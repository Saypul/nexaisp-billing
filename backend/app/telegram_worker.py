"""Telegram polling for group WO pickup, progress, and n8n notifications."""
import json
import logging
import os
import re
import time
import urllib.request
from pathlib import Path
from uuid import uuid4
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from fastapi import HTTPException
from sqlalchemy import select, update
from sqlalchemy.orm import object_session

from .database import SessionLocal
from .main import apply_ticket_update, add_ticket_event
from .models import TelegramBotState, Ticket, TicketEvent
from .schemas import TicketUpdate
from .telegram_config import get_bot_token, get_work_order_chat_id, get_ticket_team, get_ticket_chat_id, get_allowed_group_ids


log = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO)
STEPS = ('survey', 'installation', 'ready')
MAX_PHOTO_BYTES = 10 * 1024 * 1024


def telegram_call(token: str, method: str, payload: dict):
    body = json.dumps(payload).encode('utf-8')
    request = urllib.request.Request(
        f'https://api.telegram.org/bot{token}/{method}', body,
        headers={'Content-Type': 'application/json'},
    )
    with urllib.request.urlopen(request, timeout=35) as response:
        result = json.load(response)
    if not result.get('ok'):
        raise RuntimeError('Telegram API menolak permintaan')
    return result.get('result')


def send_message(token: str, chat_id: int, message: str, keyboard: dict | None = None):
    payload = {'chat_id': chat_id, 'text': message[:4000]}
    if keyboard:
        payload['reply_markup'] = {'inline_keyboard': [[
            {'text': button['text'], **button['additionalFields']}
            for button in row['row']['buttons']
        ] for row in keyboard['rows']]}
    return telegram_call(token, 'sendMessage', payload)


def dispatch_notification(token: str, chat_id: int, message: str, keyboard: dict | None = None):
    webhook_url = os.getenv('N8N_WO_WEBHOOK_URL', '').strip()
    if not webhook_url:
        return send_message(token, chat_id, message, keyboard)
    webhook_key = os.getenv('N8N_WO_WEBHOOK_KEY', '').strip()
    if not webhook_key:
        raise RuntimeError('N8N_WO_WEBHOOK_KEY belum diatur')
    request = urllib.request.Request(
        webhook_url, json.dumps({'chat_id': chat_id, 'text': message[:4000], 'keyboard': keyboard}).encode('utf-8'),
        headers={'Content-Type': 'application/json', 'X-Nexa-Webhook-Key': webhook_key},
    )
    with urllib.request.urlopen(request, timeout=35) as response:
        if response.status < 200 or response.status >= 300:
            raise RuntimeError('n8n menolak notifikasi WO')


def work_order_text(ticket: Ticket):
    service = ticket.subscription
    is_noc = get_ticket_team(object_session(ticket), ticket) == 'noc'
    address = (service.service_address if service else None) or ticket.customer.address or '—'
    return '\n'.join([
        f'WO-{ticket.id:06d} / {ticket.code}',
        f'Status: {ticket.status.upper()}',
        f'{"PIC NOC" if is_noc else "Teknisi"}: {ticket.technician_name or "Belum diambil"}',
        f'Pelanggan: {ticket.customer.name} ({ticket.customer.code})',
        f'Telepon: {ticket.customer.phone or "—"}',
        f'Layanan: {service.plan.name if service else "Belum dipilih"}',
        f'Kategori: {service.plan.category if service else "—"}',
        f'Service ID: {service.code if service else "—"}',
        f'RFS target: {ticket.rfs_target_date or "—"}',
        f'{"Konfigurasi siap" if is_noc else "Instalasi siap"}: {ticket.installed_at.astimezone(ZoneInfo("Asia/Jakarta")).strftime("%Y-%m-%d %H:%M WIB") if ticket.installed_at else "—"}',
        f'Aktivasi NOC: {ticket.activated_at.astimezone(ZoneInfo("Asia/Jakarta")).strftime("%Y-%m-%d %H:%M WIB") if ticket.activated_at else "—"}',
        f'Mulai billing: {service.start_date if service and ticket.status == "closed" else "Menunggu NOC"}',
        f'Alamat kerja: {address}',
        f'Circuit ID: {service.circuit_id if service and service.circuit_id else "—"}',
        f'Catatan: {ticket.notes or "—"}',
    ])


def work_order_keyboard(ticket: Ticket):
    if ticket.status == 'closed':
        return None
    if ticket.status == 'scheduled':
        action, label = 'info', '🗓 Menunggu Jadwal RFS'
    elif ticket.status == 'ready':
        action, label = 'info', '⏳ Menunggu Aktivasi NOC'
    elif ticket.status == 'open' and not ticket.technician_telegram_id:
        action, label = 'pickup', '📥 Ambil WO'
    elif get_ticket_team(object_session(ticket), ticket) == 'noc' and ticket.status == 'open':
        action, label = 'status:ready', '✅ Konfigurasi Siap'
    else:
        next_step = {'open': ('survey', '🔎 Mulai Survey'),
                     'survey': ('installation', '🛠 Mulai Instalasi'),
                     'installation': ('ready', '🧪 Siap Aktivasi')}
        status, label = next_step[ticket.status]
        action = f'status:{status}'
    buttons = [{'text': label, 'additionalFields': {'callback_data': f'wo:{action}:{ticket.id}'}}]
    if ticket.technician_telegram_id and ticket.status != 'scheduled':
        buttons.append({'text': '📷 Catatan / Foto',
                        'additionalFields': {'callback_data': f'wo:note:{ticket.id}'}})
    else:
        buttons.append({'text': 'ℹ️ Cara Kerja',
                        'additionalFields': {'callback_data': f'wo:info:{ticket.id}'}})
    return {'rows': [{'row': {'buttons': buttons}}]}


def deliver_events(token: str):
    with SessionLocal() as db:
        events = db.scalars(select(TicketEvent).where(
            TicketEvent.notify_telegram_id.is_not(None),
            TicketEvent.telegram_delivered_at.is_(None),
            TicketEvent.telegram_attempts < 20,
        ).order_by(TicketEvent.id).limit(20)).all()
        for event in events:
            ticket = event.ticket
            message = f'Update Work Order dari {event.actor_name}\n\n{work_order_text(ticket)}'
            if event.note:
                message += f'\n\nUpdate: {event.note}'
            try:
                dispatch_notification(token, event.notify_telegram_id, message, work_order_keyboard(ticket))
                event.telegram_delivered_at = datetime.now(timezone.utc)
            except Exception:
                log.warning('Pengiriman Telegram event %s gagal; akan dicoba ulang.', event.id)
                event.telegram_attempts += 1
            db.commit()


def handle_message(message: dict):
    sender = message.get('from') or {}
    chat = message.get('chat') or {}
    sender_id = sender.get('id')
    text = (message.get('text') or '').strip()
    reply_text = ((message.get('reply_to_message') or {}).get('text') or '')
    note_match = re.match(r'^Catatan WO-(\d+):', reply_text)
    if note_match and text and not text.startswith('/'):
        text = f'/note WO-{int(note_match.group(1)):06d} {text}'
    if not isinstance(sender_id, int) or not text:
        return None
    parts = text.split(maxsplit=3)
    command = parts[0].split('@', 1)[0].lower()
    chat_type = chat.get('type')
    chat_id = chat.get('id')
    if command == '/chatid' and chat_type in {'group', 'supergroup'}:
        return f'Chat ID grup ini: {chat_id}\nMasukkan di menu Telegram billing pada kategori layanan yang sesuai.'
    with SessionLocal() as db:
        allowed_groups = get_allowed_group_ids(db)
    if chat_type != 'private' and not (chat_type in {'group', 'supergroup'} and chat_id in allowed_groups):
        return None
    if command in {'/start', '/help'}:
        return ('Perintah WO:\n/id — lihat Telegram User ID Anda\n/wo — daftar WO yang ditugaskan\n'
                '/pickup WO-000001 — ambil WO Open dari grup teknisi\n'
                '/wo WO-000001 — detail WO\n/status WO-000001 survey|installation|ready [catatan]\n'
                '/note WO-000001 catatan progres\n/chatid — lihat ID grup teknisi')
    if command == '/id':
        return f'Telegram User ID Anda: {sender_id}'
    with SessionLocal() as db:
        if command == '/wo' and len(parts) == 1:
            rows = db.scalars(select(Ticket).where(Ticket.technician_telegram_id == sender_id, Ticket.status != 'closed').order_by(Ticket.id.desc()).limit(20)).all()
            return 'WO aktif Anda:\n' + '\n'.join(f'WO-{t.id:06d} / {t.code} — {t.status}' for t in rows) if rows else 'Belum ada WO aktif yang ditugaskan kepada Anda.'
        if command not in {'/wo', '/status', '/note', '/pickup'} or len(parts) < 2:
            return 'Perintah tidak dikenali. Ketik /help.'
        identifier = parts[1].upper()
        match = re.fullmatch(r'WO-(\d+)', identifier)
        ticket = db.get(Ticket, int(match.group(1))) if match else db.scalar(select(Ticket).where(Ticket.code == identifier))
        if ticket is None:
            return 'Ticket tidak ditemukan.'
        if chat_type != 'private' and chat_id != get_ticket_chat_id(db, ticket):
            return 'WO ini berada di grup tim yang berbeda.'
        actor_name = ' '.join(filter(None, [sender.get('first_name'), sender.get('last_name')]))[:120] or f'Teknisi {sender_id}'
        is_noc = get_ticket_team(db, ticket) == 'noc'
        if command == '/pickup':
            if chat_type not in {'group', 'supergroup'}:
                return 'Ambil WO dengan /pickup di grup tim terkait.'
            if ticket.status != 'open':
                return 'WO tidak berada pada status Open.'
            claimed = db.execute(update(Ticket).where(
                Ticket.id == ticket.id, Ticket.status == 'open', Ticket.technician_telegram_id.is_(None)
            ).values(technician_telegram_id=sender_id, technician_name=actor_name))
            if claimed.rowcount != 1:
                db.rollback()
                return 'WO ini sudah diambil teknisi lain.'
            db.refresh(ticket)
            add_ticket_event(db, ticket, 'open', 'noc_telegram' if is_noc else 'technician', actor_name, f'WO diambil oleh {actor_name}')
            db.commit()
            return f'WO-{ticket.id:06d} berhasil diambil oleh {actor_name}. Lanjutkan dengan /status WO-{ticket.id:06d} {"ready" if is_noc else "survey"}.'
        if ticket.technician_telegram_id != sender_id:
            return 'WO ini tidak ditugaskan kepada Telegram User ID Anda.'
        if command == '/wo':
            return work_order_text(ticket)
        if ticket.status == 'closed':
            return 'WO sudah Closed. Perubahan selanjutnya dilakukan admin.'
        try:
            if command == '/status':
                if len(parts) < 3 or parts[2].lower() not in STEPS:
                    return 'Format: /status WO-000001 survey|installation|ready [catatan]'
                new_status = parts[2].lower()
                note = parts[3] if len(parts) > 3 else None
                payload = {'status': new_status}
                if note:
                    payload['notes'] = note
            else:
                if len(parts) < 3:
                    return 'Format: /note WO-000001 catatan progres'
                payload = {'status': ticket.status, 'notes': ' '.join(parts[2:])}
            result = apply_ticket_update(ticket.id, TicketUpdate(**payload), db, 'noc_telegram' if is_noc else 'technician', actor_name, sender_id)
        except HTTPException as exc:
            return str(exc.detail)
        return f'Progres WO-{ticket.id:06d} tersimpan: {result["status"].upper()}.'


def save_telegram_photo(token: str, message: dict):
    photos = message.get('photo') or []
    document = message.get('document') or {}
    if photos:
        photo = max(photos, key=lambda item: item.get('width', 0) * item.get('height', 0))
    elif document.get('mime_type') in {'image/jpeg', 'image/png', 'image/webp'}:
        photo = document
    else:
        raise ValueError('Kirim foto JPG, PNG, atau WebP sebagai foto atau dokumen gambar.')
    if not photo.get('file_id') or photo.get('file_size', 0) > MAX_PHOTO_BYTES:
        raise ValueError('Foto terlalu besar. Batas dokumentasi adalah 10 MB per foto.')
    telegram_file = telegram_call(token, 'getFile', {'file_id': photo['file_id']})
    file_path = telegram_file.get('file_path') if telegram_file else None
    if not file_path or not re.fullmatch(r'[A-Za-z0-9_./-]+', file_path) or '..' in file_path.split('/'):
        raise ValueError('File foto Telegram tidak tersedia.')
    if telegram_file.get('file_size', 0) > MAX_PHOTO_BYTES:
        raise ValueError('Foto terlalu besar. Batas dokumentasi adalah 10 MB per foto.')
    request = urllib.request.Request(f'https://api.telegram.org/file/bot{token}/{file_path}')
    with urllib.request.urlopen(request, timeout=35) as response:
        content = response.read(MAX_PHOTO_BYTES + 1)
    if len(content) > MAX_PHOTO_BYTES:
        raise ValueError('Foto terlalu besar. Batas dokumentasi adalah 10 MB per foto.')
    if content.startswith(b'\xff\xd8\xff'):
        extension = 'jpg'
    elif content.startswith(b'\x89PNG\r\n\x1a\n'):
        extension = 'png'
    elif content.startswith(b'RIFF') and content[8:12] == b'WEBP':
        extension = 'webp'
    else:
        raise ValueError('Format file bukan gambar JPG, PNG, atau WebP.')
    directory = Path(os.getenv('WO_PHOTO_DIR', '/app/uploads'))
    directory.mkdir(parents=True, exist_ok=True)
    filename = f'{uuid4().hex}.{extension}'
    (directory / filename).write_bytes(content)
    return filename


def handle_photo_message(token: str, message: dict):
    prompt = ((message.get('reply_to_message') or {}).get('text') or '')
    match = re.match(r'^Catatan WO-(\d+):', prompt)
    if not match:
        return None
    sender = message.get('from') or {}
    chat = message.get('chat') or {}
    sender_id = sender.get('id')
    if not isinstance(sender_id, int):
        return None
    ticket_id = int(match.group(1))
    with SessionLocal() as db:
        ticket = db.get(Ticket, ticket_id)
        if ticket is None:
            return 'WO tidak ditemukan.'
        if chat.get('type') != 'private' and chat.get('id') != get_ticket_chat_id(db, ticket):
            return 'Grup teknisi tidak sesuai konfigurasi.'
        if ticket.technician_telegram_id != sender_id or ticket.status == 'closed':
            return 'Hanya teknisi yang mengambil WO aktif ini dapat menambah dokumentasi.'
        actor_name = ' '.join(filter(None, [sender.get('first_name'), sender.get('last_name')]))[:120] or f'Teknisi {sender_id}'
        caption = (message.get('caption') or '').strip()
        filename = None
        try:
            filename = save_telegram_photo(token, message)
            payload = {'status': ticket.status}
            if caption:
                payload['notes'] = caption
            actor_type = 'noc_telegram' if get_ticket_team(db, ticket) == 'noc' else 'technician'
            result = apply_ticket_update(ticket_id, TicketUpdate(**payload), db,
                                         actor_type, actor_name, sender_id, photo_filename=filename)
        except (ValueError, HTTPException) as exc:
            if filename:
                (Path(os.getenv('WO_PHOTO_DIR', '/app/uploads')) / filename).unlink(missing_ok=True)
            return str(exc.detail) if isinstance(exc, HTTPException) else str(exc)
        except Exception:
            if filename:
                (Path(os.getenv('WO_PHOTO_DIR', '/app/uploads')) / filename).unlink(missing_ok=True)
            log.warning('Penyimpanan foto WO-%06d gagal; file dapat dikirim ulang.', ticket_id)
            return 'Foto gagal disimpan. Silakan kirim ulang.'
        return f'Dokumentasi WO-{ticket_id:06d} tersimpan pada tahap {result["status"].upper()}.'


def process_update(token: str, update: dict):
    callback = update.get('callback_query')
    if callback:
        process_callback(token, callback)
        return
    message = update.get('message')
    if not message:
        return
    reply = handle_photo_message(token, message) if message.get('photo') or message.get('document') else handle_message(message)
    chat_id = (message.get('chat') or {}).get('id')
    if reply and isinstance(chat_id, int):
        try:
            send_message(token, chat_id, reply)
        except Exception:
            log.warning('Balasan Telegram untuk update %s gagal.', update.get('update_id'))


def process_callback(token: str, callback: dict):
    callback_id = callback.get('id')
    message = callback.get('message') or {}
    chat = message.get('chat') or {}
    sender = callback.get('from') or {}
    data = callback.get('data') or ''
    if data == 'wo:preview':
        if callback.get('id'):
            telegram_call(token, 'answerCallbackQuery', {
                'callback_query_id': callback['id'],
                'text': 'Ini contoh tombol. Buat pelanggan baru untuk menerima WO yang dapat diproses.',
                'show_alert': True,
            })
        return
    if re.fullmatch(r'wo:info:\d+', data):
        if callback.get('id'):
            ticket_id = int(data.rsplit(':', 1)[1])
            with SessionLocal() as db:
                ticket = db.get(Ticket, ticket_id)
                info = ('WO masih menunggu jadwal RFS.' if ticket and ticket.status == 'scheduled' else
                        'Instalasi selesai. Aktivasi layanan menunggu NOC.' if ticket and ticket.status == 'ready' else
                        'Teknisi pertama yang menekan Ambil WO akan mendapat penugasan.')
            telegram_call(token, 'answerCallbackQuery', {
                'callback_query_id': callback['id'],
                'text': info,
                'show_alert': True,
            })
        return
    match = re.fullmatch(r'wo:(pickup|note|status:(?:survey|installation|ready)):(\d+)', data)
    response = 'Tombol WO tidak valid.'
    success = False
    if match and isinstance(sender.get('id'), int) and isinstance(chat.get('id'), int):
        action, ticket_id = match.group(1), int(match.group(2))
        if action == 'note':
            with SessionLocal() as db:
                ticket = db.get(Ticket, ticket_id)
                allowed_chat = chat.get('type') == 'private' or chat.get('id') == get_ticket_chat_id(db, ticket)
                allowed_user = ticket and ticket.technician_telegram_id == sender['id']
                if allowed_chat and allowed_user and ticket.status != 'closed':
                    telegram_call(token, 'sendMessage', {
                        'chat_id': chat['id'],
                        'text': f'Catatan WO-{ticket_id:06d}: balas pesan ini dengan catatan teks atau foto (boleh disertai caption). Maksimal 10 MB per foto.',
                        'reply_markup': {'force_reply': True},
                    })
                    response = 'Balas pesan bot dengan teks atau foto dokumentasi.'
                else:
                    response = 'Hanya teknisi yang mengambil WO aktif ini dapat menambah catatan.'
        else:
            command = f'/pickup WO-{ticket_id:06d}' if action == 'pickup' else f'/status WO-{ticket_id:06d} {action.split(":", 1)[1]}'
            response = handle_message({'from': sender, 'chat': chat, 'text': command}) or 'Grup teknisi tidak sesuai konfigurasi.'
            success = response.startswith(f'WO-{ticket_id:06d} berhasil') or response.startswith(f'Progres WO-{ticket_id:06d} tersimpan')
    if callback_id:
        telegram_call(token, 'answerCallbackQuery', {'callback_query_id': callback_id, 'text': response[:190], 'show_alert': not success and 'Balas pesan bot' not in response})
    if success and chat.get('id') and message.get('message_id'):
        try:
            telegram_call(token, 'editMessageReplyMarkup', {
                'chat_id': chat['id'], 'message_id': message['message_id'],
                'reply_markup': {'inline_keyboard': []},
            })
        except Exception:
            log.warning('Tombol lama WO pada chat %s tidak dapat dinonaktifkan.', chat['id'])


def poll_updates(token: str):
    with SessionLocal() as db:
        state = db.get(TelegramBotState, 'last_update_id')
        offset = int(state.value) + 1 if state else 0
    updates = telegram_call(token, 'getUpdates', {'offset': offset, 'timeout': 20, 'allowed_updates': ['message', 'callback_query']})
    for update in updates:
        with SessionLocal() as db:
            if get_bot_token(db) != token:
                return
        update_id = update['update_id']
        process_update(token, update)
        with SessionLocal() as db:
            state = db.get(TelegramBotState, 'last_update_id')
            if state:
                state.value = str(max(int(state.value), update_id))
            else:
                db.add(TelegramBotState(key='last_update_id', value=str(update_id)))
            db.commit()


def main():
    waiting_logged = False
    while True:
        with SessionLocal() as db:
            token = get_bot_token(db)
        if not token:
            if not waiting_logged:
                log.info('Bot Telegram belum diatur; worker WO menunggu konfigurasi dari menu Telegram.')
                waiting_logged = True
            time.sleep(10)
            continue
        waiting_logged = False
        try:
            deliver_events(token)
            poll_updates(token)
        except Exception:
            log.warning('Koneksi Telegram atau database gagal; mencoba lagi.', exc_info=False)
            time.sleep(10)


if __name__ == '__main__':
    main()

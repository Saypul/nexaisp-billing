"""Integration smoke checks using isolated SQLite file, no Docker required."""
import os
import tempfile
import io
from pathlib import Path
from datetime import date
from unittest.mock import patch
import pytest

TEST_DIR = tempfile.mkdtemp(prefix='nexaisp-tests-')
os.environ['DATABASE_URL'] = 'sqlite:///' + str(Path(TEST_DIR) / 'test.sqlite3')
os.environ['JWT_SECRET'] = 'test-key-local-smoke-only-please-do-not-use-in-prod'
os.environ['ADMIN_EMAIL'] = 'test@nexaisp.local'
os.environ['ADMIN_PASSWORD'] = 'very-long-test-password'
os.environ['WO_PHOTO_DIR'] = str(Path(TEST_DIR) / 'photos')

from fastapi.testclient import TestClient
from app.main import app, run_auto_invoices, release_scheduled_tickets
from app.telegram_worker import handle_message, process_callback, process_update, save_telegram_photo, work_order_keyboard
from app.database import SessionLocal
from app.models import TelegramConfig, TicketEvent
from sqlalchemy import select
from app.telegram_config import get_bot_token


def activate_as_noc(client, admin_headers, ticket_id, billing_start_date, plan_id=None):
    payload = {'status': 'ready'}
    if plan_id:
        payload['plan_id'] = plan_id
    ready = client.put(f'/api/tickets/{ticket_id}', headers=admin_headers, json=payload)
    assert ready.status_code == 200, ready.text
    created = client.post('/api/users/noc', headers=admin_headers,
                          json={'email': 'noc@example.com', 'password': 'noc-test-password-123'})
    assert created.status_code in (201, 409)
    login = client.post('/api/auth/login', json={'email': 'noc@example.com', 'password': 'noc-test-password-123'})
    assert login.status_code == 200
    noc_headers = {'Authorization': 'Bearer ' + login.json()['access_token']}
    assert client.get('/api/customers', headers=noc_headers).status_code == 403
    assert client.post(f'/api/tickets/{ticket_id}/activate', headers=admin_headers,
                       json={'billing_start_date': billing_start_date, 'notes': 'Link teruji'}).status_code == 403
    with patch('app.main.local_today', return_value=date.fromisoformat(billing_start_date)):
        return client.post(f'/api/tickets/{ticket_id}/activate', headers=noc_headers,
                           json={'billing_start_date': billing_start_date, 'notes': 'Link teruji'})


def test_full_customer_multi_service_invoice_and_partial_payment():
    with TestClient(app) as client:
        assert client.get('/api/health').status_code == 200
        assert client.get('/api/customers').status_code == 401
        bad = client.post('/api/auth/login', json={'email': 'test@nexaisp.local', 'password': 'wrong'})
        assert bad.status_code == 401
        login = client.post('/api/auth/login', json={'email': 'test@nexaisp.local','password':'very-long-test-password'})
        assert login.status_code == 200
        h = {'Authorization': 'Bearer ' + login.json()['access_token']}
        c = client.post('/api/customers', headers=h, json={'name':'PT Demo Nusantara','kind':'corporate','email':'demo@example.com'})
        assert c.status_code == 201, c.text
        assert len(c.json()['code']) == 10 and c.json()['code'].isdigit()
        cid = c.json()['id']
        a = client.post('/api/plans', headers=h, json={'name':'Metro-E 1G','category':'METRO_E','monthly_fee':8000000,'setup_fee':250000})
        b = client.post('/api/plans', headers=h, json={'name':'Tunnel 3 Site','category':'TUNNEL','monthly_fee':1500000})
        assert a.status_code == 201 and b.status_code == 201
        for num, plan in enumerate((a.json()['id'],b.json()['id']),1):
            ticket=client.post('/api/tickets', headers=h,json={'customer_id':cid,'initial_service':{'plan_id':plan,'billing_type':'prepaid','start_date':'2026-10-01'}})
            assert ticket.status_code==201,ticket.text
            assert ticket.json()['status']=='open'
            assert client.patch(f"/api/subscriptions/{ticket.json()['subscription_id']}/status",headers=h,json={'status':'active'}).status_code==409
            activated=activate_as_noc(client,h,ticket.json()['id'],'2026-10-01')
            assert activated.status_code==200,activated.text
        inv=client.post('/api/invoices/generate',headers=h,json={'period':'2026-10','due_date':'2026-10-20'})
        assert inv.status_code==200,inv.text
        assert inv.json()['created']==1
        repeat=client.post('/api/invoices/generate',headers=h,json={'period':'2026-10','due_date':'2026-10-20'})
        assert repeat.json()['created']==0 and repeat.json()['skipped']==1
        invoices=client.get('/api/invoices',headers=h).json()
        assert len(invoices)==1
        assert invoices[0]['total']==9750000
        assert len(invoices[0]['items'])==3
        assert sum(item['amount'] for item in invoices[0]['items'] if item['charge_type']=='otc') == 250000
        invoice_id=invoices[0]['id']
        p1=client.post(f'/api/invoices/{invoice_id}/payments',headers=h,json={'amount':2500000,'method':'transfer','reference':'R001'})
        assert p1.status_code==201 and p1.json()['remaining']==7250000
        duplicate=client.post(f'/api/invoices/{invoice_id}/payments',headers=h,json={'amount':2500000,'method':'transfer','reference':'R001'})
        assert duplicate.status_code==409
        excessive=client.post(f'/api/invoices/{invoice_id}/payments',headers=h,json={'amount':9000000,'method':'cash'})
        assert excessive.status_code==422
        p2=client.post(f'/api/invoices/{invoice_id}/payments',headers=h,json={'amount':7250000,'method':'transfer','reference':'R002'})
        assert p2.status_code==201 and p2.json()['status']=='paid'
        summary=client.get('/api/dashboard',headers=h).json()
        assert summary['customers']==1
        assert summary['active_services']==2
        assert summary['mrr_estimate']==9500000
        assert summary['unpaid_invoices']==0


def test_business_postpaid_otc_and_crud():
    with TestClient(app) as client:
        token = client.post('/api/auth/login', json={'email':'test@nexaisp.local','password':'very-long-test-password'}).json()['access_token']
        h = {'Authorization': 'Bearer ' + token}
        customer = client.post('/api/customers', headers=h, json={'name':'CV Bisnis Baru','kind':'business'})
        assert customer.status_code == 201
        cid = customer.json()['id']
        assert customer.json()['code'].isdigit() and len(customer.json()['code']) == 10
        changed = client.put(f'/api/customers/{cid}', headers=h, json={'name':'CV Bisnis Update','kind':'business'})
        assert changed.status_code == 200 and changed.json()['code'] == customer.json()['code']
        plan = client.post('/api/plans', headers=h, json={'name':'Dedicated Bisnis','category':'DEDICATED','monthly_fee':100000,'setup_fee':50000})
        assert plan.status_code == 201
        assert client.post('/api/subscriptions', headers=h, json={'code':'BUS-POST-2027','customer_id':cid,'plan_id':plan.json()['id'],'status':'active'}).status_code == 409
        service = client.post('/api/tickets', headers=h, json={'customer_id':cid,'initial_service':{'plan_id':plan.json()['id'],'billing_type':'postpaid','monthly_fee':120000,'setup_fee':60000,'start_date':'2027-04-01'}})
        assert service.status_code == 201
        sid = service.json()['subscription_id']
        assert activate_as_noc(client,h,service.json()['id'],'2027-04-01').status_code == 200
        assert client.post('/api/invoices/generate', headers=h, json={'period':'2027-04','due_date':'2027-04-20'}).status_code == 200
        assert not any(i['customer_id'] == cid for i in client.get('/api/invoices', headers=h).json())
        assert client.post('/api/invoices/generate', headers=h, json={'period':'2027-05','due_date':'2027-05-20'}).status_code == 200
        invoice = next(i for i in client.get('/api/invoices', headers=h).json() if i['customer_id'] == cid)
        assert invoice['total'] == 180000
        assert {item['charge_type'] for item in invoice['items']} == {'mrc','otc'}
        assert '2027-04' in next(item['description'] for item in invoice['items'] if item['charge_type'] == 'mrc')
        iid = invoice['id']
        assert client.put(f'/api/invoices/{iid}', headers=h, json={'due_date':'2027-05-25'}).status_code == 200
        assert client.delete(f'/api/subscriptions/{sid}', headers=h).status_code == 409
        assert client.delete(f'/api/customers/{cid}', headers=h).status_code == 409
        assert client.delete(f'/api/invoices/{iid}', headers=h).status_code == 204
        assert client.delete(f"/api/tickets/{service.json()['id']}", headers=h).status_code == 204
        assert client.delete(f'/api/subscriptions/{sid}', headers=h).status_code == 204
        ticket_id = next(t['id'] for t in client.get('/api/tickets', headers=h).json() if t['customer_id'] == cid)
        assert client.delete(f'/api/tickets/{ticket_id}', headers=h).status_code == 204
        assert client.delete(f'/api/customers/{cid}', headers=h).status_code == 204


def test_create_customer_with_first_service():
    with TestClient(app) as client:
        token = client.post('/api/auth/login', json={'email':'test@nexaisp.local','password':'very-long-test-password'}).json()['access_token']
        h = {'Authorization': 'Bearer ' + token}
        before = len(client.get('/api/customers', headers=h).json())
        invalid = client.post('/api/customers', headers=h, json={'name':'PT Paket Tidak Ada','kind':'corporate','initial_service':{'plan_id':999999}})
        assert invalid.status_code == 404
        assert len(client.get('/api/customers', headers=h).json()) == before
        plan = client.post('/api/plans', headers=h, json={'name':'Metro Onboarding','category':'METRO_E','monthly_fee':500000,'setup_fee':75000})
        assert plan.status_code == 201
        customer = client.post('/api/customers', headers=h, json={
            'name':'PT Layanan Pertama','kind':'corporate',
            'initial_service':{'plan_id':plan.json()['id'],'billing_type':'postpaid','monthly_fee':450000,'setup_fee':50000,'start_date':'2027-06-01'}
        })
        assert customer.status_code == 201, customer.text
        services = [s for s in client.get('/api/subscriptions', headers=h).json() if s['customer_id'] == customer.json()['id']]
        assert len(services) == 1
        assert services[0]['code'].startswith('ETH-')
        assert services[0]['status'] == 'pending'
        assert services[0]['billing_type'] == 'postpaid'
        assert services[0]['monthly_fee'] == 450000
        assert services[0]['setup_fee'] == 50000
        ticket = next(t for t in client.get('/api/tickets', headers=h).json() if t['customer_id'] == customer.json()['id'])
        assert ticket['status'] == 'open' and ticket['subscription_id'] == services[0]['id']
        activated = activate_as_noc(client,h,ticket['id'],'2027-06-05',plan.json()['id'])
        assert activated.status_code == 200, activated.text
        assert activated.json()['status'] == 'closed'
        assert next(s for s in client.get('/api/subscriptions', headers=h).json() if s['id'] == services[0]['id'])['status'] == 'active'
        plain = client.post('/api/customers', headers=h, json={'name':'Tanpa Paket'})
        assert plain.status_code == 201
        plain_ticket = next(t for t in client.get('/api/tickets', headers=h).json() if t['customer_id'] == plain.json()['id'])
        assert plain_ticket['plan_id'] is None
        blocked = client.put(f"/api/tickets/{plain_ticket['id']}", headers=h, json={'status':'closed'})
        assert blocked.status_code == 409
        surveyed = client.put(f"/api/tickets/{plain_ticket['id']}", headers=h, json={'status':'survey','notes':'Jadwal survey disepakati'})
        assert surveyed.status_code == 200 and surveyed.json()['notes'] == 'Jadwal survey disepakati'


def test_ftth_automatic_invoice_and_late_service():
    with TestClient(app) as client:
        token = client.post('/api/auth/login', json={'email':'test@nexaisp.local','password':'very-long-test-password'}).json()['access_token']
        h = {'Authorization': 'Bearer ' + token}
        plan = client.post('/api/plans', headers=h, json={'name':'FTTH Auto','category':'FTTH','monthly_fee':100000,'setup_fee':10000}).json()
        customer = client.post('/api/customers', headers=h, json={'name':'Rumah FTTH','initial_service':{'plan_id':plan['id'],'billing_type':'prepaid','start_date':'2026-01-01'}}).json()
        cid = customer['id']
        first = next(t for t in client.get('/api/tickets', headers=h).json() if t['customer_id'] == cid)
        assert first['status'] == 'open' and first['service_code'].startswith('SRV-')
        assert first['invoice_mode'] == 'auto'
        assert activate_as_noc(client,h,first['id'],'2026-01-01').status_code == 200
        assert run_auto_invoices()['created'] >= 1
        invoices = [i for i in client.get('/api/invoices', headers=h).json() if i['customer_id'] == cid and i['invoice_mode'] == 'auto']
        assert len(invoices) == 1 and invoices[0]['total'] == 110000
        assert run_auto_invoices()['created'] == 0
        second = client.post('/api/tickets', headers=h, json={'customer_id':cid,'initial_service':{'plan_id':plan['id'],'billing_type':'prepaid','start_date':'2026-01-01'}}).json()
        assert activate_as_noc(client,h,second['id'],'2026-01-01').status_code == 200
        assert run_auto_invoices()['updated'] >= 1
        invoices = [i for i in client.get('/api/invoices', headers=h).json() if i['customer_id'] == cid and i['invoice_mode'] == 'auto']
        assert len(invoices) == 1 and invoices[0]['total'] == 220000
        assert client.post(f"/api/invoices/{invoices[0]['id']}/payments", headers=h, json={'amount':10000,'method':'cash'}).status_code == 201
        third = client.post('/api/tickets', headers=h, json={'customer_id':cid,'initial_service':{'plan_id':plan['id'],'billing_type':'prepaid','start_date':'2026-01-01'}}).json()
        assert activate_as_noc(client,h,third['id'],'2026-01-01').status_code == 200
        assert run_auto_invoices()['created'] >= 1
        invoices = [i for i in client.get('/api/invoices', headers=h).json() if i['customer_id'] == cid and i['invoice_mode'] == 'auto']
        assert len(invoices) == 2 and sum(i['total'] for i in invoices) == 330000


def test_assigned_technician_can_update_work_order():
    def message(user_id, text):
        return {'from': {'id': user_id, 'first_name': 'Teknisi'},
                'chat': {'id': user_id, 'type': 'private'}, 'text': text}

    with TestClient(app) as client:
        token = client.post('/api/auth/login', json={'email':'test@nexaisp.local','password':'very-long-test-password'}).json()['access_token']
        headers = {'Authorization': 'Bearer ' + token}
        plan = client.post('/api/plans', headers=headers, json={'name':'Metro WO','category':'METRO_E','monthly_fee':500000}).json()
        customer = client.post('/api/customers', headers=headers, json={'name':'PT WO Test','initial_service':{'plan_id':plan['id']}}).json()
        ticket = next(t for t in client.get('/api/tickets', headers=headers).json() if t['customer_id'] == customer['id'])
        assert ticket['work_order_code'].startswith('WO-')
        assigned = client.put(f"/api/tickets/{ticket['id']}", headers=headers,
                              json={'status':'open','technician_name':'Teknisi A','technician_telegram_id':123456})
        assert assigned.status_code == 200, assigned.text
        assert assigned.json()['technician_telegram_id'] == 123456
        assert handle_message(message(999, f"/wo {ticket['code']}")) == 'WO ini tidak ditugaskan kepada Telegram User ID Anda.'
        assert '123456' in handle_message(message(123456, '/id'))
        assert 'SURVEY' in handle_message(message(123456, f"/status {ticket['work_order_code']} survey Lokasi siap"))
        assert 'Format:' in handle_message(message(123456, f"/status {ticket['code']} closed"))
        assert 'SURVEY' in handle_message(message(123456, f"/note {ticket['work_order_code']} Kabel sudah ditarik"))
        assert client.put(f"/api/tickets/{ticket['id']}", headers=headers, json={'status':'ready'}).status_code == 200
        assert 'Format:' in handle_message(message(123456, f"/status {ticket['work_order_code']} closed Aktivasi selesai"))
        updated = next(t for t in client.get('/api/tickets', headers=headers).json() if t['id'] == ticket['id'])
        assert updated['status'] == 'ready' and updated['events'][-1]['actor_type'] == 'admin'
        assert activate_as_noc(client,headers,ticket['id'],date.today().isoformat()).status_code == 200
        service = next(s for s in client.get('/api/subscriptions', headers=headers).json() if s['customer_id'] == customer['id'])
        assert service['status'] == 'active'


def test_telegram_settings_verify_bot_and_hide_token(monkeypatch):
    token = '123456789:abcdefghijklmnopqrstuvwxyz123456'
    def fake_urlopen(request, timeout):
        assert token in request.full_url
        return io.BytesIO(b'{"ok":true,"result":{"id":123456789,"is_bot":true,"username":"nexaisp_wo_bot"}}')
    monkeypatch.setattr('app.main.urllib.request.urlopen', fake_urlopen)
    with TestClient(app) as client:
        assert client.get('/api/telegram').status_code == 401
        auth = client.post('/api/auth/login', json={'email':'test@nexaisp.local','password':'very-long-test-password'}).json()['access_token']
        headers = {'Authorization': 'Bearer ' + auth}
        saved = client.put('/api/telegram', headers=headers, json={'bot_token':token,'admin_chat_id':987654321})
        assert saved.status_code == 200, saved.text
        assert saved.json()['bot_id'] == 123456789
        assert saved.json()['bot_username'] == 'nexaisp_wo_bot'
        assert saved.json()['admin_chat_id'] == 987654321
        assert token not in saved.text
        assert token not in client.get('/api/telegram', headers=headers).text
        with SessionLocal() as db:
            config = db.get(TelegramConfig, 1)
            assert token not in config.encrypted_bot_token
            assert get_bot_token(db) == token


def test_group_work_order_pickup_and_progress():
    group_id = -1001234567890
    def group_message(user_id, content):
        return {'from': {'id': user_id, 'first_name': f'Teknisi {user_id}'},
                'chat': {'id': group_id, 'type': 'supergroup'}, 'text': content}

    with TestClient(app) as client:
        auth = client.post('/api/auth/login', json={'email':'test@nexaisp.local','password':'very-long-test-password'}).json()['access_token']
        headers = {'Authorization': 'Bearer ' + auth}
        plan = client.post('/api/plans', headers=headers, json={'name':'FTTH Grup WO','category':'FTTH','monthly_fee':100000}).json()
        customer = client.post('/api/customers', headers=headers, json={'name':'Pelanggan Grup WO',
            'initial_service':{'plan_id':plan['id']}}).json()
        ticket = next(t for t in client.get('/api/tickets', headers=headers).json() if t['customer_id'] == customer['id'])
        assert ticket['status'] == 'open' and ticket['technician_telegram_id'] is None
        assert handle_message(group_message(101, '/chatid')) == f'Chat ID grup ini: {group_id}\nMasukkan di menu Telegram billing pada kategori layanan yang sesuai.'
        configured = client.put('/api/telegram', headers=headers, json={'work_order_chat_id': group_id})
        assert configured.status_code == 200 and configured.json()['work_order_chat_id'] == group_id
        with SessionLocal() as db:
            events = db.scalars(select(TicketEvent).where(TicketEvent.ticket_id == ticket['id'], TicketEvent.notify_telegram_id == group_id)).all()
            assert len(events) == 1
        assert handle_message(group_message(101, f"/pickup {ticket['work_order_code']}" )).startswith('WO-')
        assert handle_message(group_message(202, f"/pickup {ticket['work_order_code']}")) == 'WO ini sudah diambil teknisi lain.'
        assert 'tidak ditugaskan' in handle_message(group_message(202, f"/status {ticket['work_order_code']} survey"))
        for status in ('survey', 'installation', 'ready'):
            assert status.upper() in handle_message(group_message(101, f"/status {ticket['work_order_code']} {status}"))
        updated = next(t for t in client.get('/api/tickets', headers=headers).json() if t['id'] == ticket['id'])
        assert updated['status'] == 'ready' and updated['technician_telegram_id'] == 101
        assert activate_as_noc(client,headers,ticket['id'],date.today().isoformat()).status_code == 200
        service = next(s for s in client.get('/api/subscriptions', headers=headers).json() if s['customer_id'] == customer['id'])
        assert service['status'] == 'active'


def test_inline_buttons_pickup_progress_and_note(monkeypatch):
    group_id = -100888777666
    calls = []
    monkeypatch.setattr('app.telegram_worker.telegram_call',
                        lambda token, method, payload: calls.append((method, payload)))
    def click(user_id, action, ticket_id):
        process_callback('test-token', {'id': f'callback-{len(calls)}',
            'from': {'id': user_id, 'first_name': 'Teknisi'}, 'data': f'wo:{action}:{ticket_id}',
            'message': {'message_id': 12, 'chat': {'id': group_id, 'type': 'supergroup'}}})

    with TestClient(app) as client:
        process_callback('test-token', {'id': 'preview', 'data': 'wo:preview'})
        assert calls[-1][0] == 'answerCallbackQuery' and calls[-1][1]['show_alert'] is True
        auth = client.post('/api/auth/login', json={'email':'test@nexaisp.local','password':'very-long-test-password'}).json()['access_token']
        headers = {'Authorization': 'Bearer ' + auth}
        assert client.put('/api/telegram', headers=headers, json={'work_order_chat_id': group_id}).status_code == 200
        plan = client.post('/api/plans', headers=headers, json={'name':'FTTH Button','category':'FTTH','monthly_fee':100000}).json()
        customer = client.post('/api/customers', headers=headers, json={'name':'Pelanggan Button',
            'initial_service': {'plan_id': plan['id']}}).json()
        ticket = next(t for t in client.get('/api/tickets', headers=headers).json() if t['customer_id'] == customer['id'])
        with SessionLocal() as db:
            from app.models import Ticket
            keyboard = work_order_keyboard(db.get(Ticket, ticket['id']))
            assert keyboard['rows'][0]['row']['buttons'][0]['additionalFields']['callback_data'] == f"wo:pickup:{ticket['id']}"
            assert keyboard['rows'][0]['row']['buttons'][1]['additionalFields']['callback_data'] == f"wo:info:{ticket['id']}"
        click(500, 'pickup', ticket['id'])
        assert calls[-2][0] == 'answerCallbackQuery' and calls[-1][0] == 'editMessageReplyMarkup'
        click(501, 'status:survey', ticket['id'])
        assert calls[-1][1]['show_alert'] is True
        click(500, 'note', ticket['id'])
        assert any(method == 'sendMessage' and payload.get('reply_markup') == {'force_reply': True} for method, payload in calls)
        reply = {'from': {'id': 500, 'first_name': 'Teknisi'},
                 'chat': {'id': group_id, 'type': 'supergroup'}, 'text': 'Lokasi siap',
                 'reply_to_message': {'text': f"Catatan WO-{ticket['id']:06d}: balas pesan ini dengan catatan pekerjaan."}}
        assert 'OPEN' in handle_message(reply)
        filename = 'a' * 32 + '.jpg'
        photo_path = Path(os.environ['WO_PHOTO_DIR']) / filename
        photo_path.parent.mkdir(parents=True, exist_ok=True)
        photo_path.write_bytes(b'\xff\xd8\xffphoto-test')
        monkeypatch.setattr('app.telegram_worker.save_telegram_photo', lambda token, message: filename)
        process_update('test-token', {'message': {
            'from': {'id': 500, 'first_name': 'Teknisi'},
            'chat': {'id': group_id, 'type': 'supergroup'},
            'photo': [{'file_id': 'photo-1', 'file_size': 12}],
            'caption': 'Kabel drop siap dipasang',
            'reply_to_message': {'text': f"Catatan WO-{ticket['id']:06d}: balas pesan ini dengan catatan teks atau foto."},
        }})
        current = next(t for t in client.get('/api/tickets', headers=headers).json() if t['id'] == ticket['id'])
        photo_event = next(e for e in current['events'] if e['photo_url'])
        assert photo_event['new_status'] == 'open' and photo_event['note'] == 'Kabel drop siap dipasang'
        assert client.get(photo_event['photo_url']).status_code == 401
        photo_response = client.get(photo_event['photo_url'], headers=headers)
        assert photo_response.status_code == 200 and photo_response.content == b'\xff\xd8\xffphoto-test'
        assert photo_response.headers['content-type'].startswith('image/jpeg')
        for status in ('survey', 'installation', 'ready'):
            click(500, f'status:{status}', ticket['id'])
        updated = next(t for t in client.get('/api/tickets', headers=headers).json() if t['id'] == ticket['id'])
        assert updated['status'] == 'ready' and updated['technician_telegram_id'] == 500
        assert activate_as_noc(client,headers,ticket['id'],date.today().isoformat()).status_code == 200


def test_telegram_photo_download_validation(monkeypatch):
    import app.telegram_worker as worker
    monkeypatch.setattr(worker, 'telegram_call', lambda token, method, payload: {
        'file_path': 'photos/document.jpg', 'file_size': 12,
    })
    monkeypatch.setattr(worker.urllib.request, 'urlopen', lambda request, timeout: io.BytesIO(b'\xff\xd8\xffphoto-test'))
    filename = save_telegram_photo('test-token', {'photo': [{'file_id': 'photo-1', 'file_size': 12, 'width': 800, 'height': 600}]})
    assert (Path(os.environ['WO_PHOTO_DIR']) / filename).read_bytes() == b'\xff\xd8\xffphoto-test'
    with pytest.raises(ValueError, match='10 MB'):
        save_telegram_photo('test-token', {'photo': [{'file_id': 'large', 'file_size': 11 * 1024 * 1024}]})


def test_metro_future_rfs_scheduled_release_and_noc_gate():
    with TestClient(app) as client:
        admin = client.post('/api/auth/login', json={'email': 'test@nexaisp.local', 'password': 'very-long-test-password'}).json()
        headers = {'Authorization': 'Bearer ' + admin['access_token']}
        plan = client.post('/api/plans', headers=headers, json={'name': 'Metro RFS', 'category': 'METRO_E', 'monthly_fee': 500000}).json()
        with patch('app.main.local_today', return_value=date(2026, 10, 12)):
            customer = client.post('/api/customers', headers=headers, json={'name': 'PT RFS Future',
                'initial_service': {'plan_id': plan['id'], 'rfs_target_date': '2026-12-01'}}).json()
        ticket = next(t for t in client.get('/api/tickets', headers=headers).json() if t['customer_id'] == customer['id'])
        assert ticket['status'] == 'scheduled' and ticket['rfs_target_date'] == '2026-12-01'
        assert ticket['service_code'].startswith('ETH-')
        assert client.put(f"/api/tickets/{ticket['id']}", headers=headers, json={'status': 'closed'}).status_code == 409
        assert release_scheduled_tickets(date(2026, 11, 23)) == 0
        assert release_scheduled_tickets(date(2026, 11, 24)) == 1
        opened = next(t for t in client.get('/api/tickets', headers=headers).json() if t['id'] == ticket['id'])
        assert opened['status'] == 'open'
        assert client.put(f"/api/tickets/{ticket['id']}", headers=headers, json={'status': 'ready'}).status_code == 200
        created = client.post('/api/users/noc', headers=headers, json={'email': 'noc-rfs@example.com', 'password': 'noc-rfs-password-123'})
        assert created.status_code == 201
        noc = client.post('/api/auth/login', json={'email': 'noc-rfs@example.com', 'password': 'noc-rfs-password-123'}).json()
        noc_headers = {'Authorization': 'Bearer ' + noc['access_token']}
        with patch('app.main.local_today', return_value=date(2026, 11, 30)):
            early = client.post(f"/api/tickets/{ticket['id']}/activate", headers=noc_headers,
                                json={'billing_start_date': '2026-12-01', 'notes': 'Link teruji'})
            assert early.status_code == 409
        with patch('app.main.local_today', return_value=date(2026, 12, 1)):
            active = client.post(f"/api/tickets/{ticket['id']}/activate", headers=noc_headers,
                                 json={'billing_start_date': '2026-12-03', 'notes': 'Link teruji'})
        assert active.status_code == 200, active.text
        assert active.json()['status'] == 'closed' and active.json()['start_date'] == '2026-12-03'
        assert active.json()['activated_at'] and active.json()['installed_at']


def test_cdn_noc_group_routing_and_direct_ready():
    metro_group, cdn_group = -100111222333, -100444555666
    def group_message(group_id, user_id, content):
        return {'from': {'id': user_id, 'first_name': 'Petugas NOC'},
                'chat': {'id': group_id, 'type': 'supergroup'}, 'text': content}

    with TestClient(app) as client:
        token = client.post('/api/auth/login', json={'email': 'test@nexaisp.local', 'password': 'very-long-test-password'}).json()['access_token']
        headers = {'Authorization': 'Bearer ' + token}
        config = client.put('/api/telegram', headers=headers, json={
            'work_order_chat_id': metro_group, 'noc_chat_id': cdn_group})
        assert config.status_code == 200, config.text
        assert config.json()['category_teams']['TUNNEL'] == 'noc'
        assert set(config.json()['category_teams']) == {'METRO_E', 'DEDICATED', 'FTTH', 'TUNNEL'}
        assert config.json()['category_teams']['METRO_E'] == 'technician'
        plan = client.post('/api/plans', headers=headers, json={'name': 'Tunnel Transit', 'category': 'TUNNEL',
                                                                 'monthly_fee': 2000000, 'setup_fee': 100000}).json()
        customer = client.post('/api/customers', headers=headers, json={'name': 'PT CDN Baru', 'kind': 'corporate',
            'initial_service': {'plan_id': plan['id'], 'billing_type': 'postpaid'}}).json()
        ticket = next(t for t in client.get('/api/tickets', headers=headers).json() if t['customer_id'] == customer['id'])
        assert ticket['category'] == 'TUNNEL' and ticket['service_code'].startswith('TUN-')
        assert client.put(f"/api/tickets/{ticket['id']}", headers=headers,
                          json={'status': 'survey'}).status_code == 422
        with SessionLocal() as db:
            events = db.scalars(select(TicketEvent).where(TicketEvent.ticket_id == ticket['id'])).all()
            assert events[0].notify_telegram_id == cdn_group
            from app.models import Ticket
            keyboard = work_order_keyboard(db.get(Ticket, ticket['id']))
            assert keyboard['rows'][0]['row']['buttons'][0]['additionalFields']['callback_data'] == f"wo:pickup:{ticket['id']}"
        wrong = handle_message(group_message(metro_group, 707, f"/pickup {ticket['work_order_code']}"))
        assert 'grup tim yang berbeda' in wrong
        assert handle_message(group_message(cdn_group, 707, f"/pickup {ticket['work_order_code']}")).startswith('WO-')
        with SessionLocal() as db:
            keyboard = work_order_keyboard(db.get(Ticket, ticket['id']))
            assert keyboard['rows'][0]['row']['buttons'][0]['additionalFields']['callback_data'] == f"wo:status:ready:{ticket['id']}"
        assert 'READY' in handle_message(group_message(cdn_group, 707, f"/status {ticket['work_order_code']} ready CDN terkonfigurasi"))
        updated = next(t for t in client.get('/api/tickets', headers=headers).json() if t['id'] == ticket['id'])
        assert updated['status'] == 'ready' and updated['technician_name'] == 'Petugas NOC'
        assert updated['events'][-1]['actor_type'] == 'noc_telegram'
        assert activate_as_noc(client, headers, ticket['id'], date.today().isoformat()).status_code == 200
        vpn_plan = client.post('/api/plans', headers=headers, json={'name': 'Tunnel NOC', 'category': 'TUNNEL',
                                                                   'monthly_fee': 300000}).json()
        vpn_customer = client.post('/api/customers', headers=headers, json={'name': 'PT VPN Baru',
            'initial_service': {'plan_id': vpn_plan['id']}}).json()
        vpn_ticket = next(t for t in client.get('/api/tickets', headers=headers).json() if t['customer_id'] == vpn_customer['id'])
        assert vpn_ticket['work_order_team'] == 'noc'
        with SessionLocal() as db:
            assert db.scalars(select(TicketEvent).where(TicketEvent.ticket_id == vpn_ticket['id'])).first().notify_telegram_id == cdn_group
        moved = client.put('/api/telegram', headers=headers, json={'category_teams': {'TUNNEL': 'technician'}})
        assert moved.status_code == 200, moved.text
        with SessionLocal() as db:
            events = db.scalars(select(TicketEvent).where(TicketEvent.ticket_id == vpn_ticket['id']).order_by(TicketEvent.id)).all()
            assert events[-1].notify_telegram_id == metro_group
        assert 'grup tim yang berbeda' in handle_message(group_message(cdn_group, 808, f"/pickup {vpn_ticket['work_order_code']}"))
        assert handle_message(group_message(metro_group, 808, f"/pickup {vpn_ticket['work_order_code']}")).startswith('WO-')
        with SessionLocal() as db:
            keyboard = work_order_keyboard(db.get(Ticket, vpn_ticket['id']))
            assert keyboard['rows'][0]['row']['buttons'][0]['additionalFields']['callback_data'] == f"wo:status:survey:{vpn_ticket['id']}"


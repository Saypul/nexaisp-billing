"""PPPoE provisioning dan isolir ke MikroTik.

Status billing (Subscription.status) tetap menjadi sumber kebenaran. Jaringan disinkronkan
secara best-effort: kegagalan router tidak pernah membatalkan transaksi billing, tetapi
dicatat pada Subscription.network_state/network_error dan tabel network_events.
"""
import base64
import hashlib
import logging
import os
import secrets
import string
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from cryptography.fernet import Fernet, InvalidToken
from sqlalchemy import exists, select
from sqlalchemy.orm import Session, selectinload

from .database import SessionLocal
from .mikrotik import RouterOSClient, RouterOSError
from .models import Invoice, NetworkEvent, NetworkSettings, Router, Subscription

log = logging.getLogger(__name__)
SYSTEM_ACTOR = 'Sistem (isolir otomatis)'


# --- secrets --------------------------------------------------------------
def _cipher():
    secret = os.environ['JWT_SECRET'].encode('utf-8')
    return Fernet(base64.urlsafe_b64encode(hashlib.sha256(b'nexaisp-network-v1:' + secret).digest()))


def encrypt(value: str) -> str:
    return _cipher().encrypt(value.encode('utf-8')).decode('utf-8')


def decrypt(value: str | None) -> str:
    if not value:
        return ''
    try:
        return _cipher().decrypt(value.encode('utf-8')).decode('utf-8')
    except InvalidToken:
        return ''


def generate_password(length: int = 12) -> str:
    alphabet = string.ascii_letters + string.digits
    return ''.join(secrets.choice(alphabet) for _ in range(length))


# --- helpers --------------------------------------------------------------
def client_for(router: Router) -> RouterOSClient:
    return RouterOSClient(router.host, router.port, router.username, decrypt(router.encrypted_password),
                          use_tls=router.use_tls, tls_verify=router.tls_verify)


def record(db: Session, action: str, ok: bool, message: str | None, actor: str,
           router_id: int | None = None, subscription_id: int | None = None):
    db.add(NetworkEvent(action=action, ok=ok, message=(message or '')[:2000] or None, actor=actor,
                        router_id=router_id, subscription_id=subscription_id))


def local_today() -> date:
    return datetime.now(ZoneInfo('Asia/Jakarta')).date()


def get_settings(db: Session) -> NetworkSettings:
    settings = db.get(NetworkSettings, 1)
    if settings is None:
        settings = NetworkSettings(id=1, auto_isolate=False, grace_days=7, auto_restore=True, max_per_run=50)
        db.add(settings)
        db.flush()
    return settings


def is_mapped(sub: Subscription) -> bool:
    return bool(sub.router_id and sub.pppoe_username)


# --- router level ---------------------------------------------------------
def check_router(db: Session, router: Router, actor: str) -> dict:
    """Uji koneksi dan ambil ringkasan resource. Memperbarui identity/version/last_error."""
    router.last_checked_at = datetime.now(timezone.utc)
    try:
        with client_for(router) as api:
            resource = (api.query('/system/resource') or [{}])[0]
            identity = (api.query('/system/identity') or [{}])[0].get('name')
            active = api.talk(['/ppp/active/print', '=count-only='])
        router.identity = identity
        router.version = resource.get('version')
        router.last_error = None
        result = {
            'ok': True, 'identity': identity, 'version': resource.get('version'), 'board': resource.get('board-name'),
            'uptime': resource.get('uptime'), 'cpu_load': _int(resource.get('cpu-load')),
            'free_memory': _int(resource.get('free-memory')), 'total_memory': _int(resource.get('total-memory')),
            'active_sessions': _int((active or [{}])[0].get('ret')),
        }
        record(db, 'test', True, f"{identity} · RouterOS {resource.get('version')}", actor, router.id)
        return result
    except RouterOSError as exc:
        router.last_error = str(exc)
        record(db, 'test', False, str(exc), actor, router.id)
        return {'ok': False, 'error': str(exc)}


def _int(value):
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def active_sessions(router: Router) -> list[dict]:
    with client_for(router) as api:
        rows = api.talk(['/ppp/active/print', '=.proplist=name,service,address,caller-id,uptime'])
    return [{'name': r.get('name'), 'service': r.get('service'), 'address': r.get('address'),
             'caller_id': r.get('caller-id'), 'uptime': r.get('uptime')} for r in rows]


# --- subscription level ---------------------------------------------------
def apply(db: Session, sub: Subscription, actor: str, action: str, disconnect: bool = False) -> dict:
    """Menyelaraskan PPP secret di router dengan state di database (idempotent)."""
    if not is_mapped(sub):
        return {'ok': False, 'skipped': True, 'error': 'Layanan belum dipetakan ke router dan username PPPoE.'}
    router = sub.router or db.get(Router, sub.router_id)
    if not router.enabled:
        return {'ok': False, 'skipped': True, 'error': f'Router {router.name} sedang dinonaktifkan di NexaISP.'}
    isolated = sub.isolation_reason is not None
    profile = (sub.plan.pppoe_profile or 'default') if sub.plan else 'default'
    disabled = 'no'
    if isolated:
        if router.isolation_mode == 'profile' and router.isolation_profile:
            profile = router.isolation_profile
        else:
            disabled = 'yes'
    attrs = {
        'password': decrypt(sub.encrypted_pppoe_password), 'service': 'pppoe', 'profile': profile,
        'disabled': disabled, 'comment': f'NexaISP {sub.code} {sub.customer.name if sub.customer else ""}'.strip()[:200],
    }
    try:
        with client_for(router) as api:
            found = api.query('/ppp/secret', name=sub.pppoe_username)
            if found:
                api.run('/ppp/secret/set', **{'.id': found[0]['.id']}, **attrs)
            else:
                api.run('/ppp/secret/add', name=sub.pppoe_username, **attrs)
            kicked = 0
            if disconnect:
                for session in api.query('/ppp/active', name=sub.pppoe_username):
                    api.run('/ppp/active/remove', **{'.id': session['.id']})
                    kicked += 1
    except RouterOSError as exc:
        sub.network_state = 'error'
        sub.network_error = str(exc)
        record(db, action, False, str(exc), actor, router.id, sub.id)
        return {'ok': False, 'error': str(exc)}
    sub.network_state = 'isolated' if isolated else 'provisioned'
    sub.network_error = None
    sub.network_synced_at = datetime.now(timezone.utc)
    detail = f'{sub.pppoe_username} → profile {profile}' + (', disabled' if disabled == 'yes' else '')
    if kicked:
        detail += f', {kicked} sesi diputus'
    record(db, action, True, detail, actor, router.id, sub.id)
    return {'ok': True, 'state': sub.network_state, 'message': detail}


def isolate(db: Session, sub: Subscription, reason: str, actor: str) -> dict:
    # Isolir manual menang atas isolir karena tunggakan, agar pelunasan tidak membuka layanan yang di-suspend admin.
    if sub.isolation_reason != 'manual':
        sub.isolation_reason = reason
    return apply(db, sub, actor, 'isolate', disconnect=True)


def restore(db: Session, sub: Subscription, actor: str, only_reason: str | None = None) -> dict:
    if only_reason and sub.isolation_reason != only_reason:
        return {'ok': True, 'skipped': True, 'state': sub.network_state}
    sub.isolation_reason = None
    return apply(db, sub, actor, 'restore', disconnect=True)


def sync_billing_status(db: Session, sub: Subscription, actor: str) -> dict | None:
    """Dipanggil setelah status billing berubah. Mengembalikan None jika layanan tidak dikelola jaringan."""
    if not is_mapped(sub):
        return None
    if sub.status in ('suspended', 'terminated'):
        return isolate(db, sub, 'manual', actor)
    if sub.status == 'active' and sub.isolation_reason == 'manual':
        return restore(db, sub, actor)
    return None


# --- isolir otomatis karena tunggakan --------------------------------------
def _overdue_exists(cutoff: date):
    return exists().where(Invoice.customer_id == Subscription.customer_id, Invoice.status != 'paid', Invoice.due_date <= cutoff)


def overdue_candidates(db: Session, settings: NetworkSettings, today: date):
    cutoff = today - timedelta(days=settings.grace_days)
    return db.scalars(
        select(Subscription).options(selectinload(Subscription.plan), selectinload(Subscription.customer), selectinload(Subscription.router))
        .where(Subscription.status == 'active', Subscription.router_id.is_not(None), Subscription.pppoe_username.is_not(None),
               Subscription.isolation_reason.is_(None), _overdue_exists(cutoff))
        .order_by(Subscription.id)
    ).all()


def restore_candidates(db: Session, settings: NetworkSettings, today: date, customer_id: int | None = None):
    cutoff = today - timedelta(days=settings.grace_days)
    query = (select(Subscription).options(selectinload(Subscription.plan), selectinload(Subscription.customer), selectinload(Subscription.router))
             .where(Subscription.isolation_reason == 'overdue', ~_overdue_exists(cutoff)))
    if customer_id is not None:
        query = query.where(Subscription.customer_id == customer_id)
    return db.scalars(query.order_by(Subscription.id)).all()


def run_auto_isolation(today: date) -> dict:
    """Satu putaran kebijakan: pulihkan yang sudah lunas, lalu isolir tunggakan (dibatasi max_per_run)."""
    with SessionLocal() as db:
        settings = get_settings(db)
        db.commit()
        restored = isolated = failed = 0
        if settings.auto_restore:
            for sub in restore_candidates(db, settings, today):
                result = restore(db, sub, SYSTEM_ACTOR, only_reason='overdue')
                restored += result.get('ok', False)
                failed += not result.get('ok', False)
                db.commit()
        if settings.auto_isolate:
            for sub in overdue_candidates(db, settings, today)[:settings.max_per_run]:
                result = isolate(db, sub, 'overdue', SYSTEM_ACTOR)
                isolated += result.get('ok', False)
                failed += not result.get('ok', False)
                db.commit()
        return {'isolated': isolated, 'restored': restored, 'failed': failed}


def restore_paid_customer(customer_id: int, today: date):
    """Dipanggil di background setelah pembayaran agar pemulihan tidak menunggu putaran per jam."""
    try:
        with SessionLocal() as db:
            settings = get_settings(db)
            if not settings.auto_restore:
                return
            for sub in restore_candidates(db, settings, today, customer_id):
                restore(db, sub, SYSTEM_ACTOR + ' · pembayaran', only_reason='overdue')
                db.commit()
    except Exception:
        log.exception('Gagal memulihkan layanan setelah pembayaran pelanggan %s', customer_id)

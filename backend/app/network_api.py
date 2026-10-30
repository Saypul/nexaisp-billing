"""Endpoint /api/routers dan /api/network: router MikroTik, pemetaan PPPoE, isolir, dan audit."""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from . import network
from .database import get_db
from .mikrotik import RouterOSError
from .models import NetworkEvent, Router, Subscription, User
from .schemas import NetworkAssign, NetworkSettingsUpdate, RouterCreate, RouterUpdate
from .security import admin_only, admin_or_noc

api = APIRouter(prefix='/api')


def commit(db: Session):
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, 'Nama router sudah dipakai atau data terkait tidak valid') from None


def router_view(router: Router, services: int = 0) -> dict:
    return {
        'id': router.id, 'name': router.name, 'host': router.host, 'port': router.port,
        'use_tls': router.use_tls, 'tls_verify': router.tls_verify, 'username': router.username,
        'isolation_mode': router.isolation_mode, 'isolation_profile': router.isolation_profile,
        'enabled': router.enabled, 'identity': router.identity, 'version': router.version,
        'last_checked_at': router.last_checked_at, 'last_error': router.last_error, 'services': services,
    }


def get_router(db: Session, router_id: int) -> Router:
    router = db.get(Router, router_id)
    if router is None:
        raise HTTPException(404, 'Router tidak ditemukan')
    return router


def validate_isolation(mode: str, profile: str | None):
    if mode == 'profile' and not (profile or '').strip():
        raise HTTPException(422, 'Isi nama PPP profile isolir bila mode isolir memakai profile.')


# --- routers --------------------------------------------------------------
@api.get('/routers')
def list_routers(db: Session = Depends(get_db), _: User = Depends(admin_or_noc)):
    counts = dict(db.execute(select(Subscription.router_id, func.count(Subscription.id)).where(Subscription.router_id.is_not(None)).group_by(Subscription.router_id)).all())
    return [router_view(r, counts.get(r.id, 0)) for r in db.scalars(select(Router).order_by(Router.name)).all()]


@api.post('/routers', status_code=201)
def create_router(data: RouterCreate, db: Session = Depends(get_db), user: User = Depends(admin_only)):
    validate_isolation(data.isolation_mode, data.isolation_profile)
    values = data.model_dump(exclude={'password'})
    router = Router(**values, encrypted_password=network.encrypt(data.password))
    db.add(router)
    commit(db)
    network.record(db, 'router_create', True, f'{router.name} ({router.host}:{router.port})', user.email, router.id)
    commit(db)
    return router_view(router)


@api.put('/routers/{router_id}')
def update_router(router_id: int, data: RouterUpdate, db: Session = Depends(get_db), user: User = Depends(admin_only)):
    router = get_router(db, router_id)
    validate_isolation(data.isolation_mode, data.isolation_profile)
    for key, value in data.model_dump(exclude={'password'}).items():
        setattr(router, key, value)
    if data.password:
        router.encrypted_password = network.encrypt(data.password)
    network.record(db, 'router_update', True, router.name, user.email, router.id)
    commit(db)
    return router_view(router, db.scalar(select(func.count(Subscription.id)).where(Subscription.router_id == router.id)) or 0)


@api.delete('/routers/{router_id}', status_code=204)
def delete_router(router_id: int, db: Session = Depends(get_db), user: User = Depends(admin_only)):
    router = get_router(db, router_id)
    if db.scalar(select(Subscription.id).where(Subscription.router_id == router_id).limit(1)):
        raise HTTPException(409, 'Router masih dipakai layanan pelanggan. Pindahkan pemetaan layanan terlebih dahulu.')
    network.record(db, 'router_delete', True, router.name, user.email, None)
    db.delete(router)
    commit(db)


@api.post('/routers/{router_id}/test')
def test_router(router_id: int, db: Session = Depends(get_db), user: User = Depends(admin_or_noc)):
    router = get_router(db, router_id)
    result = network.check_router(db, router, user.email)
    commit(db)
    return result


@api.get('/routers/{router_id}/sessions')
def router_sessions(router_id: int, db: Session = Depends(get_db), _: User = Depends(admin_or_noc)):
    router = get_router(db, router_id)
    try:
        sessions = network.active_sessions(router)
    except RouterOSError as exc:
        raise HTTPException(502, str(exc)) from None
    # Cocokkan sesi dengan layanan NexaISP berdasarkan username PPPoE.
    mapped = {s.pppoe_username: s for s in db.scalars(select(Subscription).options(selectinload(Subscription.customer)).where(Subscription.router_id == router_id)).all()}
    for row in sessions:
        sub = mapped.get(row['name'])
        row.update(subscription_id=sub.id if sub else None, service_code=sub.code if sub else None,
                   customer_id=sub.customer_id if sub else None, customer_name=sub.customer.name if sub else None)
    return sessions


# --- subscription mapping & actions ---------------------------------------
def get_subscription(db: Session, subscription_id: int) -> Subscription:
    sub = db.get(Subscription, subscription_id)
    if sub is None:
        raise HTTPException(404, 'Layanan tidak ditemukan')
    return sub


def network_view(sub: Subscription) -> dict:
    return {
        'subscription_id': sub.id, 'router_id': sub.router_id, 'router_name': sub.router.name if sub.router else None,
        'pppoe_username': sub.pppoe_username, 'has_password': bool(sub.encrypted_pppoe_password),
        'network_state': sub.network_state, 'isolation_reason': sub.isolation_reason,
        'network_error': sub.network_error, 'network_synced_at': sub.network_synced_at,
    }


@api.put('/subscriptions/{subscription_id}/network')
def assign_network(subscription_id: int, data: NetworkAssign, db: Session = Depends(get_db), user: User = Depends(admin_or_noc)):
    sub = get_subscription(db, subscription_id)
    if data.router_id is None:
        if sub.network_state in ('provisioned', 'isolated'):
            raise HTTPException(409, 'Layanan masih terpasang di router. Hapus/nonaktifkan secret di router lalu lepaskan pemetaan.')
        sub.router_id = sub.pppoe_username = sub.encrypted_pppoe_password = None
        sub.network_state, sub.network_error = 'unconfigured', None
        network.record(db, 'unassign', True, sub.code, user.email, None, sub.id)
        commit(db)
        return {'network': network_view(sub), 'result': None}
    get_router(db, data.router_id)
    username = (data.pppoe_username or '').strip() or sub.code.lower()
    duplicate = db.scalar(select(Subscription.code).where(Subscription.router_id == data.router_id, Subscription.pppoe_username == username, Subscription.id != sub.id))
    if duplicate:
        raise HTTPException(409, f'Username PPPoE {username} sudah dipakai layanan {duplicate} di router ini.')
    if sub.router_id and sub.router_id != data.router_id and sub.network_state in ('provisioned', 'isolated'):
        raise HTTPException(409, 'Layanan sudah terpasang di router lain. Pindah router belum didukung otomatis; hapus secret di router lama terlebih dahulu.')
    sub.router_id = data.router_id
    sub.pppoe_username = username
    if data.pppoe_password or not sub.encrypted_pppoe_password:
        sub.encrypted_pppoe_password = network.encrypt(data.pppoe_password or network.generate_password())
    network.record(db, 'assign', True, f'{sub.code} → {username}', user.email, data.router_id, sub.id)
    db.flush()
    db.refresh(sub)
    result = None
    # Layanan pending baru di-provision saat aktivasi NOC.
    if data.provision and sub.status != 'pending':
        result = network.apply(db, sub, user.email, 'provision')
    commit(db)
    return {'network': network_view(sub), 'result': result}


@api.get('/subscriptions/{subscription_id}/network/credentials')
def reveal_credentials(subscription_id: int, db: Session = Depends(get_db), user: User = Depends(admin_or_noc)):
    sub = get_subscription(db, subscription_id)
    if not sub.pppoe_username:
        raise HTTPException(404, 'Layanan belum memiliki akun PPPoE')
    network.record(db, 'reveal', True, f'Kredensial {sub.pppoe_username} dilihat', user.email, sub.router_id, sub.id)
    commit(db)
    return {'pppoe_username': sub.pppoe_username, 'pppoe_password': network.decrypt(sub.encrypted_pppoe_password)}


@api.post('/subscriptions/{subscription_id}/network/provision')
def provision(subscription_id: int, db: Session = Depends(get_db), user: User = Depends(admin_or_noc)):
    sub = get_subscription(db, subscription_id)
    if sub.status == 'pending':
        raise HTTPException(409, 'Layanan pending di-provision otomatis saat NOC mengaktifkan ticket.')
    result = network.apply(db, sub, user.email, 'provision')
    commit(db)
    return {'network': network_view(sub), 'result': result}


@api.post('/subscriptions/{subscription_id}/network/isolate')
def isolate(subscription_id: int, db: Session = Depends(get_db), user: User = Depends(admin_only)):
    sub = get_subscription(db, subscription_id)
    if not network.is_mapped(sub):
        raise HTTPException(409, 'Layanan belum dipetakan ke router.')
    result = network.isolate(db, sub, 'manual', user.email)
    commit(db)
    return {'network': network_view(sub), 'result': result}


@api.post('/subscriptions/{subscription_id}/network/restore')
def restore(subscription_id: int, db: Session = Depends(get_db), user: User = Depends(admin_only)):
    sub = get_subscription(db, subscription_id)
    if not network.is_mapped(sub):
        raise HTTPException(409, 'Layanan belum dipetakan ke router.')
    if sub.status != 'active':
        raise HTTPException(409, 'Aktifkan status billing layanan terlebih dahulu sebelum membuka isolir.')
    result = network.restore(db, sub, user.email)
    commit(db)
    return {'network': network_view(sub), 'result': result}


# --- policy & audit -------------------------------------------------------
def settings_view(settings) -> dict:
    return {'auto_isolate': settings.auto_isolate, 'grace_days': settings.grace_days,
            'auto_restore': settings.auto_restore, 'max_per_run': settings.max_per_run}


@api.get('/network/settings')
def read_settings(db: Session = Depends(get_db), _: User = Depends(admin_only)):
    settings = network.get_settings(db)
    commit(db)
    return settings_view(settings)


@api.put('/network/settings')
def update_settings(data: NetworkSettingsUpdate, db: Session = Depends(get_db), user: User = Depends(admin_only)):
    settings = network.get_settings(db)
    for key, value in data.model_dump().items():
        setattr(settings, key, value)
    network.record(db, 'policy', True, f"Isolir otomatis {'aktif' if data.auto_isolate else 'nonaktif'}, toleransi {data.grace_days} hari, "
                   f"pemulihan otomatis {'aktif' if data.auto_restore else 'nonaktif'}, maks {data.max_per_run}/putaran", user.email)
    commit(db)
    return settings_view(settings)


@api.get('/network/auto-isolate/preview')
def preview_auto_isolation(db: Session = Depends(get_db), _: User = Depends(admin_only)):
    """Daftar layanan yang AKAN diisolir/dipulihkan pada putaran berikutnya, tanpa menyentuh router."""
    settings = network.get_settings(db)
    today = network.local_today()
    def row(s):
        return {'subscription_id': s.id, 'service_code': s.code, 'customer_id': s.customer_id, 'customer_name': s.customer.name,
                'pppoe_username': s.pppoe_username, 'router_name': s.router.name if s.router else None}
    isolate_rows = [row(s) for s in network.overdue_candidates(db, settings, today)]
    return {'settings': settings_view(settings), 'isolate': isolate_rows[:settings.max_per_run], 'isolate_total': len(isolate_rows),
            'restore': [row(s) for s in network.restore_candidates(db, settings, today)]}


@api.get('/network/events')
def list_events(limit: int = 500, db: Session = Depends(get_db), _: User = Depends(admin_only)):
    limit = max(1, min(limit, 5000))
    rows = db.execute(
        select(NetworkEvent, Router.name, Subscription.code, Subscription.customer_id)
        .outerjoin(Router, Router.id == NetworkEvent.router_id)
        .outerjoin(Subscription, Subscription.id == NetworkEvent.subscription_id)
        .order_by(NetworkEvent.id.desc()).limit(limit)
    ).all()
    return [{'id': e.id, 'action': e.action, 'ok': e.ok, 'message': e.message, 'actor': e.actor, 'created_at': e.created_at,
             'router_id': e.router_id, 'router_name': rname, 'subscription_id': e.subscription_id, 'service_code': code,
             'customer_id': cid} for e, rname, code, cid in rows]

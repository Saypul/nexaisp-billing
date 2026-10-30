"""Manajemen PPP Profile dan PPP Secret (user PPPoE) langsung di router MikroTik.

Data dibaca langsung dari router (bukan cache) agar selalu sesuai konfigurasi aktual. Secret yang
terhubung ke layanan NexaISP dijaga konsisten: profile & status aktif-nya mengikuti paket dan status
billing, sehingga hanya bisa diubah lewat menu layanan.
"""
import ipaddress

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from . import network
from .database import get_db
from .mikrotik import RouterOSError, RouterOSTrap
from .models import Router, ServicePlan, Subscription, User
from .schemas import PppProfileIn, PppSecretIn
from .security import admin_only, admin_or_noc

api = APIRouter(prefix='/api/routers/{router_id}')

PROFILE_FIELDS = {'local_address': 'local-address', 'remote_address': 'remote-address', 'rate_limit': 'rate-limit',
                  'dns_server': 'dns-server', 'only_one': 'only-one', 'comment': 'comment'}
SECRET_FIELDS = {'service': 'service', 'profile': 'profile', 'local_address': 'local-address',
                 'remote_address': 'remote-address', 'comment': 'comment'}
SECRET_PROPLIST = '.id,name,service,profile,local-address,remote-address,disabled,comment,last-logged-out,caller-id'


def get_router(db: Session, router_id: int) -> Router:
    router = db.get(Router, router_id)
    if router is None:
        raise HTTPException(404, 'Router tidak ditemukan')
    if not router.enabled:
        raise HTTPException(409, f'Router {router.name} dinonaktifkan di NexaISP.')
    return router


def router_call(router: Router, fn):
    """Baca dari router; gangguan koneksi → 502, penolakan perintah → 422."""
    try:
        with network.client_for(router) as client:
            return fn(client)
    except RouterOSTrap as exc:
        raise HTTPException(422, f'Router menolak: {exc}') from None
    except RouterOSError as exc:
        raise HTTPException(502, str(exc)) from None


def router_write(db: Session, router: Router, user: User, action: str, message: str, fn, subscription_id=None):
    """Seperti router_call, tetapi setiap percobaan (berhasil/gagal) masuk log audit."""
    try:
        with network.client_for(router) as client:
            result = fn(client)
    except RouterOSError as exc:
        network.record(db, action, False, f'{message}: {exc}', user.email, router.id, subscription_id)
        db.commit()
        status = 422 if isinstance(exc, RouterOSTrap) else 502
        raise HTTPException(status, (f'Router menolak: {exc}' if status == 422 else str(exc))) from None
    network.record(db, action, True, message(result) if callable(message) else message, user.email, router.id, subscription_id)
    return result


def find(client, path: str, item_id: str) -> dict:
    found = client.query(path, **{'.id': item_id})
    if not found:
        raise HTTPException(404, 'Data tidak ditemukan di router (mungkin sudah dihapus dari Winbox).')
    return found[0]


def write_attrs(client, path: str, item_id: str | None, values: dict, fields: dict, current: dict | None = None):
    """add bila item_id None; set + unset (untuk nilai yang dikosongkan) bila item sudah ada."""
    attrs = {fields[k]: v for k, v in values.items() if k in fields and v not in (None, '')}
    if item_id is None:
        return client.run(path + '/add', **attrs)
    client.run(path + '/set', **{'.id': item_id}, **attrs)
    for key, attr in fields.items():
        if values.get(key) in (None, '') and current and current.get(attr):
            client.run(path + '/unset', **{'.id': item_id, 'value-name': attr})


# --- pools ----------------------------------------------------------------
def pool_start(ranges: str | None):
    """IP pertama dari kolom ranges RouterOS ("a-b", "a/24", atau beberapa dipisah koma)."""
    first = (ranges or '').split(',')[0].strip()
    try:
        if '/' in first:
            return ipaddress.ip_network(first, strict=False).network_address, True
        return ipaddress.ip_address(first.split('-')[0].strip()), False
    except ValueError:
        return None, False


def suggest_gateway(ranges: str | None, interface_addresses: list[str]) -> tuple[str | None, str | None]:
    """Saran local-address untuk profile PPP: IP interface router di subnet pool, atau IP sebelum awal range."""
    start, is_cidr = pool_start(ranges)
    if start is None or start.version != 4:
        return None, None
    for cidr in interface_addresses:
        try:
            iface = ipaddress.ip_interface(cidr)
        except ValueError:
            continue
        if iface.version == 4 and start in iface.network:
            return str(iface.ip), 'interface'
    if not is_cidr and int(start) & 0xFF > 1:
        return str(start - 1), 'before_range'
    return None, None


@api.get('/pools')
def list_pools(router_id: int, db: Session = Depends(get_db), _: User = Depends(admin_or_noc)):
    def load(c):
        return c.talk(['/ip/pool/print', '=.proplist=name,ranges']), c.talk(['/ip/address/print', '=.proplist=address,disabled'])
    pools, addresses = router_call(get_router(db, router_id), load)
    active = [a.get('address') for a in addresses if a.get('address') and a.get('disabled') != 'true']
    rows = []
    for r in pools:
        gateway, source = suggest_gateway(r.get('ranges'), active)
        rows.append({'name': r.get('name'), 'ranges': r.get('ranges'), 'gateway': gateway, 'gateway_source': source})
    return rows


# --- PPP profiles ---------------------------------------------------------
def profile_usage(db: Session, router: Router) -> dict[str, list[str]]:
    usage = {}
    for name, profile in db.execute(select(ServicePlan.name, ServicePlan.pppoe_profile).where(ServicePlan.pppoe_profile.is_not(None))).all():
        usage.setdefault(profile, []).append('Paket ' + name)
    if router.isolation_mode == 'profile' and router.isolation_profile:
        usage.setdefault(router.isolation_profile, []).append('Profile isolir router')
    return usage


@api.get('/profiles')
def list_profiles(router_id: int, db: Session = Depends(get_db), _: User = Depends(admin_or_noc)):
    router = get_router(db, router_id)
    def load(c):
        profiles = c.talk(['/ppp/profile/print', '=.proplist=.id,name,local-address,remote-address,rate-limit,dns-server,only-one,comment,default'])
        secrets = c.talk(['/ppp/secret/print', '=.proplist=profile'])
        return profiles, secrets
    profiles, secrets = router_call(router, load)
    counts = {}
    for s in secrets:
        counts[s.get('profile')] = counts.get(s.get('profile'), 0) + 1
    usage = profile_usage(db, router)
    return [{
        'id': p.get('.id'), 'name': p.get('name'), 'local_address': p.get('local-address'), 'remote_address': p.get('remote-address'),
        'rate_limit': p.get('rate-limit'), 'dns_server': p.get('dns-server'), 'only_one': p.get('only-one'), 'comment': p.get('comment'),
        'builtin': p.get('default') == 'true', 'secrets': counts.get(p.get('name'), 0), 'used_by': usage.get(p.get('name'), []),
    } for p in profiles]


@api.post('/profiles', status_code=201)
def create_profile(router_id: int, data: PppProfileIn, db: Session = Depends(get_db), user: User = Depends(admin_only)):
    router = get_router(db, router_id)
    router_write(db, router, user, 'profile_create', f'Profile {data.name} ({data.rate_limit or "tanpa rate-limit"})',
                 lambda c: c.run('/ppp/profile/add', name=data.name, **{PROFILE_FIELDS[k]: v for k, v in data.model_dump(exclude={'name'}).items() if v not in (None, '')}))
    db.commit()
    return {'ok': True}


@api.put('/profiles/{profile_id}')
def update_profile(router_id: int, profile_id: str, data: PppProfileIn, db: Session = Depends(get_db), user: User = Depends(admin_only)):
    router = get_router(db, router_id)
    usage = profile_usage(db, router)
    def update(c):
        current = find(c, '/ppp/profile', profile_id)
        if current.get('name') != data.name:
            if current.get('default') == 'true':
                raise HTTPException(409, 'Profile bawaan RouterOS tidak dapat diganti nama.')
            if usage.get(current.get('name')):
                raise HTTPException(409, f"Profile dipakai {', '.join(usage[current.get('name')])}. Ubah referensinya dulu sebelum mengganti nama.")
        write_attrs(c, '/ppp/profile', profile_id, data.model_dump(), PROFILE_FIELDS, current)
        if current.get('name') != data.name:
            c.run('/ppp/profile/set', **{'.id': profile_id, 'name': data.name})
    router_write(db, router, user, 'profile_update', f'Profile {data.name}', update)
    db.commit()
    return {'ok': True}


@api.delete('/profiles/{profile_id}', status_code=204)
def delete_profile(router_id: int, profile_id: str, db: Session = Depends(get_db), user: User = Depends(admin_only)):
    router = get_router(db, router_id)
    usage = profile_usage(db, router)
    def remove(c):
        current = find(c, '/ppp/profile', profile_id)
        name = current.get('name')
        if current.get('default') == 'true':
            raise HTTPException(409, 'Profile bawaan RouterOS tidak dapat dihapus.')
        if usage.get(name):
            raise HTTPException(409, f"Profile dipakai {', '.join(usage[name])}.")
        users = c.query('/ppp/secret', profile=name)
        if users:
            raise HTTPException(409, f'Profile masih dipakai {len(users)} user PPP di router ini.')
        c.run('/ppp/profile/remove', **{'.id': profile_id})
        return name
    router_write(db, router, user, 'profile_delete', lambda name: f'Profile {name}', remove)
    db.commit()


# --- PPP secrets (user PPPoE) ---------------------------------------------
def mapped_subscriptions(db: Session, router_id: int) -> dict[str, Subscription]:
    rows = db.scalars(select(Subscription).options(selectinload(Subscription.customer), selectinload(Subscription.plan)).where(Subscription.router_id == router_id)).all()
    return {s.pppoe_username: s for s in rows if s.pppoe_username}


@api.get('/secrets')
def list_secrets(router_id: int, db: Session = Depends(get_db), _: User = Depends(admin_or_noc)):
    router = get_router(db, router_id)
    def load(c):
        return c.talk(['/ppp/secret/print', '=.proplist=' + SECRET_PROPLIST]), c.talk(['/ppp/active/print', '=.proplist=name,address,uptime'])
    secrets, active = router_call(router, load)
    online = {a.get('name'): a for a in active}
    mapped = mapped_subscriptions(db, router_id)
    rows = []
    for s in secrets:
        sub = mapped.get(s.get('name'))
        session = online.get(s.get('name'))
        rows.append({
            # Password sengaja tidak pernah dikirim ke browser dari endpoint daftar.
            'id': s.get('.id'), 'name': s.get('name'), 'service': s.get('service'), 'profile': s.get('profile'),
            'local_address': s.get('local-address'), 'remote_address': s.get('remote-address'),
            'disabled': s.get('disabled') == 'true', 'comment': s.get('comment'),
            'last_logged_out': s.get('last-logged-out'), 'caller_id': s.get('caller-id'),
            'online': bool(session), 'address': session.get('address') if session else None, 'uptime': session.get('uptime') if session else None,
            'subscription_id': sub.id if sub else None, 'service_code': sub.code if sub else None,
            'customer_id': sub.customer_id if sub else None, 'customer_name': sub.customer.name if sub else None,
        })
    return rows


def link_subscription(db: Session, router: Router, subscription_id: int, username: str, password: str) -> Subscription:
    sub = db.get(Subscription, subscription_id)
    if sub is None:
        raise HTTPException(404, 'Layanan tidak ditemukan')
    if sub.router_id and (sub.router_id != router.id or sub.pppoe_username != username) and sub.network_state in ('provisioned', 'isolated'):
        raise HTTPException(409, f'Layanan {sub.code} sudah terpasang sebagai {sub.pppoe_username}. Lepas pemetaan lamanya dulu.')
    other = db.scalar(select(Subscription.code).where(Subscription.router_id == router.id, Subscription.pppoe_username == username, Subscription.id != sub.id))
    if other:
        raise HTTPException(409, f'Username {username} sudah terhubung ke layanan {other}.')
    sub.router_id, sub.pppoe_username = router.id, username
    sub.encrypted_pppoe_password = network.encrypt(password)
    return sub


@api.post('/secrets', status_code=201)
def create_secret(router_id: int, data: PppSecretIn, db: Session = Depends(get_db), user: User = Depends(admin_only)):
    router = get_router(db, router_id)
    password = data.password or network.generate_password()
    sub = link_subscription(db, router, data.subscription_id, data.name, password) if data.subscription_id else None
    values = data.model_dump()
    if sub is not None:
        # Secret milik layanan: profile & status mengikuti paket dan billing.
        db.flush()
        result = network.apply(db, sub, user.email, 'provision')
        if not result['ok']:
            db.commit()
            raise HTTPException(502, result['error'])
        static = {k: v for k, v in (('local_address', data.local_address), ('remote_address', data.remote_address)) if v}
        if static:
            def set_static(c):
                secret = c.query('/ppp/secret', name=data.name)[0]
                c.run('/ppp/secret/set', **{'.id': secret['.id']}, **{SECRET_FIELDS[k]: v for k, v in static.items()})
            router_write(db, router, user, 'secret_update', f"User {data.name} · alamat statis {static.get('remote_address', '')}", set_static, sub.id)
        db.commit()
        return {'ok': True, 'subscription_id': sub.id, 'password': None if data.password else password}
    attrs = {SECRET_FIELDS[k]: v for k, v in values.items() if k in SECRET_FIELDS and v not in (None, '')}
    router_write(db, router, user, 'secret_create', f'User {data.name} · profile {data.profile or "default"}',
                 lambda c: c.run('/ppp/secret/add', name=data.name, password=password, disabled='yes' if data.disabled else 'no', **attrs))
    db.commit()
    return {'ok': True, 'password': None if data.password else password}


@api.put('/secrets/{secret_id}')
def update_secret(router_id: int, secret_id: str, data: PppSecretIn, db: Session = Depends(get_db), user: User = Depends(admin_only)):
    router = get_router(db, router_id)
    mapped = mapped_subscriptions(db, router_id)
    def update(c):
        current = find(c, '/ppp/secret', secret_id)
        sub = mapped.get(current.get('name'))
        if sub is not None:
            if (data.profile or 'default') != (current.get('profile') or 'default') or data.disabled != (current.get('disabled') == 'true'):
                raise HTTPException(409, f'User ini dikelola layanan {sub.code}: profile mengikuti paket dan aktif/nonaktif mengikuti status billing. Ubah lewat menu Layanan.')
            if data.name != current.get('name'):
                clash = db.scalar(select(Subscription.code).where(Subscription.router_id == router_id, Subscription.pppoe_username == data.name, Subscription.id != sub.id))
                if clash:
                    raise HTTPException(409, f'Username {data.name} sudah terhubung ke layanan {clash}.')
        write_attrs(c, '/ppp/secret', secret_id, data.model_dump(), SECRET_FIELDS, current)
        extra = {'disabled': 'yes' if data.disabled else 'no'}
        if data.name != current.get('name'):
            extra['name'] = data.name
        if data.password:
            extra['password'] = data.password
        c.run('/ppp/secret/set', **{'.id': secret_id}, **extra)
        if sub is not None:
            sub.pppoe_username = data.name
            if data.password:
                sub.encrypted_pppoe_password = network.encrypt(data.password)
        return sub
    sub = router_write(db, router, user, 'secret_update', f'User {data.name}' + (' (password diganti)' if data.password else ''), update)
    db.commit()
    return {'ok': True, 'subscription_id': sub.id if sub else None}


@api.delete('/secrets/{secret_id}', status_code=204)
def delete_secret(router_id: int, secret_id: str, db: Session = Depends(get_db), user: User = Depends(admin_only)):
    router = get_router(db, router_id)
    mapped = mapped_subscriptions(db, router_id)
    def remove(c):
        current = find(c, '/ppp/secret', secret_id)
        sub = mapped.get(current.get('name'))
        if sub is not None:
            raise HTTPException(409, f'User ini terhubung ke layanan {sub.code}. Lepas pemetaan di menu Layanan terlebih dahulu.')
        c.run('/ppp/secret/remove', **{'.id': secret_id})
        for session in c.query('/ppp/active', name=current.get('name')):
            c.run('/ppp/active/remove', **{'.id': session['.id']})
        return current.get('name')
    router_write(db, router, user, 'secret_delete', lambda name: f'User {name}', remove)
    db.commit()


@api.post('/secrets/{secret_id}/disconnect')
def disconnect_secret(router_id: int, secret_id: str, db: Session = Depends(get_db), user: User = Depends(admin_only)):
    router = get_router(db, router_id)
    def kick(c):
        current = find(c, '/ppp/secret', secret_id)
        sessions = c.query('/ppp/active', name=current.get('name'))
        for session in sessions:
            c.run('/ppp/active/remove', **{'.id': session['.id']})
        return current.get('name'), len(sessions)
    name, count = router_write(db, router, user, 'disconnect', lambda r: f'Putus {r[1]} sesi user {r[0]}', kick)
    db.commit()
    return {'ok': True, 'name': name, 'disconnected': count}

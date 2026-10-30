"""MikroTik integration: protocol, provisioning, manual and automatic isolation."""
import os
import tempfile
from datetime import date
from pathlib import Path
from unittest.mock import patch

TEST_DIR = tempfile.mkdtemp(prefix='nexaisp-net-tests-')
os.environ.setdefault('DATABASE_URL', 'sqlite:///' + str(Path(TEST_DIR) / 'test.sqlite3'))
os.environ.setdefault('JWT_SECRET', 'test-key-local-smoke-only-please-do-not-use-in-prod')
os.environ.setdefault('ADMIN_EMAIL', 'test@nexaisp.local')
os.environ.setdefault('ADMIN_PASSWORD', 'very-long-test-password')
os.environ.setdefault('WO_PHOTO_DIR', str(Path(TEST_DIR) / 'photos'))

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app import network
from app.mikrotik import RouterOSClient, RouterOSError, encode_length
from fake_routeros import FakeRouter, unused_port


@pytest.fixture()
def fake():
    router = FakeRouter()
    yield router
    router.close()


def admin(client):
    token = client.post('/api/auth/login', json={'email': 'test@nexaisp.local', 'password': 'very-long-test-password'}).json()['access_token']
    return {'Authorization': 'Bearer ' + token}


def noc(client, h):
    client.post('/api/users/noc', headers=h, json={'email': 'noc@example.com', 'password': 'noc-test-password-123'})
    token = client.post('/api/auth/login', json={'email': 'noc@example.com', 'password': 'noc-test-password-123'}).json()['access_token']
    return {'Authorization': 'Bearer ' + token}


def add_router(client, h, port, name, **extra):
    body = {'name': name, 'host': '127.0.0.1', 'port': port, 'username': 'api', 'password': 'secret', **extra}
    r = client.post('/api/routers', headers=h, json=body)
    assert r.status_code == 201, r.text
    return r.json()


def new_active_service(client, h, router_id=None, username=None, start='2026-09-01'):
    """Pelanggan FTTH manual-invoice yang diaktifkan NOC, opsional dengan pemetaan router saat aktivasi."""
    plan = client.post('/api/plans', headers=h, json={'name': 'Home 30M', 'category': 'FTTH', 'monthly_fee': 200000, 'pppoe_profile': 'paket-30m'}).json()
    customer = client.post('/api/customers', headers=h, json={'name': 'Pelanggan PPPoE', 'kind': 'residential'}).json()
    ticket = client.post('/api/tickets', headers=h, json={'customer_id': customer['id'], 'initial_service': {'plan_id': plan['id'], 'billing_type': 'prepaid', 'invoice_mode': 'manual'}}).json()
    assert client.put(f"/api/tickets/{ticket['id']}", headers=h, json={'status': 'ready'}).status_code == 200
    body = {'billing_start_date': start, 'notes': 'Link up'}
    if router_id:
        body.update(router_id=router_id, pppoe_username=username)
    with patch('app.main.local_today', return_value=date.fromisoformat(start)):
        activated = client.post(f"/api/tickets/{ticket['id']}/activate", headers=noc(client, h), json=body)
    assert activated.status_code == 200, activated.text
    return customer, ticket['subscription_id'], activated.json()


def test_length_encoding_boundaries():
    assert encode_length(0x7F) == b'\x7f'
    assert encode_length(0x80) == b'\x80\x80'
    assert encode_length(0x3FFF) == b'\xbf\xff'
    assert encode_length(0x4000) == b'\xc0\x40\x00'
    assert encode_length(0x200000) == b'\xe0\x20\x00\x00'
    assert encode_length(0x10000000) == b'\xf0\x10\x00\x00\x00'


def test_client_login_errors(fake):
    with pytest.raises(RouterOSError, match='invalid user name'):
        RouterOSClient('127.0.0.1', fake.port, 'api', 'wrong').connect()
    with pytest.raises(RouterOSError, match='Tidak dapat terhubung'):
        RouterOSClient('127.0.0.1', unused_port(), 'api', 'x', timeout=1).connect()


def test_router_crud_test_and_password_never_returned(fake):
    with TestClient(app) as client:
        h = admin(client)
        router = add_router(client, h, fake.port, 'BRAS-CRUD')
        assert 'password' not in router and 'encrypted_password' not in router
        tested = client.post(f"/api/routers/{router['id']}/test", headers=h).json()
        assert tested['ok'] and tested['identity'] == 'BRAS-TEST' and tested['version'].startswith('7.16')
        listed = next(r for r in client.get('/api/routers', headers=h).json() if r['id'] == router['id'])
        assert listed['identity'] == 'BRAS-TEST' and listed['last_error'] is None
        profiles = client.get(f"/api/routers/{router['id']}/profiles", headers=h).json()
        assert any(p['name'] == 'paket-30m' and p['rate_limit'] == '30M/30M' for p in profiles)
        # Password kosong saat update = tetap memakai password lama.
        upd = client.put(f"/api/routers/{router['id']}", headers=h, json={**{k: router[k] for k in ('name', 'host', 'port', 'username')}, 'password': ''})
        assert upd.status_code == 200 and client.post(f"/api/routers/{router['id']}/test", headers=h).json()['ok']
        bad = client.put(f"/api/routers/{router['id']}", headers=h, json={**{k: router[k] for k in ('name', 'host', 'port', 'username')}, 'password': 'wrong'})
        assert bad.status_code == 200
        failed = client.post(f"/api/routers/{router['id']}/test", headers=h).json()
        assert not failed['ok'] and 'invalid' in failed['error']
        assert client.put(f"/api/routers/{router['id']}", headers=h, json={**{k: router[k] for k in ('name', 'host', 'port', 'username')}, 'isolation_mode': 'profile'}).status_code == 422
        assert client.delete(f"/api/routers/{router['id']}", headers=h).status_code == 204


def test_activation_provisions_and_status_changes_isolate(fake):
    with TestClient(app) as client:
        h = admin(client)
        router = add_router(client, h, fake.port, 'BRAS-FLOW')
        customer, sid, activated = new_active_service(client, h, router['id'], 'budi.pppoe')
        assert activated['network_result']['ok'], activated
        secret = fake.secret('budi.pppoe')
        assert secret['profile'] == 'paket-30m' and secret['disabled'] == 'no' and secret['service'] == 'pppoe'
        assert len(secret['password']) == 12
        creds = client.get(f'/api/subscriptions/{sid}/network/credentials', headers=h).json()
        assert creds['pppoe_password'] == secret['password']

        fake.active.append({'.id': '*A1', 'name': 'budi.pppoe', 'address': '10.0.0.2'})
        sessions = client.get(f"/api/routers/{router['id']}/sessions", headers=h).json()
        assert sessions[0]['subscription_id'] == sid and sessions[0]['customer_name'] == 'Pelanggan PPPoE'

        suspended = client.patch(f'/api/subscriptions/{sid}/status', headers=h, json={'status': 'suspended'}).json()
        assert suspended['network_result']['ok'] and suspended['network_state'] == 'isolated'
        assert fake.secret('budi.pppoe')['disabled'] == 'yes' and fake.active == []

        restored = client.patch(f'/api/subscriptions/{sid}/status', headers=h, json={'status': 'active'}).json()
        assert restored['network_state'] == 'provisioned' and fake.secret('budi.pppoe')['disabled'] == 'no'

        # Duplikasi username di router yang sama ditolak; router yang dipakai tidak bisa dihapus.
        _, other_sid, _ = new_active_service(client, h)
        dup = client.put(f'/api/subscriptions/{other_sid}/network', headers=h, json={'router_id': router['id'], 'pppoe_username': 'budi.pppoe'})
        assert dup.status_code == 409
        assert client.delete(f"/api/routers/{router['id']}", headers=h).status_code == 409

        events = client.get('/api/network/events', headers=h).json()
        assert {'provision', 'isolate', 'restore', 'reveal'} <= {e['action'] for e in events if e['subscription_id'] == sid}


def test_profile_isolation_mode(fake):
    with TestClient(app) as client:
        h = admin(client)
        router = add_router(client, h, fake.port, 'BRAS-PROFILE', isolation_mode='profile', isolation_profile='isolir')
        _, sid, _ = new_active_service(client, h, router['id'], 'siti.pppoe')
        assert client.post(f'/api/subscriptions/{sid}/network/isolate', headers=h).json()['result']['ok']
        assert fake.secret('siti.pppoe')['profile'] == 'isolir' and fake.secret('siti.pppoe')['disabled'] == 'no'
        assert client.post(f'/api/subscriptions/{sid}/network/restore', headers=h).json()['result']['ok']
        assert fake.secret('siti.pppoe')['profile'] == 'paket-30m'


def test_router_down_does_not_block_activation():
    with TestClient(app) as client:
        h = admin(client)
        router = add_router(client, h, unused_port(), 'BRAS-DOWN')
        _, sid, activated = new_active_service(client, h, router['id'], 'down.pppoe')
        assert activated['status'] == 'closed'
        assert activated['network_result']['ok'] is False
        sub = next(s for s in client.get('/api/subscriptions', headers=h).json() if s['id'] == sid)
        assert sub['status'] == 'active' and sub['network_state'] == 'error' and sub['network_error']


def test_auto_isolation_and_restore_after_payment(fake):
    with TestClient(app) as client:
        h = admin(client)
        router = add_router(client, h, fake.port, 'BRAS-AUTO')
        customer, sid, _ = new_active_service(client, h, router['id'], 'tunggak.pppoe', start='2026-08-01')
        gen = client.post('/api/invoices/generate', headers=h, json={'period': '2026-08', 'due_date': '2026-08-20'})
        assert gen.status_code == 200, gen.text
        invoice = next(i for i in client.get('/api/invoices', headers=h).json() if i['customer_id'] == customer['id'])

        # Kebijakan nonaktif secara default: tidak ada yang diisolir.
        assert network.run_auto_isolation(date(2026, 9, 30))['isolated'] == 0
        assert client.put('/api/network/settings', headers=h, json={'auto_isolate': True, 'grace_days': 5, 'auto_restore': True, 'max_per_run': 50}).status_code == 200
        with patch('app.network_api.network.local_today', return_value=date(2026, 8, 24)):
            assert not any(r['subscription_id'] == sid for r in client.get('/api/network/auto-isolate/preview', headers=h).json()['isolate'])
        with patch('app.network_api.network.local_today', return_value=date(2026, 8, 25)):
            assert any(r['subscription_id'] == sid for r in client.get('/api/network/auto-isolate/preview', headers=h).json()['isolate'])

        network.run_auto_isolation(date(2026, 8, 25))
        sub = next(s for s in client.get('/api/subscriptions', headers=h).json() if s['id'] == sid)
        assert sub['status'] == 'active' and sub['network_state'] == 'isolated' and sub['isolation_reason'] == 'overdue'
        assert fake.secret('tunggak.pppoe')['disabled'] == 'yes'

        with patch('app.main.local_today', return_value=date(2026, 8, 25)):
            paid = client.post(f"/api/invoices/{invoice['id']}/payments", headers=h, json={'amount': invoice['remaining'], 'method': 'cash'})
        assert paid.json()['status'] == 'paid'
        sub = next(s for s in client.get('/api/subscriptions', headers=h).json() if s['id'] == sid)
        assert sub['network_state'] == 'provisioned' and sub['isolation_reason'] is None
        assert fake.secret('tunggak.pppoe')['disabled'] == 'no'
        client.put('/api/network/settings', headers=h, json={'auto_isolate': False, 'grace_days': 7, 'auto_restore': True, 'max_per_run': 50})


def test_manual_suspend_survives_payment(fake):
    """Pelunasan hanya membuka isolir karena tunggakan, bukan suspend manual oleh admin."""
    with TestClient(app) as client:
        h = admin(client)
        router = add_router(client, h, fake.port, 'BRAS-MANUAL')
        _, sid, _ = new_active_service(client, h, router['id'], 'manual.pppoe')
        client.patch(f'/api/subscriptions/{sid}/status', headers=h, json={'status': 'suspended'})
        from app.database import SessionLocal
        from app.models import Subscription
        with SessionLocal() as db:
            sub = db.get(Subscription, sid)
            network.isolate(db, sub, 'overdue', 'test')
            assert sub.isolation_reason == 'manual'
            db.commit()
        network.restore_paid_customer(sub.customer_id, date(2026, 12, 1))
        assert fake.secret('manual.pppoe')['disabled'] == 'yes'


def test_noc_cannot_change_policy_or_routers(fake):
    with TestClient(app) as client:
        h = admin(client)
        n = noc(client, h)
        assert client.get('/api/routers', headers=n).status_code == 200
        assert client.post('/api/routers', headers=n, json={'name': 'X', 'host': 'x', 'username': 'a', 'password': 'b'}).status_code == 403
        assert client.put('/api/network/settings', headers=n, json={'auto_isolate': True, 'grace_days': 0}).status_code == 403
        assert client.get('/api/network/events', headers=n).status_code == 403


def test_ppp_profile_management(fake):
    with TestClient(app) as client:
        h = admin(client)
        router = add_router(client, h, fake.port, 'BRAS-PROF')
        base = f"/api/routers/{router['id']}"
        pools = {p['name']: p for p in client.get(base + '/pools', headers=h).json()}
        # Tanpa interface di subnet pool: IP sebelum awal range. Dengan interface: IP interface router.
        assert (pools['pool-pppoe']['gateway'], pools['pool-pppoe']['gateway_source']) == ('10.20.0.1', 'before_range')
        assert (pools['pool-bisnis']['gateway'], pools['pool-bisnis']['gateway_source']) == ('172.16.5.1', 'interface')
        created = client.post(base + '/profiles', headers=h, json={'name': 'paket-50m', 'rate_limit': '50M/50M', 'remote_address': 'pool-pppoe', 'only_one': 'yes'})
        assert created.status_code == 201, created.text
        profiles = {p['name']: p for p in client.get(base + '/profiles', headers=h).json()}
        assert profiles['paket-50m']['rate_limit'] == '50M/50M' and profiles['default']['builtin']
        pid = profiles['paket-50m']['id']
        assert client.post(base + '/profiles', headers=h, json={'name': 'paket-50m'}).status_code == 422  # duplikat ditolak router
        assert client.post(base + '/profiles', headers=h, json={'name': 'x', 'rate_limit': '1M;/system reboot'}).status_code == 422
        # Mengosongkan field memakai unset.
        assert client.put(f'{base}/profiles/{pid}', headers=h, json={'name': 'paket-50m', 'rate_limit': '60M/60M'}).status_code == 200
        updated = next(p for p in fake.profiles if p['.id'] == pid)
        assert updated['rate-limit'] == '60M/60M' and 'remote-address' not in updated
        # Profile yang dipakai paket tidak bisa dihapus atau diganti nama.
        client.post('/api/plans', headers=h, json={'name': 'Paket 50', 'category': 'FTTH', 'monthly_fee': 300000, 'pppoe_profile': 'paket-50m'})
        assert client.delete(f'{base}/profiles/{pid}', headers=h).status_code == 409
        assert client.put(f'{base}/profiles/{pid}', headers=h, json={'name': 'ganti'}).status_code == 409
        assert client.delete(f'{base}/profiles/*0', headers=h).status_code == 409
        free = client.post(base + '/profiles', headers=h, json={'name': 'sementara'})
        fid = next(p['id'] for p in client.get(base + '/profiles', headers=h).json() if p['name'] == 'sementara')
        assert client.delete(f'{base}/profiles/{fid}', headers=h).status_code == 204
        assert not any(p['name'] == 'sementara' for p in fake.profiles)


def test_ppp_secret_management(fake):
    with TestClient(app) as client:
        h = admin(client)
        router = add_router(client, h, fake.port, 'BRAS-USER')
        base = f"/api/routers/{router['id']}"
        made = client.post(base + '/secrets', headers=h, json={'name': 'hotspot.kantor', 'profile': 'paket-30m', 'remote_address': '10.20.0.50'})
        assert made.status_code == 201, made.text
        assert len(made.json()['password']) == 12 and fake.secret('hotspot.kantor')['remote-address'] == '10.20.0.50'
        fake.active.append({'.id': '*S1', 'name': 'hotspot.kantor', 'address': '10.20.0.50', 'uptime': '1h'})
        rows = {r['name']: r for r in client.get(base + '/secrets', headers=h).json()}
        row = rows['hotspot.kantor']
        assert row['online'] and row['subscription_id'] is None and 'password' not in row
        assert client.put(f"{base}/secrets/{row['id']}", headers=h, json={'name': 'hotspot.kantor', 'profile': 'default', 'disabled': True}).status_code == 200
        assert fake.secret('hotspot.kantor')['disabled'] == 'yes' and 'remote-address' not in fake.secret('hotspot.kantor')
        assert client.post(f"{base}/secrets/{row['id']}/disconnect", headers=h).json()['disconnected'] == 1

        # User yang dibuat untuk layanan ikut terpetakan dan dikunci ke paket/status billing.
        _, sid, _ = new_active_service(client, h)
        linked = client.post(base + '/secrets', headers=h, json={'name': 'pelanggan.baru', 'subscription_id': sid, 'remote_address': '10.20.0.77'})
        assert linked.status_code == 201, linked.text
        secret = fake.secret('pelanggan.baru')
        assert secret['profile'] == 'paket-30m' and secret['remote-address'] == '10.20.0.77'
        sub = next(s for s in client.get('/api/subscriptions', headers=h).json() if s['id'] == sid)
        assert sub['router_id'] == router['id'] and sub['pppoe_username'] == 'pelanggan.baru' and sub['network_state'] == 'provisioned'
        lid = next(r['id'] for r in client.get(base + '/secrets', headers=h).json() if r['name'] == 'pelanggan.baru')
        assert client.put(f'{base}/secrets/{lid}', headers=h, json={'name': 'pelanggan.baru', 'profile': 'default'}).status_code == 409
        assert client.delete(f'{base}/secrets/{lid}', headers=h).status_code == 409
        renamed = client.put(f'{base}/secrets/{lid}', headers=h, json={'name': 'pelanggan.ganti', 'profile': 'paket-30m', 'password': 'BaruSekali1'})
        assert renamed.status_code == 200, renamed.text
        creds = client.get(f'/api/subscriptions/{sid}/network/credentials', headers=h).json()
        assert creds == {'pppoe_username': 'pelanggan.ganti', 'pppoe_password': 'BaruSekali1'}
        assert fake.secret('pelanggan.ganti')['password'] == 'BaruSekali1'

        assert client.delete(f"{base}/secrets/{row['id']}", headers=h).status_code == 204
        assert fake.secret('hotspot.kantor') is None
        assert client.post(base + '/secrets', headers=h, json={'name': 'bad name;'}).status_code == 422
        actions = {e['action'] for e in client.get('/api/network/events', headers=h).json() if e['router_id'] == router['id']}
        assert {'secret_create', 'secret_update', 'secret_delete', 'disconnect', 'provision'} <= actions
        n = noc(client, h)
        assert client.get(base + '/secrets', headers=n).status_code == 200
        assert client.post(base + '/secrets', headers=n, json={'name': 'x'}).status_code == 403


def test_gateway_suggestion_edge_cases():
    from app.ppp_api import suggest_gateway
    assert suggest_gateway('10.0.0.1-10.0.0.254', []) == (None, None)  # .0 bukan alamat host
    assert suggest_gateway('10.0.0.0/24', []) == (None, None)  # CIDR penuh tanpa interface: tidak menebak
    assert suggest_gateway('10.0.0.0/24', ['10.0.0.1/24']) == ('10.0.0.1', 'interface')
    assert suggest_gateway('10.9.0.10-10.9.0.99,10.9.1.10-10.9.1.99', ['192.168.88.1/24']) == ('10.9.0.9', 'before_range')
    assert suggest_gateway('bukan-ip', []) == (None, None)

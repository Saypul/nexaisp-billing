import asyncio
import logging
import os
import re
import secrets
import json
import urllib.request
from pathlib import Path
from contextlib import asynccontextmanager
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo
from fastapi import BackgroundTasks, FastAPI, Depends, HTTPException
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import func, select, inspect, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload, object_session
from . import network
from .database import Base, SessionLocal, engine, get_db
from .models import Customer, Invoice, InvoiceItem, Payment, Router, ServicePlan, Subscription, Ticket, TicketEvent, TelegramBotState, TelegramConfig, User
from .schemas import CustomerCreate, CustomerCreateWithService, CustomerOut, InvoiceGenerate, InvoiceUpdate, Login, PaymentCreate, PlanCreate, PlanOut, PlanUpdate, SubscriptionCreate, SubscriptionStatus, TicketCreate, TicketUpdate, TicketActivation, NocUserCreate, TelegramConfigUpdate
from .security import admin_only, admin_or_noc, hash_password, token_for, verify_password
from .network_api import api as network_api
from .ppp_api import api as ppp_api
from .telegram_config import cipher, get_bot_token, get_admin_chat_id, get_work_order_chat_id, get_category_teams, get_ticket_team, get_ticket_chat_id


@asynccontextmanager
async def lifespan(app: FastAPI):
    if len(os.getenv('JWT_SECRET', '')) < 32:
        raise RuntimeError('JWT_SECRET minimal 32 karakter harus tersedia')
    Base.metadata.create_all(bind=engine)  # Bootstrap MVP only; use Alembic migrations before schema upgrades.
    # Additive migration for installations created before per-service billing was available.
    with engine.begin() as conn:
        subscription_columns = {c['name'] for c in inspect(conn).get_columns('subscriptions')}
        for name, ddl in {
            'billing_type': "VARCHAR(20) NOT NULL DEFAULT 'prepaid'",
            'invoice_mode': "VARCHAR(20) NOT NULL DEFAULT 'manual'",
            'monthly_fee': 'INTEGER',
            'setup_fee': 'INTEGER',
            'router_id': 'INTEGER REFERENCES routers(id)',
            'pppoe_username': 'VARCHAR(100)',
            'encrypted_pppoe_password': 'TEXT',
            'network_state': "VARCHAR(20) NOT NULL DEFAULT 'unconfigured'",
            'isolation_reason': 'VARCHAR(20)',
            'network_error': 'TEXT',
            'network_synced_at': 'TIMESTAMP WITH TIME ZONE',
        }.items():
            if name not in subscription_columns:
                conn.execute(text(f'ALTER TABLE subscriptions ADD COLUMN {name} {ddl}'))
        plan_columns = {c['name'] for c in inspect(conn).get_columns('service_plans')}
        if 'pppoe_profile' not in plan_columns:
            conn.execute(text('ALTER TABLE service_plans ADD COLUMN pppoe_profile VARCHAR(80)'))
        # Jenis layanan disederhanakan: Metro-E, Dedicated Internet, FTTH, Tunnel.
        conn.execute(text("UPDATE service_plans SET category = 'TUNNEL' WHERE category = 'VPN'"))
        conn.execute(text("UPDATE service_plans SET category = 'DEDICATED' WHERE category = 'CDN'"))
        item_columns = {c['name'] for c in inspect(conn).get_columns('invoice_items')}
        if 'charge_type' not in item_columns:
            conn.execute(text("ALTER TABLE invoice_items ADD COLUMN charge_type VARCHAR(20) NOT NULL DEFAULT 'mrc'"))
        invoice_columns = {c['name'] for c in inspect(conn).get_columns('invoices')}
        if 'invoice_mode' not in invoice_columns:
            conn.execute(text("ALTER TABLE invoices ADD COLUMN invoice_mode VARCHAR(20) NOT NULL DEFAULT 'manual'"))
        if 'sequence' not in invoice_columns:
            conn.execute(text('ALTER TABLE invoices ADD COLUMN sequence INTEGER NOT NULL DEFAULT 1'))
        if conn.dialect.name == 'postgresql':
            constraints = {c['name'] for c in inspect(conn).get_unique_constraints('invoices')}
            if 'uq_invoice_customer_period' in constraints:
                conn.execute(text('ALTER TABLE invoices DROP CONSTRAINT uq_invoice_customer_period'))
            if 'uq_invoice_customer_period_mode' in constraints:
                conn.execute(text('ALTER TABLE invoices DROP CONSTRAINT uq_invoice_customer_period_mode'))
            if 'uq_invoice_customer_period_mode_sequence' not in constraints:
                conn.execute(text('ALTER TABLE invoices ADD CONSTRAINT uq_invoice_customer_period_mode_sequence UNIQUE (customer_id, period, invoice_mode, sequence)'))
        conn.execute(text('UPDATE subscriptions SET monthly_fee = (SELECT monthly_fee FROM service_plans WHERE id = plan_id) WHERE monthly_fee IS NULL'))
        conn.execute(text('UPDATE subscriptions SET setup_fee = 0 WHERE setup_fee IS NULL'))
        conn.execute(text("UPDATE tickets SET status = 'open' WHERE status = 'new'"))
        conn.execute(text("UPDATE tickets SET status = 'closed' WHERE status = 'active'"))
        ticket_columns = {c['name'] for c in inspect(conn).get_columns('tickets')}
        if 'technician_name' not in ticket_columns:
            conn.execute(text('ALTER TABLE tickets ADD COLUMN technician_name VARCHAR(120)'))
        if 'technician_telegram_id' not in ticket_columns:
            conn.execute(text('ALTER TABLE tickets ADD COLUMN technician_telegram_id BIGINT'))
        if 'rfs_target_date' not in ticket_columns:
            conn.execute(text('ALTER TABLE tickets ADD COLUMN rfs_target_date DATE'))
        if 'installed_at' not in ticket_columns:
            conn.execute(text('ALTER TABLE tickets ADD COLUMN installed_at TIMESTAMP WITH TIME ZONE'))
        event_columns = {c['name'] for c in inspect(conn).get_columns('ticket_events')}
        if 'photo_filename' not in event_columns:
            conn.execute(text('ALTER TABLE ticket_events ADD COLUMN photo_filename VARCHAR(80)'))
        telegram_columns = {c['name'] for c in inspect(conn).get_columns('telegram_config')}
        if 'work_order_chat_id' not in telegram_columns:
            conn.execute(text('ALTER TABLE telegram_config ADD COLUMN work_order_chat_id BIGINT'))
        if 'noc_chat_id' not in telegram_columns:
            conn.execute(text('ALTER TABLE telegram_config ADD COLUMN noc_chat_id BIGINT'))
        if 'category_teams' not in telegram_columns:
            conn.execute(text('ALTER TABLE telegram_config ADD COLUMN category_teams TEXT'))
        for config_id, raw_teams in conn.execute(text("SELECT id, category_teams FROM telegram_config WHERE category_teams LIKE '%VPN%' OR category_teams LIKE '%CDN%'")).all():
            teams = json.loads(raw_teams)
            if 'VPN' in teams:
                teams.setdefault('TUNNEL', teams['VPN'])
            teams = {k: v for k, v in teams.items() if k not in ('VPN', 'CDN')}
            conn.execute(text('UPDATE telegram_config SET category_teams = :t WHERE id = :i'), {'t': json.dumps(teams), 'i': config_id})
    with SessionLocal() as db:
        for customer in db.scalars(select(Customer).order_by(Customer.id)).all():
            if not re.fullmatch(r'[0-9]{10}', customer.code):
                customer.code = new_customer_code(db)
                db.flush()
        db.commit()
        for customer in db.scalars(select(Customer).order_by(Customer.id)).all():
            active_services = db.scalars(select(Subscription).where(Subscription.customer_id == customer.id, Subscription.status == 'active').order_by(Subscription.id)).all()
            for service in active_services:
                if not db.scalar(select(Ticket.id).where(Ticket.subscription_id == service.id).limit(1)):
                    db.add(Ticket(code=new_ticket_code(db), customer_id=customer.id, subscription_id=service.id,
                                  status='closed', activated_at=datetime.combine(service.start_date, datetime.min.time(), tzinfo=timezone.utc)))
                    db.flush()
            has_ticket = db.scalar(select(Ticket.id).where(Ticket.customer_id == customer.id).limit(1))
            if not has_ticket:
                pending = db.scalar(select(Subscription).where(Subscription.customer_id == customer.id, Subscription.status == 'pending').order_by(Subscription.id).limit(1))
                db.add(Ticket(code=new_ticket_code(db), customer_id=customer.id, subscription_id=pending.id if pending else None))
                db.flush()
        db.commit()
        email = os.getenv('ADMIN_EMAIL')
        password = os.getenv('ADMIN_PASSWORD')
        if not email or not password or len(password) < 12:
            raise RuntimeError('ADMIN_EMAIL dan ADMIN_PASSWORD minimal 12 karakter wajib diatur')
        admin = db.scalar(select(User).where(User.email == email))
        if admin is None:
            db.add(User(email=email, password_hash=hash_password(password), role='admin'))
            db.commit()
        elif not verify_password(password, admin.password_hash):
            # MVP: .env is the authoritative bootstrap/admin password.
            admin.password_hash = hash_password(password)
            db.commit()
    auto_task = asyncio.create_task(auto_invoice_loop())
    try:
        yield
    finally:
        auto_task.cancel()
        try:
            await auto_task
        except asyncio.CancelledError:
            pass


app = FastAPI(title='NexaISP Billing API', version='0.3.0', lifespan=lifespan, docs_url=None, redoc_url=None)
app.include_router(network_api)
app.include_router(ppp_api)


@app.get('/api/health')
def health():
    return {"status": "ok", "version": app.version}


@app.post('/api/auth/login')
def login(data: Login, db: Session = Depends(get_db)):
    user = db.scalar(select(User).where(User.email == data.email))
    if not user or not verify_password(data.password, user.password_hash):
        raise HTTPException(401, 'Email atau password tidak valid')
    return {"access_token": token_for(user), "token_type": "bearer", "email": user.email, "role": user.role}


@app.get('/api/auth/me')
def current_user(user: User = Depends(admin_or_noc)):
    return {"id": user.id, "email": user.email, "role": user.role}


@app.get('/api/users/noc')
def list_noc_users(db: Session = Depends(get_db), _: User = Depends(admin_only)):
    return [{'id': user.id, 'email': user.email} for user in db.scalars(select(User).where(User.role == 'noc').order_by(User.email)).all()]


@app.post('/api/users/noc', status_code=201)
def create_noc_user(data: NocUserCreate, db: Session = Depends(get_db), _: User = Depends(admin_only)):
    email = str(data.email).lower()
    if db.scalar(select(User.id).where(User.email == email)):
        raise HTTPException(409, 'Email sudah digunakan')
    user = User(email=email, password_hash=hash_password(data.password), role='noc')
    db.add(user)
    safe_commit(db)
    return {'id': user.id, 'email': user.email}


def telegram_config_view(db: Session):
    config = db.get(TelegramConfig, 1)
    token = get_bot_token(db)
    bot_id = config.bot_id if token and config and config.bot_id else (int(token.split(':', 1)[0]) if token.split(':', 1)[0].isdigit() else None)
    return {
        'configured': bool(token), 'bot_id': bot_id,
        'bot_username': config.bot_username if token and config else None,
        'admin_chat_id': get_admin_chat_id(db),
        'work_order_chat_id': get_work_order_chat_id(db),
        'noc_chat_id': config.noc_chat_id if config else None,
        'category_teams': get_category_teams(db),
        'notification_mode': 'n8n' if os.getenv('N8N_WO_WEBHOOK_URL', '').strip() else 'direct',
    }


@app.get('/api/telegram')
def read_telegram_config(db: Session = Depends(get_db), _: User = Depends(admin_only)):
    return telegram_config_view(db)


@app.put('/api/telegram')
def update_telegram_config(data: TelegramConfigUpdate, db: Session = Depends(get_db), _: User = Depends(admin_only)):
    if not data.model_fields_set:
        raise HTTPException(422, 'Isi token bot atau Telegram Chat ID.')
    bot_info = None
    if data.bot_token is not None:
        bot_token = data.bot_token.strip()
        if not re.fullmatch(r'\d{5,}:[A-Za-z0-9_-]{20,}', bot_token):
            raise HTTPException(422, 'Format token bot Telegram tidak valid.')
        request = urllib.request.Request(f'https://api.telegram.org/bot{bot_token}/getMe',
                                         data=b'{}', headers={'Content-Type': 'application/json'})
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                result = json.load(response)
            bot_info = result['result'] if result.get('ok') and result.get('result', {}).get('is_bot') else None
        except Exception:
            raise HTTPException(502, 'Bot tidak dapat diverifikasi melalui Telegram. Periksa token dan koneksi server.') from None
        if not bot_info:
            raise HTTPException(422, 'Token tidak terhubung ke bot Telegram yang valid.')
    config = db.get(TelegramConfig, 1)
    if config is None:
        config = TelegramConfig(id=1)
        db.add(config)
    if bot_info:
        config.encrypted_bot_token = cipher().encrypt(bot_token.encode('utf-8')).decode('utf-8')
        config.bot_id = bot_info['id']
        config.bot_username = bot_info.get('username')
        state = db.get(TelegramBotState, 'last_update_id')
        if state:
            db.delete(state)
    if 'admin_chat_id' in data.model_fields_set:
        if data.admin_chat_id is not None and data.admin_chat_id <= 0:
            raise HTTPException(422, 'Telegram Chat ID admin harus bilangan positif.')
        config.admin_chat_id = data.admin_chat_id
    active_tickets = db.scalars(select(Ticket).where(Ticket.status != 'closed').order_by(Ticket.id)).all()
    old_routes = {ticket.id: get_ticket_chat_id(db, ticket) for ticket in active_tickets}
    old_teams = {ticket.id: get_ticket_team(db, ticket) for ticket in active_tickets}
    if 'work_order_chat_id' in data.model_fields_set:
        chat_id = data.work_order_chat_id
        if chat_id is not None and chat_id >= 0:
            raise HTTPException(422, 'Chat ID grup teknisi harus bilangan negatif dari /chatid di grup.')
        config.work_order_chat_id = chat_id
    if 'noc_chat_id' in data.model_fields_set:
        if data.noc_chat_id is not None and data.noc_chat_id >= 0:
            raise HTTPException(422, 'Chat ID grup NOC harus bilangan negatif dari /chatid di grup.')
        config.noc_chat_id = data.noc_chat_id
    if config.noc_chat_id is not None and config.noc_chat_id == config.work_order_chat_id:
        raise HTTPException(422, 'Grup NOC dan Teknisi harus berbeda.')
    if 'category_teams' in data.model_fields_set:
        config.category_teams = json.dumps(data.category_teams or {})
    db.flush()
    for ticket in active_tickets:
        new_team = get_ticket_team(db, ticket)
        previous_status = ticket.status
        if new_team != old_teams.get(ticket.id) and ticket.status not in {'ready', 'scheduled'}:
            ticket.technician_name = None
            ticket.technician_telegram_id = None
            ticket.status = 'open'
        new_chat_id = get_ticket_chat_id(db, ticket)
        if new_chat_id and (new_chat_id != old_routes.get(ticket.id) or new_team != old_teams.get(ticket.id)):
            db.add(TicketEvent(ticket=ticket, actor_type='admin', actor_name='Sistem',
                               old_status=previous_status, new_status=ticket.status,
                               note=f'WO dialihkan ke tim {new_team.upper()}.', notify_telegram_id=new_chat_id))
    safe_commit(db)
    return telegram_config_view(db)


def safe_commit(db: Session):
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, 'Kode/entri duplikat atau referensi tidak valid') from None


def customer_view(obj: Customer):
    return CustomerOut.model_validate(obj)


def new_customer_code(db: Session):
    for _ in range(20):
        candidate = str(secrets.randbelow(9_000_000_000) + 1_000_000_000)
        if not db.scalar(select(Customer.id).where(Customer.code == candidate)):
            return candidate
    raise HTTPException(503, 'Gagal membuat ID pelanggan unik. Coba lagi.')


def new_service_code(db: Session, category: str = ''):
    prefix = 'ETH-' if category == 'METRO_E' else 'TUN-' if category == 'TUNNEL' else 'SRV-'
    for _ in range(20):
        candidate = prefix + str(secrets.randbelow(9_000_000_000) + 1_000_000_000)
        if not db.scalar(select(Subscription.id).where(Subscription.code == candidate)):
            return candidate
    raise HTTPException(503, 'Gagal membuat Service ID unik. Coba lagi.')


def default_invoice_mode(category: str):
    return 'auto' if category == 'FTTH' else 'manual'


def new_ticket_code(db: Session):
    for _ in range(20):
        candidate = 'TCK-' + str(secrets.randbelow(9_000_000_000) + 1_000_000_000)
        if not db.scalar(select(Ticket.id).where(Ticket.code == candidate)):
            return candidate
    raise HTTPException(503, 'Gagal membuat Ticket ID unik. Coba lagi.')


def add_pending_service(db: Session, customer_id: int, initial_service):
    plan = db.get(ServicePlan, initial_service.plan_id)
    if plan is None:
        raise HTTPException(404, 'Paket layanan tidak ditemukan')
    values = initial_service.model_dump(exclude={'plan_id', 'status', 'rfs_target_date'})
    values['invoice_mode'] = values['invoice_mode'] or default_invoice_mode(plan.category)
    values['monthly_fee'] = plan.monthly_fee if values['monthly_fee'] is None else values['monthly_fee']
    values['setup_fee'] = plan.setup_fee if values['setup_fee'] is None else values['setup_fee']
    service = Subscription(code=new_service_code(db, plan.category), customer_id=customer_id, plan=plan, status='pending', **values)
    db.add(service)
    db.flush()
    return service


def local_today():
    return datetime.now(ZoneInfo('Asia/Jakarta')).date()


def target_ticket_status(initial_service, plan: ServicePlan | None):
    target = initial_service.rfs_target_date if initial_service else None
    if target and plan and plan.category == 'METRO_E' and target > local_today() + timedelta(days=7):
        return 'scheduled'
    return 'open'


@app.get('/api/customers', response_model=list[CustomerOut])
def list_customers(db: Session = Depends(get_db), _: User = Depends(admin_only)):
    return db.scalars(select(Customer).order_by(Customer.id.desc())).all()


@app.post('/api/customers', response_model=CustomerOut, status_code=201)
def create_customer(data: CustomerCreateWithService, db: Session = Depends(get_db), _: User = Depends(admin_only)):
    if data.initial_service and db.get(ServicePlan, data.initial_service.plan_id) is None:
        raise HTTPException(404, 'Paket layanan tidak ditemukan')
    obj = Customer(code=new_customer_code(db), **data.model_dump(exclude={'initial_service'}))
    db.add(obj)
    try:
        db.flush()
        service = add_pending_service(db, obj.id, data.initial_service) if data.initial_service else None
        plan = service.plan if service else None
        ticket = Ticket(code=new_ticket_code(db), customer_id=obj.id, subscription=service,
                        status=target_ticket_status(data.initial_service, plan),
                        rfs_target_date=data.initial_service.rfs_target_date if data.initial_service else None)
        db.add(ticket)
        add_ticket_event(db, ticket, None, 'admin', 'Admin', 'Pelanggan baru terdaftar')
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, 'Kode pelanggan, layanan, atau tiket duplikat') from None
    safe_commit(db)
    db.refresh(obj)
    return obj


@app.put('/api/customers/{customer_id}', response_model=CustomerOut)
def update_customer(customer_id: int, data: CustomerCreate, db: Session = Depends(get_db), _: User = Depends(admin_only)):
    obj = db.get(Customer, customer_id)
    if obj is None:
        raise HTTPException(404, 'Pelanggan tidak ditemukan')
    for key, value in data.model_dump().items():
        setattr(obj, key, value)
    safe_commit(db)
    db.refresh(obj)
    return obj


@app.delete('/api/customers/{customer_id}', status_code=204)
def delete_customer(customer_id: int, db: Session = Depends(get_db), _: User = Depends(admin_only)):
    obj = db.get(Customer, customer_id)
    if obj is None:
        raise HTTPException(404, 'Pelanggan tidak ditemukan')
    if db.scalar(select(Subscription.id).where(Subscription.customer_id == customer_id).limit(1)) or db.scalar(select(Invoice.id).where(Invoice.customer_id == customer_id).limit(1)) or db.scalar(select(Ticket.id).where(Ticket.customer_id == customer_id).limit(1)):
        raise HTTPException(409, 'Pelanggan mempunyai layanan, tiket, atau invoice. Hapus data terkait terlebih dahulu.')
    db.delete(obj)
    safe_commit(db)


@app.get('/api/plans', response_model=list[PlanOut])
def list_plans(db: Session = Depends(get_db), _: User = Depends(admin_only)):
    return db.scalars(select(ServicePlan).order_by(ServicePlan.id.desc())).all()


@app.post('/api/plans', response_model=PlanOut, status_code=201)
def create_plan(data: PlanCreate, db: Session = Depends(get_db), _: User = Depends(admin_only)):
    obj = ServicePlan(**data.model_dump())
    db.add(obj)
    safe_commit(db)
    db.refresh(obj)
    return obj


@app.put('/api/plans/{plan_id}', response_model=PlanOut)
def update_plan(plan_id: int, data: PlanUpdate, db: Session = Depends(get_db), _: User = Depends(admin_only)):
    obj = db.get(ServicePlan, plan_id)
    if obj is None:
        raise HTTPException(404, 'Paket layanan tidak ditemukan')
    values = data.model_dump(exclude={'confirm_existing'})
    changed = any(getattr(obj, key) != value for key, value in values.items())
    if changed:
        subscribers = db.scalar(select(func.count(Subscription.id)).where(Subscription.plan_id == plan_id)) or 0
        if subscribers and not data.confirm_existing:
            raise HTTPException(409, f'Paket digunakan oleh {subscribers} layanan pelanggan. Konfirmasi perubahan harga awal untuk layanan baru.')
        for key, value in values.items():
            setattr(obj, key, value)
        safe_commit(db)
        db.refresh(obj)
    return obj


@app.delete('/api/plans/{plan_id}', status_code=204)
def delete_plan(plan_id: int, db: Session = Depends(get_db), _: User = Depends(admin_only)):
    obj = db.get(ServicePlan, plan_id)
    if obj is None:
        raise HTTPException(404, 'Paket layanan tidak ditemukan')
    subscribers = db.scalar(select(func.count(Subscription.id)).where(Subscription.plan_id == plan_id)) or 0
    if subscribers:
        raise HTTPException(409, 'Paket masih digunakan subscription pelanggan dan tidak dapat dihapus. Pertahankan paket atau buat paket pengganti.')
    db.delete(obj)
    safe_commit(db)
    return None


def subscription_view(obj: Subscription):
    return {
        'id': obj.id, 'code': obj.code, 'customer_id': obj.customer_id, 'customer_name': obj.customer.name,
        'plan_id': obj.plan_id, 'plan_name': obj.plan.name, 'category': obj.plan.category,
        'bandwidth_mbps': obj.plan.bandwidth_mbps, 'plan_description': obj.plan.description,
        'monthly_fee': obj.monthly_fee, 'setup_fee': obj.setup_fee, 'billing_type': obj.billing_type,
        'invoice_mode': obj.invoice_mode,
        'status': obj.status, 'circuit_id': obj.circuit_id,
        'service_address': obj.service_address, 'start_date': obj.start_date,
        'router_id': obj.router_id, 'router_name': obj.router.name if obj.router else None,
        'pppoe_username': obj.pppoe_username, 'network_state': obj.network_state or 'unconfigured',
        'isolation_reason': obj.isolation_reason, 'network_error': obj.network_error,
        'network_synced_at': obj.network_synced_at,
    }


@app.get('/api/subscriptions')
def list_subscriptions(db: Session = Depends(get_db), _: User = Depends(admin_only)):
    rows = db.scalars(select(Subscription).options(selectinload(Subscription.customer), selectinload(Subscription.plan), selectinload(Subscription.router)).order_by(Subscription.id.desc())).all()
    return [subscription_view(s) for s in rows]


@app.post('/api/subscriptions', status_code=201)
def create_subscription(data: SubscriptionCreate, db: Session = Depends(get_db), _: User = Depends(admin_only)):
    if data.status != 'pending':
        raise HTTPException(409, 'Layanan baru harus melalui ticket dan diaktifkan dari menu Ticketing.')
    customer, plan = db.get(Customer, data.customer_id), db.get(ServicePlan, data.plan_id)
    if not customer or not plan:
        raise HTTPException(404, 'Pelanggan atau paket tidak ditemukan')
    values = data.model_dump()
    values['invoice_mode'] = values['invoice_mode'] or default_invoice_mode(plan.category)
    values['monthly_fee'] = plan.monthly_fee if values['monthly_fee'] is None else values['monthly_fee']
    values['setup_fee'] = plan.setup_fee if values['setup_fee'] is None else values['setup_fee']
    obj = Subscription(**values)
    db.add(obj)
    try:
        db.flush()
        ticket = db.scalar(select(Ticket).where(Ticket.customer_id == data.customer_id, Ticket.subscription_id.is_(None), Ticket.status != 'closed').order_by(Ticket.id).limit(1))
        if ticket:
            ticket.subscription_id = obj.id
        else:
            db.add(Ticket(code=new_ticket_code(db), customer_id=data.customer_id, subscription_id=obj.id))
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, 'Kode layanan atau tiket duplikat') from None
    safe_commit(db)
    db.refresh(obj)
    return subscription_view(obj)


@app.put('/api/subscriptions/{subscription_id}')
def update_subscription(subscription_id: int, data: SubscriptionCreate, db: Session = Depends(get_db), user: User = Depends(admin_only)):
    obj = db.get(Subscription, subscription_id)
    if obj is None:
        raise HTTPException(404, 'Layanan tidak ditemukan')
    if not db.get(Customer, data.customer_id) or not db.get(ServicePlan, data.plan_id):
        raise HTTPException(404, 'Pelanggan atau paket tidak ditemukan')
    ticket = db.scalar(select(Ticket).where(Ticket.subscription_id == subscription_id).limit(1))
    if ticket and (data.customer_id != ticket.customer_id or (ticket.status != 'closed' and data.status != 'pending')):
        raise HTTPException(409, 'Layanan yang masih dalam ticket hanya dapat diaktifkan dari Ticketing dan pelanggan tidak dapat diubah.')
    has_invoice = db.scalar(select(InvoiceItem.id).where(InvoiceItem.subscription_id == subscription_id).limit(1))
    if has_invoice and (data.customer_id != obj.customer_id or data.billing_type != obj.billing_type or data.start_date != obj.start_date or (data.invoice_mode is not None and data.invoice_mode != obj.invoice_mode)):
        raise HTTPException(409, 'Pelanggan, mode billing, cara invoice, dan tanggal aktivasi tidak dapat diubah setelah layanan masuk invoice.')
    values = data.model_dump()
    values['invoice_mode'] = values['invoice_mode'] or obj.invoice_mode
    plan = db.get(ServicePlan, data.plan_id)
    values['monthly_fee'] = plan.monthly_fee if values['monthly_fee'] is None else values['monthly_fee']
    values['setup_fee'] = plan.setup_fee if values['setup_fee'] is None else values['setup_fee']
    previous_status = obj.status
    for key, value in values.items():
        setattr(obj, key, value)
    safe_commit(db)
    db.refresh(obj)
    return with_network_sync(db, obj, previous_status, user)


@app.delete('/api/subscriptions/{subscription_id}', status_code=204)
def delete_subscription(subscription_id: int, db: Session = Depends(get_db), _: User = Depends(admin_only)):
    obj = db.get(Subscription, subscription_id)
    if obj is None:
        raise HTTPException(404, 'Layanan tidak ditemukan')
    if db.scalar(select(InvoiceItem.id).where(InvoiceItem.subscription_id == subscription_id).limit(1)):
        raise HTTPException(409, 'Layanan sudah tercatat pada invoice dan tidak dapat dihapus.')
    if db.scalar(select(Ticket.id).where(Ticket.subscription_id == subscription_id).limit(1)):
        raise HTTPException(409, 'Layanan masih terhubung ke ticket. Hapus ticket terlebih dahulu.')
    db.delete(obj)
    safe_commit(db)


@app.patch('/api/subscriptions/{subscription_id}/status')
def change_subscription_status(subscription_id: int, data: SubscriptionStatus, db: Session = Depends(get_db), user: User = Depends(admin_only)):
    obj = db.get(Subscription, subscription_id)
    if not obj:
        raise HTTPException(404, 'Layanan tidak ditemukan')
    ticket = db.scalar(select(Ticket).where(Ticket.subscription_id == subscription_id).limit(1))
    if ticket and ticket.status != 'closed' and data.status != 'pending':
        raise HTTPException(409, 'Aktifkan layanan melalui ticket di menu Ticketing.')
    previous_status = obj.status
    obj.status = data.status
    safe_commit(db)
    return with_network_sync(db, obj, previous_status, user)


def with_network_sync(db: Session, obj: Subscription, previous_status: str, user: User):
    """Status billing sudah tersimpan; selaraskan router bila status berubah. Kegagalan router tidak membatalkan perubahan."""
    result = None
    if obj.status != previous_status:
        result = network.sync_billing_status(db, obj, user.email)
        if result is not None:
            db.commit()
    return {**subscription_view(obj), 'network_result': result}


def ticket_view(ticket: Ticket):
    service = ticket.subscription
    return {
        'id': ticket.id, 'code': ticket.code, 'customer_id': ticket.customer_id,
        'customer_name': ticket.customer.name, 'customer_code': ticket.customer.code,
        'customer_kind': ticket.customer.kind, 'subscription_id': ticket.subscription_id,
        'service_code': service.code if service else None,
        'category': service.plan.category if service else None,
        'work_order_team': get_ticket_team(object_session(ticket), ticket),
        'plan_id': service.plan_id if service else None,
        'plan_name': service.plan.name if service else None,
        'bandwidth_mbps': service.plan.bandwidth_mbps if service else None,
        'billing_type': service.billing_type if service else None,
        'invoice_mode': service.invoice_mode if service else None,
        'monthly_fee': service.monthly_fee if service else None,
        'setup_fee': service.setup_fee if service else None,
        'start_date': service.start_date if service else None,
        'rfs_target_date': ticket.rfs_target_date,
        'installed_at': ticket.installed_at,
        'circuit_id': service.circuit_id if service else None,
        'service_address': service.service_address if service else None,
        'status': ticket.status, 'notes': ticket.notes,
        'work_order_code': f'WO-{ticket.id:06d}',
        'technician_name': ticket.technician_name,
        'technician_telegram_id': ticket.technician_telegram_id,
        'events': [{'id': event.id, 'actor_type': event.actor_type, 'actor_name': event.actor_name,
                    'old_status': event.old_status, 'new_status': event.new_status,
                    'note': event.note, 'photo_url': f'/api/ticket-events/{event.id}/photo' if event.photo_filename else None,
                    'created_at': event.created_at} for event in ticket.events],
        'created_at': ticket.created_at, 'updated_at': ticket.updated_at,
        'activated_at': ticket.activated_at,
    }


@app.get('/api/tickets')
def list_tickets(db: Session = Depends(get_db), _: User = Depends(admin_or_noc)):
    rows = db.scalars(select(Ticket).options(selectinload(Ticket.customer), selectinload(Ticket.subscription).selectinload(Subscription.plan), selectinload(Ticket.events)).order_by(Ticket.id.desc())).all()
    return [ticket_view(ticket) for ticket in rows]


def add_ticket_event(db: Session, ticket: Ticket, old_status: str | None, actor_type: str, actor_name: str,
                     note: str | None = None, photo_filename: str | None = None):
    group_id = get_ticket_chat_id(db, ticket)
    recipient = group_id or (get_admin_chat_id(db) if actor_type != 'admin' else None)
    db.add(TicketEvent(ticket=ticket, actor_type=actor_type, actor_name=actor_name,
                       old_status=old_status, new_status=ticket.status or 'open', note=note,
                       photo_filename=photo_filename, notify_telegram_id=recipient))


@app.get('/api/ticket-events/{event_id}/photo')
def read_ticket_event_photo(event_id: int, db: Session = Depends(get_db), _: User = Depends(admin_or_noc)):
    event = db.get(TicketEvent, event_id)
    filename = event.photo_filename if event else None
    if not filename or not re.fullmatch(r'[0-9a-f]{32}\.(jpg|png|webp)', filename):
        raise HTTPException(404, 'Foto dokumentasi tidak ditemukan')
    path = Path(os.getenv('WO_PHOTO_DIR', '/app/uploads')) / filename
    if not path.is_file():
        raise HTTPException(404, 'File foto dokumentasi tidak ditemukan')
    media_type = {'jpg': 'image/jpeg', 'png': 'image/png', 'webp': 'image/webp'}[filename.rsplit('.', 1)[1]]
    return FileResponse(path, media_type=media_type, headers={
        'Cache-Control': 'private, max-age=300', 'X-Content-Type-Options': 'nosniff',
    })


@app.post('/api/tickets', status_code=201)
def create_ticket(data: TicketCreate, db: Session = Depends(get_db), _: User = Depends(admin_only)):
    if db.get(Customer, data.customer_id) is None:
        raise HTTPException(404, 'Pelanggan tidak ditemukan')
    if data.initial_service and db.get(ServicePlan, data.initial_service.plan_id) is None:
        raise HTTPException(404, 'Paket layanan tidak ditemukan')
    if data.initial_service is None and db.scalar(select(Ticket.id).where(Ticket.customer_id == data.customer_id, Ticket.subscription_id.is_(None), Ticket.status != 'closed').limit(1)):
        raise HTTPException(409, 'Pelanggan sudah mempunyai tiket tanpa layanan yang masih berjalan.')
    try:
        service = add_pending_service(db, data.customer_id, data.initial_service) if data.initial_service else None
        ticket = Ticket(code=new_ticket_code(db), customer_id=data.customer_id, subscription=service,
                        notes=data.notes, technician_name=data.technician_name,
                        technician_telegram_id=data.technician_telegram_id,
                        status=target_ticket_status(data.initial_service, service.plan if service else None),
                        rfs_target_date=data.initial_service.rfs_target_date if data.initial_service else None)
        db.add(ticket)
        add_ticket_event(db, ticket, None, 'admin', 'Admin', data.notes or 'Ticket dibuat')
        safe_commit(db)
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, 'Kode layanan atau tiket duplikat') from None
    db.refresh(ticket)
    return ticket_view(ticket)


@app.put('/api/tickets/{ticket_id}')
def update_ticket(ticket_id: int, data: TicketUpdate, db: Session = Depends(get_db), _: User = Depends(admin_only)):
    return apply_ticket_update(ticket_id, data, db, 'admin', 'Admin')


def apply_ticket_update(ticket_id: int, data: TicketUpdate, db: Session, actor_type: str, actor_name: str,
                        actor_telegram_id: int | None = None, photo_filename: str | None = None):
    ticket = db.get(Ticket, ticket_id)
    if ticket is None:
        raise HTTPException(404, 'Tiket tidak ditemukan')
    old_route = get_ticket_chat_id(db, ticket)
    old_category = ticket.subscription.plan.category if ticket.subscription else None
    old_team = get_ticket_team(db, ticket)
    if data.status == 'closed' and ticket.status != 'closed':
        raise HTTPException(409, 'Aktivasi Closed hanya dapat dilakukan NOC melalui aksi Aktivasi.')
    if actor_type in {'technician', 'noc_telegram'}:
        if actor_telegram_id is None or ticket.technician_telegram_id != actor_telegram_id:
            raise HTTPException(403, 'Work Order tidak ditugaskan kepada teknisi ini.')
        if data.technician_name is not None or data.technician_telegram_id is not None:
            raise HTTPException(403, 'Penugasan teknisi hanya dapat diubah admin.')
        steps = ['open', 'ready'] if get_ticket_team(db, ticket) == 'noc' else ['open', 'survey', 'installation', 'ready']
        if ticket.status == 'scheduled':
            raise HTTPException(409, 'WO masih terjadwal dan belum dibuka untuk teknisi.')
        if data.status != ticket.status and (data.status not in steps or steps.index(data.status) != steps.index(ticket.status) + 1):
            raise HTTPException(409, 'Teknisi hanya dapat melanjutkan ke tahap progres berikutnya.')
    old_status, old_notes, old_technician_id, old_technician_name = ticket.status, ticket.notes, ticket.technician_telegram_id, ticket.technician_name
    if ticket.status == 'closed' and ({'technician_name', 'technician_telegram_id'} & data.model_fields_set):
        raise HTTPException(409, 'Penugasan WO yang sudah Closed tidak dapat diubah.')
    if actor_type == 'admin':
        if 'technician_name' in data.model_fields_set:
            ticket.technician_name = data.technician_name or None
        if 'technician_telegram_id' in data.model_fields_set:
            if data.technician_telegram_id is not None and data.technician_telegram_id <= 0:
                raise HTTPException(422, 'Telegram User ID teknisi harus bilangan positif.')
            ticket.technician_telegram_id = data.technician_telegram_id
    if ticket.status == 'closed':
        if data.status != 'closed':
            raise HTTPException(409, 'Tiket yang sudah aktif tidak dapat dibuka ulang.')
        if 'notes' in data.model_fields_set:
            ticket.notes = data.notes
        if ticket.notes != old_notes:
            add_ticket_event(db, ticket, old_status, actor_type, actor_name, data.notes)
        safe_commit(db)
        db.refresh(ticket)
        return ticket_view(ticket)
    service = ticket.subscription
    plan_id = data.plan_id or (service.plan_id if service else None)
    plan = db.get(ServicePlan, plan_id) if plan_id else None
    if plan_id and plan is None:
        raise HTTPException(404, 'Paket layanan tidak ditemukan')
    if service is None and plan:
        service = Subscription(
            code=new_service_code(db, plan.category), customer_id=ticket.customer_id, plan=plan,
            status='pending', billing_type=data.billing_type or 'postpaid',
            invoice_mode=data.invoice_mode or default_invoice_mode(plan.category),
            monthly_fee=plan.monthly_fee if data.monthly_fee is None else data.monthly_fee,
            setup_fee=plan.setup_fee if data.setup_fee is None else data.setup_fee,
            start_date=date.today(), circuit_id=data.circuit_id,
            service_address=data.service_address,
        )
        db.add(service)
        db.flush()
        ticket.subscription = service
    elif service:
        if plan and plan.id != service.plan_id:
            service.plan_id = plan.id
            service.plan = plan
            if data.monthly_fee is None:
                service.monthly_fee = plan.monthly_fee
            if data.setup_fee is None:
                service.setup_fee = plan.setup_fee
        if data.monthly_fee is not None:
            service.monthly_fee = data.monthly_fee
        if data.setup_fee is not None:
            service.setup_fee = data.setup_fee
        if data.billing_type is not None:
            service.billing_type = data.billing_type
        if data.invoice_mode is not None:
            service.invoice_mode = data.invoice_mode
        for field in ('circuit_id', 'service_address'):
            if field in data.model_fields_set:
                setattr(service, field, getattr(data, field))
    if service:
        service.status = 'pending'
    if actor_type == 'admin' and service and (service.plan.category != old_category or get_ticket_team(db, ticket) != old_team):
        ticket.technician_name = None
        ticket.technician_telegram_id = None
    if service and get_ticket_team(db, ticket) == 'noc' and data.status in {'survey', 'installation'}:
        raise HTTPException(422, 'Progres layanan NOC dari Open langsung ke Siap Aktivasi.')
    if actor_type == 'admin' and 'rfs_target_date' in data.model_fields_set:
        ticket.rfs_target_date = data.rfs_target_date
    if data.status == 'scheduled' and (not service or service.plan.category != 'METRO_E' or not ticket.rfs_target_date):
        raise HTTPException(422, 'Status Terjadwal memerlukan layanan Metro dan tanggal RFS.')
    ticket.status = data.status
    if 'notes' in data.model_fields_set:
        ticket.notes = data.notes
    if data.status == 'ready' and old_status != 'ready':
        ticket.installed_at = datetime.now(timezone.utc)
    route_changed = get_ticket_chat_id(db, ticket) != old_route or get_ticket_team(db, ticket) != old_team
    if ticket.status != old_status or ticket.notes != old_notes or ticket.technician_telegram_id != old_technician_id or ticket.technician_name != old_technician_name or photo_filename or 'rfs_target_date' in data.model_fields_set or route_changed:
        event_note = data.notes if 'notes' in data.model_fields_set else ('Dokumentasi foto' if photo_filename else None)
        if ticket.technician_telegram_id != old_technician_id and actor_type == 'admin':
            event_note = f'Ditugaskan kepada {ticket.technician_name or ticket.technician_telegram_id}' if ticket.technician_telegram_id else 'Penugasan teknisi dilepas'
        if 'rfs_target_date' in data.model_fields_set and actor_type == 'admin':
            event_note = f'RFS target diubah menjadi {ticket.rfs_target_date or "belum ditentukan"}. {data.notes or ""}'.strip()
        if route_changed and not event_note:
            event_note = f'WO dialihkan ke grup kategori {service.plan.category}.'
        add_ticket_event(db, ticket, old_status, actor_type, actor_name, event_note, photo_filename)
    safe_commit(db)
    db.refresh(ticket)
    return ticket_view(ticket)


@app.post('/api/tickets/{ticket_id}/activate')
def activate_ticket(ticket_id: int, data: TicketActivation, db: Session = Depends(get_db), user: User = Depends(admin_or_noc)):
    if user.role != 'noc':
        raise HTTPException(403, 'Aktivasi layanan hanya dapat dilakukan akun NOC.')
    ticket = db.scalar(select(Ticket).where(Ticket.id == ticket_id).with_for_update())
    if ticket is None:
        raise HTTPException(404, 'Tiket tidak ditemukan')
    if ticket.status != 'ready':
        raise HTTPException(409, 'WO harus Siap Aktivasi sebelum NOC mengaktifkan layanan.')
    service = ticket.subscription
    if service is None:
        raise HTTPException(422, 'Pilih paket layanan sebelum aktivasi.')
    today = local_today()
    if ticket.rfs_target_date and today < ticket.rfs_target_date:
        raise HTTPException(409, f'RFS target {ticket.rfs_target_date} belum tiba. Admin dapat mengubah target jika jadwal disepakati ulang.')
    if data.billing_start_date < today:
        raise HTTPException(422, 'Tanggal mulai billing tidak boleh sebelum tanggal aktivasi.')
    if data.router_id is not None:
        if db.get(Router, data.router_id) is None:
            raise HTTPException(404, 'Router tidak ditemukan')
        username = (data.pppoe_username or '').strip() or service.code.lower()
        duplicate = db.scalar(select(Subscription.code).where(Subscription.router_id == data.router_id, Subscription.pppoe_username == username, Subscription.id != service.id))
        if duplicate:
            raise HTTPException(409, f'Username PPPoE {username} sudah dipakai layanan {duplicate} di router ini.')
        service.router_id = data.router_id
        service.pppoe_username = username
        if not service.encrypted_pppoe_password:
            service.encrypted_pppoe_password = network.encrypt(network.generate_password())
    ticket.status = 'closed'
    ticket.activated_at = datetime.now(timezone.utc)
    service.status = 'active'
    service.start_date = data.billing_start_date
    add_ticket_event(db, ticket, 'ready', 'noc', user.email,
                     f'Aktivasi NOC. Mulai billing {data.billing_start_date}. {data.notes}')
    safe_commit(db)
    db.refresh(ticket)
    # Provisioning PPPoE berjalan setelah aktivasi tersimpan; router yang gagal tidak membatalkan aktivasi.
    network_result = None
    if network.is_mapped(service):
        network_result = network.apply(db, service, user.email, 'provision')
        db.commit()
    return {**ticket_view(ticket), 'network_result': network_result}


@app.delete('/api/tickets/{ticket_id}', status_code=204)
def delete_ticket(ticket_id: int, db: Session = Depends(get_db), _: User = Depends(admin_only)):
    ticket = db.get(Ticket, ticket_id)
    if ticket is None:
        raise HTTPException(404, 'Tiket tidak ditemukan')
    service = ticket.subscription
    if service and ticket.status != 'closed' and db.scalar(select(InvoiceItem.id).where(InvoiceItem.subscription_id == service.id).limit(1)):
        raise HTTPException(409, 'Layanan pada tiket sudah tercatat dalam invoice.')
    db.delete(ticket)
    if service and ticket.status != 'closed' and not db.scalar(select(Ticket.id).where(Ticket.subscription_id == service.id, Ticket.id != ticket_id).limit(1)):
        db.delete(service)
    safe_commit(db)


def invoice_view(invoice: Invoice):
    paid = sum(p.amount for p in invoice.payments)
    return {
        'id': invoice.id, 'number': invoice.number, 'customer_id': invoice.customer_id,
        'customer_name': invoice.customer.name, 'period': invoice.period, 'invoice_mode': invoice.invoice_mode,
        'due_date': invoice.due_date, 'status': invoice.status, 'total': invoice.total,
        'paid': paid, 'remaining': invoice.total - paid,
        'items': [{'subscription_id': i.subscription_id, 'description': i.description, 'amount': i.amount, 'charge_type': i.charge_type} for i in invoice.items],
        'payments': [{'id': p.id, 'amount': p.amount, 'method': p.method, 'reference': p.reference, 'paid_at': p.paid_at} for p in invoice.payments],
    }


@app.get('/api/invoices')
def list_invoices(db: Session = Depends(get_db), _: User = Depends(admin_only)):
    rows = db.scalars(select(Invoice).options(selectinload(Invoice.customer), selectinload(Invoice.items), selectinload(Invoice.payments)).order_by(Invoice.id.desc())).all()
    return [invoice_view(x) for x in rows]


@app.post('/api/invoices/generate')
def generate_invoices(data: InvoiceGenerate, db: Session = Depends(get_db), _: User = Depends(admin_only)):
    return generate_invoices_for_mode(data, db, 'manual')


def generate_invoices_for_mode(data: InvoiceGenerate, db: Session, invoice_mode: str):
    # Invoice period is the issue month: prepaid bills this month, postpaid bills last month.
    subscriptions = db.scalars(select(Subscription).options(selectinload(Subscription.plan), selectinload(Subscription.customer)).where(Subscription.status == 'active', Subscription.invoice_mode == invoice_mode)).all()
    grouped = defaultdict(list)
    year, month = map(int, data.period.split('-'))
    previous_period = f'{year - 1}-12' if month == 1 else f'{year}-{month - 1:02d}'
    for sub in subscriptions:
        service_period = data.period if sub.billing_type == 'prepaid' else previous_period
        if sub.start_date.strftime('%Y-%m') <= service_period:
            grouped[sub.customer_id].append((sub, service_period))
    created, updated, skipped = [], [], []
    for customer_id, entries in grouped.items():
        existing = db.scalars(select(Invoice).options(selectinload(Invoice.items), selectinload(Invoice.payments)).where(
            Invoice.customer_id == customer_id, Invoice.period == data.period, Invoice.invoice_mode == invoice_mode
        ).order_by(Invoice.sequence).with_for_update()).all()
        billed_services = {item.subscription_id for inv in existing for item in inv.items if item.charge_type == 'mrc'}
        fresh_entries = [(sub, service_period) for sub, service_period in entries if sub.id not in billed_services]
        if not fresh_entries:
            skipped.append(customer_id)
            continue
        items = []
        for sub, service_period in fresh_entries:
            items.append(InvoiceItem(subscription_id=sub.id, charge_type='mrc', description=f'MRC {service_period} · {sub.plan.name} ({sub.code})', amount=sub.monthly_fee))
            otc_billed = db.scalar(select(InvoiceItem.id).where(InvoiceItem.subscription_id == sub.id, InvoiceItem.charge_type == 'otc').limit(1))
            if sub.setup_fee and not otc_billed:
                items.append(InvoiceItem(subscription_id=sub.id, charge_type='otc', description=f'OTC registrasi/instalasi · {sub.plan.name} ({sub.code})', amount=sub.setup_fee))
        total = sum(item.amount for item in items)
        open_invoice = next((inv for inv in existing if inv.status == 'unpaid' and not inv.payments), None)
        if open_invoice:
            open_invoice.items.extend(items)
            open_invoice.total += total
            updated.append(open_invoice.number)
        else:
            sequence = max((inv.sequence for inv in existing), default=0) + 1
            number = f"INV-{data.period.replace('-', '')}-{customer_id:06d}-{'A' if invoice_mode == 'auto' else 'M'}"
            if sequence > 1:
                number += f'-{sequence}'
            inv = Invoice(number=number, customer_id=customer_id, period=data.period, invoice_mode=invoice_mode,
                          sequence=sequence, due_date=data.due_date, status='paid' if total == 0 else 'unpaid', total=total)
            inv.items = items
            db.add(inv)
            created.append(number)
    safe_commit(db)
    return {'created': len(created), 'updated': len(updated), 'skipped': len(skipped), 'numbers': created + updated}


def run_auto_invoices():
    today = local_today()
    due_date = max(today + timedelta(days=7), date(today.year, today.month, 20))
    with SessionLocal() as db:
        return generate_invoices_for_mode(InvoiceGenerate(period=today.strftime('%Y-%m'), due_date=due_date), db, 'auto')


def release_scheduled_tickets(today: date | None = None):
    today = today or local_today()
    with SessionLocal() as db:
        tickets = db.scalars(select(Ticket).where(Ticket.status == 'scheduled', Ticket.rfs_target_date <= today + timedelta(days=7))).all()
        for ticket in tickets:
            ticket.status = 'open'
            add_ticket_event(db, ticket, 'scheduled', 'system', 'Sistem', f'WO dibuka 7 hari sebelum RFS target {ticket.rfs_target_date}.')
        if tickets:
            safe_commit(db)
        return len(tickets)


async def auto_invoice_loop():
    while True:
        try:
            await asyncio.to_thread(release_scheduled_tickets)
            await asyncio.to_thread(run_auto_invoices)
        except Exception:
            logging.exception('Gagal membuat invoice otomatis; akan dicoba lagi dalam satu jam')
        try:
            result = await asyncio.to_thread(network.run_auto_isolation, local_today())
            if any(result.values()):
                logging.info('Isolir otomatis: %s', result)
        except Exception:
            logging.exception('Gagal menjalankan kebijakan isolir otomatis; akan dicoba lagi dalam satu jam')
        await asyncio.sleep(3600)


@app.put('/api/invoices/{invoice_id}')
def update_invoice(invoice_id: int, data: InvoiceUpdate, db: Session = Depends(get_db), _: User = Depends(admin_only)):
    obj = db.get(Invoice, invoice_id)
    if obj is None:
        raise HTTPException(404, 'Invoice tidak ditemukan')
    if obj.status == 'paid':
        raise HTTPException(409, 'Invoice lunas tidak dapat diubah.')
    obj.due_date = data.due_date
    safe_commit(db)
    return invoice_view(obj)


@app.delete('/api/invoices/{invoice_id}', status_code=204)
def delete_invoice(invoice_id: int, db: Session = Depends(get_db), _: User = Depends(admin_only)):
    obj = db.get(Invoice, invoice_id)
    if obj is None:
        raise HTTPException(404, 'Invoice tidak ditemukan')
    if obj.status == 'paid' or db.scalar(select(Payment.id).where(Payment.invoice_id == invoice_id).limit(1)):
        raise HTTPException(409, 'Invoice lunas atau dengan pembayaran tidak dapat dihapus.')
    db.delete(obj)
    safe_commit(db)


@app.post('/api/invoices/{invoice_id}/payments', status_code=201)
def add_payment(invoice_id: int, data: PaymentCreate, background: BackgroundTasks, db: Session = Depends(get_db), _: User = Depends(admin_only)):
    invoice = db.scalar(select(Invoice).where(Invoice.id == invoice_id).with_for_update())
    if not invoice:
        raise HTTPException(404, 'Invoice tidak ditemukan')
    paid = db.scalar(select(func.coalesce(func.sum(Payment.amount), 0)).where(Payment.invoice_id == invoice_id)) or 0
    if data.amount > invoice.total - paid:
        raise HTTPException(422, 'Pembayaran melebihi sisa tagihan')
    if data.reference and db.scalar(select(Payment.id).where(Payment.invoice_id == invoice_id, Payment.reference == data.reference)):
        raise HTTPException(409, 'Referensi pembayaran sudah digunakan untuk invoice ini')
    obj = Payment(invoice_id=invoice_id, **data.model_dump())
    db.add(obj)
    if paid + data.amount == invoice.total:
        invoice.status = 'paid'
    safe_commit(db)
    if invoice.status == 'paid':
        # Buka isolir tunggakan segera setelah lunas, tanpa menunggu putaran per jam.
        background.add_task(network.restore_paid_customer, invoice.customer_id, local_today())
    return {'id': obj.id, 'status': invoice.status, 'remaining': invoice.total - paid - data.amount}


@app.get('/api/dashboard')
def dashboard(db: Session = Depends(get_db), _: User = Depends(admin_only)):
    today = date.today()
    period = today.strftime('%Y-%m')
    customer_count = db.scalar(select(func.count(Customer.id))) or 0
    active_services = db.scalar(select(func.count(Subscription.id)).where(Subscription.status == 'active')) or 0
    total_services = db.scalar(select(func.count(Subscription.id))) or 0
    unpaid_invoices = db.scalar(select(func.count(Invoice.id)).where(Invoice.status != 'paid')) or 0
    overdue = db.scalar(select(func.count(Invoice.id)).where(Invoice.status != 'paid', Invoice.due_date < today)) or 0
    monthly_revenue = db.scalar(select(func.coalesce(func.sum(Payment.amount), 0)).where(func.substr(Payment.paid_at, 1, 7) == period)) if engine.dialect.name == 'sqlite' else db.scalar(select(func.coalesce(func.sum(Payment.amount), 0)).where(func.to_char(Payment.paid_at, 'YYYY-MM') == period))
    revenue_by_category = db.execute(select(ServicePlan.category, func.coalesce(func.sum(Subscription.monthly_fee), 0)).join(Subscription, Subscription.plan_id == ServicePlan.id).where(Subscription.status == 'active').group_by(ServicePlan.category)).all()
    recent = db.scalars(select(Invoice).options(selectinload(Invoice.customer),selectinload(Invoice.items),selectinload(Invoice.payments)).order_by(Invoice.id.desc()).limit(6)).all()
    return {'customers': customer_count, 'active_services': active_services, 'total_services': total_services,
            'unpaid_invoices': unpaid_invoices, 'overdue_invoices': overdue, 'revenue_month': monthly_revenue or 0,
            'mrr_estimate': sum(value for _, value in revenue_by_category),
            'revenue_by_category': [{'category': c, 'amount': amount} for c, amount in revenue_by_category],
            'recent_invoices': [invoice_view(x) for x in recent]}

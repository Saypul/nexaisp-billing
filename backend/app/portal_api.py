"""API aplikasi pelanggan (/api/portal) dan sisi admin untuk akses portal, laporan gangguan, dan bukti transfer.

Setiap query portal difilter dengan customer_id dari token, sehingga pelanggan hanya melihat datanya sendiri.
Verifikasi bukti transfer menjadi Payment ada di main.py (memakai alur pembayaran yang sama dengan admin).
"""
import base64
import os
import secrets
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from .database import get_db
from .models import BankAccount, Complaint, Customer, Invoice, PaymentProof, Subscription, User
from .schemas import BankAccountIn, ComplaintCreate, ComplaintUpdate, PasswordChange, PaymentProofCreate, PortalAccess, PortalLogin, ProofReject
from .security import admin_only, authenticated_customer, customer_token_for, hash_password, verify_password

api = APIRouter()

PROOF_TYPES = {b'\xff\xd8\xff': ('jpg', 'image/jpeg'), b'\x89PNG\r\n\x1a\n': ('png', 'image/png'), b'RIFF': ('webp', 'image/webp')}
MAX_PROOF_BYTES = 1_200_000
# Hash tetap untuk menyamakan waktu respons login saat ID pelanggan tidak ada/portal belum aktif.
DUMMY_HASH = hash_password(secrets.token_urlsafe(16))


def upload_dir() -> Path:
    return Path(os.getenv('WO_PHOTO_DIR', '/app/uploads'))


def invoice_payload(invoice: Invoice):
    paid = sum(p.amount for p in invoice.payments)
    return {
        'id': invoice.id, 'number': invoice.number, 'period': invoice.period, 'due_date': invoice.due_date,
        'status': invoice.status, 'total': invoice.total, 'paid': paid, 'remaining': invoice.total - paid, 'created_at': invoice.created_at,
        'items': [{'description': i.description, 'amount': i.amount, 'charge_type': i.charge_type} for i in invoice.items],
        'payments': [{'id': p.id, 'amount': p.amount, 'method': p.method, 'paid_at': p.paid_at} for p in invoice.payments],
    }


def complaint_payload(c: Complaint, admin: bool = False):
    row = {
        'id': c.id, 'code': f'GG-{c.id:06d}', 'category': c.category, 'description': c.description, 'status': c.status,
        'reply': c.reply, 'service_code': c.subscription.code if c.subscription else None,
        'created_at': c.created_at, 'updated_at': c.updated_at, 'resolved_at': c.resolved_at,
    }
    if admin:
        row.update({'customer_id': c.customer_id, 'customer_name': c.customer.name, 'customer_code': c.customer.code, 'customer_phone': c.customer.phone,
                    'service_address': c.subscription.service_address if c.subscription else None})
    return row


def proof_payload(p: PaymentProof, admin: bool = False):
    row = {
        'id': p.id, 'invoice_id': p.invoice_id, 'invoice_number': p.invoice.number, 'amount': p.amount, 'sender_name': p.sender_name,
        'note': p.note, 'status': p.status, 'review_note': p.review_note, 'created_at': p.created_at, 'reviewed_at': p.reviewed_at,
        'image_url': (f'/api/payment-proofs/{p.id}/image' if admin else f'/api/portal/proofs/{p.id}/image'),
    }
    if admin:
        row.update({'customer_id': p.customer_id, 'customer_name': p.customer.name, 'customer_code': p.customer.code,
                    'reviewed_by': p.reviewed_by, 'payment_id': p.payment_id})
    return row


def proof_file(p: PaymentProof | None):
    if p is None:
        raise HTTPException(404, 'Bukti transfer tidak ditemukan')
    path = upload_dir() / p.filename
    if not path.is_file():
        raise HTTPException(404, 'File bukti transfer tidak ditemukan')
    media_type = {'jpg': 'image/jpeg', 'png': 'image/png', 'webp': 'image/webp'}[p.filename.rsplit('.', 1)[1]]
    return FileResponse(path, media_type=media_type, headers={'Cache-Control': 'private, max-age=300', 'X-Content-Type-Options': 'nosniff'})


def bank_payload(b: BankAccount):
    return {'id': b.id, 'bank_name': b.bank_name, 'account_number': b.account_number, 'account_holder': b.account_holder,
            'note': b.note, 'active': b.active, 'sort_order': b.sort_order}


def bank_query():
    return select(BankAccount).order_by(BankAccount.sort_order, BankAccount.id)


# --- portal pelanggan --------------------------------------------------------
@api.post('/api/portal/login')
def portal_login(data: PortalLogin, db: Session = Depends(get_db)):
    customer = db.scalar(select(Customer).where(Customer.code == data.customer_code.strip()))
    stored = customer.portal_password_hash if customer else None
    if not verify_password(data.password, stored or DUMMY_HASH) or not stored:
        raise HTTPException(401, 'ID pelanggan atau password salah, atau akses aplikasi belum diaktifkan.')
    return {'access_token': customer_token_for(customer), 'token_type': 'bearer', 'name': customer.name, 'code': customer.code}


@api.put('/api/portal/password')
def portal_change_password(data: PasswordChange, db: Session = Depends(get_db), customer: Customer = Depends(authenticated_customer)):
    if not verify_password(data.current_password, customer.portal_password_hash):
        raise HTTPException(422, 'Password lama salah')
    customer.portal_password_hash = hash_password(data.new_password)
    db.commit()
    # Sesi lain otomatis tidak berlaku; kembalikan token baru untuk perangkat ini.
    return {'access_token': customer_token_for(customer)}


@api.get('/api/portal/me')
def portal_me(db: Session = Depends(get_db), customer: Customer = Depends(authenticated_customer)):
    services = db.scalars(select(Subscription).options(selectinload(Subscription.plan))
                          .where(Subscription.customer_id == customer.id, Subscription.status != 'terminated').order_by(Subscription.id)).all()
    invoices = db.scalars(select(Invoice).options(selectinload(Invoice.payments)).where(Invoice.customer_id == customer.id)).all()
    open_invoices = [invoice_payload(i) for i in invoices if i.status != 'paid']
    open_invoices = [i for i in open_invoices if i['remaining'] > 0]
    return {
        'id': customer.id, 'code': customer.code, 'name': customer.name, 'kind': customer.kind,
        'email': customer.email, 'phone': customer.phone, 'address': customer.address,
        'outstanding': sum(i['remaining'] for i in open_invoices), 'open_invoices': len(open_invoices),
        'next_due': min((i['due_date'] for i in open_invoices), default=None),
        'services': [{
            'id': s.id, 'code': s.code, 'plan_name': s.plan.name, 'category': s.plan.category, 'bandwidth_mbps': s.plan.bandwidth_mbps,
            'status': s.status, 'network_state': s.network_state, 'isolation_reason': s.isolation_reason,
            'monthly_fee': s.monthly_fee if s.monthly_fee is not None else s.plan.monthly_fee, 'billing_type': s.billing_type,
            'circuit_id': s.circuit_id, 'service_address': s.service_address, 'start_date': s.start_date,
        } for s in services],
    }


@api.get('/api/portal/bank-accounts')
def portal_bank_accounts(db: Session = Depends(get_db), _: Customer = Depends(authenticated_customer)):
    return [bank_payload(b) for b in db.scalars(bank_query().where(BankAccount.active.is_(True))).all()]


@api.get('/api/portal/invoices')
def portal_invoices(db: Session = Depends(get_db), customer: Customer = Depends(authenticated_customer)):
    rows = db.scalars(select(Invoice).options(selectinload(Invoice.items), selectinload(Invoice.payments))
                      .where(Invoice.customer_id == customer.id).order_by(Invoice.due_date.desc(), Invoice.id.desc())).all()
    return [invoice_payload(i) for i in rows]


@api.get('/api/portal/complaints')
def portal_complaints(db: Session = Depends(get_db), customer: Customer = Depends(authenticated_customer)):
    rows = db.scalars(select(Complaint).options(selectinload(Complaint.subscription))
                      .where(Complaint.customer_id == customer.id).order_by(Complaint.id.desc())).all()
    return [complaint_payload(c) for c in rows]


@api.post('/api/portal/complaints', status_code=201)
def portal_create_complaint(data: ComplaintCreate, db: Session = Depends(get_db), customer: Customer = Depends(authenticated_customer)):
    if data.subscription_id is not None:
        service = db.get(Subscription, data.subscription_id)
        if service is None or service.customer_id != customer.id:
            raise HTTPException(404, 'Layanan tidak ditemukan')
    open_count = db.scalar(select(func.count(Complaint.id)).where(Complaint.customer_id == customer.id, Complaint.status != 'resolved'))
    if open_count >= 5:
        raise HTTPException(429, 'Masih ada 5 laporan yang belum selesai. Tunggu laporan sebelumnya ditangani.')
    complaint = Complaint(customer_id=customer.id, subscription_id=data.subscription_id, category=data.category, description=data.description.strip())
    db.add(complaint)
    db.commit()
    db.refresh(complaint)
    return complaint_payload(complaint)


@api.get('/api/portal/proofs')
def portal_proofs(db: Session = Depends(get_db), customer: Customer = Depends(authenticated_customer)):
    rows = db.scalars(select(PaymentProof).options(selectinload(PaymentProof.invoice))
                      .where(PaymentProof.customer_id == customer.id).order_by(PaymentProof.id.desc())).all()
    return [proof_payload(p) for p in rows]


@api.post('/api/portal/proofs', status_code=201)
def portal_upload_proof(data: PaymentProofCreate, db: Session = Depends(get_db), customer: Customer = Depends(authenticated_customer)):
    invoice = db.scalar(select(Invoice).options(selectinload(Invoice.payments)).where(Invoice.id == data.invoice_id, Invoice.customer_id == customer.id))
    if invoice is None:
        raise HTTPException(404, 'Invoice tidak ditemukan')
    remaining = invoice.total - sum(p.amount for p in invoice.payments)
    if remaining <= 0:
        raise HTTPException(409, 'Invoice ini sudah lunas')
    if data.amount > remaining:
        raise HTTPException(422, 'Nominal melebihi sisa tagihan')
    if db.scalar(select(func.count(PaymentProof.id)).where(PaymentProof.invoice_id == invoice.id, PaymentProof.status == 'pending')) >= 3:
        raise HTTPException(429, 'Sudah ada 3 bukti transfer menunggu verifikasi untuk invoice ini.')
    try:
        raw = base64.b64decode(data.image_base64.split(',', 1)[-1], validate=True)
    except ValueError:
        raise HTTPException(422, 'File gambar tidak valid') from None
    if len(raw) > MAX_PROOF_BYTES:
        raise HTTPException(413, 'Ukuran gambar maksimal 1,2 MB')
    kind = next((v for magic, v in PROOF_TYPES.items() if raw.startswith(magic) and (magic != b'RIFF' or raw[8:12] == b'WEBP')), None)
    if kind is None:
        raise HTTPException(422, 'Format gambar harus JPG, PNG, atau WEBP')
    filename = f'{secrets.token_hex(16)}.{kind[0]}'
    directory = upload_dir()
    directory.mkdir(parents=True, exist_ok=True)
    (directory / filename).write_bytes(raw)
    proof = PaymentProof(customer_id=customer.id, invoice_id=invoice.id, amount=data.amount, sender_name=data.sender_name,
                         note=data.note, filename=filename)
    db.add(proof)
    db.commit()
    db.refresh(proof)
    return proof_payload(proof)


@api.get('/api/portal/proofs/{proof_id}/image')
def portal_proof_image(proof_id: int, db: Session = Depends(get_db), customer: Customer = Depends(authenticated_customer)):
    proof = db.get(PaymentProof, proof_id)
    return proof_file(proof if proof and proof.customer_id == customer.id else None)


# --- admin ---------------------------------------------------------------------
@api.put('/api/customers/{customer_id}/portal-access')
def set_portal_access(customer_id: int, data: PortalAccess, db: Session = Depends(get_db), _: User = Depends(admin_only)):
    customer = db.get(Customer, customer_id)
    if customer is None:
        raise HTTPException(404, 'Pelanggan tidak ditemukan')
    password = data.password or secrets.token_urlsafe(6).replace('-', 'x').replace('_', 'y') + '7'
    customer.portal_password_hash = hash_password(password)
    db.commit()
    return {'customer_code': customer.code, 'password': None if data.password else password}


@api.delete('/api/customers/{customer_id}/portal-access', status_code=204)
def revoke_portal_access(customer_id: int, db: Session = Depends(get_db), _: User = Depends(admin_only)):
    customer = db.get(Customer, customer_id)
    if customer is None:
        raise HTTPException(404, 'Pelanggan tidak ditemukan')
    customer.portal_password_hash = None
    db.commit()


@api.get('/api/complaints')
def list_complaints(db: Session = Depends(get_db), _: User = Depends(admin_only)):
    rows = db.scalars(select(Complaint).options(selectinload(Complaint.customer), selectinload(Complaint.subscription)).order_by(Complaint.id.desc())).all()
    return [complaint_payload(c, admin=True) for c in rows]


@api.put('/api/complaints/{complaint_id}')
def update_complaint(complaint_id: int, data: ComplaintUpdate, db: Session = Depends(get_db), _: User = Depends(admin_only)):
    complaint = db.get(Complaint, complaint_id)
    if complaint is None:
        raise HTTPException(404, 'Laporan tidak ditemukan')
    complaint.status = data.status
    complaint.reply = data.reply
    complaint.resolved_at = datetime.now(timezone.utc) if data.status == 'resolved' else None
    db.commit()
    db.refresh(complaint)
    return complaint_payload(complaint, admin=True)


@api.get('/api/payment-proofs')
def list_payment_proofs(db: Session = Depends(get_db), _: User = Depends(admin_only)):
    rows = db.scalars(select(PaymentProof).options(selectinload(PaymentProof.customer), selectinload(PaymentProof.invoice))
                      .order_by(PaymentProof.id.desc())).all()
    return [proof_payload(p, admin=True) for p in rows]


@api.get('/api/payment-proofs/{proof_id}/image')
def payment_proof_image(proof_id: int, db: Session = Depends(get_db), _: User = Depends(admin_only)):
    return proof_file(db.get(PaymentProof, proof_id))


@api.post('/api/payment-proofs/{proof_id}/reject')
def reject_payment_proof(proof_id: int, data: ProofReject, db: Session = Depends(get_db), user: User = Depends(admin_only)):
    proof = db.get(PaymentProof, proof_id)
    if proof is None:
        raise HTTPException(404, 'Bukti transfer tidak ditemukan')
    if proof.status != 'pending':
        raise HTTPException(409, 'Bukti transfer sudah diproses')
    proof.status, proof.review_note = 'rejected', data.note
    proof.reviewed_by, proof.reviewed_at = user.email, datetime.now(timezone.utc)
    db.commit()
    return {'ok': True}


@api.get('/api/bank-accounts')
def list_bank_accounts(db: Session = Depends(get_db), _: User = Depends(admin_only)):
    return [bank_payload(b) for b in db.scalars(bank_query()).all()]


def save_bank(db: Session, account: BankAccount, data: BankAccountIn):
    for key, value in data.model_dump().items():
        setattr(account, key, value.strip() if isinstance(value, str) else value)
    account.note = account.note or None
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, 'Rekening dengan bank dan nomor yang sama sudah ada') from None
    db.refresh(account)
    return bank_payload(account)


@api.post('/api/bank-accounts', status_code=201)
def create_bank_account(data: BankAccountIn, db: Session = Depends(get_db), _: User = Depends(admin_only)):
    account = BankAccount()
    db.add(account)
    return save_bank(db, account, data)


@api.put('/api/bank-accounts/{account_id}')
def update_bank_account(account_id: int, data: BankAccountIn, db: Session = Depends(get_db), _: User = Depends(admin_only)):
    account = db.get(BankAccount, account_id)
    if account is None:
        raise HTTPException(404, 'Rekening tidak ditemukan')
    return save_bank(db, account, data)


@api.delete('/api/bank-accounts/{account_id}', status_code=204)
def delete_bank_account(account_id: int, db: Session = Depends(get_db), _: User = Depends(admin_only)):
    account = db.get(BankAccount, account_id)
    if account is None:
        raise HTTPException(404, 'Rekening tidak ditemukan')
    db.delete(account)
    db.commit()

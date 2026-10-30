"""Optional demonstration data. Never runs automatically."""
import os
import secrets
from datetime import date
from sqlalchemy import select
from .database import SessionLocal
from .models import Customer, ServicePlan, Subscription, Invoice, InvoiceItem, Payment


def main():
    if os.getenv('DEMO_SEED_ALLOWED') != '1':
        raise SystemExit('Demo seed diblokir. Gunakan DEMO_SEED_ALLOWED=1 hanya di lingkungan uji.')
    with SessionLocal() as db:
        if db.scalar(select(Customer.id).limit(1)):
            raise SystemExit('Dibatalkan: tabel pelanggan sudah berisi data. Tidak mencampur demo dengan data nyata.')
        customers = [
            Customer(code=str(secrets.randbelow(9_000_000_000)+1_000_000_000),name='Andi Pratama',kind='residential',email='andi@example.com'),
            Customer(code=str(secrets.randbelow(9_000_000_000)+1_000_000_000),name='Siti Rahmawati',kind='residential',email='siti@example.com'),
            Customer(code=str(secrets.randbelow(9_000_000_000)+1_000_000_000),name='PT Nusantara Digital',kind='corporate',email='finance@example.com'),
            Customer(code=str(secrets.randbelow(9_000_000_000)+1_000_000_000),name='CV Mitra Jaringan',kind='business',email='billing@example.com'),
        ]
        db.add_all(customers)
        plans = [
            ServicePlan(name='Home 50 Mbps',category='FTTH',monthly_fee=250_000,setup_fee=100_000,bandwidth_mbps=50),
            ServicePlan(name='Home 30 Mbps',category='FTTH',monthly_fee=185_000,setup_fee=100_000,bandwidth_mbps=30),
            ServicePlan(name='Metro-E Corporate 1 Gbps',category='METRO_E',monthly_fee=8_000_000,setup_fee=1_000_000,bandwidth_mbps=1000),
            ServicePlan(name='Tunnel Site-to-Site',category='TUNNEL',monthly_fee=1_500_000,setup_fee=500_000),
            ServicePlan(name='Dedicated 200 Mbps',category='DEDICATED',monthly_fee=5_000_000,setup_fee=1_500_000,bandwidth_mbps=200),
        ]
        db.add_all(plans)
        db.flush()
        subscriptions = [
            Subscription(code='SRV-FTTH-001', customer_id=customers[0].id,plan_id=plans[0].id,status='active',start_date=date(2026,9,1)),
            Subscription(code='SRV-FTTH-002', customer_id=customers[1].id,plan_id=plans[1].id,status='active',start_date=date(2026,9,1)),
            Subscription(code='SRV-DIA-001', customer_id=customers[2].id,plan_id=plans[4].id,status='active',start_date=date(2026,8,1)),
            Subscription(code='ETH-ME-001', customer_id=customers[2].id,plan_id=plans[2].id,status='active',circuit_id='ME-JKT-001',start_date=date(2026,8,1)),
            Subscription(code='SRV-VPN-001', customer_id=customers[2].id,plan_id=plans[3].id,status='active',circuit_id='TUN-001',start_date=date(2026,8,1)),
            Subscription(code='SRV-VPN-002', customer_id=customers[3].id,plan_id=plans[3].id,status='pending',start_date=date(2026,10,1)),
        ]
        db.add_all(subscriptions)
        for subscription in subscriptions:
            subscription.billing_type = 'prepaid'
            subscription.monthly_fee = next(p.monthly_fee for p in plans if p.id == subscription.plan_id)
            subscription.setup_fee = 0  # Historical demo invoices include MRC only.
        db.flush()
        for c in customers[:3]:
            service_rows=[s for s in subscriptions if s.customer_id == c.id and s.status == 'active']
            total=sum(s.plan.monthly_fee for s in service_rows)
            inv=Invoice(number=f'INV-DEMO-202610-{c.id:06d}',customer_id=c.id,period='2026-10',due_date=date(2026,10,20),total=total,status='unpaid')
            inv.items=[InvoiceItem(subscription_id=s.id,description=f'{s.plan.category} · {s.plan.name} ({s.code})',amount=s.plan.monthly_fee) for s in service_rows]
            db.add(inv)
            db.flush()
            if c.id == customers[0].id:
                db.add(Payment(invoice_id=inv.id,amount=total,method='transfer',reference='DEMO-001'))
                inv.status='paid'
        db.commit()
        print('Demo data berhasil dibuat. Semua nama dan jumlah merupakan ilustrasi.')


if __name__ == '__main__':
    main()

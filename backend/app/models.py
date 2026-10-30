from datetime import date, datetime, timezone
from sqlalchemy import (
    String, Integer, BigInteger, Boolean, ForeignKey, Date, DateTime, Text, UniqueConstraint, CheckConstraint
)
from sqlalchemy.orm import Mapped, mapped_column, relationship
from .database import Base


def utcnow():
    return datetime.now(timezone.utc)


class User(Base):
    __tablename__ = "users"
    id: Mapped[int] = mapped_column(primary_key=True)
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(512))
    role: Mapped[str] = mapped_column(String(30), default="admin")


class Customer(Base):
    __tablename__ = "customers"
    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(40), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(150), index=True)
    kind: Mapped[str] = mapped_column(String(30), default="residential")
    email: Mapped[str | None] = mapped_column(String(255), nullable=True)
    phone: Mapped[str | None] = mapped_column(String(60), nullable=True)
    address: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    subscriptions: Mapped[list["Subscription"]] = relationship(back_populates="customer")


class ServicePlan(Base):
    __tablename__ = "service_plans"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(120))
    category: Mapped[str] = mapped_column(String(30))
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    bandwidth_mbps: Mapped[int | None] = mapped_column(Integer, nullable=True)
    monthly_fee: Mapped[int] = mapped_column(Integer)
    setup_fee: Mapped[int] = mapped_column(Integer, default=0)
    # Nama PPP profile di router (rate-limit paket). Kosong = profile "default".
    pppoe_profile: Mapped[str | None] = mapped_column(String(80), nullable=True)
    __table_args__ = (CheckConstraint("monthly_fee >= 0 AND setup_fee >= 0", name="fee_nonnegative"),)


class Subscription(Base):
    __tablename__ = "subscriptions"
    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(50), unique=True)
    customer_id: Mapped[int] = mapped_column(ForeignKey("customers.id", ondelete="RESTRICT"))
    plan_id: Mapped[int] = mapped_column(ForeignKey("service_plans.id", ondelete="RESTRICT"))
    status: Mapped[str] = mapped_column(String(25), default="pending")
    billing_type: Mapped[str] = mapped_column(String(20), default="prepaid")
    invoice_mode: Mapped[str] = mapped_column(String(20), default="manual")
    monthly_fee: Mapped[int | None] = mapped_column(Integer, nullable=True)
    setup_fee: Mapped[int | None] = mapped_column(Integer, nullable=True)
    circuit_id: Mapped[str | None] = mapped_column(String(100), nullable=True)
    service_address: Mapped[str | None] = mapped_column(Text, nullable=True)
    start_date: Mapped[date] = mapped_column(Date, default=date.today)
    # Pemetaan jaringan PPPoE. network_state: unconfigured | provisioned | isolated | error.
    router_id: Mapped[int | None] = mapped_column(ForeignKey("routers.id", ondelete="RESTRICT"), nullable=True)
    pppoe_username: Mapped[str | None] = mapped_column(String(100), nullable=True)
    encrypted_pppoe_password: Mapped[str | None] = mapped_column(Text, nullable=True)
    network_state: Mapped[str] = mapped_column(String(20), default="unconfigured")
    isolation_reason: Mapped[str | None] = mapped_column(String(20), nullable=True)  # manual | overdue
    network_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    network_synced_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    customer: Mapped["Customer"] = relationship(back_populates="subscriptions")
    plan: Mapped["ServicePlan"] = relationship()
    router: Mapped["Router | None"] = relationship()
    __table_args__ = (CheckConstraint("monthly_fee >= 0 AND setup_fee >= 0", name="subscription_fee_nonnegative"),)


class Ticket(Base):
    __tablename__ = "tickets"
    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(40), unique=True, index=True)
    customer_id: Mapped[int] = mapped_column(ForeignKey("customers.id", ondelete="RESTRICT"), index=True)
    subscription_id: Mapped[int | None] = mapped_column(ForeignKey("subscriptions.id", ondelete="SET NULL"), nullable=True)
    status: Mapped[str] = mapped_column(String(30), default="open")
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    technician_name: Mapped[str | None] = mapped_column(String(120), nullable=True)
    technician_telegram_id: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    rfs_target_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    installed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)
    activated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    customer: Mapped["Customer"] = relationship()
    subscription: Mapped["Subscription | None"] = relationship()
    events: Mapped[list["TicketEvent"]] = relationship(back_populates="ticket", cascade="all, delete-orphan", order_by="TicketEvent.id")


class TicketEvent(Base):
    __tablename__ = "ticket_events"
    id: Mapped[int] = mapped_column(primary_key=True)
    ticket_id: Mapped[int] = mapped_column(ForeignKey("tickets.id", ondelete="CASCADE"), index=True)
    actor_type: Mapped[str] = mapped_column(String(20))
    actor_name: Mapped[str] = mapped_column(String(120))
    old_status: Mapped[str | None] = mapped_column(String(30), nullable=True)
    new_status: Mapped[str] = mapped_column(String(30))
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    photo_filename: Mapped[str | None] = mapped_column(String(80), nullable=True)
    notify_telegram_id: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    telegram_delivered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    telegram_attempts: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    ticket: Mapped["Ticket"] = relationship(back_populates="events")


class TelegramBotState(Base):
    __tablename__ = "telegram_bot_state"
    key: Mapped[str] = mapped_column(String(40), primary_key=True)
    value: Mapped[str] = mapped_column(String(100))


class TelegramConfig(Base):
    __tablename__ = "telegram_config"
    id: Mapped[int] = mapped_column(primary_key=True)
    encrypted_bot_token: Mapped[str | None] = mapped_column(Text, nullable=True)
    bot_id: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    bot_username: Mapped[str | None] = mapped_column(String(120), nullable=True)
    admin_chat_id: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    work_order_chat_id: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    noc_chat_id: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    category_teams: Mapped[str | None] = mapped_column(Text, nullable=True)


class Invoice(Base):
    __tablename__ = "invoices"
    __table_args__ = (
        UniqueConstraint("customer_id", "period", "invoice_mode", "sequence", name="uq_invoice_customer_period_mode_sequence"),
    )
    id: Mapped[int] = mapped_column(primary_key=True)
    number: Mapped[str] = mapped_column(String(60), unique=True)
    customer_id: Mapped[int] = mapped_column(ForeignKey("customers.id", ondelete="RESTRICT"))
    period: Mapped[str] = mapped_column(String(7))
    invoice_mode: Mapped[str] = mapped_column(String(20), default="manual")
    sequence: Mapped[int] = mapped_column(Integer, default=1)
    due_date: Mapped[date] = mapped_column(Date)
    status: Mapped[str] = mapped_column(String(20), default="unpaid")
    total: Mapped[int] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    customer: Mapped["Customer"] = relationship()
    items: Mapped[list["InvoiceItem"]] = relationship(back_populates="invoice", cascade="all, delete-orphan")
    payments: Mapped[list["Payment"]] = relationship(back_populates="invoice")


class InvoiceItem(Base):
    __tablename__ = "invoice_items"
    id: Mapped[int] = mapped_column(primary_key=True)
    invoice_id: Mapped[int] = mapped_column(ForeignKey("invoices.id", ondelete="CASCADE"))
    subscription_id: Mapped[int | None] = mapped_column(ForeignKey("subscriptions.id", ondelete="SET NULL"), nullable=True)
    description: Mapped[str] = mapped_column(String(240))
    charge_type: Mapped[str] = mapped_column(String(20), default="mrc")
    amount: Mapped[int] = mapped_column(Integer)
    invoice: Mapped["Invoice"] = relationship(back_populates="items")


class Payment(Base):
    __tablename__ = "payments"
    id: Mapped[int] = mapped_column(primary_key=True)
    invoice_id: Mapped[int] = mapped_column(ForeignKey("invoices.id", ondelete="RESTRICT"))
    amount: Mapped[int] = mapped_column(Integer)
    method: Mapped[str] = mapped_column(String(50))
    reference: Mapped[str | None] = mapped_column(String(120), nullable=True)
    paid_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    invoice: Mapped["Invoice"] = relationship(back_populates="payments")
    __table_args__ = (CheckConstraint("amount > 0", name="payment_positive"),)


class Router(Base):
    """MikroTik NAS/BRAS yang dikelola lewat RouterOS API."""
    __tablename__ = "routers"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(100), unique=True)
    host: Mapped[str] = mapped_column(String(255))
    port: Mapped[int] = mapped_column(Integer, default=8728)
    use_tls: Mapped[bool] = mapped_column(Boolean, default=False)
    tls_verify: Mapped[bool] = mapped_column(Boolean, default=False)
    username: Mapped[str] = mapped_column(String(100))
    encrypted_password: Mapped[str] = mapped_column(Text)
    isolation_mode: Mapped[str] = mapped_column(String(20), default="disable")  # disable | profile
    isolation_profile: Mapped[str | None] = mapped_column(String(80), nullable=True)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    identity: Mapped[str | None] = mapped_column(String(120), nullable=True)
    version: Mapped[str | None] = mapped_column(String(60), nullable=True)
    last_checked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class NetworkEvent(Base):
    """Jejak audit setiap aksi ke router (berhasil maupun gagal)."""
    __tablename__ = "network_events"
    id: Mapped[int] = mapped_column(primary_key=True)
    router_id: Mapped[int | None] = mapped_column(ForeignKey("routers.id", ondelete="SET NULL"), nullable=True, index=True)
    subscription_id: Mapped[int | None] = mapped_column(ForeignKey("subscriptions.id", ondelete="SET NULL"), nullable=True, index=True)
    action: Mapped[str] = mapped_column(String(30))
    ok: Mapped[bool] = mapped_column(Boolean)
    message: Mapped[str | None] = mapped_column(Text, nullable=True)
    actor: Mapped[str] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)


class NetworkSettings(Base):
    """Kebijakan isolir otomatis (satu baris, id=1). Nonaktif secara default."""
    __tablename__ = "network_settings"
    id: Mapped[int] = mapped_column(primary_key=True)
    auto_isolate: Mapped[bool] = mapped_column(Boolean, default=False)
    grace_days: Mapped[int] = mapped_column(Integer, default=7)
    auto_restore: Mapped[bool] = mapped_column(Boolean, default=True)
    max_per_run: Mapped[int] = mapped_column(Integer, default=50)

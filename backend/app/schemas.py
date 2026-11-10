import ipaddress
from datetime import date
from typing import Literal
from pydantic import BaseModel, ConfigDict, EmailStr, Field, computed_field, field_validator
from .security import PASSWORD_RULE, password_ok

Kind = Literal['residential', 'business', 'corporate']
Category = Literal['METRO_E', 'DEDICATED', 'FTTH', 'TUNNEL']
Status = Literal['pending', 'active', 'suspended', 'terminated']
TicketStatus = Literal['scheduled', 'open', 'survey', 'installation', 'ready', 'closed']


class Login(BaseModel):
    email: str = Field(min_length=3, max_length=255)
    password: str


class TelegramConfigUpdate(BaseModel):
    bot_token: str | None = Field(default=None, min_length=20, max_length=200)
    admin_chat_id: int | None = None
    work_order_chat_id: int | None = None
    noc_chat_id: int | None = None
    category_teams: dict[Category, Literal['technician', 'noc']] | None = None


class CustomerCreate(BaseModel):
    name: str = Field(min_length=2, max_length=150)
    kind: Kind = 'residential'
    email: EmailStr | None = None
    phone: str | None = Field(default=None, max_length=60)
    address: str | None = None


class CustomerOut(CustomerCreate):
    model_config = ConfigDict(from_attributes=True)
    id: int
    code: str
    portal_password_hash: str | None = Field(default=None, exclude=True)

    @computed_field
    @property
    def portal_enabled(self) -> bool:
        return bool(self.portal_password_hash)


class InitialServiceCreate(BaseModel):
    plan_id: int
    billing_type: Literal['prepaid', 'postpaid'] = 'postpaid'
    invoice_mode: Literal['manual', 'auto'] | None = None
    monthly_fee: int | None = Field(default=None, ge=0)
    setup_fee: int | None = Field(default=None, ge=0)
    status: Status = 'active'
    start_date: date = Field(default_factory=date.today)
    rfs_target_date: date | None = None
    circuit_id: str | None = Field(default=None, max_length=100)
    service_address: str | None = None


class CustomerCreateWithService(CustomerCreate):
    initial_service: InitialServiceCreate | None = None


class TicketCreate(BaseModel):
    customer_id: int
    initial_service: InitialServiceCreate | None = None
    notes: str | None = None
    technician_name: str | None = Field(default=None, max_length=120)
    technician_telegram_id: int | None = Field(default=None, gt=0)


class TicketUpdate(BaseModel):
    status: TicketStatus
    technician_name: str | None = Field(default=None, max_length=120)
    technician_telegram_id: int | None = None
    plan_id: int | None = None
    billing_type: Literal['prepaid', 'postpaid'] | None = None
    invoice_mode: Literal['manual', 'auto'] | None = None
    monthly_fee: int | None = Field(default=None, ge=0)
    setup_fee: int | None = Field(default=None, ge=0)
    start_date: date | None = None
    rfs_target_date: date | None = None
    circuit_id: str | None = Field(default=None, max_length=100)
    service_address: str | None = None
    notes: str | None = None


class TicketActivation(BaseModel):
    billing_start_date: date
    notes: str = Field(min_length=3, max_length=2000)
    # Opsional: NOC memetakan layanan PPPoE ke router saat aktivasi.
    router_id: int | None = None
    pppoe_username: str | None = Field(default=None, max_length=100, pattern=r'^[A-Za-z0-9._@-]*$')


class NocUserCreate(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)

    @field_validator('password')
    @classmethod
    def strong_enough(cls, value: str) -> str:
        if not password_ok(value):
            raise ValueError(PASSWORD_RULE)
        return value


class PlanCreate(BaseModel):
    name: str = Field(min_length=2, max_length=120)
    category: Category
    description: str | None = None
    bandwidth_mbps: int | None = Field(default=None, gt=0)
    monthly_fee: int = Field(ge=0)
    setup_fee: int = Field(default=0, ge=0)
    pppoe_profile: str | None = Field(default=None, max_length=80)


class PlanUpdate(PlanCreate):
    # Require acknowledgement when the catalog item has linked services.
    confirm_existing: bool = False


class PlanOut(PlanCreate):
    model_config = ConfigDict(from_attributes=True)
    id: int


class SubscriptionCreate(BaseModel):
    code: str = Field(min_length=2, max_length=50)
    customer_id: int
    plan_id: int
    status: Status = 'active'
    billing_type: Literal['prepaid', 'postpaid'] = 'prepaid'
    invoice_mode: Literal['manual', 'auto'] | None = None
    monthly_fee: int | None = Field(default=None, ge=0)
    setup_fee: int | None = Field(default=None, ge=0)
    circuit_id: str | None = Field(default=None, max_length=100)
    service_address: str | None = None
    start_date: date = Field(default_factory=date.today)


class SubscriptionStatus(BaseModel):
    status: Status


class InvoiceUpdate(BaseModel):
    due_date: date


class InvoiceGenerate(BaseModel):
    period: str = Field(pattern=r'^\d{4}-(0[1-9]|1[0-2])$')
    due_date: date


class PaymentCreate(BaseModel):
    amount: int = Field(gt=0)
    method: Literal['transfer', 'cash', 'qris_manual', 'other']
    reference: str | None = Field(default=None, max_length=120)


class RouterBase(BaseModel):
    name: str = Field(min_length=2, max_length=100)
    host: str = Field(min_length=1, max_length=255)
    port: int = Field(default=8728, ge=1, le=65535)
    use_tls: bool = False
    tls_verify: bool = False
    username: str = Field(min_length=1, max_length=100)
    isolation_mode: Literal['disable', 'profile'] = 'disable'
    isolation_profile: str | None = Field(default=None, max_length=80)
    enabled: bool = True


class RouterCreate(RouterBase):
    password: str = Field(min_length=1, max_length=200)


class RouterUpdate(RouterBase):
    # Kosong = password lama tetap dipakai.
    password: str | None = Field(default=None, max_length=200)


class NetworkAssign(BaseModel):
    router_id: int | None
    pppoe_username: str | None = Field(default=None, max_length=100, pattern=r'^[A-Za-z0-9._@-]*$')
    pppoe_password: str | None = Field(default=None, max_length=100)
    provision: bool = True


class NetworkSettingsUpdate(BaseModel):
    auto_isolate: bool
    grace_days: int = Field(ge=0, le=90)
    auto_restore: bool = True
    max_per_run: int = Field(default=50, ge=1, le=1000)


RouterOSName = Field(min_length=1, max_length=100, pattern=r'^[A-Za-z0-9._@-]+$')


class PppProfileIn(BaseModel):
    name: str = Field(min_length=1, max_length=80, pattern=r'^[A-Za-z0-9._ -]+$')
    rate_limit: str | None = Field(default=None, max_length=120, pattern=r'^[0-9A-Za-z/ .:]*$')
    local_address: str | None = Field(default=None, max_length=100)
    remote_address: str | None = Field(default=None, max_length=100)
    dns_server: str | None = Field(default=None, max_length=120)
    only_one: Literal['default', 'yes', 'no'] | None = None
    comment: str | None = Field(default=None, max_length=200)


class IpPoolIn(BaseModel):
    name: str = Field(min_length=1, max_length=80, pattern=r'^[A-Za-z0-9._-]+$')
    ranges: str = Field(min_length=7, max_length=500)
    next_pool: str | None = Field(default=None, max_length=80, pattern=r'^[A-Za-z0-9._-]*$')
    comment: str | None = Field(default=None, max_length=200)

    @field_validator('ranges')
    @classmethod
    def valid_ranges(cls, value: str) -> str:
        """Format RouterOS: "a-b", "a/24", atau "a", beberapa dipisah koma; dinormalisasi tanpa spasi."""
        parts = [p.strip() for p in value.split(',') if p.strip()]
        for part in parts:
            try:
                if '/' in part:
                    ipaddress.ip_network(part, strict=False)
                    continue
                start, _, end = part.partition('-')
                first = ipaddress.ip_address(start.strip())
                if end and (ipaddress.ip_address(end.strip()).version != first.version or ipaddress.ip_address(end.strip()) < first):
                    raise ValueError
            except ValueError:
                raise ValueError(f'Range "{part}" tidak valid. Contoh: 10.20.0.2-10.20.0.254 atau 10.20.0.0/24') from None
        if not parts:
            raise ValueError('Range wajib diisi')
        return ','.join(p.replace(' ', '') for p in parts)


class PppSecretIn(BaseModel):
    name: str = RouterOSName
    # Kosong saat membuat = dibuat otomatis; kosong saat edit = password lama tetap.
    password: str | None = Field(default=None, max_length=100)
    service: Literal['any', 'pppoe', 'pptp', 'l2tp', 'sstp', 'ovpn'] = 'pppoe'
    profile: str | None = Field(default=None, max_length=80)
    local_address: str | None = Field(default=None, max_length=100)
    remote_address: str | None = Field(default=None, max_length=100)
    disabled: bool = False
    comment: str | None = Field(default=None, max_length=200)
    subscription_id: int | None = None


class PortalLogin(BaseModel):
    customer_code: str = Field(min_length=1, max_length=40)
    password: str = Field(max_length=128)


class PortalAccess(BaseModel):
    # Kosong = dibuat otomatis dan ditampilkan sekali ke admin.
    password: str | None = Field(default=None, max_length=128)

    @field_validator('password')
    @classmethod
    def strong_enough(cls, value: str | None) -> str | None:
        if value and not password_ok(value):
            raise ValueError(PASSWORD_RULE)
        return value or None


class PasswordChange(BaseModel):
    current_password: str = Field(max_length=128)
    new_password: str = Field(max_length=128)

    @field_validator('new_password')
    @classmethod
    def strong_enough(cls, value: str) -> str:
        if not password_ok(value):
            raise ValueError(PASSWORD_RULE)
        return value


ComplaintCategory = Literal['no_internet', 'slow', 'intermittent', 'other']


class ComplaintCreate(BaseModel):
    subscription_id: int | None = None
    category: ComplaintCategory
    description: str = Field(min_length=5, max_length=2000)


class ComplaintUpdate(BaseModel):
    status: Literal['open', 'in_progress', 'resolved']
    reply: str | None = Field(default=None, max_length=2000)


class PaymentProofCreate(BaseModel):
    invoice_id: int
    amount: int = Field(gt=0)
    sender_name: str | None = Field(default=None, max_length=120)
    note: str | None = Field(default=None, max_length=500)
    image_base64: str = Field(min_length=16, max_length=1_700_000)


class ProofApprove(BaseModel):
    amount: int | None = Field(default=None, gt=0)
    method: Literal['transfer', 'cash', 'qris_manual', 'other'] = 'transfer'


class ProofReject(BaseModel):
    note: str = Field(min_length=3, max_length=500)


class BankAccountIn(BaseModel):
    bank_name: str = Field(min_length=2, max_length=80)
    # Hanya angka, spasi, dan tanda minus agar mudah disalin pelanggan.
    account_number: str = Field(min_length=4, max_length=40, pattern=r'^[0-9 -]+$')
    account_holder: str = Field(min_length=2, max_length=120)
    note: str | None = Field(default=None, max_length=200)
    active: bool = True
    sort_order: int = Field(default=0, ge=0, le=999)

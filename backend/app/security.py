import hashlib
import os
from datetime import datetime, timedelta, timezone
import jwt
from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError, VerificationError, InvalidHashError
from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session
from .database import get_db
from .models import Customer, User

hasher = PasswordHasher()
bearer = HTTPBearer(auto_error=False)


PASSWORD_RULE = 'Password minimal 8 karakter dan memuat angka, huruf kapital, atau simbol'


def password_ok(password: str) -> bool:
    return len(password) >= 8 and any(not c.isalpha() or c.isupper() for c in password)


def hash_password(password: str) -> str:
    return hasher.hash(password)


def verify_password(password: str, value: str) -> bool:
    try:
        return hasher.verify(value, password)
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        return False


def token_for(user: User) -> str:
    return jwt.encode(
        {"sub": str(user.id), "role": user.role, "exp": datetime.now(timezone.utc) + timedelta(hours=8)},
        os.environ["JWT_SECRET"], algorithm="HS256",
    )


def authenticated_user(credentials: HTTPAuthorizationCredentials | None = Depends(bearer), db: Session = Depends(get_db)) -> User:
    if credentials is None:
        raise HTTPException(401, "Login diperlukan")
    try:
        payload = jwt.decode(credentials.credentials, os.environ["JWT_SECRET"], algorithms=["HS256"])
        if payload.get("role") == "customer":
            raise HTTPException(403, "Akses ditolak")
        user_id = int(payload["sub"])
    except (jwt.InvalidTokenError, KeyError, TypeError, ValueError):
        raise HTTPException(401, "Sesi tidak valid atau kedaluwarsa") from None
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(401, "Sesi tidak valid atau kedaluwarsa")
    return user


def admin_only(user: User = Depends(authenticated_user)) -> User:
    if user.role != 'admin':
        raise HTTPException(403, "Akses ditolak")
    return user


def admin_or_noc(user: User = Depends(authenticated_user)) -> User:
    if user.role not in {'admin', 'noc'}:
        raise HTTPException(403, "Akses ditolak")
    return user


# --- aplikasi pelanggan ----------------------------------------------------
# Token pelanggan memakai sub "customer:<id>" agar tidak pernah terbaca sebagai User admin/NOC.
# "pv" mengikat token ke hash password: reset/ganti password mencabut semua sesi lama.
def password_version(password_hash: str) -> str:
    return hashlib.sha256(password_hash.encode()).hexdigest()[:16]


def customer_token_for(customer: Customer) -> str:
    return jwt.encode(
        {"sub": f"customer:{customer.id}", "role": "customer", "pv": password_version(customer.portal_password_hash),
         "exp": datetime.now(timezone.utc) + timedelta(days=30)},
        os.environ["JWT_SECRET"], algorithm="HS256",
    )


def authenticated_customer(credentials: HTTPAuthorizationCredentials | None = Depends(bearer), db: Session = Depends(get_db)) -> Customer:
    if credentials is None:
        raise HTTPException(401, "Login diperlukan")
    try:
        payload = jwt.decode(credentials.credentials, os.environ["JWT_SECRET"], algorithms=["HS256"])
        kind, _, raw_id = payload["sub"].partition(":")
        if payload.get("role") != "customer" or kind != "customer":
            raise ValueError
        customer_id = int(raw_id)
    except (jwt.InvalidTokenError, KeyError, TypeError, ValueError, AttributeError):
        raise HTTPException(401, "Sesi tidak valid atau kedaluwarsa") from None
    customer = db.get(Customer, customer_id)
    if not customer or not customer.portal_password_hash or payload.get("pv") != password_version(customer.portal_password_hash):
        raise HTTPException(401, "Sesi tidak valid atau kedaluwarsa")
    return customer

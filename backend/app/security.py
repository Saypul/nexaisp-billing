import os
from datetime import datetime, timedelta, timezone
import jwt
from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError, VerificationError, InvalidHashError
from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session
from .database import get_db
from .models import User

hasher = PasswordHasher()
bearer = HTTPBearer(auto_error=False)


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

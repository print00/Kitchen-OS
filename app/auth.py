import secrets
from datetime import datetime, timedelta

from fastapi import Depends, Header, HTTPException
from passlib.context import CryptContext

from .db import execute, now_iso, query_one

pwd_context = CryptContext(schemes=["pbkdf2_sha256"], deprecated="auto")
TOKEN_HOURS = 16


def hash_password(password: str) -> str:
    return pwd_context.hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    return pwd_context.verify(password, password_hash)


def create_token(user_id: int) -> str:
    token = secrets.token_urlsafe(32)
    expires_at = (datetime.utcnow() + timedelta(hours=TOKEN_HOURS)).isoformat()
    execute(
        "INSERT INTO auth_tokens(token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
        (token, user_id, expires_at, now_iso()),
    )
    return token


def get_current_user(authorization: str | None = Header(default=None)) -> dict:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Missing auth token")

    token = authorization.split(" ", 1)[1].strip()
    row = query_one(
        """
        SELECT u.id, u.username, u.full_name, u.active, r.name AS role, t.expires_at
        FROM auth_tokens t
        JOIN users u ON u.id = t.user_id
        JOIN roles r ON r.id = u.role_id
        WHERE t.token = ?
        """,
        (token,),
    )
    if not row:
        raise HTTPException(status_code=401, detail="Invalid token")
    if datetime.fromisoformat(row["expires_at"]) < datetime.utcnow():
        raise HTTPException(status_code=401, detail="Token expired")
    if int(row["active"]) != 1:
        raise HTTPException(status_code=403, detail="User inactive")
    return row


def require_roles(*allowed: str):
    def _dep(user: dict = Depends(get_current_user)) -> dict:
        if user["role"] not in allowed:
            raise HTTPException(status_code=403, detail="Insufficient permissions")
        return user

    return _dep

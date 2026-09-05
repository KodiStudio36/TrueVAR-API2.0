import os
from datetime import datetime, timedelta, timezone
from typing import Optional

import jwt
from fastapi import Request

from infrastructure.firebase_client import init_firestore

db = init_firestore()

JWT_SECRET = os.getenv("JWT_SECRET", "super-secret-app-key-change-in-production")
JWT_ALGORITHM = "HS256"
SESSION_COOKIE_NAME = "session"
EXPIRES_IN = timedelta(days=5)


def create_session_jwt(user_data: dict, expires_delta: timedelta) -> str:
    to_encode = user_data.copy()
    expire = datetime.now(timezone.utc) + expires_delta
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, JWT_SECRET, algorithm=JWT_ALGORITHM)


def decode_session_jwt(token: str) -> Optional[dict]:
    try:
        return jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
    except jwt.PyJWTError:
        return None
    except Exception:
        return None


async def get_current_user(request: Request) -> Optional[dict]:
    session_cookie = request.cookies.get(SESSION_COOKIE_NAME)
    if not session_cookie:
        return None
    return decode_session_jwt(session_cookie)


def get_admin_club_id(user: Optional[dict]) -> Optional[str]:
    roles = (user or {}).get("roles", {})
    for club_id, role in roles.items():
        if role == "ADMIN":
            return club_id
    return None


def get_user_roles(uid: str) -> dict:
    perms_docs = db.collection("user_permissions").where("uid", "==", uid).stream()
    roles = {}
    for doc in perms_docs:
        data = doc.to_dict()
        roles[data.get("clubId")] = data.get("role", "COACH")
    return roles
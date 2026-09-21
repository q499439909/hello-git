"""Self-contained account and opaque-cookie authentication."""

from __future__ import annotations

import hashlib
import hmac
import re
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any
from uuid import uuid4

from .catalog import Catalog


class AuthenticationError(ValueError):
    pass


class AccountConflictError(ValueError):
    pass


class PasswordHasher:
    """Password hashing using the standard-library scrypt KDF."""

    n = 2**14
    r = 8
    p = 1
    dklen = 32

    def hash(self, password: str) -> str:
        self.validate(password)
        salt = secrets.token_bytes(16)
        digest = hashlib.scrypt(
            password.encode("utf-8"),
            salt=salt,
            n=self.n,
            r=self.r,
            p=self.p,
            dklen=self.dklen,
        )
        return f"scrypt${self.n}${self.r}${self.p}${salt.hex()}${digest.hex()}"

    def verify(self, password: str, encoded: str) -> bool:
        try:
            algorithm, n, r, p, salt, expected = encoded.split("$", 5)
            if algorithm != "scrypt":
                return False
            actual = hashlib.scrypt(
                password.encode("utf-8"),
                salt=bytes.fromhex(salt),
                n=int(n),
                r=int(r),
                p=int(p),
                dklen=len(bytes.fromhex(expected)),
            )
            return hmac.compare_digest(actual, bytes.fromhex(expected))
        except (ValueError, TypeError):
            return False

    @staticmethod
    def validate(password: str) -> None:
        if len(password) < 8:
            raise ValueError("password must contain at least 8 characters")
        if len(password.encode("utf-8")) > 256:
            raise ValueError("password is too long")


class AuthManager:
    """High-leverage interface for registration and login-session lifecycle."""

    username_pattern = re.compile(r"^[A-Za-z0-9_.-]{3,64}$")

    def __init__(self, catalog: Catalog, session_days: int = 14) -> None:
        self.catalog = catalog
        self.session_days = max(1, session_days)
        self.passwords = PasswordHasher()

    def register(
        self, username: str, password: str, display_name: str = ""
    ) -> tuple[dict[str, Any], str]:
        normalized = self._username(username)
        if self.catalog.get_user_by_username(normalized):
            raise AccountConflictError("username is already registered")
        user_id = f"usr_{uuid4().hex}"
        try:
            role = "admin" if not self.catalog.list_users() else "user"
            user = self.catalog.create_user(
                {
                    "id": user_id,
                    "username": normalized,
                    "password_hash": self.passwords.hash(password),
                    "display_name": str(display_name or "").strip()[:100],
                    "role": role,
                }
            )
        except Exception as exc:
            if "UNIQUE" in str(exc).upper():
                raise AccountConflictError("username is already registered") from exc
            raise
        return user, self._new_session(user_id)

    def login(self, username: str, password: str) -> tuple[dict[str, Any], str]:
        normalized = self._username(username)
        record = self.catalog.get_user_by_username(normalized)
        if (
            not record
            or record.get("status") != "active"
            or not self.passwords.verify(password, str(record.get("password_hash", "")))
        ):
            raise AuthenticationError("invalid username or password")
        user = dict(record)
        user.pop("password_hash", None)
        return user, self._new_session(str(record["id"]))

    def authenticate(self, token: str | None) -> dict[str, Any] | None:
        if not token:
            return None
        return self.catalog.user_for_token(self._token_hash(token))

    def logout(self, token: str | None) -> None:
        if token:
            self.catalog.delete_auth_session(self._token_hash(token))

    def change_password(
        self, user_id: str, current_password: str, new_password: str
    ) -> str:
        record = self.catalog.get_user(user_id, include_password=True)
        if not record or not self.passwords.verify(
            current_password, str(record.get("password_hash", ""))
        ):
            raise AuthenticationError("current password is incorrect")
        self.catalog.update_password(user_id, self.passwords.hash(new_password))
        return self._new_session(user_id)

    def _new_session(self, user_id: str) -> str:
        token = secrets.token_urlsafe(32)
        expires = datetime.now(timezone.utc) + timedelta(days=self.session_days)
        self.catalog.create_auth_session(
            f"auth_{uuid4().hex}", user_id, self._token_hash(token), expires.isoformat()
        )
        return token

    @classmethod
    def _username(cls, value: str) -> str:
        username = str(value or "").strip()
        if not cls.username_pattern.fullmatch(username):
            raise ValueError(
                "username must be 3-64 characters using letters, numbers, '.', '_' or '-'"
            )
        return username

    @staticmethod
    def _token_hash(token: str) -> str:
        return hashlib.sha256(token.encode("utf-8")).hexdigest()

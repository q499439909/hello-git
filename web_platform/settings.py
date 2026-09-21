"""Filesystem settings for the portable web platform."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


def _agent_root() -> Path:
    return Path(__file__).resolve().parents[2]


@dataclass(frozen=True)
class PlatformSettings:
    """Resolved platform paths.

    The database stores relative storage keys, so ``home`` can change when an
    installation is copied to another machine.
    """

    home: Path
    database_path: Path
    static_dir: Path
    max_inline_json_bytes: int = 10 * 1024 * 1024
    preview_row_limit: int = 200
    auth_cookie_name: str = "dj_session"
    auth_session_days: int = 14
    auth_cookie_secure: bool = False

    @classmethod
    def load(cls, home: str | Path | None = None) -> "PlatformSettings":
        root = _agent_root()
        resolved_home = (
            Path(home or os.environ.get("DJ_PLATFORM_HOME") or root / "platform")
            .expanduser()
            .resolve()
        )
        static_override = os.environ.get("DJ_WEB_STATIC_DIR")
        static_dir = (
            Path(static_override).expanduser().resolve()
            if static_override
            else Path(__file__).resolve().parent / "static"
        )
        return cls(
            home=resolved_home,
            database_path=resolved_home / "platform.db",
            static_dir=static_dir,
            auth_cookie_name=os.environ.get("DJ_AUTH_COOKIE_NAME", "dj_session"),
            auth_session_days=max(int(os.environ.get("DJ_AUTH_SESSION_DAYS", "14")), 1),
            auth_cookie_secure=os.environ.get("DJ_AUTH_COOKIE_SECURE", "").lower()
            in {"1", "true", "yes", "on"},
        )

    def ensure_directories(self) -> None:
        self.home.mkdir(parents=True, exist_ok=True)
        for name in ("users", "backups"):
            (self.home / name).mkdir(parents=True, exist_ok=True)

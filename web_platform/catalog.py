"""SQLite catalog for accounts, conversations, runs, and artifacts."""

from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

LOCAL_USER_ID = "local"
LEGACY_USER_ID = "legacy"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL, display_name TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL DEFAULT 'user', status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_sessions (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE, expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id);
CREATE TABLE IF NOT EXISTS agent_sessions (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    app_id TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active', state_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_user_updated
    ON agent_sessions(user_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS chat_messages (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
    sequence INTEGER NOT NULL, role TEXT NOT NULL,
    message_type TEXT NOT NULL DEFAULT 'text', content_json TEXT NOT NULL,
    created_at TEXT NOT NULL, UNIQUE(session_id, sequence)
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_user_session_sequence
    ON chat_messages(user_id, session_id, sequence);
CREATE TABLE IF NOT EXISTS project_bindings (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, app_id TEXT NOT NULL,
    project_name TEXT NOT NULL DEFAULT '', settings_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(user_id, app_id)
);
CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL DEFAULT '', app_id TEXT NOT NULL, status TEXT NOT NULL,
    stage TEXT NOT NULL DEFAULT '', progress REAL NOT NULL DEFAULT 0,
    staging_key TEXT NOT NULL, output_key TEXT, error_message TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    FOREIGN KEY(user_id, app_id) REFERENCES project_bindings(user_id, app_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_runs_user_app_created ON runs(user_id, app_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_user_session_created ON runs(user_id, session_id, created_at DESC);
CREATE TABLE IF NOT EXISTS artifacts (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    app_id TEXT NOT NULL, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    name TEXT NOT NULL, kind TEXT NOT NULL, role TEXT NOT NULL, format TEXT NOT NULL,
    mime_type TEXT NOT NULL, storage_key TEXT NOT NULL UNIQUE, byte_size INTEGER NOT NULL,
    status TEXT NOT NULL, metadata_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_artifacts_user_app_created
    ON artifacts(user_id, app_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_artifacts_user_run ON artifacts(user_id, run_id);
"""


class Catalog:
    """Own all durable platform metadata behind one SQLite interface."""

    def __init__(self, path: Path) -> None:
        self.path = path

    def initialize(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._migrate_legacy_catalog()
        with self.connection() as conn:
            conn.executescript(SCHEMA)
            self._insert_system_user(conn, LOCAL_USER_ID, "Local user", "active")
            self._insert_system_user(conn, LEGACY_USER_ID, "Legacy data", "disabled")

    def _migrate_legacy_catalog(self) -> None:
        if not self.path.exists():
            return
        conn = sqlite3.connect(self.path, timeout=5)
        try:
            table = conn.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='project_bindings'"
            ).fetchone()
            if not table:
                return
            columns = {
                row[1] for row in conn.execute("PRAGMA table_info(project_bindings)")
            }
            if "user_id" in columns:
                return
            conn.execute("PRAGMA foreign_keys=OFF")
            conn.executescript(
                """
                ALTER TABLE artifacts RENAME TO artifacts_legacy;
                ALTER TABLE runs RENAME TO runs_legacy;
                ALTER TABLE project_bindings RENAME TO project_bindings_legacy;
            """
            )
            conn.executescript(SCHEMA)
            self._insert_system_user(conn, LEGACY_USER_ID, "Legacy data", "disabled")
            conn.execute(
                """
                INSERT INTO project_bindings(user_id, app_id, project_name, settings_json, created_at, updated_at)
                SELECT ?, app_id, project_name, settings_json, created_at, updated_at
                FROM project_bindings_legacy
            """,
                (LEGACY_USER_ID,),
            )
            conn.execute(
                """
                INSERT INTO runs(id, user_id, session_id, app_id, status, stage, progress,
                    staging_key, output_key, error_message, created_at, updated_at)
                SELECT id, ?, '', app_id, status, stage, progress, staging_key,
                    output_key, error_message, created_at, updated_at FROM runs_legacy
            """,
                (LEGACY_USER_ID,),
            )
            conn.execute(
                """
                INSERT INTO artifacts(id, user_id, app_id, run_id, name, kind, role, format,
                    mime_type, storage_key, byte_size, status, metadata_json, created_at)
                SELECT id, ?, app_id, run_id, name, kind, role, format, mime_type,
                    storage_key, byte_size, status, metadata_json, created_at
                FROM artifacts_legacy
            """,
                (LEGACY_USER_ID,),
            )
            conn.executescript(
                """
                DROP TABLE artifacts_legacy;
                DROP TABLE runs_legacy;
                DROP TABLE project_bindings_legacy;
            """
            )
            conn.commit()
        finally:
            conn.close()

    @staticmethod
    def _insert_system_user(
        conn: sqlite3.Connection, user_id: str, display_name: str, status: str
    ) -> None:
        now = utc_now()
        conn.execute(
            """
            INSERT OR IGNORE INTO users(id, username, password_hash, display_name,
                role, status, created_at, updated_at)
            VALUES (?, ?, '!', ?, 'system', ?, ?, ?)
        """,
            (user_id, f"__{user_id}__", display_name, status, now, now),
        )

    @contextmanager
    def connection(self) -> Iterator[sqlite3.Connection]:
        conn = sqlite3.connect(self.path, timeout=5)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys=ON")
        conn.execute("PRAGMA busy_timeout=5000")
        try:
            yield conn
            conn.commit()
        finally:
            conn.close()

    def initialize_wal(self) -> None:
        with self.connection() as conn:
            conn.execute("PRAGMA journal_mode=WAL")

    # Accounts -----------------------------------------------------------------
    def create_user(self, payload: dict[str, Any]) -> dict[str, Any]:
        now = utc_now()
        with self.connection() as conn:
            conn.execute(
                """
                INSERT INTO users(id, username, password_hash, display_name, role,
                    status, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
            """,
                (
                    payload["id"],
                    payload["username"],
                    payload["password_hash"],
                    payload.get("display_name", ""),
                    payload.get("role", "user"),
                    now,
                    now,
                ),
            )
            row = conn.execute(
                "SELECT * FROM users WHERE id=?", (payload["id"],)
            ).fetchone()
        return self._user_row(row)

    def get_user(
        self, user_id: str, *, include_password: bool = False
    ) -> dict[str, Any] | None:
        with self.connection() as conn:
            row = conn.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()
        if not row:
            return None
        return dict(row) if include_password else self._user_row(row)

    def get_user_by_username(self, username: str) -> dict[str, Any] | None:
        with self.connection() as conn:
            row = conn.execute(
                "SELECT * FROM users WHERE username=? COLLATE NOCASE", (username,)
            ).fetchone()
        return dict(row) if row else None

    def list_users(self) -> list[dict[str, Any]]:
        with self.connection() as conn:
            rows = conn.execute(
                "SELECT * FROM users WHERE role <> 'system' ORDER BY created_at"
            ).fetchall()
        return [self._user_row(row) for row in rows]

    def update_user_status(self, user_id: str, status: str) -> dict[str, Any] | None:
        with self.connection() as conn:
            conn.execute(
                "UPDATE users SET status=?, updated_at=? WHERE id=? AND role <> 'system'",
                (status, utc_now(), user_id),
            )
            row = conn.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()
            if status != "active":
                conn.execute("DELETE FROM auth_sessions WHERE user_id=?", (user_id,))
        return self._user_row(row) if row else None

    def update_password(self, user_id: str, password_hash: str) -> None:
        with self.connection() as conn:
            conn.execute(
                "UPDATE users SET password_hash=?, updated_at=? WHERE id=?",
                (password_hash, utc_now(), user_id),
            )
            conn.execute("DELETE FROM auth_sessions WHERE user_id=?", (user_id,))

    def create_auth_session(
        self, session_id: str, user_id: str, token_hash: str, expires_at: str
    ) -> None:
        now = utc_now()
        with self.connection() as conn:
            conn.execute(
                """
                INSERT INTO auth_sessions(id, user_id, token_hash, expires_at, created_at, last_seen_at)
                VALUES (?, ?, ?, ?, ?, ?)
            """,
                (session_id, user_id, token_hash, expires_at, now, now),
            )

    def user_for_token(self, token_hash: str) -> dict[str, Any] | None:
        now = utc_now()
        with self.connection() as conn:
            row = conn.execute(
                """
                SELECT u.* FROM auth_sessions s JOIN users u ON u.id=s.user_id
                WHERE s.token_hash=? AND s.expires_at>? AND u.status='active'
            """,
                (token_hash, now),
            ).fetchone()
            if row:
                conn.execute(
                    "UPDATE auth_sessions SET last_seen_at=? WHERE token_hash=?",
                    (now, token_hash),
                )
        return self._user_row(row) if row else None

    def delete_auth_session(self, token_hash: str) -> None:
        with self.connection() as conn:
            conn.execute("DELETE FROM auth_sessions WHERE token_hash=?", (token_hash,))

    # Conversations ------------------------------------------------------------
    def create_agent_session(
        self, session_id: str, user_id: str, app_id: str, model: str, title: str = ""
    ) -> dict[str, Any]:
        now = utc_now()
        with self.connection() as conn:
            conn.execute(
                """
                INSERT INTO agent_sessions(id, user_id, app_id, title, model, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
                (session_id, user_id, app_id, title, model, now, now),
            )
            row = conn.execute(
                "SELECT * FROM agent_sessions WHERE id=? AND user_id=?",
                (session_id, user_id),
            ).fetchone()
        return self._agent_session_row(row)

    def get_agent_session(self, user_id: str, session_id: str) -> dict[str, Any] | None:
        with self.connection() as conn:
            row = conn.execute(
                "SELECT * FROM agent_sessions WHERE id=? AND user_id=?",
                (session_id, user_id),
            ).fetchone()
        return self._agent_session_row(row) if row else None

    def list_agent_sessions(self, user_id: str) -> list[dict[str, Any]]:
        with self.connection() as conn:
            rows = conn.execute(
                """
                SELECT * FROM agent_sessions WHERE user_id=? AND status <> 'deleted'
                ORDER BY updated_at DESC
            """,
                (user_id,),
            ).fetchall()
        return [self._agent_session_row(row) for row in rows]

    def update_agent_session(
        self,
        user_id: str,
        session_id: str,
        *,
        model: str | None = None,
        title: str | None = None,
        state: dict[str, Any] | None = None,
    ) -> None:
        assignments, values = ["updated_at=?"], [utc_now()]
        for column, value in (("model", model), ("title", title)):
            if value is not None:
                assignments.append(f"{column}=?")
                values.append(value)
        if state is not None:
            assignments.append("state_json=?")
            values.append(json.dumps(state, ensure_ascii=False, default=str))
        values.extend((session_id, user_id))
        with self.connection() as conn:
            conn.execute(
                f"UPDATE agent_sessions SET {', '.join(assignments)} WHERE id=? AND user_id=?",
                values,
            )

    def append_message(
        self,
        user_id: str,
        session_id: str,
        message_id: str,
        role: str,
        content: Any,
        message_type: str = "text",
    ) -> dict[str, Any]:
        with self.connection() as conn:
            sequence = int(
                conn.execute(
                    "SELECT COALESCE(MAX(sequence), 0) + 1 FROM chat_messages WHERE session_id=?",
                    (session_id,),
                ).fetchone()[0]
            )
            now = utc_now()
            conn.execute(
                """
                INSERT INTO chat_messages(id, user_id, session_id, sequence, role,
                    message_type, content_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
                (
                    message_id,
                    user_id,
                    session_id,
                    sequence,
                    role,
                    message_type,
                    json.dumps(content, ensure_ascii=False, default=str),
                    now,
                ),
            )
            conn.execute(
                "UPDATE agent_sessions SET updated_at=? WHERE id=? AND user_id=?",
                (now, session_id, user_id),
            )
            row = conn.execute(
                "SELECT * FROM chat_messages WHERE id=?", (message_id,)
            ).fetchone()
        return self._message_row(row)

    def list_messages(self, user_id: str, session_id: str) -> list[dict[str, Any]]:
        with self.connection() as conn:
            rows = conn.execute(
                """
                SELECT m.* FROM chat_messages m
                JOIN agent_sessions s ON s.id=m.session_id AND s.user_id=m.user_id
                WHERE m.user_id=? AND m.session_id=? ORDER BY m.sequence
            """,
                (user_id, session_id),
            ).fetchall()
        return [self._message_row(row) for row in rows]

    # Projects, runs, and artifacts --------------------------------------------
    def ensure_project(
        self, app_id: str, project_name: str = "", *, user_id: str = LOCAL_USER_ID
    ) -> dict[str, Any]:
        now = utc_now()
        with self.connection() as conn:
            conn.execute(
                """
                INSERT INTO project_bindings(user_id, app_id, project_name, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(user_id, app_id) DO UPDATE SET
                    project_name=CASE WHEN excluded.project_name <> '' THEN excluded.project_name ELSE project_name END,
                    updated_at=excluded.updated_at
            """,
                (user_id, app_id, project_name, now, now),
            )
            row = conn.execute(
                "SELECT * FROM project_bindings WHERE user_id=? AND app_id=?",
                (user_id, app_id),
            ).fetchone()
        return self._row(row)

    def create_run(
        self,
        run_id: str,
        app_id: str,
        staging_key: str,
        *,
        user_id: str = LOCAL_USER_ID,
        session_id: str = "",
    ) -> dict[str, Any]:
        now = utc_now()
        with self.connection() as conn:
            conn.execute(
                """
                INSERT INTO runs(id, user_id, session_id, app_id, status, stage,
                    progress, staging_key, created_at, updated_at)
                VALUES (?, ?, ?, ?, 'running', 'preparing', 0, ?, ?, ?)
            """,
                (run_id, user_id, session_id, app_id, staging_key, now, now),
            )
            row = conn.execute(
                "SELECT * FROM runs WHERE id=? AND user_id=?", (run_id, user_id)
            ).fetchone()
        return self._row(row)

    def get_run(
        self, run_id: str, *, user_id: str = LOCAL_USER_ID
    ) -> dict[str, Any] | None:
        with self.connection() as conn:
            row = conn.execute(
                "SELECT * FROM runs WHERE id=? AND user_id=?", (run_id, user_id)
            ).fetchone()
        return self._row(row) if row else None

    def finish_run(
        self, run_id: str, output_key: str, *, user_id: str = LOCAL_USER_ID
    ) -> None:
        with self.connection() as conn:
            conn.execute(
                """
                UPDATE runs SET status='succeeded', stage='completed', progress=1,
                    output_key=?, updated_at=? WHERE id=? AND user_id=?
            """,
                (output_key, utc_now(), run_id, user_id),
            )

    def fail_run(
        self, run_id: str, message: str, *, user_id: str = LOCAL_USER_ID
    ) -> None:
        with self.connection() as conn:
            conn.execute(
                """
                UPDATE runs SET status='failed', stage='failed', error_message=?,
                    updated_at=? WHERE id=? AND user_id=?
            """,
                (message, utc_now(), run_id, user_id),
            )

    def add_artifact(self, payload: dict[str, Any]) -> None:
        with self.connection() as conn:
            conn.execute(
                """
                INSERT INTO artifacts(id, user_id, app_id, run_id, name, kind, role,
                    format, mime_type, storage_key, byte_size, status, metadata_json, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
                (
                    payload["id"],
                    payload.get("user_id", LOCAL_USER_ID),
                    payload["app_id"],
                    payload["run_id"],
                    payload["name"],
                    payload["kind"],
                    payload["role"],
                    payload["format"],
                    payload["mime_type"],
                    payload["storage_key"],
                    payload["byte_size"],
                    payload.get("status", "ready"),
                    json.dumps(payload.get("metadata", {}), ensure_ascii=False),
                    utc_now(),
                ),
            )

    def list_artifacts(
        self, app_id: str, limit: int = 200, *, user_id: str = LOCAL_USER_ID
    ) -> list[dict[str, Any]]:
        with self.connection() as conn:
            rows = conn.execute(
                """
                SELECT * FROM artifacts WHERE user_id=? AND app_id=? AND status='ready'
                ORDER BY created_at DESC LIMIT ?
            """,
                (user_id, app_id, max(1, min(limit, 500))),
            ).fetchall()
        return [self._artifact_row(row) for row in rows]

    def get_artifact(
        self, artifact_id: str, *, user_id: str = LOCAL_USER_ID
    ) -> dict[str, Any] | None:
        with self.connection() as conn:
            row = conn.execute(
                "SELECT * FROM artifacts WHERE id=? AND user_id=? AND status='ready'",
                (artifact_id, user_id),
            ).fetchone()
        return self._artifact_row(row) if row else None

    def delete_artifact(self, artifact_id: str, *, user_id: str) -> bool:
        with self.connection() as conn:
            cursor = conn.execute(
                "UPDATE artifacts SET status='deleted' WHERE id=? AND user_id=? AND status='ready'",
                (artifact_id, user_id),
            )
        return bool(cursor.rowcount)

    @staticmethod
    def _row(row: sqlite3.Row) -> dict[str, Any]:
        return dict(row)

    @staticmethod
    def _user_row(row: sqlite3.Row) -> dict[str, Any]:
        result = dict(row)
        result.pop("password_hash", None)
        return result

    @staticmethod
    def _agent_session_row(row: sqlite3.Row) -> dict[str, Any]:
        result = dict(row)
        try:
            result["state"] = json.loads(result.pop("state_json"))
        except (TypeError, json.JSONDecodeError):
            result["state"] = {}
            result.pop("state_json", None)
        return result

    @staticmethod
    def _message_row(row: sqlite3.Row) -> dict[str, Any]:
        result = dict(row)
        try:
            result["content"] = json.loads(result.pop("content_json"))
        except (TypeError, json.JSONDecodeError):
            result["content"] = ""
            result.pop("content_json", None)
        return result

    @staticmethod
    def _artifact_row(row: sqlite3.Row) -> dict[str, Any]:
        result = dict(row)
        try:
            result["metadata"] = json.loads(result.pop("metadata_json"))
        except (TypeError, json.JSONDecodeError):
            result["metadata"] = {}
            result.pop("metadata_json", None)
        return result

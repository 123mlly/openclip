"""SQLite-backed per-session user preferences for the React web UI."""

from __future__ import annotations

import json
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping, Optional

from core.config import REPO_ROOT

DEFAULT_DB_PATH = REPO_ROOT / "data" / "openclip.db"

_lock = threading.Lock()


def _utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


class UserPreferencesStore:
    def __init__(self, db_path: Path | str | None = None) -> None:
        self.db_path = Path(db_path) if db_path else DEFAULT_DB_PATH
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._ensure_schema()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self.db_path), check_same_thread=False)
        conn.row_factory = sqlite3.Row
        return conn

    def _ensure_schema(self) -> None:
        with _lock:
            with self._connect() as conn:
                conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS user_preferences (
                        session_id TEXT PRIMARY KEY,
                        version INTEGER NOT NULL,
                        prefs_json TEXT NOT NULL,
                        updated_at TEXT NOT NULL
                    )
                    """
                )
                conn.commit()

    def get(self, session_id: str) -> Optional[dict[str, Any]]:
        session_id = (session_id or "").strip()
        if not session_id:
            return None
        with _lock:
            with self._connect() as conn:
                row = conn.execute(
                    "SELECT version, prefs_json, updated_at FROM user_preferences WHERE session_id = ?",
                    (session_id,),
                ).fetchone()
        if row is None:
            return None
        try:
            prefs = json.loads(row["prefs_json"])
        except json.JSONDecodeError:
            return None
        if not isinstance(prefs, dict):
            return None
        return {
            "session_id": session_id,
            "version": int(row["version"]),
            "prefs": prefs,
            "updated_at": row["updated_at"],
        }

    def put(self, session_id: str, version: int, prefs: Mapping[str, Any]) -> dict[str, Any]:
        session_id = (session_id or "").strip()
        if not session_id:
            raise ValueError("session_id is required")
        if not isinstance(prefs, Mapping):
            raise ValueError("prefs must be an object")
        payload = dict(prefs)
        updated_at = _utc_now()
        prefs_json = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        with _lock:
            with self._connect() as conn:
                conn.execute(
                    """
                    INSERT INTO user_preferences (session_id, version, prefs_json, updated_at)
                    VALUES (?, ?, ?, ?)
                    ON CONFLICT(session_id) DO UPDATE SET
                        version = excluded.version,
                        prefs_json = excluded.prefs_json,
                        updated_at = excluded.updated_at
                    """,
                    (session_id, int(version), prefs_json, updated_at),
                )
                conn.commit()
        return {
            "session_id": session_id,
            "version": int(version),
            "prefs": payload,
            "updated_at": updated_at,
        }

    def delete(self, session_id: str) -> bool:
        session_id = (session_id or "").strip()
        if not session_id:
            return False
        with _lock:
            with self._connect() as conn:
                cursor = conn.execute(
                    "DELETE FROM user_preferences WHERE session_id = ?",
                    (session_id,),
                )
                conn.commit()
                return cursor.rowcount > 0


_default_store: UserPreferencesStore | None = None


def get_preferences_store(db_path: Path | str | None = None) -> UserPreferencesStore:
    global _default_store
    if db_path is not None:
        return UserPreferencesStore(db_path)
    if _default_store is None:
        _default_store = UserPreferencesStore()
    return _default_store

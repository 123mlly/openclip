"""Tests for SQLite-backed user preferences store and web API endpoints."""

from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from core.browser_preferences import PREFERENCES_SCHEMA_VERSION, build_preferences_payload
from core.user_preferences_store import UserPreferencesStore
from web_api import build_preferences_defaults, create_app


def test_user_preferences_store_round_trip(tmp_path: Path):
    store = UserPreferencesStore(tmp_path / "prefs.db")
    saved = store.put("sess-1", PREFERENCES_SCHEMA_VERSION, {"language": "en", "max_clips": 3})
    assert saved["session_id"] == "sess-1"
    assert saved["prefs"]["language"] == "en"

    loaded = store.get("sess-1")
    assert loaded is not None
    assert loaded["prefs"]["max_clips"] == 3
    assert loaded["updated_at"]

    assert store.delete("sess-1") is True
    assert store.get("sess-1") is None


def test_preferences_api_get_put_round_trip(tmp_path: Path, monkeypatch):
    db_path = tmp_path / "openclip.db"
    store = UserPreferencesStore(db_path)
    monkeypatch.setattr("web_api.get_preferences_store", lambda: store)

    client = TestClient(create_app())
    headers = {"X-OpenClip-Session": "test-session-prefs"}

    empty = client.get("/api/preferences", headers=headers)
    assert empty.status_code == 200
    body = empty.json()
    assert body["session_id"] == "test-session-prefs"
    assert body["prefs"]["language"] == "zh"
    assert body["updated_at"] is None

    defaults = build_preferences_defaults()
    defaults["language"] = "en"
    defaults["max_clips"] = 7
    defaults["llm_provider"] = "qwen"
    defaults["llm_provider_settings"]["qwen"] = {
        "model": "qwen3.7-plus",
        "base_url": "https://example.com/v1/chat/completions",
    }
    defaults["burn_subtitles"] = True
    defaults["output_dir"] = "my_output"
    payload = build_preferences_payload(defaults)

    saved = client.put("/api/preferences", headers=headers, json={"prefs": payload["prefs"]})
    assert saved.status_code == 200
    saved_body = saved.json()
    assert saved_body["prefs"]["language"] == "en"
    assert saved_body["prefs"]["max_clips"] == 7
    assert saved_body["prefs"]["output_dir"] == "my_output"
    assert saved_body["prefs"]["llm_provider_settings"]["qwen"]["model"] == "qwen3.7-plus"
    assert "api_key" not in saved_body["prefs"]

    loaded = client.get("/api/preferences", headers=headers)
    assert loaded.status_code == 200
    loaded_body = loaded.json()
    assert loaded_body["prefs"]["language"] == "en"
    assert loaded_body["prefs"]["burn_subtitles"] is True
    assert loaded_body["updated_at"]

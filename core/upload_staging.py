from __future__ import annotations

import json
import shutil
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping, MutableMapping

from core.file_string_utils import FileStringUtils
from core.video_utils import VideoFileValidator

OWNER_SESSION_QUERY_PARAM = "oc_session"
SOURCE_KIND_URL = "url"
SOURCE_KIND_SERVER_PATH = "server_path"
SOURCE_KIND_UPLOADED_FILE = "uploaded_file"
UPLOAD_METADATA_FILENAME = "upload.json"


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _query_param_value(query_params: Mapping[str, Any], key: str) -> str | None:
    value = query_params.get(key)
    if isinstance(value, list):
        return str(value[0]).strip() if value else None
    if value is None:
        return None
    value = str(value).strip()
    return value or None


def ensure_owner_session_id(
    query_params: MutableMapping[str, Any],
    session_state: MutableMapping[str, Any],
    *,
    key: str = OWNER_SESSION_QUERY_PARAM,
) -> str:
    owner_session_id = str(session_state.get(key, "")).strip() or _query_param_value(query_params, key)
    if not owner_session_id:
        owner_session_id = uuid.uuid4().hex
    session_state[key] = owner_session_id
    query_params[key] = owner_session_id
    return owner_session_id


def uploads_root_for_output_dir(output_dir: str | Path) -> Path:
    return Path(output_dir) / "_uploads"


def owner_upload_root(uploads_root: str | Path, owner_session_id: str) -> Path:
    return Path(uploads_root) / owner_session_id


def sanitize_uploaded_filename(filename: str) -> str:
    path = Path(filename or "upload.mp4")
    suffix = path.suffix.lower()
    if suffix not in VideoFileValidator.VIDEO_EXTENSIONS:
        raise ValueError(f"Unsupported upload file type: {suffix or '(missing extension)'}")
    stem = FileStringUtils.sanitize_filename(path.stem) or "upload"
    return f"{stem}{suffix}"


def sanitize_cookies_filename(filename: str) -> str:
    path = Path(filename or "cookies.txt")
    suffix = path.suffix.lower() or ".txt"
    if suffix not in {".txt", ".cookies"}:
        raise ValueError("Cookies file must be a .txt or .cookies Netscape cookie export")
    stem = FileStringUtils.sanitize_filename(path.stem) or "cookies"
    return f"{stem}{suffix}"


def _write_uploaded_bytes(uploaded_file: Any, staged_path: Path) -> int:
    sync_file = getattr(uploaded_file, "file", None)
    if sync_file is not None and hasattr(sync_file, "read"):
        sync_file.seek(0)
        with staged_path.open("wb") as staged_file:
            shutil.copyfileobj(sync_file, staged_file, length=1024 * 1024)
        return int(getattr(uploaded_file, "size", None) or staged_path.stat().st_size)
    if hasattr(uploaded_file, "getvalue"):
        upload_bytes = uploaded_file.getvalue()
        staged_path.write_bytes(upload_bytes)
        return len(upload_bytes)
    if hasattr(uploaded_file, "read") and hasattr(uploaded_file, "seek"):
        uploaded_file.seek(0)
        with staged_path.open("wb") as staged_file:
            shutil.copyfileobj(uploaded_file, staged_file, length=1024 * 1024)
        return int(getattr(uploaded_file, "size", staged_path.stat().st_size))
    raise TypeError(f"Unsupported upload object type: {type(uploaded_file)!r}")


def stage_uploaded_file(uploaded_file: Any, uploads_root: str | Path, owner_session_id: str) -> dict[str, Any]:
    original_name = (
        getattr(uploaded_file, "filename", None)
        or getattr(uploaded_file, "name", None)
        or "upload.mp4"
    )
    sanitized_name = sanitize_uploaded_filename(str(original_name))
    upload_id = uuid.uuid4().hex
    upload_dir = owner_upload_root(uploads_root, owner_session_id) / upload_id
    upload_dir.mkdir(parents=True, exist_ok=True)

    staged_path = upload_dir / sanitized_name
    size_bytes = _write_uploaded_bytes(uploaded_file, staged_path)

    metadata = {
        "upload_id": upload_id,
        "owner_session_id": owner_session_id,
        "original_filename": str(original_name),
        "stored_filename": sanitized_name,
        "staged_path": str(staged_path.resolve()),
        "created_at": utc_now_iso(),
        "deleted_at": None,
        "size_bytes": size_bytes,
        "source_kind": SOURCE_KIND_UPLOADED_FILE,
    }
    metadata_path_for_upload_dir(upload_dir).write_text(json.dumps(metadata, indent=2), encoding="utf-8")
    return metadata


def stage_cookies_file(uploaded_file: Any, uploads_root: str | Path, owner_session_id: str) -> dict[str, Any]:
    """Stage a Netscape cookies.txt export for yt-dlp / downloader auth."""
    original_name = (
        getattr(uploaded_file, "filename", None)
        or getattr(uploaded_file, "name", None)
        or "cookies.txt"
    )
    sanitized_name = sanitize_cookies_filename(str(original_name))
    upload_id = uuid.uuid4().hex
    upload_dir = owner_upload_root(uploads_root, owner_session_id) / "_cookies" / upload_id
    upload_dir.mkdir(parents=True, exist_ok=True)

    staged_path = upload_dir / sanitized_name
    size_bytes = _write_uploaded_bytes(uploaded_file, staged_path)
    if size_bytes <= 0:
        staged_path.unlink(missing_ok=True)
        raise ValueError("Cookies file is empty")

    # Light sanity check: Netscape cookie files are text and usually contain tab-separated rows
    # or the "# Netscape HTTP Cookie File" header. Reject obvious binary uploads early.
    sample = staged_path.read_bytes()[:2048]
    if b"\x00" in sample:
        staged_path.unlink(missing_ok=True)
        raise ValueError("Cookies file looks binary; upload a Netscape cookies.txt export")

    return {
        "upload_id": upload_id,
        "owner_session_id": owner_session_id,
        "original_filename": str(original_name),
        "stored_filename": sanitized_name,
        "staged_path": str(staged_path.resolve()),
        "created_at": utc_now_iso(),
        "size_bytes": size_bytes,
        "kind": "cookies",
    }

def metadata_path_for_upload_dir(upload_dir: str | Path) -> Path:
    return Path(upload_dir) / UPLOAD_METADATA_FILENAME


def load_upload_metadata(path: str | Path) -> dict[str, Any]:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def list_uploads_for_owner(uploads_root: str | Path, owner_session_id: str) -> list[dict[str, Any]]:
    owner_root = owner_upload_root(uploads_root, owner_session_id)
    if not owner_root.exists():
        return []

    uploads: list[dict[str, Any]] = []
    for metadata_path in owner_root.glob(f"*/{UPLOAD_METADATA_FILENAME}"):
        try:
            payload = load_upload_metadata(metadata_path)
        except Exception:
            continue
        staged_path = Path(payload.get("staged_path") or "")
        payload["exists"] = staged_path.exists()
        uploads.append(payload)

    uploads.sort(key=lambda item: item.get("created_at") or "", reverse=True)
    return uploads


def delete_upload_record(metadata: Mapping[str, Any]) -> None:
    staged_path = Path(str(metadata.get("staged_path") or ""))
    upload_dir = staged_path.parent
    if upload_dir.exists():
        shutil.rmtree(upload_dir)


def upload_record_matches_owner(payload: Mapping[str, Any], owner_session_id: str) -> bool:
    return str(payload.get("owner_session_id") or "") == owner_session_id

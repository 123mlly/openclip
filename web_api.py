#!/usr/bin/env python3
"""FastAPI backend for the OpenClip React web UI."""

from __future__ import annotations

import argparse
import asyncio
import os
import re
import tempfile
import uuid
from pathlib import Path
from typing import Any, Optional
from urllib.parse import quote

import uvicorn
from fastapi import FastAPI, File, Header, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from core.browser_preferences import (
    PREFERENCES_SCHEMA_VERSION,
    build_preferences_payload,
    merge_browser_preferences,
)
from core.browser_session import INPUT_TYPE_SERVER_PATH, INPUT_TYPE_UPLOAD, INPUT_TYPE_URL
from core.clip_duration import CLIP_DURATION_PRESETS, DEFAULT_CLIP_LENGTH_PRESET
from core.config import (
    API_KEY_ENV_VARS,
    DEFAULT_LLM_PROVIDER,
    DEFAULT_TITLE_STYLE,
    LLM_CONFIG,
    MAX_CLIPS,
    MAX_DURATION_MINUTES,
    SUPPORTED_LLM_PROVIDERS,
    WHISPER_MODEL,
)
from core.downloaders.bilibili_downloader import ImprovedBilibiliDownloader
from core.editor.service import EditorService, register_editor_api_routes
from core.file_string_utils import FileStringUtils
from core.subtitle_burner import SubtitleBurner, SubtitleStyleConfig
from core.transcript_generation_whisperx import WHISPERX_AVAILABLE
from core.upload_staging import (
    SOURCE_KIND_SERVER_PATH,
    SOURCE_KIND_UPLOADED_FILE,
    SOURCE_KIND_URL,
    delete_upload_record,
    list_uploads_for_owner,
    load_upload_metadata,
    owner_upload_root,
    stage_cookies_file,
    stage_uploaded_file,
    upload_record_matches_owner,
    uploads_root_for_output_dir,
)
from core.user_preferences_store import get_preferences_store
from core.video_utils import VideoFileValidator
from job_manager import get_job_manager
from video_orchestrator import VideoOrchestrator

SESSION_HEADER = "X-OpenClip-Session"
DIST_DIR = Path(__file__).resolve().parent / "web_frontend" / "dist"


def is_bilibili_url(url: str) -> bool:
    if not url:
        return False
    patterns = [
        r"https?://(?:www\.)?bilibili\.com/video/[Bb][Vv][0-9A-Za-z]+",
        r"https?://(?:www\.)?bilibili\.com/bangumi/",
        r"https?://(?:www\.)?b23\.tv/",
        r"https?://(?:m\.)?bilibili\.com/video/",
    ]
    return any(re.match(pattern, url) for pattern in patterns)


def process_video_worker(job, progress_callback):
    options = job.options
    orchestrator = VideoOrchestrator(
        output_dir=options["output_dir"],
        max_duration_minutes=options["max_duration_minutes"],
        whisper_model=options["whisper_model"],
        browser=options.get("browser"),
        cookies=options.get("cookies_file") or None,
        api_key=options["api_key"],
        llm_provider=options["llm_provider"],
        llm_model=options.get("llm_model"),
        llm_base_url=options.get("llm_base_url"),
        skip_analysis=False,
        generate_clips=options["generate_clips"],
        add_titles=options["add_titles"],
        title_style=options["title_style"],
        use_background=options["use_background"],
        generate_cover=options["generate_cover"],
        language=options["language"],
        debug=False,
        custom_prompt_file=options.get("custom_prompt_file"),
        max_clips=options["max_clips"],
        clip_length_preset=options.get("clip_length_preset", DEFAULT_CLIP_LENGTH_PRESET),
        enable_diarization=bool(options.get("speaker_references_dir")),
        speaker_references_dir=options.get("speaker_references_dir"),
        burn_subtitles=options.get("burn_subtitles", False),
        subtitle_translation=options.get("subtitle_translation") or None,
        subtitle_style_preset=options.get("subtitle_style_preset", "default"),
        subtitle_style_font_size=options.get("subtitle_style_font_size", "medium"),
        subtitle_style_vertical_position=options.get("subtitle_style_vertical_position", "bottom"),
        subtitle_style_bilingual_layout="auto",
        subtitle_style_background_style=options.get("subtitle_style_background_style", "none"),
        mode=options.get("mode", "engaging_moments"),
        user_intent=options.get("user_intent") or None,
        agentic_analysis=options.get("agentic_analysis", False),
        normalize_boundaries=options.get("normalize_boundaries", True),
    )

    result = asyncio.run(
        orchestrator.process_video(
            job.video_source,
            force_whisper=options["force_whisper"],
            skip_download=False,
            progress_callback=progress_callback,
        )
    )

    if not result.success:
        raise RuntimeError(getattr(result, "error_message", None) or "Processing failed")

    return {
        "success": result.success,
        "error_message": getattr(result, "error_message", None),
        "processing_time": getattr(result, "processing_time", None),
        "video_info": getattr(result, "video_info", None),
        "transcript_source": getattr(result, "transcript_source", None),
        "engaging_moments_analysis": getattr(result, "engaging_moments_analysis", None),
        "clip_generation": getattr(result, "clip_generation", None),
        "post_processing": getattr(result, "post_processing", None),
        "cover_generation": getattr(result, "cover_generation", None),
        "editor_project": getattr(result, "editor_project", None),
    }


async def get_bilibili_multi_parts(
    url: str,
    browser: Optional[str] = None,
    cookies_file: Optional[str] = None,
) -> list:
    try:
        downloader = ImprovedBilibiliDownloader(browser=browser, cookies=cookies_file)
        return await downloader.get_multi_part_info(url)
    except Exception:
        return []


def resolve_session_id(x_openclip_session: Optional[str]) -> str:
    session_id = (x_openclip_session or "").strip()
    return session_id or uuid.uuid4().hex


def is_editor_rerender_job(job) -> bool:
    return (job.options or {}).get("kind") == "editor_rerender"


class CreateJobRequest(BaseModel):
    input_type: str = INPUT_TYPE_URL
    video_source: str = ""
    upload_id: Optional[str] = None
    output_dir: str = "processed_videos"
    llm_provider: str = DEFAULT_LLM_PROVIDER
    llm_model: Optional[str] = None
    llm_base_url: Optional[str] = None
    api_key: Optional[str] = None
    language: str = "zh"
    max_clips: int = MAX_CLIPS
    clip_length_preset: str = DEFAULT_CLIP_LENGTH_PRESET
    user_intent: Optional[str] = None
    generate_cover: bool = True
    burn_subtitles: bool = False
    agentic_analysis: bool = False
    add_titles: bool = False
    use_background: bool = False
    force_whisper: bool = False
    title_style: str = DEFAULT_TITLE_STYLE
    cookie_mode: str = "none"
    cookie_browser: str = "chrome"
    cookies_file: Optional[str] = None
    speaker_references_dir: Optional[str] = None
    subtitle_translation: Optional[str] = None
    subtitle_style_preset: str = "default"
    subtitle_style_font_size: str = "medium"
    subtitle_style_vertical_position: str = "bottom"
    subtitle_style_background_style: str = "none"
    custom_prompt_text: Optional[str] = None


class EditorLaunchRequest(BaseModel):
    project_id: str
    projects_root: Optional[str] = None


def resolve_projects_root(projects_root: Optional[str], default_projects_root: str) -> str:
    """
    Map host-absolute or relative projects_root values onto this runtime.

    Jobs created on the Mac often store `/Users/.../processed_videos`. Inside
    Docker that path does not exist, so editor launch would 404 as "missing project".
    """
    default = Path(default_projects_root).resolve()
    candidates: list[Path] = []
    if projects_root:
        raw = Path(projects_root)
        candidates.append(raw)
        if not raw.is_absolute():
            candidates.append(Path.cwd() / raw)
        parts = raw.parts
        if "processed_videos" in parts:
            idx = parts.index("processed_videos")
            # projects_root may be the processed_videos dir itself, or a parent path ending there.
            if idx == len(parts) - 1:
                candidates.append(Path.cwd() / "processed_videos")
                candidates.append(default)
            else:
                # Accidentally passed a project folder; use its parent processed_videos root.
                relative = Path(*parts[idx:])
                candidates.append(Path.cwd() / relative)
                candidates.append(default.parent / relative if default.name != "processed_videos" else default)
                candidates.append(default)
    candidates.append(default)

    seen: set[str] = set()
    for candidate in candidates:
        key = str(candidate)
        if key in seen:
            continue
        seen.add(key)
        try:
            resolved = candidate.resolve()
        except OSError:
            continue
        if resolved.exists() and resolved.is_dir():
            return str(resolved)
    return str(default)


class SubtitlePreviewRequest(BaseModel):
    preset: str = "default"
    font_size: str = "medium"
    vertical_position: str = "bottom"
    background_style: str = "none"
    subtitle_translation: Optional[str] = None
    ui_language: str = "zh"


class PreferencesSaveRequest(BaseModel):
    prefs: dict[str, Any]


def build_preferences_defaults() -> dict[str, Any]:
    return {
        "ui_language": "zh",
        "input_type": INPUT_TYPE_URL,
        "llm_provider": DEFAULT_LLM_PROVIDER,
        "llm_provider_settings": {
            provider: {
                "model": (LLM_CONFIG[provider].get("default_model") or "").strip(),
                "base_url": "",
            }
            for provider in SUPPORTED_LLM_PROVIDERS
        },
        "language": "zh",
        "use_background": False,
        "force_whisper": False,
        "generate_clips": True,
        "max_clips": MAX_CLIPS,
        "clip_length_preset": DEFAULT_CLIP_LENGTH_PRESET,
        "add_titles": False,
        "burn_subtitles": False,
        "subtitle_translation": None,
        "subtitle_style_preset": "default",
        "subtitle_style_font_size": "medium",
        "subtitle_style_vertical_position": "bottom",
        "subtitle_style_background_style": "none",
        "generate_cover": True,
        "cookie_mode": "none",
        "cookie_browser": "chrome",
        "mode": "engaging_moments",
        "agentic_analysis": False,
        "output_dir": "processed_videos",
        "user_intent": "",
        "use_custom_prompt": False,
        "custom_prompt_text": "",
        # Excluded placeholders kept for merge_browser_preferences restores
        "api_key": "",
        "video_source": "",
        "cookies_file": "",
        "custom_prompt_file": None,
        "speaker_references_dir": "",
        "processing_result": None,
    }


def create_app() -> FastAPI:
    app = FastAPI(title="OpenClip Web API", version="0.1.0")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    job_manager = get_job_manager()
    editor_services: dict[str, EditorService] = {}
    default_jobs_dir = str((Path.cwd() / "jobs").resolve())
    default_projects_root = str((Path.cwd() / "processed_videos").resolve())

    def get_editor_service(projects_root: Optional[str] = None) -> EditorService:
        root = resolve_projects_root(projects_root, default_projects_root)
        cached = editor_services.get(root)
        if cached is None:
            cached = EditorService(projects_root=root, jobs_dir=default_jobs_dir)
            editor_services[root] = cached
        return cached

    assets_dir = DIST_DIR / "assets"
    if assets_dir.exists():
        app.mount("/assets", StaticFiles(directory=assets_dir), name="assets")

    def serve_spa() -> Response:
        index = DIST_DIR / "index.html"
        if index.exists():
            return FileResponse(
                index,
                headers={"Cache-Control": "no-store, no-cache, must-revalidate"},
            )
        return HTMLResponse(
            "<html><body><h1>OpenClip</h1>"
            "<p>Build the React UI first: <code>cd web_frontend && npm install && npm run build</code></p>"
            "</body></html>"
        )

    @app.get("/healthz")
    def healthz() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/api/config")
    def get_config() -> dict[str, Any]:
        providers = {}
        for provider in SUPPORTED_LLM_PROVIDERS:
            cfg = LLM_CONFIG[provider]
            providers[provider] = {
                "default_model": (cfg.get("default_model") or "").strip(),
                "base_url": (cfg.get("base_url") or "").strip(),
                "api_key_env": API_KEY_ENV_VARS.get(provider, ""),
                "api_key_configured": bool(os.getenv(API_KEY_ENV_VARS.get(provider, ""))),
            }
        return {
            "providers": providers,
            "default_provider": DEFAULT_LLM_PROVIDER,
            "default_title_style": DEFAULT_TITLE_STYLE,
            "max_clips": MAX_CLIPS,
            "clip_length_presets": {
                key: {"preset": key, "label": value.label}
                for key, value in CLIP_DURATION_PRESETS.items()
            },
            "default_clip_length_preset": DEFAULT_CLIP_LENGTH_PRESET,
            "languages": ["zh", "en", "vi"],
            "video_extensions": sorted(ext.lstrip(".") for ext in VideoFileValidator.VIDEO_EXTENSIONS),
            "whisperx_available": WHISPERX_AVAILABLE,
            "input_types": [INPUT_TYPE_URL, INPUT_TYPE_UPLOAD, INPUT_TYPE_SERVER_PATH],
            "subtitle_presets": ["default", "clean", "high_contrast", "stream"],
            "subtitle_sizes": ["small", "medium", "large"],
            "subtitle_positions": ["bottom", "lower_middle", "middle"],
            "subtitle_backgrounds": ["none", "light_box", "solid_box"],
        }

    @app.get("/api/session")
    def create_session(
        x_openclip_session: Optional[str] = Header(default=None, alias=SESSION_HEADER),
    ) -> dict[str, str]:
        return {"session_id": resolve_session_id(x_openclip_session)}

    @app.get("/api/preferences")
    def get_preferences(
        x_openclip_session: Optional[str] = Header(default=None, alias=SESSION_HEADER),
    ) -> dict[str, Any]:
        session_id = resolve_session_id(x_openclip_session)
        defaults = build_preferences_defaults()
        stored = get_preferences_store().get(session_id)
        payload = None
        if stored:
            payload = {
                "version": stored.get("version", PREFERENCES_SCHEMA_VERSION),
                "prefs": stored.get("prefs") or {},
            }
        merged = merge_browser_preferences(defaults, defaults, payload)
        prefs = build_preferences_payload(merged)["prefs"]
        return {
            "session_id": session_id,
            "version": PREFERENCES_SCHEMA_VERSION,
            "prefs": prefs,
            "updated_at": stored.get("updated_at") if stored else None,
        }

    @app.put("/api/preferences")
    def save_preferences(
        payload: PreferencesSaveRequest,
        x_openclip_session: Optional[str] = Header(default=None, alias=SESSION_HEADER),
    ) -> dict[str, Any]:
        session_id = resolve_session_id(x_openclip_session)
        defaults = build_preferences_defaults()
        existing = get_preferences_store().get(session_id)
        base = dict(defaults)
        if existing and isinstance(existing.get("prefs"), dict):
            base = merge_browser_preferences(
                defaults,
                defaults,
                {"version": existing.get("version", PREFERENCES_SCHEMA_VERSION), "prefs": existing["prefs"]},
            )
        merged = merge_browser_preferences(
            defaults,
            base,
            {"version": PREFERENCES_SCHEMA_VERSION, "prefs": payload.prefs or {}},
        )
        # merge_browser_preferences rebuilds provider settings from defaults + incoming only.
        # Re-apply existing provider settings first so siblings survive partial updates.
        settings = {
            provider: dict(values)
            for provider, values in (defaults.get("llm_provider_settings") or {}).items()
        }
        for source in (base.get("llm_provider_settings"), (payload.prefs or {}).get("llm_provider_settings")):
            if not isinstance(source, dict):
                continue
            for provider, values in source.items():
                if provider not in settings or not isinstance(values, dict):
                    continue
                current = dict(settings[provider])
                for field in ("model", "base_url"):
                    raw_value = values.get(field, "")
                    if isinstance(raw_value, str):
                        current[field] = raw_value
                settings[provider] = current
        merged["llm_provider_settings"] = settings
        sanitized = build_preferences_payload(merged)["prefs"]
        saved = get_preferences_store().put(session_id, PREFERENCES_SCHEMA_VERSION, sanitized)
        return saved

    @app.get("/api/jobs")
    def list_jobs(
        limit: int = Query(20, ge=1, le=100),
        x_openclip_session: Optional[str] = Header(default=None, alias=SESSION_HEADER),
    ) -> dict[str, Any]:
        session_id = resolve_session_id(x_openclip_session)
        jobs = job_manager.list_jobs(limit=limit, owner_session_id=session_id)
        stats = job_manager.get_stats(owner_session_id=session_id)
        return {
            "session_id": session_id,
            "stats": stats,
            "jobs": [
                {
                    **job.to_dict(),
                    "is_editor_rerender": is_editor_rerender_job(job),
                }
                for job in jobs
            ],
        }

    @app.get("/api/jobs/{job_id}")
    def get_job(job_id: str) -> dict[str, Any]:
        job = job_manager.get_job(job_id)
        if job is None:
            for candidate in job_manager.list_jobs(limit=1000):
                if candidate.id == job_id:
                    job = candidate
                    break
        if job is None:
            raise HTTPException(status_code=404, detail=f"Unknown job_id: {job_id}")
        return {**job.to_dict(), "is_editor_rerender": is_editor_rerender_job(job)}

    @app.post("/api/jobs")
    async def create_job(
        payload: CreateJobRequest,
        x_openclip_session: Optional[str] = Header(default=None, alias=SESSION_HEADER),
    ) -> dict[str, Any]:
        session_id = resolve_session_id(x_openclip_session)
        uploads_root = uploads_root_for_output_dir(payload.output_dir)

        provider = payload.llm_provider
        if provider not in SUPPORTED_LLM_PROVIDERS:
            raise HTTPException(status_code=400, detail=f"Unsupported provider: {provider}")

        provider_cfg = LLM_CONFIG[provider]
        resolved_model = (payload.llm_model or provider_cfg.get("default_model") or "").strip()
        resolved_base_url = (payload.llm_base_url or provider_cfg.get("base_url") or "").strip()
        api_key_env = API_KEY_ENV_VARS.get(provider, "")
        resolved_api_key = (payload.api_key or os.getenv(api_key_env) or "").strip() or None
        requires_api_key = provider != "custom_openai"

        if not resolved_model:
            raise HTTPException(status_code=400, detail="LLM model is required")
        if not resolved_base_url:
            raise HTTPException(status_code=400, detail="LLM base URL is required")
        if requires_api_key and not resolved_api_key:
            raise HTTPException(status_code=400, detail=f"API key required ({api_key_env})")

        cookies_file_path: Optional[str] = None
        if payload.cookie_mode == "file":
            cookies_file_path = (payload.cookies_file or "").strip() or None
            if not cookies_file_path:
                raise HTTPException(status_code=400, detail="Cookies file is required when cookie mode is file")
            if not Path(cookies_file_path).is_file():
                raise HTTPException(status_code=400, detail=f"Cookies file not found: {cookies_file_path}")

        source_kind = SOURCE_KIND_URL
        job_source = payload.video_source.strip()
        upload_id = None

        if payload.input_type == INPUT_TYPE_UPLOAD:
            if not payload.upload_id:
                raise HTTPException(status_code=400, detail="upload_id is required for upload input")
            upload_meta_path = (
                owner_upload_root(uploads_root, session_id) / payload.upload_id / "upload.json"
            )
            if not upload_meta_path.exists():
                raise HTTPException(status_code=404, detail="Upload not found")
            upload_meta = load_upload_metadata(upload_meta_path)
            if not upload_record_matches_owner(upload_meta, session_id):
                raise HTTPException(status_code=403, detail="Upload does not belong to this session")
            job_source = upload_meta["staged_path"]
            upload_id = upload_meta["upload_id"]
            source_kind = SOURCE_KIND_UPLOADED_FILE
        elif payload.input_type == INPUT_TYPE_SERVER_PATH:
            if not job_source:
                raise HTTPException(status_code=400, detail="Server file path is required")
            if not Path(job_source).exists():
                raise HTTPException(status_code=400, detail="Server file path does not exist")
            source_kind = SOURCE_KIND_SERVER_PATH
        else:
            if not job_source:
                raise HTTPException(status_code=400, detail="Video URL is required")

        custom_prompt_file = None
        if payload.custom_prompt_text and payload.custom_prompt_text.strip():
            temp_dir = Path("./temp_prompts")
            temp_dir.mkdir(exist_ok=True)
            custom_prompt_file = str(temp_dir / f"custom_highlight_prompt_{uuid.uuid4().hex}.md")
            Path(custom_prompt_file).write_text(payload.custom_prompt_text, encoding="utf-8")

        job_options = {
            "output_dir": payload.output_dir,
            "max_duration_minutes": MAX_DURATION_MINUTES,
            "whisper_model": WHISPER_MODEL,
            "browser": payload.cookie_browser if payload.cookie_mode == "browser" else None,
            "api_key": resolved_api_key,
            "llm_provider": provider,
            "llm_model": (payload.llm_model or None),
            "llm_base_url": (payload.llm_base_url or None),
            "generate_clips": True,
            "add_titles": payload.add_titles,
            "title_style": payload.title_style,
            "use_background": payload.use_background,
            "generate_cover": payload.generate_cover,
            "language": payload.language,
            "custom_prompt_file": custom_prompt_file,
            "max_clips": payload.max_clips,
            "clip_length_preset": payload.clip_length_preset,
            "force_whisper": payload.force_whisper,
            "cookie_mode": payload.cookie_mode,
            "cookies_file": cookies_file_path if payload.cookie_mode == "file" else None,
            "speaker_references_dir": payload.speaker_references_dir or None,
            "burn_subtitles": payload.burn_subtitles,
            "subtitle_translation": payload.subtitle_translation or None,
            "subtitle_style_preset": payload.subtitle_style_preset,
            "subtitle_style_font_size": payload.subtitle_style_font_size,
            "subtitle_style_vertical_position": payload.subtitle_style_vertical_position,
            "subtitle_style_background_style": payload.subtitle_style_background_style,
            "user_intent": payload.user_intent or None,
            "agentic_analysis": payload.agentic_analysis,
            "owner_session_id": session_id,
            "source_kind": source_kind,
            "upload_id": upload_id,
            "source_deleted": False,
        }

        created_job_ids: list[str] = []
        if source_kind == SOURCE_KIND_URL and is_bilibili_url(job_source):
            parts = await get_bilibili_multi_parts(
                job_source,
                browser=job_options["browser"],
                cookies_file=job_options["cookies_file"],
            )
            if parts and len(parts) > 1:
                for part in parts:
                    part_options = dict(job_options)
                    part_options["output_dir"] = os.path.join(
                        payload.output_dir,
                        f"P{part['index']}_{FileStringUtils.sanitize_filename(part['title'])[:30]}",
                    )
                    job_id = job_manager.create_job(part["url"], part_options)
                    job_manager.start_job(job_id, process_video_worker)
                    created_job_ids.append(job_id)
            else:
                job_id = job_manager.create_job(job_source, job_options)
                job_manager.start_job(job_id, process_video_worker)
                created_job_ids.append(job_id)
        else:
            job_id = job_manager.create_job(job_source, job_options)
            job_manager.start_job(job_id, process_video_worker)
            created_job_ids.append(job_id)

        return {
            "session_id": session_id,
            "job_ids": created_job_ids,
            "multipart": len(created_job_ids) > 1,
        }

    @app.post("/api/jobs/{job_id}/cancel")
    def cancel_job(job_id: str) -> dict[str, str]:
        job_manager.cancel_job(job_id)
        return {"status": "cancelled", "job_id": job_id}

    @app.post("/api/jobs/{job_id}/retry")
    def retry_job(job_id: str) -> dict[str, Any]:
        new_job_id = job_manager.retry_job(job_id)
        if not new_job_id:
            raise HTTPException(status_code=404, detail="Unable to retry job")
        job_manager.start_job(new_job_id, process_video_worker)
        return {"job_id": new_job_id}

    @app.delete("/api/jobs/{job_id}")
    def delete_job(job_id: str) -> dict[str, str]:
        job_manager.delete_job(job_id)
        return {"status": "deleted", "job_id": job_id}

    @app.get("/api/uploads")
    def list_uploads(
        output_dir: str = Query("processed_videos"),
        x_openclip_session: Optional[str] = Header(default=None, alias=SESSION_HEADER),
    ) -> dict[str, Any]:
        session_id = resolve_session_id(x_openclip_session)
        uploads_root = uploads_root_for_output_dir(output_dir)
        uploads = list_uploads_for_owner(uploads_root, session_id)
        for upload in uploads:
            upload["in_use"] = job_manager.has_active_upload_reference(upload["upload_id"])
        return {"session_id": session_id, "uploads": uploads}

    @app.post("/api/uploads")
    async def upload_file(
        file: UploadFile = File(...),
        output_dir: str = Query("processed_videos"),
        x_openclip_session: Optional[str] = Header(default=None, alias=SESSION_HEADER),
    ) -> dict[str, Any]:
        session_id = resolve_session_id(x_openclip_session)
        uploads_root = uploads_root_for_output_dir(output_dir)
        try:
            metadata = stage_uploaded_file(file, uploads_root, session_id)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return {"session_id": session_id, "upload": metadata}

    @app.post("/api/cookies")
    async def upload_cookies_file(
        file: UploadFile = File(...),
        output_dir: str = Query("processed_videos"),
        x_openclip_session: Optional[str] = Header(default=None, alias=SESSION_HEADER),
    ) -> dict[str, Any]:
        session_id = resolve_session_id(x_openclip_session)
        uploads_root = uploads_root_for_output_dir(output_dir)
        try:
            metadata = stage_cookies_file(file, uploads_root, session_id)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return {"session_id": session_id, "cookies": metadata}

    @app.delete("/api/uploads/{upload_id}")
    def delete_upload(
        upload_id: str,
        output_dir: str = Query("processed_videos"),
        x_openclip_session: Optional[str] = Header(default=None, alias=SESSION_HEADER),
    ) -> dict[str, str]:
        session_id = resolve_session_id(x_openclip_session)
        if job_manager.has_active_upload_reference(upload_id):
            raise HTTPException(status_code=409, detail="Upload is in use by an active job")
        uploads_root = uploads_root_for_output_dir(output_dir)
        meta_path = owner_upload_root(uploads_root, session_id) / upload_id / "upload.json"
        if not meta_path.exists():
            raise HTTPException(status_code=404, detail="Upload not found")
        metadata = load_upload_metadata(meta_path)
        if not upload_record_matches_owner(metadata, session_id):
            raise HTTPException(status_code=403, detail="Upload does not belong to this session")
        job_manager.mark_upload_deleted(upload_id)
        delete_upload_record(metadata)
        return {"status": "deleted", "upload_id": upload_id}

    @app.post("/api/editor/launch")
    def launch_editor(payload: EditorLaunchRequest) -> dict[str, str]:
        root = resolve_projects_root(payload.projects_root, default_projects_root)
        # Ensure the service can resolve the project before handing a URL to the UI.
        try:
            get_editor_service(root).load_project(payload.project_id)
        except KeyError:
            # Retry against the default root when a stale host path was stored on the job.
            if root != default_projects_root:
                root = default_projects_root
                try:
                    get_editor_service(root).load_project(payload.project_id)
                except KeyError as exc:
                    raise HTTPException(status_code=404, detail=f"Unknown project_id: {payload.project_id}") from exc
            else:
                raise HTTPException(status_code=404, detail=f"Unknown project_id: {payload.project_id}") from None
        except Exception as exc:
            raise HTTPException(status_code=503, detail=f"Editor unavailable: {exc}") from exc
        qs = f"?projects_root={quote(str(Path(root).resolve()), safe='')}"
        return {"editor_url": f"/editor/{payload.project_id}{qs}"}

    register_editor_api_routes(
        app,
        get_editor_service,
        include_jobs=False,
        include_legacy_aliases=False,
    )

    @app.post("/api/subtitle-preview")
    def subtitle_preview(payload: SubtitlePreviewRequest) -> Response:
        sample_original = (
            "这是一行原字幕预览效果。"
            if payload.ui_language == "zh"
            else "This is an original subtitle preview line."
        )
        sample_translation = (
            "This is the translated subtitle preview."
            if payload.ui_language == "zh"
            else "这是翻译字幕的预览效果。"
        )
        burner = SubtitleBurner(
            subtitle_style_config=SubtitleStyleConfig(
                preset=payload.preset,
                font_size=payload.font_size,
                vertical_position=payload.vertical_position,
                bilingual_layout="auto",
                background_style=payload.background_style,
            )
        )
        with tempfile.TemporaryDirectory() as tmpdir:
            preview_path = Path(tmpdir) / "subtitle_preview.png"
            ok = burner.generate_preview_image(
                preview_path,
                subtitle_translation=payload.subtitle_translation,
                original_text=sample_original,
                translated_text=sample_translation,
            )
            if not ok or not preview_path.exists():
                raise HTTPException(status_code=500, detail="Subtitle preview failed")
            return Response(content=preview_path.read_bytes(), media_type="image/png")

    @app.get("/")
    def root():
        return serve_spa()

    @app.get("/{full_path:path}")
    def spa_fallback(full_path: str):
        if full_path.startswith("api/"):
            raise HTTPException(status_code=404, detail="Not found")
        candidate = DIST_DIR / full_path
        if candidate.is_file():
            return FileResponse(candidate)
        return serve_spa()

    return app


app = create_app()


def main() -> None:
    parser = argparse.ArgumentParser(description="OpenClip React web UI server")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8502)
    parser.add_argument("--log-level", default="info")
    args = parser.parse_args()
    uvicorn.run("web_api:app", host=args.host, port=args.port, log_level=args.log_level, reload=False)


if __name__ == "__main__":
    main()

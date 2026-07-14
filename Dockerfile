# OpenClip production image: React UI + FastAPI (web_api)
# Multi-stage: build frontend, then run Python backend with ffmpeg (libass).

# ── Frontend build ───────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS frontend

WORKDIR /frontend
COPY web_frontend/package.json web_frontend/package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi
COPY web_frontend/ ./
RUN npm run build

# ── Runtime ──────────────────────────────────────────────────────────────────
FROM python:3.12-slim-bookworm

ARG DEBIAN_FRONTEND=noninteractive
# Optional: docker compose build --build-arg APT_MIRROR=mirrors.aliyun.com
ARG APT_MIRROR=

# ffmpeg (Debian builds include libass → ass/subtitles filters),
# CJK fonts for burned titles/subtitles, git for yt-dlp VCS dependency.
RUN set -eux; \
    if [ -n "${APT_MIRROR}" ]; then \
      sed -i "s|deb.debian.org|${APT_MIRROR}|g; s|security.debian.org|${APT_MIRROR}|g" \
        /etc/apt/sources.list.d/debian.sources 2>/dev/null \
        || sed -i "s|deb.debian.org|${APT_MIRROR}|g; s|security.debian.org|${APT_MIRROR}|g" /etc/apt/sources.list; \
    fi; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      ffmpeg \
      fonts-noto-cjk \
      fonts-noto-color-emoji \
      git; \
    rm -rf /var/lib/apt/lists/*; \
    ffmpeg -hide_banner -filters 2>/dev/null | grep -E '[[:space:]]ass[[:space:]]' >/dev/null

COPY --from=ghcr.io/astral-sh/uv:0.8.4 /uv /usr/local/bin/uv

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/app/.venv \
    XDG_CACHE_HOME=/app/.cache \
    HF_HOME=/app/.cache/huggingface \
    OPENCLIP_HOST=0.0.0.0 \
    OPENCLIP_PORT=8502

# Depend on .dockerignore excluding host caches; keep logo for README packaging.
COPY pyproject.toml README.md logo.png ./
RUN uv sync --no-dev --no-install-project

# Application source + built SPA
COPY . .
COPY --from=frontend /frontend/dist ./web_frontend/dist

RUN uv sync --no-dev --no-install-project \
    && mkdir -p /app/processed_videos /app/data /app/.cache

EXPOSE 8502

HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${OPENCLIP_PORT}/api/config" >/dev/null || exit 1

CMD ["sh", "-c", "uv run --no-sync python web_api.py --host \"${OPENCLIP_HOST}\" --port \"${OPENCLIP_PORT}\""]

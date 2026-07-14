

<p align="center">
  <img src="./logo.png" alt="OpenClip" width="350"/>
</p>


English | [简体中文](./README.md)

OpenClip is a lightweight AI pipeline for extracting highlight clips from long-form videos (talk-to-camera, livestreams, interviews). Give it a URL or file and it runs **Download → Transcribe → AI analysis → Clips → Covers**, with a **Web control-room UI** for jobs, previews, and an integrated **Clip Editor**.

> 💡 How is it different from [AutoClip](https://github.com/zhouxiaoka/autoclip)? See the [comparison](#-comparison-with-autoclip) at the end.

## 📢 News

- **2026-07-15 — Web control room (default UI)**
  - New **React Web UI** (`web_api.py` + `web_frontend/`), default port **8502**
  - Single app flow: create job → track progress → view results → **open editor** (no separate editor server)
  - **URL / browser upload / server path** inputs; cookies file upload in the UI
  - Preferences in `data/openclip.db`; job history in `jobs/*.json`
  - **Docker Compose** one-command deploy (ffmpeg with libass included)
- Older changes: [changelog summary](#earlier-updates)

## 🎬 Demo

![OpenClip Web UI demo](demo/demo_en.gif)

## ✨ Highlights

| Capability | Description |
|------------|-------------|
| **Web control room** | Job cards, live progress, result preview, retry/cancel/delete |
| **Three input modes** | Bilibili/YouTube URL, browser upload, server filesystem path |
| **Smart transcription** | Platform subs first; local ASR routes by language (faster-whisper; optional Paraformer for Chinese) |
| **AI highlights** | Finds engaging talk/livestream moments; **User Focus** steers selection |
| **Deep optimize** | Optional second-pass AI review + boundary repair (UI toggle / `--deep-optimize`) |
| **Clip Editor** | Trim boundaries, edit subtitles, cover titles, speed rerender |
| **Subtitle burn-in** | Optional hard subs + bilingual translation (libass in Docker image) |
| **Cover images** | Horizontal + vertical thumbnails |
| **Background jobs** | Concurrent tasks; interrupted jobs marked failed after restart, retryable |
| **CLI / Agent** | `video_orchestrator.py` and Agent Skill still supported |

## 🚀 Quick start

### Docker (recommended)

```bash
git clone https://github.com/linzzzzzz/openclip.git
cd openclip

cp .env.example .env
# Edit .env — set at least one LLM API key (e.g. QWEN_API_KEY)

docker compose up -d --build
# Open http://127.0.0.1:8502/
```

**Persisted paths**

| Path | Contents |
|------|----------|
| `./jobs/` | Job records (one JSON per job) |
| `./processed_videos/` | Downloads, analysis, clips, editor manifests |
| `./data/` | User preferences (SQLite) |
| Docker volume `openclip-cache` | Whisper / HuggingFace model cache |

Default timezone `Asia/Shanghai`; override with `TZ=...` in `.env`. Slow builds: `APT_MIRROR=mirrors.aliyun.com docker compose build --no-cache`.

> Default image does not include heavy extras (Paraformer / WhisperX). Use local `uv sync --extra …` or extend the Dockerfile if needed.

### Local development

```bash
git clone https://github.com/linzzzzzz/openclip.git
cd openclip

uv sync
cd web_frontend && npm install && npm run build && cd ..

export QWEN_API_KEY=your_key   # or another provider — see below
uv run python web_api.py
# http://127.0.0.1:8502
```

Hot reload:

```bash
# Terminal 1
uv run python web_api.py

# Terminal 2
cd web_frontend && npm run dev
```

<a id="paraformer-installation"></a>
<details>
<summary>🈶 Enable Paraformer Chinese ASR (optional)</summary>

```bash
uv sync --extra paraformer
```

Chinese audio prefers Paraformer; falls back to faster-whisper if unavailable. Helper lives in `third_party/funasr-paraformer`.

</details>

## 🖥️ Web UI guide

### 1. Video source

| Mode | When to use |
|------|-------------|
| **URL** | Bilibili / YouTube; cookie modes available |
| **Upload** | Pick a local file; staged under `processed_videos/_uploads/` |
| **Server path** | Absolute path on the backend host (inside Docker: container path) |

Multi-part Bilibili URLs spawn multiple jobs automatically.

### 2. Processing settings

Open **Processing settings**:

- **LLM provider / API key / language / max clips / length preset**
- **User Focus** — natural-language hint (e.g. `"moments about AI risk"`)
- **Generate cover / Burn subtitles / Deep optimize / Artistic titles / Force Whisper / Background context**
- **Cookie mode** (URL only): none → browser cookies → **upload cookies.txt**
- **Subtitle styling** when burn-in is on: preset, size, position, translation + live preview
- **Advanced**: custom model & base URL, output dir, speaker references dir, custom prompt

Preferences persist to `data/openclip.db`. API keys can be remembered per provider in browser localStorage.

### 3. Job list

- Live progress and current step
- **Completed**: view highlight list; **Open editor** when clips were generated
- **Failed / cancelled**: retry (new job, same params)
- **Processing / pending**: cancel
- Delete any job record

> **No “Open editor” button?** The pipeline finished but AI found **zero** highlights or clip generation failed — common for pure music/montage or poor ASR. Check `processed_videos/.../splits/top_engaging_moments.json`. Try User Focus or different source material.

### 4. Clip Editor (built-in)

From a job card → `/editor/:projectId`:

- Adjust **in/out** and **speed** → boundary rerender
- Edit **subtitle text** (incl. translation track) → subtitle rerender
- Change **cover title** → cover rerender
- Preview composed clip and horizontal/vertical covers

Manifest: `editor_project.json` per project. Host absolute paths remap automatically when sharing `processed_videos` with Docker.

## 🍪 Cookie guidance

If remote download hits login/rate limits, try in order:

1. **No cookies**
2. **Browser cookies** (works for local `uv` runs; usually not inside Docker)
3. **Cookies file** — upload Netscape `cookies.txt` in the Web UI

For YouTube with cookies, install [Deno or Node](https://github.com/yt-dlp/yt-dlp/wiki/EJS#step-1-install-a-supported-javascript-runtime). Export guide: [Exporting YouTube cookies](https://github.com/yt-dlp/yt-dlp/wiki/Extractors#exporting-youtube-cookies)

## 📋 Requirements

### Manual

- **[uv](https://docs.astral.sh/uv/getting-started/installation/)**
- **FFmpeg** (`brew install ffmpeg` on macOS)
- **LLM API key** (one of): Qwen, OpenRouter, GLM, MiniMax, `custom_openai`
- **Browser** (optional) — browser cookie download
- **Deno or Node** (optional) — YouTube stability
- **HuggingFace token** (optional) — speaker ID via `uv sync --extra speakers`

<details>
<summary>Subtitle burn-in needs ffmpeg with libass</summary>

- macOS: `brew tap homebrew-ffmpeg/ffmpeg && brew install homebrew-ffmpeg/ffmpeg/ffmpeg`
- Ubuntu: PPA + `ffmpeg` with libass
- **Docker image already includes libass**

</details>

### Managed by uv

`uv sync` installs Python 3.11+, yt-dlp, faster-whisper, etc.

Optional extras:

- `uv sync --extra paraformer` — Chinese Paraformer ASR
- `uv sync --extra speakers` — WhisperX speaker ID

## 📁 Output layout

```
processed_videos/{video_name}/
├── downloads/
├── splits/              # chunks, transcripts, AI JSON
├── clips/               # highlight mp4, srt, covers
├── clips_post_processed/
├── editor_project.json
└── editor_overrides/
```

## 🔧 Pipeline

```text
Input (URL / upload / path)
    ↓
Download or validate
    ↓
Transcript (platform subs → local ASR)
    ↓
Split if >20 min
    ↓
Per-part AI analysis → aggregate top highlights
    ↓  (optional: deep optimize)
Generate clips + covers
    ↓  (optional: burn subs / artistic titles)
Write editor_project.json
```

## 🛠️ Other interfaces

### Streamlit (legacy)

Port **8501**:

```bash
uv run python -m streamlit run streamlit_app.py
```

New features land in the Web UI first.

### CLI

```bash
uv run python video_orchestrator.py "https://www.youtube.com/watch?v=..."

uv run python video_orchestrator.py \
  --user-intent "most controversial takes" \
  --burn-subtitles \
  --subtitle-translation "Simplified Chinese" \
  --deep-optimize \
  "VIDEO_URL"
```

<details>
<summary>📖 Full CLI flags</summary>

| Flag | Description | Default |
|------|-------------|---------|
| `VIDEO_URL_OR_PATH` | URL or path | required |
| `-o`, `--output` | Output dir | `processed_videos` |
| `--llm-provider` | qwen / openrouter / glm / minimax / custom_openai | qwen |
| `--llm-model` / `--llm-base-url` | Override model & endpoint | provider default |
| `--language` | zh / en | zh |
| `--browser` / `--cookies` | Cookie modes (CLI) | none |
| `--force-whisper` | Ignore platform subs | off |
| `--user-intent` | Natural-language focus | none |
| `--max-clips` | Max highlights | 5 |
| `--clip-length` | auto / 30_60 / … | auto |
| `--deep-optimize` | Deep optimize | off |
| `--burn-subtitles` | Burn subs | off |
| `--subtitle-translation` | Bilingual burn | none |
| `--add-titles` | Artistic banner titles | off |
| `--speaker-references` | Speaker ref dir | none |

See `video_orchestrator.py --help` for title styles and skip flags.

</details>

### Agent Skills

```bash
npx skills add https://github.com/linzzzzzz/openclip --skill video-clip-extractor -g
```

Skill: `.claude/skills/video-clip-extractor/`

<a id="speaker-identification"></a>
<details>
<summary>🎙️ Speaker identification (preview)</summary>

```bash
uv sync --extra speakers
export HUGGINGFACE_TOKEN=hf_xxx

uv run python tools/extract_reference.py VIDEO 00:01:23 00:01:50 "references/Host.wav"
uv run python video_orchestrator.py --speaker-references references/ "VIDEO"
```

Set `speaker_references_dir` in Web UI advanced settings.

</details>

## 🎨 Customization

- **Background**: `prompts/background/background.md` + UI “Background context” or `--use-background`
- **Prompts**: `prompts/engaging_moments_*.md`, `prompts/language_patches/`
- **User Focus**: UI field or `--user-intent`

## 🐛 Troubleshooting

| Symptom | Likely cause / fix |
|---------|-------------------|
| **0 highlights / no editor** | AI found nothing clip-worthy; check `top_engaging_moments.json`. Talk content works best; music/montage often empty |
| **Editor missing media in Docker** | Stale host absolute paths; reopen project (path remapping supported) |
| **Jobs missing in Docker** | Mount `./jobs`; jobs filtered by browser session |
| **Download fails** | Upgrade yt-dlp; try cookies; install Deno/Node for YouTube |
| **Burn-in fails** | Needs libass; Docker OK; Homebrew ffmpeg may lack ass filter |
| **Chinese garbled/traditional** | Install `fonts-noto-cjk`; prefer Paraformer extra for Chinese |
| **LLM errors** | Check API keys / env; custom_openai needs base URL + model |

## 🔄 Comparison with AutoClip

| | OpenClip | AutoClip |
|---|----------|----------|
| Core size | ~5K lines | ~2M lines (incl. frontend deps) |
| Stack | Python + FFmpeg | Docker + Redis + PostgreSQL + Celery |
| Default UI | **React Web control room** | Web |
| Deploy | `docker compose up` or `uv sync` | Full Docker stack |
| Customization | Editable prompts | Config files |

Thanks to [AutoClip](https://github.com/zhouxiaoka/autoclip) for inspiration.

## Earlier updates

<details>
<summary>2026-05 — 2026-03 highlights</summary>

- Clip length presets
- Clip Editor (boundaries, subtitles, covers)
- Streamlit upload, multi-part Bilibili, job retry
- `--deep-optimize`
- `custom_openai`, Paraformer, GLM / MiniMax
- Subtitle burn-in, speaker ID preview, `--user-intent`
- Agent Skill on skills.sh

</details>

## 🤝 Contributing

PRs welcome — keep the codebase small and readable: prompt tweaks, perf, more platforms, etc.

## 📞 Support

1. Check job step text and `docker compose logs -f openclip`
2. Test with a short video first
3. [GitHub Issues](https://github.com/linzzzzzz/openclip/issues)
4. [Discord](https://discord.gg/KsC4Keaq)

## 📄 License

MIT — see [LICENSE](LICENSE)

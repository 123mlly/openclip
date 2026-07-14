# OpenClip Web Frontend

React + TypeScript + Vite UI for the main OpenClip processing workflow, built with **shadcn/ui** + Tailwind CSS.

## Scripts

- `npm run dev` — Vite dev server (proxies `/api` to `http://127.0.0.1:8502`)
- `npm run build` — type-check + production build into `dist/`
- `npm run preview` — preview the production build

## Run with backend

From the repo root:

```bash
# Terminal 1 — API + static SPA
uv run python web_api.py

# Optional Terminal 2 — hot reload during UI work
cd web_frontend && npm run dev
```

Then open `http://127.0.0.1:8502` (or the Vite URL when using `npm run dev`).

## UI stack

- shadcn/ui (New York style)
- Tailwind CSS v4
- Radix primitives
- Lucide icons
- Sonner toasts

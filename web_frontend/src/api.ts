import type {
  AppConfig,
  FormState,
  Job,
  JobStats,
  ProcessingResult,
  UploadRecord,
} from './types'

const SESSION_KEY = 'openclip-session-id'

export function getSessionId(): string {
  try {
    const existing = window.localStorage.getItem(SESSION_KEY)
    if (existing) return existing
  } catch {
    // ignore
  }
  const created = crypto.randomUUID().replace(/-/g, '')
  try {
    window.localStorage.setItem(SESSION_KEY, created)
  } catch {
    // ignore
  }
  return created
}

function headers(extra?: HeadersInit): HeadersInit {
  return {
    'X-OpenClip-Session': getSessionId(),
    ...extra,
  }
}

async function parseError(response: Response): Promise<string> {
  try {
    const data = await response.json()
    if (typeof data.detail === 'string') return data.detail
    if (Array.isArray(data.detail)) {
      return data.detail.map((item: { msg?: string }) => item.msg ?? JSON.stringify(item)).join('; ')
    }
    return JSON.stringify(data)
  } catch {
    return `Request failed (${response.status})`
  }
}

async function assertOk(response: Response): Promise<void> {
  if (!response.ok) {
    throw new Error(await parseError(response))
  }
}

export async function fetchConfig(): Promise<AppConfig> {
  const response = await fetch('/api/config')
  await assertOk(response)
  return response.json()
}

export async function fetchJobs(limit = 20): Promise<{
  session_id: string
  stats: JobStats
  jobs: Job[]
}> {
  const response = await fetch(`/api/jobs?limit=${limit}`, { headers: headers() })
  await assertOk(response)
  return response.json()
}

export async function fetchUploads(outputDir: string): Promise<{
  session_id: string
  uploads: UploadRecord[]
}> {
  const params = new URLSearchParams({ output_dir: outputDir })
  const response = await fetch(`/api/uploads?${params}`, { headers: headers() })
  await assertOk(response)
  return response.json()
}

export async function uploadVideo(file: File, outputDir: string): Promise<UploadRecord> {
  const params = new URLSearchParams({ output_dir: outputDir })
  const body = new FormData()
  body.append('file', file)
  const response = await fetch(`/api/uploads?${params}`, {
    method: 'POST',
    headers: headers(),
    body,
  })
  await assertOk(response)
  const data = await response.json()
  return data.upload as UploadRecord
}

export async function uploadCookiesFile(
  file: File,
  outputDir: string,
): Promise<{ staged_path: string; original_filename: string }> {
  const params = new URLSearchParams({ output_dir: outputDir })
  const body = new FormData()
  body.append('file', file)
  const response = await fetch(`/api/cookies?${params}`, {
    method: 'POST',
    headers: headers(),
    body,
  })
  await assertOk(response)
  const data = await response.json()
  return {
    staged_path: data.cookies.staged_path as string,
    original_filename: data.cookies.original_filename as string,
  }
}

export async function deleteUpload(uploadId: string, outputDir: string): Promise<void> {
  const params = new URLSearchParams({ output_dir: outputDir })
  const response = await fetch(`/api/uploads/${uploadId}?${params}`, {
    method: 'DELETE',
    headers: headers(),
  })
  await assertOk(response)
}

export async function createJob(form: FormState): Promise<{ job_ids: string[]; multipart: boolean }> {
  const response = await fetch('/api/jobs', {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      input_type: form.inputType,
      video_source: form.videoSource,
      upload_id: form.uploadId,
      output_dir: form.outputDir,
      llm_provider: form.llmProvider,
      llm_model: form.llmModel || null,
      llm_base_url: form.llmBaseUrl || null,
      api_key: form.apiKey || null,
      language: form.language,
      max_clips: form.maxClips,
      clip_length_preset: form.clipLengthPreset,
      user_intent: form.userIntent || null,
      generate_cover: form.generateCover,
      burn_subtitles: form.burnSubtitles,
      agentic_analysis: form.agenticAnalysis,
      add_titles: form.addTitles,
      use_background: form.useBackground,
      force_whisper: form.forceWhisper,
      cookie_mode: form.cookieMode,
      cookie_browser: form.cookieBrowser,
      cookies_file: form.cookiesFile || null,
      speaker_references_dir: form.speakerReferencesDir || null,
      subtitle_translation: form.burnSubtitles ? form.subtitleTranslation : null,
      subtitle_style_preset: form.subtitleStylePreset,
      subtitle_style_font_size: form.subtitleStyleFontSize,
      subtitle_style_vertical_position: form.subtitleStyleVerticalPosition,
      subtitle_style_background_style: form.subtitleStyleBackgroundStyle,
      custom_prompt_text: form.useCustomPrompt ? form.customPromptText : null,
    }),
  })
  await assertOk(response)
  return response.json()
}

export async function cancelJob(jobId: string): Promise<void> {
  const response = await fetch(`/api/jobs/${jobId}/cancel`, {
    method: 'POST',
    headers: headers(),
  })
  await assertOk(response)
}

export async function retryJob(jobId: string): Promise<{ job_id: string }> {
  const response = await fetch(`/api/jobs/${jobId}/retry`, {
    method: 'POST',
    headers: headers(),
  })
  await assertOk(response)
  return response.json()
}

export async function deleteJob(jobId: string): Promise<void> {
  const response = await fetch(`/api/jobs/${jobId}`, {
    method: 'DELETE',
    headers: headers(),
  })
  await assertOk(response)
}

export async function launchEditor(
  projectId: string,
  projectsRoot?: string,
): Promise<{ editor_url: string }> {
  const response = await fetch('/api/editor/launch', {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      project_id: projectId,
      projects_root: projectsRoot ?? null,
    }),
  })
  await assertOk(response)
  return response.json()
}

export async function fetchSubtitlePreview(payload: {
  preset: string
  font_size: string
  vertical_position: string
  background_style: string
  subtitle_translation: string | null
  ui_language: string
}): Promise<string> {
  const response = await fetch('/api/subtitle-preview', {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(payload),
  })
  await assertOk(response)
  const blob = await response.blob()
  return URL.createObjectURL(blob)
}

export async function fetchPreferences(): Promise<{
  session_id: string
  version: number
  prefs: Record<string, unknown>
  updated_at: string | null
}> {
  const response = await fetch('/api/preferences', { headers: headers() })
  await assertOk(response)
  return response.json()
}

export async function savePreferences(prefs: Record<string, unknown>): Promise<{
  session_id: string
  version: number
  prefs: Record<string, unknown>
  updated_at: string
}> {
  const response = await fetch('/api/preferences', {
    method: 'PUT',
    headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ prefs }),
  })
  await assertOk(response)
  return response.json()
}

export type { ProcessingResult }

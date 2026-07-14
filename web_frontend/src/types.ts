export type Locale = 'zh' | 'en'
export type InputType = 'url' | 'upload' | 'server_path'

export interface ProviderConfig {
  default_model: string
  base_url: string
  api_key_env: string
  api_key_configured: boolean
}

export interface AppConfig {
  providers: Record<string, ProviderConfig>
  default_provider: string
  default_title_style: string
  max_clips: number
  clip_length_presets: Record<string, { preset: string; label: string }>
  default_clip_length_preset: string
  languages: string[]
  video_extensions: string[]
  whisperx_available: boolean
  input_types: InputType[]
  subtitle_presets: string[]
  subtitle_sizes: string[]
  subtitle_positions: string[]
  subtitle_backgrounds: string[]
}

export interface JobOptions {
  output_dir?: string
  operation?: string
  clip_id?: string
  project_id?: string
  projects_root?: string
  kind?: string
  source_deleted?: boolean
  upload_id?: string
  [key: string]: unknown
}

export interface Job {
  id: string
  video_source: string
  options: JobOptions
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled'
  progress: number
  current_step: string
  result: ProcessingResult | null
  error: string | null
  created_at: string
  started_at: string | null
  completed_at: string | null
  is_editor_rerender?: boolean
}

export interface JobStats {
  total: number
  pending: number
  processing: number
  completed: number
  failed: number
  cancelled: number
}

export interface UploadRecord {
  upload_id: string
  original_filename: string
  staged_path: string
  created_at: string
  exists?: boolean
  in_use?: boolean
  size_bytes?: number
}

export interface EditorProject {
  project_id: string
  project_root?: string
  projects_root?: string
}

export interface EngagingMoment {
  title?: string
  start_time?: string
  end_time?: string
  reason?: string
  score?: number
}

export interface ProcessingResult {
  success?: boolean
  error_message?: string | null
  processing_time?: number | null
  video_info?: Record<string, unknown> | null
  transcript_source?: string | null
  engaging_moments_analysis?: {
    engaging_moments?: EngagingMoment[]
  } | null
  clip_generation?: Record<string, unknown> | null
  post_processing?: Record<string, unknown> | null
  cover_generation?: Record<string, unknown> | null
  editor_project?: EditorProject | null
}

export interface FormState {
  inputType: InputType
  videoSource: string
  uploadId: string | null
  uploadFileName: string
  outputDir: string
  llmProvider: string
  llmModel: string
  llmBaseUrl: string
  apiKey: string
  language: string
  maxClips: number
  clipLengthPreset: string
  userIntent: string
  generateCover: boolean
  burnSubtitles: boolean
  agenticAnalysis: boolean
  addTitles: boolean
  useBackground: boolean
  forceWhisper: boolean
  cookieMode: 'none' | 'browser' | 'file'
  cookieBrowser: string
  cookiesFile: string
  speakerReferencesDir: string
  subtitleTranslation: string | null
  subtitleStylePreset: string
  subtitleStyleFontSize: string
  subtitleStyleVerticalPosition: string
  subtitleStyleBackgroundStyle: string
  useCustomPrompt: boolean
  customPromptText: string
}

export function defaultFormState(config?: AppConfig | null): FormState {
  const provider = config?.default_provider ?? 'qwen'
  const providerCfg = config?.providers?.[provider]
  return {
    inputType: 'url',
    videoSource: '',
    uploadId: null,
    uploadFileName: '',
    outputDir: 'processed_videos',
    llmProvider: provider,
    llmModel: providerCfg?.default_model ?? '',
    llmBaseUrl: '',
    apiKey: '',
    language: 'zh',
    maxClips: config?.max_clips ?? 5,
    clipLengthPreset: config?.default_clip_length_preset ?? 'auto',
    userIntent: '',
    generateCover: true,
    burnSubtitles: false,
    agenticAnalysis: false,
    addTitles: false,
    useBackground: false,
    forceWhisper: false,
    cookieMode: 'none',
    cookieBrowser: 'chrome',
    cookiesFile: '',
    speakerReferencesDir: '',
    subtitleTranslation: null,
    subtitleStylePreset: 'default',
    subtitleStyleFontSize: 'medium',
    subtitleStyleVerticalPosition: 'bottom',
    subtitleStyleBackgroundStyle: 'none',
    useCustomPrompt: false,
    customPromptText: '',
  }
}

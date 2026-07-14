import type { AppConfig, FormState, Locale } from './types'
import { defaultFormState } from './types'

export type PreferencesMap = Record<string, unknown>

export function formToPreferences(
  form: FormState,
  locale: Locale,
  existing?: PreferencesMap | null,
): PreferencesMap {
  const previousSettings =
    existing && typeof existing.llm_provider_settings === 'object' && existing.llm_provider_settings
      ? { ...(existing.llm_provider_settings as Record<string, { model?: string; base_url?: string }>) }
      : {}

  const providerSettings = {
    ...previousSettings,
    [form.llmProvider]: {
      ...(previousSettings[form.llmProvider] || {}),
      model: form.llmModel || '',
      base_url: form.llmBaseUrl || '',
    },
  }

  return {
    ui_language: locale,
    input_type: form.inputType,
    llm_provider: form.llmProvider,
    llm_provider_settings: providerSettings,
    language: form.language,
    use_background: form.useBackground,
    force_whisper: form.forceWhisper,
    generate_clips: true,
    max_clips: form.maxClips,
    clip_length_preset: form.clipLengthPreset,
    add_titles: form.addTitles,
    burn_subtitles: form.burnSubtitles,
    subtitle_translation: form.subtitleTranslation,
    subtitle_style_preset: form.subtitleStylePreset,
    subtitle_style_font_size: form.subtitleStyleFontSize,
    subtitle_style_vertical_position: form.subtitleStyleVerticalPosition,
    subtitle_style_background_style: form.subtitleStyleBackgroundStyle,
    generate_cover: form.generateCover,
    cookie_mode: form.cookieMode,
    cookie_browser: form.cookieBrowser,
    mode: 'engaging_moments',
    agentic_analysis: form.agenticAnalysis,
    output_dir: form.outputDir || 'processed_videos',
    user_intent: form.userIntent || '',
  }
}

export function applyPreferencesToForm(
  prefs: PreferencesMap | null | undefined,
  config: AppConfig | null,
  current: FormState = defaultFormState(config),
): { form: FormState; locale?: Locale } {
  if (!prefs) return { form: current }

  const provider =
    typeof prefs.llm_provider === 'string' && prefs.llm_provider
      ? prefs.llm_provider
      : current.llmProvider

  const settingsRoot =
    prefs.llm_provider_settings && typeof prefs.llm_provider_settings === 'object'
      ? (prefs.llm_provider_settings as Record<string, { model?: string; base_url?: string }>)
      : {}
  const providerSettings = settingsRoot[provider] || {}
  const providerCfg = config?.providers?.[provider]

  const next: FormState = {
    ...current,
    inputType:
      prefs.input_type === 'url' || prefs.input_type === 'upload' || prefs.input_type === 'server_path'
        ? prefs.input_type
        : current.inputType,
    llmProvider: provider,
    llmModel:
      typeof providerSettings.model === 'string' && providerSettings.model
        ? providerSettings.model
        : providerCfg?.default_model || current.llmModel,
    llmBaseUrl:
      typeof providerSettings.base_url === 'string'
        ? providerSettings.base_url
        : current.llmBaseUrl,
    language: typeof prefs.language === 'string' ? prefs.language : current.language,
    maxClips: typeof prefs.max_clips === 'number' ? prefs.max_clips : current.maxClips,
    clipLengthPreset:
      typeof prefs.clip_length_preset === 'string' ? prefs.clip_length_preset : current.clipLengthPreset,
    generateCover: typeof prefs.generate_cover === 'boolean' ? prefs.generate_cover : current.generateCover,
    burnSubtitles: typeof prefs.burn_subtitles === 'boolean' ? prefs.burn_subtitles : current.burnSubtitles,
    agenticAnalysis:
      typeof prefs.agentic_analysis === 'boolean' ? prefs.agentic_analysis : current.agenticAnalysis,
    addTitles: typeof prefs.add_titles === 'boolean' ? prefs.add_titles : current.addTitles,
    useBackground: typeof prefs.use_background === 'boolean' ? prefs.use_background : current.useBackground,
    forceWhisper: typeof prefs.force_whisper === 'boolean' ? prefs.force_whisper : current.forceWhisper,
    cookieMode:
      prefs.cookie_mode === 'none' || prefs.cookie_mode === 'browser' || prefs.cookie_mode === 'file'
        ? prefs.cookie_mode
        : current.cookieMode,
    cookieBrowser: typeof prefs.cookie_browser === 'string' ? prefs.cookie_browser : current.cookieBrowser,
    subtitleTranslation:
      prefs.subtitle_translation === null || typeof prefs.subtitle_translation === 'string'
        ? (prefs.subtitle_translation as string | null)
        : current.subtitleTranslation,
    subtitleStylePreset:
      typeof prefs.subtitle_style_preset === 'string'
        ? prefs.subtitle_style_preset
        : current.subtitleStylePreset,
    subtitleStyleFontSize:
      typeof prefs.subtitle_style_font_size === 'string'
        ? prefs.subtitle_style_font_size
        : current.subtitleStyleFontSize,
    subtitleStyleVerticalPosition:
      typeof prefs.subtitle_style_vertical_position === 'string'
        ? prefs.subtitle_style_vertical_position
        : current.subtitleStyleVerticalPosition,
    subtitleStyleBackgroundStyle:
      typeof prefs.subtitle_style_background_style === 'string'
        ? prefs.subtitle_style_background_style
        : current.subtitleStyleBackgroundStyle,
    outputDir: typeof prefs.output_dir === 'string' && prefs.output_dir
      ? prefs.output_dir
      : current.outputDir,
    userIntent: typeof prefs.user_intent === 'string' ? prefs.user_intent : current.userIntent,
  }

  const locale =
    prefs.ui_language === 'en' || prefs.ui_language === 'zh'
      ? prefs.ui_language
      : undefined

  return { form: next, locale }
}

const apiKeyStoragePrefix = 'openclip-web-api-key:'

export function loadStoredApiKey(provider: string): string {
  try {
    return window.localStorage.getItem(`${apiKeyStoragePrefix}${provider}`) || ''
  } catch {
    return ''
  }
}

export function saveStoredApiKey(provider: string, apiKey: string): void {
  try {
    const key = `${apiKeyStoragePrefix}${provider}`
    if (apiKey.trim()) window.localStorage.setItem(key, apiKey)
    else window.localStorage.removeItem(key)
  } catch {
    // ignore
  }
}

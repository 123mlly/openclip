import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  ChevronDown,
  Clapperboard,
  FileVideo,
  Link2,
  Loader2,
  FolderOpen,
  Settings2,
  Sparkles,
  Trash2,
  Upload,
  FileText,
} from 'lucide-react'
import { toast, Toaster } from 'sonner'
import { useNavigate } from 'react-router-dom'
import {
  cancelJob,
  createJob,
  deleteJob,
  deleteUpload,
  fetchConfig,
  fetchJobs,
  fetchPreferences,
  fetchSubtitlePreview,
  fetchUploads,
  launchEditor,
  retryJob,
  savePreferences,
  uploadCookiesFile,
  uploadVideo,
} from '@/api'
import { applyPreferencesToForm, formToPreferences, loadStoredApiKey, saveStoredApiKey } from '@/preferences'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { t } from '@/i18n'
import { cn } from '@/lib/utils'
import {
  defaultFormState,
  type AppConfig,
  type FormState,
  type Job,
  type JobStats,
  type Locale,
  type ProcessingResult,
  type UploadRecord,
} from '@/types'

const localeKey = 'openclip-web-locale'
const pollMs = 2000

function loadLocale(): Locale {
  try {
    return window.localStorage.getItem(localeKey) === 'en' ? 'en' : 'zh'
  } catch {
    return 'zh'
  }
}

function truncate(text: string, max = 80): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

function formatTime(iso: string | null, locale: Locale): string {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return iso
  }
}

function statusVariant(status: Job['status']): 'info' | 'success' | 'destructive' | 'warning' {
  if (status === 'processing') return 'info'
  if (status === 'completed') return 'success'
  if (status === 'failed') return 'destructive'
  return 'warning'
}

function Field({
  label,
  children,
  className,
}: {
  label: string
  children: ReactNode
  className?: string
}) {
  return (
    <div className={cn('grid gap-2', className)}>
      <Label>{label}</Label>
      {children}
    </div>
  )
}

function OptionToggle({
  checked,
  onCheckedChange,
  label,
}: {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  label: string
}) {
  return (
    <label className="flex min-w-0 cursor-pointer items-center gap-2.5 rounded-lg border bg-card px-3 py-2.5 text-sm font-medium hover:bg-accent/60">
      <Checkbox checked={checked} onCheckedChange={(value) => onCheckedChange(value === true)} />
      <span className="truncate">{label}</span>
    </label>
  )
}

export default function HomePage() {
  const navigate = useNavigate()
  const [locale, setLocale] = useState<Locale>(loadLocale)
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [form, setForm] = useState<FormState>(() => defaultFormState())
  const [jobs, setJobs] = useState<Job[]>([])
  const [stats, setStats] = useState<JobStats | null>(null)
  const [uploads, setUploads] = useState<UploadRecord[]>([])
  const [result, setResult] = useState<ProcessingResult | null>(null)
  const [resultJobId, setResultJobId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [cookiesUploading, setCookiesUploading] = useState(false)
  const [cookiesFileName, setCookiesFileName] = useState('')
  const [loadError, setLoadError] = useState<string | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [savingPrefs, setSavingPrefs] = useState(false)
  const [storedPrefs, setStoredPrefs] = useState<Record<string, unknown> | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const cookiesInputRef = useRef<HTMLInputElement | null>(null)
  const settingsForcedRef = useRef(false)

  const providerCfg = config?.providers?.[form.llmProvider]
  const resolvedModel = (form.llmModel || providerCfg?.default_model || '').trim()
  const resolvedBaseUrl = (form.llmBaseUrl || providerCfg?.base_url || '').trim()
  const requiresApiKey = form.llmProvider !== 'custom_openai'
  const hasApiKey = Boolean(form.apiKey.trim() || providerCfg?.api_key_configured)
  const sourceReady =
    form.inputType === 'upload' ? Boolean(form.uploadId) : Boolean(form.videoSource.trim())
  const cookiesReady = form.inputType !== 'url' || form.cookieMode !== 'file' || Boolean(form.cookiesFile.trim())
  const canProcess = Boolean(
    sourceReady && resolvedModel && resolvedBaseUrl && (!requiresApiKey || hasApiKey) && cookiesReady,
  )

  const blocker = !sourceReady
    ? t(locale, 'missingSource')
    : !resolvedModel
      ? t(locale, 'missingModel')
      : !resolvedBaseUrl
        ? t(locale, 'missingBaseUrl')
        : requiresApiKey && !hasApiKey
          ? t(locale, 'missingApiKey')
          : !cookiesReady
            ? t(locale, 'cookiesFileMissing')
            : null

  const settingsSummary = [
    form.llmProvider,
    form.llmModel || providerCfg?.default_model || null,
    form.language,
    `${form.maxClips} clips`,
    form.clipLengthPreset,
    form.burnSubtitles ? 'subs' : null,
    form.agenticAnalysis ? 'deep' : null,
  ].filter(Boolean).join(' · ')

  function patchForm(patch: Partial<FormState>) {
    setForm((current) => ({ ...current, ...patch }))
  }

  function notify(text: string, kind: 'ok' | 'error' = 'ok') {
    if (kind === 'error') toast.error(text)
    else toast.success(text)
  }

  async function refreshJobs() {
    const data = await fetchJobs()
    setJobs(data.jobs)
    setStats(data.stats)
  }

  async function refreshUploads(outputDir = form.outputDir) {
    const data = await fetchUploads(outputDir)
    setUploads(data.uploads)
  }

  useEffect(() => {
    try {
      window.localStorage.setItem(localeKey, locale)
    } catch {
      // ignore
    }
  }, [locale])

  useEffect(() => {
    let cancelled = false
    async function boot() {
      try {
        const [nextConfig, preferences] = await Promise.all([
          fetchConfig(),
          fetchPreferences(),
        ])
        if (cancelled) return
        setConfig(nextConfig)
        setStoredPrefs(preferences.prefs)
        const applied = applyPreferencesToForm(
          preferences.prefs,
          nextConfig,
          defaultFormState(nextConfig),
        )
        const restoredApiKey = loadStoredApiKey(applied.form.llmProvider)
        setForm({
          ...applied.form,
          apiKey: restoredApiKey || applied.form.apiKey,
        })
        if (applied.locale) setLocale(applied.locale)
        setLoadError(null)
        await Promise.all([
          refreshJobs(),
          refreshUploads(applied.form.outputDir || 'processed_videos'),
        ])
      } catch (error) {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : String(error))
        }
      }
    }
    void boot()
    return () => {
      cancelled = true
    }
  }, [])

  async function handleSavePreferences(closePanel = true) {
    setSavingPrefs(true)
    try {
      const prefs = formToPreferences(form, locale, storedPrefs)
      const saved = await savePreferences(prefs)
      setStoredPrefs(saved.prefs)
      saveStoredApiKey(form.llmProvider, form.apiKey)
      if (saved.prefs.ui_language === 'en' || saved.prefs.ui_language === 'zh') {
        setLocale(saved.prefs.ui_language)
      }
      notify(t(locale, 'saved'))
      if (closePanel) setSettingsOpen(false)
    } catch (error) {
      notify(error instanceof Error ? error.message : t(locale, 'saveFailed'), 'error')
    } finally {
      setSavingPrefs(false)
    }
  }
  useEffect(() => {
    const timer = window.setInterval(() => {
      void refreshJobs().catch(() => undefined)
    }, pollMs)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    if (!sourceReady || settingsForcedRef.current) return
    if ((!hasApiKey && requiresApiKey) || !resolvedModel || !resolvedBaseUrl) {
      settingsForcedRef.current = true
      setSettingsOpen(true)
    }
  }, [sourceReady, hasApiKey, requiresApiKey, resolvedModel, resolvedBaseUrl])

  useEffect(() => {
    if (!form.burnSubtitles || !settingsOpen) {
      setPreviewUrl(null)
      setPreviewLoading(false)
      return
    }
    let cancelled = false
    let objectUrl: string | null = null
    setPreviewLoading(true)
    const timer = window.setTimeout(() => {
      void fetchSubtitlePreview({
        preset: form.subtitleStylePreset,
        font_size: form.subtitleStyleFontSize,
        vertical_position: form.subtitleStyleVerticalPosition,
        background_style: form.subtitleStyleBackgroundStyle,
        subtitle_translation: form.subtitleTranslation,
        ui_language: locale,
      })
        .then((url) => {
          if (cancelled) {
            URL.revokeObjectURL(url)
            return
          }
          objectUrl = url
          setPreviewUrl((previous) => {
            if (previous) URL.revokeObjectURL(previous)
            return url
          })
          setPreviewLoading(false)
        })
        .catch(() => {
          if (!cancelled) {
            setPreviewUrl(null)
            setPreviewLoading(false)
          }
        })
    }, 350)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [
    form.burnSubtitles,
    form.subtitleStylePreset,
    form.subtitleStyleFontSize,
    form.subtitleStyleVerticalPosition,
    form.subtitleStyleBackgroundStyle,
    form.subtitleTranslation,
    locale,
    settingsOpen,
  ])

  const moments = useMemo(
    () => result?.engaging_moments_analysis?.engaging_moments ?? [],
    [result],
  )

  async function handleUpload(file: File | null) {
    if (!file) return
    setUploading(true)
    try {
      const upload = await uploadVideo(file, form.outputDir)
      patchForm({
        inputType: 'upload',
        uploadId: upload.upload_id,
        uploadFileName: upload.original_filename,
        videoSource: upload.original_filename,
      })
      await refreshUploads()
      notify(`${t(locale, 'uploadSelected')}: ${upload.original_filename}`)
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setUploading(false)
    }
  }

  async function handleCookiesUpload(file: File | null) {
    if (!file) return
    setCookiesUploading(true)
    try {
      const uploaded = await uploadCookiesFile(file, form.outputDir)
      patchForm({ cookieMode: 'file', cookiesFile: uploaded.staged_path })
      setCookiesFileName(uploaded.original_filename)
      notify(`${t(locale, 'cookiesFileReady')}: ${uploaded.original_filename}`)
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setCookiesUploading(false)
      if (cookiesInputRef.current) cookiesInputRef.current.value = ''
    }
  }

  async function handleProcess() {
    if (!canProcess || busy) return
    setBusy(true)
    setSettingsOpen(false)
    try {
      const response = await createJob(form)
      await refreshJobs()
      notify(response.multipart ? t(locale, 'multipartStarted') : t(locale, 'jobStarted'))
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setBusy(false)
    }
  }

  async function handleOpenEditor(job: Job) {
    const project =
      job.result?.editor_project?.project_id
        ? job.result.editor_project
        : (job.options.project_id
          ? {
              project_id: String(job.options.project_id),
              projects_root: job.options.projects_root
                ? String(job.options.projects_root)
                : undefined,
            }
          : null)
    if (!project?.project_id) {
      notify(t(locale, 'missingEditorProject'), 'error')
      return
    }
    try {
      // Let the API remap host absolute roots (e.g. /Users/.../processed_videos) for Docker.
      const { editor_url } = await launchEditor(project.project_id, project.projects_root)
      navigate(editor_url)
      notify(t(locale, 'editorLaunched'))
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error')
    }
  }

  function hasEditorProject(job: Job): boolean {
    return Boolean(job.result?.editor_project?.project_id || job.options.project_id)
  }

  function toggleResult(job: Job) {
    if (resultJobId === job.id) {
      setResult(null)
      setResultJobId(null)
      return
    }
    setResult(job.result)
    setResultJobId(job.id)
  }

  return (
    <div className="mx-auto min-h-screen max-w-6xl px-4 pb-10 pt-6 sm:px-6 lg:px-8">
      <Toaster richColors position="top-center" />

      <header className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm">
            <Clapperboard className="size-5" />
          </div>
          <div>
            <h1 className="font-[Syne] text-2xl font-bold tracking-tight">{t(locale, 'brand')}</h1>
            <p className="mt-1 max-w-md text-sm text-muted-foreground">{t(locale, 'tagline')}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="inline-flex rounded-lg border bg-card p-1">
            <Button
              type="button"
              size="sm"
              variant={locale === 'en' ? 'default' : 'ghost'}
              onClick={() => setLocale('en')}
            >
              EN
            </Button>
            <Button
              type="button"
              size="sm"
              variant={locale === 'zh' ? 'default' : 'ghost'}
              onClick={() => setLocale('zh')}
            >
              中文
            </Button>
          </div>
          <Badge variant={loadError ? 'destructive' : 'success'}>
            {loadError ? t(locale, 'error') : config ? t(locale, 'connected') : t(locale, 'loading')}
          </Badge>
        </div>
      </header>

      {loadError ? (
        <Alert variant="destructive" className="mb-4">
          <AlertDescription>{loadError}</AlertDescription>
        </Alert>
      ) : null}

      <Card className="mb-6 overflow-hidden">
        <CardContent className="space-y-4 pt-5">
          <Tabs
            value={form.inputType}
            onValueChange={(value) => patchForm({
              inputType: value as FormState['inputType'],
              uploadId: value === 'upload' ? form.uploadId : null,
              videoSource: value === form.inputType ? form.videoSource : '',
              uploadFileName: value === 'upload' ? form.uploadFileName : '',
            })}
          >
            <TabsList>
              <TabsTrigger value="url" className="gap-1.5">
                <Link2 className="size-3.5" />
                {t(locale, 'inputUrl')}
              </TabsTrigger>
              <TabsTrigger value="upload" className="gap-1.5">
                <Upload className="size-3.5" />
                {t(locale, 'inputUpload')}
              </TabsTrigger>
              <TabsTrigger value="server_path" className="gap-1.5">
                <FolderOpen className="size-3.5" />
                {t(locale, 'inputServer')}
              </TabsTrigger>
            </TabsList>
          </Tabs>

          <div className="flex flex-col gap-3 sm:flex-row">
            {form.inputType === 'url' || form.inputType === 'server_path' ? (
              <Input
                className="h-11 flex-1 text-base"
                value={form.videoSource}
                placeholder={form.inputType === 'url' ? t(locale, 'videoUrlPlaceholder') : t(locale, 'serverPath')}
                autoComplete="off"
                autoFocus={form.inputType === 'url'}
                onChange={(event) => patchForm({ videoSource: event.currentTarget.value })}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && canProcess) void handleProcess()
                }}
              />
            ) : (
              <div
                className={cn(
                  'relative min-w-0 flex-1 overflow-hidden rounded-lg border border-dashed transition-colors',
                  uploading && 'opacity-60',
                  dragOver || form.uploadId ? 'border-primary bg-accent/50' : 'bg-card text-muted-foreground hover:bg-accent/40',
                )}
                onDragEnter={(event) => { event.preventDefault(); setDragOver(true) }}
                onDragOver={(event) => { event.preventDefault(); setDragOver(true) }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(event) => {
                  event.preventDefault()
                  setDragOver(false)
                  void handleUpload(event.dataTransfer.files?.[0] ?? null)
                }}
              >
                {/*
                  Do not use `sr-only` here: Tailwind v4 applies clip-path, which
                  blocks the native file picker in Chromium/Safari when clicking.
                */}
                <input
                  id="openclip-video-upload"
                  ref={fileInputRef}
                  type="file"
                  disabled={uploading}
                  className="absolute inset-0 z-10 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
                  accept={(config?.video_extensions ?? ['mp4', 'webm', 'mov', 'mkv', 'avi']).map((ext) => `.${ext}`).join(',')}
                  onChange={(event) => {
                    void handleUpload(event.currentTarget.files?.[0] ?? null)
                    event.currentTarget.value = ''
                  }}
                />
                <div className="pointer-events-none flex h-11 w-full items-center justify-start gap-2 px-3 text-left text-sm">
                  {uploading ? <Loader2 className="size-4 animate-spin" /> : <FileVideo className="size-4" />}
                  <span className="truncate font-medium text-foreground">
                    {uploading
                      ? t(locale, 'uploading')
                      : form.uploadFileName || t(locale, 'uploadFile')}
                  </span>
                </div>
              </div>
            )}

            <Button
              type="button"
              size="lg"
              className="h-11 min-w-28 sm:min-w-36"
              disabled={!canProcess || busy}
              onClick={() => void handleProcess()}
              title={blocker ?? t(locale, 'readyToProcess')}
            >
              {busy ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
              {busy ? t(locale, 'starting') : t(locale, 'process')}
            </Button>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              onClick={() => setSettingsOpen((open) => !open)}
            >
              <Settings2 className="size-4" />
              {settingsSummary}
              <ChevronDown className={cn('size-4 transition-transform', settingsOpen && 'rotate-180')} />
            </Button>
            {!canProcess ? (
              <span className="text-xs font-medium text-amber-700">{blocker}</span>
            ) : null}
          </div>

          <Collapsible open={settingsOpen} onOpenChange={setSettingsOpen}>
            <CollapsibleContent className="space-y-5">
              <Separator />

              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                <Field label={t(locale, 'llmProvider')}>
                  <Select
                    value={form.llmProvider}
                    onValueChange={(value) => {
                      const nextCfg = config?.providers?.[value]
                      const savedSettings =
                        storedPrefs?.llm_provider_settings
                        && typeof storedPrefs.llm_provider_settings === 'object'
                          ? (storedPrefs.llm_provider_settings as Record<string, { model?: string; base_url?: string }>)[value]
                          : undefined
                      patchForm({
                        llmProvider: value,
                        llmModel: savedSettings?.model || nextCfg?.default_model || '',
                        llmBaseUrl: savedSettings?.base_url || '',
                        apiKey: loadStoredApiKey(value),
                      })
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(config ? Object.keys(config.providers) : ['qwen']).map((provider) => (
                        <SelectItem key={provider} value={provider}>{provider}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>

                <Field label={`${t(locale, 'apiKey')}${providerCfg?.api_key_configured ? ` · ${t(locale, 'apiKeyReady')}` : ''}`}>
                  <Input
                    type="password"
                    value={form.apiKey}
                    placeholder={providerCfg?.api_key_env ?? t(locale, 'apiKeyHelp')}
                    onChange={(event) => patchForm({ apiKey: event.currentTarget.value })}
                  />
                </Field>

                <Field label={t(locale, 'outputLanguage')}>
                  <Select value={form.language} onValueChange={(value) => patchForm({ language: value })}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(config?.languages ?? ['zh', 'en', 'vi']).map((language) => (
                        <SelectItem key={language} value={language}>{language}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>

                <Field label={t(locale, 'maxClips')}>
                  <Input
                    type="number"
                    min={1}
                    max={20}
                    value={form.maxClips}
                    onChange={(event) => patchForm({ maxClips: Number(event.currentTarget.value) || 1 })}
                  />
                </Field>

                <Field label={t(locale, 'clipLength')}>
                  <Select value={form.clipLengthPreset} onValueChange={(value) => patchForm({ clipLengthPreset: value })}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.entries(config?.clip_length_presets ?? { auto: { preset: 'auto', label: 'Auto' } }).map(([key, value]) => (
                        <SelectItem key={key} value={key}>{value.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>

                <Field label={t(locale, 'userIntent')} className="sm:col-span-2 lg:col-span-3">
                  <Input
                    value={form.userIntent}
                    placeholder={t(locale, 'userIntentPlaceholder')}
                    onChange={(event) => patchForm({ userIntent: event.currentTarget.value })}
                  />
                </Field>
              </div>

              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                <OptionToggle checked={form.generateCover} onCheckedChange={(checked) => patchForm({ generateCover: checked })} label={t(locale, 'generateCover')} />
                <OptionToggle checked={form.burnSubtitles} onCheckedChange={(checked) => patchForm({ burnSubtitles: checked })} label={t(locale, 'burnSubtitles')} />
                <OptionToggle checked={form.agenticAnalysis} onCheckedChange={(checked) => patchForm({ agenticAnalysis: checked })} label={t(locale, 'agenticAnalysis')} />
                <OptionToggle checked={form.addTitles} onCheckedChange={(checked) => patchForm({ addTitles: checked })} label={t(locale, 'addTitles')} />
                <OptionToggle checked={form.forceWhisper} onCheckedChange={(checked) => patchForm({ forceWhisper: checked })} label={t(locale, 'forceWhisper')} />
                <OptionToggle checked={form.useBackground} onCheckedChange={(checked) => patchForm({ useBackground: checked })} label={t(locale, 'useBackground')} />
              </div>

              {form.inputType === 'url' ? (
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label={t(locale, 'cookieMode')}>
                    <Select
                      value={form.cookieMode}
                      onValueChange={(value) => {
                        const cookieMode = value as FormState['cookieMode']
                        patchForm({
                          cookieMode,
                          cookiesFile: cookieMode === 'file' ? form.cookiesFile : '',
                        })
                        if (cookieMode !== 'file') setCookiesFileName('')
                      }}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">{t(locale, 'cookieNone')}</SelectItem>
                        <SelectItem value="browser">{t(locale, 'cookieBrowser')}</SelectItem>
                        <SelectItem value="file">{t(locale, 'cookieFile')}</SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>
                  {form.cookieMode === 'browser' ? (
                    <Field label={t(locale, 'cookieBrowserLabel')}>
                      <Select value={form.cookieBrowser} onValueChange={(value) => patchForm({ cookieBrowser: value })}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {['chrome', 'firefox', 'edge', 'safari'].map((browser) => (
                            <SelectItem key={browser} value={browser}>{browser}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </Field>
                  ) : null}
                  {form.cookieMode === 'file' ? (
                    <Field label={t(locale, 'cookiesFilePath')}>
                      <div className="space-y-2">
                        <input
                          ref={cookiesInputRef}
                          type="file"
                          accept=".txt,.cookies,text/plain"
                          className="sr-only"
                          disabled={cookiesUploading}
                          onChange={(event) => {
                            const file = event.currentTarget.files?.[0] ?? null
                            void handleCookiesUpload(file)
                          }}
                        />
                        <div className="flex flex-wrap items-center gap-2">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={cookiesUploading}
                            onClick={() => cookiesInputRef.current?.click()}
                          >
                            {cookiesUploading ? <Loader2 className="size-4 animate-spin" /> : <FileText className="size-4" />}
                            {cookiesUploading ? t(locale, 'cookiesFileUploading') : t(locale, 'cookiesFileUpload')}
                          </Button>
                          {form.cookiesFile ? (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() => {
                                patchForm({ cookiesFile: '' })
                                setCookiesFileName('')
                              }}
                            >
                              {t(locale, 'cookiesFileClear')}
                            </Button>
                          ) : null}
                        </div>
                        {form.cookiesFile ? (
                          <p className="truncate text-xs text-muted-foreground">
                            {t(locale, 'cookiesFileReady')}
                            {': '}
                            <span className="font-medium text-foreground">{cookiesFileName || form.cookiesFile.split('/').pop()}</span>
                          </p>
                        ) : (
                          <p className="text-xs text-muted-foreground">{t(locale, 'cookiesFileHint')}</p>
                        )}
                      </div>
                    </Field>
                  ) : null}
                </div>
              ) : null}

              {form.burnSubtitles ? (
                <div className="space-y-4 rounded-xl border bg-muted/40 p-4">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label={t(locale, 'subtitleTranslation')}>
                      <Select
                        value={form.subtitleTranslation ?? 'none'}
                        onValueChange={(value) => patchForm({
                          subtitleTranslation: value === 'none' ? null : value,
                        })}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">{t(locale, 'translationNone')}</SelectItem>
                          <SelectItem value="Simplified Chinese">{t(locale, 'translationZh')}</SelectItem>
                          <SelectItem value="English">{t(locale, 'translationEn')}</SelectItem>
                        </SelectContent>
                      </Select>
                    </Field>
                    <Field label={t(locale, 'subtitlePreset')}>
                      <Select value={form.subtitleStylePreset} onValueChange={(value) => patchForm({ subtitleStylePreset: value })}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {(config?.subtitle_presets ?? []).map((value) => (
                            <SelectItem key={value} value={value}>{value}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </Field>
                    <Field label={t(locale, 'subtitleSize')}>
                      <Select value={form.subtitleStyleFontSize} onValueChange={(value) => patchForm({ subtitleStyleFontSize: value })}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {(config?.subtitle_sizes ?? []).map((value) => (
                            <SelectItem key={value} value={value}>{value}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </Field>
                    <Field label={t(locale, 'subtitlePosition')}>
                      <Select value={form.subtitleStyleVerticalPosition} onValueChange={(value) => patchForm({ subtitleStyleVerticalPosition: value })}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {(config?.subtitle_positions ?? []).map((value) => (
                            <SelectItem key={value} value={value}>{value}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </Field>
                  </div>
                  {previewLoading ? <p className="text-sm text-muted-foreground">{t(locale, 'previewLoading')}</p> : null}
                  {previewUrl ? (
                    <div className="overflow-hidden rounded-lg border bg-black">
                      <img src={previewUrl} alt="" className="block w-full" />
                    </div>
                  ) : null}
                </div>
              ) : null}

              <Collapsible className="group overflow-hidden rounded-xl border bg-muted/30">
                <CollapsibleTrigger className="flex w-full items-center gap-3 px-4 py-3.5 text-left outline-none transition-colors hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring/40">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-foreground">{t(locale, 'advanced')}</p>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">{t(locale, 'advancedHint')}</p>
                  </div>
                  <div className="flex size-8 shrink-0 items-center justify-center rounded-lg border bg-card shadow-xs">
                    <ChevronDown className="size-4 text-muted-foreground transition-transform duration-200 group-data-[state=open]:rotate-180" />
                  </div>
                </CollapsibleTrigger>
                <CollapsibleContent className="space-y-4 border-t bg-card px-4 py-4">
                  <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    <Field label={t(locale, 'llmModel')}>
                      <Input
                        value={form.llmModel}
                        placeholder={providerCfg?.default_model || ''}
                        onChange={(event) => patchForm({ llmModel: event.currentTarget.value })}
                      />
                    </Field>
                    <Field label={t(locale, 'llmBaseUrl')}>
                      <Input
                        value={form.llmBaseUrl}
                        placeholder={providerCfg?.base_url || ''}
                        onChange={(event) => patchForm({ llmBaseUrl: event.currentTarget.value })}
                      />
                    </Field>
                    <Field label={t(locale, 'outputDir')}>
                      <Input
                        value={form.outputDir}
                        onChange={(event) => patchForm({ outputDir: event.currentTarget.value })}
                        onBlur={() => { void refreshUploads(form.outputDir) }}
                      />
                    </Field>
                    {config?.whisperx_available ? (
                      <Field label={t(locale, 'speakerRefs')}>
                        <Input
                          value={form.speakerReferencesDir}
                          onChange={(event) => patchForm({ speakerReferencesDir: event.currentTarget.value })}
                        />
                      </Field>
                    ) : null}
                  </div>
                  <OptionToggle
                    checked={form.useCustomPrompt}
                    onCheckedChange={(checked) => patchForm({ useCustomPrompt: checked })}
                    label={t(locale, 'customPrompt')}
                  />
                  {form.useCustomPrompt ? (
                    <Textarea
                      value={form.customPromptText}
                      onChange={(event) => patchForm({ customPromptText: event.currentTarget.value })}
                      rows={6}
                    />
                  ) : null}
                </CollapsibleContent>
              </Collapsible>

              <div className="flex flex-col items-end gap-2 sm:flex-row sm:justify-end">
                <p className="mr-auto max-w-md text-xs text-muted-foreground">{t(locale, 'saveHint')}</p>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setForm({
                      ...defaultFormState(config),
                      apiKey: loadStoredApiKey(config?.default_provider ?? form.llmProvider),
                    })
                    setResult(null)
                    setResultJobId(null)
                  }}
                >
                  {t(locale, 'reset')}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={savingPrefs}
                  onClick={() => void handleSavePreferences(true)}
                >
                  {savingPrefs ? <Loader2 className="size-4 animate-spin" /> : null}
                  {t(locale, 'save')}
                </Button>
              </div>
            </CollapsibleContent>
          </Collapsible>
        </CardContent>
      </Card>

      <section className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <h2 className="font-[Syne] text-lg font-semibold tracking-tight">{t(locale, 'jobs')}</h2>
          {stats ? (
            <div className="flex gap-3 text-xs text-muted-foreground">
              <span>{stats.processing} {t(locale, 'processing')}</span>
              <span>{stats.completed} {t(locale, 'completed')}</span>
              <span>{stats.failed} {t(locale, 'failed')}</span>
            </div>
          ) : null}
        </div>

        {jobs.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
              <Clapperboard className="size-8 text-muted-foreground/60" />
              <p className="font-medium">{t(locale, 'emptyJobsTitle')}</p>
              <p className="text-sm text-muted-foreground">{t(locale, 'emptyJobsHint')}</p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {jobs.map((job) => {
              const open = resultJobId === job.id
              return (
                <Card key={job.id} className={cn(job.status === 'processing' && 'border-primary/30')}>
                  <CardHeader className="items-start">
                    <div className="min-w-0 flex-1">
                      <CardTitle className="truncate text-base" title={job.video_source}>
                        {truncate(job.video_source)}
                      </CardTitle>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {job.id.slice(0, 8)} · {formatTime(job.created_at, locale)}
                        {job.current_step ? ` · ${job.current_step}` : ''}
                      </p>
                    </div>
                    <Badge variant={statusVariant(job.status)}>{t(locale, job.status)}</Badge>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {(job.status === 'processing' || job.status === 'pending') ? (
                      <div className="flex items-center gap-3">
                        <Progress value={Math.min(Math.max(job.progress, 3), 100)} className="flex-1" />
                        <span className="w-10 text-right text-xs font-semibold text-primary">
                          {Math.round(job.progress)}%
                        </span>
                      </div>
                    ) : null}

                    {job.error ? (
                      <Alert variant="destructive">
                        <AlertDescription>{job.error}</AlertDescription>
                      </Alert>
                    ) : null}

                    <div className="flex flex-wrap gap-2">
                      {job.status === 'completed' && !job.is_editor_rerender ? (
                        <Button type="button" size="sm" variant="outline" onClick={() => toggleResult(job)}>
                          {open ? t(locale, 'clearResults') : t(locale, 'view')}
                        </Button>
                      ) : null}
                      {job.status === 'completed' && (hasEditorProject(job) || job.is_editor_rerender) ? (
                        <Button type="button" size="sm" onClick={() => void handleOpenEditor(job)}>
                          {t(locale, 'openEditor')}
                        </Button>
                      ) : null}
                      {(job.status === 'processing' || job.status === 'pending') ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            void cancelJob(job.id).then(refreshJobs)
                              .catch((error) => notify(error instanceof Error ? error.message : String(error), 'error'))
                          }}
                        >
                          {t(locale, 'cancel')}
                        </Button>
                      ) : null}
                      {(job.status === 'failed' || job.status === 'cancelled') ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={Boolean(job.options.source_deleted)}
                          onClick={() => {
                            void retryJob(job.id).then(refreshJobs)
                              .catch((error) => notify(error instanceof Error ? error.message : String(error), 'error'))
                          }}
                        >
                          {t(locale, 'retry')}
                        </Button>
                      ) : null}
                      <Button
                        type="button"
                        size="sm"
                        variant="destructive"
                        onClick={() => {
                          if (!window.confirm(t(locale, 'confirmDeleteJob'))) return
                          void deleteJob(job.id).then(() => {
                            if (resultJobId === job.id) {
                              setResult(null)
                              setResultJobId(null)
                            }
                            return refreshJobs()
                          }).catch((error) => notify(error instanceof Error ? error.message : String(error), 'error'))
                        }}
                      >
                        <Trash2 className="size-3.5" />
                        {t(locale, 'delete')}
                      </Button>
                    </div>

                    {open && result ? (
                      <div className="space-y-3 border-t pt-3">
                        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                          {result.processing_time != null ? (
                            <span>{t(locale, 'processingTime')}: {result.processing_time.toFixed(1)}s</span>
                          ) : null}
                          {result.transcript_source ? (
                            <span>{t(locale, 'transcriptSource')}: {result.transcript_source}</span>
                          ) : null}
                        </div>
                        {moments.length > 0 ? (
                          <div className="space-y-2">
                            <p className="text-sm font-semibold">{t(locale, 'moments')}</p>
                            {moments.map((moment, index) => (
                              <div key={`${moment.title}-${index}`} className="border-l-2 border-primary pl-3">
                                <p className="text-sm font-medium">{index + 1}. {moment.title ?? 'Untitled'}</p>
                                <p className="text-xs text-muted-foreground">
                                  {[moment.start_time, moment.end_time].filter(Boolean).join(' → ')}
                                  {moment.reason ? ` · ${moment.reason}` : ''}
                                </p>
                              </div>
                            ))}
                          </div>
                        ) : null}
                        {result.editor_project?.project_id ? (
                          <Button
                            type="button"
                            onClick={() => {
                              void launchEditor(
                                result.editor_project!.project_id,
                                result.editor_project!.projects_root ?? undefined,
                              ).then(({ editor_url }) => {
                                navigate(editor_url)
                                notify(t(locale, 'editorLaunched'))
                              }).catch((error) => notify(error instanceof Error ? error.message : String(error), 'error'))
                            }}
                          >
                            {t(locale, 'openEditor')}
                          </Button>
                        ) : null}
                      </div>
                    ) : null}
                  </CardContent>
                </Card>
              )
            })}
          </div>
        )}
      </section>

      {uploads.length > 0 ? (
        <section className="mt-8 space-y-3">
          <h2 className="font-[Syne] text-lg font-semibold tracking-tight">{t(locale, 'uploads')}</h2>
          <div className="space-y-2">
            {uploads.map((upload) => (
              <Card key={upload.upload_id}>
                <CardContent className="flex items-center justify-between gap-3 py-4">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{upload.original_filename}</p>
                    <p className="text-xs text-muted-foreground">
                      {formatTime(upload.created_at, locale)}
                      {upload.in_use ? ` · ${t(locale, 'inUse')}` : ''}
                    </p>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="destructive"
                    disabled={Boolean(upload.in_use)}
                    onClick={() => {
                      if (!window.confirm(t(locale, 'confirmDeleteUpload'))) return
                      void deleteUpload(upload.upload_id, form.outputDir)
                        .then(() => refreshUploads())
                        .then(() => {
                          if (form.uploadId === upload.upload_id) {
                            patchForm({ uploadId: null, uploadFileName: '', videoSource: '' })
                          }
                        })
                        .catch((error) => notify(error instanceof Error ? error.message : String(error), 'error'))
                    }}
                  >
                    <Trash2 className="size-3.5" />
                    {t(locale, 'delete')}
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  )
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, Clapperboard, Loader2, RotateCcw } from 'lucide-react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import './editor.css'
import {
  clampBoundsWithinRange,
  emptyProject,
  formatApiTimestamp,
  formatTimestamp,
  getDirtyState,
  projectFromManifest,
  type ClipDraft,
  type EditorProject,
  type SubtitleSegmentDraft,
  serializeSubtitleSegments,
  subtitleSegmentsToText,
} from './editorState'
import { t, type Locale, type MessageKey } from './i18n'

const editorEndpoints = [
  'GET /api/projects/:project_id',
  'PATCH /api/projects/:project_id/clips/:clip_id/bounds',
  'PATCH /api/projects/:project_id/clips/:clip_id/subtitle',
  'PATCH /api/projects/:project_id/clips/:clip_id/translated-subtitle',
  'PATCH /api/projects/:project_id/clips/:clip_id/cover-title',
  'POST /api/projects/:project_id/clips/:clip_id/rerender/boundary',
  'POST /api/projects/:project_id/clips/:clip_id/rerender/subtitles',
  'POST /api/projects/:project_id/clips/:clip_id/rerender/cover',
  'POST /api/projects/:project_id/clips/:clip_id/resume',
  'GET /api/jobs/:job_id',
]

const emptyDirtyState = {
  hasChanges: false,
  boundsDirty: false,
  speedDirty: false,
  boundaryDirty: false,
  sourceSubtitlesDirty: false,
  translatedSubtitlesDirty: false,
  subtitlesDirty: false,
  coverTitleDirty: false,
  coverNeedsRefresh: false,
}

const speedOptions = [1, 1.25, 1.5, 2, 3]

const jobPollIntervalMs = 1000
const jobPollTimeoutMs = 5 * 60 * 1000
const reconciliationPollIntervalMs = 300
const reconciliationTimeoutMs = 3000
const loadProjectFailedError = 'openclip_load_project_failed'

interface LoadedProjectResult {
  project: EditorProject
  statusMessage: UiText
  logMessage: UiText
}

interface PreviewWindow {
  start: number
  end: number
  sourceVideoUrl?: string
}

type MessageValues = Record<string, string | number>
type UiText = { key: MessageKey; values?: MessageValues } | { raw: string }

const languageStorageKey = 'openclip-editor-language'

function loadInitialLocale(): Locale {
  try {
    const storedLocale = window.localStorage.getItem(languageStorageKey)
    return storedLocale === 'en' ? 'en' : 'zh'
  } catch {
    return 'zh'
  }
}

function withVersionToken(url?: string, version?: string): string | undefined {
  if (!url) {
    return undefined
  }
  if (!version) {
    return url
  }
  const separator = url.includes('?') ? '&' : '?'
  return `${url}${separator}v=${encodeURIComponent(version)}`
}

function message(key: MessageKey, values?: MessageValues): UiText {
  return { key, values }
}

function rawMessage(text: string): UiText {
  return { raw: text }
}

function formatSpeedLabel(speed: number): string {
  return `${speed}x`
}

function buildPreviewWindow(clip?: ClipDraft, projectSourceVideoUrl?: string): PreviewWindow | null {
  if (!clip) {
    return null
  }
  return {
    start: clip.start,
    end: clip.end,
    sourceVideoUrl: clip.sourceVideoUrl ?? projectSourceVideoUrl,
  }
}

function loadFailureMessage(error: unknown, projectId: string): UiText {
  if (error instanceof Error && error.message === loadProjectFailedError) {
    return message('unableLoadManifestProject', { projectId })
  }
  if (error instanceof Error) {
    return rawMessage(error.message)
  }
  return message('unableLoadProject')
}

function withProjectsRoot(path: string, projectsRoot: string | null): string {
  if (!projectsRoot) return path
  const separator = path.includes('?') ? '&' : '?'
  return `${path}${separator}projects_root=${encodeURIComponent(projectsRoot)}`
}

function subtitleTextareaRows(text: string): number {
  const estimatedRows = text.split('\n').reduce((rows, line) => {
    return rows + Math.max(1, Math.ceil(Math.max(line.length, 1) / 56))
  }, 0)
  return Math.max(2, Math.min(3, estimatedRows))
}

function EditorPage() {
  const { projectId: routeProjectId = '' } = useParams<{ projectId: string }>()
  const [searchParams] = useSearchParams()
  const projectId = decodeURIComponent(routeProjectId)
  const projectsRoot = searchParams.get('projects_root')
  const editorApi = useCallback(
    (path: string) => withProjectsRoot(path, projectsRoot),
    [projectsRoot],
  )
  const [savedProject, setSavedProject] = useState<EditorProject>(() => emptyProject(projectId))
  const [draftProject, setDraftProject] = useState<EditorProject>(() => emptyProject(projectId))
  const [activeClipId, setActiveClipId] = useState('')
  const [activityLog, setActivityLog] = useState<UiText[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<UiText | null>(null)
  const [statusMessage, setStatusMessage] = useState<UiText>(message('loadingEditorProject'))
  const [dragHandle, setDragHandle] = useState<'start' | 'end' | null>(null)
  const [locale, setLocale] = useState<Locale>(loadInitialLocale)
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false)

  const timelineTrackRef = useRef<HTMLDivElement | null>(null)
  const previewVideoRef = useRef<HTMLVideoElement | null>(null)
  const subtitlePreviewVideoRef = useRef<HTMLVideoElement | null>(null)
  const activeClipIdRef = useRef('')

  const savedClipMap = useMemo(() => new Map(savedProject.clips.map((clip) => [clip.id, clip])), [savedProject.clips])
  const activeClip = draftProject.clips.find((clip) => clip.id === activeClipId) ?? draftProject.clips[0]
  const savedActiveClip = savedClipMap.get(activeClip?.id ?? '') ?? activeClip
  const subtitlePreviewUrl = withVersionToken(activeClip?.currentComposedClipUrl, activeClip?.updatedAt)
  const horizontalCoverPreviewUrl = withVersionToken(activeClip?.horizontalCoverUrl, activeClip?.updatedAt)
  const verticalCoverPreviewUrl = withVersionToken(activeClip?.verticalCoverUrl, activeClip?.updatedAt)
  const previewWindow = useMemo(
    () => buildPreviewWindow(activeClip, draftProject.sourceVideoUrl),
    [activeClip, draftProject.sourceVideoUrl],
  )
  const activeDirtyState = activeClip && savedActiveClip ? getDirtyState(savedActiveClip, activeClip) : emptyDirtyState
  const activePartStart = activeClip?.partAbsoluteStart ?? 0
  const activePartEnd = activeClip?.partAbsoluteEnd ?? draftProject.totalDuration
  const outputDuration = activeClip ? (activeClip.end - activeClip.start) / Math.max(activeClip.speed, 0.001) : 0
  const dirtyClipCount = draftProject.clips.filter((clip) => {
    const savedClip = savedClipMap.get(clip.id)
    return savedClip ? getDirtyState(savedClip, clip).hasChanges || Boolean(clip.coverDirty) : false
  }).length

  const resolveText = useCallback((entry: UiText) => (
    'raw' in entry ? entry.raw : t(locale, entry.key, entry.values)
  ), [locale])

  const pushLog = useCallback((entry: UiText) => {
    setActivityLog((current) => [entry, ...current].slice(0, 8))
  }, [])

  const applyLoadedProject = useCallback((result: LoadedProjectResult) => {
    const targetClip = result.project.clips.find((clip) => clip.id === activeClipIdRef.current) ?? result.project.clips[0]
    setSavedProject(result.project)
    setDraftProject(result.project)
    setActiveClipId(targetClip?.id ?? '')
    setStatusMessage(result.statusMessage)
    setLoadError(null)
    pushLog(result.logMessage)
    setLoading(false)
  }, [pushLog])

  const loadProject = useCallback(async (): Promise<LoadedProjectResult> => {
    const response = await fetch(editorApi(`/api/projects/${projectId}`))
    if (!response.ok) {
      throw new Error(loadProjectFailedError)
    }
    const manifest = await response.json()
    const project = projectFromManifest(manifest)
    return {
      project,
      statusMessage: message('loadedManifestProjectStatus', { projectName: project.projectName }),
      logMessage: message('loadedManifestProjectLog', { projectId }),
    }
  }, [editorApi, projectId])

  useEffect(() => {
    let cancelled = false

    async function initializeProject() {
      try {
        const result = await loadProject()
        if (!cancelled) {
          applyLoadedProject(result)
        }
      } catch (error) {
        if (!cancelled) {
          const nextMessage = loadFailureMessage(error, projectId)
          setLoadError(nextMessage)
          setStatusMessage(nextMessage)
          setLoading(false)
          pushLog(nextMessage)
        }
      }
    }

    void initializeProject()

    return () => {
      cancelled = true
    }
  }, [applyLoadedProject, loadProject, projectId, pushLog])

  useEffect(() => {
    try {
      window.localStorage.setItem(languageStorageKey, locale)
    } catch {
      // Ignore persistence failures and keep the in-memory locale.
    }
  }, [locale])

  useEffect(() => {
    activeClipIdRef.current = activeClipId
  }, [activeClipId])

  useEffect(() => {
    if (!dragHandle || !activeClip || !timelineTrackRef.current) {
      return undefined
    }

    function handlePointerMove(event: PointerEvent) {
      const rect = timelineTrackRef.current?.getBoundingClientRect()
      if (!rect || draftProject.totalDuration <= 0) {
        return
      }

      const ratio = Math.min(Math.max((event.clientX - rect.left) / rect.width, 0), 1)
      const nextSeconds = ratio * draftProject.totalDuration
      const clamped = dragHandle === 'start'
        ? clampBoundsWithinRange(nextSeconds, activeClip.end, draftProject.totalDuration, activePartStart, activePartEnd ?? draftProject.totalDuration)
        : clampBoundsWithinRange(activeClip.start, nextSeconds, draftProject.totalDuration, activePartStart, activePartEnd ?? draftProject.totalDuration)
      setDraftProject((current) => ({
        ...current,
        clips: current.clips.map((clip) => (
          clip.id === activeClip.id ? { ...clip, start: clamped.start, end: clamped.end, coverDirty: true } : clip
        )),
      }))
    }

    function handlePointerUp() {
      setDragHandle(null)
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
    }
  }, [activeClip, activePartEnd, activePartStart, dragHandle, draftProject.totalDuration])

  useEffect(() => {
    if (!previewVideoRef.current || !previewWindow) {
      return
    }
    const currentVideo = previewVideoRef.current
    const currentWindow = previewWindow

    function handleLoadedMetadata() {
      currentVideo.currentTime = currentWindow.start
      currentVideo.pause()
    }

    function handleTimeUpdate() {
      if (currentVideo.currentTime >= currentWindow.end) {
        currentVideo.pause()
      }
    }

    try {
      currentVideo.pause()
      currentVideo.currentTime = currentWindow.start
    } catch {
      // If metadata is not ready yet, loadedmetadata will apply the same previewWindow.
    }

    currentVideo.addEventListener('loadedmetadata', handleLoadedMetadata)
    currentVideo.addEventListener('timeupdate', handleTimeUpdate)
    return () => {
      currentVideo.removeEventListener('loadedmetadata', handleLoadedMetadata)
      currentVideo.removeEventListener('timeupdate', handleTimeUpdate)
    }
  }, [previewWindow])

  useEffect(() => {
    if (!subtitlePreviewVideoRef.current || !subtitlePreviewUrl) {
      return
    }

    const video = subtitlePreviewVideoRef.current
    const previewOffset = 0.05

    function showFirstFrame() {
      if (!Number.isFinite(video.duration) || video.duration <= 0) {
        return
      }
      const targetTime = Math.min(previewOffset, Math.max(video.duration - 0.001, 0))
      if (targetTime <= 0) {
        return
      }
      try {
        video.currentTime = targetTime
      } catch {
        // Some browsers may reject early seeks until the media is a little further along.
      }
    }

    function handleSeeked() {
      video.pause()
    }

    video.addEventListener('loadedmetadata', showFirstFrame)
    video.addEventListener('seeked', handleSeeked)

    if (video.readyState >= 1) {
      showFirstFrame()
    }

    return () => {
      video.removeEventListener('loadedmetadata', showFirstFrame)
      video.removeEventListener('seeked', handleSeeked)
    }
  }, [subtitlePreviewUrl])

  function getOperationLabel(action: 'boundary' | 'subtitles' | 'cover'): string {
    const operationKeys: Record<'boundary' | 'subtitles' | 'cover', MessageKey> = {
      boundary: 'operationBoundary',
      subtitles: 'operationSubtitle',
      cover: 'operationCover',
    }
    return t(locale, operationKeys[action])
  }

  function getDirtyStateLabel(state: typeof emptyDirtyState): string {
    if (!state.hasChanges && !state.coverNeedsRefresh) {
      return t(locale, 'noLocalChanges')
    }
    const tokens = []
    if (state.boundsDirty) tokens.push(t(locale, 'dirtyTokenBounds'))
    if (state.speedDirty) tokens.push(t(locale, 'dirtyTokenSpeed'))
    if (state.subtitlesDirty) tokens.push(t(locale, 'dirtyTokenSubtitles'))
    if (state.coverNeedsRefresh) tokens.push(t(locale, 'dirtyTokenCover'))
    return t(locale, 'dirtySummary', { items: tokens.join(' + ') })
  }

  function getRenderStatusLabel(status: ClipDraft['renderStatus']): string {
    const renderStatusKeys: Record<ClipDraft['renderStatus'], MessageKey> = {
      Ready: 'renderStatusReady',
      'Needs sync': 'renderStatusNeedsSync',
      Rendering: 'renderStatusRendering',
      Recoverable: 'renderStatusRecoverable',
      Error: 'renderStatusError',
    }
    return t(locale, renderStatusKeys[status])
  }

  async function assertOk(response: Response, action: string) {
    if (!response.ok) {
      throw new Error(`${action} failed with status ${response.status}`)
    }
  }

  function updateClip(id: string, updater: (clip: ClipDraft) => ClipDraft) {
    setDraftProject((current) => ({
      ...current,
      clips: current.clips.map((clip) => (clip.id === id ? updater(clip) : clip)),
    }))
  }

  function updateBoundsLocally(nextStart: number, nextEnd: number) {
    if (!activeClip) return
    const clamped = clampBoundsWithinRange(
      nextStart,
      nextEnd,
      draftProject.totalDuration,
      activePartStart,
      activePartEnd ?? draftProject.totalDuration,
    )
    updateClip(activeClip.id, (clip) => ({
      ...clip,
      start: clamped.start,
      end: clamped.end,
      coverDirty: true,
    }))
  }

  async function patchClip(clip: ClipDraft) {
    const savedClip = savedClipMap.get(clip.id)
    if (!savedClip) return

    if (savedClip.start !== clip.start || savedClip.end !== clip.end || savedClip.speed !== clip.speed) {
      const response = await fetch(editorApi(`/api/projects/${projectId}/clips/${clip.id}/bounds`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          start_time: formatApiTimestamp(clip.start),
          end_time: formatApiTimestamp(clip.end),
          speed: clip.speed,
        }),
      })
      await assertOk(response, 'Saving clip bounds')
    }
    if (serializeSubtitleSegments(savedClip.subtitleSegments) !== serializeSubtitleSegments(clip.subtitleSegments)) {
      const response = await fetch(editorApi(`/api/projects/${projectId}/clips/${clip.id}/subtitle`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subtitle_text: clip.subtitleText,
          subtitle_segments: clip.subtitleSegments.map((segment) => ({
            start_time: segment.startTime,
            end_time: segment.endTime,
            text: segment.text,
          })),
        }),
      })
      await assertOk(response, 'Saving subtitle override')
    }
    if (serializeSubtitleSegments(savedClip.translatedSubtitleSegments) !== serializeSubtitleSegments(clip.translatedSubtitleSegments)) {
      const response = await fetch(editorApi(`/api/projects/${projectId}/clips/${clip.id}/translated-subtitle`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subtitle_text: clip.translatedSubtitleText,
          subtitle_segments: clip.translatedSubtitleSegments.map((segment) => ({
            start_time: segment.startTime,
            end_time: segment.endTime,
            text: segment.text,
          })),
        }),
      })
      await assertOk(response, 'Saving translated subtitle override')
    }
    if (savedClip.coverTitle !== clip.coverTitle) {
      const response = await fetch(editorApi(`/api/projects/${projectId}/clips/${clip.id}/cover-title`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title_text: clip.coverTitle }),
      })
      await assertOk(response, 'Saving cover title')
    }
  }

  async function loadProjectUntilJobReconciled(jobId: string, clipId: string): Promise<LoadedProjectResult> {
    let latestResult: LoadedProjectResult | null = null
    const deadline = Date.now() + reconciliationTimeoutMs
    while (Date.now() < deadline) {
      latestResult = await loadProject()
      const latestClip = latestResult.project.clips.find((clip) => clip.id === clipId)
      if (!latestClip?.pendingJobId || latestClip.pendingJobId !== jobId) {
        return latestResult
      }
      await new Promise((resolve) => setTimeout(resolve, reconciliationPollIntervalMs))
    }
    return latestResult ?? loadProject()
  }

  function handleResetClip() {
    if (!activeClip) return
    const savedClip = savedClipMap.get(activeClip.id)
    if (!savedClip) return
    updateClip(activeClip.id, () => ({
      ...savedClip,
      renderStatus: 'Ready',
      lastError: undefined,
      pendingJobId: undefined,
      pendingOperation: undefined,
      recoveryState: undefined,
    }))
    setStatusMessage(message('resetClipLog', { title: activeClip.title }))
    pushLog(message('resetClipLog', { title: activeClip.title }))
  }

  async function pollJob(jobId: string, clipId: string) {
    const deadline = Date.now() + jobPollTimeoutMs
    while (Date.now() < deadline) {
      const response = await fetch(`/api/jobs/${jobId}`)
      if (response.ok) {
        const job = await response.json()
        const status = typeof job.status === 'string' ? job.status : job.status?.value
        if (status === 'completed') {
          pushLog(message('jobCompletedLog', { jobId }))
          applyLoadedProject(await loadProjectUntilJobReconciled(jobId, clipId))
          return
        }
        if (status === 'failed' || status === 'cancelled') {
          updateClip(clipId, (clip) => ({
            ...clip,
            renderStatus: 'Error',
            lastError: job.error ?? `Job ${status}.`,
            pendingJobId: undefined,
            pendingOperation: undefined,
          }))
          setStatusMessage(job.error ? rawMessage(job.error) : message('jobEndedStatus', { status }))
          pushLog(message('jobEndedLog', { jobId, status }))
          return
        }
      }
      await new Promise((resolve) => setTimeout(resolve, jobPollIntervalMs))
    }

    updateClip(clipId, (clip) => ({
      ...clip,
      renderStatus: 'Error',
      lastError: t(locale, 'timedOutWaitingRerenderStatus'),
      pendingJobId: undefined,
      pendingOperation: undefined,
    }))
    setStatusMessage(message('timedOutWaitingRerenderStatus'))
    pushLog(message('timedOutWaitingJobLog', { jobId }))
  }

  async function handleQueue(action: 'boundary' | 'subtitles' | 'cover') {
    if (!activeClip || activeClip.renderStatus === 'Rendering') return
    try {
      await patchClip(activeClip)
      const response = await fetch(editorApi(`/api/projects/${projectId}/clips/${activeClip.id}/rerender/${action}`), { method: 'POST' })
      await assertOk(response, t(locale, 'queueRerender', { operation: getOperationLabel(action) }))
      const payload = await response.json()
      const queuedStatus = message('queuedRerenderStatus', { operation: getOperationLabel(action), title: activeClip.title })
      setStatusMessage(queuedStatus)
      pushLog(message('queuedRerenderLog', { operation: getOperationLabel(action), jobId: payload.job_id }))
      if (action === 'boundary') {
        applyLoadedProject(await loadProject())
        setStatusMessage(queuedStatus)
      } else {
        updateClip(activeClip.id, (clip) => ({
          ...clip,
          renderStatus: 'Rendering',
          pendingJobId: payload.job_id,
          pendingOperation: action,
          lastError: undefined,
        }))
      }
      void pollJob(payload.job_id, activeClip.id)
    } catch (error) {
      const nextMessage = error instanceof Error ? error.message : t(locale, 'unableQueueRerender', { operation: getOperationLabel(action) })
      updateClip(activeClip.id, (clip) => ({ ...clip, renderStatus: 'Error', lastError: nextMessage }))
      setStatusMessage(rawMessage(nextMessage))
      pushLog(rawMessage(nextMessage))
    }
  }

  async function handleResume() {
    if (!activeClip) return
    try {
      const response = await fetch(editorApi(`/api/projects/${projectId}/clips/${activeClip.id}/resume`), { method: 'POST' })
      await assertOk(response, t(locale, 'resumingRerender'))
      const payload = await response.json()
      pushLog(message('resumedRerenderLog', { operation: getOperationLabel(payload.operation), jobId: payload.job_id }))
      updateClip(activeClip.id, (clip) => ({
        ...clip,
        renderStatus: 'Rendering',
        pendingJobId: payload.job_id,
        lastError: undefined,
      }))
      void pollJob(payload.job_id, activeClip.id)
    } catch (error) {
      const nextMessage = error instanceof Error ? error.message : t(locale, 'unableResumeRerender')
      setStatusMessage(rawMessage(nextMessage))
      pushLog(rawMessage(nextMessage))
    }
  }

  if (loadError && draftProject.clips.length === 0) {
    return (
      <div className="mx-auto min-h-screen max-w-7xl px-4 pb-10 pt-6 sm:px-6 lg:px-8">
        <header className="mb-6 flex items-center gap-3">
          <Button asChild variant="ghost" size="sm">
            <Link to="/"><ArrowLeft className="size-4" />OpenClip</Link>
          </Button>
        </header>
        <div className="mx-auto max-w-lg rounded-2xl border border-border/70 bg-card/80 p-6 shadow-[0_18px_50px_-36px_rgba(30,58,110,0.45)]">
          <h1 className="font-[Syne] text-xl font-bold">{t(locale, 'editorUnavailable')}</h1>
          <Alert variant="destructive" className="mt-4">
            <AlertDescription>{resolveText(loadError)}</AlertDescription>
          </Alert>
          <Button
            type="button"
            className="mt-4"
            onClick={() => {
              setLoading(true)
              setLoadError(null)
              void loadProject().then(applyLoadedProject).catch((error) => {
                const nextMessage = loadFailureMessage(error, projectId)
                setLoadError(nextMessage)
                setStatusMessage(nextMessage)
                setLoading(false)
                pushLog(nextMessage)
              })
            }}
          >
            {t(locale, 'retryLoad')}
          </Button>
        </div>
      </div>
    )
  }

  if (!activeClip) {
    return (
      <div className="mx-auto flex min-h-screen max-w-7xl items-center justify-center px-4 pb-10 pt-6 sm:px-6 lg:px-8">
        <div className="space-y-3 rounded-2xl border border-border/70 bg-card/80 px-8 py-10 text-center shadow-[0_18px_50px_-36px_rgba(30,58,110,0.45)]">
          <p>{t(locale, 'noClipsAvailable')}</p>
          <Button asChild variant="outline">
            <Link to="/"><ArrowLeft className="size-4" />OpenClip</Link>
          </Button>
        </div>
      </div>
    )
  }

  const timelineStart = draftProject.totalDuration > 0 ? (activeClip.start / draftProject.totalDuration) * 100 : 0
  const timelineWidth = draftProject.totalDuration > 0 ? ((activeClip.end - activeClip.start) / draftProject.totalDuration) * 100 : 0
  const previewSourceUrl = previewWindow?.sourceVideoUrl ?? activeClip.sourceVideoUrl ?? draftProject.sourceVideoUrl
  const diagnosticsStatusKind = loading ? 'loading' : loadError ? 'error' : 'connected'
  const diagnosticsStatus = loading ? t(locale, 'loadingStatus') : loadError ? t(locale, 'errorStatus') : t(locale, 'connectedStatus')
  const activePendingOperation = activeClip.pendingOperation as 'boundary' | 'subtitles' | 'cover' | undefined
  const shouldShowStatusBanner = loading
    || activeClip.renderStatus === 'Recoverable'
    || activeClip.renderStatus === 'Error'
    || activeDirtyState.hasChanges
    || activeDirtyState.coverNeedsRefresh
  const boundaryRerenderMessage = activePendingOperation === 'boundary'
    ? (activeClip.renderStatus === 'Rendering' ? t(locale, 'rerenderInProgress', { operation: getOperationLabel('boundary') }) : t(locale, 'queueing'))
    : null
  const subtitleRerenderMessage = activePendingOperation === 'subtitles'
    ? (activeClip.renderStatus === 'Rendering' ? t(locale, 'rerenderInProgress', { operation: getOperationLabel('subtitles') }) : t(locale, 'queueing'))
    : null
  const coverRerenderMessage = activePendingOperation === 'cover'
    ? (activeClip.renderStatus === 'Rendering' ? t(locale, 'rerenderInProgress', { operation: getOperationLabel('cover') }) : t(locale, 'queueing'))
    : null
  const translatedSubtitleByIndex = new Map(
    activeClip.translatedSubtitleSegments.map((segment) => [segment.index, segment]),
  )

  function subtitleCueTextareaLabel(index: number): string {
    return `${t(locale, 'subtitleOverride')} #${index}`
  }

  function translatedSubtitleCueTextareaLabel(index: number): string {
    return `${t(locale, 'translatedSubtitleTrack')} #${index}`
  }

  function updateSubtitleSegmentText(index: number, text: string, track: 'original' | 'translated' = 'original') {
    updateClip(activeClip.id, (clip) => {
      const currentSegments = track === 'translated' ? clip.translatedSubtitleSegments : clip.subtitleSegments
      const nextSegments = currentSegments.map((segment) => (
        segment.index === index
          ? { ...segment, text }
          : segment
      ))
      if (track === 'translated') {
        return {
          ...clip,
          translatedSubtitleSegments: nextSegments,
          translatedSubtitleText: subtitleSegmentsToText(nextSegments),
          hasTranslatedSubtitles: nextSegments.length > 0,
        }
      }
      return {
        ...clip,
        subtitleSegments: nextSegments,
        subtitleText: subtitleSegmentsToText(nextSegments),
      }
    })
  }

  function getQueueButtonLabel(action: 'boundary' | 'subtitles' | 'cover'): string {
    if (activePendingOperation === action) {
      return activeClip.renderStatus === 'Rendering'
        ? t(locale, 'rerenderInProgress', { operation: getOperationLabel(action) })
        : t(locale, 'queueing')
    }
    return t(locale, 'queueRerender', { operation: getOperationLabel(action) })
  }

  const statusBadgeVariant =
    diagnosticsStatusKind === 'connected' ? 'success'
      : diagnosticsStatusKind === 'loading' ? 'info'
        : 'destructive'

  return (
    <div className="editor-shell mx-auto min-h-screen max-w-7xl px-4 pb-12 pt-5 sm:px-6 lg:px-8">
      <header className="editor-topbar mb-5 flex flex-col gap-3 rounded-2xl border border-border/70 bg-card/70 px-4 py-3 shadow-[0_12px_40px_-28px_rgba(30,58,110,0.45)] backdrop-blur-md sm:flex-row sm:items-center sm:justify-between sm:px-5">
        <div className="flex min-w-0 items-center gap-3">
          <Button asChild variant="ghost" size="sm" className="-ml-1 shrink-0 text-muted-foreground">
            <Link to="/"><ArrowLeft className="size-3.5" />OpenClip</Link>
          </Button>
          <div className="hidden h-6 w-px bg-border sm:block" />
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <Clapperboard className="size-4" />
            </div>
            <div className="min-w-0">
              <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">{t(locale, 'openClipEditor')}</p>
              <h1 className="truncate font-[Syne] text-lg font-bold tracking-tight sm:text-xl">{draftProject.projectName}</h1>
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:justify-end">
          <div className="flex items-center gap-3 rounded-lg border border-border/60 bg-background/60 px-3 py-1.5 text-xs tabular-nums text-muted-foreground">
            <span><strong className="text-foreground">{draftProject.clips.length}</strong> {t(locale, 'clipsInBrowser')}</span>
            <span className="text-border">|</span>
            <span><strong className="text-foreground">{dirtyClipCount}</strong> {t(locale, 'dirtyClips')}</span>
            <span className="text-border">|</span>
            <span><strong className="text-foreground">{formatTimestamp(draftProject.totalDuration)}</strong></span>
          </div>
          <div className="inline-flex rounded-lg border bg-background/70 p-0.5">
            <Button type="button" size="sm" variant={locale === 'en' ? 'default' : 'ghost'} className="h-7 px-2.5" onClick={() => setLocale('en')}>EN</Button>
            <Button type="button" size="sm" variant={locale === 'zh' ? 'default' : 'ghost'} className="h-7 px-2.5" onClick={() => setLocale('zh')}>中文</Button>
          </div>
          <Badge variant={statusBadgeVariant}>{diagnosticsStatus}</Badge>
          <Button type="button" size="sm" variant="outline" className="h-8" onClick={() => setDiagnosticsOpen((open) => !open)}>
            {t(locale, 'diagnosticsLabel')}
          </Button>
        </div>
      </header>

      <p className="mb-4 truncate text-sm text-muted-foreground">
        {t(locale, 'projectLabel')} <code className="rounded bg-muted/80 px-1.5 py-0.5 text-[11px]">{draftProject.projectId}</code>
        {' · '}
        {t(locale, 'sourceLabel')} <code className="rounded bg-muted/80 px-1.5 py-0.5 text-[11px]">{draftProject.sourceLabel}</code>
        {' · '}
        {resolveText(statusMessage)}
      </p>

      <div className="grid gap-5 lg:grid-cols-[220px_minmax(0,1fr)]">
        <aside className="editor-clip-rail h-fit lg:sticky lg:top-4">
          <div className="mb-2 flex items-baseline justify-between gap-2 px-0.5">
            <h2 className="font-[Syne] text-sm font-semibold tracking-tight">{t(locale, 'clipsTitle')}</h2>
            <span className="text-[11px] text-muted-foreground">{t(locale, 'oneActiveClipAtATime')}</span>
          </div>
          <div className="space-y-1.5">
            {draftProject.clips.map((clip) => {
              const dirtyState = getDirtyState(savedClipMap.get(clip.id) ?? clip, clip)
              const isActive = clip.id === activeClip.id
              const dirty = dirtyState.hasChanges || clip.coverDirty
              return (
                <button
                  key={clip.id}
                  type="button"
                  onClick={() => setActiveClipId(clip.id)}
                  className={cn(
                    'editor-clip-item w-full rounded-xl border px-3 py-2.5 text-left transition-all duration-200',
                    isActive
                      ? 'border-primary/50 bg-primary/[0.08] shadow-[inset_3px_0_0_0_var(--primary)]'
                      : 'border-transparent bg-card/50 hover:border-border hover:bg-card',
                  )}
                >
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <span className="font-[Syne] text-xs font-bold text-muted-foreground">#{clip.order}</span>
                    <Badge variant={dirty ? 'warning' : 'secondary'} className="h-5 px-1.5 text-[10px]">
                      {getDirtyStateLabel({ ...dirtyState, coverNeedsRefresh: Boolean(clip.coverDirty) || dirtyState.coverNeedsRefresh })}
                    </Badge>
                  </div>
                  <p className="truncate text-sm font-semibold leading-snug">{clip.title}</p>
                  <p className="mt-1 truncate text-[11px] tabular-nums text-muted-foreground">
                    {formatTimestamp(clip.start)} → {formatTimestamp(clip.end)}
                  </p>
                  <p className="mt-0.5 truncate text-[11px] text-muted-foreground/80">
                    {getRenderStatusLabel(clip.renderStatus)}
                    {clip.sourcePart ? ` · ${clip.sourcePart}` : ''}
                  </p>
                </button>
              )
            })}
          </div>
        </aside>

        <div key={activeClip.id} className="editor-workspace space-y-5 animate-in fade-in-0 duration-300">
          <section className="space-y-3">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div className="min-w-0">
                <h2 className="font-[Syne] text-2xl font-bold tracking-tight">{activeClip.title}</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {activeClip.sourcePart || t(locale, 'singleSource')}
                  {' · '}
                  {t(locale, 'localLabel')} {activeClip.localTimeRange}
                  {' · '}
                  {t(locale, 'lastUpdate')} {activeClip.updatedAt}
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className={cn(
                  'shrink-0 border-border/80 bg-background/80',
                  activeDirtyState.hasChanges || activeDirtyState.coverNeedsRefresh || activeClip.renderStatus === 'Error' || activeClip.renderStatus === 'Recoverable'
                    ? 'border-amber-500/50 text-amber-800 hover:bg-amber-50 hover:text-amber-900'
                    : null,
                )}
                disabled={loading || !(
                  activeDirtyState.hasChanges
                  || activeDirtyState.coverNeedsRefresh
                  || activeClip.renderStatus === 'Error'
                  || activeClip.renderStatus === 'Recoverable'
                  || Boolean(activeClip.lastError)
                )}
                onClick={handleResetClip}
              >
                <RotateCcw className="size-3.5" />
                {t(locale, 'resetClipDraft')}
              </Button>
            </div>
            {shouldShowStatusBanner ? (
              <Alert variant={activeClip.renderStatus === 'Error' ? 'destructive' : 'default'} className="border-border/80 bg-card/80">
                <AlertDescription>
                  <span className="font-semibold">
                    {loading
                      ? t(locale, 'loadingProject')
                      : activeClip.renderStatus === 'Recoverable'
                        ? t(locale, 'recoverableRerenderDetected')
                        : activeClip.renderStatus === 'Error'
                          ? t(locale, 'editorActionFailed')
                          : t(locale, 'dirtyStateDetected')}
                  </span>
                  {(activeClip.lastError
                    || (activeClip.renderStatus === 'Recoverable' ? t(locale, 'resumeInterruptedHint') : '')
                    || ((activeDirtyState.hasChanges || activeDirtyState.coverNeedsRefresh) ? t(locale, 'queueSpecificRerenderHint') : ''))
                    ? (
                      <span className="mt-1 block text-muted-foreground">
                        {activeClip.lastError
                          ? activeClip.lastError
                          : activeClip.renderStatus === 'Recoverable'
                            ? t(locale, 'resumeInterruptedHint')
                            : activeDirtyState.hasChanges || activeDirtyState.coverNeedsRefresh
                              ? t(locale, 'queueSpecificRerenderHint')
                              : ''}
                      </span>
                    ) : null}
                </AlertDescription>
              </Alert>
            ) : null}
          </section>

          <section className="overflow-hidden rounded-2xl border border-border/70 bg-card/80 shadow-[0_18px_50px_-36px_rgba(30,58,110,0.55)]">
            <div className="editor-monitor relative bg-black">
              {previewSourceUrl ? (
                <video ref={previewVideoRef} controls preload="metadata" src={previewSourceUrl} className="aspect-video w-full bg-black" />
              ) : (
                <div className="flex aspect-video items-center justify-center bg-gradient-to-br from-slate-900 to-slate-800 px-6 text-center">
                  <p className="text-sm text-slate-300">{t(locale, 'sourceVideoPreviewUnavailable')}</p>
                </div>
              )}
              <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center justify-between px-3 py-2">
                <span className="rounded bg-black/45 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-white/90 backdrop-blur-sm">
                  {t(locale, 'timelinePreview')}
                </span>
                <span className="rounded bg-black/45 px-2 py-0.5 text-[10px] font-medium tabular-nums text-white/80 backdrop-blur-sm">
                  {formatTimestamp(activeClip.start)} → {formatTimestamp(activeClip.end)} · {formatTimestamp(outputDuration)}
                </span>
              </div>
            </div>

            <div className="space-y-4 border-t border-border/60 bg-gradient-to-b from-card to-muted/20 px-4 py-4 sm:px-5">
              <div>
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm text-muted-foreground">{t(locale, 'timelinePreviewDescription')}</p>
                  <Badge variant="info">{t(locale, 'previewAndRerender')}</Badge>
                </div>
                <div className="editor-timeline" aria-hidden="true" ref={timelineTrackRef}>
                  {draftProject.clips.map((clip) => {
                    const left = draftProject.totalDuration > 0 ? (clip.start / draftProject.totalDuration) * 100 : 0
                    const width = draftProject.totalDuration > 0 ? ((clip.end - clip.start) / draftProject.totalDuration) * 100 : 0
                    return (
                      <div
                        key={clip.id}
                        className={cn('editor-timeline__clip', clip.id === activeClip.id && 'editor-timeline__clip--active')}
                        style={{ left: `${left}%`, width: `${width}%` }}
                      >
                        <span>#{clip.order}</span>
                      </div>
                    )
                  })}
                  <div className="editor-timeline__window" style={{ left: `${timelineStart}%`, width: `${timelineWidth}%` }}>
                    <button type="button" className="editor-timeline__handle editor-timeline__handle--start" aria-label={t(locale, 'dragStartHandle')} onPointerDown={() => setDragHandle('start')} />
                    <span>#{activeClip.order}</span>
                    <button type="button" className="editor-timeline__handle editor-timeline__handle--end" aria-label={t(locale, 'dragEndHandle')} onPointerDown={() => setDragHandle('end')} />
                  </div>
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="clip-start">{t(locale, 'start')} · {formatTimestamp(activeClip.start)}</Label>
                  <input
                    id="clip-start"
                    aria-label={t(locale, 'clipStart')}
                    type="range"
                    className="w-full accent-[var(--primary)]"
                    min={activePartStart}
                    max={Math.max((activePartEnd ?? draftProject.totalDuration) - 0.1, activePartStart + 0.1)}
                    step={0.1}
                    value={activeClip.start}
                    disabled={loading}
                    onChange={(event) => updateBoundsLocally(Number(event.currentTarget.value), activeClip.end)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="clip-end">{t(locale, 'end')} · {formatTimestamp(activeClip.end)}</Label>
                  <input
                    id="clip-end"
                    aria-label={t(locale, 'clipEnd')}
                    type="range"
                    className="w-full accent-[var(--primary)]"
                    min={Math.min(activePartStart + 0.1, activePartEnd ?? draftProject.totalDuration)}
                    max={Math.max(activePartEnd ?? draftProject.totalDuration, activePartStart + 0.1)}
                    step={0.1}
                    value={activeClip.end}
                    disabled={loading}
                    onChange={(event) => updateBoundsLocally(activeClip.start, Number(event.currentTarget.value))}
                  />
                </div>
              </div>

              <div className="flex flex-wrap items-end gap-3 border-t border-border/50 pt-3">
                <Button
                  type="button"
                  disabled={loading || !activeDirtyState.boundaryDirty || Boolean(boundaryRerenderMessage)}
                  onClick={() => void handleQueue('boundary')}
                >
                  {activePendingOperation === 'boundary' ? <Loader2 className="size-4 animate-spin" /> : null}
                  {getQueueButtonLabel('boundary')}
                </Button>
                <div className="w-32 space-y-1">
                  <Label className="text-xs">{t(locale, 'playbackSpeed')}</Label>
                  <Select
                    value={String(activeClip.speed)}
                    disabled={loading}
                    onValueChange={(value) => {
                      const speed = Number(value)
                      updateClip(activeClip.id, (clip) => ({ ...clip, speed, coverDirty: true }))
                    }}
                  >
                    <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {speedOptions.map((speed) => (
                        <SelectItem key={speed} value={String(speed)}>{formatSpeedLabel(speed)}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {activeClip.renderStatus === 'Recoverable' ? (
                  <Button type="button" variant="outline" disabled={loading} onClick={() => void handleResume()}>
                    {t(locale, 'resumeRerender')}
                  </Button>
                ) : null}
                <div className="ml-auto hidden text-right text-[11px] tabular-nums text-muted-foreground sm:block">
                  <p>{t(locale, 'partLocalDebug')}: {formatTimestamp(activeClip.localStart)} → {formatTimestamp(activeClip.localEnd)}</p>
                  <p>{t(locale, 'coverState')}: {activeDirtyState.coverNeedsRefresh ? t(locale, 'needsRerender') : t(locale, 'currentAssetsUsable')}</p>
                </div>
              </div>
              {boundaryRerenderMessage ? <p className="text-sm text-muted-foreground">{boundaryRerenderMessage}</p> : null}
              {previewSourceUrl ? <p className="text-xs text-muted-foreground">{t(locale, 'previewPlaysSelectedWindow')}</p> : null}
            </div>
          </section>

          <section className="rounded-2xl border border-border/70 bg-card/70 px-4 py-4 sm:px-5">
            <div className="mb-4 flex flex-wrap items-start justify-between gap-2">
              <div>
                <h3 className="font-[Syne] text-lg font-semibold tracking-tight">{t(locale, 'subtitleEditor')}</h3>
                <p className="mt-0.5 text-sm text-muted-foreground">{t(locale, 'subtitleEditorDescription')}</p>
              </div>
              <Badge variant={activeDirtyState.subtitlesDirty ? 'warning' : 'secondary'}>
                {activeDirtyState.subtitlesDirty ? t(locale, 'dirty') : t(locale, 'clean')}
              </Badge>
            </div>
            <div className="grid gap-5 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
              <div className="space-y-3">
                <Label>{activeClip.hasTranslatedSubtitles ? t(locale, 'translatedSubtitleTrack') : t(locale, 'subtitleOverride')}</Label>
                <div className="max-h-[28rem] space-y-2 overflow-y-auto pr-1">
                  {activeClip.subtitleSegments.length > 0 ? activeClip.subtitleSegments.map((segment: SubtitleSegmentDraft) => {
                    const translatedSegment = translatedSubtitleByIndex.get(segment.index)
                    return (
                      <div key={`${segment.index}-${segment.startTime}-${segment.endTime}`} className="rounded-xl border border-border/60 bg-background/50 p-3 transition-colors hover:border-border">
                        <code className="mb-2 block text-[11px] tabular-nums text-muted-foreground">{segment.startTime} → {segment.endTime}</code>
                        <div className={cn('grid gap-2', activeClip.hasTranslatedSubtitles && 'md:grid-cols-2')}>
                          <Textarea
                            aria-label={subtitleCueTextareaLabel(segment.index)}
                            value={segment.text}
                            disabled={loading}
                            onChange={(event) => updateSubtitleSegmentText(segment.index, event.currentTarget.value, 'original')}
                            rows={subtitleTextareaRows(segment.text)}
                            className="min-h-0"
                          />
                          {activeClip.hasTranslatedSubtitles ? (
                            translatedSegment ? (
                              <Textarea
                                aria-label={translatedSubtitleCueTextareaLabel(segment.index)}
                                value={translatedSegment.text}
                                disabled={loading}
                                onChange={(event) => updateSubtitleSegmentText(segment.index, event.currentTarget.value, 'translated')}
                                rows={subtitleTextareaRows(translatedSegment.text)}
                                className="min-h-0"
                              />
                            ) : (
                              <p className="text-xs text-muted-foreground">{t(locale, 'noTranslatedSubtitleSegmentsAvailable')}</p>
                            )
                          ) : null}
                        </div>
                      </div>
                    )
                  }) : (
                    <p className="text-sm text-muted-foreground">{t(locale, 'noSubtitleSegmentsAvailable')}</p>
                  )}
                </div>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={loading || !activeDirtyState.subtitlesDirty || Boolean(subtitleRerenderMessage)}
                  onClick={() => void handleQueue('subtitles')}
                >
                  {activePendingOperation === 'subtitles' ? <Loader2 className="size-4 animate-spin" /> : null}
                  {getQueueButtonLabel('subtitles')}
                </Button>
                {subtitleRerenderMessage ? <p className="text-sm text-muted-foreground">{subtitleRerenderMessage}</p> : null}
              </div>

              <div className="overflow-hidden rounded-xl border border-border/70 bg-background/40">
                <div className="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-2.5">
                  <div>
                    <p className="text-sm font-semibold">{t(locale, 'postProcessedPreview')}</p>
                    <p className="text-xs text-muted-foreground">{t(locale, 'postProcessedPreviewDescription')}</p>
                  </div>
                  <Badge variant={subtitlePreviewUrl ? 'info' : 'secondary'}>
                    {subtitlePreviewUrl ? t(locale, 'available') : t(locale, 'unavailable')}
                  </Badge>
                </div>
                {subtitlePreviewUrl ? (
                  <div>
                    <video ref={subtitlePreviewVideoRef} key={subtitlePreviewUrl} controls preload="auto" src={subtitlePreviewUrl} className="aspect-video w-full bg-black" />
                    <p className="px-3 py-2 text-xs text-muted-foreground">{t(locale, 'latestRenderedSubtitleOutput')}</p>
                  </div>
                ) : (
                  <div className="space-y-1 px-4 py-10 text-center">
                    <p className="font-semibold">{t(locale, 'postProcessedPreviewUnavailable')}</p>
                    <p className="text-sm text-muted-foreground">{t(locale, 'noRenderedClipAvailable')}</p>
                  </div>
                )}
              </div>
            </div>
          </section>

          <section className="rounded-2xl border border-border/70 bg-card/70 px-4 py-4 sm:px-5">
            <div className="mb-4 flex flex-wrap items-start justify-between gap-2">
              <div>
                <h3 className="font-[Syne] text-lg font-semibold tracking-tight">{t(locale, 'coverTitleEditor')}</h3>
                <p className="mt-0.5 text-sm text-muted-foreground">{t(locale, 'coverTitleEditorDescription')}</p>
              </div>
              <Badge variant={activeDirtyState.coverNeedsRefresh ? 'warning' : 'secondary'}>
                {activeDirtyState.coverNeedsRefresh ? t(locale, 'needsRefresh') : t(locale, 'upToDate')}
              </Badge>
            </div>
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="cover-title">{t(locale, 'coverTitle')}</Label>
                <Input
                  id="cover-title"
                  aria-label={t(locale, 'coverTitle')}
                  value={activeClip.coverTitle}
                  disabled={loading}
                  onChange={(event) => {
                    const { value } = event.currentTarget
                    updateClip(activeClip.id, (clip) => ({ ...clip, coverTitle: value, coverDirty: true }))
                  }}
                />
              </div>
              <div className="grid gap-4 md:grid-cols-[1.2fr_0.8fr]">
                <div className="overflow-hidden rounded-xl border border-border/60 bg-background/40">
                  <div className="border-b border-border/60 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t(locale, 'horizontal')}</div>
                  {horizontalCoverPreviewUrl ? (
                    <img src={horizontalCoverPreviewUrl} alt={t(locale, 'horizontalCoverAlt', { title: activeClip.coverTitle })} className="aspect-video w-full object-cover" />
                  ) : (
                    <div className="space-y-1 px-3 py-10 text-center">
                      <p className="font-semibold">{t(locale, 'horizontalCoverUnavailable')}</p>
                      <p className="text-sm text-muted-foreground">{t(locale, 'queueHorizontalCoverRerenderHint')}</p>
                    </div>
                  )}
                  <p className="truncate px-3 py-2 text-sm">{activeClip.coverTitle}</p>
                </div>
                <div className="overflow-hidden rounded-xl border border-border/60 bg-background/40">
                  <div className="border-b border-border/60 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t(locale, 'vertical')}</div>
                  {verticalCoverPreviewUrl ? (
                    <img src={verticalCoverPreviewUrl} alt={t(locale, 'verticalCoverAlt', { title: activeClip.coverTitle })} className="mx-auto aspect-[9/16] max-h-80 object-cover" />
                  ) : (
                    <div className="space-y-1 px-3 py-10 text-center">
                      <p className="font-semibold">{t(locale, 'verticalCoverUnavailable')}</p>
                      <p className="text-sm text-muted-foreground">{t(locale, 'queueVerticalCoverRerenderHint')}</p>
                    </div>
                  )}
                  <p className="truncate px-3 py-2 text-sm">{activeClip.coverTitle}</p>
                </div>
              </div>
              <Button
                type="button"
                variant="secondary"
                disabled={loading || !activeDirtyState.coverNeedsRefresh || Boolean(coverRerenderMessage)}
                onClick={() => void handleQueue('cover')}
              >
                {activePendingOperation === 'cover' ? <Loader2 className="size-4 animate-spin" /> : null}
                {getQueueButtonLabel('cover')}
              </Button>
              {coverRerenderMessage ? <p className="text-sm text-muted-foreground">{coverRerenderMessage}</p> : null}
            </div>
          </section>
        </div>
      </div>

      {diagnosticsOpen ? (
        <div className="fixed inset-0 z-50 flex justify-end">
          <button type="button" className="absolute inset-0 bg-black/35 backdrop-blur-[2px] transition-opacity" aria-label={t(locale, 'closeDiagnosticsDrawer')} onClick={() => setDiagnosticsOpen(false)} />
          <aside className="relative z-10 flex h-full w-full max-w-md animate-in slide-in-from-right-4 duration-200 flex-col border-l bg-card shadow-2xl">
            <div className="flex items-start justify-between gap-3 border-b px-4 py-4">
              <div>
                <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">{t(locale, 'runtimeStatus')}</p>
                <h2 className="font-[Syne] text-lg font-semibold">{t(locale, 'editorDiagnostics')}</h2>
                <p className="text-sm text-muted-foreground">{t(locale, 'diagnosticsDescription')}</p>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant={loadError ? 'warning' : 'info'}>{diagnosticsStatus}</Badge>
                <Button type="button" size="sm" variant="ghost" onClick={() => setDiagnosticsOpen(false)}>{t(locale, 'close')}</Button>
              </div>
            </div>
            <div className="space-y-4 overflow-y-auto px-4 py-4">
              <section>
                <h3 className="mb-2 text-sm font-semibold">{t(locale, 'recentActivity')}</h3>
                <ul className="space-y-1.5 text-sm text-muted-foreground">
                  {activityLog.map((entry, index) => <li key={index}>{resolveText(entry)}</li>)}
                </ul>
              </section>
              <Separator />
              <section>
                <h3 className="mb-2 text-sm font-semibold">{t(locale, 'expectedServiceContract')}</h3>
                <ul className="space-y-1.5 text-xs text-muted-foreground">
                  {editorEndpoints.map((endpoint) => <li key={endpoint}><code>{endpoint}</code></li>)}
                </ul>
              </section>
            </div>
          </aside>
        </div>
      ) : null}
    </div>
  )
}

export default EditorPage

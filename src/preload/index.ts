import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { Job } from '@shared/types'
import type { MediaAsset, ParallaxBake, Project, TextSpec } from '@shared/timeline'
import type { DecisionRecord } from '@shared/project'
import type { Transcript } from '@shared/transcript'
import type { HelloResult } from '@shared/sidecar/protocol'
import type { AssetCatalog } from '@shared/assets/catalog'
import type { PackListing } from '@shared/assets/pack'
import type { TransitionDef } from '@shared/transitions/registry'
import type { EncodeSpec, EncoderId } from '@shared/render/encode'
import type { FrameRange } from '@shared/render/exportShape'
import type { MusicAnalysis } from '@shared/automation/cutPlan'
import type { Measure } from '@shared/director/gate'
import type { IngestRequest } from '@shared/ingest/args'
import type {
  CompletionRequest,
  CompletionResult,
  LlmProviderChoice,
  LlmStatus,
  OllamaConfig,
  OpenAiConfig,
  PublicDirectorConfig
} from '@shared/director/provider'

export interface ProbeResult {
  assets: MediaAsset[]
  failed: { path: string; error: string }[]
}

export type SidecarStatusMessage =
  | { state: 'starting' }
  | { state: 'ready'; hello: HelloResult }
  | { state: 'failed'; error: string }

export interface OpenedProject {
  path: string
  project: Project
  decisions: DecisionRecord[]
  savedAt: string
}

/**
 * The only bridge between renderer and main. Every entry is an explicit, narrow
 * function — no generic invoke(channel, ...) escape hatch, which would hand the
 * renderer the entire IPC surface.
 */
const api = {
  /**
   * Electron 32 removed File.path; webUtils is the supported replacement and it
   * only exists in the preload, so drag-and-drop has to route through here.
   * Returns '' for anything not backed by a real file on disk.
   */
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),

  probe: (paths: string[], fps: number): Promise<ProbeResult> =>
    ipcRenderer.invoke('media:probe', { paths, fps }),
  pickMedia: (): Promise<string[]> => ipcRenderer.invoke('dialog:pickMedia'),
  /** Choose a .cube 3D LUT. Null when the dialog was cancelled. */
  pickLut: (): Promise<string | null> => ipcRenderer.invoke('dialog:pickLut'),
  /** Looks that ship with the app — the same .cube files, already written. */
  builtInLooks: (): Promise<{ id: string; name: string; description: string; file: string }[]> =>
    ipcRenderer.invoke('looks:list'),

  startRender: (request: {
    project: Project
    outputPath: string
    canvas?: { width: number; height: number }
    crf?: number
    preset?: string
    /** Codec, quality, audio and container; absent is H.264 as it always was. */
    encode?: EncodeSpec
    /** Only these frames of the edit — the in and out points. */
    range?: FrameRange
    /** Styled captions the renderer already drew, to composite in the one pass. */
    captionOverlay?: { listPath: string; y: number; height: number }
  }): Promise<Job> => ipcRenderer.invoke('render:start', request),
  /** Which encoders work on this machine — probed once per launch, by encoding. */
  encoders: (): Promise<{ id: EncoderId; ok: boolean; reason?: string }[]> =>
    ipcRenderer.invoke('render:encoders'),
  cancelRender: (id: string): Promise<void> => ipcRenderer.invoke('render:cancel', id),
  listJobs: (): Promise<Job[]> => ipcRenderer.invoke('jobs:list'),
  clearFinished: (): Promise<void> => ipcRenderer.invoke('jobs:clearFinished'),
  graphicsSelfTest: (): Promise<{
    ok: boolean
    transparentFraction: number
    opaqueFraction: number
    bytes: number
    message: string
  }> => ipcRenderer.invoke('graphics:selftest'),

  chooseExportPath: (suggested: string): Promise<string | null> =>
    ipcRenderer.invoke('dialog:exportPath', suggested),

  saveProject: (
    project: Project,
    path: string | null,
    decisions: DecisionRecord[],
    forceDialog?: boolean
  ): Promise<string | null> =>
    ipcRenderer.invoke('project:save', { project, path, decisions, forceDialog }),
  openProject: (path?: string): Promise<OpenedProject | null> =>
    ipcRenderer.invoke('project:open', path),

  /**
   * Point missing media at files that exist.
   *
   * With `assetId`, asks for one file; without it, asks for a folder and
   * matches everything in it by name — which is the case that matters, because
   * a project arrives with a hundred clips missing.
   */
  relinkAssets: (
    assets: { id: string; path: string; size: number; source?: string }[],
    assetId?: string
  ): Promise<Record<string, string | { path: string; source: string }>> =>
    ipcRenderer.invoke('project:relink', { assets, assetId }),

  /* ------------------------------------------------------ voice-over */

  /** Whether the microphone may be opened; asks the system on macOS. */
  microphonePermission: (): Promise<boolean> => ipcRenderer.invoke('voiceover:permission'),
  /** A recorded take, converted to WAV by the main process; returns its path. */
  saveVoiceOver: (bytes: ArrayBuffer, name: string, sampleRate: number): Promise<string> =>
    ipcRenderer.invoke('voiceover:save', { bytes, name, sampleRate }),

  /* --------------------------------------------------------- settings */

  /** Everything that is the person's rather than the project's. */
  getSettings: (): Promise<Record<string, unknown>> => ipcRenderer.invoke('settings:get'),
  setSetting: (key: string, value: unknown): Promise<Record<string, unknown>> =>
    ipcRenderer.invoke('settings:set', { key, value }),

  /* --------------------------------------------- autosave and recovery */

  autosaveProject: (
    project: Project,
    path: string | null,
    decisions: DecisionRecord[]
  ): Promise<string | null> =>
    ipcRenderer.invoke('project:autosave', { project, path, decisions }),
  /** Autosaves holding work their saved file does not, newest first. */
  recoveries: (): Promise<
    { projectId: string; file: string; savedAt: number; projectPath: string | null; name: string }[]
  > => ipcRenderer.invoke('project:recoveries'),
  recoverProject: (file: string): Promise<OpenedProject | null> =>
    ipcRenderer.invoke('project:recover', file),
  clearAutosave: (projectId: string): Promise<void> =>
    ipcRenderer.invoke('project:clearAutosave', projectId),

  /* ------------------------------------------------------------- menu */

  /**
   * What the menu needs to know to enable its items.
   *
   * A send rather than an invoke: it fires on every selection change and every
   * edit, and nothing waits on the answer.
   */
  reportMenuState: (state: {
    canUndo: boolean
    canRedo: boolean
    hasSelection: boolean
    dirty: boolean
    recording: boolean
  }): void => {
    ipcRenderer.send('menu:state', state)
  },
  rememberRecent: (path: string): void => {
    ipcRenderer.send('menu:recent', path)
  },
  /** The close guard waits on this before letting the window go. */
  reportSaved: (ok: boolean): void => {
    ipcRenderer.send('project:saved', ok)
  },
  onMenuCommand: (cb: (command: string) => void): (() => void) => {
    const listener = (_e: unknown, command: string): void => cb(command)
    ipcRenderer.on('menu:command', listener)
    return () => ipcRenderer.removeListener('menu:command', listener)
  },
  /** Told when the window enters (true) or leaves (false) full screen. */
  onFullScreen: (cb: (on: boolean) => void): (() => void) => {
    const listener = (_e: unknown, on: boolean): void => cb(on === true)
    ipcRenderer.on('window:fullscreen', listener)
    return () => ipcRenderer.removeListener('window:fullscreen', listener)
  },
  exitFullScreen: (): void => {
    ipcRenderer.send('window:exitFullScreen')
  },
  onMenuOpen: (cb: (path: string) => void): (() => void) => {
    const listener = (_e: unknown, path: string): void => cb(path)
    ipcRenderer.on('menu:open', listener)
    return () => ipcRenderer.removeListener('menu:open', listener)
  },

  assetCatalog: (force?: boolean): Promise<{ catalog: AssetCatalog; root: string; exists: boolean }> =>
    ipcRenderer.invoke('assets:catalog', force),
  assetFileUrl: (relativePath: string): Promise<string> =>
    ipcRenderer.invoke('assets:fileUrl', relativePath),
  assetFontData: (relativePath: string): Promise<ArrayBuffer> =>
    ipcRenderer.invoke('assets:fontData', relativePath),

  /**
   * The downloadable asset packs, with what is installed.
   *
   * `refresh` asks main to look for a newer published list first; without it
   * this answers from what the build shipped knowing about, which is instant
   * and is a complete answer on a machine with no network.
   */
  assetPacks: (refresh?: boolean): Promise<PackListing[]> =>
    ipcRenderer.invoke('assets:packs', refresh),
  /**
   * Fetch and install one, by id — the only thing the renderer chooses. Rejects
   * if it was cancelled, so a caller that cancelled should expect that and not
   * show it as a failure.
   */
  installAssetPack: (id: string): Promise<PackListing> =>
    ipcRenderer.invoke('assets:installPack', id),
  cancelAssetPack: (id: string): Promise<void> => ipcRenderer.invoke('assets:cancelPack', id),
  /** Returns the list again, so the caller does not have to ask twice. */
  removeAssetPack: (id: string): Promise<PackListing[]> =>
    ipcRenderer.invoke('assets:removePack', id),

  onPackProgress: (
    cb: (update: { id: string; progress: number | null; message: string }) => void
  ): (() => void) => {
    const listener = (
      _e: unknown,
      update: { id: string; progress: number | null; message: string }
    ): void => cb(update)
    ipcRenderer.on('assets:packProgress', listener)
    return () => ipcRenderer.removeListener('assets:packProgress', listener)
  },
  transitionLibrary: (): Promise<TransitionDef[]> => ipcRenderer.invoke('transitions:library'),
  placeAsset: (file: string, fps: number): Promise<MediaAsset> =>
    ipcRenderer.invoke('assets:place', { file, fps }),
  /** Plain text to a transparent PNG. Returns the file path. */
  renderText: (options: {
    spec: Omit<TextSpec, 'version'>
    clipId: string
    width: number
    height: number
  }): Promise<string> => ipcRenderer.invoke('titles:text', options),

  /** Save a PNG the renderer drew — text, where the fonts actually live. */
  /** One frame of an animated text clip. Returns the ffmpeg image2 pattern. */
  writeTitleFrame: (clipId: string, frame: number, bytes: ArrayBuffer): Promise<string> =>
    ipcRenderer.invoke('titles:frame', { clipId, frame, bytes }),
  clearTitleFrames: (clipId: string): Promise<void> =>
    ipcRenderer.invoke('titles:clearFrames', clipId),

  writeTitleImage: (clipId: string, bytes: ArrayBuffer): Promise<string> =>
    ipcRenderer.invoke('titles:write', { clipId, bytes }),

  /** One distinct picture of a styled caption. Returns the path it was written to. */
  writeCaptionFrame: (index: number, bytes: ArrayBuffer): Promise<string> =>
    ipcRenderer.invoke('captions:frame', { index, bytes }),
  /** The concat list naming those pictures and how long each holds. */
  writeCaptionList: (text: string): Promise<string> =>
    ipcRenderer.invoke('captions:list', text),
  clearCaptionFrames: (): Promise<void> => ipcRenderer.invoke('captions:clearFrames'),

  renderSolid: (options: {
    color: string
    opacity: number
    clipId: string
    width: number
    height: number
  }): Promise<string> => ipcRenderer.invoke('titles:solid', options),

  titleSlots: (template: string): Promise<{ index: number; placeholder: string }[]> =>
    ipcRenderer.invoke('titles:slots', template),
  renderTitle: (options: {
    template: string
    texts: string[]
    clipId: string
    width: number
    height: number
  }): Promise<string> => ipcRenderer.invoke('titles:render', options),

  /** Times come back relative to `startMs`, not to the file. */
  analyseBeats: (
    path: string,
    range?: { startMs?: number; endMs?: number }
  ): Promise<MusicAnalysis & { onsets: number[]; windowStartMs: number }> =>
    ipcRenderer.invoke('audio:beats', { path, ...range }),

  peaks: (path: string, buckets?: number): Promise<{ values: number[]; buckets: number; durationMs: number }> =>
    ipcRenderer.invoke('media:peaks', { path, buckets }),

  /** Cut a photo into depth planes. Slow once, then cached on disk. */
  bakeParallax: (request: {
    assetId: string
    path: string
    layers?: number
    /** Cut the subject out properly rather than taking a depth band. */
    subject?: boolean
  }): Promise<ParallaxBake & { cached: boolean; reason?: string }> =>
    ipcRenderer.invoke('depth:layers', request),

  cancelParallax: (assetId: string): Promise<void> =>
    ipcRenderer.invoke('depth:cancel', assetId),

  /**
   * Sharpness, exposure and a perceptual hash per photo (the Director's gate),
   * with each file's `size:mtime` cache key. `unavailable` when the sidecar
   * cannot measure — the gate then lets every photo through.
   */
  measurePhotos: (
    paths: string[]
  ): Promise<{
    measures: ({ path: string; error?: string } & Partial<Measure>)[]
    keys: Record<string, string | null>
    unavailable?: string
  }> => ipcRenderer.invoke('vision:measure', { paths }),

  /** Each file's `size:mtime`, the key the Director's looks are cached under. */
  fileKeys: (paths: string[]): Promise<Record<string, string | null>> =>
    ipcRenderer.invoke('media:fileKeys', { paths }),

  onParallaxProgress: (
    cb: (update: { assetId: string; progress: number | null; message?: string }) => void
  ): (() => void) => {
    const listener = (
      _e: unknown,
      update: { assetId: string; progress: number | null; message?: string }
    ): void => cb(update)
    ipcRenderer.on('depth:progress', listener)
    return () => ipcRenderer.removeListener('depth:progress', listener)
  },

  /**
   * Split a song into a voice track and an instrumental.
   *
   * The instrumental is a real separation — anything mixed dead centre cancels.
   * The voice is an EMPHASIS, and `quality` says so; it exists to be legible to
   * speech recognition, not to be listened to on its own.
   */
  splitStems: (
    path: string,
    /** 'separated' asks the sidecar for a real stem; it falls back on its own. */
    quality?: 'separated' | 'emphasised'
  ): Promise<{
    instrumental: string
    voice: string
    backend: string
    quality: 'separated' | 'emphasised'
  }> => ipcRenderer.invoke('audio:stems', { path, quality }),

  /** Is yt-dlp on this machine — and if not, why not. Never fetches. */
  ingestStatus: (): Promise<{
    ready: boolean
    tool: { path: string; source: 'env' | 'managed' | 'path'; version: string | null } | null
    reason: string | null
  }> => ipcRenderer.invoke('ingest:status'),

  /**
   * Start a download. It appears in the job list beside the exports, with the
   * same bar and the same cancel; watch `onJobsChanged` for it to read `done`,
   * then `collectIngest` it.
   */
  startIngest: (request: IngestRequest): Promise<Job> => ipcRenderer.invoke('ingest:start', request),

  /** The finished file as an asset, named after the video rather than the file. */
  collectIngest: (
    jobId: string,
    fps: number
  ): Promise<{
    /** Where the file actually is — not always inside the downloads folder. */
    path: string
    asset: MediaAsset
    cached: boolean
    /** The fast range path was taken: the ends are loose and want trimming. */
    approximateRange: boolean
    requestedRange: { startMs: number; endMs: number } | null
    /**
     * For instrumental/vocal: which backend answered. `emphasised` is mid/side
     * and is an emphasis, not a stem — the name already says so, and a UI that
     * shows this should not promise more.
     */
    stems: { backend: string; quality: 'separated' | 'emphasised' } | null
  }> => ipcRenderer.invoke('ingest:collect', { jobId, fps }),

  /** Which speech engines are usable, and why not when they are not. */
  voiceStatus: (): Promise<
    { id: 'kokoro' | 'hosted'; label: string; kind: 'local' | 'hosted'; ready: boolean; reason: string | null }[]
  > => ipcRenderer.invoke('voice:status'),

  voiceOptions: (
    provider?: 'auto' | 'kokoro' | 'hosted'
  ): Promise<{ id: string; label: string; language: string }[]> =>
    ipcRenderer.invoke('voice:voices', { provider }),

  /** Speak some words. Comes back as a wav on disk, ready to import. */
  speak: (request: {
    text: string
    voice?: string
    speed?: number
    provider?: 'auto' | 'kokoro' | 'hosted'
  }): Promise<{
    path: string
    durationMs: number
    provider: 'kokoro' | 'hosted'
    voice: string
    cached: boolean
  }> => ipcRenderer.invoke('voice:speak', request),

  /** Which language models are usable, and why not when they are not. */
  directorStatus: (): Promise<LlmStatus[]> => ipcRenderer.invoke('director:status'),
  /** The models the Ollama server has pulled. Rejects when it is not running. */
  directorModels: (): Promise<string[]> => ipcRenderer.invoke('director:models'),
  /** The provider config, with the key replaced by whether there is one. */
  directorSettings: (): Promise<PublicDirectorConfig> => ipcRenderer.invoke('director:settings'),
  /** Change part of it. A field that is absent keeps what is there. */
  setDirectorSettings: (patch: {
    provider?: LlmProviderChoice
    ollama?: Partial<OllamaConfig>
    openai?: Partial<OpenAiConfig>
  }): Promise<PublicDirectorConfig> => ipcRenderer.invoke('director:setSettings', patch),
  /**
   * One structured completion: prompts and a schema in, the model's text out.
   * Parse and validate it in the renderer — this only carries it.
   */
  directorComplete: (request: CompletionRequest): Promise<CompletionResult> =>
    ipcRenderer.invoke('director:complete', request),

  transcribe: (request: {
    assetId: string
    path: string
    language?: string
    model?: string
    /** Names and words to listen for (transcript.ts vocabularyPrompt). */
    initialPrompt?: string
  }): Promise<Transcript> => ipcRenderer.invoke('asr:transcribe', request),
  cancelTranscribe: (assetId: string): Promise<void> => ipcRenderer.invoke('asr:cancel', assetId),
  sidecarStatus: (): Promise<SidecarStatusMessage> => ipcRenderer.invoke('sidecar:status'),

  onTranscribeProgress: (
    cb: (update: { assetId: string; progress: number | null; message?: string }) => void
  ): (() => void) => {
    const listener = (_e: unknown, update: { assetId: string; progress: number | null; message?: string }): void =>
      cb(update)
    ipcRenderer.on('asr:progress', listener)
    return () => ipcRenderer.removeListener('asr:progress', listener)
  },

  onSidecarStatus: (cb: (status: SidecarStatusMessage) => void): (() => void) => {
    const listener = (_e: unknown, status: SidecarStatusMessage): void => cb(status)
    ipcRenderer.on('sidecar:status', listener)
    return () => ipcRenderer.removeListener('sidecar:status', listener)
  },

  revealPath: (path: string): Promise<void> => ipcRenderer.invoke('shell:reveal', path),
  openPath: (path: string): Promise<void> => ipcRenderer.invoke('shell:open', path),

  onJobsChanged: (cb: (jobs: Job[]) => void): (() => void) => {
    const listener = (_e: unknown, jobs: Job[]): void => cb(jobs)
    ipcRenderer.on('jobs:changed', listener)
    return () => ipcRenderer.removeListener('jobs:changed', listener)
  }
}

contextBridge.exposeInMainWorld('forge', api)

export type ForgeBridge = typeof api

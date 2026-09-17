import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { Job } from '@shared/types'
import type { MediaAsset, ParallaxBake, Project, TextSpec } from '@shared/timeline'
import type { DecisionRecord } from '@shared/project'
import type { Transcript } from '@shared/transcript'
import type { HelloResult } from '@shared/sidecar/protocol'
import type { AssetCatalog } from '@shared/assets/catalog'
import type { TransitionDef } from '@shared/transitions/registry'
import type { MusicAnalysis } from '@shared/automation/cutPlan'
import type { IngestRequest } from '@shared/ingest/args'

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
    /** Styled captions the renderer already drew, to composite in the one pass. */
    captionOverlay?: { listPath: string; y: number; height: number }
  }): Promise<Job> => ipcRenderer.invoke('render:start', request),
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

  saveProject: (project: Project, path: string | null, decisions: DecisionRecord[]): Promise<string | null> =>
    ipcRenderer.invoke('project:save', { project, path, decisions }),
  openProject: (path?: string): Promise<OpenedProject | null> =>
    ipcRenderer.invoke('project:open', path),

  assetCatalog: (force?: boolean): Promise<{ catalog: AssetCatalog; root: string; exists: boolean }> =>
    ipcRenderer.invoke('assets:catalog', force),
  assetFileUrl: (relativePath: string): Promise<string> =>
    ipcRenderer.invoke('assets:fileUrl', relativePath),
  assetFontData: (relativePath: string): Promise<ArrayBuffer> =>
    ipcRenderer.invoke('assets:fontData', relativePath),
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

  transcribe: (request: {
    assetId: string
    path: string
    language?: string
    model?: string
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

import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { Job } from '@shared/types'
import type { MediaAsset, Project } from '@shared/timeline'
import type { DecisionRecord } from '@shared/project'
import type { Transcript } from '@shared/transcript'
import type { HelloResult } from '@shared/sidecar/protocol'
import type { AssetCatalog } from '@shared/assets/catalog'

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

  startRender: (request: {
    project: Project
    outputPath: string
    canvas?: { width: number; height: number }
    crf?: number
    preset?: string
  }): Promise<Job> => ipcRenderer.invoke('render:start', request),
  cancelRender: (id: string): Promise<void> => ipcRenderer.invoke('render:cancel', id),
  listJobs: (): Promise<Job[]> => ipcRenderer.invoke('jobs:list'),
  clearFinished: (): Promise<void> => ipcRenderer.invoke('jobs:clearFinished'),
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

  peaks: (path: string, buckets?: number): Promise<{ values: number[]; buckets: number; durationMs: number }> =>
    ipcRenderer.invoke('media:peaks', { path, buckets }),

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

import { BrowserWindow, dialog, ipcMain, shell, app } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { basename } from 'node:path'
import type { Job } from '@shared/types'
import type { MediaAsset, Project } from '@shared/timeline'
import { ALL_EXTENSIONS } from '@shared/media'
import { deserializeProject, serializeProject, type DecisionRecord } from '@shared/project'
import { probeMany } from './ffmpeg/probe'
import { getSidecar } from './sidecar/service'
import { SIDECAR_METHODS } from '@shared/sidecar/protocol'
import { segmentIntoSentences, type Transcript, type Word } from '@shared/transcript'
import { JobQueue } from './queue'
import { startRender, type RenderOptions } from './render/renderJob'
import { toAsset } from './assets'
import { prepareCaptions } from './captions'
import { peaksFor } from './waveform'
import { loadCatalog, resolveAssetFile, assetsRootExists, assetsRoot } from './assets/scan'

interface ExportRequest {
  project: Project
  outputPath: string
  canvas?: { width: number; height: number }
  crf?: number
  preset?: string
}

export function registerIpc(getWindow: () => BrowserWindow | null): JobQueue {
  // Render options can't live on the Job (its params are scalars), so they're
  // held alongside and cleared when the queue is cleared.
  const renders = new Map<string, RenderOptions>()
  /** Temp files to remove once a render reaches a terminal state. */
  const cleanups = new Map<string, () => Promise<void>>()

  const queue = new JobQueue((job, onProgress) => {
    const options = renders.get(job.id)
    if (!options) throw new Error('This export is missing its render settings')
    return startRender(options, onProgress)
  }, 1)

  queue.on('changed', (jobs: Job[]) => {
    for (const job of jobs) {
      if (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') {
        const cleanup = cleanups.get(job.id)
        if (cleanup) {
          cleanups.delete(job.id)
          void cleanup()
        }
      }
    }
    getWindow()?.webContents.send('jobs:changed', jobs)
  })

  /* ---------------------------------------------------------------- media */

  ipcMain.handle('media:probe', async (_e, payload: unknown) => {
    const { paths, fps } = (payload ?? {}) as { paths?: unknown; fps?: unknown }
    if (!Array.isArray(paths) || paths.some((p) => typeof p !== 'string')) {
      throw new Error('Import expects a list of file paths')
    }
    const projectFps = typeof fps === 'number' && fps > 0 ? fps : 30

    const { ok, failed } = await probeMany(paths as string[])
    const assets: MediaAsset[] = ok.map((info) => toAsset(info, projectFps))
    return { assets, failed }
  })

  ipcMain.handle('dialog:pickMedia', async () => {
    const window = getWindow()
    if (!window) return []
    const result = await dialog.showOpenDialog(window, {
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Media', extensions: ALL_EXTENSIONS },
        { name: 'All files', extensions: ['*'] }
      ]
    })
    return result.canceled ? [] : result.filePaths
  })

  /* --------------------------------------------------------------- assets */

  ipcMain.handle('assets:catalog', async (_e, force: unknown) => {
    const catalog = await loadCatalog(force === true)
    return {
      catalog,
      root: assetsRoot(),
      exists: await assetsRootExists()
    }
  })

  ipcMain.handle('assets:fileUrl', (_e, relativePath: unknown) => {
    if (typeof relativePath !== 'string') throw new Error('Expected an asset path')
    return `forge-media://local/?p=${encodeURIComponent(resolveAssetFile(relativePath))}`
  })

  /**
   * Font bytes, not a URL.
   *
   * FontFace accepts an ArrayBuffer directly, which sidesteps the entire
   * network path: no CORS preflight (fonts are always fetched in CORS mode),
   * no CSP font-src, no custom-protocol quirks. Fonts are ~200KB and only the
   * visible ones are ever requested, so the transfer is cheap.
   */
  ipcMain.handle('assets:fontData', async (_e, relativePath: unknown) => {
    if (typeof relativePath !== 'string') throw new Error('Expected an asset path')
    const absolute = resolveAssetFile(relativePath)
    const data = await readFile(absolute)
    // Copy into a plain ArrayBuffer: a Node Buffer is a view onto a shared pool,
    // and sending it whole would ship far more bytes than the font.
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
  })

  ipcMain.handle('media:peaks', async (_e, payload: unknown) => {
    const { path, buckets } = (payload ?? {}) as { path?: unknown; buckets?: unknown }
    if (typeof path !== 'string') throw new Error('Peaks need a file path')
    return peaksFor(path, typeof buckets === 'number' ? Math.max(64, Math.min(4000, buckets)) : 600)
  })

  /* ------------------------------------------------------------------ asr */

  // One abort controller per in-flight transcription, so the UI can cancel.
  const transcriptions = new Map<string, AbortController>()

  ipcMain.handle('asr:transcribe', async (_e, payload: unknown) => {
    const { assetId, path, language, model } = (payload ?? {}) as {
      assetId?: unknown
      path?: unknown
      language?: unknown
      model?: unknown
    }
    if (typeof assetId !== 'string' || typeof path !== 'string') {
      throw new Error('Transcription needs an asset id and a file path')
    }

    const controller = new AbortController()
    transcriptions.set(assetId, controller)

    try {
      const result = await getSidecar().request<{
        language: string
        durationMs: number
        model: string
        words: Word[]
      }>(
        SIDECAR_METHODS.transcribe,
        {
          path,
          language: typeof language === 'string' ? language : undefined,
          model: typeof model === 'string' ? model : undefined
        },
        {
          signal: controller.signal,
          onProgress: (progress, message) => {
            getWindow()?.webContents.send('asr:progress', { assetId, progress, message })
          }
        }
      )

      // Segmentation happens here rather than in Python: it is pure, shared with
      // the renderer, and unit-tested without a model in the loop.
      const transcript: Transcript = {
        assetId,
        language: result.language,
        model: result.model,
        durationMs: result.durationMs,
        words: result.words,
        segments: segmentIntoSentences(result.words)
      }
      return transcript
    } finally {
      transcriptions.delete(assetId)
    }
  })

  ipcMain.handle('asr:cancel', (_e, assetId: unknown) => {
    if (typeof assetId !== 'string') return
    transcriptions.get(assetId)?.abort()
  })

  ipcMain.handle('sidecar:status', async () => {
    const sidecar = getSidecar()
    if (sidecar.info) return { state: 'ready' as const, hello: sidecar.info }
    try {
      return { state: 'ready' as const, hello: await sidecar.start() }
    } catch (err) {
      return { state: 'failed' as const, error: err instanceof Error ? err.message : String(err) }
    }
  })

  /* --------------------------------------------------------------- export */

  ipcMain.handle('render:start', async (_e, payload: unknown) => {
    const request = payload as ExportRequest
    if (!request?.project || typeof request.outputPath !== 'string') {
      throw new Error('Export is missing a project or an output path')
    }

    const canvas = request.canvas ?? {
      width: request.project.settings.width,
      height: request.project.settings.height
    }

    // Captions are written before the job is queued, so a failure to build them
    // surfaces here rather than as a mysterious ffmpeg error mid-render.
    const captions = await prepareCaptions(request.project, canvas)

    const job = queue.add({
      presetId: 'render',
      input: request.project.name,
      inputName: basename(request.outputPath),
      output: request.outputPath,
      params: {}
    })
    renders.set(job.id, {
      project: request.project,
      outputPath: request.outputPath,
      canvas: request.canvas,
      crf: request.crf,
      preset: request.preset,
      subtitlesPath: captions?.subtitlesPath,
      fontsDir: captions?.fontsDir
    })
    if (captions) cleanups.set(job.id, captions.cleanup)
    return job
  })

  ipcMain.handle('render:cancel', (_e, id: unknown) => {
    if (typeof id !== 'string') throw new Error('Cancel expects a job id')
    queue.cancel(id)
  })

  ipcMain.handle('jobs:list', () => queue.list())
  ipcMain.handle('jobs:clearFinished', () => {
    queue.clearFinished()
    for (const id of renders.keys()) {
      if (!queue.list().some((j) => j.id === id)) renders.delete(id)
    }
  })

  ipcMain.handle('dialog:exportPath', async (_e, suggested: unknown) => {
    const window = getWindow()
    if (!window) return null
    const result = await dialog.showSaveDialog(window, {
      title: 'Export video',
      defaultPath: typeof suggested === 'string' ? suggested : 'export.mp4',
      filters: [{ name: 'MP4 video', extensions: ['mp4'] }]
    })
    return result.canceled ? null : (result.filePath ?? null)
  })

  /* -------------------------------------------------------------- project */

  ipcMain.handle('project:save', async (_e, payload: unknown) => {
    const { project, path, decisions } = (payload ?? {}) as {
      project?: Project
      path?: unknown
      decisions?: DecisionRecord[]
    }
    if (!project) throw new Error('Nothing to save')

    let target = typeof path === 'string' ? path : null
    if (!target) {
      const window = getWindow()
      if (!window) return null
      const result = await dialog.showSaveDialog(window, {
        title: 'Save project',
        defaultPath: `${project.name || 'Untitled'}.forge`,
        filters: [{ name: 'Forge project', extensions: ['forge'] }]
      })
      if (result.canceled || !result.filePath) return null
      target = result.filePath
    }

    const file = serializeProject(project, { appVersion: app.getVersion(), decisions })
    await writeFile(target, JSON.stringify(file, null, 2), 'utf8')
    return target
  })

  ipcMain.handle('project:open', async (_e, path: unknown) => {
    let target = typeof path === 'string' ? path : null
    if (!target) {
      const window = getWindow()
      if (!window) return null
      const result = await dialog.showOpenDialog(window, {
        properties: ['openFile'],
        filters: [{ name: 'Forge project', extensions: ['forge'] }]
      })
      if (result.canceled || result.filePaths.length === 0) return null
      target = result.filePaths[0]
    }

    const raw = await readFile(target, 'utf8')
    const file = deserializeProject(JSON.parse(raw))
    return { path: target, ...file }
  })

  /* ---------------------------------------------------------------- shell */

  ipcMain.handle('shell:reveal', (_e, path: unknown) => {
    if (typeof path === 'string') shell.showItemInFolder(path)
  })

  ipcMain.handle('shell:open', async (_e, path: unknown) => {
    if (typeof path === 'string') await shell.openPath(path)
  })

  return queue
}

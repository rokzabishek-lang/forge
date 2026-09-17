import { BrowserWindow, dialog, ipcMain, shell, app } from 'electron'
import { access, readFile, writeFile } from 'node:fs/promises'
import { basename } from 'node:path'
import type { Job } from '@shared/types'
import type { MediaAsset, ParallaxBake, Project } from '@shared/timeline'
import { ALL_EXTENSIONS } from '@shared/media'
import { deserializeProject, serializeProject, type DecisionRecord } from '@shared/project'
import { probeMany } from './ffmpeg/probe'
import { getSidecar } from './sidecar/service'
import { SIDECAR_METHODS } from '@shared/sidecar/protocol'
import { segmentIntoSentences, type Transcript, type Word } from '@shared/transcript'
import { JobQueue } from './queue'
import { startRender, type RenderOptions } from './render/renderJob'
import { runGraphicsSelfTest } from './graphics/tier2'
import { transitionsFromMasks, type TransitionDef } from '@shared/transitions/registry'
import type { MaskTag } from '@shared/transitions/classify'
import { entriesOfKind } from '@shared/assets/catalog'
import { toAsset } from './assets'
import {
  prepareCaptions,
  writeCaptionFrame,
  writeCaptionList,
  clearCaptionFrames
} from './captions'
import { peaksFor } from './waveform'
import { FFMPEG_PATH, FFPROBE_PATH } from './ffmpeg/paths'
import { ensureLooks } from './looks'
import { splitStems } from './stems'
import { speak, voiceOptions, voiceStatus } from './voice'
import { loadCatalog, resolveAssetFile, assetsRootExists, assetsRoot } from './assets/scan'
import { preparePlaceableFile, placeableName } from './assets/place'
import { readTitleSlots, renderSolid, renderText, renderTitle, writeTitleImage, writeTitleFrame, clearTitleFrames } from './titles'
import { tagMasks } from './transitions/maskTags'

interface ExportRequest {
  project: Project
  outputPath: string
  canvas?: { width: number; height: number }
  crf?: number
  preset?: string
  /** Styled captions the renderer baked, ready to composite in the one pass. */
  captionOverlay?: { listPath: string; y: number; height: number }
}

export function registerIpc(getWindow: () => BrowserWindow | null): JobQueue {
  // Render options can't live on the Job (its params are scalars), so they're
  // held alongside and cleared when the queue is cleared.
  const renders = new Map<string, RenderOptions>()
  /** Temp files to remove once a render reaches a terminal state. */
  const cleanups = new Map<string, () => Promise<void>>()

  /*
   * Every export is one pass now.
   *
   * Styled captions used to take a second one: render the whole video to a
   * temporary file, screenshot an offscreen browser once per frame, then decode
   * that video again and re-encode it with the frames on top. Measured at
   * 1080x1920 it cost about five times the render itself, nearly all of it
   * waiting on a double requestAnimationFrame and a capturePage per frame.
   * Captions are drawn on a canvas now, so they are baked to a handful of
   * pictures and composited by the ordinary graph. See docs/EFFECTS.md §13.
   */
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

  /** The looks that ship with the app, generated to disk on first use. */
  ipcMain.handle('looks:list', async () => ensureLooks())

  /**
   * Pick a 3D LUT.
   *
   * `.cube` is the interchange format every grading tool exports and the one
   * ffmpeg reads directly, so a look bought or built anywhere else works here
   * without conversion.
   */
  ipcMain.handle('dialog:pickLut', async () => {
    const window = getWindow()
    if (!window) return null
    const result = await dialog.showOpenDialog(window, {
      title: 'Choose a LUT',
      properties: ['openFile'],
      filters: [
        { name: '3D LUT', extensions: ['cube'] },
        { name: 'All files', extensions: ['*'] }
      ]
    })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })

  /* --------------------------------------------------------------- assets */

  /**
   * Mask-based transitions, derived from the asset library.
   *
   * Built once per catalog load rather than per render: turning 405 catalog
   * entries into transition definitions on every export would be wasted work.
   */
  let maskTransitions: TransitionDef[] | null = null
  const getMaskTransitions = async (): Promise<TransitionDef[]> => {
    if (maskTransitions) return maskTransitions

    const catalog = await loadCatalog()
    const entries = entriesOfKind(catalog, 'transition').map((entry) => ({
      id: entry.id,
      name: entry.name,
      file: entry.file
    }))

    /*
     * Tags are a nicety; the transitions are the feature.
     *
     * Tagging spawns ffmpeg once per mask to classify it by what it does, and
     * it used to sit directly in this chain — so anything that went wrong in it
     * took all 412 transitions down with it and the picker silently fell back
     * to the eight built-ins. Four families where there had been seven, with no
     * error anywhere, which is indistinguishable from the feature having been
     * removed. The filter row is worth losing; the library is not.
     */
    let tags = new Map<string, MaskTag[]>()
    try {
      tags = await tagMasks(entries.map((e) => ({ id: e.id, file: resolveAssetFile(e.file) })))
    } catch (err) {
      console.warn('Could not tag transition masks; the library still loads untagged', err)
    }

    maskTransitions = transitionsFromMasks(entries.map((e) => ({ ...e, tags: tags.get(e.id) })))
    return maskTransitions
  }

  ipcMain.handle('transitions:library', () => getMaskTransitions())

  ipcMain.handle('titles:text', async (_e, payload: unknown) => {
    const { spec, clipId, width, height } = (payload ?? {}) as {
      spec?: unknown
      clipId?: unknown
      width?: unknown
      height?: unknown
    }
    if (typeof clipId !== 'string' || typeof spec !== 'object' || spec === null) {
      throw new Error('Rendering text needs a clip and a spec')
    }
    return renderText({
      spec: spec as Parameters<typeof renderText>[0]['spec'],
      clipId,
      width: typeof width === 'number' ? width : 1920,
      height: typeof height === 'number' ? height : 1080
    })
  })

  ipcMain.handle('titles:frame', async (_e, payload: unknown) => {
    const { clipId, frame, bytes } = (payload ?? {}) as {
      clipId?: unknown
      frame?: unknown
      bytes?: unknown
    }
    if (typeof clipId !== 'string') throw new Error('Writing a frame needs a clip')
    if (typeof frame !== 'number' || frame < 0) throw new Error('Writing a frame needs its number')
    if (!(bytes instanceof ArrayBuffer) && !ArrayBuffer.isView(bytes)) {
      throw new Error('Writing a frame needs its pixels')
    }
    return writeTitleFrame(clipId, frame, Buffer.from(bytes as ArrayBuffer))
  })

  ipcMain.handle('titles:clearFrames', async (_e, clipId: unknown) => {
    if (typeof clipId !== 'string') return
    await clearTitleFrames(clipId)
  })

  /* Styled captions, baked in the renderer where the fonts are. */
  ipcMain.handle('captions:frame', async (_e, payload: unknown) => {
    const { index, bytes } = (payload ?? {}) as { index?: unknown; bytes?: unknown }
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) {
      throw new Error('A caption frame needs an index')
    }
    if (!(bytes instanceof ArrayBuffer)) throw new Error('A caption frame needs its pixels')
    return writeCaptionFrame(index, Buffer.from(bytes))
  })

  ipcMain.handle('captions:list', async (_e, text: unknown) => {
    if (typeof text !== 'string') throw new Error('A caption list needs its contents')
    return writeCaptionList(text)
  })

  ipcMain.handle('captions:clearFrames', async () => {
    await clearCaptionFrames()
  })

  ipcMain.handle('titles:write', async (_e, payload: unknown) => {
    const { clipId, bytes } = (payload ?? {}) as { clipId?: unknown; bytes?: unknown }
    if (typeof clipId !== 'string') throw new Error('Writing a title image needs a clip')
    if (!(bytes instanceof ArrayBuffer) && !ArrayBuffer.isView(bytes)) {
      throw new Error('Writing a title image needs its pixels')
    }
    return writeTitleImage(clipId, Buffer.from(bytes as ArrayBuffer))
  })

  ipcMain.handle('titles:solid', async (_e, payload: unknown) => {
    const { color, opacity, clipId, width, height } = (payload ?? {}) as Record<string, unknown>
    if (typeof clipId !== 'string') throw new Error('A colour card needs a clip')
    return renderSolid({
      color: typeof color === 'string' ? color : '#000000',
      opacity: typeof opacity === 'number' ? opacity : 1,
      clipId,
      width: typeof width === 'number' ? width : 1920,
      height: typeof height === 'number' ? height : 1080
    })
  })

  ipcMain.handle('titles:slots', (_e, template: unknown) => {
    if (typeof template !== 'string') throw new Error('A title needs its template path')
    return readTitleSlots(template)
  })

  ipcMain.handle('titles:render', async (_e, payload: unknown) => {
    const { template, texts, clipId, width, height } = (payload ?? {}) as {
      template?: unknown
      texts?: unknown
      clipId?: unknown
      width?: unknown
      height?: unknown
    }
    if (typeof template !== 'string' || typeof clipId !== 'string') {
      throw new Error('Rendering a title needs a template and a clip')
    }
    return renderTitle({
      template,
      texts: Array.isArray(texts) ? texts.map(String) : [],
      clipId,
      width: typeof width === 'number' ? width : 1920,
      height: typeof height === 'number' ? height : 1080
    })
  })

  /**
   * Turn a library entry into something the timeline can hold.
   *
   * Rasterises SVG if needed, then probes the result so the caller gets a real
   * MediaAsset with dimensions — the same shape an imported file produces, so
   * nothing downstream has to know where a clip came from.
   */
  ipcMain.handle('assets:place', async (_e, payload: unknown) => {
    const { file, fps } = (payload ?? {}) as { file?: unknown; fps?: unknown }
    if (typeof file !== 'string') throw new Error('Placing an asset needs its path')

    const usable = await preparePlaceableFile(file)
    const projectFps = typeof fps === 'number' && fps > 0 ? fps : 30
    const { ok, failed } = await probeMany([usable])
    if (ok.length === 0) {
      throw new Error(failed[0]?.error ?? `Could not read ${placeableName(file)}`)
    }
    return toAsset({ ...ok[0], name: placeableName(file) }, projectFps)
  })

  ipcMain.handle('assets:catalog', async (_e, force: unknown) => {
    if (force === true) maskTransitions = null
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

  ipcMain.handle('audio:beats', async (_e, payload: unknown) => {
    const { path, startMs, endMs } = (payload ?? {}) as {
      path?: unknown
      startMs?: unknown
      endMs?: unknown
    }
    if (typeof path !== 'string') throw new Error('Beat analysis needs a file path')
    // The sidecar decodes through the same ffmpeg the app ships, so there is
    // one audio-decoding path in the product rather than two.
    return getSidecar().request(
      'audio.beats',
      {
        path,
        ffmpeg: FFMPEG_PATH,
        ...(typeof startMs === 'number' ? { startMs: Math.max(0, startMs) } : {}),
        ...(typeof endMs === 'number' ? { endMs: Math.max(0, endMs) } : {})
      },
      { timeoutMs: 300_000 }
    )
  })

  /* -------------------------------------------------------------- parallax */

  // One controller per asset: baking twenty photos for a reel is a minute of
  // work, and the user must be able to stop it.
  const bakes = new Map<string, AbortController>()

  ipcMain.handle('depth:layers', async (_e, payload: unknown) => {
    const { assetId, path, layers, subject } = (payload ?? {}) as {
      assetId?: unknown
      path?: unknown
      layers?: unknown
      subject?: unknown
    }
    if (typeof assetId !== 'string' || typeof path !== 'string') {
      throw new Error('Depth baking needs an asset id and a file path')
    }

    const controller = new AbortController()
    bakes.get(assetId)?.abort()
    bakes.set(assetId, controller)

    try {
      return await getSidecar().request<ParallaxBake>(
        SIDECAR_METHODS.depthLayers,
        {
          path,
          // Image decode and encode go through the same binaries as everything
          // else, so there is one media pipeline in the product.
          ffmpeg: FFMPEG_PATH,
          ffprobe: FFPROBE_PATH,
          ...(typeof layers === 'number' ? { layers } : {}),
          ...(typeof subject === 'boolean' ? { subject } : {})
        },
        {
          signal: controller.signal,
          // The first bake downloads a ~27MB model; without a generous ceiling
          // that shows up as a timeout rather than as progress.
          timeoutMs: 600_000,
          onProgress: (progress, message) => {
            getWindow()?.webContents.send('depth:progress', { assetId, progress, message })
          }
        }
      )
    } finally {
      bakes.delete(assetId)
    }
  })

  ipcMain.handle('depth:cancel', (_e, assetId: unknown) => {
    if (typeof assetId !== 'string') return
    bakes.get(assetId)?.abort()
  })

  ipcMain.handle('media:peaks', async (_e, payload: unknown) => {
    const { path, buckets } = (payload ?? {}) as { path?: unknown; buckets?: unknown }
    if (typeof path !== 'string') throw new Error('Peaks need a file path')
    return peaksFor(path, typeof buckets === 'number' ? Math.max(64, Math.min(4000, buckets)) : 600)
  })

  /* ---------------------------------------------------------------- stems */

  /*
   * Splitting a song into a voice and an instrumental.
   *
   * In the main process rather than the sidecar because it is arithmetic on two
   * channels and the ffmpeg to do it is already here — asking Python for it
   * would mean decoding the audio a third time to get an answer ffmpeg can give
   * in one pass. See src/main/stems.ts for what the two halves actually are,
   * and for why only one of them deserves the word "separation".
   */
  ipcMain.handle('audio:stems', async (_e, payload: unknown) => {
    const { path, quality } = (payload ?? {}) as { path?: unknown; quality?: unknown }
    if (typeof path !== 'string') throw new Error('Splitting a song needs a file path')

    /*
     * Ask for the good one, take the cheap one.
     *
     * Demucs is a real separation and minutes of CPU; mid/side is arithmetic
     * and instant. Most installs will not have demucs at all — it is not in
     * requirements.txt — so the fallback is the normal path rather than the
     * error path, and it is not worth a message on screen. What IS worth
     * reporting is which one answered, which the result carries.
     */
    if (quality === 'separated') {
      try {
        return await getSidecar().request(SIDECAR_METHODS.stems, { path }, { timeoutMs: 900_000 })
      } catch (err) {
        console.warn('Falling back to mid/side stems', err)
      }
    }
    return splitStems(path)
  })

  /* ---------------------------------------------------------------- voice */

  /*
   * Speech, from whichever engine the user has.
   *
   * Nothing above this learns which one answered — both return a wav on disk
   * and the result says which provider made it. See shared/voice/provider.ts.
   */
  ipcMain.handle('voice:status', () => voiceStatus())

  ipcMain.handle('voice:voices', (_e, payload: unknown) => {
    const { provider } = (payload ?? {}) as { provider?: unknown }
    return voiceOptions(
      provider === 'kokoro' || provider === 'hosted' || provider === 'auto' ? provider : 'auto'
    )
  })

  ipcMain.handle('voice:speak', async (_e, payload: unknown) => {
    const { text, voice, speed, provider } = (payload ?? {}) as {
      text?: unknown
      voice?: unknown
      speed?: unknown
      provider?: unknown
    }
    if (typeof text !== 'string') throw new Error('Speaking needs some words')
    return speak({
      text,
      ...(typeof voice === 'string' ? { voice } : {}),
      ...(typeof speed === 'number' ? { speed } : {}),
      ...(provider === 'kokoro' || provider === 'hosted' || provider === 'auto'
        ? { provider }
        : {})
    })
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

    /*
     * Captions take one path or the other, never both.
     *
     * A look libass cannot draw arrives already baked from the renderer, and
     * burning the same words in again with libass would render every caption
     * twice, on top of itself.
     */
    const captions = request.captionOverlay
      ? null
      : await prepareCaptions(request.project, canvas)

    // Everything the executor needs is resolved BEFORE the job is queued: the
    // queue pumps synchronously, so anything still being awaited here would not
    // exist by the time the render starts.
    const options: RenderOptions = {
      project: request.project,
      outputPath: request.outputPath,
      canvas: request.canvas,
      crf: request.crf,
      preset: request.preset,
      subtitlesPath: captions?.subtitlesPath,
      fontsDir: captions?.fontsDir,
      captionOverlay: request.captionOverlay,
      resolveAsset: resolveAssetFile,
      extraTransitions: await getMaskTransitions()
    }

    return queue.add(
      {
        presetId: 'render',
        input: request.project.name,
        inputName: basename(request.outputPath),
        output: request.outputPath,
        params: {}
      },
      (id) => {
        renders.set(id, options)
        if (captions) cleanups.set(id, captions.cleanup)
      }
    )
  })

  ipcMain.handle('render:cancel', (_e, id: unknown) => {
    if (typeof id !== 'string') throw new Error('Cancel expects a job id')
    queue.cancel(id)
  })

  ipcMain.handle('graphics:selftest', () => runGraphicsSelfTest())

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

    /*
     * Drop depth bakes whose plane files are gone.
     *
     * The bakes live in a cache directory, not beside the project, so clearing
     * that cache (or opening the project on another machine) leaves the map
     * pointing at nothing. Left in place the render fails with "No such file";
     * dropped here, the clip quietly falls back to a flat move and the user can
     * re-bake, which is cheap because the cache is keyed by content.
     */
    if (file.project.parallax) {
      const surviving: NonNullable<Project['parallax']> = {}
      for (const [assetId, bake] of Object.entries(file.project.parallax)) {
        const present = await Promise.all(
          bake.layers.map((layer) =>
            access(layer.file).then(
              () => true,
              () => false
            )
          )
        )
        if (present.every(Boolean)) surviving[assetId] = bake
      }
      file.project = { ...file.project, parallax: surviving }
    }

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

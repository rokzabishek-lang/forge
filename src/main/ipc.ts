import { BrowserWindow, dialog, ipcMain, shell, app } from 'electron'
import { access, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { Job } from '@shared/types'
import type { MediaAsset, ParallaxBake, Project } from '@shared/timeline'
import { ALL_EXTENSIONS } from '@shared/media'
import { deserializeProject, serializeProject, type DecisionRecord } from '@shared/project'
import {
  autosaveName,
  worthRecovering,
  type AutosaveRecord
} from '@shared/project/recovery'
import { candidatePaths, dirNameOf, matchByName } from '@shared/project/relink'
import { probeMany } from './ffmpeg/probe'
import { getSidecar } from './sidecar/service'
import { SIDECAR_METHODS } from '@shared/sidecar/protocol'
import { segmentIntoSentences, type Transcript, type Word } from '@shared/transcript'
import { JobQueue } from './queue'
import { startRender, type RenderOptions } from './render/renderJob'
import { runGraphicsSelfTest } from './graphics/tier2'
import { transitionsFromMasks, type TransitionDef } from '@shared/transitions/registry'
import type { MaskTag } from '@shared/transitions/classify'
import { entriesOfKind, isClipSticker, type ClipStickerMeta } from '@shared/assets/catalog'
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
import { separateStems } from './separate'
import { speak, voiceOptions, voiceStatus } from './voice'
import {
  complete as directorComplete,
  directorSettings,
  directorStatus,
  ollamaModels,
  setDirectorSettings
} from './director'
import { loadCatalog, resolveAssetFile, assetsRootExists, assetsRoot } from './assets/scan'
import { installPack, listPacks, refreshPacksInstalled, removePack } from './assets/packs'
import { preparePlaceableFile, placeableName } from './assets/place'
import { readTitleSlots, renderSolid, renderText, renderTitle, writeTitleImage, writeTitleFrame, clearTitleFrames } from './titles'
import { tagMasks } from './transitions/maskTags'
import { downloadMedia, downloadsDir, type IngestHandle, type IngestOutcome } from './ingest/download'
import { ensureYtDlp, ytDlpStatus } from './ingest/binary'
import { CancelledError } from './ffmpeg/run'
import { needsStems, outputStem, type IngestRequest } from '@shared/ingest/args'
import { parseLink } from '@shared/ingest/url'
import { QUALITIES } from '@shared/ingest/format'

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

  /*
   * Downloads get a queue of their own.
   *
   * The render queue runs one job at a time, because an export is CPU-bound
   * and two at once are slower than two in a row. A download is network-bound:
   * behind a twenty-minute export it would wait for nothing, and in front of
   * one it would hold the export up for nothing. Two queues, one list — the
   * renderer receives a single array and draws the same bar for both, so
   * nothing over there has to learn that a job can be a download.
   */
  const ingests = new Map<string, { request: IngestRequest; outcome: IngestOutcome | null }>()
  /** Stems with a download running, so a second job for one waits rather than races. */
  const inFlightStems = new Map<string, Promise<void>>()
  const downloads = new JobQueue((job, onProgress) => {
    const entry = ingests.get(job.id)
    if (!entry) throw new Error('This download is missing its request')

    // The executor must hand back a handle synchronously, but finding (or
    // fetching) yt-dlp is async. So the handle wraps a promise that does both,
    // and cancel reaches whichever stage is running.
    let inner: IngestHandle | null = null
    let cancelled = false
    const splitting = new AbortController()
    const fetching = new AbortController()
    const split = needsStems(entry.request.kind)

    const promise = (async (): Promise<void> => {
      // The fetch message rides in the speed column, which is free text on
      // screen — "downloading yt-dlp (~30MB, first time only)" is exactly what
      // a user staring at 0% needs to read.
      //
      // The signal matters: without it, cancelling during the first-run fetch
      // only set a flag, and the job sat at "running" for up to five minutes
      // waiting on a transfer nobody wanted.
      let tool
      try {
        tool = await ensureYtDlp((message) => onProgress(0, message), { signal: fetching.signal })
      } catch (err) {
        if (cancelled) throw new CancelledError()
        throw err
      }
      if (cancelled) throw new CancelledError()

      /*
       * One download per stem at a time.
       *
       * The queue runs two jobs at once, and two jobs for the same video wrote
       * to the same `.part`: yt-dlp resumes by default, so the second appended
       * from wherever the first had reached, one rename won and the other
       * failed — and cancelling either removed the shared partials. Waiting
       * here means the second job finds a finished file and takes the cache
       * path. It cannot be a straight "return the other job", because
       * instrumental and vocal share the audio stem and need different
       * post-processing.
       */
      const stem = outputStem(parseLink(entry.request.url)!, entry.request)
      while (inFlightStems.has(stem)) {
        onProgress(0, 'waiting for the same download to finish')
        await inFlightStems.get(stem)!.catch(() => undefined)
        if (cancelled) throw new CancelledError()
      }

      // With a split to follow, the download is the first 80% of the bar. The
      // split is minutes with Demucs and instant with mid/side, and we do not
      // know which until the sidecar answers, so the last 20% is the honest
      // compromise: the bar never reaches the end before the file exists.
      const scale = split ? 0.8 : 1
      inner = downloadMedia(entry.request, { command: tool.path }, (p, s) => onProgress(p * scale, s))
      const claim = inner.promise.then(
        () => undefined,
        () => undefined
      )
      inFlightStems.set(stem, claim)
      let downloaded
      try {
        downloaded = await inner.promise
      } finally {
        if (inFlightStems.get(stem) === claim) inFlightStems.delete(stem)
      }
      if (cancelled) throw new CancelledError()

      if (!split) {
        entry.outcome = { ...downloaded, stems: null }
        return
      }

      const stems = await separateStems(downloaded.path, 'separated', {
        signal: splitting.signal,
        onProgress: (p, message) => onProgress(0.8 + 0.2 * (p ?? 0), message ?? 'separating')
      })
      entry.outcome = {
        ...downloaded,
        path: entry.request.kind === 'vocal' ? stems.voice : stems.instrumental,
        stems: { backend: stems.backend, quality: stems.quality }
      }
    })()

    return {
      promise,
      cancel: () => {
        cancelled = true
        inner?.cancel()
        splitting.abort()
        fetching.abort()
      }
    }
  }, 2)

  const allJobs = (): Job[] => [...queue.list(), ...downloads.list()]
  const broadcast = (): void => {
    getWindow()?.webContents.send('jobs:changed', allJobs())
  }

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
    broadcast()
  })
  downloads.on('changed', broadcast)

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

  /*
   * Which folder the catalog scans depends on whether a pack is installed, and
   * that is a disk check — so it is started once, here, and AWAITED by
   * everything that resolves an asset path.
   *
   * Setting the flag from a floating promise at startup would have been a race
   * against the first scan, lost silently and only on a slow disk: the catalog
   * would be built from the empty bundled folder, cached with that root, and
   * the packs the user downloaded would simply not be there until the next
   * launch. Cheap enough to gate on — one readdir, once.
   */
  let packsPrimed: Promise<unknown> | null = null
  const primePacks = (): Promise<unknown> => (packsPrimed ??= refreshPacksInstalled())

  const getMaskTransitions = async (): Promise<TransitionDef[]> => {
    if (maskTransitions) return maskTransitions

    await primePacks()
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

    /*
     * A clip sticker brings its alpha with it.
     *
     * The catalog is the only place that knows a `…colour.mp4` has a matte
     * beside it, and main owns the catalog — so the pairing is resolved here
     * rather than trusted from the renderer, which would let any path be passed
     * off as a matte. Its title comes from the same entry: the filename is a
     * safe key like `13-tomorrow-for-sure`, and the words are in the catalog.
     */
    const entry = (await loadCatalog()).entries.find((e) => e.file === file)
    const sticker = entry?.kind === 'sticker' && isClipSticker(entry.meta) ? entry : null

    const asset = toAsset(
      { ...ok[0], name: sticker ? sticker.name : placeableName(file) },
      projectFps
    )
    if (sticker) asset.matte = resolveAssetFile((sticker.meta as ClipStickerMeta).matte)
    return asset
  })

  ipcMain.handle('assets:catalog', async (_e, force: unknown) => {
    if (force === true) maskTransitions = null
    await primePacks()
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

  /* ---------------------------------------------------------- asset packs */

  /** Installs in flight, so each has one cancel and a second press is refused. */
  const installs = new Map<string, AbortController>()

  ipcMain.handle('assets:packs', async (_e, refresh: unknown) => {
    await primePacks()
    return listPacks({ refresh: refresh === true })
  })

  /**
   * Fetch and install one pack, by id.
   *
   * The id is the only thing the renderer gets to choose. The URL, checksum and
   * size all come from the manifest main already holds — a renderer that could
   * pass a URL here would be a renderer that could make the app download and
   * unpack anything at all.
   */
  ipcMain.handle('assets:installPack', async (_e, id: unknown) => {
    if (typeof id !== 'string') throw new Error('Installing a pack needs its id')
    if (installs.has(id)) throw new Error('That pack is already downloading')

    const pack = (await listPacks()).find((entry) => entry.id === id)
    if (!pack) throw new Error(`There is no pack called ${id}`)

    const controller = new AbortController()
    installs.set(id, controller)
    try {
      const listing = await installPack(pack, {
        signal: controller.signal,
        onProgress: (progress, message) => {
          getWindow()?.webContents.send('assets:packProgress', { id, progress, message })
        }
      })

      /*
       * The catalog has to be rebuilt, not just invalidated.
       *
       * Its on-disk cache is keyed by the root it scanned, and installing a
       * SECOND pack does not change that root — so an unforced load would come
       * straight back with a catalog that predates the download. Rescanning
       * here also means `transitions:library` is right the moment the button
       * finishes, rather than on whatever call happens to force it next.
       */
      await refreshPacksInstalled()
      maskTransitions = null
      await loadCatalog(true)
      return listing
    } finally {
      installs.delete(id)
    }
  })

  ipcMain.handle('assets:cancelPack', (_e, id: unknown) => {
    if (typeof id !== 'string') throw new Error('Cancelling a pack needs its id')
    // Cancelling one that is not running is a no-op, the same as a render.
    installs.get(id)?.abort()
  })

  ipcMain.handle('assets:removePack', async (_e, id: unknown) => {
    if (typeof id !== 'string') throw new Error('Removing a pack needs its id')
    installs.get(id)?.abort()
    await removePack(id)
    await refreshPacksInstalled()
    maskTransitions = null
    await loadCatalog(true)
    return listPacks()
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

    // The policy — ask for the good one, take the cheap one — lives in
    // separate.ts now, shared with the download job. See there for why.
    return separateStems(path, quality === 'separated' ? 'separated' : 'emphasised', {})
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

  /* ------------------------------------------------------------- director */

  /*
   * A language model, from whichever engine the user has.
   *
   * The renderer sends a system prompt, a user prompt and a schema, and gets
   * text back — it never learns which provider answered beyond the stamp on
   * the result. A hosted key goes IN through `director:setSettings` and never
   * comes back out: `director:settings` reports `hasKey`, not the key. See
   * shared/director/provider.ts.
   */
  ipcMain.handle('director:status', () => directorStatus())
  ipcMain.handle('director:models', () => ollamaModels())
  ipcMain.handle('director:settings', () => directorSettings())

  ipcMain.handle('director:setSettings', (_e, payload: unknown) => {
    const { provider, ollama, openai } = (payload ?? {}) as {
      provider?: unknown
      ollama?: unknown
      openai?: unknown
    }
    const strings = (raw: unknown, keys: string[]): Record<string, string> => {
      if (typeof raw !== 'object' || raw === null) return {}
      const input = raw as Record<string, unknown>
      const out: Record<string, string> = {}
      for (const key of keys) if (typeof input[key] === 'string') out[key] = input[key] as string
      return out
    }
    return setDirectorSettings({
      ...(provider === 'auto' || provider === 'ollama' || provider === 'openai' ? { provider } : {}),
      ollama: strings(ollama, ['baseUrl', 'model']),
      openai: strings(openai, ['baseUrl', 'model', 'apiKey'])
    })
  })

  ipcMain.handle('director:complete', async (_e, payload: unknown) => {
    const { system, user, schema, images, maxTokens, think, provider } = (payload ?? {}) as {
      system?: unknown
      user?: unknown
      schema?: unknown
      images?: unknown
      maxTokens?: unknown
      think?: unknown
      provider?: unknown
    }
    if (typeof system !== 'string' || typeof user !== 'string') {
      throw new Error('Directing needs a system prompt and a user prompt')
    }
    if (typeof schema !== 'object' || schema === null) throw new Error('Directing needs a schema')
    return directorComplete({
      system,
      user,
      schema,
      ...(Array.isArray(images) ? { images: images.filter((i): i is string => typeof i === 'string') } : {}),
      ...(typeof maxTokens === 'number' ? { maxTokens } : {}),
      ...(typeof think === 'boolean' ? { think } : {}),
      ...(provider === 'auto' || provider === 'ollama' || provider === 'openai' ? { provider } : {})
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
    // One X button for both kinds of job. Cancelling an id a queue does not
    // hold is a no-op, so both can simply be asked.
    queue.cancel(id)
    downloads.cancel(id)
  })

  ipcMain.handle('graphics:selftest', () => runGraphicsSelfTest())

  ipcMain.handle('jobs:list', () => allJobs())
  ipcMain.handle('jobs:clearFinished', () => {
    queue.clearFinished()
    downloads.clearFinished()
    for (const id of renders.keys()) {
      if (!queue.list().some((j) => j.id === id)) renders.delete(id)
    }
    for (const id of ingests.keys()) {
      if (!downloads.list().some((j) => j.id === id)) ingests.delete(id)
    }
  })

  /* --------------------------------------------------------------- ingest */

  ipcMain.handle('ingest:status', () => ytDlpStatus())

  ipcMain.handle('ingest:start', (_e, payload: unknown) => {
    const raw = (payload ?? {}) as Partial<IngestRequest> & { range?: unknown }
    if (typeof raw.url !== 'string') throw new Error('A download needs a link')
    const link = parseLink(raw.url)
    if (!link) throw new Error('That is not a link yt-dlp can read')

    // Everything is re-validated here: the renderer proposes, main decides
    // what is actually spawned.
    const range =
      raw.range &&
      typeof raw.range === 'object' &&
      Number.isFinite((raw.range as { startMs?: unknown }).startMs) &&
      Number.isFinite((raw.range as { endMs?: unknown }).endMs)
        ? {
            startMs: (raw.range as { startMs: number }).startMs,
            endMs: (raw.range as { endMs: number }).endMs
          }
        : null
    const request: IngestRequest = {
      url: link.url,
      kind:
        raw.kind === 'audio' || raw.kind === 'instrumental' || raw.kind === 'vocal'
          ? raw.kind
          : 'video',
      quality: QUALITIES.includes(raw.quality as never) ? (raw.quality as IngestRequest['quality']) : '1080p',
      audioFormat: raw.audioFormat === 'mp3' ? 'mp3' : 'm4a',
      range,
      exact: raw.exact === true
    }

    return downloads.add(
      {
        presetId: 'ingest',
        input: link.url,
        inputName: link.kind === 'youtube' ? `YouTube · ${link.videoId}` : link.url,
        // The final path is unknown until yt-dlp says; the folder is what the
        // "reveal" button can honestly point at meanwhile.
        output: downloadsDir(),
        params: {}
      },
      (id) => ingests.set(id, { request, outcome: null })
    )
  })

  /**
   * The finished download as an asset, named after the video rather than the
   * file — the same split assets:place makes, so nothing downstream learns the
   * clip came from a link. Pulled by the renderer once the job reads `done`,
   * rather than pushed, so a reload between the two does not lose it.
   */
  ipcMain.handle('ingest:collect', async (_e, payload: unknown) => {
    const { jobId, fps } = (payload ?? {}) as { jobId?: unknown; fps?: unknown }
    if (typeof jobId !== 'string') throw new Error('Collecting a download needs its job id')
    const entry = ingests.get(jobId)
    // Three different situations that all used to say "has not finished".
    if (!entry) throw new Error('That download was cleared from the list')
    if (!entry.outcome) throw new Error('That download has not finished')

    const projectFps = typeof fps === 'number' && fps > 0 ? fps : 30
    const { ok, failed } = await probeMany([entry.outcome.path])
    if (ok.length === 0) throw new Error(failed[0]?.error ?? 'Could not read the downloaded file')

    // The media pool must tell the song from its instrumental at a glance, and
    // "emphasised" must not be allowed to read as a clean stem.
    const suffix =
      entry.request.kind === 'instrumental'
        ? entry.outcome.stems?.quality === 'separated' ? ' (instrumental)' : ' (instrumental, mid/side)'
        : entry.request.kind === 'vocal'
          ? entry.outcome.stems?.quality === 'separated' ? ' (vocals)' : ' (voice, emphasised)'
          : ''
    const base = entry.outcome.title ?? basename(entry.outcome.path)
    return {
      path: entry.outcome.path,
      asset: toAsset({ ...ok[0], name: `${base}${suffix}` }, projectFps),
      cached: entry.outcome.cached,
      approximateRange: entry.outcome.approximateRange,
      requestedRange: entry.outcome.requestedRange,
      stems: entry.outcome.stems ?? null
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

  /**
   * Write, then rename.
   *
   * A partial file where a project used to be is worse than no file: it opens,
   * it parses as far as the truncation, and what it loses is silent. `rename`
   * within one directory is atomic on both platforms, so the project file is
   * either the old one or the new one and never half of either.
   *
   * The temp name carries the process id: two windows autosaving the same
   * project at the same moment would otherwise race on one temp file and each
   * rename the other's half-written bytes into place.
   */
  const writeAtomic = async (target: string, text: string): Promise<void> => {
    const temp = `${target}.${process.pid}.tmp`
    await writeFile(temp, text, 'utf8')
    try {
      await rename(temp, target)
    } catch (err) {
      await unlink(temp).catch(() => undefined)
      throw err
    }
  }

  /* ------------------------------------------------------------ settings */

  /**
   * One JSON file in userData for everything that is the PERSON's rather than
   * the project's — export presets today, and whatever else outlives a
   * project later.
   *
   * Read fresh on every call rather than cached: it is a few hundred bytes,
   * it is touched only when a panel opens, and a cache here would be a second
   * copy of the truth that a second window could disagree with.
   */
  const settingsFile = (): string => join(app.getPath('userData'), 'settings.json')

  const readSettings = async (): Promise<Record<string, unknown>> => {
    try {
      const raw: unknown = JSON.parse(await readFile(settingsFile(), 'utf8'))
      return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : {}
    } catch {
      // Missing is the normal first-run case, and a corrupt file must not stop
      // the app — defaults are a better answer than a dialog nobody can act on.
      return {}
    }
  }

  ipcMain.handle('settings:get', () => readSettings())

  ipcMain.handle('settings:set', async (_e, payload: unknown) => {
    const { key, value } = (payload ?? {}) as { key?: unknown; value?: unknown }
    if (typeof key !== 'string' || !key) throw new Error('Expected a settings key')
    const current = await readSettings()
    const next = { ...current, [key]: value }
    // Atomic, like the project save: a truncated settings file would lose
    // every preset rather than the one being written.
    await writeAtomic(settingsFile(), JSON.stringify(next, null, 2))
    return next
  })

  /* ------------------------------------------------- autosave & recovery */

  const autosaveDir = (): string => join(app.getPath('userData'), 'autosave')

  ipcMain.handle('project:autosave', async (_e, payload: unknown) => {
    const { project, path, decisions } = (payload ?? {}) as {
      project?: Project
      path?: unknown
      decisions?: DecisionRecord[]
    }
    if (!project) return null

    const dir = autosaveDir()
    await mkdir(dir, { recursive: true })
    const target = join(dir, autosaveName(project.id ?? 'untitled'))
    const file = serializeProject(project, { appVersion: app.getVersion(), decisions })
    await writeAtomic(
      target,
      JSON.stringify({ ...file, autosave: { projectPath: typeof path === 'string' ? path : null } })
    )
    return target
  })

  /**
   * Autosaves that hold work the saved file does not.
   *
   * Read at launch, before anything is opened. A file that cannot be parsed is
   * skipped rather than thrown: one corrupt autosave must not stop the app
   * offering the other three, and it certainly must not stop the app starting.
   */
  ipcMain.handle('project:recoveries', async () => {
    const dir = autosaveDir()
    let names: string[] = []
    try {
      names = await readdir(dir)
    } catch {
      return []
    }

    const records: AutosaveRecord[] = []
    for (const name of names) {
      if (!name.endsWith('.forge.json')) continue
      const file = join(dir, name)
      try {
        const raw = JSON.parse(await readFile(file, 'utf8')) as {
          project?: { id?: string; name?: string }
          autosave?: { projectPath?: string | null }
        }
        const id = raw.project?.id
        if (!id) continue
        const savedAt = (await stat(file)).mtimeMs
        const projectPath = raw.autosave?.projectPath ?? null
        const projectSavedAt = projectPath
          ? await stat(projectPath).then((st) => st.mtimeMs, () => null)
          : null
        records.push({
          projectId: id,
          file,
          savedAt,
          projectPath,
          projectSavedAt,
          name: raw.project?.name || 'Untitled'
        })
      } catch {
        // A half-written or hand-edited autosave is not a reason to offer
        // nothing; it is a reason to skip this one.
      }
    }
    return worthRecovering(records)
  })

  /** Take a recovery: read it back as an ordinary project file. */
  ipcMain.handle('project:recover', async (_e, file: unknown) => {
    if (typeof file !== 'string') throw new Error('Expected an autosave path')
    const raw = JSON.parse(await readFile(file, 'utf8')) as { autosave?: { projectPath?: string } }
    const parsed = deserializeProject(raw)
    return { ...parsed, path: raw.autosave?.projectPath ?? null }
  })

  /** Clear an autosave once its work is safely in the real file. */
  ipcMain.handle('project:clearAutosave', async (_e, projectId: unknown) => {
    if (typeof projectId !== 'string') return
    await unlink(join(autosaveDir(), autosaveName(projectId))).catch(() => undefined)
  })

  ipcMain.handle('project:save', async (_e, payload: unknown) => {
    const { project, path, decisions, forceDialog } = (payload ?? {}) as {
      project?: Project
      path?: unknown
      decisions?: DecisionRecord[]
      forceDialog?: boolean
    }
    if (!project) throw new Error('Nothing to save')

    let target = forceDialog === true ? null : typeof path === 'string' ? path : null
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

    const file = serializeProject(project, {
      appVersion: app.getVersion(),
      decisions,
      // Told where it is going, so each asset underneath records its own place
      // relative to the project — which is what lets the folder be moved.
      projectDir: dirname(target)
    })
    // Atomic here too: a crash mid-save used to be able to leave a truncated
    // project where a whole one had been.
    await writeAtomic(target, JSON.stringify(file, null, 2))
    app.addRecentDocument(target)
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

    /*
     * Find every asset, or say which one is missing.
     *
     * Absolute first, then relative to the project file, then the folders this
     * project has already found media in. Whatever still resolves to nothing is
     * marked `offline` — a runtime mark, never saved — so the pool, the preview
     * and the timeline can all show it rather than each quietly rendering
     * black.
     */
    const projectDir = dirname(target)
    const searchFolders = [
      ...new Set(
        file.project.assets
          .map((a) => dirNameOf(a.path))
          .filter((d) => d.length > 0)
      )
    ]

    file.project = {
      ...file.project,
      assets: await Promise.all(
        file.project.assets.map(async (asset) => {
          /*
           * A self-drawn asset has no file to find.
           *
           * Text cards, colour cards and clippings are baked into the app's own
           * cache and re-baked on demand; marking one offline would put a red
           * card over a caption that draws itself perfectly well.
           */
          if (asset.size === 0) return asset
          for (const candidate of candidatePaths(asset, projectDir, searchFolders)) {
            const found = await access(candidate).then(() => true, () => false)
            if (found) return candidate === asset.path ? asset : { ...asset, path: candidate }
          }
          return { ...asset, offline: true }
        })
      )
    }

    app.addRecentDocument(target)
    return { path: target, ...file }
  })

  /**
   * Relink: point a project's missing media at files that exist.
   *
   * One file for one asset, or a folder for all of them — the folder case is
   * what matters, because a project arrives with a hundred clips missing and
   * relinking them one at a time is not a feature anyone would use.
   */
  ipcMain.handle('project:relink', async (_e, payload: unknown) => {
    const { assets, assetId } = (payload ?? {}) as {
      assets?: { id: string; path: string; size: number }[]
      assetId?: string
    }
    if (!Array.isArray(assets) || assets.length === 0) return {}
    const window = getWindow()
    if (!window) return {}

    if (assetId) {
      const asset = assets.find((a) => a.id === assetId)
      const result = await dialog.showOpenDialog(window, {
        title: `Find ${asset ? basename(asset.path) : 'this file'}`,
        properties: ['openFile'],
        filters: [{ name: 'Media', extensions: [...ALL_EXTENSIONS] }]
      })
      if (result.canceled || result.filePaths.length === 0) return {}
      return { [assetId]: result.filePaths[0] }
    }

    const result = await dialog.showOpenDialog(window, {
      title: 'Find the folder holding this project\u2019s media',
      properties: ['openDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return {}
    const folder = result.filePaths[0]

    /*
     * One level of subfolders as well as the folder itself.
     *
     * Footage is usually in `clips/` and `audio/` beside the project rather
     * than loose, and asking the user to relink twice for that is asking them
     * to know how the app searches. Not recursive beyond that: a pointed-at
     * home directory would take minutes and find the wrong files.
     */
    const entries = await readdir(folder, { withFileTypes: true }).catch(() => [])
    const files: { path: string; size: number }[] = []
    const scan = async (dir: string): Promise<void> => {
      const found = await readdir(dir, { withFileTypes: true }).catch(() => [])
      for (const entry of found) {
        if (!entry.isFile()) continue
        const full = join(dir, entry.name)
        const size = await stat(full).then((st) => st.size, () => -1)
        if (size >= 0) files.push({ path: full, size })
      }
    }
    await scan(folder)
    for (const entry of entries) {
      if (entry.isDirectory()) await scan(join(folder, entry.name))
    }

    return matchByName(assets, files)
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

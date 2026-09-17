import type { MediaAsset } from '@shared/timeline'
import { LOOKS, cubeFor } from '@shared/render/looks'

/**
 * A working stand-in for the Electron bridge, so the UI runs in a browser.
 *
 * Not a mock in the testing sense — nothing asserts on it. It exists so the
 * interface can be opened, clicked and looked at without building and launching
 * the app, which is the one thing that cannot be done from outside the machine.
 * Layout, panel logic, what appears when a clip is selected, where the text box
 * lands: all of that is renderer-side and all of it has been reported as broken
 * at some point.
 *
 * What it cannot stand in for: ffmpeg, the Python sidecar, real decoding, and
 * the export. Those are real work in other processes. Anything the harness
 * shows about THOSE is worthless, and it says so rather than faking a result.
 */

const unsupported = (what: string) => async (): Promise<never> => {
  throw new Error(`${what} needs the real app — the harness has no ${what.toLowerCase()}`)
}

/** Files the harness has made, so they can be handed back as assets. */
const made = new Map<string, { width: number; height: number }>()

function blobUrl(data: BlobPart, type: string): string {
  return URL.createObjectURL(new Blob([data], { type }))
}

/**
 * Record a picture's REAL size.
 *
 * The harness must never guess at dimensions. The first run of it drew every
 * text clip twice — once from the baked PNG, once from the editing overlay, in
 * different places — which looks exactly like a placement bug and was purely
 * this file claiming a 1920x1080 image was 1080x1920. A harness that lies sends
 * you hunting for faults that are not there.
 */
async function measured(url: string): Promise<string> {
  const size = await new Promise<{ width: number; height: number }>((resolve) => {
    const image = new Image()
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight })
    image.onerror = () => resolve({ width: 0, height: 0 })
    image.src = url
  })
  if (size.width > 0) made.set(url, size)
  return url
}

/**
 * A synthetic photograph.
 *
 * Distinct colours and a number on each, because "the wrong clip is showing"
 * and "the layer order is upside down" are both invisible with identical
 * placeholders.
 */
function samplePhoto(index: number, width = 1600, height = 1067): Promise<string> {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')!
  const hue = (index * 47) % 360
  const sky = ctx.createLinearGradient(0, 0, 0, height)
  sky.addColorStop(0, `hsl(${hue} 55% 62%)`)
  sky.addColorStop(1, `hsl(${(hue + 40) % 360} 45% 28%)`)
  ctx.fillStyle = sky
  ctx.fillRect(0, 0, width, height)

  // A figure, roughly where a subject sits, so framing and matting have a shape.
  ctx.fillStyle = `hsl(${(hue + 180) % 360} 40% 18%)`
  ctx.beginPath()
  ctx.ellipse(width * 0.42, height * 0.34, width * 0.07, width * 0.07, 0, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillRect(width * 0.35, height * 0.44, width * 0.14, height * 0.5)

  ctx.fillStyle = 'rgba(255,255,255,0.85)'
  ctx.font = `bold ${Math.round(height * 0.16)}px sans-serif`
  ctx.textAlign = 'right'
  ctx.fillText(String(index + 1), width - 40, height - 40)

  return new Promise((resolve) => {
    canvas.toBlob((blob) => {
      const url = URL.createObjectURL(blob!)
      made.set(url, { width, height })
      resolve(url)
    }, 'image/png')
  })
}

/**
 * A synthetic VIDEO — a real, decodable, seekable file.
 *
 * Recorded from a canvas rather than faked, because the things that need
 * checking about video cannot be checked against a still: playback rate,
 * seeking, drift, trimming, and now speed. Until this existed the harness could
 * only ever produce images, so an entire half of the editor was invisible to
 * it — and "only images" is exactly the blind spot that lets a video-only bug
 * ship.
 *
 * A moving counter and a sweeping bar, so a frame can be identified on sight:
 * "it is showing the wrong moment" is impossible to see in a static gradient.
 */
async function sampleVideo(seconds = 6, fps = 30): Promise<string> {
  const width = 640
  const height = 360
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')!

  const stream = canvas.captureStream(fps)
  const type = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((t) =>
    MediaRecorder.isTypeSupported(t)
  )
  const recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined)
  const chunks: BlobPart[] = []
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data)
  }

  const done = new Promise<void>((resolve) => {
    recorder.onstop = () => resolve()
  })
  recorder.start()

  /*
   * Paced by the wall clock, not by a frame count.
   *
   * The first version drew `seconds * fps` frames one per animation frame,
   * which on a 60Hz display recorded 180 frames in three seconds and produced a
   * three-second file that the harness then announced as six. A harness that
   * misreports a duration sends you hunting a trimming bug that does not exist
   * — the same trap this file already carries a warning about for image sizes.
   */
  const start = performance.now()
  await new Promise<void>((resolve) => {
    const draw = (): void => {
      const t = (performance.now() - start) / 1000
      if (t >= seconds) {
        resolve()
        return
      }
      ctx.fillStyle = `hsl(${Math.round(t * 90) % 360} 45% 22%)`
      ctx.fillRect(0, 0, width, height)
      // A bar sweeping once per second: a seek landing early is visible.
      ctx.fillStyle = '#f97a4b'
      ctx.fillRect(((t % 1) * width) | 0, 0, 8, height)
      ctx.fillStyle = '#fff'
      ctx.font = 'bold 84px monospace'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(t.toFixed(2), width / 2, height / 2)
      requestAnimationFrame(draw)
    }
    requestAnimationFrame(draw)
  })

  recorder.stop()
  await done
  const url = URL.createObjectURL(new Blob(chunks, { type: type ?? 'video/webm' }))
  made.set(url, { width, height })
  // What was actually recorded, asked of the file itself.
  videoFiles.set(url, await videoSeconds(url))
  return url
}

/**
 * How long a recorded blob really is.
 *
 * Chromium reports `Infinity` for MediaRecorder webm until it has been seeked
 * past the end, which is why this asks twice instead of trusting `duration`.
 */
async function videoSeconds(url: string): Promise<number> {
  const video = document.createElement('video')
  video.preload = 'metadata'
  video.src = url
  await new Promise<void>((resolve) => {
    video.onloadedmetadata = () => resolve()
    video.onerror = () => resolve()
  })
  if (Number.isFinite(video.duration) && video.duration > 0) return video.duration
  await new Promise<void>((resolve) => {
    video.onseeked = () => resolve()
    video.onerror = () => resolve()
    video.currentTime = 1e6
  })
  return Number.isFinite(video.currentTime) && video.currentTime > 0 ? video.currentTime : 1
}

/** Which synthetic files are video, and how long each one is. */
const videoFiles = new Map<string, number>()

function asset(path: string, name: string, fps: number, kind: MediaAsset['kind']): MediaAsset {
  const size = made.get(path) ?? { width: 1600, height: 1067 }
  return {
    id: `a-${Math.random().toString(36).slice(2, 9)}`,
    path,
    name,
    kind,
    // A recorded clip reports its REAL length. Claiming twelve seconds for a
    // six-second file would let a trim run off the end of the media, which is
    // precisely the sort of fiction that sends you hunting a bug that is not there.
    durationFrames:
      kind === 'image' ? fps * 5 : Math.round((videoFiles.get(path) ?? 12) * fps),
    width: kind === 'audio' ? null : size.width,
    height: kind === 'audio' ? null : size.height,
    fps: kind === 'image' ? null : fps,
    hasVideo: kind !== 'audio',
    hasAudio: kind === 'audio',
    size: 1024
  }
}

/** Steady 120 BPM, so beat-driven planning has something plausible to chew. */
function fakeBeats(durationMs: number): Record<string, unknown> {
  const step = 500
  const beats = Array.from({ length: Math.floor(durationMs / step) }, (_, i) => i * step)
  return {
    bpm: 120,
    beats,
    downbeats: beats.filter((_, i) => i % 4 === 0),
    tiers: beats.map((_, i) => (i % 16 >= 12 ? 3 : 2)),
    drops: [{ ms: Math.round(durationMs * 0.5), score: 0.9 }],
    buildups: [],
    sections: [0, Math.round(durationMs * 0.5)],
    durationMs,
    onsets: beats,
    windowStartMs: 0
  }
}

/** How many frames each clip has baked, for the harness to read back. */
const titleFrames = new Map<string, number>()
/** Byte sizes of the caption pictures baked, and the concat list naming them. */
const captionFrames: number[] = []
const captionList = { text: '' }

export function installHarnessBridge(): void {
  let sampleCount = 0

  const bridge = {
    getPathForFile: () => '',

    probe: async (paths: string[], fps: number) => ({
      assets: paths.map((p, i) =>
        asset(p, videoFiles.has(p) ? `clip ${i + 1}.webm` : `sample ${i + 1}`, fps,
          videoFiles.has(p) ? 'video' : 'image')
      ),
      failed: []
    }),

    /** Stands in for the file dialog: makes pictures rather than opening any. */
    pickMedia: async () => {
      const files: string[] = []
      for (let i = 0; i < 3; i++) files.push(await samplePhoto(sampleCount++))
      // One real recorded clip alongside the stills, so anything that only
      // applies to moving pictures — speed, seeking, playback rate — can
      // actually be tried here.
      files.push(await sampleVideo())
      return files
    },

    pickLut: async () => {
      const look = LOOKS[2]
      return blobUrl(cubeFor(look, 9), 'text/plain')
    },

    builtInLooks: async () =>
      LOOKS.map((look) => ({
        id: look.id,
        name: look.name,
        description: look.description,
        file: blobUrl(cubeFor(look, 9), 'text/plain')
      })),

    placeAsset: async (file: string, fps: number) =>
      asset(file, file.split('/').pop() ?? 'placed', fps,
        videoFiles.has(file) ? 'video' : 'image'),

    writeTitleImage: async (_clipId: string, bytes: ArrayBuffer) =>
      // Straight back out as a URL the preview can load, so text really draws.
      measured(blobUrl(bytes, 'image/png')),

    /*
     * Baked animation frames, counted rather than written.
     *
     * There is no disk here, but how MANY frames a clip bakes is the part of
     * the export path a browser can genuinely check — it is decided entirely by
     * the animation and the clip, and getting it wrong means either a frozen
     * caption or a folder full of identical pictures.
     */
    writeTitleFrame: async (clipId: string, frame: number) => {
      titleFrames.set(clipId, Math.max(titleFrames.get(clipId) ?? 0, frame + 1))
      return `harness://${clipId}.seq/%05d.png`
    },
    clearTitleFrames: async (clipId: string) => {
      titleFrames.delete(clipId)
    },

    /*
     * Baked captions, counted and kept rather than written.
     *
     * There is no disk here, but HOW MANY distinct pictures a timeline bakes is
     * the number the whole optimisation turns on — it is decided entirely by the
     * caption timings and the animation, and a regression that quietly baked one
     * picture per frame would look identical in every other respect.
     */
    writeCaptionFrame: async (index: number, bytes: ArrayBuffer) => {
      captionFrames.push(bytes.byteLength)
      return `harness://captions/${String(index).padStart(5, '0')}.png`
    },
    writeCaptionList: async (text: string) => {
      captionList.text = text
      return 'harness://captions/captions.txt'
    },
    clearCaptionFrames: async () => {
      captionFrames.length = 0
      captionList.text = ''
    },

    renderText: unsupported('Text rasterising'),
    renderSolid: async (options: { width: number; height: number; color: string; opacity: number }) => {
      const canvas = document.createElement('canvas')
      canvas.width = options.width
      canvas.height = options.height
      const ctx = canvas.getContext('2d')!
      ctx.globalAlpha = options.opacity
      ctx.fillStyle = options.color
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      const url = canvas.toDataURL('image/png')
      made.set(url, { width: options.width, height: options.height })
      return url
    },

    titleSlots: async () => [],
    renderTitle: unsupported('Title templates'),

    assetCatalog: async () => ({
      catalog: { version: 1, generatedAt: '', entries: [] },
      root: '',
      exists: false
    }),
    assetFileUrl: async (relative: string) => relative,
    assetFontData: unsupported('Font loading'),
    transitionLibrary: async () => [],

    analyseBeats: async (_path: string, range?: { startMs?: number; endMs?: number }) =>
      fakeBeats((range?.endMs ?? 30_000) - (range?.startMs ?? 0)),

    peaks: async (_path: string, buckets = 400) => ({
      values: Array.from({ length: buckets }, (_, i) => 0.3 + 0.5 * Math.abs(Math.sin(i / 7))),
      buckets,
      durationMs: 30_000
    }),

    bakeParallax: unsupported('Depth baking'),
    cancelParallax: async () => undefined,
    onParallaxProgress: () => () => undefined,

    splitStems: async (path: string) => ({
      instrumental: path,
      voice: path,
      backend: 'harness',
      quality: 'emphasised' as const
    }),

    /*
     * Downloads cannot happen here, but the PANEL must still be clickable —
     * it is renderer logic, which is exactly what the harness exists to check.
     * So status answers honestly and the two actions refuse by name.
     */
    ingestStatus: async () => ({ ready: false, tool: null, reason: 'harness: no yt-dlp' }),
    startIngest: unsupported('Downloading'),
    collectIngest: unsupported('Downloading'),

    voiceStatus: async () => [
      { id: 'kokoro' as const, label: 'Kokoro (on this machine)', kind: 'local' as const, ready: false, reason: 'harness: no sidecar' },
      { id: 'hosted' as const, label: 'Hosted API', kind: 'hosted' as const, ready: false, reason: 'harness: no network' }
    ],
    voiceOptions: async () => [],
    speak: unsupported('Speech'),

    transcribe: unsupported('Transcription'),
    cancelTranscribe: async () => undefined,
    sidecarStatus: async () => ({ state: 'failed' as const, error: 'harness: no sidecar' }),
    onTranscribeProgress: () => () => undefined,
    onSidecarStatus: () => () => undefined,

    startRender: unsupported('Exporting'),
    cancelRender: async () => undefined,
    listJobs: async () => [],
    clearFinished: async () => undefined,
    graphicsSelfTest: async () => ({
      ok: false,
      transparentFraction: 0,
      opaqueFraction: 0,
      bytes: 0,
      message: 'harness: no frame server'
    }),

    chooseExportPath: async () => null,
    saveProject: async () => null,
    openProject: async () => null,
    revealPath: async () => undefined,
    openPath: async () => undefined,
    onJobsChanged: () => () => undefined
  }

  window.forge = bridge as unknown as Window['forge']
  // Readable from a driving script, which cannot see a module-scoped Map.
  ;(window as unknown as { forgeTitleFrames: Map<string, number> }).forgeTitleFrames = titleFrames
  ;(
    window as unknown as { forgeCaptionBake: { frames: number[]; list: { text: string } } }
  ).forgeCaptionBake = { frames: captionFrames, list: captionList }
}

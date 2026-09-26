import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'
import type React from 'react'
import { X } from 'lucide-react'
import type { Clip, CropRect, MediaAsset, Project } from '@shared/timeline'
import {
  clipCoversFrame,
  clipEnd,
  framesToSeconds,
  sourceFrameFor,
  projectDuration
} from '@shared/timeline'
import { ASPECTS, useEditor } from '../store'
import { assetUrl, mediaUrl } from '../media'
import {
  previewAt,
  type TransitionDef,
  type TransitionPreview
} from '@shared/transitions/registry'
import { forgetWipe, wipedSource } from '../wipe'
import { PreviewMixer } from '../audioGraph'
import { publishLevels } from '../levels'
import { fadeGainAt, fadesWithNeighbours } from '@shared/render/audioFade'
import { audioRole, clampGain, clipLevelAt, isAudible } from '@shared/render/audibility'
import { NO_SCRUB, SCRUB_BURST_MS, scrubStep, type ScrubState } from '@shared/render/scrub'
import { motionSourceRect, moveAt } from '@shared/render/motion'
import { effectiveCrop } from '@shared/render/crop'
import { pickRegion, pickedColor, saneKey } from '@shared/render/chromaKey'
import { maskAt } from '@shared/render/mask'
import { clipBox, parallaxBakeFor, planeShare } from '@shared/render/plan'
import { pathAt } from '@shared/render/path'
import { clockStep, needsReanchor, type ClockAnchor } from '@shared/render/clock'
import { valueAt } from '@shared/render/keyframes'
import { CropOverlay } from './CropOverlay'
import { TextOverlay } from './TextOverlay'
import { TransformOverlay } from './TransformOverlay'
import { MaskOverlay } from './MaskOverlay'
import { forgetGrade, gradeRegion, gradedSource } from '../grade'
import { forgetMatte, lumaMattedSource, mattedSource } from '../matte'
import { forgetMask, maskedSource } from '../maskPreview'
import { forgetTextPreview, textPreviewCanvas } from '../textCanvas'
import { paperPreviewCanvas } from '../paperCanvas'
import { carouselPreviewCanvas } from '../carouselCanvas'
import { clipRateAt, clipSpeed } from '@shared/render/speed'
import { activeCaptionStyle, captionAt, drawCaptions } from '../captionPreview'
import { captionSourceClip } from '@shared/captions/timeline'
import { useCatalog } from '../catalog'
import { isAssetDrag, readDragPayload, type DragPayload } from '../dragPayload'
import { DROP_CHOICES, type DropIntent } from '@shared/render/dropIntent'

export interface ViewTransform {
  scale: number
  offsetX: number
  offsetY: number
}

/**
 * Where the finished frame sits inside the preview box.
 *
 * Duplicated deliberately from the draw loop's own arithmetic so overlays can be
 * positioned without reaching into canvas state — and kept in one exported
 * function so the two cannot drift.
 */
export function outputFrame(
  box: { width: number; height: number },
  target: { width: number; height: number },
  splitRatio: number
): { x: number; y: number; width: number; height: number } | null {
  const splitX = Math.round(box.width * splitRatio)
  const gutter = splitX > 0 && splitX < box.width ? 1 : 0
  const right = {
    x: splitX + gutter,
    y: 0,
    width: box.width - splitX - gutter,
    height: box.height
  }
  if (right.width <= 8) return null
  const fit = fitTransform(target.width, target.height, right.width, right.height)
  return {
    x: right.x + fit.offsetX,
    y: right.y + fit.offsetY,
    width: target.width * fit.scale,
    height: target.height * fit.scale
  }
}

function fitTransform(sourceW: number, sourceH: number, boxW: number, boxH: number): ViewTransform {
  const scale = Math.min(boxW / sourceW, boxH / sourceH)
  return {
    scale,
    offsetX: (boxW - sourceW * scale) / 2,
    offsetY: (boxH - sourceH * scale) / 2
  }
}

/** Fill the box and let the overflow spill — the caller clips it. */
function coverTransform(sourceW: number, sourceH: number, boxW: number, boxH: number): ViewTransform {
  const scale = Math.max(boxW / sourceW, boxH / sourceH)
  return {
    scale,
    offsetX: (boxW - sourceW * scale) / 2,
    offsetY: (boxH - sourceH * scale) / 2
  }
}

/** Re-seek a media element only when it has drifted visibly. */
const DRIFT_TOLERANCE = 0.18

/**
 * How far playing audio may drift before it is worth a glitch to correct.
 *
 * Deliberately large. Seeking audio mid-playback is audible, so this should only
 * ever fire after a real jump — a scrub or a loop — never for the millisecond
 * wander between a wall clock and an audio device.
 */
const AUDIO_RESYNC = 0.75

type MediaElement = HTMLVideoElement | HTMLImageElement

interface Layer {
  clip: Clip
  asset: MediaAsset
  element: MediaElement
  /**
   * What this clip's incoming transition is doing at this frame — the same
   * fade, offset and punch-in the render compiles into its filters, evaluated
   * here from the same factory so the two cannot drift.
   */
  transition: TransitionPreview
  /**
   * A luma wipe's mask and how far the reveal has swept, when this clip is
   * being wiped on. Separate from `transition` because a wipe is a stencil
   * rather than a number: the draw loop builds it, the formula does not.
   */
  wipe?: { mask: HTMLImageElement; progress: number; softness?: number }
  /** 0..1 across the clip, for the camera move. */
  progress: number
  /** Elapsed seconds into the clip; only shake needs it. */
  elapsed: number
  /**
   * Animated values at this frame — the same curve the renderer compiles into
   * an expression, evaluated here so the two cannot drift.
   */
  keyed: { zoom: number; rotation: number; opacity: number }
  /** The shape this clip is shown through, when it has one. */
  matteElement?: MediaElement
  /**
   * The shape's clip, kept so the draw loop can use its LIVE picture.
   *
   * A text shape has no file while it is being edited — the whole point of
   * drawing text live — so resolving the matte from the element alone made
   * "fill with the picture below" quietly stop working in the preview while the
   * export, which bakes on its way out, still applied it. The two must agree.
   */
  matteClip?: Clip
  /**
   * A clip sticker's own alpha, as a greyscale video beside its colour.
   *
   * Nothing to do with `matteElement`, which is another CLIP being used as a
   * stencil. This one is a property of the file: H.264 cannot carry alpha, so a
   * keyed cut-out ships as a pair and the colour half still has the green it
   * was keyed from sitting in its RGB.
   */
  stickerMatte?: HTMLVideoElement
  /**
   * Depth planes, far to near, when this clip renders as parallax.
   *
   * Drawn instead of the flat image, each with its own move amount — the same
   * arithmetic the renderer compiles into zoompan, from the same table.
   */
  planes?: { element: HTMLImageElement; depth: number; width: number; height: number }[]
}

/**
 * Load again without CORS if the CORS load fails.
 *
 * Asking for CORS is what lets the GPU grade read the picture, but if the
 * request is ever refused the element loads nothing at all — and a preview that
 * is entirely black while the audio plays is far worse than a preview that
 * cannot show a grade. So the picture always wins: on failure the element
 * re-loads plainly and the grade quietly stops previewing for that clip.
 */
function withoutCorsOnError(element: HTMLImageElement | HTMLVideoElement, url: string): void {
  element.addEventListener(
    'error',
    () => {
      if (element.dataset.forgePlain === '1') return
      element.dataset.forgePlain = '1'
      element.removeAttribute('crossorigin')
      element.src = url
    },
    { once: true }
  )
}

interface SourceRect {
  sx: number
  sy: number
  sw: number
  sh: number
}

/**
 * A centred sub-rectangle — what any punch-in narrows the view to.
 *
 * Centred, matching the renderer's zoompan, which takes `iw/2-(iw/zoom/2)`,
 * and its transitions' `crop=iw/f:ih/f`, which crops about the middle too.
 */
function insetRect(rect: SourceRect, zoom: number): SourceRect {
  const z = Math.max(1, zoom)
  const sw = rect.sw / z
  const sh = rect.sh / z
  return { sx: rect.sx + (rect.sw - sw) / 2, sy: rect.sy + (rect.sh - sh) / 2, sw, sh }
}

/** The source rectangle a keyframed zoom shows. */
function zoomedRect(width: number, height: number, zoom: number): SourceRect {
  return insetRect({ sx: 0, sy: 0, sw: width, sh: height }, zoom)
}

/**
 * Composition guides, over the finished frame.
 *
 * Thirds for framing; title-safe and action-safe for anything that must survive
 * a crop or an overscan. The safe percentages are SMPTE ST 2046-1: action at
 * 93%, titles at 90% — the same numbers the text layout already uses, so what
 * the guide promises and what the renderer does are the same promise.
 */
function drawGuides(
  ctx: CanvasRenderingContext2D,
  frame: { x: number; y: number; width: number; height: number },
  thirds: boolean,
  safe: boolean
): void {
  if (!thirds && !safe) return
  ctx.save()
  ctx.lineWidth = 1

  if (thirds) {
    ctx.strokeStyle = 'rgba(255,255,255,0.22)'
    ctx.beginPath()
    for (let i = 1; i < 3; i++) {
      const x = Math.round(frame.x + (frame.width * i) / 3) + 0.5
      const y = Math.round(frame.y + (frame.height * i) / 3) + 0.5
      ctx.moveTo(x, frame.y)
      ctx.lineTo(x, frame.y + frame.height)
      ctx.moveTo(frame.x, y)
      ctx.lineTo(frame.x + frame.width, y)
    }
    ctx.stroke()
  }

  if (safe) {
    const box = (fraction: number, colour: string): void => {
      const inset = (1 - fraction) / 2
      ctx.strokeStyle = colour
      ctx.strokeRect(
        Math.round(frame.x + frame.width * inset) + 0.5,
        Math.round(frame.y + frame.height * inset) + 0.5,
        Math.round(frame.width * fraction),
        Math.round(frame.height * fraction)
      )
    }
    box(0.93, 'rgba(255,255,255,0.2)')
    box(0.9, 'rgba(249,122,75,0.55)')
  }

  ctx.restore()
}

/** Every video clip live at a frame, bottom track first. */
function activeVideoClips(project: Project, frame: number): { clip: Clip; asset: MediaAsset }[] {
  const order = new Map(project.tracks.map((t, i) => [t.id, i]))
  return project.clips
    .filter((clip) => {
      const track = project.tracks.find((t) => t.id === clip.trackId)
      if (!track || track.kind !== 'video' || track.hidden) return false
      // A matte shape is a stencil for another clip, not a picture of its own,
      // and an adjustment layer is a grade rather than anything to draw.
      if (clip.matteOnly || clip.adjustment) return false
      return frame >= clip.start && frame < clipEnd(clip)
    })
    .sort((a, b) => (order.get(a.trackId) ?? 0) - (order.get(b.trackId) ?? 0) || a.start - b.start)
    .map((clip) => ({ clip, asset: project.assets.find((a) => a.id === clip.assetId)! }))
    .filter((l) => Boolean(l.asset))
}

export function Preview(): ReactNode {
  const project = useEditor((s) => s.project)
  const playhead = useEditor((s) => s.playhead)
  const playing = useEditor((s) => s.playing)
  const aspect = useEditor((s) => s.aspect)
  const splitRatio = useEditor((s) => s.splitRatio)
  const setSplitRatio = useEditor((s) => s.setSplitRatio)
  const selectedClipId = useEditor((s) => s.selectedClipId)
  const setPlayhead = useEditor((s) => s.setPlayhead)
  const notify = useEditor((s) => s.notify)
  const placePoolAsset = useEditor((s) => s.placePoolAsset)
  const placeTitle = useEditor((s) => s.placeTitle)
  const placeLibraryAsset = useEditor((s) => s.placeLibraryAsset)
  const applyDropIntent = useEditor((s) => s.applyDropIntent)
  const setPlaying = useEditor((s) => s.setPlaying)
  const loop = useEditor((s) => s.loop)
  const scrubAudio = useEditor((s) => s.scrubAudio)
  const dropExternal = useEditor((s) => s.dropExternal)
  const rangeIn = useEditor((s) => s.rangeIn)
  const rangeOut = useEditor((s) => s.rangeOut)
  const showThirds = useEditor((s) => s.showThirds)
  const showSafe = useEditor((s) => s.showSafe)
  const previewTool = useEditor((s) => s.previewTool)
  const setPreviewTool = useEditor((s) => s.setPreviewTool)
  const setKey = useEditor((s) => s.setKey)

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const boxRef = useRef<HTMLDivElement | null>(null)
  const holderRef = useRef<HTMLDivElement | null>(null)
  /**
   * One media element per clip, created lazily and reused.
   *
   * A single element cannot show a transition: both clips are on screen at once
   * and they are different files. The pool also gives multi-track preview for
   * free, since layering has the same requirement.
   */
  const pool = useRef(new Map<string, MediaElement>())
  const audioRefs = useRef(new Map<string, HTMLAudioElement>())
  /*
   * The mix, as a graph rather than as one number per element.
   *
   * A ref and not state: nothing about it renders, and rebuilding an
   * AudioContext on a re-render would cut the sound every time a panel moved.
   */
  const mixer = useRef(new PreviewMixer())
  /** The scrub throttle's state, and the timer that ends the current burst. */
  const scrubRef = useRef<ScrubState>(NO_SCRUB)
  const burstStop = useRef<number>(0)
  /**
   * The timeline's clock: when playback was anchored, and the last frame the
   * clock itself wrote. `wrote` is what tells a scrub apart from our own
   * advance — see `needsReanchor`.
   */
  const clockRef = useRef<{ anchor: ClockAnchor; wrote: number } | null>(null)

  /**
   * The chip offered after something is dropped on the picture.
   *
   * Dropping a photo has no single right answer — it might be the shot, a
   * corner inset over the shot, or a soft backdrop behind it — and picking one
   * silently is wrong two times in three. So the commonest is applied at once
   * and the others are offered, the way pasting into a slide asks what kind of
   * paste it was.
   */
  const [dropChip, setDropChip] = useState<{ clipId: string; intent: DropIntent } | null>(null)
  /** Report a blocked play() once, not sixty times a second. */
  const audioWarned = useRef(false)

  /*
   * Bumped when a LUT finishes loading.
   *
   * The grade is applied on the GPU from a file read asynchronously, so the
   * first frame drawn after a look is chosen has nothing to apply yet. Without
   * this the picture stays ungraded until something else happens to repaint.
   */
  const [, setGradeTick] = useState(0)
  /*
   * Set whenever the picture could have changed.
   *
   * A ref rather than state: marking the canvas dirty must not itself cause a
   * React render, or the flag becomes the very churn it exists to prevent.
   */
  const dirty = useRef(true)
  /*
   * Repaint marks the canvas dirty ITSELF rather than relying on a re-render.
   *
   * `draw` is memoised over the project, the playhead and the view settings,
   * and none of those move when a LUT finishes loading or an image finishes
   * decoding — so bumping state alone re-rendered the component and left the
   * canvas exactly as it was. The old always-on loop covered for that; a loop
   * that only paints on a change cannot.
   */
  const repaint = useCallback(() => {
    dirty.current = true
    setGradeTick((n) => n + 1)
  }, [])

  const [box, setBox] = useState({ width: 0, height: 0 })
  const [transform, setTransform] = useState<ViewTransform>({ scale: 1, offsetX: 0, offsetY: 0 })

  const fps = project.settings.fps
  const ensureFont = useCatalog((s) => s.ensureFont)
  // Wipes live in the asset library, so the preview needs both the table of
  // transitions and the root their mask files are relative to.
  const transitions = useCatalog((s) => s.transitions)
  const assetsRoot = useCatalog((s) => s.root)

  // Canvas silently falls back to a default face for a font it does not have.
  useEffect(() => {
    if (!project.captions.enabled) return
    void ensureFont(activeCaptionStyle(project).fontFamily)
  }, [project, ensureFont])

  /*
   * The faces the live text needs, and a repaint when they land.
   *
   * Text is drawn straight onto the canvas now, so a font that arrives after
   * the first frame changes the picture without changing any state — and the
   * draw loop only repaints on a change it can see. Keyed on the set of font
   * names rather than on the project, so typing does not re-run it on every
   * keystroke.
   */
  const textFonts = [
    ...new Set(project.clips.map((c) => c.text?.font).filter((f): f is string => Boolean(f)))
  ]
    .sort()
    .join('|')
  useEffect(() => {
    if (!textFonts) return
    let alive = true
    void Promise.all(textFonts.split('|').map((f) => ensureFont(f))).then(() => {
      if (alive) repaint()
    })
    return () => {
      alive = false
    }
  }, [textFonts, ensureFont, repaint])

  useLayoutEffect(() => {
    const element = boxRef.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => {
      setBox({ width: entry.contentRect.width, height: entry.contentRect.height })
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  /* --------------------------------------------------------- media pool */

  /**
   * Depth planes, pooled by file path rather than by clip.
   *
   * Two clips of the same photo share one bake, so they should share the decoded
   * images too — a reel that cycles twelve photos across thirty shots would
   * otherwise decode each plane three times over.
   */
  const planePool = useRef(new Map<string, HTMLImageElement>())
  const planeFor = useCallback((file: string): HTMLImageElement => {
    const existing = planePool.current.get(file)
    if (existing) return existing
    const image = new Image()
    // Same as elementFor: a decode finishing is invisible to React.
    image.addEventListener('load', repaint)
    // See elementFor: without this the GPU grade silently refuses the texture.
    image.crossOrigin = 'anonymous'
    withoutCorsOnError(image, mediaUrl(file))
    image.src = mediaUrl(file)
    image.style.display = 'none'
    holderRef.current?.appendChild(image)
    planePool.current.set(file, image)
    return image
  }, [repaint])

  /**
   * A wipe's mask, pooled by file.
   *
   * Keyed by the library-relative path rather than by clip, because one mask
   * commonly reveals every cut in a reel — and there are 405 of them, so
   * decoding one per cut is exactly the waste the plane pool exists to avoid.
   */
  const maskPool = useRef(new Map<string, HTMLImageElement>())
  const wipeMaskFor = useCallback(
    (file: string): HTMLImageElement => {
      const existing = maskPool.current.get(file)
      if (existing) return existing
      const image = new Image()
      const url = assetUrl(assetsRoot, file)
      image.addEventListener('load', repaint)
      image.crossOrigin = 'anonymous'
      withoutCorsOnError(image, url)
      image.src = url
      image.style.display = 'none'
      holderRef.current?.appendChild(image)
      maskPool.current.set(file, image)
      return image
    },
    [repaint, assetsRoot]
  )

  /**
   * Every transition by id, masks included.
   *
   * `transitionById` knows only the eight built-ins; the other 405 arrive from
   * the asset library at startup, and looking a wipe up in the built-in table
   * would find nothing and quietly draw a hard cut.
   */
  const transitionsById = useMemo(
    () => new Map<string, TransitionDef>(transitions.map((t) => [t.id, t])),
    [transitions]
  )

  /**
   * The greyscale half of a clip sticker, pooled beside the colour it belongs to.
   *
   * Keyed `<clip>#matte` so the ordinary pool machinery — cleanup, pausing what
   * is off screen — can find it from the clip id, and so two copies of the same
   * sticker at different moments each get their own playhead rather than
   * fighting over one element's currentTime.
   */
  const stickerMatteFor = useCallback(
    (clip: Clip, asset: MediaAsset): HTMLVideoElement | undefined => {
      if (!asset.matte) return undefined
      const key = `${clip.id}#matte`
      const existing = pool.current.get(key)
      if (existing instanceof HTMLVideoElement) return existing

      const url = mediaUrl(asset.matte)
      const video = document.createElement('video')
      // Same reason as the colour half: without CORS approval the grade pass
      // cannot texture from anything drawn off this element.
      video.crossOrigin = 'anonymous'
      withoutCorsOnError(video, url)
      video.src = url
      video.preload = 'auto'
      video.playsInline = true
      // It is a stencil. Whatever audio the pair carries belongs to the colour.
      video.muted = true
      video.addEventListener('loadeddata', repaint)
      video.addEventListener('seeked', repaint)
      video.addEventListener('canplay', repaint)
      video.style.display = 'none'
      holderRef.current?.appendChild(video)
      pool.current.set(key, video)
      return video
    },
    [repaint]
  )

  const elementFor = useCallback((clip: Clip, asset: MediaAsset): MediaElement => {
    // Generated artwork is overwritten in place, so the path alone cannot tell
    // the pool that the image changed. Keying by version does — and the version
    // has to reach the URL too, or the fresh element just re-reads Chromium's
    // cached copy of the old bytes.
    const version = clip.title?.version ?? clip.text?.version ?? clip.solid?.version
    const key = version === undefined ? clip.id : `${clip.id}:${version}`
    const existing = pool.current.get(key)
    if (existing) return existing

    /*
     * A generated card whose file has not been written yet.
     *
     * Text clips exist on the timeline before their PNG does — deliberately, so
     * adding text is instant — and pointing an <img> at an empty path would
     * fail to load, trip the no-CORS retry, and fail again on every frame. The
     * element stays empty and unattached; the preview draws the type live and
     * does not consult it.
     */
    const url = asset.path ? mediaUrl(asset.path, version) : ''
    let element: MediaElement
    if (!url) {
      const blank = new Image()
      // Not pooled: the next call must build a real one once the path arrives.
      return blank
    }
    /*
     * CORS, or the grade does nothing.
     *
     * forge-media:// is a different origin from the app, so without an explicit
     * crossOrigin the element is "cross-origin clean but not CORS-approved".
     * Canvas 2D happily draws it, which is why everything looked fine — but
     * WebGL's texImage2D refuses it outright, the grade pass caught the error
     * and fell back to the ungraded element, and the brightness slider moved
     * nothing with no error anywhere. The protocol already sends
     * Access-Control-Allow-Origin; this is the half that asks for it.
     */
    if (asset.kind === 'image') {
      const image = new Image()
      image.crossOrigin = 'anonymous'
      withoutCorsOnError(image, url)
      image.src = url
      element = image
    } else {
      const video = document.createElement('video')
      video.crossOrigin = 'anonymous'
      withoutCorsOnError(video, url)
      video.src = url
      video.preload = 'auto'
      video.playsInline = true
      element = video
    }
    /*
     * Wake the canvas when the picture arrives.
     *
     * The draw loop only repaints when something changed, and a decode
     * finishing is a change nothing else can see: React does not re-render
     * because an <img> loaded, so the frame would stay blank until the user
     * happened to touch something. The old loop repainted sixty times a second
     * regardless and hid this entirely — which is exactly how a cost like that
     * survives, by covering for the wiring it makes unnecessary.
     *
     * `seeked` matters just as much: scrubbing a paused video changes the
     * picture with no state change at all behind it.
     */
    if (element instanceof HTMLVideoElement) {
      element.addEventListener('loadeddata', repaint)
      element.addEventListener('seeked', repaint)
      element.addEventListener('canplay', repaint)
    } else {
      element.addEventListener('load', repaint)
    }

    // Kept in the DOM (hidden) because some browsers throttle decoding for
    // elements that were never attached.
    element.style.display = 'none'
    holderRef.current?.appendChild(element)
    pool.current.set(key, element)
    return element
  }, [repaint])

  // Discard elements for clips that no longer exist, or the pool grows forever.
  useEffect(() => {
    const live = new Set(
      project.clips.map((c) => {
        const version = c.title?.version ?? c.text?.version ?? c.solid?.version
        return version === undefined ? c.id : `${c.id}:${version}`
      })
    )
    for (const [clipId, element] of pool.current) {
      // A sticker's matte is pooled as `<clip>#matte`; it lives and dies with
      // the clip it belongs to rather than having an entry of its own.
      if (live.has(clipId.split('#')[0])) continue
      if (element instanceof HTMLVideoElement) element.pause()
      element.remove()
      pool.current.delete(clipId)
      // The graded copy is keyed by clip too, and is a full-size canvas.
      forgetGrade(clipId)
      forgetMatte(clipId)
      // Three more full-size canvases: the mask keeps an output, an inner copy
      // and a stencil, and none of them should outlive the clip.
      forgetMask(clipId)
      forgetTextPreview(clipId)
      // And the wipe's, which is keyed `<clip>#wipe` for the same reason a
      // sticker's matte is: it belongs to the clip, not to the mask file.
      forgetWipe(`${clipId}#wipe`)
    }

    // Plane images outlive individual clips, so they are evicted against the
    // bakes the project still holds rather than against the clip list.
    const liveFiles = new Set(
      Object.values(project.parallax ?? {}).flatMap((bake) => bake.layers.map((l) => l.file))
    )
    for (const [file, element] of planePool.current) {
      if (liveFiles.has(file)) continue
      element.remove()
      planePool.current.delete(file)
    }
  }, [project.clips, project.parallax])

  useEffect(() => {
    const elements = pool.current
    const audio = audioRefs.current
    const graph = mixer.current
    return () => {
      for (const [, element] of elements) {
        if (element instanceof HTMLVideoElement) element.pause()
        element.remove()
      }
      elements.clear()
      for (const [, element] of audio) element.pause()
      audio.clear()
      // An AudioContext is a real device handle; browsers allow only a handful,
      // so leaking one per mount is a preview that eventually falls silent.
      graph.close()
    }
  }, [])

  /* ------------------------------------------------------- audio tracks */

  useEffect(() => {
    const elements = audioRefs.current
    const wanted = new Set<string>()

    for (const clip of project.clips) {
      const track = project.tracks.find((t) => t.id === clip.trackId)
      if (!track || track.kind !== 'audio' || track.muted) continue
      const asset = project.assets.find((a) => a.id === clip.assetId)
      if (!asset?.hasAudio) continue

      wanted.add(clip.id)
      let element = elements.get(clip.id)
      if (!element) {
        element = new Audio(mediaUrl(asset.path))
        element.preload = 'auto'
        // Needed before `createMediaElementSource`: a graph that reads from a
        // tainted element is refused, and the refusal is silent.
        element.crossOrigin = 'anonymous'
        /*
         * Attach it, hidden.
         *
         * The video pool already does this, with a comment saying detached
         * elements get their decoding throttled — and the audio pool did not,
         * which is why a reel played silently except for a blip at each clip
         * boundary while video played fine.
         */
        element.style.display = 'none'
        holderRef.current?.appendChild(element)
        elements.set(clip.id, element)
      }
      /*
       * Through the graph if it will take it, and at its own volume if not.
       *
       * The fallback is not decoration: `createMediaElementSource` refuses a
       * cross-origin element, and a refusal that silently left the gain at its
       * default would mute the whole timeline. Losing the envelope is a much
       * smaller loss than losing the sound.
       */
      if (!mixer.current.attach(clip.id, element, clip.trackId)) {
        // element.volume cannot exceed 1; the graph is what gives +6 dB. And
        // with no graph there is no track gain, so solo is applied here or not
        // at all.
        element.volume = isAudible(track, project.tracks)
          ? Math.min(1, clampGain(clip.volume ?? 1))
          : 0
      }
    }

    for (const [id, element] of elements) {
      if (wanted.has(id)) continue
      element.pause()
      element.removeAttribute('src')
      element.remove()
      elements.delete(id)
      mixer.current.forget(id)
    }
  }, [project.clips, project.tracks, project.assets])

  /*
   * Which bus each track feeds, and whether it is heard at all.
   *
   * Both answers come from render/audibility.ts, which the export calls too —
   * so a muted video track, a soloed voice-over and a dialogue-marked audio
   * track sound the same here as they do in the file. Mute and solo are track
   * GAINS rather than skipped elements, so toggling either is instant and
   * re-decodes nothing.
   */
  useEffect(() => {
    for (const track of project.tracks) {
      mixer.current.routeTrack(track.id, audioRole(track))
      mixer.current.setTrackGain(track.id, isAudible(track, project.tracks) ? 1 : 0)
    }
  }, [project.tracks])

  /**
   * What one clip's sound should be worth at this frame.
   *
   * Three things multiplied, each from the function the EXPORT uses:
   * `clip.volume` is the fader, `valueAt` reads the drawn envelope — the same
   * curve the renderer compiles into an expression — and `fadeGainAt` walks the
   * same `qsin` that `afade` walks, over the same fades `fadesWithNeighbours`
   * derives. An overlap on one track is a crossfade in both, without either
   * side being told about it.
   */
  const clipGainAt = useCallback(
    (clip: Clip, frame: number): number => {
      const into = frame - clip.start
      // A detached clip's sound lives on the audio clip lifted off it.
      if (clip.audioDetached) return 0
      // The envelope REPLACES the fader when one is drawn — the export's rule,
      // asked of the same function. See `clipLevelAt`.
      const level = clipLevelAt(clip, into, (keys, f, d) => valueAt(keys, f, d, 1))

      // Neighbours on the SAME track, because an overlap is only a crossfade
      // between clips that are actually fighting for the same moment.
      const lane = project.clips
        .filter((c) => c.trackId === clip.trackId)
        .sort((a, b) => a.start - b.start)
      const at = lane.findIndex((c) => c.id === clip.id)
      const fades = fadesWithNeighbours(clip, lane[at - 1] ?? null, lane[at + 1] ?? null)

      return level * fadeGainAt(fades, into)
    },
    [project.clips]
  )

  /** Keep every live media element at the right time, playing or paused. */
  const syncMedia = useCallback(
    (frame: number, isPlaying: boolean) => {
      const activeIds = new Set<string>()

      /*
       * Scrubbing: let each audible element sound for a moment, then stop it.
       *
       * Deciding WHETHER once, here, rather than per element — otherwise ten
       * clips under the playhead would each run their own throttle and the
       * bursts would interleave into a continuous smear. The decision is a pure
       * function so the throttle is testable without dragging anything;
       * `shared/render/scrub.ts` has why the numbers are what they are.
       */
      const scrubbing = !isPlaying && scrubAudio
      const decision = scrubbing
        ? scrubStep(scrubRef.current, frame, performance.now())
        : { burst: false, next: NO_SCRUB }
      scrubRef.current = decision.next

      const burst = (element: HTMLMediaElement): void => {
        if (!decision.burst) return
        mixer.current.resume()
        void element.play().then(
          () => {
            // One timer per burst, cleared if another lands first, so a fast
            // drag does not leave a dozen pending stops racing each other.
            window.clearTimeout(burstStop.current)
            burstStop.current = window.setTimeout(() => {
              for (const [, media] of pool.current) {
                if (media instanceof HTMLVideoElement && !media.paused) media.pause()
              }
              for (const [, media] of audioRefs.current) if (!media.paused) media.pause()
            }, SCRUB_BURST_MS)
          },
          () => undefined
        )
      }

      for (const { clip, asset } of activeVideoClips(project, frame)) {
        activeIds.add(clip.id)
        if (asset.kind === 'image') continue
        const video = pool.current.get(clip.id)
        if (!(video instanceof HTMLVideoElement)) continue

        const target = framesToSeconds(sourceFrameFor(clip, frame), fps)
        if (Math.abs(video.currentTime - target) > (isPlaying ? DRIFT_TOLERANCE : 0.02)) {
          video.currentTime = target
        }

        /*
         * The sticker's matte, driven to the same instant.
         *
         * Not left to play on its own: two video elements started separately
         * drift, and a matte a few frames off its colour is a cut-out sliding
         * around its subject — which reads as a broken key rather than as a
         * sync problem. Held to the SAME target as the colour, so any drift
         * correction applies to both.
         */
        const matte = pool.current.get(`${clip.id}#matte`)
        if (matte instanceof HTMLVideoElement) {
          activeIds.add(`${clip.id}#matte`)
          if (Math.abs(matte.currentTime - target) > (isPlaying ? DRIFT_TOLERANCE : 0.02)) {
            matte.currentTime = target
          }
          const rate = clipRateAt(clip, frame)
          if (rate > 0 && Math.abs(matte.playbackRate - rate) > 0.001) matte.playbackRate = rate
          if (isPlaying && !clip.hold && matte.paused) void matte.play().catch(() => undefined)
          if ((!isPlaying || clip.hold) && !matte.paused) matte.pause()
        }
        /*
         * Play at the clip's own rate.
         *
         * Without this a slowed clip would seek correctly and then run away at
         * full speed between seeks, so the picture and the playhead would
         * disagree until the drift grew large enough to force a correction —
         * which reads as stuttering, not as slow motion. A ramp plays at the
         * rate under this frame, so between seeks it decelerates as the export does.
         */
        // A held frame (a freeze) plays at no rate at all: it is paused on its in-point below.
        const rate = clipRateAt(clip, frame)
        if (rate > 0 && Math.abs(video.playbackRate - rate) > 0.001) video.playbackRate = rate
        /*
         * A video clip's own sound, at the level the clip says.
         *
         * Only the AUDIO pool honoured `clip.volume`, so a video track's audio
         * played at full volume here whatever the clip asked for — and the
         * export, which has always applied it, disagreed. Clip stickers made
         * that visible: they land muted and would have talked anyway.
         */
        if (asset.hasAudio && mixer.current.attach(clip.id, video, clip.trackId)) {
          mixer.current.setClipGain(clip.id, clipGainAt(clip, frame))
        } else {
          const heard = project.tracks.find((t) => t.id === clip.trackId)
          video.volume =
            clip.audioDetached || !heard || !isAudible(heard, project.tracks)
              ? 0
              : Math.min(1, clampGain(clip.volume ?? 1))
        }
        if (isPlaying && !clip.hold && video.paused) void video.play().catch(() => undefined)
        if ((!isPlaying || clip.hold) && !video.paused && !scrubbing) video.pause()
        if (!isPlaying && scrubbing && asset.hasAudio) burst(video)
      }

      for (const [clipId, element] of pool.current) {
        if (activeIds.has(clipId)) continue
        if (element instanceof HTMLVideoElement && !element.paused) element.pause()
      }

      for (const [clipId, element] of audioRefs.current) {
        const clip = project.clips.find((c) => c.id === clipId)
        if (!clip) continue
        const live = frame >= clip.start && frame < clipEnd(clip)
        if (!live) {
          if (!element.paused) element.pause()
          continue
        }
        if (mixer.current.has(clip.id)) mixer.current.setClipGain(clip.id, clipGainAt(clip, frame))

        const target = framesToSeconds(sourceFrameFor(clip, frame), fps)
        // The sound is stretched to match, the same way the export stretches it.
        const audioRate = clipSpeed(clip)
        if (Math.abs(element.playbackRate - audioRate) > 0.001) {
          element.playbackRate = audioRate
        }

        if (!isPlaying) {
          /*
           * Land exactly, then sound for a moment if this is a scrub.
           *
           * The seek comes first either way: an 80 ms burst played from
           * wherever the element happened to be is worse than silence, because
           * it is confidently the wrong audio.
           */
          if (!element.paused && !scrubbing) element.pause()
          if (Math.abs(element.currentTime - target) > 0.02) element.currentTime = target
          if (scrubbing) burst(element)
          continue
        }

        /*
         * Never seek audio that is already playing.
         *
         * This used to assign currentTime on every drifted frame — sixty times a
         * second — and each assignment restarts the decoder. The result was a
         * continuous crackle, like a fan, while the exported file was clean.
         *
         * So seek once, when starting, and afterwards leave it alone. The wall
         * clock and the audio device wander apart by tens of milliseconds over a
         * reel, which is neither audible nor visible; only a real jump — a scrub
         * or a loop — is worth the glitch of correcting.
         *
         * Driving the playhead FROM the audio instead was tried and deadlocked:
         * `paused` flips false the instant play() is called, while currentTime
         * is still the value the seek just wrote, so the clock pinned itself to
         * a frame it had supplied and playback froze at zero.
         */
        if (element.paused) {
          element.currentTime = target
          void element.play().catch((err: unknown) => {
            if (audioWarned.current) return
            audioWarned.current = true
            console.error('[forge] preview audio refused to play:', err)
          })
        } else if (Math.abs(element.currentTime - target) > AUDIO_RESYNC) {
          element.currentTime = target
        }
      }
    },
    [project, fps, clipGainAt, scrubAudio]
  )

  useEffect(() => {
    if (!playing) syncMedia(playhead, false)
  }, [playhead, playing, syncMedia])

  useEffect(() => {
    clockRef.current = playing
      ? { anchor: { at: performance.now(), frame: playhead }, wrote: playhead }
      : null
    // A browser keeps an AudioContext suspended until a gesture, and pressing
    // play is the gesture. Asked on every play rather than once, because the
    // context can be suspended again by the tab going to the background.
    if (playing) mixer.current.resume()
    if (!playing) syncMedia(playhead, false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing])

  /**
   * Something dropped on the picture.
   *
   * It lands on the top video track at the playhead — "here, over this" is what
   * the gesture means — filling the frame, because a clip has to look like
   * something the instant it arrives. The chip then offers the other two.
   *
   * Audio is refused rather than quietly placed: a sound has no appearance, so
   * there is nothing for the canvas to say about it and nothing for the chip to
   * offer. The timeline is where a sound goes.
   */
  const onCanvasDrop = useCallback(
    async (payload: DragPayload | null): Promise<void> => {
      if (!payload) return
      if (payload.mediaKind === 'audio' || payload.kind === 'sfx') {
        notify('Sounds go on an audio track, not on the picture', 'info')
        return
      }
      if (payload.kind === 'transition') {
        notify('A transition goes on a cut in the timeline', 'info')
        return
      }

      const tracks = useEditor.getState().project.tracks.filter((t) => t.kind === 'video' && !t.locked)
      const top = tracks[tracks.length - 1]
      if (!top) return
      const before = new Set(useEditor.getState().project.clips.map((c) => c.id))

      if (payload.kind === 'media' && payload.assetId) {
        placePoolAsset(payload.assetId, top.id, playhead)
      } else if (payload.kind === 'title') {
        await placeTitle(payload.file, payload.name, top.id, playhead)
      } else {
        await placeLibraryAsset(payload.file, payload.name, top.id, playhead)
      }

      // Whichever clip is new is the one the chip belongs to. Asked after the
      // fact rather than threaded back, because each of those three places a
      // clip its own way and only one of them returns an id.
      const made = useEditor.getState().project.clips.find((c) => !before.has(c.id))
      if (!made) return
      applyDropIntent(made.id, 'fill')
      setDropChip({ clipId: made.id, intent: 'fill' })
    },
    [notify, placePoolAsset, placeTitle, placeLibraryAsset, applyDropIntent, playhead]
  )

  // A chip for a clip that has since been deleted has nothing to act on.
  useEffect(() => {
    if (dropChip && !project.clips.some((c) => c.id === dropChip.clipId)) setDropChip(null)
  }, [project.clips, dropChip])

  /* ------------------------------------------------------------- layers */

  const layersAtFrame = useCallback(
    (frame: number): Layer[] => {
      return activeVideoClips(project, frame).map(({ clip, asset }) => {
        const element = elementFor(clip, asset)
        const into = frame - clip.start
        // Where in its camera move — a split clip is a window onto one move.
        const { progress, seconds: elapsed } = moveAt(clip.motion ?? {}, clip.duration, into, project.settings.fps)

        const bake = parallaxBakeFor(project, clip)
        const planes = bake?.layers.map((layer) => ({
          element: planeFor(layer.file),
          depth: layer.depth,
          width: bake.width,
          height: bake.height
        }))

        /*
         * The transition, played rather than approximated.
         *
         * Every transition used to fade in here, whatever it actually was: a
         * slide dissolved instead of sliding, a punch-in dissolved instead of
         * punching in, and each of the 405 wipes dissolved instead of wiping.
         * The preview was not showing the edit, it was showing the one effect
         * the preview knew how to draw — so a cut was judged on timing that
         * only a dissolve would have.
         */
        const transitionFrames = clip.transitionIn?.durationFrames ?? 0
        const def = clip.transitionIn ? transitionsById.get(clip.transitionIn.id) : undefined
        const swept =
          transitionFrames > 0 ? Math.max(0, Math.min(1, into / transitionFrames)) : 1
        const canvas = ASPECTS[aspect]
        const transition = previewAt(def, swept, {
          duration: transitionFrames / project.settings.fps,
          canvasWidth: canvas.width,
          canvasHeight: canvas.height
        })
        /*
         * A wipe only exists while it is sweeping. Past the transition the
         * render's geq has saturated to fully opaque, which is the same picture
         * as no stencil at all — and cheaper to draw that way.
         */
        const wipe =
          def?.mask && transitionFrames > 0 && into < transitionFrames
            ? {
                mask: wipeMaskFor(def.mask),
                progress: swept,
                ...(def.softness === undefined ? {} : { softness: def.softness })
              }
            : undefined
        const keyed = {
          zoom: valueAt(clip.keyframes?.zoom ?? [], into, clip.duration, 1),
          rotation: valueAt(clip.keyframes?.rotation ?? [], into, clip.duration, 0),
          opacity: valueAt(clip.keyframes?.opacity ?? [], into, clip.duration, 1)
        }
        const shapeClip = clip.matte
          ? project.clips.find((c) => c.id === clip.matte!.clipId)
          : undefined
        const shapeAsset = shapeClip
          ? project.assets.find((a) => a.id === shapeClip.assetId)
          : undefined
        const matteElement =
          shapeClip && shapeAsset ? elementFor(shapeClip, shapeAsset) : undefined

        return {
          clip, asset, element, transition, progress, elapsed, planes, keyed,
          matteElement, matteClip: shapeClip,
          stickerMatte: stickerMatteFor(clip, asset),
          ...(wipe ? { wipe } : {})
        }
      })
    },
    [project, aspect, elementFor, planeFor, stickerMatteFor, transitionsById, wipeMaskFor]
  )

  /* ---------------------------------------------------------- draw loop */

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    const target = ASPECTS[aspect]
    const layers = layersAtFrame(playhead)

    canvas.width = Math.round(box.width * dpr)
    canvas.height = Math.round(box.height * dpr)
    canvas.style.width = `${box.width}px`
    canvas.style.height = `${box.height}px`
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = '#0b0d10'
    ctx.fillRect(0, 0, box.width, box.height)

    // Two independent viewports, not one image wiped across. Comparing a 16:9
    // source with a 9:16 output needs both framings whole — a swipe shows half
    // of each and tells you nothing.
    const splitX = Math.round(box.width * splitRatio)
    const gutter = splitX > 0 && splitX < box.width ? 1 : 0
    const leftBox = { x: 0, y: 0, width: splitX - gutter, height: box.height }
    const rightBox = {
      x: splitX + gutter,
      y: 0,
      width: box.width - splitX - gutter,
      height: box.height
    }

    /*
     * Picking a key colour: the clip alone, as it arrived.
     *
     * No key, no grade, no mask, nothing over it and nothing faded — the pick
     * reads the pixel under the click off this canvas, so what is drawn here
     * has to be the colour ffmpeg's key will actually be measuring. A key
     * picked through its own key would be picking from the hole it made.
     */
    const pickLayer =
      previewTool === 'key'
        ? layers.find((l) => l.clip.id === selectedClipId && l.clip.key) ?? null
        : null
    const raw = pickLayer !== null
    const drawn = pickLayer ? [pickLayer] : layers

    const top = drawn[drawn.length - 1] ?? null
    const naturalW = top?.asset.width ?? 16
    const naturalH = top?.asset.height ?? 9

    /*
     * Text never waits on a file.
     *
     * Its picture is drawn live, so a text clip is showable the instant it
     * exists — gating it on the baked PNG having loaded is what made a new text
     * clip appear a beat after it was asked for, and made every edit to the
     * words wait for a disk write nobody was watching.
     */
    const elementReady = (element: MediaElement): boolean =>
      element instanceof HTMLVideoElement
        ? element.readyState >= 2
        : element.complete && element.naturalWidth > 0

    /*
     * A clip that DRAWS itself is always ready.
     *
     * Text and clippings both paint from their spec on a canvas here, so
     * neither has anything to wait for — and both exist on the timeline
     * before their file does, deliberately, so adding one is instant.
     * Gating them on an `<img>` that has not been written yet leaves the
     * layer permanently unready and the preview permanently black, which is
     * exactly what clippings did until this said `paper` as well as `text`.
     */
    const drawsItself = (layer: Layer): boolean =>
      Boolean(layer.clip.text ?? layer.clip.paper ?? layer.clip.carousel)

    const ready = (layer: Layer): boolean =>
      drawsItself(layer) ? true : elementReady(layer.element)

    /*
     * Graded on the GPU before it is drawn.
     *
     * Returns the element itself when the clip has no grade, so an ungraded
     * timeline — the overwhelming majority of clips — costs nothing.
     */
    /*
     * Text is drawn live, never fetched.
     *
     * A text clip's asset is a PNG the app bakes for the export, and the
     * preview used to wait for that file: every pause in typing cost a
     * full-canvas PNG encode, an IPC hop, a disk write and a re-decode before a
     * single letter changed on screen. The letters are drawn here instead, from
     * the same shared layout the bake uses, so typing is immediate and the file
     * is written in the background where nobody is waiting for it.
     */
    const sourceFor = (layer: Layer): MediaElement | HTMLCanvasElement => {
      /*
       * Clippings are drawn live too, and they have to be.
       *
       * Unlike a caption this never settles — the effect IS the cut from page
       * to page — so waiting on a baked file would show one frozen page while
       * the run played in the export. The preview draws the same pages the
       * bake does, from the same spec.
       */
      if (layer.clip.carousel) {
        /*
         * Drawn live like the others, and it must be: the ring's whole point
         * is that it TURNS, so a frozen baked frame would show one angle
         * while the export played the move.
         */
        const live = carouselPreviewCanvas(
          layer.clip.id,
          layer.clip.carousel,
          layer.clip.carousel.assetIds
            .map((id) => project.assets.find((a) => a.id === id)?.path)
            .filter((path): path is string => Boolean(path)),
          ASPECTS[aspect].width,
          ASPECTS[aspect].height,
          { frame: playhead - layer.clip.start, fps },
          repaint
        )
        if (live) return live
      }

      if (layer.clip.paper) {
        const live = paperPreviewCanvas(
          layer.clip.id,
          layer.clip.paper,
          ASPECTS[aspect].width,
          ASPECTS[aspect].height,
          { frame: playhead - layer.clip.start, fps }
        )
        if (live) return live
      }

      if (layer.clip.text) {
        const live = textPreviewCanvas(
          layer.clip.id,
          layer.clip.text,
          ASPECTS[aspect].width,
          ASPECTS[aspect].height,
          // Frames from the clip's own first frame, so an animation plays when
          // the playhead reaches it rather than when the timeline starts.
          { frame: playhead - layer.clip.start, fps }
        )
        if (live) return live
      }

      /*
       * A clip sticker, cut out by the matte that travels with it.
       *
       * Applied to the SOURCE rather than alongside the other stencils, because
       * this alpha belongs to the file and not to anything on the timeline: the
       * colour half still has green in its RGB, and every path from here — the
       * grade, the mask, both viewports — has to see the cut-out version or the
       * sticker is a green rectangle in one of them.
       */
      if (
        layer.stickerMatte &&
        elementReady(layer.stickerMatte) &&
        elementReady(layer.element) &&
        layer.asset.width &&
        layer.asset.height
      ) {
        const cut = lumaMattedSource(
          `${layer.clip.id}#sticker`,
          layer.element,
          layer.stickerMatte,
          layer.asset.width,
          layer.asset.height
        )
        if (cut) return cut
      }
      return layer.element
    }

    const picture = (layer: Layer): CanvasImageSource =>
      raw
        ? sourceFor(layer)
        : gradedSource(sourceFor(layer), layer.clip.color, layer.clip.id, repaint, layer.clip.key)

    let sourceFit: ViewTransform = { scale: 1, offsetX: 0, offsetY: 0 }

    /* ----- left viewport: the whole source frame, reframe outlined ----- */
    if (leftBox.width > 8) {
      ctx.save()
      ctx.beginPath()
      ctx.rect(leftBox.x, leftBox.y, leftBox.width, leftBox.height)
      ctx.clip()

      const fit = fitTransform(naturalW, naturalH, leftBox.width, leftBox.height)
      sourceFit = { ...fit, offsetX: fit.offsetX + leftBox.x, offsetY: fit.offsetY + leftBox.y }

      for (const layer of drawn) {
        if (!ready(layer)) continue
        const w = layer.asset.width ?? naturalW
        const h = layer.asset.height ?? naturalH
        const layerFit = fitTransform(w, h, leftBox.width, leftBox.height)
        // The source viewport shows the whole frame as it is being blended in;
        // where it lands and how tight it is are the output's business.
        ctx.globalAlpha = raw ? 1 : layer.transition.alpha
        ctx.drawImage(
          picture(layer),
          leftBox.x + layerFit.offsetX,
          leftBox.y + layerFit.offsetY,
          w * layerFit.scale,
          h * layerFit.scale
        )
      }
      ctx.globalAlpha = 1

      // The rectangle the export really cuts, not the raw one — they differ for
      // a crop hanging off an edge (shared/render/crop.ts effectiveCrop).
      const crop = top?.clip.crop ? effectiveCrop(top.clip.crop, { width: naturalW, height: naturalH }) : undefined
      if (crop) {
        ctx.fillStyle = 'rgba(8,10,13,0.66)'
        ctx.beginPath()
        ctx.rect(sourceFit.offsetX, sourceFit.offsetY, naturalW * sourceFit.scale, naturalH * sourceFit.scale)
        ctx.rect(
          sourceFit.offsetX + crop.x * sourceFit.scale,
          sourceFit.offsetY + crop.y * sourceFit.scale,
          crop.width * sourceFit.scale,
          crop.height * sourceFit.scale
        )
        ctx.fill('evenodd')
      }
      ctx.restore()
    }

    /* ----- right viewport: the finished frame, captions included ----- */
    if (rightBox.width > 8) {
      ctx.save()
      ctx.beginPath()
      ctx.rect(rightBox.x, rightBox.y, rightBox.width, rightBox.height)
      ctx.clip()

      const frame = outputFrame(box, target, splitRatio)!

      ctx.fillStyle = '#000'
      ctx.fillRect(frame.x, frame.y, frame.width, frame.height)

      /*
       * Adjustment layers, flushed in track order.
       *
       * One grades everything BELOW it, so it has to run after the layers under
       * it are drawn and before any layer above it — grading the finished frame
       * at the end would wrongly catch a title sitting on top of it, which is
       * exactly where titles usually sit.
       */
      const trackOrder = new Map(project.tracks.map((t, i) => [t.id, i]))
      const pendingGrades = project.clips
        .filter(
          (c) =>
            !raw &&
            c.adjustment &&
            playhead >= c.start &&
            playhead < clipEnd(c) &&
            !project.tracks.find((t) => t.id === c.trackId)?.hidden
        )
        .sort((a, b) => (trackOrder.get(a.trackId) ?? 0) - (trackOrder.get(b.trackId) ?? 0))

      const flushGradesBelow = (limit: number): void => {
        while (pendingGrades.length > 0 && (trackOrder.get(pendingGrades[0].trackId) ?? 0) < limit) {
          const grade = pendingGrades.shift()!
          gradeRegion(ctx, frame, grade.color, grade.id, repaint)
        }
      }

      for (const layer of drawn) {
        flushGradesBelow(trackOrder.get(layer.clip.trackId) ?? 0)
        const w = layer.asset.width ?? naturalW
        const h = layer.asset.height ?? naturalH
        // Exactly what the export crops to, so the finished frame on screen is
        // the finished frame in the file.
        const crop: CropRect = effectiveCrop(layer.clip.crop, { width: w, height: h })
        const motion = layer.clip.motion

        /*
         * The clip's own box, not the whole canvas.
         *
         * Scale, position and opacity live on Clip.transform and were rendered
         * by nothing, in either path — which is why a prop dropped on a track
         * covered the entire frame with no way to shrink it. The box comes from
         * the same function the renderer uses.
         */
        const target = ASPECTS[aspect]
        const boxOf = clipBox(layer.clip, { width: target.width, height: target.height })
        const px = frame.width / target.width
        const py = frame.height / target.height

        // A path moves the clip relative to its resting box — the same offset
        // the renderer compiles into the overlay expression.
        const travel = layer.clip.path
          ? pathAt(layer.clip.path, playhead - layer.clip.start, layer.clip.duration)
          : null
        const driftX = travel ? (travel.x * target.width) / 2 : 0
        const driftY = travel ? (travel.y * target.height) / 2 : 0
        const inner =
          boxOf.fit === 'cover'
            ? coverTransform(crop.width, crop.height, boxOf.width * px, boxOf.height * py)
            : fitTransform(crop.width, crop.height, boxOf.width * px, boxOf.height * py)

        /*
         * A wipe whose mask has not decoded yet falls back to the fade.
         *
         * Without this the clip would pop to fully visible for the frame or two
         * a first decode takes — louder and more wrong than the approximation
         * it replaces, and it would happen exactly when the user drops a new
         * wipe on a cut and looks straight at it.
         */
        const pending = layer.wipe !== undefined && !elementReady(layer.wipe.mask)
        const blend = pending ? layer.wipe!.progress : layer.transition.alpha
        ctx.globalAlpha = raw ? 1 : blend * boxOf.opacity * layer.keyed.opacity

        // A transition offsets the clip from where it rests — the same number
        // the renderer adds to the box inside its overlay expression.
        const slideX = layer.transition.dx
        const slideY = layer.transition.dy

        const destination = [
          frame.x + (boxOf.x + driftX + slideX) * px + inner.offsetX,
          frame.y + (boxOf.y + driftY + slideY) * py + inner.offsetY,
          crop.width * inner.scale,
          crop.height * inner.scale
        ] as const

        /*
         * Parallax: draw the planes, back to front, each at its own rate.
         *
         * Planes are baked at a capped working size, so the crop — which is in
         * asset pixels — has to be scaled into plane space before the move is
         * applied inside it.
         */
        if (layer.planes && motion) {
          for (const [index, plane] of layer.planes.entries()) {
            if (!plane.element.complete || plane.element.naturalWidth === 0) continue
            const scale = plane.width / Math.max(1, w)
            const region = {
              x: crop.x * scale,
              y: crop.y * scale,
              width: crop.width * scale,
              height: crop.height * scale
            }
            const rect = motionSourceRect(
              motion,
              layer.progress,
              layer.elapsed,
              region.width,
              region.height,
              planeShare(motion, motion.amount, plane.depth)
            )
            ctx.drawImage(
              raw
                ? plane.element
                : gradedSource(plane.element, layer.clip.color, `${layer.clip.id}:p${index}`, repaint, layer.clip.key),
              region.x + rect.sx, region.y + rect.sy, rect.sw, rect.sh,
              ...destination
            )
          }
          continue
        }

        /*
         * Media that is not there says so, in the frame.
         *
         * A missing file leaves `ready()` false forever, so the layer was
         * skipped and the preview showed black — indistinguishable from a clip
         * that is genuinely black, and from the app failing to draw at all.
         */
        if (layer.asset.offline) {
          ctx.save()
          ctx.globalAlpha = 1
          ctx.fillStyle = 'rgba(69,10,10,0.92)'
          ctx.fillRect(destination[0], destination[1], destination[2], destination[3])
          ctx.strokeStyle = 'rgba(248,113,113,0.9)'
          ctx.lineWidth = 2
          ctx.strokeRect(
            destination[0] + 1,
            destination[1] + 1,
            destination[2] - 2,
            destination[3] - 2
          )
          ctx.fillStyle = 'rgb(252,165,165)'
          ctx.textAlign = 'center'
          ctx.textBaseline = 'middle'
          const cx = destination[0] + destination[2] / 2
          const cy = destination[1] + destination[3] / 2
          ctx.font = '600 13px ui-sans-serif, system-ui, sans-serif'
          ctx.fillText('Media offline', cx, cy - 9)
          ctx.font = '12px ui-sans-serif, system-ui, sans-serif'
          ctx.fillStyle = 'rgba(252,165,165,0.8)'
          ctx.fillText(layer.asset.name, cx, cy + 9)
          ctx.restore()
          continue
        }

        if (!ready(layer)) continue

        /*
         * Rotation, around the middle of where the clip lands.
         *
         * The preview never drew rotation at all — not even the static kind —
         * so a turned prop looked upright on screen and turned in the export.
         */
        const turn = layer.clip.keyframes?.rotation ? layer.keyed.rotation : boxOf.rotation
        const turned = Math.abs(turn) > 0.01
        if (turned) {
          ctx.save()
          const cx = destination[0] + destination[2] / 2
          const cy = destination[1] + destination[3] / 2
          ctx.translate(cx, cy)
          ctx.rotate((turn * Math.PI) / 180)
          ctx.translate(-cx, -cy)
        }

        const clipped = boxOf.fit === 'cover'
        if (clipped) {
          ctx.save()
          ctx.beginPath()
          ctx.rect(
            frame.x + (boxOf.x + driftX + slideX) * px,
            frame.y + (boxOf.y + driftY + slideY) * py,
            boxOf.width * px,
            boxOf.height * py
          )
          ctx.clip()
        }

        // A flat move: the same rectangle the renderer's zoompan would show,
        // narrowed again by a transition that punches in.
        const moved = motion
          ? motionSourceRect(motion, layer.progress, layer.elapsed, crop.width, crop.height)
          : zoomedRect(crop.width, crop.height, layer.keyed.zoom)
        const rect =
          layer.transition.scale === 1 ? moved : insetRect(moved, layer.transition.scale)

        /*
         * The shape, live.
         *
         * A text shape is drawn from its spec like any other text, so retyping
         * the word changes the hole in the picture immediately — which is the
         * entire point of the feature — rather than after a file is written.
         */
        const matteShape = raw
          ? null
          : layer.matteClip?.text
          ? textPreviewCanvas(
              layer.matteClip.id,
              layer.matteClip.text,
              ASPECTS[aspect].width,
              ASPECTS[aspect].height,
              // The shape animates too — words that fly in carry the footage
              // they are cut from with them.
              { frame: playhead - layer.matteClip.start, fps }
            )
          : layer.matteElement && elementReady(layer.matteElement)
            ? layer.matteElement
            : null

        const shaped =
          matteShape
            ? mattedSource(
                layer.clip.id,
                picture(layer),
                matteShape,
                { sx: crop.x + rect.sx, sy: crop.y + rect.sy, sw: rect.sw, sh: rect.sh },
                destination[2],
                destination[3]
              )
            : null

        /*
         * The mask, applied here and not inside the grade pass.
         *
         * This is the one point where the clip has been fitted to its box, and
         * the box is the space a mask's fractions are measured in — the same
         * space ffmpeg applies them in, after its own fit. Doing it earlier, on
         * the source element, would put the shape in the wrong place for every
         * clip that is cropped or scaled.
         */
        // The mask as it stands at this frame — a moving one is keyed.
        const mask = raw ? undefined : maskAt(layer.clip, playhead - layer.clip.start)
        // Grade mode needs the PLAIN picture underneath; if `picture` were the
        // background, everything would already be graded and "only inside"
        // would show nothing at all.
        const overMatte = shaped !== null && mask?.mode !== 'grade'
        const masked = mask
          ? maskedSource(
              layer.clip.id,
              mask.mode === 'grade' ? layer.element : (overMatte ? shaped! : picture(layer)),
              mask,
              overMatte
                ? null
                : { sx: crop.x + rect.sx, sy: crop.y + rect.sy, sw: rect.sw, sh: rect.sh },
              destination[2],
              destination[3],
              mask.mode === 'grade' ? picture(layer) : undefined
            )
          : null

        /*
         * The wipe, last, over whatever the clip had already become.
         *
         * It is a stencil on the finished layer, so it composes with a matte, a
         * mask and a grade instead of competing with them — the same order the
         * render uses, where the wipe's alpha is multiplied into the one
         * stencil every other shape has already contributed to.
         *
         * A masked or matted layer arrives as a canvas already cut to the
         * destination, so it is wiped whole; a plain picture is wiped straight
         * from its source rectangle.
         */
        const finished = masked ?? shaped
        const wiped =
          layer.wipe && !pending && !raw
            ? wipedSource(
                `${layer.clip.id}#wipe`,
                finished ?? picture(layer),
                layer.wipe.mask,
                finished
                  ? { sx: 0, sy: 0, sw: destination[2], sh: destination[3] }
                  : { sx: crop.x + rect.sx, sy: crop.y + rect.sy, sw: rect.sw, sh: rect.sh },
                destination[2],
                destination[3],
                layer.wipe.progress,
                layer.wipe.softness
              )
            : null

        if (wiped) {
          ctx.drawImage(wiped, destination[0], destination[1], destination[2], destination[3])
        } else if (masked) {
          ctx.drawImage(masked, destination[0], destination[1], destination[2], destination[3])
        } else if (shaped) {
          // Already cut to size by the scratch canvas, so it draws whole.
          ctx.drawImage(shaped, destination[0], destination[1], destination[2], destination[3])
        } else {
          ctx.drawImage(
            picture(layer),
            crop.x + rect.sx, crop.y + rect.sy, rect.sw, rect.sh,
            ...destination
          )
        }
        if (clipped) ctx.restore()
        if (turned) ctx.restore()
      }
      // Anything above every picture still applies.
      flushGradesBelow(Number.POSITIVE_INFINITY)
      ctx.globalAlpha = 1

      /*
       * An empty project says what to do with itself.
       *
       * A black rectangle is indistinguishable from a broken preview, from a
       * clip that is genuinely black, and from an app that has not finished
       * loading. Two sentences here are the difference between someone
       * starting and someone closing the window.
       */
      if (project.clips.length === 0) {
        ctx.save()
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        const cx = frame.x + frame.width / 2
        const cy = frame.y + frame.height / 2
        ctx.fillStyle = 'rgba(226,232,240,0.72)'
        ctx.font = '600 14px ui-sans-serif, system-ui, sans-serif'
        ctx.fillText('Drop pictures or a clip here', cx, cy - 10)
        ctx.font = '12px ui-sans-serif, system-ui, sans-serif'
        ctx.fillStyle = 'rgba(148,163,184,0.7)'
        ctx.fillText('or open Create and press Direct', cx, cy + 10)
        ctx.restore()
      }

      drawGuides(ctx, frame, showThirds, showSafe)

      // Captions are drawn here rather than only at export: judging a style by
      // rendering a video first is an unusable feedback loop.
      if (project.captions.enabled && !raw) {
        /*
         * The caption's source clip, chosen the way the EXPORT chooses it.
         *
         * This used to read `top` — the highest layer at the playhead — so
         * putting a text card or a sticker over the picture made the captions
         * disappear from the preview while they still burned into the exported
         * file. Both sides ask the same shared function now.
         */
        const source = captionSourceClip(project, playhead)
        if (source) {
          const style = activeCaptionStyle(project)
          const caption = captionAt(project, source, playhead, style)
          if (caption) drawCaptions(ctx, frame, style, caption, fps)
        }
      }
      ctx.restore()
    }

    if (gutter) {
      ctx.save()
      ctx.strokeStyle = 'rgba(249,115,65,0.9)'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(splitX + 0.5, 0)
      ctx.lineTo(splitX + 0.5, box.height)
      ctx.stroke()
      ctx.restore()
    }

    setTransform((prev) =>
      prev.scale === sourceFit.scale &&
      prev.offsetX === sourceFit.offsetX &&
      prev.offsetY === sourceFit.offsetY
        ? prev
        : sourceFit
    )
    // showThirds/showSafe/previewTool belong here: without them the memoised
    // draw closes over their opening values, the toolbox button lights up, and
    // the picture never changes.
  }, [
    aspect,
    splitRatio,
    box.width,
    box.height,
    playhead,
    layersAtFrame,
    project,
    showThirds,
    showSafe,
    previewTool,
    // Picking draws the selected clip alone, so which clip that is matters.
    selectedClipId,
    repaint
  ])

  // Any change `draw` can see — a new project, a moved playhead, a toggled
  // guide — gives it a new identity, and that is the signal to repaint.
  useEffect(() => {
    dirty.current = true
  }, [draw])

  useEffect(() => {
    let raf = 0
    const tick = (): void => {
      /*
       * Repaint when something changed, or when it is moving. Not otherwise.
       *
       * This loop used to call draw() on every animation frame regardless —
       * sixty full composites a second of every layer, every grade and every
       * mask, forever, while the app sat idle on a still frame. That is a core
       * of a laptop spent painting a picture identical to the one already on
       * screen, and it is why everything ELSE felt heavy: each real interaction
       * had to compete with it for the same main thread.
       *
       * `draw` is a useCallback over the project, the playhead and the view
       * settings, so its identity changing IS the signal that the picture is
       * stale. Playback is its own reason to keep going.
       */
      if (dirty.current || playing) {
        dirty.current = false
        draw()
      }

      if (playing) {
        const now = performance.now()
        /*
         * The ducker, advanced once per frame.
         *
         * Here rather than on a timer of its own so it steps with the clock it
         * is mixing against — and only while playing, because a compressor
         * following silence is a compressor doing nothing sixty times a second.
         */
        const levels = mixer.current.step(now)
        // Published, not stored: meters read this in their own loop so nothing
        // in React re-renders sixty times a second to move a bar.
        publishLevels(levels.peak, levels.tracks, now)

        /*
         * Re-anchor whenever something else moved the playhead.
         *
         * A scrub, Home, or clicking the ruler during playback changes the
         * playhead without touching the clock, and computing from the stale
         * anchor would drag it straight back. The old code never hit this
         * because a media element rewrote the playhead every tick anyway,
         * which hid the problem rather than solving it.
         */
        if (!clockRef.current || needsReanchor(clockRef.current.wrote, playhead)) {
          clockRef.current = { anchor: { at: now, frame: playhead }, wrote: playhead }
        }

        /*
         * Playback obeys the marked range.
         *
         * The point of marking one is to watch two seconds of a ninety-second
         * reel without watching the other eighty-eight, so the out point stops
         * playback and the in point is where a loop returns to.
         */
        const step = clockStep(
          clockRef.current.anchor,
          now,
          fps,
          rangeOut ?? projectDuration(project),
          loop,
          rangeIn ?? 0
        )

        if (step.kind === 'loop') {
          clockRef.current = { anchor: { at: now, frame: step.frame }, wrote: step.frame }
          setPlayhead(step.frame)
          syncMedia(step.frame, true)
        } else if (step.kind === 'stop') {
          setPlaying(false)
          setPlayhead(step.frame)
          clockRef.current = null
        } else {
          clockRef.current.wrote = step.frame
          setPlayhead(step.frame)
          syncMedia(step.frame, true)
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [draw, playing, playhead, fps, project, layersAtFrame, setPlayhead, setPlaying, syncMedia, loop, rangeIn, rangeOut])

  /*
   * The selected text clip, when the playhead is actually over it.
   *
   * Editing words that are not on screen would type into nothing.
   */
  const selectedClip = (() => {
    const found = project.clips.find((c) => c.id === selectedClipId)
    if (!found) return null
    return clipCoversFrame(found, playhead) ? found : null
  })()
  const selectedTextClip = selectedClip?.text ? selectedClip : null
  /*
   * Handles go on everything except text.
   *
   * A text clip is a full-canvas transparent PNG, so scaling its transform would
   * scale the whole frame rather than the words. TextOverlay moves and sizes the
   * type itself, which is what the user is actually reaching for.
   */
  const selectedBoxClip = selectedClip && !selectedClip.text ? selectedClip : null
  const outputRect = outputFrame(box, ASPECTS[aspect], splitRatio)

  const topLayer = layersAtFrame(playhead).at(-1) ?? null
  /*
   * The reframe rectangle follows the TOOL now, not the split view.
   *
   * It used to appear only when the source/output comparison was open, which is
   * an odd home for it: comparing has nothing to do with choosing a crop, and
   * anyone who never opened the split never found the tool at all.
   */
  /*
   * A clip that is selected but not under the playhead.
   *
   * It is not being drawn, so it has no box and no handles — there is nothing
   * on screen to grab. Meanwhile the Inspector's colour controls keep working,
   * because they read the selection directly rather than the frame. That
   * combination is genuinely confusing: it looks precisely like sizing and
   * moving are broken while brightness is fine, which is how it was reported.
   *
   * Saying so, with one click to get there, is the difference between a tool
   * that appears broken and a tool that is merely showing a different moment.
   */
  const offScreenClip = (() => {
    if (!selectedClipId || selectedClip) return null
    return project.clips.find((c) => c.id === selectedClipId) ?? null
  })()

  // The mask tool needs no layer under the pointer and no split view — the
  // shape belongs to the selected clip wherever its pixels happen to be.
  const showMask = previewTool === 'mask' && selectedClip?.mask !== undefined
  // Picking a key colour: the click samples the picture, so nothing else may take it.
  const pickingKey = previewTool === 'key' && selectedClip?.key !== undefined

  /*
   * No `splitRatio` condition — that was the bug.
   *
   * The Reframe BUTTON was lifted out of the split view and into the tool
   * strip, with a note in Toolbox saying that comparing source against output
   * has nothing to do with choosing a crop. This gate was left behind, so
   * pressing Reframe with the split closed did nothing at all: the tool was
   * moved and its visibility still depended on the place it moved from.
   */
  const showCrop =
    previewTool === 'crop' &&
    topLayer !== null &&
    topLayer.clip.id === selectedClipId &&
    topLayer.clip.crop !== undefined

  return (
    <div className="flex h-full flex-col bg-ink-950">
      <div
        ref={boxRef}
        // `select-none` for the same reason the timeline has it: every gesture
        // on the picture — moving a clip, dragging a corner, pulling a crop
        // edge — is a drag of an object, and the browser's default is to paint
        // the labels it passes over in selection blue and leave them that way.
        className="relative flex-1 select-none overflow-hidden"
        onDragOver={(e) => {
          // `types` includes 'Files' during a desktop drag; the files
          // themselves are only readable on drop.
          if (!isAssetDrag(e) && !e.dataTransfer.types.includes('Files')) return
          e.preventDefault()
          e.dataTransfer.dropEffect = 'copy'
        }}
        onDrop={(e) => {
          /*
           * Files from the desktop, imported and placed.
           *
           * Only the Media grid took an external drop, so dropping a photo on
           * the PICTURE — the obvious target, and the one every editor accepts
           * — did nothing at all. It lands at the playhead on the top lane,
           * which is what dropping something on the frame means.
           */
          const files = Array.from(e.dataTransfer.files)
          if (files.length > 0) {
            e.preventDefault()
            const paths = files
              .map((file) => window.forge.getPathForFile(file))
              .filter((path) => path.length > 0)
            if (paths.length === 0) {
              notify('Those items have no file on disk — use Import instead', 'info')
              return
            }
            const tracks = useEditor.getState().project.tracks.filter((t) => t.kind === 'video')
            void dropExternal(paths, tracks[tracks.length - 1]?.id ?? null, playhead)
            return
          }
          if (!isAssetDrag(e)) return
          e.preventDefault()
          void onCanvasDrop(readDragPayload(e))
        }}
      >
        {/* Tagged so the style gallery can show a look over the real frame
            rather than over an invented background. */}
        <canvas ref={canvasRef} data-forge-preview="1" className="absolute inset-0" />
        <div ref={holderRef} className="hidden" />

        {showCrop && topLayer && (
          <CropOverlay clip={topLayer.clip} asset={topLayer.asset} transform={transform} />
        )}

        {/* Edit the words on the picture, not in a panel two columns away. */}
        {selectedTextClip && outputRect && (
          <TextOverlay
            clip={selectedTextClip}
            frame={outputRect}
            canvas={ASPECTS[aspect]}
          />
        )}

        {/* Move, scale and rotate anything else where you can see it. */}
        {selectedBoxClip && outputRect && !showCrop && !showMask && !pickingKey && (
          <TransformOverlay
            clip={selectedBoxClip}
            frame={outputRect}
            canvas={ASPECTS[aspect]}
          />
        )}

        {/*
         * The mask, on top of everything and instead of the transform box: two
         * sets of drag handles over one picture is a coin toss about which one
         * a drag will land on.
         */}
        {showMask && selectedClip?.mask && outputRect && (
          <MaskOverlay
            clip={selectedClip}
            // Where the shape is NOW, so a drag starts from what is on screen.
            mask={maskAt(selectedClip, playhead - selectedClip.start) ?? selectedClip.mask}
            frame={outputRect}
            canvas={ASPECTS[aspect]}
          />
        )}

        {pickingKey && selectedClip && (
          <KeyPickOverlay
            canvasRef={canvasRef}
            onPick={(color) => {
              if (!color) {
                notify('Click on the screen itself', 'info')
                return
              }
              setKey(selectedClip.id, { ...saneKey(selectedClip.key), color })
              setPreviewTool('select')
            }}
            onCancel={() => setPreviewTool('select')}
          />
        )}

        {/*
          What the thing you just dropped should BE.

          Sits at the top rather than under the pointer: it would otherwise
          cover the very change it is describing, and every option here is a
          visible one you want to see happen. It goes away on the first choice,
          because a chooser that lingers stops being an answer and becomes
          furniture.
        */}
        {dropChip && (
          <div className="absolute left-1/2 top-3 z-30 flex -translate-x-1/2 items-center gap-1 rounded-full border border-ink-700 bg-ink-900/95 p-1 shadow-lg backdrop-blur">
            {DROP_CHOICES.map((choice) => (
              <button
                key={choice.id}
                title={choice.hint}
                onClick={() => {
                  applyDropIntent(dropChip.clipId, choice.id)
                  setDropChip({ ...dropChip, intent: choice.id })
                }}
                className={`rounded-full px-2.5 py-1 text-[10.5px] transition-colors ${
                  dropChip.intent === choice.id
                    ? 'bg-flame-500 font-medium text-ink-950'
                    : 'text-ink-300 hover:bg-ink-800 hover:text-ink-100'
                }`}
              >
                {choice.label}
              </button>
            ))}
            <button
              onClick={() => setDropChip(null)}
              title="Keep it as it is"
              className="rounded-full px-1.5 py-1 text-ink-500 hover:bg-ink-800 hover:text-ink-200"
            >
              <X size={11} />
            </button>
          </div>
        )}

        {offScreenClip && (
          <button
            onClick={() => setPlayhead(offScreenClip.start)}
            className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-ink-700 bg-ink-900/95 px-3 py-1.5 text-[11px] text-ink-300 shadow-lg backdrop-blur transition-colors hover:border-ink-600 hover:text-ink-100"
          >
            The selected clip is not at this moment —{' '}
            <span className="text-flame-400">go to it</span>
          </button>
        )}

        {splitRatio > 0.02 && splitRatio < 0.98 && (
          <SplitDivider ratio={splitRatio} onChange={setSplitRatio} containerRef={boxRef} />
        )}

        {splitRatio > 0.02 && splitRatio < 0.98 && (
          <>
            <span className="pointer-events-none absolute left-2 top-2 rounded bg-ink-950/80 px-1.5 py-0.5 text-[10px] text-ink-400">
              Source
            </span>
            <span className="pointer-events-none absolute right-2 top-2 rounded bg-ink-950/80 px-1.5 py-0.5 text-[10px] text-ink-400">
              Output
            </span>
          </>
        )}

        {/*
          Only when there IS an edit and the playhead is off it. An empty
          project draws its own two lines on the canvas — "drop pictures here" —
          and this line on top of those was two messages printed over each
          other, which is what A9's empty state first shipped as.
        */}
        {topLayer === null && project.clips.length > 0 && (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-ink-600">
            No clip under the playhead
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * The screen-colour pick: a click on the picture, read off the canvas.
 *
 * The canvas is drawing the clip raw while this is up (see `pickLayer` in the
 * draw loop), so the pixels under the pointer are the clip's own. A few of them
 * are averaged — a screen is never one colour, and a key taken from one pixel
 * is a key taken from that pixel's noise.
 */
function KeyPickOverlay({
  canvasRef,
  onPick,
  onCancel
}: {
  canvasRef: React.RefObject<HTMLCanvasElement | null>
  onPick: (color: string | null) => void
  onCancel: () => void
}): ReactNode {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      // Handled here: the shortcut layer would otherwise deselect the clip too.
      e.preventDefault()
      e.stopPropagation()
      onCancel()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onCancel])

  return (
    <div
      className="absolute inset-0 z-20 cursor-crosshair"
      title="Click the screen colour · Esc to cancel"
      onPointerDown={(e) => {
        e.preventDefault()
        e.stopPropagation()
        const canvas = canvasRef.current
        const ctx = canvas?.getContext('2d')
        if (!canvas || !ctx) return
        const bounds = canvas.getBoundingClientRect()
        if (bounds.width === 0 || bounds.height === 0) return
        const region = pickRegion(
          ((e.clientX - bounds.left) / bounds.width) * canvas.width,
          ((e.clientY - bounds.top) / bounds.height) * canvas.height,
          canvas.width,
          canvas.height
        )
        if (!region) return
        const { data } = ctx.getImageData(region.x, region.y, region.width, region.height)
        onPick(pickedColor(data))
      }}
    >
      <span className="pointer-events-none absolute left-1/2 top-3 -translate-x-1/2 rounded-full border border-ink-700 bg-ink-900/95 px-3 py-1 text-[11px] text-ink-200 shadow-lg">
        Click the screen colour — <span className="text-ink-500">Esc to cancel</span>
      </span>
    </div>
  )
}

function SplitDivider({
  ratio,
  onChange,
  containerRef
}: {
  ratio: number
  onChange: (ratio: number) => void
  containerRef: React.RefObject<HTMLDivElement | null>
}): ReactNode {
  const [dragging, setDragging] = useState(false)

  const move = useCallback(
    (clientX: number) => {
      const box = containerRef.current?.getBoundingClientRect()
      if (!box || box.width === 0) return
      onChange((clientX - box.left) / box.width)
    },
    [containerRef, onChange]
  )

  /**
   * Drag is tracked on the window, not the handle. The handle is 16px wide and
   * the pointer leaves it almost immediately, so the handle's own pointermove
   * drops the drag.
   */
  useEffect(() => {
    if (!dragging) return
    const onMove = (e: PointerEvent): void => {
      e.preventDefault()
      move(e.clientX)
    }
    const onUp = (): void => setDragging(false)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [dragging, move])

  return (
    <div
      className="absolute top-0 z-30 h-full w-4 -translate-x-1/2 cursor-col-resize"
      style={{ left: `${ratio * 100}%` }}
      onPointerDown={(e) => {
        e.preventDefault()
        setDragging(true)
      }}
      onDoubleClick={() => onChange(0.5)}
      title="Drag to compare · double-click for an even split"
    >
      <div className={`mx-auto h-full w-0.5 ${dragging ? 'bg-flame-400' : 'bg-flame-500/90'}`} />
      <div
        className={`absolute left-1/2 top-1/2 flex size-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-ink-950 shadow-lg ${
          dragging ? 'bg-flame-400' : 'bg-flame-500'
        }`}
      >
        <span className="text-[9px] font-bold leading-none text-ink-950">||</span>
      </div>
    </div>
  )
}

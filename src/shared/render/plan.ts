import type { Project, Clip, MediaAsset, ParallaxBake, Track } from '../timeline'
import {
  assetById,
  clipsOnTrack,
  clipEnd,
  framesToSeconds,
  isNeutralEq,
  projectDuration
} from '../timeline'
import { escapeFilterPath } from '../captions/timeline'
import { lumaAlphaExpression, transitionById, type TransitionDef } from '../transitions/registry'
// Geometry shared with the preview, so what is on screen and what is exported
// cannot drift apart.
import { hasPath, pathExpression } from './path'
import { hasKeys, keyframeExpression } from './keyframes'
import { curvesFilter } from './colourCurve'
import { whiteBalanceFilter } from './whiteBalance'
import { chromakeyFilter, despillFilter, saneKey } from './chromaKey'
import { isFullFrameMask, maskExpression } from './mask'
import { effectiveCrop, safeCrop, type Size } from './crop'
import { atempoChain, clipSpeed, sourceFramesFor, speedVideoFilter } from './speed'
import { audioFadeFilters, fadesWithNeighbours } from './audioFade'
import { duckFilter } from './duck'
import { voiceFilters } from './voice'
import { audioRole, clampGain, isAudible, type AudioRole } from './audibility'
import { loudnessFilters } from './loudness'
import {
  DEFAULT_SHAKE_DECAY,
  DEFAULT_SHAKE_HZ,
  MOVES,
  anchoredAmount,
  clampAmount,
  planeAmount
} from './motion'

import {
  DEFAULT_ENCODE,
  containerFor,
  encoderArgs,
  type EncodeSpec,
  type SpeedPreset
} from './encode'
import type { FrameRange } from './exportShape'

export { DEFAULT_SHAKE_DECAY, DEFAULT_SHAKE_HZ, PARALLAX_FLOOR, anchoredAmount, planeAmount } from './motion'

const SPEED_PRESETS: SpeedPreset[] = ['veryfast', 'faster', 'fast', 'medium', 'slow']

/**
 * The encode a request asks for. The old `crf`/`preset` pair is the spec this
 * app always used, so a request without `encode` renders byte-for-byte the
 * arguments it did before.
 */
export function encodeSpecFor(request: Pick<RenderRequest, 'encode' | 'crf' | 'preset'>): EncodeSpec {
  if (request.encode) return request.encode
  const preset = SPEED_PRESETS.includes(request.preset as SpeedPreset)
    ? (request.preset as SpeedPreset)
    : DEFAULT_ENCODE.preset
  return {
    ...DEFAULT_ENCODE,
    quality: { mode: 'crf', crf: request.crf ?? 20 },
    preset
  }
}

/**
 * Compiles a Timeline IR into an ffmpeg invocation.
 *
 * Pure: no fs, no spawn, no electron. Everything here is unit-testable by
 * asserting on the argv, which matters because a wrong filter graph is otherwise
 * only discoverable by rendering and watching the result.
 *
 * Composition strategy: every clip is laid onto a generated base canvas at its
 * own timeline offset, rather than concatenated. Concat is cheaper for a single
 * contiguous track but cannot express gaps, overlaps or layering — and all three
 * are ordinary once there is more than one track. One mechanism handles the lot.
 */

export interface RenderRequest {
  project: Project
  outputPath: string
  /** Overrides the project canvas, e.g. to render a 9:16 version of a 16:9 edit. */
  canvas?: { width: number; height: number }
  /** Burned-in captions: an .ass file written before the render starts. */
  subtitlesPath?: string
  /**
   * Styled captions, baked to pictures before the render starts.
   *
   * Only the band of the frame the captions touch, replayed through the concat
   * demuxer: a still caption is one file held for as long as it is on screen.
   * This is the alternative to `subtitlesPath` for looks libass cannot draw —
   * and it stays inside the single pass, which the frame server did not.
   */
  captionOverlay?: { listPath: string; y: number; height: number }
  /** Directory libass searches for the fonts a style names. */
  fontsDir?: string
  /** Resolves a transition's mask path, relative to the assets root. */
  resolveAsset?: (relativePath: string) => string
  /** Extra transitions beyond the built-ins, e.g. mask wipes from the catalog. */
  extraTransitions?: TransitionDef[]
  /**
   * Codec, quality, audio bitrate and container — see render/encode.ts.
   *
   * Absent means the export this app always made: H.264 at `crf`/`preset`
   * (CRF 20, medium), AAC 192k, MP4. `crf` and `preset` stay for exactly that
   * case and are ignored when `encode` is given.
   */
  encode?: EncodeSpec
  crf?: number
  preset?: string
  /**
   * Only frames `[start, end)` of the edit. The graph runs to `end` with every
   * clip wholly outside dropped, then the output is trimmed from `start` — so
   * what comes out is exactly that slice of the full render, not a re-edit.
   */
  range?: FrameRange
}

export interface RenderPlan {
  args: string[]
  durationFrames: number
  clips: { clip: Clip; asset: MediaAsset; inputIndex: number }[]
}

export class RenderError extends Error {}

/** Even dimensions — H.264 chroma subsampling requires it. */
function even(n: number): number {
  return Math.max(2, Math.round(n / 2) * 2)
}

function fitFilter(width: number, height: number, mode: 'contain' | 'cover' = 'contain'): string {
  if (mode === 'cover') {
    // Fill the box and cut the overflow. `increase` then crop is the standard
    // pair; scaling to the box directly would squash the picture instead.
    return (
      `scale=${width}:${height}:force_original_aspect_ratio=increase,` +
      `crop=${width}:${height}`
    )
  }
  return (
    `scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black@0`
  )
}


/**
 * Is this clip actually going to render as parallax?
 *
 * A bake that failed to separate, or that never happened, is not an error — the
 * clip falls back to the same move as an ordinary still. Keeping that decision
 * in one predicate means the input loop and the filter loop cannot disagree
 * about how many inputs a clip consumes, which would corrupt every index after
 * it.
 */
export function parallaxBakeFor(project: Project, clip: Clip): ParallaxBake | null {
  const motion = clip.motion
  const wantsPlanes =
    motion?.kind === 'parallax' ||
    (motion?.kind === 'shake' && motion.anchor === 'subject') ||
    // A clip drawing only part of its bake needs the planes whatever it is doing.
    clip.planes !== undefined
  if (!wantsPlanes) return null
  const bake = project.parallax?.[clip.assetId]
  if (!bake || !bake.separated || bake.layers.length < 2) return null
  return bake
}

/**
 * The planes a clip actually draws.
 *
 * `front` is the subject cutout — the last plane, and only when the bake has a
 * real matte rather than a depth band, because half a depth gradient is not a
 * person and putting text behind it would look like a mistake.
 */
export function planesFor(clip: Clip, bake: ParallaxBake): ParallaxBake['layers'] {
  if (clip.planes === 'front') return bake.layers.slice(-1)
  if (clip.planes === 'background') return bake.layers.slice(0, -1)
  return bake.layers
}

/**
 * How much of the move a given plane gets.
 *
 * Parallax drives the near plane hardest, so the world separates as the camera
 * travels. An anchored shake is the exact inverse: the subject is nailed down
 * and the scene takes the hit, which reads as force applied to the world rather
 * than to the camera.
 */
export function planeShare(motion: Clip['motion'], amount: number, depth: number): number {
  return motion?.kind === 'shake' ? anchoredAmount(amount, depth) : planeAmount(amount, depth)
}

/**
 * Camera move across a still.
 *
 * zoompan, not an animated crop: crop evaluates its `w`/`h` expressions ONCE at
 * filter configuration, so only `x`/`y` can animate — a crop-based zoom fails
 * outright with "Error when evaluating the expression". zoompan is the filter
 * built for this and evaluates per output frame.
 *
 * A pan needs something to pan *into*, so `pan*` holds a constant zoom rather
 * than sitting at 1: at zoom 1 the margin `iw-iw/zoom` is zero and the move is
 * silently a no-op.
 */
function motionFilter(
  clip: Clip,
  asset: MediaAsset,
  durationFrames: number,
  fps: number,
  /** Set per plane when compositing parallax; otherwise the clip's own. */
  overrideAmount?: number,
  /** Plane dimensions differ from the source asset's working size. */
  overrideSize?: { width: number; height: number },
  canvas: { width: number; height: number } = { width: 1920, height: 1080 }
): string | null {
  const motion = clip.motion
  if (!motion) return null

  const amount = clampAmount(overrideAmount ?? motion.amount)
  const frames = Math.max(2, Math.round(durationFrames))
  // `on` is the output frame index, which is what makes the move linear in time.
  const progress = `on/${frames - 1}`
  const a = amount.toFixed(4)

  /*
   * Run the move at the resolution the canvas will actually use, not the
   * source's.
   *
   * zoompan costs output area per frame, and this used to run at up to
   * 2560x1440 only for the very next filter to throw most of it away scaling to
   * the canvas. Measured on one 3s still to a 1080x1920 canvas: 6.0s at source
   * size, 4.0s at canvas-matched size. The encoder preset made no measurable
   * difference at all, so the filter graph was the whole cost.
   *
   * The factor is what `fitFilter` will apply, times the zoom headroom, so the
   * most zoomed-in frame still has a full canvas of real pixels behind it. It
   * never upscales.
   */
  const rawW = Math.max(2, overrideSize?.width ?? asset.width ?? 1920)
  const rawH = Math.max(2, overrideSize?.height ?? asset.height ?? 1080)
  const fit = Math.min(canvas.width / rawW, canvas.height / rawH)
  const headroom = (1 + amount) * 1.05
  const factor = Math.min(1, fit * headroom)
  /*
   * ONE factor for both sides, and no fixed ceiling.
   *
   * There was a cap of 2560 wide by 1440 tall, applied to each side on its own.
   * It assumed a landscape picture: a portrait phone photo in a vertical reel
   * wants to be taller than 1440, so its height was cut and its width was not,
   * and a 3024×4032 photo went into the move at 1304×1440 — 21 % too wide. Every
   * Ken Burns on a tall photo in a 9:16 reel exported stretched, while the
   * preview showed it right (tests/integration/motionAspect.int.test.ts). The
   * cap also starved a 4K move, feeding a 2160-wide canvas from at most 1440.
   *
   * It was never what bounded the cost anyway: `factor` already limits the
   * working picture to the canvas plus the zoom's headroom, which is exactly
   * what the most zoomed-in frame needs and no more.
   */
  const sourceW = even(rawW * factor)
  const sourceH = even(rawH * factor)
  // Pre-scale as well: feeding zoompan the full-size frame costs the same
  // per-frame resampling whatever `s` says.
  const pre = factor < 1 ? `scale=${sourceW}:${sourceH}:flags=bicubic,` : ''
  const size = `s=${sourceW}x${sourceH}:fps=${fps}`

  if (motion.kind === 'shake') {
    // Held zoom gives the margin the oscillation moves within, so the shake
    // never exposes an edge.
    const hz = Math.max(1, Math.min(30, motion.hz ?? DEFAULT_SHAKE_HZ))
    const decay = Math.max(0, motion.decay ?? DEFAULT_SHAKE_DECAY)
    const seconds = `on/${fps}`
    // The same exponential settle the preview applies, written as an expression.
    const envelope = decay > 0 ? `exp(-(${seconds})/${decay.toFixed(4)})` : '1'
    const wobble = (phase: number): string =>
      `0.5+0.5*${envelope}*sin(2*PI*${hz.toFixed(2)}*${seconds}+${phase.toFixed(3)})`
    return (
      `${pre}zoompan=z='1+${a}':d=${frames}:` +
      `x='(iw-iw/zoom)*(${wobble(0)})':` +
      // A quarter-cycle apart, or the two axes move as one diagonal line.
      `y='(ih-ih/zoom)*(${wobble(Math.PI / 2)})':` +
      `${size}`
    )
  }

  const move = MOVES[motion.direction] ?? MOVES.in
  const zoom =
    move.zoom === 'in'
      ? `1+${a}*${progress}`
      : move.zoom === 'out'
        ? `1+${a}*(1-${progress})`
        : `1+${a}`

  /** Fraction of the pannable margin at this frame. */
  const track = ([from, to]: [number, number]): string =>
    from === to ? from.toFixed(4) : `${from.toFixed(4)}+${(to - from).toFixed(4)}*${progress}`

  return (
    `${pre}zoompan=z='${zoom}':d=${frames}:` +
    `x='(iw-iw/zoom)*(${track(move.fx)})':` +
    `y='(ih-ih/zoom)*(${track(move.fy)})':` +
    `${size}`
  )
}

/**
 * The box a clip is drawn into, and where that box sits on the canvas.
 *
 * `Clip.transform` existed from the first commit and was rendered by nothing:
 * every clip was fitted to the whole canvas, so a 3D prop dropped on a track
 * covered the entire frame and no control could shrink it. Defined here once so
 * the renderer and the preview cannot disagree.
 *
 * scale 1 fills the canvas (what every existing project already does), x and y
 * are fractions of a half-canvas from centre, so 0 is centred and 1 is hard
 * against the right or bottom edge.
 */
export function clipBox(
  clip: Clip,
  canvas: { width: number; height: number }
): {
  width: number
  height: number
  x: number
  y: number
  opacity: number
  rotation: number
  fit: 'contain' | 'cover'
} {
  const t = clip.transform
  const scale = Math.max(0.02, Math.min(4, t?.scale ?? 1))
  const scaleY = Math.max(0.02, Math.min(4, t?.scaleY ?? scale))
  const width = Math.max(2, Math.round((canvas.width * scale) / 2) * 2)
  const height = Math.max(2, Math.round((canvas.height * scaleY) / 2) * 2)
  return {
    width,
    height,
    fit: t?.fit ?? 'contain',
    x: Math.round((canvas.width - width) / 2 + ((t?.x ?? 0) * canvas.width) / 2),
    y: Math.round((canvas.height - height) / 2 + ((t?.y ?? 0) * canvas.height) / 2),
    opacity: Math.max(0, Math.min(1, t?.opacity ?? 1)),
    rotation: t?.rotation ?? 0
  }
}

/**
 * Brightness, contrast and saturation.
 *
 * The slider ranges were chosen to BE ffmpeg's, so this is a straight handover
 * with no conversion to get wrong. Omitted entirely when neutral — every filter
 * in the chain is paid for on every frame of every clip.
 */
/**
 * Rotation, animated or not.
 *
 * `rotate` takes an expression in `t` — verified against the binary, where a
 * frame at t=0 and one at t=0.9 came back genuinely turned.
 */
/**
 * A hand-placed zoom curve, for a clip with no preset camera move.
 *
 * zoompan counts output frames in `on` rather than exposing `t`, so the curve is
 * compiled against a converted time expression rather than written twice. A
 * clip that already has a `motion` keeps it: they drive the same filter, and the
 * preset is the one the user picked most recently in the UI.
 */
function zoomKeyframeFilter(
  clip: Clip,
  stream: { width: number; height: number } | null,
  fps: number,
  canvas: { width: number; height: number }
): string | null {
  const keys = clip.keyframes?.zoom
  if (!hasKeys(clip.keyframes, 'zoom')) return null

  const frames = Math.max(2, Math.round(clip.duration))
  // zoompan counts output frames from zero in `on`, and like the others it runs
  // before setpts — so the curve is clip-relative throughout.
  const z = keyframeExpression(keys!, {
    durationFrames: clip.duration,
    fps,
    startSeconds: 0,
    fallback: 1,
    precision: 5,
    timeVar: `(on/${fps})`
  })

  /*
   * Sized from the stream that actually arrives, not from the photograph.
   *
   * zoompan is handed a fixed output size, and whatever comes in is scaled to
   * fill it — so telling it the size of the whole file when the stream has
   * already been cropped down to a slice does not merely waste pixels, it
   * SQUASHES the slice into the file's aspect. A grid piece one twentieth of a
   * 4000x3000 photograph came out stretched into 4:3 and then centre-cropped to
   * fit its box, showing about 40% of itself at nearly two and a half times the
   * right size. It is the resting state, not the animation: `pre` and `s=` are
   * fixed for the whole clip.
   *
   * Every caller reaches this after `cropFilter`, so the crop is the stream.
   */
  const rawW = Math.max(2, stream?.width ?? canvas.width)
  const rawH = Math.max(2, stream?.height ?? canvas.height)
  const peak = Math.max(...keys!.map((k) => k.value), 1)
  const factor = Math.min(1, Math.min(canvas.width / rawW, canvas.height / rawH) * peak * 1.05)
  const sourceW = Math.min(2560, even(rawW * factor))
  const sourceH = Math.min(1440, even(rawH * factor))
  const pre = factor < 1 ? `scale=${sourceW}:${sourceH}:flags=bicubic,` : ''

  return (
    `${pre}zoompan=z='${z}':d=${frames}:` +
    // Centred: the frame grows around the middle rather than drifting.
    `x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':` +
    `s=${sourceW}x${sourceH}:fps=${fps}`
  )
}

/**
 * The widest angle a clip is ever turned through, in degrees.
 *
 * A keyframed rotation has to be sized for its extreme, not for the value it
 * happens to hold at the first frame: `rotate` fixes its output size when the
 * graph is configured and never revisits it, so an expression there would be
 * evaluated once and quietly describe the wrong frame for the rest of the clip.
 */
function widestTurn(clip: Clip, staticDegrees: number): number {
  const keys = clip.keyframes?.rotation
  if (hasKeys(clip.keyframes, 'rotation') && keys) {
    return keys.reduce((widest, key) => Math.max(widest, Math.abs(key.value)), 0)
  }
  return Math.abs(staticDegrees)
}

/**
 * The frame a turned clip needs, so its corners are not cut off.
 *
 * `rotate` keeps the input's dimensions unless told otherwise, which means a
 * square turned by any angle at all loses four triangles — the diagonal of the
 * picture is longer than its side, and there is nowhere for the overhang to go.
 * At 45° a square loses 29% of its area. The preview never had this problem,
 * because a canvas rotation carries the whole rectangle with it, so the two have
 * always disagreed about what a turned clip looks like; growing the frame here
 * is what makes them agree.
 *
 * Measured against the bundled binary rather than assumed: a 200x200 red square
 * turned 20° with `ow=rotw(a):oh=roth(a)` came back 256x256, against a predicted
 * 200·(cos20°+sin20°) = 256.3. A 200x100 input given a flat `ow=300:oh=300` came
 * back centred — opaque from row 99 to 200 and column 49 to 250, against the
 * predicted 100 and 50 — so the padding is symmetrical and the offset is simply
 * half the growth.
 */
export function rotatedExtent(
  degrees: number,
  width: number,
  height: number
): { width: number; height: number } {
  const radians = (Math.abs(degrees) * Math.PI) / 180
  const cos = Math.abs(Math.cos(radians))
  const sin = Math.abs(Math.sin(radians))
  return {
    width: even(width * cos + height * sin),
    height: even(width * sin + height * cos)
  }
}

function rotationFilter(clip: Clip, staticDegrees: number, fps: number, grown: string): string | null {
  const keys = clip.keyframes?.rotation
  if (hasKeys(clip.keyframes, 'rotation')) {
    const expression = keyframeExpression(keys!, {
      durationFrames: clip.duration,
      fps,
      // Zero, not the clip's timeline position: this runs BEFORE setpts, so the
      // frames still carry source timestamps starting at zero. Offsetting by the
      // start would have worked perfectly for the first clip on a timeline and
      // silently frozen every clip after it.
      startSeconds: 0,
      fallback: staticDegrees,
      // rotate wants radians; the user thinks in degrees.
      transform: (degrees) => (degrees * Math.PI) / 180,
      precision: 5
    })
    return `rotate='${expression}':${grown}fillcolor=none`
  }
  return staticDegrees !== 0 ? `rotate=${staticDegrees}*PI/180:${grown}fillcolor=none` : null
}

/**
 * Opacity, animated or not.
 *
 * A constant is a cheap channel mixer. An animated one has to go through `geq`,
 * which is the only filter here that exposes time to a per-pixel expression —
 * `colorchannelmixer` takes numbers, not expressions. geq is genuinely
 * expensive, so it is emitted only when the clip actually animates.
 */
function opacityFilter(clip: Clip, staticOpacity: number, fps: number): string | null {
  const keys = clip.keyframes?.opacity
  if (hasKeys(clip.keyframes, 'opacity')) {
    const expression = keyframeExpression(keys!, {
      durationFrames: clip.duration,
      fps,
      // As rotation: before setpts, so clip-relative.
      startSeconds: 0,
      fallback: staticOpacity,
      // geq's alpha plane is 0..255; the user thinks 0..1.
      transform: (value) => Math.max(0, Math.min(1, value)) * 255,
      precision: 2,
      /*
       * geq calls it `T`, not `t`.
       *
       * With a lowercase t the parser reported "Unknown function in
       * 't,2.0000)..." — it was reading `t(` as a call to an undefined
       * function rather than a variable, and the whole graph refused to build.
       */
      timeVar: 'T'
    })
    // The colour planes are passed straight through; only alpha is rewritten.
    /*
     * Multiplied into the alpha that is there, not written over it.
     *
     * `a='value'` REPLACED the clip's alpha with the opacity, so a keyframed
     * fade on a clip with see-through parts — the bars round a letterboxed
     * picture, a sticker, a keyed screen — made them solid for its whole
     * length. Measured: a 4:3 clip over red with an opacity keyframe had
     * black bars.
     */
    return `geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*(${expression})/255'`
  }
  return staticOpacity < 1 ? `colorchannelmixer=aa=${staticOpacity.toFixed(3)}` : null
}

function eqFilter(clip: Clip): string | null {
  const color = clip.color
  if (isNeutralEq(color) || !color) return null
  return (
    `eq=brightness=${clamp(color.brightness, -1, 1).toFixed(3)}` +
    `:contrast=${clamp(color.contrast, 0, 3).toFixed(3)}` +
    `:saturation=${clamp(color.saturation, 0, 3).toFixed(3)}`
  )
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * The crop, clamped to the pixels that actually exist.
 *
 * `source` is the size of the stream AT THIS POINT in the chain, which is not
 * always the asset's: a parallax clip has already been composited from its
 * depth planes and carries the bake's dimensions instead. Cropping a plane
 * composite against the original photograph's size was a second way to ask for
 * pixels that were not there.
 */
function cropFilter(clip: Clip, source: Size | null): string | null {
  if (!clip.crop) return null
  const crop = safeCrop(clip.crop, source) ?? safeCrop(clip.crop, { width: 1e6, height: 1e6 })
  if (!crop) return null

  /*
   * Expressions, not numbers — so the filter clamps itself.
   *
   * `safeCrop` above can only bound the rectangle against the size the app
   * BELIEVES the stream has, and there are several ways for that belief to be
   * wrong: a phone video carrying a rotation matrix decodes with its sides
   * swapped (the probe reads the coded size and never looks at side_data_list);
   * a parallax clip reaches here as a plane composite that has already been
   * scaled; a source re-exported at a different resolution under the same path
   * keeps the dimensions the project recorded. Any of those is a dead render,
   * because `crop` is the one filter that refuses rather than clamps.
   *
   * `in_w`/`in_h` are evaluated against what actually arrives, so the crop
   * shrinks to fit whatever that turns out to be. Measured: asking for
   * 3210x1808 of a 1280x720 stream yields 1280x720 instead of killing the
   * export, and an off-edge origin slides in with its size intact — both inside
   * a filter_complex with filters either side, which is where the commas in
   * these expressions could have gone wrong and do not.
   */
  const w = `min(${crop.width},in_w)`
  const h = `min(${crop.height},in_h)`
  const x = `max(0,min(${crop.x},in_w-out_w))`
  const y = `max(0,min(${crop.y},in_h-out_h))`
  return `crop=w='${w}':h='${h}':x='${x}':y='${y}'`
}

const seconds = (frames: number, fps: number): string => framesToSeconds(frames, fps).toFixed(6)

/**
 * Stretch a drawn animation across its clip.
 *
 * The baked sequence only holds the frames that move — a third of a second of
 * it for a three-second caption. `tpad` clones the last frame onward and `trim`
 * cuts the result to the clip's own length, so the words arrive and then simply
 * stay, at the cost of the movement alone.
 *
 * Measured against the bundled binary: four frames at 30fps held with
 * `stop_duration=2` and trimmed produce exactly 60 frames of 2.000s, with the
 * source alpha intact (rgba 7f stayed 7f) — which matters, since text is
 * nothing but alpha.
 */
function holdFilter(clip: Clip, fps: number): string {
  const length = seconds(clip.duration, fps)
  return `tpad=stop_mode=clone:stop_duration=${length},trim=duration=${length},setpts=PTS-STARTPTS`
}

/**
 * Sum audio streams without amix quietly dividing every level by the count.
 *
 * `amix` normalises by default: two clips and each is halved, three and each is
 * a third. `normalize=0` turns that off in one word — and was added in ffmpeg
 * **4.2**, so it is present on the macOS build and missing on the Windows one.
 * It is the same trap as `anullsrc:d` above, and it only fired on the two-clip
 * tests, because a graph with one audio stream never reaches amix at all.
 *
 * The workaround every forum gives is `dropout_transition=0` plus a
 * compensating `volume`. It is wrong, and the measurement says so. Against a
 * 3s tone mixed with a 1s one:
 *
 *     normalize=0                       -21.1  -24.1  -24.1 dB   (correct)
 *     dropout_transition=0, volume=2    -21.1  -18.1  -18.1 dB   (6dB HOT)
 *     amix with nothing                 -27.1  -28.8  -25.8 dB   (and ramping)
 *
 * The moment the short input ends, amix renormalises to one active stream and
 * the compensating volume doubles what is already correct. So the inputs are
 * padded to the full timeline first: nothing ever drops out, the divisor stays
 * at N for the whole render, and multiplying by N undoes it exactly. Measured
 * against the `normalize=0` output, the residual is -91.0 dB — the 16-bit
 * quantisation floor, i.e. the same samples.
 *
 * `apad`, `atrim` and `volume` all predate 4.0 by years, so this form works on
 * both builds and there is no version branch to keep in step.
 */
function mixFilters(labels: string[], out: string, totalSeconds: string): string[] {
  if (labels.length === 1) return [`${labels[0]}anull${out}`]

  // The tag comes off the output label, so the intermediates cannot collide
  // between the dialogue, music, other and final mixes.
  const tag = out.replace(/[[\]]/g, '')
  const padded = labels.map((_, i) => `[${tag}p${i}]`)
  return [
    ...labels.map((label, i) => `${label}apad,atrim=end=${totalSeconds}${padded[i]}`),
    `${padded.join('')}amix=inputs=${labels.length}:duration=longest:dropout_transition=0,` +
      `volume=${labels.length}${out}`
  ]
}

/**
 * The clips a range export keeps: every one that overlaps `[start, end)`, and
 * every one those use as their matte.
 *
 * A matte is a shape clip that another clip is cut out through
 * (`clip.matte.clipId`), and it has a span of its own that need not overlap the
 * range. Dropped by time alone, the picture it shapes would find no matte and be
 * composited as a plain rectangle — silently, because a missing matte label is
 * simply skipped. Found by the B2 review.
 */
export function clipsForRange(clips: readonly Clip[], range: { start: number; end: number }): Clip[] {
  const kept = new Set(clips.filter((c) => c.start < range.end && clipEnd(c) > range.start).map((c) => c.id))
  for (const c of clips) if (kept.has(c.id) && c.matte) kept.add(c.matte.clipId)
  return clips.filter((c) => kept.has(c.id))
}

export function buildRenderPlan(request: RenderRequest): RenderPlan {
  const { outputPath } = request
  const spec = encodeSpecFor(request)
  const fullFrames = projectDuration(request.project)
  if (fullFrames <= 0) throw new RenderError('The timeline has no clips to render')

  /*
   * A range renders the edit up to its OUT point, with every clip wholly
   * outside it dropped, and trims the front off at the very end.
   *
   * Dropping first is what makes a five-second range of a ten-minute edit cost
   * five seconds of decoding, not ten minutes. Trimming at the end, rather
   * than re-cutting the clips to fit, is what makes the result exactly that
   * slice of the full render: a clip straddling the in point keeps its fades,
   * its transition, its keyframes and its motion exactly where they were.
   */
  // A range over the whole edit needs no special case: it drops no clip and
  // trims nothing, so it renders exactly the plain export.
  const range =
    request.range && request.range.end > request.range.start
      ? {
          start: Math.max(0, Math.round(request.range.start)),
          end: Math.min(fullFrames, Math.round(request.range.end))
        }
      : null
  const project: Project = range ? { ...request.project, clips: clipsForRange(request.project.clips, range) } : request.project
  const canvas = request.canvas ?? { width: project.settings.width, height: project.settings.height }
  const width = even(canvas.width)
  const height = even(canvas.height)
  const fps = project.settings.fps

  const videoTracks = project.tracks.filter((t) => t.kind === 'video' && !t.hidden)
  if (videoTracks.length === 0) throw new RenderError('The project has no visible video track')

  /** How far the graph runs — to the out point of a range. */
  const totalFrames = range ? range.end : fullFrames
  /** How long the file is. */
  const outputFrames = range ? range.end - range.start : fullFrames
  /** The front trimmed off, in the graph's own seconds, or null for none. */
  const trimFrom = range && range.start > 0 ? seconds(range.start, fps) : null

  // Tracks composite bottom-up: index 0 is the backmost layer.
  const videoClips: { clip: Clip; track: Track }[] = []
  for (const track of videoTracks) {
    for (const clip of clipsOnTrack(project, track.id)) videoClips.push({ clip, track })
  }
  if (videoClips.length === 0) {
    throw new RenderError(
      range
        ? 'There is no picture between the in and out points — move them over a clip'
        : 'The timeline has no clips to render'
    )
  }

  // Mute, solo and hidden all decide who is heard, in one place both the
  // preview and this file ask — see render/audibility.ts.
  const audioTracks = project.tracks.filter(
    (t) => t.kind === 'audio' && isAudible(t, project.tracks)
  )
  const audioClips = audioTracks.flatMap((t) => clipsOnTrack(project, t.id))

  const args: string[] = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y']
  const filters: string[] = []
  const entries: RenderPlan['clips'] = []

  /* ------------------------------------------------------------- inputs */

  let inputIndex = 0
  const videoInputs: { clip: Clip; index: number; hasAudio: boolean }[] = []
  /** Extra input indices for a parallax clip's planes, in far-to-near order. */
  const planeInputs = new Map<string, number[]>()

  for (const { clip } of videoClips) {
    const asset = assetById(project, clip.assetId)
    if (!asset) throw new RenderError(`Clip ${clip.id} refers to a missing asset`)

    const bake = parallaxBakeFor(project, clip)
    if (bake) {
      // One input per depth plane, and none for the flat original — the planes
      // together *are* the photograph.
      const indices: number[] = []
      for (const layer of planesFor(clip, bake)) {
        args.push('-loop', '1', '-t', seconds(clip.duration, fps), '-i', layer.file)
        indices.push(inputIndex)
        inputIndex++
      }
      planeInputs.set(clip.id, indices)
      // The clip's own stream is the composite, built below from the back plane.
      videoInputs.push({ clip, index: indices[0], hasAudio: false })
      entries.push({ clip, asset, inputIndex: indices[0] })
      continue
    }

    if (asset.kind === 'image') {
      if (asset.frames) {
        /*
         * A drawn animation arrives as numbered PNGs.
         *
         * `-start_number 0` because the frames count from zero and image2
         * otherwise starts looking at 1 — this build happens to find them
         * anyway, but a build that did not would silently drop the first frame
         * of every animation, which is the one that matters most.
         *
         * The input ends when the movement does; `holdFilter` below extends the
         * last frame across the rest of the clip.
         */
        args.push('-start_number', '0', '-framerate', String(fps), '-i', asset.frames.pattern)
      } else {
        // A still needs an explicit length or it produces a single frame. Speed
        // means nothing to a photograph, so it takes exactly its timeline length.
        args.push('-loop', '1', '-t', seconds(clip.duration, fps), '-i', asset.path)
      }
    } else {
      /*
       * Take `duration × speed` of source, not `duration`.
       *
       * Half speed covers four timeline seconds with two seconds of footage,
       * and asking for four here would both waste a decode and run past the
       * end of the shot.
       */
      // -ss before -i seeks on the input, far faster on long sources.
      args.push(
        '-ss', seconds(clip.inPoint, fps),
        '-t', seconds(sourceFramesFor(clip), fps),
        '-i', asset.path
      )
    }
    videoInputs.push({ clip, index: inputIndex, hasAudio: asset.hasAudio })
    entries.push({ clip, asset, inputIndex })
    inputIndex++
  }

  /*
   * A clip sticker's matte, as an input.
   *
   * Seeked and limited exactly like the colour stream it belongs to, so the two
   * stay in step — a matte running at its own pace is a cut-out that slides off
   * its subject, which looks like a broken key rather than a timing bug.
   */
  const assetMatteInputs = new Map<string, number>()
  for (const { clip, asset } of entries) {
    if (!asset.matte) continue
    args.push(
      '-ss', seconds(clip.inPoint, fps),
      '-t', seconds(sourceFramesFor(clip), fps),
      '-i', asset.matte
    )
    assetMatteInputs.set(clip.id, inputIndex)
    inputIndex++
  }

  /* Mask inputs come before audio so video input indices stay contiguous. */
  const lookupTransition = (id: string): TransitionDef | null =>
    request.extraTransitions?.find((t) => t.id === id) ?? transitionById(id)

  const maskInputs = new Map<string, number>()
  for (const { clip } of videoClips) {
    if (!clip.transitionIn) continue
    const definition = lookupTransition(clip.transitionIn.id)
    if (!definition?.mask || !request.resolveAsset) continue

    // The mask outlives the wipe on purpose: alphamerge needs a frame for every
    // frame of the clip, and the expression saturates once the wipe is done.
    args.push(
      '-loop', '1',
      '-framerate', String(fps),
      '-t', seconds(clip.duration, fps),
      '-i', request.resolveAsset(definition.mask)
    )
    maskInputs.set(clip.id, inputIndex)
    inputIndex++
  }

  /*
   * The caption bake, as an input.
   *
   * Before audio so the video input indices stay contiguous, for the same reason
   * the mask inputs are.
   */
  let captionInput: number | null = null
  if (request.captionOverlay) {
    args.push('-f', 'concat', '-safe', '0', '-i', request.captionOverlay.listPath)
    captionInput = inputIndex
    inputIndex++
  }

  const audioInputs: { clip: Clip; index: number }[] = []
  for (const clip of audioClips) {
    const asset = assetById(project, clip.assetId)
    if (!asset) throw new RenderError(`Clip ${clip.id} refers to a missing asset`)
    if (!asset.hasAudio) continue
    args.push(
      '-ss', seconds(clip.inPoint, fps),
      '-t', seconds(sourceFramesFor(clip), fps),
      '-i', asset.path
    )
    audioInputs.push({ clip, index: inputIndex })
    inputIndex++
  }

  /* -------------------------------------------------------------- video */

  // A generated canvas is the bottom layer, so a timeline with gaps renders
  // black rather than stalling or shifting later clips earlier.
  filters.push(
    `color=c=black:s=${width}x${height}:r=${fps}:d=${seconds(totalFrames, fps)},format=yuv420p[base]`
  )

  /*
   * Matte shapes, emitted before anything consumes them.
   *
   * A clip marked matteOnly is never composited — it exists to be another
   * clip's alpha. Its own stream becomes a greyscale mask at canvas size, which
   * is exactly what alphamerge wants.
   */
  const matteLabels = new Map<string, string>()
  videoInputs.forEach(({ clip, index }, i) => {
    if (!clip.matteOnly) return
    // A drawn animation is short by construction, and a matte that runs out
    // part-way through leaves the clip it cuts with no alpha at all.
    const hold = assetById(project, clip.assetId)?.frames ? `${holdFilter(clip, fps)},` : ''
    filters.push(
      `[${index}:v]${hold}format=gray,scale=${width}:${height},setsar=1,fps=${fps}[mt${i}]`
    )
    matteLabels.set(clip.id, `[mt${i}]`)
  })

  /*
   * Which clips actually reach the canvas.
   *
   * The chain hands its output to the next stage and the LAST one must produce
   * [vmix]. Skipping matte shapes means "last" is no longer simply the last
   * index, and getting that wrong silently drops every clip after the skip.
   */
  const composited = videoInputs
    .map(({ clip }, i) => (clip.matteOnly ? -1 : i))
    .filter((i) => i >= 0)
  const lastComposited = composited[composited.length - 1]
  if (lastComposited === undefined) {
    throw new RenderError('Every clip on the timeline is a matte shape — there is nothing to draw')
  }

  let current = '[base]'
  videoInputs.forEach(({ clip }, i) => {
    // A shape is not a picture: it was emitted above and is drawn by nobody.
    if (clip.matteOnly) return
    const transition = clip.transitionIn ? lookupTransition(clip.transitionIn.id) : null
    const transitionSeconds = clip.transitionIn
      ? framesToSeconds(clip.transitionIn.durationFrames, fps)
      : 0
    const context = { duration: transitionSeconds, canvasWidth: width, canvasHeight: height }

    const asset = assetById(project, clip.assetId)!
    const bake = parallaxBakeFor(project, clip)
    const planes = planeInputs.get(clip.id)
    const box = clipBox(clip, { width, height })

    /*
     * Room for the corners, when the clip is turned.
     *
     * The stream grows around its own middle, so the overlay has to start half
     * the growth earlier to leave the picture where it was — and the motion
     * path, which is written as an offset from the resting box, has to be given
     * the same shifted origin or a turned clip would fly off on a different
     * trajectory from an upright one.
     */
    /*
     * The stream, before and after the crop.
     *
     * A parallax clip arrives as its baked planes, which are the bake's size
     * rather than the photograph's, so the crop has to be measured against
     * whichever one the pixels actually came from. `safeCrop` is used rather
     * than `clip.crop` directly so this agrees with the clamped rectangle
     * `cropFilter` really emits.
     */
    const preCrop: Size | null = bake
      ? { width: bake.width, height: bake.height }
      : asset.width && asset.height
        ? { width: asset.width, height: asset.height }
        : null
    // What the crop filter will really output — see `effectiveCrop`. With no
    // known source size the loose rectangle is the best guess there is.
    const streamSize: Size | null = !clip.crop
      ? preCrop
      : preCrop
        ? effectiveCrop(clip.crop, preCrop)
        : safeCrop(clip.crop, { width: 1e6, height: 1e6 })

    const turn = widestTurn(clip, box.rotation)
    const extent = turn > 0.01 ? rotatedExtent(turn, box.width, box.height) : null
    const growX = extent ? Math.round((extent.width - box.width) / 2) : 0
    const growY = extent ? Math.round((extent.height - box.height) / 2) : 0
    const grownArgs = extent ? `ow=${extent.width}:oh=${extent.height}:` : ''

    /*
     * Parallax: each plane moves at its own rate, then they stack back up.
     *
     * The planes are the same pixel size, so each zoompan outputs that size and
     * the overlays line up at 0:0. What differs is how far each one travels —
     * and that difference is the entire effect.
     */
    let source = `[${videoInputs[i].index}:v]`
    if (bake && planes) {
      const size = { width: bake.width, height: bake.height }
      const drawn = planesFor(clip, bake)
      drawn.forEach((layer, p) => {
        const move = motionFilter(
          clip,
          asset,
          clip.duration,
          fps,
          planeShare(clip.motion, clip.motion?.amount ?? 0, layer.depth),
          size,
          { width, height }
        )
        filters.push(`[${planes[p]}:v]format=yuva420p${move ? `,${move}` : ''}[pl${i}_${p}]`)
      })

      let stack = `[pl${i}_0]`
      for (let p = 1; p < drawn.length; p++) {
        const out = p === drawn.length - 1 ? `[px${i}]` : `[ps${i}_${p}]`
        filters.push(`${stack}[pl${i}_${p}]overlay=0:0:format=yuv420${out}`)
        stack = out
      }
      // A single plane is already the stream; there is nothing to stack.
      source = drawn.length > 1 ? `[px${i}]` : `[pl${i}_0]`
    }

    /*
     * A mask splits this chain in two.
     *
     * `alphamerge` REPLACES a stream's alpha rather than multiplying into it,
     * so anything that has already written alpha — the opacity control, a
     * transition's fade — would be wiped out by the shape landing on top of it.
     * Those steps move to a tail that runs after the mask instead. With no mask
     * the chain is exactly the one it has always been.
     */
    const mask = clip.mask && !isFullFrameMask(clip.mask) ? clip.mask : null
    // A grade mask means the colour belongs to the masked copy alone, so it has
    // to come out of the main chain entirely.
    const gradeInline = mask?.mode !== 'grade'
    const finish = [
      /*
       * Rotation belongs on THIS side of the mask, not before it.
       *
       * Every stencil in this renderer — a mask's `geq`, a luma wipe's scaled
       * pattern, a track matte — is sized against the clip's BOX, and
       * `alphamerge` refuses two streams of different sizes. Turning the clip
       * first grows the frame past the box, so a rotated clip with any shape on
       * it failed outright; and where it did not fail, `geq`'s `W` and `H` were
       * the grown frame rather than the box, so the shape came out the wrong
       * size and in the wrong place. Masks are documented as fractions of the
       * box in render/mask.ts, and that is what the preview draws them against.
       *
       * Rotating afterwards also gets the picture right: `rotate:fillcolor=none`
       * runs on a stream that already carries the mask's alpha, so the shape
       * turns WITH the photograph, which is what a canvas rotation does in the
       * preview. Rotating first and masking after would have held the shape
       * still while the picture spun underneath it.
       */
      rotationFilter(clip, box.rotation, fps, grownArgs),
      opacityFilter(clip, box.opacity, fps),
      // Transition effects run before setpts, so their times are relative to
      // the clip's own start rather than the timeline's.
      ...(transition?.incoming ? transition.incoming(context) : [])
    ].filter((s): s is string => s !== null)

    /*
     * The chain comes in halves, split where a key is taken.
     *
     * Everything up to the fitted, yuva420p picture is `prepare`; the grade
     * and what follows come after it. A chroma key has to be measured on the
     * UNGRADED picture — grading the greens would move the key — so a keyed
     * clip splits between them (see the key below). Unkeyed and ungraded, the
     * halves join into the one chain they always were.
     */
    // An adjustment layer grades what is below it and has no picture to key.
    const key = clip.key && !clip.adjustment ? saneKey(clip.key) : null
    const prepare = [
      // Before anything else: a drawn animation is only as long as its movement,
      // and every step below assumes a stream of exactly `duration` frames.
      asset.frames ? holdFilter(clip, fps) : null,
      /*
       * Speed first, and self-contained.
       *
       * `setpts` re-times and `fps` immediately restores the frame count, so
       * everything after this point sees a perfectly ordinary clip of exactly
       * `duration` frames at the project rate. That is deliberate: motion,
       * rotation, opacity keyframes and the transitions all read clip-relative
       * time, and any of them seeing a half-rate stream would have drifted.
       * Stills are untouched — a photograph has no rate to change.
       */
      asset.kind === 'image' ? null : speedVideoFilter(clipSpeed(clip), fps, clip.smoothSlow),
      /*
       * The stream this crop actually applies to.
       *
       * A parallax clip reaches here as its stacked depth planes, which are the
       * bake's size rather than the photograph's — so the crop has to be
       * measured against whichever one the pixels came from.
       */
      cropFilter(clip, preCrop),
      /*
       * Motion runs before the fit so the move happens in source pixels and the
       * result is still letterboxed to the canvas exactly once. Parallax has
       * already applied it, per plane.
       *
       * Both of these are told the POST-CROP size. They hand zoompan a fixed
       * output size and whatever arrives is stretched to fill it, so a stream
       * that has already been cut down to a slice and a filter that believes it
       * is still the whole photograph do not merely waste pixels — they squash
       * the slice into the file's aspect.
       */
      bake
        ? null
        : motionFilter(clip, asset, clip.duration, fps, undefined, streamSize ?? undefined, {
            width,
            height
          }) ?? zoomKeyframeFilter(clip, streamSize, fps, { width, height }),
      fitFilter(box.width, box.height, box.fit),
      `fps=${fps}`,
      'setsar=1',
      // yuva420p, not rgba.
      //
      // Every overlay stage takes the canvas as its main input and a clip as its
      // overlay. With the clip in rgba and the canvas in YUV, ffmpeg inserted a
      // full-frame colour conversion at EVERY stage, and the cost was paid for
      // the whole timeline once per clip. Measured on 8 clips over a 12s
      // 1080x1920 output: 59.1s in rgba, 29.5s in yuva420p. Same picture, half
      // the time, one word changed.
      'format=yuva420p'
    ].filter((s): s is string => s !== null)
    /*
     * The grade, in three parts, because the middle one drops alpha.
     *
     * `eq` takes no pixel format with an alpha plane, so ffmpeg converts in
     * front of it and every transparent pixel comes out opaque — measured,
     * alpha 0 in and 255 out. Brightness on a clip that does not fill its box
     * turned the see-through bars black, and a sticker became its rectangle.
     * White balance, curves, despill and the look all keep alpha (measured the
     * same way); only `eq` does not, so only `eq` is wrapped (see below).
     */
    const beforeEq = [
      // A key's fringe comes out first, before anything grades what is left.
      key ? despillFilter(key) : null,
      // Grade after the fit, so it runs at canvas size rather than over every
      // pixel of a 6000px photograph.
      // White balance first: correct the light, then grade it.
      gradeInline ? whiteBalanceFilter(clip.color?.temperature, clip.color?.tint) : null
    ].filter((s): s is string => s !== null)
    // An adjustment layer's grade runs on the tracks below, further down; its
    // own chain is never drawn, so nothing may be split off it here.
    const eq = gradeInline && !clip.adjustment ? eqFilter(clip) : null
    const afterEq = [
      // Curves after the sliders, before the look: correct, shape, then style.
      gradeInline ? curvesFilter(clip.color?.curves) : null,
      // With a mask these move to `finish`, after the shape has been applied.
      ...(mask ? [] : finish)
    ].filter((s): s is string => s !== null)

    /*
     * The LUT cannot live in that chain.
     *
     * `lut3d` has no mix or intensity option — verified against the bundled
     * binary, not assumed — so anything short of full strength needs the graded
     * and ungraded pictures blended, and a blend takes two inputs. That makes it
     * a sub-graph rather than another link in a single chain.
     *
     * Alpha is held at full through the blend (c3_opacity=1): without it a
     * half-strength look would also make a sticker half-transparent. Measured on
     * a 40%-alpha source, the alpha comes out 0x66 either way.
     */
    let head = source
    let body = [...prepare, ...beforeEq].join(',')

    /*
     * The key, taken from the ungraded picture and put on straight away.
     *
     * `chromakey` REPLACES alpha, so it runs on a copy and only its alpha is
     * kept — multiplied into the clip's own transparency, never put on in place
     * of it. And it goes on HERE, on the fitted picture, rather than with the
     * shapes further down: everything after this point — the grade, a turn, an
     * opacity, a transition's punch-in — then acts on a picture that is already
     * keyed. As a late shape it met the picture after `finish` had turned it,
     * and a rotated keyed clip failed the whole export: the stencil was the
     * box's size and the turned picture was not.
     */
    if (key) {
      filters.push(`${source}${prepare.join(',')},split=3[kp${i}][ko${i}][kc${i}]`)
      filters.push(`[kc${i}]${chromakeyFilter(key)},alphaextract[kk${i}]`)
      filters.push(`[ko${i}]alphaextract[kn${i}]`)
      filters.push(`[kn${i}][kk${i}]blend=all_mode=multiply[ka${i}]`)
      filters.push(`[kp${i}][ka${i}]alphamerge[kd${i}]`)
      head = `[kd${i}]`
      body = beforeEq.join(',')
    }

    /*
     * `eq`, with the alpha it would drop handed back.
     *
     * The alpha is lifted off before it and merged on after, so the colour is
     * exactly what `eq` has always produced and only the transparency changes.
     * Measured at 1080x1920: about 0.03s per second of graded footage, paid
     * only by a clip whose brightness, contrast or saturation is set.
     */
    if (eq) {
      filters.push(`${head}${body ? `${body},` : ''}split[qa${i}][qb${i}]`)
      filters.push(`[qa${i}]format=yuva420p,alphaextract[ql${i}]`)
      filters.push(`[qb${i}]${eq}[qe${i}]`)
      filters.push(`[qe${i}][ql${i}]alphamerge[qm${i}]`)
      head = `[qm${i}]`
      body = ''
    }
    body = [body, ...afterEq].filter((s) => s.length > 0).join(',')
    const lut = clip.color?.lut
    const hasLook = Boolean(lut?.file && lut.intensity > 0)

    /*
     * The look, applied to whichever stream is asked for.
     *
     * A closure rather than inline code because a grade mask needs the same
     * sub-graph run on the masked copy instead of on the whole picture, and two
     * hand-written copies of a split-and-blend is two chances to get the alpha
     * handling subtly different. `prefix` keeps the labels unique between them.
     */
    const applyLook = (input: string, prefix: string): string => {
      const file = escapeFilterPath(lut!.file)
      if (lut!.intensity >= 0.999) {
        filters.push(`${input}lut3d=file=${file}:interp=tetrahedral[${prefix}r${i}]`)
      } else {
        const mix = lut!.intensity.toFixed(3)
        filters.push(`${input}split[${prefix}a${i}][${prefix}b${i}]`)
        filters.push(`[${prefix}b${i}]lut3d=file=${file}:interp=tetrahedral[${prefix}l${i}]`)
        filters.push(
          `[${prefix}a${i}][${prefix}l${i}]blend=all_mode=normal:` +
            `c0_opacity=${mix}:c1_opacity=${mix}:c2_opacity=${mix}:c3_opacity=1[${prefix}r${i}]`
        )
      }
      return `[${prefix}r${i}]`
    }

    // Not on an adjustment layer: its look runs on the tracks below (further
    // down), and one built here too was left unconnected — ffmpeg refused the
    // whole graph, so a Grade layer with a look could not export at all.
    if (hasLook && gradeInline && !clip.adjustment) {
      filters.push(`${head}${body || 'null'}[gs${i}]`)
      head = applyLook(`[gs${i}]`, 'g')
      body = ''
    }

    const start = framesToSeconds(clip.start, fps).toFixed(6)
    const end = framesToSeconds(clipEnd(clip), fps).toFixed(6)

    /*
     * An adjustment layer grades what is underneath it instead of drawing.
     *
     * `current` already holds every lower track composited together, so this is
     * simply a filter on that stream — which is exactly why the track position
     * decides the scope. `enable` limits it to the frames the clip covers, so
     * the horizontal position decides the when.
     */
    if (clip.adjustment) {
      const target = i === lastComposited ? '[vmix]' : `[o${i}]`
      const gate = `enable='between(t,${start},${end})'`
      let stream = current
      let stage = 0
      const nextLabel = (): string => `[aj${i}_${stage++}]`

      // `colorchannelmixer` takes `enable` like `eq` does (measured).
      const balance = whiteBalanceFilter(clip.color?.temperature, clip.color?.tint)
      if (balance) {
        const out = nextLabel()
        filters.push(`${stream}${balance}:${gate}${out}`)
        stream = out
      }

      const eq = eqFilter(clip)
      if (eq) {
        const out = nextLabel()
        filters.push(`${stream}${eq}:${gate}${out}`)
        stream = out
      }

      const shaped = curvesFilter(clip.color?.curves)
      if (shaped) {
        const out = nextLabel()
        filters.push(`${stream}${shaped}:${gate}${out}`)
        stream = out
      }

      const look = clip.color?.lut
      if (look?.file && look.intensity > 0) {
        const file = escapeFilterPath(look.file)
        if (look.intensity >= 0.999) {
          const out = nextLabel()
          filters.push(`${stream}lut3d=file=${file}:interp=tetrahedral:${gate}${out}`)
          stream = out
        } else {
          const mix = look.intensity.toFixed(3)
          const a = nextLabel()
          const b = nextLabel()
          const graded = nextLabel()
          const out = nextLabel()
          filters.push(`${stream}split${a}${b}`)
          filters.push(`${b}lut3d=file=${file}:interp=tetrahedral${graded}`)
          // Disabled, blend passes the first input through untouched — which is
          // the ungraded copy, so the layer simply stops outside its own span.
          filters.push(
            `${a}${graded}blend=all_mode=normal:` +
              `c0_opacity=${mix}:c1_opacity=${mix}:c2_opacity=${mix}:c3_opacity=1:${gate}${out}`
          )
          stream = out
        }
      }

      // A layer with nothing set on it yet still has to hand the chain along.
      filters.push(`${stream}null${target}`)
      current = target
      return
    }

    const offset = seconds(clip.start, fps)

    /*
     * The mask's shape, as a greyscale stream at canvas size.
     *
     * Written in plane-relative coordinates rather than absolute pixels — see
     * render/mask.ts for the measurement that forced it.
     */
    let shapeLabel: string | null = null
    if (mask) {
      /*
       * Drawn onto a copy of the clip's OWN stream rather than a fresh canvas.
       *
       * A generated `color` source would have to be told a size, and the only
       * size available here is the canvas — but the clip has already been
       * fitted to its box by this point, and a picture-in-picture's box is
       * smaller than the canvas. Splitting the stream means the shape is always
       * exactly the size of the thing it is masking, whatever that turns out to
       * be, and alphamerge never sees a mismatch.
       */
      filters.push(`${head}${body ? `${body},` : ''}split[mv${i}][mg${i}]`)
      filters.push(`[mg${i}]format=gray,geq=lum='${maskExpression(mask.shape)}'[ms${i}]`)
      head = `[mv${i}]`
      body = ''
      shapeLabel = `[ms${i}]`
    }

    /*
     * A luma wipe's shape, on the same footing as every other shape.
     *
     * The file's brightness decides the order pixels flip, and geq sweeps a
     * threshold across it over the transition's length.
     */
    const wipeIndex = maskInputs.get(clip.id)
    let wipeLabel: string | null = null
    if (wipeIndex !== undefined && transition?.mask) {
      const expression = lumaAlphaExpression(transitionSeconds, transition.softness)
      filters.push(
        // Scaled to the clip's box, not the canvas: alphamerge needs the two
        // streams the same size, and a clip that has been fitted to a smaller
        // box is no longer canvas-sized.
        `[${wipeIndex}:v]format=gray,scale=${Math.round(box.width)}:${Math.round(box.height)},` +
          `setsar=1,geq=lum='${expression}'[mk${i}]`
      )
      wipeLabel = `[mk${i}]`
    }

    /*
     * Everything that shapes alpha, multiplied into a single stencil.
     *
     * One alphamerge, never two. alphamerge REPLACES alpha, so a second one
     * silently throws the first away — which is what used to happen to a matted
     * clip that was also revealed by a wipe, despite the comment here promising
     * otherwise. A clip cut to the shape of a word, windowed by a mask, and
     * wiped on, has three shapes; multiplying them is what makes all three
     * survive rather than the last one winning.
     */
    /*
     * The sticker's own cut-out, on the same footing as every other shape.
     *
     * Scaled to the clip's box for the same reason the wipe is: alphamerge
     * refuses two streams of different sizes, and a sticker fitted to a box is
     * no longer canvas-sized. Going through the multiply chain rather than
     * straight to alphamerge is what lets a sticker also be masked, or wiped
     * on, without one shape silently replacing another.
     */
    const stickerIndex = assetMatteInputs.get(clip.id)
    let stickerLabel: string | null = null
    if (stickerIndex !== undefined) {
      filters.push(
        `[${stickerIndex}:v]format=gray,scale=${Math.round(box.width)}:${Math.round(box.height)},` +
          `setsar=1[mt${i}]`
      )
      stickerLabel = `[mt${i}]`
    }

    const matteLabel = clip.matte ? matteLabels.get(clip.matte.clipId) : undefined
    const shapes = [
      stickerLabel,
      matteLabel ?? null,
      mask?.mode === 'reveal' ? shapeLabel : null,
      wipeLabel
    ].filter((s): s is string => s !== null)

    if (shapes.length > 0) {
      /*
       * The clip's OWN alpha is the first shape, and the rest multiply into it.
       *
       * `alphamerge` REPLACES alpha. With only the shapes in the stencil, a
       * clip's own transparency was thrown away the moment it had one: the
       * see-through bars a fit leaves around a picture that does not fill its
       * box came back solid black, and a transparent PNG went opaque inside its
       * mask. Measured: a 4:3 clip over red with a reveal mask — the side bars
       * were 0,0,0 where they should have been the red below.
       */
      filters.push(`${head}${body || 'null'},split[mb${i}][mo${i}]`)
      filters.push(`[mo${i}]format=yuva420p,alphaextract[ma${i}]`)
      let stencil = `[ma${i}]`
      for (let s = 0; s < shapes.length; s++) {
        filters.push(`${stencil}${shapes[s]}blend=all_mode=multiply[cs${i}_${s}]`)
        stencil = `[cs${i}_${s}]`
      }
      filters.push(`[mb${i}]${stencil}alphamerge[mm${i}]`)
      head = `[mm${i}]`
      body = ''
    }

    /*
     * An effect confined to the shape — blur inside it, or colour inside it.
     *
     * The picture's own alpha is lifted out first, the merge happens between
     * two fully opaque copies, and the alpha goes back on at the end. The
     * obvious route, overlaying the effected copy straight onto the original,
     * was measured and is WRONG: with a half-transparent source the region
     * under the overlay came back fully opaque, so a sticker with a blurred
     * patch would have grown a solid rectangle nobody asked for. `maskedmerge`
     * was measured too and mangles chroma on subsampled input. This route came
     * back exact to the byte on both sides of the edge.
     */
    if (mask && shapeLabel && mask.mode !== 'reveal') {
      const inner =
        mask.mode === 'blur'
          ? // gblur wants a sigma; people think in radius, and half is the
            // usual correspondence between the two.
            [`gblur=sigma=${Math.max(0.1, mask.blur / 2).toFixed(2)}`]
          : [
              whiteBalanceFilter(clip.color?.temperature, clip.color?.tint),
              eqFilter(clip),
              curvesFilter(clip.color?.curves)
            ].filter(
              (s): s is string => s !== null
            )

      filters.push(`${head}${body || 'null'}[xs${i}]`)
      filters.push(`[xs${i}]split[xa${i}][xb${i}]`)
      filters.push(`[xa${i}]format=yuva420p,alphaextract[xl${i}]`)
      filters.push(`[xb${i}]format=yuv420p,split[xc${i}][xd${i}]`)
      filters.push(`[xd${i}]${inner.length > 0 ? inner.join(',') : 'null'}[xe${i}]`)

      let effected = `[xe${i}]`
      if (mask.mode === 'grade' && hasLook) effected = applyLook(effected, 'k')

      filters.push(`${effected}${shapeLabel}alphamerge[xm${i}]`)
      filters.push(`[xc${i}]format=yuva420p[xg${i}]`)
      filters.push(`[xg${i}][xm${i}]overlay=0:0:format=auto,format=yuv420p[xn${i}]`)
      filters.push(`[xn${i}][xl${i}]alphamerge[xo${i}]`)
      head = `[xo${i}]`
      body = ''
    }

    // The tail the mask displaced. With no mask these are already in the chain.
    if (mask && finish.length > 0) body = body ? `${body},${finish.join(',')}` : finish.join(',')

    // setpts moves the clip to its timeline position; without it every clip
    // would start at zero regardless of where it sits.
    filters.push(`${head}${body ? `${body},` : ''}setpts=PTS-STARTPTS+${offset}/TB[v${i}]`)

    const next = i === lastComposited ? '[vmix]' : `[o${i}]`

    // Position expressions are written against S, the clip's timeline start.
    const place = transition?.position
      ? (() => {
          const p = transition.position(context)
          /*
           * An OFFSET from where the clip rests, added to its box.
           *
           * This used to replace the box outright, and the transition's own
           * expressions rest at 0 — so a slide onto a picture-in-picture, a
           * corner logo or anything else not filling the frame flew it to the
           * top-left of the canvas and left it there for the rest of the shot.
           * The box carries the same `-grow` shift it does without a
           * transition: a turned clip's frame is grown to keep its corners, and
           * the picture no longer starts at the stream's corner.
           */
          const from = (rest: number, expression: string): string =>
            `(${rest})+(${expression.replace(/\bS\b/g, start)})`
          return {
            x: from(box.x - growX, p.x),
            y: from(box.y - growY, p.y)
          }
        })()
      : hasPath(clip)
        ? {
            // A path moves the clip relative to its resting box, so a clip with
            // both a position and a path still starts where the box puts it.
            x: pathExpression(clip.path!, 'x', {
              durationFrames: clip.duration,
              fps,
              startSeconds: framesToSeconds(clip.start, fps),
              scale: width / 2,
              offset: box.x - growX
            }),
            y: pathExpression(clip.path!, 'y', {
              durationFrames: clip.duration,
              fps,
              startSeconds: framesToSeconds(clip.start, fps),
              scale: height / 2,
              offset: box.y - growY
            })
          }
        : { x: `${box.x - growX}`, y: `${box.y - growY}` }

    // repeatlast=0 stops the clip's final frame being held for the rest of the
    // timeline; eof_action=pass keeps the base flowing once the clip ends.
    filters.push(
      `${current}[v${i}]overlay=x='${place.x}':y='${place.y}':format=yuv420:` +
        `eof_action=pass:repeatlast=0:enable='between(t,${start},${end})'${next}`
    )
    current = next
  })

  let videoOut = '[vmix]'
  if (request.subtitlesPath) {
    const file = escapeFilterPath(request.subtitlesPath)
    const fonts = request.fontsDir ? `:fontsdir=${escapeFilterPath(request.fontsDir)}` : ''
    filters.push(`[vmix]subtitles=filename=${file}${fonts}[vsub]`)
    videoOut = '[vsub]'
  }
  if (captionInput !== null) {
    /*
     * Baked captions, over everything, in the same pass.
     *
     * `fps` normalises the demuxer's variable rate — the pictures arrive with
     * whatever durations they are held for — and `shortest=1` means a bake that
     * is a frame short can neither extend the video nor truncate it.
     *
     * Measured at 1080x1920, on ten seconds: a full-frame overlay costs 3.4s and
     * a band 0.86s, which is why the y offset exists at all.
     */
    const overlay = request.captionOverlay!
    filters.push(`[${captionInput}:v]fps=${fps},format=rgba[cap]`)
    filters.push(
      `${videoOut}[cap]overlay=0:${Math.round(overlay.y)}:shortest=1:format=auto[vcap]`
    )
    videoOut = '[vcap]'
  }
  // A range's front comes off last, so everything before it was composed on
  // the full edit's own clock. `trim` and `setpts` are both ancient.
  const videoTrim = trimFrom === null ? '' : `trim=start=${trimFrom},setpts=PTS-STARTPTS,`
  filters.push(`${videoOut}${videoTrim}format=yuv420p[vout]`)

  /* -------------------------------------------------------------- audio */

  /* Dialogue and music are kept apart so one can duck the other. */
  const dialogueLabels: string[] = []
  const musicLabels: string[] = []
  const otherLabels: string[] = []

  /*
   * A clip's fades, including the ones its neighbours imply.
   *
   * Sorted per track once rather than per clip, because `addAudio` runs for
   * every clip and a timeline of a few hundred would otherwise sort inside the
   * loop. The neighbours are on the clip's OWN track — an overlap with
   * something on another track is a layer, not an edit point, and two tracks
   * playing at once is the whole purpose of having two.
   */
  const byTrack = new Map<string, Clip[]>()
  for (const c of project.clips) {
    const list = byTrack.get(c.trackId)
    if (list) list.push(c)
    else byTrack.set(c.trackId, [c])
  }
  for (const list of byTrack.values()) list.sort((a, b) => a.start - b.start)

  const withNeighbourFades = (clip: Clip): Clip => {
    const lane = byTrack.get(clip.trackId) ?? []
    const i = lane.findIndex((c) => c.id === clip.id)
    const fades = fadesWithNeighbours(clip, i > 0 ? lane[i - 1] : null, lane[i + 1] ?? null)
    return { ...clip, fadeIn: fades.fadeIn, fadeOut: fades.fadeOut }
  }

  const addAudio = (index: number, clip: Clip, label: string, into: string[]): void => {
    // Clamped to the same +6 dB ceiling the fader stops at: a hand-edited
    // project asking for 50x would otherwise reach the speakers as asked.
    const volume = clampGain(clip.volume ?? 1)
    /*
     * A drawn envelope beats the flat level.
     *
     * `volume` takes an expression with `eval=frame`, and — unlike `scale`,
     * which accepts `eval=frame` and then silently ignores what it is given
     * (EFFECTS.md §1) — it genuinely follows it. Measured on a 4s tone with
     * `if(lt(t,2),1,0.25)`: the second half came back 12.0 dB down, which is
     * 0.25x to within rounding.
     *
     * `t` here is time since the clip's own first frame, because `adelay`
     * comes AFTER this in the chain — so the envelope is authored in clip time
     * and needs no timeline offset.
     */
    const envelope = clip.keyframes?.volume
    const hasEnvelope = envelope !== undefined && envelope.length > 0
    const volumeFilter =
      hasEnvelope
        ? `volume=volume='${keyframeExpression(envelope!, {
            durationFrames: clip.duration,
            fps,
            startSeconds: 0,
            fallback: volume
          })}':eval=frame`
        : volume === 1
          ? null
          : `volume=${volume}`
    /*
     * A muted clip is not a quiet input, it is not an input.
     *
     * Mixing it changes nothing in the output — padding plus `volume=N` cancels
     * amix's renormalisation exactly, so silence in is silence out — but it
     * decodes a stream, builds a filter chain, and pushes the audio tail off the
     * single-source `anull` path onto the full apad/atrim/amix workaround, which
     * is the branch carrying every 2018-ffmpeg compromise. Stickers land muted
     * and their colour files DO carry an aac stream, so on a timeline of them
     * this was the normal case rather than an edge one.
     *
     * The guard lives here rather than at the two call sites so picture audio
     * and audio-track clips cannot drift apart.
     *
     * It must test the FLAT level AND the absence of an envelope, not the flat
     * level alone. When this was written `volume` was a plain scalar and the
     * reasoning was that nothing could raise it mid-clip; the envelope made
     * that false the same day. A sticker lands at `volume: 0` by design and is
     * meant to be turned back up: through the Sound row that lifts the scalar
     * and is fine, but through the envelope the keyframes are written WITHOUT
     * touching `clip.volume`, so a flat-only guard discarded the clip before
     * the expression above was ever used. Drawn curve on screen, silence in
     * the file: the shape this project keeps meeting.
     */
    if (volume === 0 && !hasEnvelope) return
    const delayMs = Math.round(framesToSeconds(clip.start, fps) * 1000)
    const chain = [
      'aformat=sample_fmts=fltp:channel_layouts=stereo',
      `aresample=${project.settings.sampleRate}`,
      /*
       * Tempo before delay: the stretch belongs to the clip, the delay places
       * the stretched result on the timeline. The other order would scale the
       * offset too and slide every slowed clip out of sync.
       */
      ...atempoChain(clipSpeed(clip)),
      /*
       * The voice effect after the speed stretch, before the level.
       *
       * After, because both reach for `atempo` and the two are different
       * intentions: speed changes how long the clip is, and a voice effect
       * changes its pitch while deliberately keeping the length. Running them
       * in one chain rather than combining the ratios keeps that readable —
       * and keeps a slowed clip with a chipmunk voice honest about being both.
       *
       * Before the level, so the fader and the envelope apply to the finished
       * sound rather than being re-scaled by a band filter afterwards.
       */
      ...voiceFilters(clip.voice, project.settings.sampleRate),
      volumeFilter,
      /*
       * Fades after the level, before the delay.
       *
       * After the level so a fade multiplies whatever the envelope drew rather
       * than arguing with it — the two are separate controls and both apply.
       * Before the delay because `afade` is told a time, and until `adelay`
       * runs the clip's stream still begins at zero however far along the
       * timeline the clip sits. Putting these after the delay would need every
       * fade offset by the clip's position, and getting it wrong would push a
       * fade-out past the end of the stream, where it silently does nothing.
       */
      ...audioFadeFilters(withNeighbourFades(clip), fps),
      /*
       * One delay per channel, repeated — not `:all=1`.
       *
       * `all` arrived in ffmpeg 4.2, and `@ffmpeg-installer` ships an older
       * build on Windows (docs/EFFECTS.md §25), where it is "Option not found"
       * and the whole graph fails to initialise.
       *
       * Simply dropping it would be worse than the error it replaces: a bare
       * `adelay=500` delays only the FIRST channel, so every clip with a
       * timeline offset would play its left channel late and its right on time.
       * Measured — L came back silent for the first 400ms and R still running
       * at −24dB. Eight repeats cover 5.1 and are harmless on stereo, where the
       * extras are ignored.
       */
      delayMs > 0 ? `adelay=${Array(8).fill(delayMs).join('|')}` : null
    ]
      .filter((x): x is string => x !== null)
      .join(',')
    filters.push(`[${index}:a]${chain}${label}`)
    into.push(label)
  }

  /*
   * Every clip's sound, onto the bus its TRACK plays in.
   *
   * A video clip's own sound used to go into the dialogue mix on `hasAudio`
   * alone — no mute check — so muting a video track silenced it in the editor
   * and left it talking in the file. And an audio track could only ever be
   * music or accompaniment, never speech, so a voice-over had nothing ducking
   * for it. Both questions are `isAudible` and `audioRole` now, the same two
   * the preview's mixer asks.
   *
   * A detached clip's sound is skipped outright rather than zeroed: its audio
   * lives on the clip that was lifted off it, and a zero fader would still let
   * a drawn envelope through the `volume === 0 && !hasEnvelope` guard.
   */
  const busFor = (role: AudioRole): string[] =>
    role === 'dialogue' ? dialogueLabels : role === 'music' ? musicLabels : otherLabels

  videoInputs.forEach(({ clip, index, hasAudio }, i) => {
    if (!hasAudio || clip.audioDetached) return
    const track = project.tracks.find((t) => t.id === clip.trackId)
    if (!track || !isAudible(track, project.tracks)) return
    addAudio(index, clip, `[va${i}]`, busFor(audioRole(track)))
  })
  audioInputs.forEach(({ clip, index }, i) => {
    const track = project.tracks.find((t) => t.id === clip.trackId)
    if (!track) return
    addAudio(index, clip, `[aa${i}]`, busFor(audioRole(track)))
  })

  /** Combine a set of labels into one stream, or null when there are none. */
  const mixInto = (labels: string[], out: string): string | null => {
    if (labels.length === 0) return null
    filters.push(...mixFilters(labels, out, seconds(totalFrames, fps)))
    return out
  }

  const dialogue = mixInto(dialogueLabels, '[dia]')
  const music = mixInto(musicLabels, '[mus]')
  const other = mixInto(otherLabels, '[oth]')

  const finalLabels: string[] = []

  if (music && dialogue) {
    // sidechaincompress rather than a hand-built volume expression: it gives
    // natural attack and release, and a piecewise expression over hundreds of
    // speech spans becomes unreadable and slow.
    filters.push(`${dialogue}asplit=2[dia_out][dia_key]`)
    /*
     * Both inputs pinned to one format, immediately before the filter.
     *
     * `sidechaincompress` will not negotiate its two inputs on its own, and
     * without this it does not merely sound wrong — the graph refuses to
     * initialise and the ENTIRE EXPORT fails:
     *
     *     The following filters could not choose their formats:
     *     Parsed_sidechaincompress_18
     *     Error reinitializing filters!
     *
     * Every clip chain already ends in `aformat=sample_fmts=fltp:
     * channel_layouts=stereo` followed by `aresample=48000`, which looks like
     * enough and is not: `aresample` converts the samples without pinning the
     * rate for the negotiation, so the two branches arrive with rates the
     * filter cannot reconcile. Naming `sample_rates` here is what fixes it.
     *
     * This shipped. Ducking is set by the Director on every ad it builds
     * (`director/apply.ts`), so every one of those exports died at the
     * filtergraph — and no test caught it because the duck was only ever
     * checked as a STRING. It is rendered now: tests/integration/mix.int.test.ts.
     */
    const pinned =
      `aformat=sample_fmts=fltp:channel_layouts=stereo:` +
      `sample_rates=${project.settings.sampleRate}`
    /*
     * And the key runs to the END, not to the last word.
     *
     * `sidechaincompress` stops when its sidechain stops, so a voiceover that
     * finishes before the music did took the music with it: rendered and
     * measured, the mix held -23.4 dB while the voice ran and dropped to -91 —
     * digital silence — for every second after it. A thirty-second ad with a
     * twenty-second read came out with ten seconds of nothing.
     *
     * Padding the key with silence keeps the compressor running, and silence
     * is below the threshold, so the music simply comes back up. `apad` bounded
     * by `atrim` rather than `apad:whole_dur`, which is 4.2 and dies on the
     * Windows build (docs/EFFECTS.md §25).
     */
    const full = seconds(totalFrames, fps)
    filters.push(`[dia_key]${pinned},apad,atrim=end=${full}[dia_keyf]`)
    filters.push(`${music}${pinned}[musf]`)
    // The settings live in render/duck.ts, because the preview's own ducker
    // reads the same ones — two sets of numbers is how a preview comes to teach
    // a balance the export does not deliver.
    filters.push(`[musf][dia_keyf]${duckFilter()}[ducked]`)
    finalLabels.push('[dia_out]', '[ducked]')
  } else {
    if (dialogue) finalLabels.push(dialogue)
    if (music) finalLabels.push(music)
  }
  if (other) finalLabels.push(other)

  const audioLabels = finalLabels

  if (audioLabels.length === 0) {
    /*
     * Silence keeps the output shape identical whether or not anything has
     * audio, so downstream tools never see a video-only file by surprise.
     *
     * No `d=` on it, deliberately. `anullsrc` gained a duration option in
     * ffmpeg 4.2, and `@ffmpeg-installer` ships a DIFFERENT ffmpeg per
     * platform — 4.4 on macOS arm64, older on Windows. So the option is
     * present on the machine this was written on and missing on the one it
     * shipped to, where every single render died with "Option 'd' not found"
     * before a frame was encoded.
     *
     * It was never needed anyway: the output already carries `-t`, which is
     * what actually bounds the stream. Measured both ways on the same graph —
     * 4.00s with the option and 4.00s without it.
     *
     * The wider lesson is in docs/EFFECTS.md §25: anything reached for here has
     * to exist in the OLDEST bundled build, not the newest.
     */
    filters.push(
      `anullsrc=channel_layout=stereo:sample_rate=${project.settings.sampleRate}[aout]`
    )
  } else {
    /*
     * Loudness goes last, on the finished mix, or it is not loudness.
     *
     * The measurement is of everything together — normalising a clip before
     * the music joins it would target a number that stops being true the
     * moment anything else is added.
     *
     * The silence branch above is deliberately left alone. `loudnorm` on
     * silence measures `-inf` LUFS, and asking for a finite target from that
     * is a request to amplify nothing by an unbounded amount.
     */
    const loudness = loudnessFilters(project.settings.loudness, project.settings.sampleRate)
    /*
     * A range's front comes off the MIX, before loudness.
     *
     * After it, `loudnorm` would have spent the whole stretch before the in
     * point listening to silence — its dynamic mode rides the gain up through
     * it — and the range would open on a lurch. Trimmed first, it measures only
     * what is actually in the file. The silence branch needs no trim: silence
     * from zero is the same silence, and `-t` bounds it.
     */
    const after = [
      ...(trimFrom === null ? [] : [`atrim=start=${trimFrom}`, 'asetpts=PTS-STARTPTS']),
      ...loudness
    ]
    if (after.length === 0) {
      filters.push(...mixFilters(audioLabels, '[aout]', seconds(totalFrames, fps)))
    } else {
      filters.push(...mixFilters(audioLabels, '[amixed]', seconds(totalFrames, fps)))
      filters.push(`[amixed]${after.join(',')}[aout]`)
    }
  }

  args.push(
    '-filter_complex', filters.join(';'),
    '-map', '[vout]',
    '-map', '[aout]',
    // The graph's own duration is authoritative; without this a held audio
    // stream can run past the picture.
    '-t', seconds(outputFrames, fps),
    ...encoderArgs(spec, width * height),
    /*
     * The container named outright, not left to the file's extension: ProRes
     * cannot go in an MP4, and a name typed as `.mp4` before switching codec
     * must not be what decides. The renderer fixes the name to match as well.
     */
    '-f', containerFor(spec.encoder, spec.container),
    outputPath
  )

  return { args, durationFrames: outputFrames, clips: entries }
}

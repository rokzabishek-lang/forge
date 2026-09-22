import type { MediaKind } from './types'
import type { KeyframeTracks } from './render/keyframes'
import { isNeutralCurves, type Curves } from './render/colourCurve'
import { DEFAULT_LOUDNESS } from './render/loudness'
import type { PaperSpec } from './render/paper'
import type { CarouselClipSpec } from './render/carousel'
import type { Mask } from './render/mask'
import type { Transcript } from './transcript'
import type { VoiceEffect } from './render/voice'
/*
 * A value import, unlike every other one above, and safe: `render/speed.ts`
 * takes only TYPES from this file, so the edge is one-way at runtime. It is
 * worth the asymmetry — the alternative is a second copy of "how much source
 * does a timeline frame eat", and the first copy of that already drifted.
 */
import { clipSpeed, maxDurationAtSpeed, sourceFrameAt } from './render/speed'

/**
 * Everything on the timeline is measured in whole frames at the project frame
 * rate. Seconds are a display concern only — floating-point positions drift and
 * make cuts land a frame off, which is exactly the bug you cannot debug later.
 */
export type Frames = number

export interface ProjectSettings {
  width: number
  height: number
  fps: number
  sampleRate: number
  /**
   * Integrated loudness target for the export, in LUFS. Absent means off.
   *
   * Absent rather than a number so a project saved before this existed keeps
   * sounding exactly as it did. New projects get `DEFAULT_LOUDNESS`; see
   * render/loudness.ts for why one pass is enough and why `aformat` after it
   * is not optional.
   */
  loudness?: number
}

export interface CaptionSettings {
  enabled: boolean
  /** Id from CAPTION_STYLES. */
  styleId: string
  /** User edits layered over the preset; see resolveStyle. */
  overrides?: Record<string, unknown>
}

export interface MediaAsset {
  id: string
  path: string
  /**
   * The same file, expressed relative to the PROJECT's folder.
   *
   * Set when the asset sits under the folder the project was saved into, which
   * is the case worth handling: footage that travels with the project. On open,
   * an absolute path that no longer resolves is retried through this, so
   * moving the whole folder — or opening it on the other machine — simply
   * works. Absent when the asset lives elsewhere, where a relative path would
   * be `../../..` segments that stop meaning anything the moment either end
   * moves.
   */
  relativeTo?: string
  /**
   * The file is not where the project says it is. RUNTIME ONLY.
   *
   * Never written to a project file: it describes this machine at this moment,
   * and a saved `offline: true` would mark an asset missing on a machine where
   * it is present. Every surface reads it — a badge in the pool, a card in the
   * preview instead of black, a striped clip on the timeline — so a missing
   * file looks like a missing file rather than like the app being broken.
   */
  offline?: boolean
  name: string
  kind: MediaKind
  /** Source length in project frames. Stills get a nominal length. */
  durationFrames: Frames
  width: number | null
  height: number | null
  /** Source frame rate; null for audio and stills. */
  fps: number | null
  hasVideo: boolean
  hasAudio: boolean
  size: number
  /**
   * Baked frames, when the editor DREW this asset moving.
   *
   * Animated text is the only producer today: the renderer paints the frames
   * that actually move and writes them numbered, and `path` stays the settled
   * still so anything wanting one picture still finds one. The export reads the
   * sequence and holds its last frame for the rest of the clip, so what it costs
   * is set by how long the movement lasts rather than by how long the words are
   * on screen.
   */
  frames?: {
    /** An ffmpeg image2 pattern, e.g. `…/clip.seq/%05d.png`, numbered from 0. */
    pattern: string
    count: number
  }

  /**
   * A greyscale video holding this asset's alpha, beside `path`.
   *
   * Clip stickers only. H.264 4:2:0 cannot carry an alpha channel at all, so a
   * keyed cut-out ships as a PAIR — colour here, matte there — recombined with
   * `alphamerge` at render. The colour file still has the green background in
   * its RGB; the matte is what hides it.
   *
   * On the ASSET rather than the clip, because it is a property of the file and
   * travels with every copy of it. `clip.matte` is a different thing entirely:
   * that points at another clip on the timeline.
   */
  matte?: string
}

export interface Transform {
  /**
   * Offset from centre, as a fraction of HALF the canvas.
   *
   * So `1` is the full half-width — 960px at 1080p — and `0.5` is a quarter of
   * the canvas across. Not pixels, which is what this said until an exporter
   * was written against it: the units are three orders of magnitude apart at
   * 1080p, and every position it produced would have been wrong without being
   * obviously wrong.
   *
   * The unit is deliberate. It makes the value resolution-independent, which is
   * what lets a clip keep its position when the project is re-framed from 16:9
   * to 9:16 — and `clipBox` (render/plan.ts) is the single place it is turned
   * back into pixels: `(x * canvas.width) / 2`. `gridCells` relies on exactly
   * this when it derives `x: (2 * bx0 + boxW - canvas.width) / canvas.width`.
   */
  x: number
  /** As `x`, but a fraction of half the canvas HEIGHT. */
  y: number
  scale: number
  /**
   * Vertical scale, when it differs from `scale`.
   *
   * A filmstrip panel is a quarter of the frame wide and all of it tall, which
   * one uniform scale cannot say. Absent means square with `scale`, so every
   * existing clip is unaffected.
   */
  scaleY?: number
  /**
   * How the source fills its box.
   *
   * `contain` (the default, and what every clip did before) letterboxes to fit.
   * `cover` fills the box and crops the overflow — which is the only sensible
   * thing for a narrow panel, since a landscape photo letterboxed into a tall
   * strip is a thin band floating in black.
   */
  fit?: 'contain' | 'cover'
  rotation: number
  opacity: number
}

/**
 * The grade on a clip.
 *
 * The three sliders match ffmpeg's `eq` exactly — brightness is an offset around
 * 0, contrast and saturation are multipliers around 1 — so the neutral state is
 * also the identity and a clip that has never been graded costs no filter.
 */
export interface ColorAdjust {
  /** -1..1, an offset. */
  brightness: number
  /** 0..3, a multiplier. 1 is untouched. */
  contrast: number
  /** 0..3, a multiplier. 0 is greyscale. */
  saturation: number
  /**
   * Per-channel curves — the grading tool, before any look.
   *
   * Lift the shadows, roll off the highlights, put a little blue in the blacks.
   * Applied after the three sliders and before the LUT, which is the order every
   * grading tool uses: correct, shape, then style.
   */
  curves?: Curves
  /**
   * A 3D LUT laid over the top, as every grading tool ships them.
   *
   * Applied after the three sliders, which is the order Resolve and CapCut both
   * use: correct the picture first, then put the look on it.
   */
  lut?: LutRef
}

export interface LutRef {
  /** Absolute path to a .cube file. */
  file: string
  /** For the UI — a filename is not always the name of the look. */
  name?: string
  /** 0..1. CapCut calls this Intensity; a look at full strength is rare. */
  intensity: number
}

/**
 * The reframe rectangle, in SOURCE pixels. This is what auto-reframe computes and
 * what the user drags in the NLE when the crop lands on the wrong person.
 * Undefined means "use the whole frame".
 */
export interface CropRect {
  x: number
  y: number
  width: number
  height: number
}

export const DEFAULT_TRANSFORM: Transform = { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }
export const DEFAULT_COLOR: ColorAdjust = { brightness: 0, contrast: 1, saturation: 1 }

/** True when a grade would change nothing, so the render can skip it entirely. */
export function isNeutralGrade(color: ColorAdjust | undefined): boolean {
  if (!color) return true
  if (color.lut?.file && color.lut.intensity > 0) return false
  if (!isNeutralCurves(color.curves)) return false
  return (
    Math.abs(color.brightness) < 0.001 &&
    Math.abs(color.contrast - 1) < 0.001 &&
    Math.abs(color.saturation - 1) < 0.001
  )
}

/** True when only the LUT is doing anything — the eq filter can be skipped. */
export function isNeutralEq(color: ColorAdjust | undefined): boolean {
  if (!color) return true
  return (
    Math.abs(color.brightness) < 0.001 &&
    Math.abs(color.contrast - 1) < 0.001 &&
    Math.abs(color.saturation - 1) < 0.001
  )
}

export interface Clip {
  id: string
  assetId: string
  trackId: string
  /** Position of the clip's first frame on the timeline. */
  start: Frames
  /** Length on the timeline. */
  duration: Frames
  /** Offset into the source media of the clip's first frame. */
  inPoint: Frames
  volume: number
  transform: Transform
  color: ColorAdjust
  /** Static reframe rectangle. Keyframed crop paths arrive with the NLE. */
  crop?: CropRect
  /**
   * Playback rate. 1 is untouched; below 1 is slow motion.
   *
   * The source range stays where it is and `duration` changes instead, which is
   * what makes half speed show the same footage over twice the time. See
   * render/speed.ts — the frames consumed are always `duration × speed`.
   */
  speed?: number
  /**
   * A voice effect on this clip's sound — chipmunk, monster, phone call.
   *
   * Pitch WITHOUT tempo, so the clip is exactly as long as it was and nothing
   * after it on the timeline moves. See render/voice.ts. Absent means the
   * sound is untouched, which is every clip made before this existed.
   */
  voice?: VoiceEffect
  /**
   * Frames of fade at the head and the tail of the clip's sound.
   *
   * Deliberately NOT the same thing as the `volume` envelope, and multiplied
   * with it rather than replacing it: the envelope says *quiet it here*, a
   * fade says *do not start or stop abruptly*. See render/audioFade.ts.
   *
   * In frames like everything else on the timeline, so a fade survives being
   * re-timed the same way a cut does. Absent means no fade, which is what
   * every clip made before this had.
   */
  fadeIn?: Frames
  fadeOut?: Frames
  /**
   * Invent the in-between frames rather than repeating them.
   *
   * Only meaningful below 1× — speeding up discards frames and has nothing to
   * interpolate. Measured at 41× the render cost, so it is never the default.
   */
  smoothSlow?: boolean
  /**
   * A shape on the picture, and something that happens only inside it.
   *
   * Distinct from `matte`, which takes its shape from another clip on the
   * timeline: this one is a drawn region belonging to this clip alone, and it
   * carries a verb — blur inside, colour inside, or show only inside. See
   * render/mask.ts for why a video editor's toolbox is a mask toolbox and not a
   * paint toolbox.
   */
  mask?: Mask
  /**
   * Transition into this clip. The clip genuinely overlaps the one before it by
   * `durationFrames` — that overlap IS the transition, and the compositor draws
   * this clip over the previous one for its duration.
   */
  transitionIn?: { id: string; durationFrames: Frames }
  /**
   * A title card generated from an SVG template.
   *
   * The clip's asset points at a PNG rendered from this; `version` increments on
   * every edit so the preview knows the bytes changed even though the path did
   * not.
   */
  title?: { template: string; texts: string[]; version: number }
  /**
   * Plain text, with no template behind it.
   *
   * The title system needs an SVG file with placeholders in it, which meant
   * there was no way to simply write a word — and so nothing to put behind a
   * subject, which is what the whole sandwich exists for. `version` increments
   * on every edit so the preview knows the PNG changed although its path did
   * not.
   */
  text?: TextSpec
  /**
   * A flat card of colour.
   *
   * Text needs something to sit on when there is no footage under it, and a
   * matte or a colour wash between shots is an ordinary editing move. Cheaper
   * and clearer as a real clip than as a special case in the renderer.
   */
  solid?: SolidSpec
  /**
   * A run of newspaper clippings with a word highlighted across them.
   *
   * Like `text`, this is a clip that DRAWS itself rather than one that shows a
   * file: the pages are baked to a numbered PNG sequence with alpha and held
   * by `tpad`, so it composites over footage with no green screen. See
   * render/paper.ts for the layout and docs/PAPER.md for why this look and not
   * the other three on the reference site.
   */
  paper?: PaperSpec
  /**
   * Photographs on a ring, in 3D.
   *
   * Like `text` and `paper`, a clip that DRAWS itself: the ring is rendered
   * with three.js and baked to a numbered PNG sequence with alpha, so nothing
   * in the export knows three.js exists. See render/carousel.ts for the
   * geometry, which imports none of it.
   */
  carousel?: CarouselClipSpec
  /**
   * Set when an automation rule created this clip.
   *
   * Re-running a rule replaces its previous output rather than stacking a second
   * copy on top, and it lets the UI show *why* something appeared — which is
   * what keeps an automated edit auditable rather than mysterious.
   */
  generatedBy?: { rule: string; reason: string }
  /**
   * What this clip's length and fade were BEFORE the director shortened it.
   *
   * The director trims the music to the ad it built. That is an edit to a
   * clip the user placed, not a clip the director made, so `clearGenerated`
   * cannot undo it by removing clips — and without a record, Clear leaves the
   * song cut short and every later run builds its menu from the shorter clip,
   * so the ad can only ever shrink. Stamped once, on the first trim, and
   * restored and removed by `clearDirector`. See shared/director/apply.ts.
   */
  directorTrim?: { duration: Frames; fadeOut?: Frames }
  /**
   * Camera move across a still.
   *
   * Without it a photo reel is a slideshow: a static image held for two seconds
   * reads as dead air however well the cut lands on the beat. Two moves are not
   * enough either — alternating push/pull down a reel is itself a pattern the
   * eye picks up within four shots, which is why the repertoire is wide.
   */
  motion?: Motion
  /**
   * Animated position, as points the clip travels between.
   *
   * Position only, deliberately. Overlay `x`/`y` take expressions in `t` and
   * the transition system already relies on that, so this is proven ground.
   * Animated SIZE is not here: `scale` with `eval=frame` re-evaluates but does
   * not follow its own expression — measured, a width that should have grown
   * from 192px to 495px shrank to 138px instead. That is the same trap as
   * `crop` resolving w/h once, and it is not something to build on.
   *
   * `frame` is relative to the clip's own start, so moving a clip does not
   * rewrite its path.
   */
  path?: PathPoint[]
  /**
   * Values that change over the clip — zoom, rotation, opacity.
   *
   * Position is not here: the motion path already animates it and has presets,
   * and two mechanisms for one property would be two things to disagree.
   */
  keyframes?: KeyframeTracks
  /**
   * Take this clip's alpha from another clip's brightness.
   *
   * Text as a window onto footage — the trailer look where a photograph moves
   * inside block letters. The mechanism is `alphamerge`, the same filter the
   * mask transitions already use; what is new is that the mask is a clip on the
   * timeline rather than a file in the library, so it can be typed and moved.
   */
  matte?: { clipId: string }
  /**
   * This clip is only a shape for another clip's matte, never drawn itself.
   *
   * It stays an ordinary clip on the timeline — visible, selectable, editable —
   * because the whole point is being able to retype the word and see the fill
   * follow.
   */
  matteOnly?: boolean
  /**
   * A grade applied to everything on the tracks BELOW it.
   *
   * Resolve's adjustment clip, and the shape of it is the elegant part: the
   * track position decides which layers are included, the horizontal duration
   * decides when. One object carrying two different meanings on two axes.
   *
   * It is never drawn itself — it has no picture — so the clip's own colour is
   * the grade, and its media is a transparent card that exists only to make it
   * an ordinary, draggable, trimmable clip like everything else.
   */
  adjustment?: boolean
  /**
   * Which depth planes this clip draws.
   *
   * Text behind a person needs the background and the subject to sit on either
   * side of the text in the compositing order, and a clip is one stream — so
   * the photo becomes TWO ordinary clips: one drawing `background`, one drawing
   * `front`, with the text on a track between them.
   *
   * Ordinary, visible, deletable clips rather than a hidden mode: you can see
   * why the text is behind the subject by looking at the timeline, and you undo
   * it by deleting a clip. See docs/AUTOMATION.md §6.
   */
  planes?: 'background' | 'front'
}

export interface TextSpec {
  content: string
  /** Font family name, resolved against the catalogue's fonts. */
  font: string
  /** Cap height as a fraction of canvas height, so it scales with the canvas. */
  size: number
  color: string
  align: 'left' | 'center' | 'right'
  /** Where the block sits vertically. `lower` is the lower-third convention. */
  position: 'top' | 'center' | 'lower'
  weight: number
  /**
   * Letter spacing, as a fraction of the font size.
   *
   * The single biggest lever on whether type reads as cinematic. Wide tracking
   * with capitals is the film-title look; tight tracking builds tension. A
   * default of zero is what makes text look like a caption rather than a title.
   */
  tracking: number
  /** Capitals pressurise; lowercase is approachable. */
  uppercase: boolean
  /**
   * Soft drop shadow opacity, 0..1.
   *
   * Preferred over an outline: the craft guidance is that thick shadows and
   * harsh strokes both look poor, and that a soft semi-transparent shadow is
   * what lifts letters off a busy background.
   */
  shadow: number
  /** Outline width as a fraction of the font size; 0 for none. */
  stroke: number
  strokeColor: string
  /**
   * A look from the style library: gradient fill, glow, outline, metallic.
   *
   * Separate from `font` on purpose — a style is a recipe and a font is a face,
   * and keeping them independent is what turns two dozen styles across fifty
   * faces into twelve hundred looks instead of twelve hundred presets. See
   * render/textStyle.ts.
   */
  styleId?: string
  /**
   * How the words arrive, from the animation library.
   *
   * Independent of the style and the font, like everything else here: any
   * animation works with any look. See render/textAnimation.ts — only the
   * moving frames are baked for the export, and the last of them is held.
   */
  animationId?: string
  /**
   * The word being spoken, for captions.
   *
   * Deliberately not part of a style: the index moves every few frames, and it
   * rides ON TOP of whatever style the line has, so a gradient caption keeps its
   * gradient and only the active word changes colour and size. `word` counts
   * from zero across the whole content; -1 highlights nothing.
   */
  highlight?: { word: number; color?: string; scale?: number }
  /**
   * Side margin as a fraction of the width, when it is not the title-safe one.
   *
   * Captions hold a wider boundary than titles do — a subtitle at the very edge
   * of a phone frame sits under the interface.
   */
  margin?: number
  /**
   * Nudge away from the anchored position, as a fraction of the canvas.
   *
   * `position` and `align` put the block somewhere sensible; these let it be
   * dragged anywhere from there. Optional so projects saved before free
   * positioning existed still open.
   */
  offsetX?: number
  offsetY?: number
  /** Bumped on every edit — the path stays the same, the bytes do not. */
  version: number
}

export interface SolidSpec {
  color: string
  /** 0..1; a translucent card is a wash over what is underneath. */
  opacity: number
  version: number
}

export const DEFAULT_TEXT: Omit<TextSpec, 'version'> = {
  content: 'YOUR TEXT',
  font: 'sans-serif',
  size: 0.1,
  // Not pure white: #fff on a bright frame clips and loses its edges. A touch
  // off it keeps the contrast without the glare.
  color: '#f5f2ec',
  align: 'center',
  position: 'center',
  weight: 700,
  tracking: 0.14,
  uppercase: true,
  shadow: 0.55,
  stroke: 0,
  strokeColor: '#000000',
  offsetX: 0,
  offsetY: 0
}

/**
 * The margin type must stay inside, as a fraction of each edge.
 *
 * SMPTE ST 2046-1 puts the title-safe area at 90% of width and height — a 5%
 * margin — and has done since 2009. Text outside it risks being cropped by a
 * player, and more immediately just looks wrong jammed against the edge.
 */
export const TITLE_SAFE = 0.05

/** One waypoint. x and y are fractions of a half-canvas, as in Transform. */
export interface PathPoint {
  frame: Frames
  x: number
  y: number
}

/**
 * Named camera moves.
 *
 * `in`/`out` are centred; `in*`/`out*` drift while zooming; `pan*` holds the
 * zoom and translates. Kept as names rather than raw numbers so a saved project
 * stays readable and the renderer owns the expressions.
 */
export type MotionMove =
  | 'in'
  | 'out'
  | 'inLeft'
  | 'inRight'
  | 'inUp'
  | 'inDown'
  | 'outLeft'
  | 'outRight'
  | 'panLeft'
  | 'panRight'
  | 'panUp'
  | 'panDown'

export type Motion =
  | { kind: 'kenburns'; direction: MotionMove; amount: number }
  /**
   * Oscillating offset at a held zoom — for impacts, not for whole shots.
   *
   * `decay` is the seconds the wobble takes to die away. A drop is an impact:
   * it should hit hard and settle. Without this the shake ran for the whole
   * shot — 2.23 seconds of continuous rattle on a rendered reel, which reads as
   * a fault rather than a hit.
   *
   * `anchor: 'subject'` shakes the world and holds the subject still, using the
   * depth planes. It reads as force applied to the scene rather than to the
   * camera.
   */
  | {
      kind: 'shake'
      amount: number
      hz?: number
      decay?: number
      anchor?: 'camera' | 'subject'
    }
  /**
   * The same move, but run on baked depth planes so near things travel faster
   * than far ones. Falls back to `kenburns` at render time when the photo has
   * no bake — see docs/PARALLAX.md.
   */
  | { kind: 'parallax'; direction: MotionMove; amount: number }

/**
 * One photograph cut into depth planes, keyed by asset id on the project.
 *
 * Per-asset rather than per-clip: two clips of the same photo share one bake,
 * and a cleared cache invalidates one map instead of N clips.
 */
export interface ParallaxBake {
  width: number
  height: number
  /** False when the photo is too flat to separate; render falls back. */
  separated: boolean
  /** Distance between the nearest and farthest plane, 0..1. */
  spread: number
  /**
   * True when the front plane is a real subject cutout rather than a depth band.
   *
   * It is what makes an anchored shake hold a person perfectly still, and it is
   * the same cutout text-behind-subject needs.
   */
  subject?: boolean
  /**
   * Where the subject is, normalised 0..1 against the photograph.
   *
   * Knowing that there IS a person is enough to hold them still in a shake.
   * Knowing WHERE they are is what lets a crop be a close-up rather than a
   * guess — framed on the middle of the picture, a close-up on a standing
   * figure lands on their waist. Absent on bakes made before it was recorded.
   */
  subjectBox?: { x: number; y: number; width: number; height: number }
  /** Ordered far to near. */
  layers: { file: string; index: number; depth: number; coverage: number }[]
}

export const MOTION_MOVES: MotionMove[] = [
  'in',
  'out',
  'inLeft',
  'inRight',
  'inUp',
  'inDown',
  'outLeft',
  'outRight',
  'panLeft',
  'panRight',
  'panUp',
  'panDown'
]

export interface Track {
  id: string
  kind: 'video' | 'audio'
  name: string
  muted: boolean
  hidden: boolean
  locked: boolean
  /**
   * Duck this track under dialogue.
   *
   * Audio tracks only. The render sidechains it against the picture's own audio,
   * so music drops while someone is speaking and recovers when they stop.
   */
  duck?: boolean
}

export interface Project {
  /**
   * This project's own identity, independent of where it is saved.
   *
   * Autosaves are keyed on it: a project saved under a new name is the same
   * work, and keying on the path instead would orphan the old autosave and
   * offer it back later as though it were a different project.
   *
   * Optional, because every project file written before it existed has none.
   * `deserializeProject` mints one on the way in, so a project in memory
   * always has one — it is the FILES that can be without.
   */
  id?: string
  name: string
  settings: ProjectSettings
  assets: MediaAsset[]
  /** Index 0 renders bottom-most; later video tracks composite on top. */
  tracks: Track[]
  clips: Clip[]
  /**
   * Transcripts keyed by asset id. They live with the project so they survive
   * save/load and so director decisions can reference their segment ids without
   * re-running ASR.
   */
  transcripts: Record<string, Transcript>
  /**
   * Depth-plane bakes keyed by asset id.
   *
   * Optional so that every project written before parallax existed still loads.
   */
  parallax?: Record<string, ParallaxBake>
  captions: CaptionSettings
}

export const DEFAULT_SETTINGS: ProjectSettings = {
  width: 1920,
  height: 1080,
  fps: 30,
  sampleRate: 48000,
  /*
   * New projects normalise; saved ones are left as they were.
   *
   * That asymmetry is the point. Two exports landing at different levels is
   * the thing being fixed, so the default has to be on — but turning it on
   * for a project someone has already finished would change how it sounds
   * with nothing to show why.
   */
  loudness: DEFAULT_LOUDNESS
}

export function framesToSeconds(frames: Frames, fps: number): number {
  return frames / fps
}

export function secondsToFrames(seconds: number, fps: number): Frames {
  return Math.round(seconds * fps)
}

/** "00:01:23:07" — hours:minutes:seconds:frames. */
export function formatTimecode(frames: Frames, fps: number): string {
  const safeFps = Math.max(1, Math.round(fps))
  const total = Math.max(0, Math.floor(frames))
  const f = total % safeFps
  const totalSeconds = Math.floor(total / safeFps)
  const s = totalSeconds % 60
  const m = Math.floor(totalSeconds / 60) % 60
  const h = Math.floor(totalSeconds / 3600)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(h)}:${pad(m)}:${pad(s)}:${pad(f)}`
}

export function clipEnd(clip: Clip): Frames {
  return clip.start + clip.duration
}

/**
 * Is this clip on screen at this frame?
 *
 * Half-open, so a clip ending at 90 and one starting at 90 never both claim
 * frame 90 — the cut belongs to the incoming clip, which is what makes butted
 * clips render as one continuous picture instead of flickering at every join.
 *
 * Worth having as a named rule rather than an inequality written out wherever
 * it is needed: the preview draws a clip by it, and its on-picture handles only
 * exist over a frame that is actually drawn. When a sticker was added away from
 * the playhead it was selected but not covered, so it had no box and nothing to
 * drag — while the Inspector's colour controls kept working, because those read
 * the selection rather than the frame. The two had to agree, and now they read
 * from the same function.
 */
export function clipCoversFrame(clip: Clip, frame: Frames): boolean {
  return frame >= clip.start && frame < clipEnd(clip)
}

export function projectDuration(project: Project): Frames {
  return project.clips.reduce((max, clip) => Math.max(max, clipEnd(clip)), 0)
}

export function clipsOnTrack(project: Project, trackId: string): Clip[] {
  return project.clips
    .filter((c) => c.trackId === trackId)
    .sort((a, b) => a.start - b.start)
}

/**
 * Tracks in the order a timeline should DISPLAY them, top row first.
 *
 * Both the renderer and the preview composite in `tracks` order, so the first
 * video track is the BOTTOM layer. Listing them in that same order put V1 at the
 * top of the screen while it sat underneath everything in the picture — a
 * sticker dropped on the track visibly above the video rendered behind it.
 *
 * Video therefore displays reversed, highest layer first, exactly as Resolve,
 * Premiere and CapCut all show it. Audio follows underneath in its own order.
 * This is presentation only: nothing about the composite changes.
 */
export function laneOrder(tracks: Track[]): Track[] {
  return [
    ...tracks.filter((t) => t.kind === 'video').reverse(),
    ...tracks.filter((t) => t.kind !== 'video')
  ]
}

/** The clip covering `frame` on a track, if any. */
export function clipAt(project: Project, trackId: string, frame: Frames): Clip | null {
  return (
    project.clips.find(
      (c) => c.trackId === trackId && frame >= c.start && frame < clipEnd(c)
    ) ?? null
  )
}

/** Every clip covering `frame`, ordered bottom track first (render order). */
export function clipsAtFrame(project: Project, frame: Frames): Clip[] {
  const trackOrder = new Map(project.tracks.map((t, i) => [t.id, i]))
  return project.clips
    .filter((c) => frame >= c.start && frame < clipEnd(c))
    .sort((a, b) => (trackOrder.get(a.trackId) ?? 0) - (trackOrder.get(b.trackId) ?? 0))
}

/**
 * Source frame the clip is showing when the playhead is at `frame`.
 *
 * Speed is part of this mapping, not a separate concern. The preview seeks with
 * this, the caption timing reads from it, and `splitClip` and `trimStart` below
 * now cut with it, so a slowed clip whose seek ignored speed would show the
 * wrong frame, say the wrong word, and split in the wrong place — drifting
 * further the deeper into the clip you went.
 *
 * It delegates rather than repeating the multiplication, because it used to
 * repeat it and the two copies had already diverged: this one took `clip.speed`
 * at face value while every render path clamps it to [MIN_SPEED, MAX_SPEED].
 * A project file carrying `speed: 100` therefore previewed one frame and
 * exported another. One formula cannot disagree with itself.
 */
export function sourceFrameFor(clip: Clip, frame: Frames): Frames {
  return sourceFrameAt(clip, frame)
}

export function assetById(project: Project, id: string): MediaAsset | null {
  return project.assets.find((a) => a.id === id) ?? null
}

/**
 * Two clips may not occupy the same frames on one track. Returns the clips that
 * `candidate` would collide with, ignoring the clip being moved.
 */
export function overlapsOn(
  project: Project,
  trackId: string,
  start: Frames,
  duration: Frames,
  ignoreClipId?: string
): Clip[] {
  const end = start + duration
  return project.clips.filter(
    (c) =>
      c.trackId === trackId &&
      c.id !== ignoreClipId &&
      start < clipEnd(c) &&
      end > c.start
  )
}

/** First frame >= `desired` where the clip fits on the track without overlapping. */
export function findFreeSlot(
  project: Project,
  trackId: string,
  desired: Frames,
  duration: Frames,
  ignoreClipId?: string
): Frames {
  let start = Math.max(0, desired)
  // Walk past each collision; tracks hold few enough clips that this is fine.
  for (let guard = 0; guard < 10000; guard++) {
    const hits = overlapsOn(project, trackId, start, duration, ignoreClipId)
    if (hits.length === 0) return start
    start = Math.max(...hits.map(clipEnd))
  }
  return start
}

/**
 * Where an overlay should land: the same moment, one track higher.
 *
 * `findFreeSlot` slides a clip LATER until it fits, which is right for a cut —
 * two shots on one track are a sequence. It is wrong for anything that is meant
 * to sit ON something: a second line of text, a sticker over a face, a colour
 * wash. Reported as "it adds on the side of it of the same track, but the actual
 * layers work different, its on top of each other be it any N layers", which is
 * exactly the distinction.
 *
 * So this climbs instead. The asked-for track first, then each video track above
 * it in compositing order, and null when they are all busy — which the caller
 * answers by making a new one. The time never moves: an overlay dropped at a
 * moment belongs at that moment.
 */
export function stackedSlot(
  project: Project,
  trackId: string,
  desired: Frames,
  duration: Frames
): { trackId: string; start: Frames } | null {
  const start = Math.max(0, desired)
  const from = project.tracks.find((t) => t.id === trackId)
  if (!from) return null

  // Within the track's own kind: pictures stack for compositing order, sounds
  // stack because two pieces of music at once is a mix, not a queue.
  const lanes = project.tracks.filter((t) => t.kind === from.kind)
  const at = lanes.findIndex((t) => t.id === trackId)
  if (at < 0) return null

  for (let i = at; i < lanes.length; i++) {
    const track = lanes[i]
    if (track.locked) continue
    if (overlapsOn(project, track.id, start, duration).length === 0) {
      return { trackId: track.id, start }
    }
  }
  return null
}

/** True when the project cannot hold another track. */
export function trackLimitReached(project: Project): boolean {
  return project.tracks.length >= MAX_TRACKS
}

/**
 * Split a clip at an absolute timeline frame.
 * Returns the two halves, or null when the frame is not strictly inside the clip.
 */
export function splitClip(clip: Clip, frame: Frames): [Clip, Clip] | null {
  if (frame <= clip.start || frame >= clipEnd(clip)) return null
  const leftDuration = frame - clip.start
  const left: Clip = { ...clip, duration: leftDuration }
  const right: Clip = {
    ...clip,
    id: `${clip.id}-b`,
    start: frame,
    duration: clip.duration - leftDuration,
    /*
     * The right half opens on the frame the playhead was showing — which is
     * the definition of an invisible cut, and at 2× is two source frames per
     * timeline frame, not one.
     *
     * This was `inPoint + leftDuration`, which is the same number only at
     * speed 1. Split a 2× clip two seconds in and the right half replayed the
     * second second; at 0.5× it skipped one. Both halves then rendered the
     * wrong footage, silently, from a gesture whose whole promise is that
     * nothing moves.
     */
    inPoint: sourceFrameFor(clip, frame)
  }
  return [left, right]
}

/**
 * Drag the left edge. The clip's content stays put on the timeline: moving the
 * head in also moves the source in-point, so the visible frames do not slide.
 */
export function trimStart(clip: Clip, newStart: Frames): Clip {
  const rate = clipSpeed(clip)
  const maxStart = clipEnd(clip) - 1
  const delta = Math.min(newStart, maxStart) - clip.start
  /*
   * Cannot pull the head earlier than the start of the source media — and at
   * 2× the footage before `inPoint` buys only half as many timeline frames of
   * reach, because each one of them eats two source frames.
   *
   * Floored, so the head lands on a frame. Flooring the reach can only ever
   * stop short, never overshoot: `floor(inPoint / rate) × rate ≤ inPoint`, and
   * rounding an integer-bounded value cannot cross the integer, so the new
   * in-point is never negative.
   */
  const limited = Math.max(delta, -Math.floor(clip.inPoint / rate))
  return {
    ...clip,
    start: clip.start + limited,
    duration: clip.duration - limited,
    inPoint: clip.inPoint + Math.round(limited * rate)
  }
}

/** Drag the right edge. Cannot run past the end of the source media. */
export function trimEnd(clip: Clip, newEnd: Frames, sourceDuration: Frames): Clip {
  const minEnd = clip.start + 1
  /*
   * At 2× the tail runs out of footage twice as fast, so the ceiling is the
   * source that is left divided by the rate — which is exactly
   * `maxDurationAtSpeed`, rather than a second copy of it here.
   *
   * It is handed a video-shaped asset because the caller has already decided
   * there is a real source length to respect: the image branch returns
   * "as long as you like" and would throw the caller's own limit away.
   */
  const room = maxDurationAtSpeed(
    clip,
    { kind: 'video', durationFrames: sourceDuration },
    clipSpeed(clip)
  )
  const end = Math.max(minEnd, Math.min(newEnd, clip.start + room))
  return { ...clip, duration: end - clip.start }
}

/** Beyond this the timeline stops being readable and ffmpeg graphs get slow. */
export const MAX_TRACKS = 12

/** Next free name for a kind: V1, V2, V3... */
export function nextTrackName(tracks: Track[], kind: Track['kind']): string {
  const prefix = kind === 'video' ? 'V' : 'A'
  const used = tracks.filter((t) => t.kind === kind).length
  return `${prefix}${used + 1}`
}

/**
 * Insert a track, keeping video tracks above audio in the array.
 * Render order depends on this ordering, so it is not cosmetic.
 */
/**
 * `where` decides which END of the stack it joins.
 *
 * Index 0 is the BOTTOM layer, so appending makes a track that composites over
 * everything. That is right for an overlay and exactly wrong for a backdrop,
 * which has to sit under the shot it is behind — a blurred copy drawn on top
 * hides the very thing it was meant to set off.
 */
export function addTrack(
  project: Project,
  kind: Track['kind'],
  where: 'top' | 'bottom' = 'top'
): Project {
  if (project.tracks.length >= MAX_TRACKS) return project

  const track: Track = {
    /*
     * A random suffix, like every clip id.
     *
     * This was a bare millisecond timestamp, which was fine while the only way
     * to make a track was clicking `+ Video`. Overlays now add one themselves
     * when every layer is busy, and several can be added inside a single tick —
     * at which point two tracks share an id, and clips land on whichever the
     * lookup happens to find first.
     */
    id: `${kind === 'video' ? 'v' : 'a'}${Date.now().toString(36)}${Math.random()
      .toString(36)
      .slice(2, 6)}`,
    kind,
    name: nextTrackName(project.tracks, kind),
    muted: false,
    hidden: false,
    locked: false
  }

  const video = project.tracks.filter((t) => t.kind === 'video')
  const audio = project.tracks.filter((t) => t.kind === 'audio')
  return {
    ...project,
    tracks:
      kind === 'video'
        ? where === 'bottom'
          ? [track, ...video, ...audio]
          : [...video, track, ...audio]
        : where === 'bottom'
          ? [...video, track, ...audio]
          : [...video, ...audio, track]
  }
}

/** Removing a track removes its clips; there is nowhere for them to go. */
export function removeTrack(project: Project, trackId: string): Project {
  const remaining = project.tracks.filter((t) => t.id !== trackId)
  if (remaining.length === project.tracks.length) return project
  // Never leave a project with no video track — the renderer requires one.
  if (!remaining.some((t) => t.kind === 'video')) return project
  return {
    ...project,
    tracks: remaining,
    clips: project.clips.filter((c) => c.trackId !== trackId)
  }
}

/** Longest transition that still leaves a frame of each clip un-blended. */
export function maxTransitionFrames(previous: Clip | null, next: Clip): Frames {
  /*
   * A layered clip has no previous clip to borrow frames from.
   *
   * It blends against whatever is already on the canvas underneath it, and that
   * layer runs its own length regardless — so the only limit is how long this
   * clip is on screen. Treating a missing previous clip as "no room" is what
   * made a slow grid reveal over a photograph impossible to set.
   */
  if (!previous) return Math.max(0, next.duration - 1)
  return Math.max(0, Math.min(previous.duration - 1, next.duration - 1))
}

/**
 * What a transition on this clip blends in FROM.
 *
 * Two different things can be underneath. The ordinary case is the clip before
 * it on the same track — an edit point, where a dissolve eats into both. The
 * other is a layer: a clip on a lower track that is on screen at the same time,
 * which is how a grid reveal of one photograph over another is built.
 *
 * Returning null means there is genuinely nothing underneath and a transition
 * would blend in from black.
 */
export function transitionBase(
  project: Project,
  clip: Clip
): { clip: Clip; kind: 'cut' | 'layer' } | null {
  const previous = clipBefore(project, clip)
  if (previous) return { clip: previous, kind: 'cut' }

  const trackIndex = project.tracks.findIndex((t) => t.id === clip.trackId)
  if (trackIndex < 0) return null

  // Lower index composites first, so those are the layers beneath this one.
  for (let i = trackIndex - 1; i >= 0; i--) {
    const track = project.tracks[i]
    if (track.kind !== 'video' || track.hidden) continue
    const under = clipsOnTrack(project, track.id).find(
      (c) => c.start < clipEnd(clip) && clipEnd(c) > clip.start
    )
    if (under) return { clip: under, kind: 'layer' }
  }
  return null
}

/**
 * Attach a transition to a clip, creating the overlap it needs.
 *
 * The clip and everything after it on the track move earlier by the transition
 * length, so the timeline shortens — which is what actually happens in an edit:
 * a dissolve consumes time from both sides rather than adding any.
 */
export function addTransition(
  project: Project,
  clipId: string,
  transitionId: string,
  durationFrames: Frames
): Project {
  const clip = project.clips.find((c) => c.id === clipId)
  if (!clip) return project

  const onTrack = clipsOnTrack(project, clip.trackId)
  const index = onTrack.findIndex((c) => c.id === clipId)
  const previous = index > 0 ? onTrack[index - 1] : null

  const already = clip.transitionIn?.durationFrames ?? 0
  const frames = Math.max(1, Math.min(durationFrames, maxTransitionFrames(previous, clip)))

  /*
   * A layered clip has nothing before it on its own track, and does not need
   * anything: it blends against whatever is composited underneath, which runs
   * its own length regardless. So nothing overlaps and nothing shifts — the
   * clip simply gains a transition where it already sits.
   *
   * This used to `return project` unchanged. The panel offered the transition,
   * the click did nothing, and no error was raised anywhere — which read as the
   * whole transition feature being broken for text.
   */
  if (!previous) {
    if (clip.transitionIn?.id === transitionId && already === frames) return project
    return {
      ...project,
      clips: project.clips.map((c) =>
        c.id === clipId ? { ...c, transitionIn: { id: transitionId, durationFrames: frames } } : c
      )
    }
  }
  // Shift by the delta so changing an existing transition does not stack.
  const shift = frames - already
  if (frames === already && clip.transitionIn?.id === transitionId) return project

  return {
    ...project,
    clips: project.clips.map((c) => {
      if (c.trackId !== clip.trackId) return c
      if (c.id === clipId) {
        return {
          ...c,
          start: Math.max(0, c.start - shift),
          transitionIn: { id: transitionId, durationFrames: frames }
        }
      }
      // Everything later on the track moves with it.
      return c.start > clip.start ? { ...c, start: Math.max(0, c.start - shift) } : c
    })
  }
}

/**
 * A transition that moves nothing.
 *
 * `addTransition` closes the timeline up around the overlap: the incoming clip
 * slides back to meet the outgoing one, and everything after it follows. That
 * is right for a hand-cut timeline, where a transition consumes time and the
 * rest of the edit closes up behind it.
 *
 * It is wrong for anything cut to music, and quietly so. Every shot in a reel
 * has a start that was computed against a beat, a drop or a sung word — and
 * rippling drags all of them off it, by more and more as the reel goes on. With
 * a majority of cuts carrying a treatment at seven frames each, a thirty-shot
 * reel finishes nearly four seconds adrift of the track it was cut to. Nothing
 * reports it, because each individual transition is doing exactly what it says.
 *
 * So the overlap is taken from the OUTGOING clip's tail instead: the previous
 * clip plays a few frames longer and the incoming one stays exactly where the
 * music put it. The two clips overlap by the same amount over the same frames
 * of the incoming clip, so the renderer sees no difference at all — the
 * transition simply begins on the beat rather than finishing near it.
 */
export function anchorTransition(
  project: Project,
  clipId: string,
  transitionId: string,
  durationFrames: Frames
): Project {
  const clip = project.clips.find((c) => c.id === clipId)
  if (!clip) return project

  const onTrack = clipsOnTrack(project, clip.trackId)
  const index = onTrack.findIndex((c) => c.id === clipId)
  const previous = index > 0 ? onTrack[index - 1] : null

  const frames = Math.max(1, Math.min(durationFrames, maxTransitionFrames(previous, clip)))
  if (clip.transitionIn?.id === transitionId && clip.transitionIn.durationFrames === frames) {
    return project
  }

  // Layered: nothing to borrow from and nothing to lengthen — it blends against
  // whatever is composited underneath, which runs its own length regardless.
  const already = clip.transitionIn?.durationFrames ?? 0
  const grow = previous ? frames - already : 0

  return {
    ...project,
    clips: project.clips.map((c) => {
      if (c.id === clipId) {
        return { ...c, transitionIn: { id: transitionId, durationFrames: frames } }
      }
      if (previous && c.id === previous.id) {
        return { ...c, duration: Math.max(1, c.duration + grow) }
      }
      return c
    })
  }
}

/** Remove a transition and restore the time it consumed. */
export function removeTransition(project: Project, clipId: string): Project {
  const clip = project.clips.find((c) => c.id === clipId)
  if (!clip?.transitionIn) return project

  // A layered transition consumed no time, so removing it must give none back.
  const onTrack = clipsOnTrack(project, clip.trackId)
  if (onTrack.findIndex((c) => c.id === clipId) === 0) {
    return {
      ...project,
      clips: project.clips.map((c) => {
        if (c.id !== clipId) return c
        const { transitionIn: _removed, ...rest } = c
        return rest
      })
    }
  }

  const shift = clip.transitionIn.durationFrames

  return {
    ...project,
    clips: project.clips.map((c) => {
      if (c.trackId !== clip.trackId) return c
      if (c.id === clipId) {
        const { transitionIn: _removed, ...rest } = c
        return { ...rest, start: c.start + shift }
      }
      return c.start > clip.start ? { ...c, start: c.start + shift } : c
    })
  }
}

/**
 * The clip whose incoming edge is nearest a frame, for dropping a transition.
 *
 * "Between two clips" is ambiguous by a pixel: landing just left of a boundary
 * targets the outgoing clip, just right targets the incoming one. Snapping to
 * the nearest cut — and only cuts that can actually take a transition — makes
 * the gesture mean what it looks like.
 */
export function nearestTransitionTarget(
  project: Project,
  trackId: string,
  frame: Frames,
  toleranceFrames: number
): { clip: Clip; reason?: undefined } | { clip: null; reason: string } {
  const onTrack = clipsOnTrack(project, trackId)
  if (onTrack.length === 0) return { clip: null, reason: 'There are no clips on this track' }

  // Cuts are the starts of every clip that has something before it.
  const cuts = onTrack.slice(1)
  if (cuts.length === 0) {
    return {
      clip: null,
      reason: 'A transition needs a clip before it — this track has only one clip'
    }
  }

  let best: Clip | null = null
  let bestDistance = Infinity
  for (const candidate of cuts) {
    const distance = Math.abs(candidate.start - frame)
    if (distance < bestDistance) {
      bestDistance = distance
      best = candidate
    }
  }

  if (best && bestDistance <= toleranceFrames) return { clip: best }

  // Nothing close enough: fall back to whatever sits under the cursor, so a
  // deliberate drop onto a clip body still works.
  const under = onTrack.find((c) => frame >= c.start && frame < clipEnd(c))
  if (under && cuts.some((c) => c.id === under.id)) return { clip: under }
  if (under) {
    return {
      clip: null,
      reason: 'This is the first clip on its track, so there is nothing to transition from'
    }
  }
  return { clip: null, reason: 'Drop a transition on or near a cut between two clips' }
}

/**
 * How many frames two clips on the same track share. Zero when they do not.
 *
 * Lives here rather than beside the fades that use it so the dependency runs
 * one way: `render/audioFade.ts` reaches into the timeline for geometry, and
 * the timeline never reaches back into the renderer.
 */
export function overlapFrames(
  outgoing: Pick<Clip, 'start' | 'duration'>,
  incoming: Pick<Clip, 'start' | 'duration'>
): Frames {
  const end = outgoing.start + outgoing.duration
  return Math.max(0, Math.min(end, incoming.start + incoming.duration) - incoming.start)
}

/**
 * Slide a clip back onto the one before it, so their sound crosses over.
 *
 * The overlap IS the crossfade — `fadesWithNeighbours` derives an equal-power
 * pair from it at render, and the explicit fades written here make it visible
 * on the clip and adjustable by its grips afterwards.
 *
 * The overlap is taken by moving the INCOMING clip back, not by lengthening
 * the outgoing one. That matters: lengthening a clip needs source material
 * past its out point, and a music clip trimmed to the end of the file has
 * none — the "extra" would be silence, so the outgoing half would cross-fade
 * into nothing and the join would gap instead of blending. Moving the incoming
 * clip back uses frames both clips already have.
 *
 * Everything later on the track follows, which closes the timeline up around
 * the join. That is the opposite of `anchorTransition`'s choice, and
 * deliberately: a crossfade is a statement about two pieces of MUSIC meeting,
 * and the thing that must not move is the join, not the grid. A reel cut to
 * beats uses `anchorTransition`; a DJ dropping one track over another uses
 * this.
 */
export function crossfadeAt(project: Project, clipId: string, durationFrames: Frames): Project {
  const clip = project.clips.find((c) => c.id === clipId)
  if (!clip) return project
  const previous = clipBefore(project, clip)
  if (!previous) return project

  // Already overlapping: change the overlap by the difference rather than
  // stacking a second one on top of the first.
  const already = overlapFrames(previous, clip)
  const room = Math.max(0, Math.min(previous.duration - 1, clip.duration - 1))
  const frames = Math.max(1, Math.min(Math.round(durationFrames), room))
  const shift = frames - already
  if (shift === 0 && clip.fadeIn === frames && previous.fadeOut === frames) return project

  return {
    ...project,
    clips: project.clips.map((c) => {
      if (c.trackId !== clip.trackId) {
        return c
      }
      if (c.id === previous.id) {
        return { ...c, fadeOut: frames }
      }
      if (c.id === clipId) {
        return { ...c, start: Math.max(0, c.start - shift), fadeIn: frames }
      }
      return c.start > clip.start ? { ...c, start: Math.max(0, c.start - shift) } : c
    })
  }
}

/** How much of a crossfade this clip could take with the one before it. */
export function maxCrossfadeFrames(project: Project, clip: Clip): Frames {
  const previous = clipBefore(project, clip)
  if (!previous) return 0
  return Math.max(0, Math.min(previous.duration - 1, clip.duration - 1))
}

/** The clip a transition blends from, if any. */
export function clipBefore(project: Project, clip: Clip): Clip | null {
  const onTrack = clipsOnTrack(project, clip.trackId)
  const index = onTrack.findIndex((c) => c.id === clip.id)
  return index > 0 ? onTrack[index - 1] : null
}

/** A fresh project id, in the shape everything else here makes them. */
export function newProjectId(): string {
  return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export function emptyProject(name = 'Untitled'): Project {
  return {
    id: newProjectId(),
    name,
    settings: { ...DEFAULT_SETTINGS },
    assets: [],
    // Two of each by default: enough to show that layering exists without
    // presenting an empty stack of tracks nobody asked for.
    tracks: [
      { id: 'v1', kind: 'video', name: 'V1', muted: false, hidden: false, locked: false },
      { id: 'v2', kind: 'video', name: 'V2', muted: false, hidden: false, locked: false },
      { id: 'a1', kind: 'audio', name: 'A1', muted: false, hidden: false, locked: false },
      { id: 'a2', kind: 'audio', name: 'A2', muted: false, hidden: false, locked: false }
    ],
    clips: [],
    transcripts: {},
    captions: { enabled: true, styleId: 'pop' }
  }
}

import type { CropRect } from '../timeline'

/**
 * Turn one photograph into several shots.
 *
 * A still has no time in it, so a reel built from a single image has to
 * manufacture every change. The oldest and strongest technique is the one
 * documentary editors have used on archive stills for decades: treat the
 * photograph as a set of shots rather than one picture. Wide establishing,
 * medium, close on the face, a detail. Each crop cuts on a bar and reads as a
 * new angle on the same moment.
 *
 * Two rules keep it from looking broken, both borrowed from how coverage is
 * actually shot and cut:
 *
 *  - Shot sizes are proportions of the FIGURE, not of the frame. A medium is
 *    waist-up, a close-up is head and shoulders. Cropping to a fraction of the
 *    picture instead lands the frame on whatever happens to be there.
 *  - Consecutive framings must differ enough in scale to read as a cut rather
 *    than a twitch.
 *
 * Rects are in SOURCE PIXELS, matching CropRect and the renderer's crop filter,
 * which runs before the camera move — so a framing crop and a Ken Burns move
 * compose: the move happens inside the chosen frame.
 */

/**
 * Minimum scale ratio between consecutive framings.
 *
 * Under this the cut reads as a jump rather than a new shot.
 */
export const MIN_CUT_SCALE_RATIO = 1.4

/**
 * How far a crop may be enlarged to fill the canvas.
 *
 * Some upscaling is fine and even flattering on a close-up; past this it is
 * visibly soft. This is what stops the ladder promising shots the photograph
 * does not have the pixels for.
 */
export const MAX_UPSCALE = 1.6

/** Fallback floor when the output size is unknown. */
export const MIN_CROP_FRACTION = 0.22

/**
 * Shot sizes as fractions of a standing figure's height.
 *
 * From ordinary coverage practice: medium is waist-up, close is head and
 * shoulders, detail is the face.
 */
const SHOT_HEIGHT = { medium: 0.55, close: 0.28, detail: 0.14 } as const

/**
 * Where the head sits inside a figure, top-down.
 *
 * The classic eight-heads canon puts the centre of the head about a sixteenth
 * of the way down. Framing a close-up on the middle of the subject box instead
 * lands it on the waist, which is the most recognisable sign that nothing
 * looked at the picture.
 */
const HEAD_AT = 0.08

/**
 * Overlap above which two framings show the same thing.
 *
 * The size rule is really about whether the frame changed enough to read as a
 * cut, and scale is only one way to change it. A crop of the same size on a
 * different part of the picture shows different content, which is a cut by any
 * measure — and it is the only coverage available when a wide landscape photo
 * is cropped to a vertical reel, where there is almost no room to punch in.
 */
export const MAX_CUT_OVERLAP = 0.5

export type FramingLabel = 'wide' | 'medium' | 'close' | 'detail' | 'aside'

export interface Framing {
  rect: CropRect
  label: FramingLabel
  /** Magnification against the full frame. 1 = the whole photograph. */
  scale: number
}

export interface Source {
  width: number
  height: number
}

export interface LadderOptions {
  /** Canvas height, so the ladder knows how far it may enlarge a crop. */
  outputHeight?: number
  maxUpscale?: number
}

/**
 * Build the ladder, loosest first.
 *
 * With a subject box the crops are about the person. Without one every crop is
 * a guess, so the fallback sits slightly above centre — where faces are in most
 * photographs — and never goes as tight.
 *
 * Rungs that collapse into one another are dropped rather than offered: on a
 * low-resolution photo, or one where the subject already fills the frame, there
 * genuinely are fewer shots available and pretending otherwise puts two
 * identical framings next to each other.
 */
export function framingLadder(
  source: Source,
  aspectRatio: number,
  subject: CropRect | null,
  options: LadderOptions = {}
): Framing[] {
  const floor = minCropHeight(source, options)
  const fit = (cx: number, cy: number, h: number): CropRect =>
    fitRect(cx, cy, h, aspectRatio, source, floor)

  /*
   * The wide is framed on the subject, not on the middle of the photograph.
   *
   * A vertical reel crops a landscape photo to a third of its width. Centring
   * that on the picture rather than on the person can leave the person outside
   * the frame entirely — an establishing shot of their left shoulder.
   */
  const wideX = subject && subject.width > 0 ? subject.x + subject.width / 2 : source.width / 2
  const wide = fit(wideX, source.height / 2, source.height)
  const ladder: Framing[] = [{ rect: wide, label: 'wide', scale: 1 }]
  const add = (label: FramingLabel, rect: CropRect): void => {
    const scale = wide.height / rect.height
    const candidate: Framing = { rect, label, scale }
    // Same size AND looking at the same thing is the same shot.
    if (ladder.some((f) => sameScale(f, candidate) && overlap(f.rect, rect) > MAX_CUT_OVERLAP)) return
    ladder.push(candidate)
  }

  if (subject && subject.width > 0 && subject.height > 0) {
    const cx = subject.x + subject.width / 2
    const headY = subject.y + subject.height * HEAD_AT
    const figure = subject.height

    add('medium', fit(cx, subject.y + figure * 0.3, figure * SHOT_HEIGHT.medium))
    add('close', fit(cx, headY + figure * 0.04, figure * SHOT_HEIGHT.close))
    add('detail', fit(cx, headY, figure * SHOT_HEIGHT.detail))

    /*
     * The shot that looks away.
     *
     * A wide landscape photograph cropped to a vertical reel has almost no room
     * to punch in, so the coverage has to come from moving across the picture
     * instead. Framed on whichever side has more of the photograph left, it
     * plays as the establishing shot the subject then cuts into.
     */
    const asideX = cx < source.width / 2 ? source.width - wide.width / 2 : wide.width / 2
    add('aside', fit(asideX, source.height / 2, source.height))
  } else {
    const cx = source.width / 2
    const cy = source.height * 0.42
    add('medium', fit(cx, cy, source.height * 0.62))
    add('close', fit(cx, cy, source.height * 0.4))
    add('detail', fit(cx, cy, source.height * 0.26))
  }

  return ladder
}

function sameScale(a: Framing, b: Framing): boolean {
  return Math.max(a.scale, b.scale) / Math.min(a.scale, b.scale) < 1.02
}

/** Intersection over union of two source rects, 0..1. */
export function overlap(a: CropRect, b: CropRect): number {
  const w = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
  const h = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))
  const intersection = w * h
  const union = a.width * a.height + b.width * b.height - intersection
  return union > 0 ? intersection / union : 0
}

/**
 * Does cutting from `a` to `b` read as a new shot?
 *
 * Either the size changed enough, or the frame is looking somewhere else.
 */
export function readsAsCut(a: Framing, b: Framing): boolean {
  return ratioBetween(a, b) >= MIN_CUT_SCALE_RATIO || overlap(a.rect, b.rect) <= MAX_CUT_OVERLAP
}

/**
 * The tightest crop this photograph can support.
 *
 * Driven by the output size when we know it — the question is how much the crop
 * gets enlarged, which a fraction of the source cannot answer.
 */
export function minCropHeight(source: Source, options: LadderOptions = {}): number {
  const { outputHeight, maxUpscale = MAX_UPSCALE } = options
  const floor = outputHeight ? outputHeight / maxUpscale : source.height * MIN_CROP_FRACTION
  return Math.min(floor, source.height)
}

/**
 * An aspect-correct rect of the requested height, centred where asked and
 * pushed back inside the source rather than clipped — a crop that runs off the
 * edge renders as black bars.
 */
export function fitRect(
  centreX: number,
  centreY: number,
  height: number,
  aspectRatio: number,
  source: Source,
  floor = source.height * MIN_CROP_FRACTION
): CropRect {
  const maxHeight = Math.min(source.height, source.width / aspectRatio)
  const clampedH = Math.min(Math.max(height, Math.min(floor, maxHeight)), maxHeight)
  const w = clampedH * aspectRatio

  return {
    x: Math.round(clamp(centreX - w / 2, 0, source.width - w)),
    y: Math.round(clamp(centreY - clampedH / 2, 0, source.height - clampedH)),
    width: Math.round(w),
    height: Math.round(clampedH)
  }
}

/**
 * Walk the ladder into a sequence of `count` framings.
 *
 * Not in ladder order: a monotonic creep from wide to tight and back reads as a
 * slideshow. Interleaving the loose and tight halves gives the big-then-small
 * alternation that cutting coverage actually produces, and it is deterministic,
 * so rebuilding does not reshuffle shots the user has already watched.
 */
export function chooseFramings(ladder: Framing[], count: number): Framing[] {
  if (ladder.length === 0 || count <= 0) return []
  if (ladder.length === 1) return Array.from({ length: count }, () => ladder[0])

  const order = interleave(ladder.length)
  const out: Framing[] = []
  let cursor = 0
  let previous: Framing | null = null

  for (let i = 0; i < count; i++) {
    let chosen: Framing | null = null
    let best: Framing | null = null
    let bestScore = -1

    // Walk forward from where we are, taking the first framing that is a real
    // cut away from the last one.
    for (let attempt = 0; attempt < order.length; attempt++) {
      const candidate = ladder[order[(cursor + attempt) % order.length]]
      if (!previous || readsAsCut(previous, candidate)) {
        chosen = candidate
        cursor = (cursor + attempt + 1) % order.length
        break
      }
      // How different it is, on whichever axis differs most.
      const score = Math.max(ratioBetween(previous, candidate), 1 / (overlap(previous.rect, candidate.rect) + 0.01))
      if (score > bestScore) {
        bestScore = score
        best = candidate
      }
    }

    // Nothing clears the bar — this photograph simply does not have two
    // distinct shots in it. Take the biggest jump available.
    if (!chosen) {
      chosen = best ?? ladder[0]
      cursor = (cursor + 1) % order.length
    }
    out.push(chosen)
    previous = chosen
  }
  return out
}

/** [0, 1, 2, 3] becomes [0, 2, 1, 3]: loose, tight, loose, tight. */
function interleave(length: number): number[] {
  const half = Math.ceil(length / 2)
  const out: number[] = []
  for (let i = 0; i < half; i++) {
    out.push(i)
    if (i + half < length) out.push(i + half)
  }
  return out
}

export function ratioBetween(a: Framing, b: Framing): number {
  const hi = Math.max(a.scale, b.scale)
  const lo = Math.min(a.scale, b.scale)
  return lo > 0 ? hi / lo : 0
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min
  return Math.min(max, Math.max(min, value))
}

/**
 * Text animation.
 *
 * Every trending caption is a still frame of something moving. That is the gap
 * between type that merely looks good and type that stops a scroll: words
 * arriving one at a time, a line springing up on the beat, a highlight walking
 * along the sentence. A static style cannot imitate it, however well drawn.
 *
 * The model is deliberately small. An animation says, for one piece of a line
 * at one moment, how it is displaced, how big it is, and how visible:
 *
 *   (progress, index, count) -> { dx, dy, scale, alpha }
 *
 * Everything else — which pieces, where they sit, what they are painted with —
 * is already decided by the layout and the style. That keeps animations
 * independent of both: any animation works with any style, with any font, the
 * same way any style works with any font.
 *
 * Pieces are WORDS or CHARACTERS. Words are what most captions animate and are
 * far cheaper; characters are for a wave or a bounce, where the whole effect is
 * letters moving against each other.
 */

export type Scope = 'word' | 'char' | 'block'

/** How one piece is displaced at one moment. Offsets are fractions of the font size. */
export interface Step {
  dx: number
  dy: number
  scale: number
  alpha: number
}

export const STILL: Step = { dx: 0, dy: 0, scale: 1, alpha: 1 }

export interface TextAnimation {
  id: string
  name: string
  description: string
  scope: Scope
  /**
   * How long the whole move takes, in seconds, before any stagger.
   *
   * Short on purpose. A caption that takes a second to arrive has already lost
   * the viewer it was supposed to catch.
   */
  seconds: number
  /**
   * How far apart consecutive pieces start, as a fraction of `seconds`.
   *
   * 0 moves everything together; 0.5 is a pronounced cascade. This is the dial
   * that turns one animation into a family of them.
   */
  stagger: number
  /** Where a piece is at a given moment. `t` is 0..1 for that piece. */
  at: (t: number) => Step
}

/* ------------------------------------------------------------------- easing */

/** Decelerating — the default for anything arriving. */
function easeOut(t: number): number {
  return 1 - Math.pow(1 - t, 3)
}

/**
 * Overshoot and settle.
 *
 * The difference between "appears" and "pops". Without the overshoot a scale-in
 * reads as a zoom; with it, it reads as something landing.
 */
function backOut(t: number, amount = 1.7): number {
  const c = amount + 1
  return 1 + c * Math.pow(t - 1, 3) + amount * Math.pow(t - 1, 2)
}

/** A decaying bounce, as something settling onto a surface. */
function bounceOut(t: number): number {
  if (t < 1 / 2.75) return 7.5625 * t * t
  if (t < 2 / 2.75) return 7.5625 * (t -= 1.5 / 2.75) * t + 0.75
  if (t < 2.5 / 2.75) return 7.5625 * (t -= 2.25 / 2.75) * t + 0.9375
  return 7.5625 * (t -= 2.625 / 2.75) * t + 0.984375
}

/* --------------------------------------------------------------- animations */

export const TEXT_ANIMATIONS: TextAnimation[] = [
  {
    id: 'fade',
    name: 'Fade',
    description: 'The whole line fades up. Quiet, and never wrong.',
    scope: 'block',
    seconds: 0.35,
    stagger: 0,
    at: (t) => ({ ...STILL, alpha: easeOut(t) })
  },
  {
    id: 'rise',
    name: 'Rise',
    description: 'Words lift into place one after another.',
    scope: 'word',
    seconds: 0.42,
    stagger: 0.35,
    at: (t) => ({ dx: 0, dy: (1 - easeOut(t)) * 0.5, scale: 1, alpha: Math.min(1, t * 2) })
  },
  {
    id: 'pop',
    name: 'Pop',
    description: 'Each word springs in past its size and settles. The reel default.',
    scope: 'word',
    seconds: 0.36,
    stagger: 0.32,
    at: (t) => ({ dx: 0, dy: 0, scale: 0.4 + backOut(t) * 0.6, alpha: Math.min(1, t * 3) })
  },
  {
    id: 'typewriter',
    name: 'Typewriter',
    description: 'Words appear in turn, nothing moves. Reads as speech.',
    scope: 'word',
    seconds: 0.05,
    stagger: 1,
    // A hard cut per word: anything softer stops looking like typing.
    at: (t) => ({ ...STILL, alpha: t > 0 ? 1 : 0 })
  },
  {
    id: 'bounce',
    name: 'Bounce',
    description: 'Letters drop in and settle. Playful and loud.',
    scope: 'char',
    seconds: 0.5,
    stagger: 0.5,
    at: (t) => ({ dx: 0, dy: -(1 - bounceOut(t)) * 0.8, scale: 1, alpha: Math.min(1, t * 4) })
  },
  {
    id: 'wave',
    name: 'Wave',
    description: 'Letters roll in from the side, one by one.',
    scope: 'char',
    seconds: 0.4,
    stagger: 0.6,
    at: (t) => ({ dx: (1 - easeOut(t)) * 0.35, dy: 0, scale: 1, alpha: Math.min(1, t * 2.5) })
  },
  {
    id: 'zoom-out',
    name: 'Zoom out',
    description: 'The line arrives oversized and shrinks to fit. Impact.',
    scope: 'block',
    seconds: 0.3,
    stagger: 0,
    at: (t) => ({ dx: 0, dy: 0, scale: 1 + (1 - easeOut(t)) * 0.6, alpha: Math.min(1, t * 3) })
  },
  {
    id: 'slide',
    name: 'Slide',
    description: 'The whole line slides in from the left.',
    scope: 'block',
    seconds: 0.38,
    stagger: 0,
    at: (t) => ({ dx: -(1 - easeOut(t)) * 1.2, dy: 0, scale: 1, alpha: Math.min(1, t * 2) })
  },
  {
    id: 'drop',
    name: 'Drop',
    description: 'Words fall from above and land in order.',
    scope: 'word',
    seconds: 0.4,
    stagger: 0.3,
    at: (t) => ({ dx: 0, dy: -(1 - bounceOut(t)) * 0.9, scale: 1, alpha: Math.min(1, t * 3) })
  }
]

export function textAnimationById(id: string | undefined): TextAnimation | null {
  if (!id) return null
  return TEXT_ANIMATIONS.find((a) => a.id === id) ?? null
}

/**
 * Where a piece is, at a frame.
 *
 * `frame` counts from the clip's first frame. The stagger spreads the starts
 * across the pieces, so the LAST piece finishes at
 * `seconds * (1 + stagger * (count - 1) / count)` — which `animationFrames`
 * rounds up, and which is exactly how many frames the export has to bake.
 */
export function stepAt(
  animation: TextAnimation,
  frame: number,
  fps: number,
  index: number,
  count: number
): Step {
  const seconds = Math.max(0.01, animation.seconds)
  const offset = count > 1 ? (index / (count - 1)) * animation.stagger * seconds : 0
  const t = (frame / Math.max(1, fps) - offset) / seconds
  if (t <= 0) return animation.at(0)
  if (t >= 1) return STILL
  return animation.at(t)
}

/**
 * How many frames actually move.
 *
 * The whole reason the export stays affordable: only these are drawn and
 * written, and the last of them is held for the rest of the clip with `tpad`.
 * A three-second caption with a third of a second of movement costs ten frames,
 * not ninety.
 */
export function animationFrames(animation: TextAnimation, fps: number, pieces: number): number {
  const spread = pieces > 1 ? animation.stagger * animation.seconds : 0
  return Math.max(1, Math.ceil((animation.seconds + spread) * fps) + 1)
}

/**
 * The furthest an animation ever throws a piece from where it settles.
 *
 * Needed to know how much of the frame a caption can touch while it is arriving,
 * which decides how tall a strip has to be baked for the export. Sampled rather
 * than declared: a curve that overshoots — and the good ones all do — reaches
 * past both of its endpoints, so reading `at(0)` and `at(1)` would under-measure
 * every pop and every bounce, and the words would be clipped mid-flight.
 *
 * Offsets are in font sizes, as everywhere in this module.
 */
export function animationBounds(animation: TextAnimation): {
  dx: number
  dy: number
  scale: number
} {
  let dx = 0
  let dy = 0
  let scale = 1
  for (let i = 0; i <= 64; i++) {
    const step = animation.at(i / 64)
    dx = Math.max(dx, Math.abs(step.dx))
    dy = Math.max(dy, Math.abs(step.dy))
    scale = Math.max(scale, step.scale)
  }
  return { dx, dy, scale }
}

/** Splitting a line into the pieces an animation moves. */
export function piecesOf(text: string, scope: Scope): string[] {
  if (scope === 'block') return [text]
  if (scope === 'char') return Array.from(text)
  return text.split(/(\s+)/).filter((p) => p.length > 0)
}

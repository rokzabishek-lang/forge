import { describe, it, expect } from 'vitest'
import {
  TRANSITIONS,
  previewAt,
  lumaAlpha,
  lumaAlphaExpression,
  lumaAlphaRamp,
  lumaAlphaMatrix,
  LUMA_SOFTNESS,
  AT_REST,
  type TransitionContext,
  type TransitionDef
} from '@shared/transitions/registry'
import { buildRenderPlan } from '@shared/render/plan'
import { addTransition, emptyProject, type Clip, type MediaAsset, type Project } from '@shared/timeline'

/*
 * The preview and the export, held to the same numbers.
 *
 * Every transition is written once, as a factory that returns both an ffmpeg
 * string and a JavaScript function (`registry.ts`). That arrangement makes
 * drift possible to catch but not impossible to introduce, so this file reads
 * the strings ffmpeg will actually be given, evaluates them, and holds the
 * result against what the canvas will actually draw.
 *
 * The alternative — trusting that two implementations of "ease out over half a
 * second" agree — is how the preview came to fade every transition, including
 * the 405 that are wipes.
 */

/* ------------------------------------------------- a tiny ffmpeg evaluator */

/**
 * Enough of ffmpeg's expression language for the position and geq strings:
 * `+ - * /`, parentheses, and the handful of functions they use.
 *
 * Deliberately not a general implementation. It refuses anything it does not
 * know rather than guessing, so an expression that grows a new function fails
 * here loudly instead of being silently evaluated as something else.
 */
function evaluate(source: string, env: Record<string, number>): number {
  const tokens = source.match(/\d*\.?\d+|[A-Za-z_]\w*|[(),+\-*/]/g) ?? []
  let at = 0

  const peek = (): string | undefined => tokens[at]
  const take = (expected?: string): string => {
    const token = tokens[at++]
    if (expected !== undefined && token !== expected) {
      throw new Error(`expected ${expected}, found ${token} in ${source}`)
    }
    return token
  }

  const FUNCTIONS: Record<string, (args: number[]) => number> = {
    if: ([cond, a, b]) => (cond !== 0 ? a : b),
    lt: ([a, b]) => (a < b ? 1 : 0),
    gt: ([a, b]) => (a > b ? 1 : 0),
    min: ([a, b]) => Math.min(a, b),
    max: ([a, b]) => Math.max(a, b),
    pow: ([a, b]) => a ** b,
    clip: ([v, lo, hi]) => Math.min(hi, Math.max(lo, v)),
    // The mask's brightness at a pixel. The caller supplies it as `luma`,
    // because every pixel of a given brightness behaves identically.
    p: () => env.luma
  }

  function primary(): number {
    const token = peek()
    if (token === undefined) throw new Error(`ran out of tokens in ${source}`)
    if (token === '(') {
      take('(')
      const value = expression()
      take(')')
      return value
    }
    if (token === '-') {
      take('-')
      return -primary()
    }
    if (/^[A-Za-z_]/.test(token)) {
      take()
      if (peek() === '(') {
        take('(')
        const args: number[] = []
        if (peek() !== ')') {
          args.push(expression())
          while (peek() === ',') {
            take(',')
            args.push(expression())
          }
        }
        take(')')
        const fn = FUNCTIONS[token]
        if (!fn) throw new Error(`unknown function ${token}() in ${source}`)
        return fn(args)
      }
      if (!(token in env)) throw new Error(`unknown variable ${token} in ${source}`)
      return env[token]
    }
    take()
    return Number(token)
  }

  function term(): number {
    let value = primary()
    for (;;) {
      const op = peek()
      if (op === '*') { take(); value *= primary() }
      else if (op === '/') { take(); value /= primary() }
      else return value
    }
  }

  function expression(): number {
    let value = term()
    for (;;) {
      const op = peek()
      if (op === '+') { take(); value += term() }
      else if (op === '-') { take(); value -= term() }
      else return value
    }
  }

  const result = expression()
  if (at !== tokens.length) throw new Error(`trailing tokens in ${source}`)
  return result
}

describe('the expression evaluator itself', () => {
  // It is test infrastructure, so it gets the same scrutiny as the thing it
  // tests: an evaluator that quietly returned 0 would pass every case below.
  it('follows precedence, calls and variables', () => {
    expect(evaluate('1+2*3', {})).toBe(7)
    expect(evaluate('(1+2)*3', {})).toBe(9)
    expect(evaluate('if(lt(t,1),10,20)', { t: 0 })).toBe(10)
    expect(evaluate('if(lt(t,1),10,20)', { t: 5 })).toBe(20)
    expect(evaluate('pow(1-min(1,0.5),2)', {})).toBe(0.25)
    expect(evaluate('clip(300,0,255)', {})).toBe(255)
    expect(evaluate('-3*-2', {})).toBe(6)
  })

  it('refuses what it does not know instead of guessing', () => {
    expect(() => evaluate('hypot(3,4)', {})).toThrow(/unknown function/)
    expect(() => evaluate('W/2', {})).toThrow(/unknown variable/)
  })
})

/* ------------------------------------------------------ position == preview */

const CTX: TransitionContext = { duration: 0.5, canvasWidth: 1080, canvasHeight: 1920 }
const START = 2 // the clip's timeline start, in seconds — what `S` becomes.

const moving = TRANSITIONS.filter((t) => t.position)

describe('every sliding transition draws where it renders', () => {
  it('has some to check', () => {
    // A filter that silently matched nothing would make this whole block vacuous.
    expect(moving.length).toBeGreaterThanOrEqual(5)
  })

  for (const transition of moving) {
    it(`${transition.id}: the canvas offset equals the overlay expression`, () => {
      const p = transition.position!(CTX)

      for (const progress of [0, 0.25, 0.5, 0.75, 1]) {
        const env = { t: START + progress * CTX.duration, S: START }
        const preview = previewAt(transition, progress, CTX)

        expect(evaluate(p.x, env), `${transition.id} x at ${progress}`).toBeCloseTo(preview.dx, 0)
        expect(evaluate(p.y, env), `${transition.id} y at ${progress}`).toBeCloseTo(preview.dy, 0)
      }
    })

    it(`${transition.id}: starts off the edge and lands at rest`, () => {
      // Without this the test above is satisfied by both halves being zero.
      const away = previewAt(transition, 0, CTX)
      expect(Math.abs(away.dx) + Math.abs(away.dy)).toBeGreaterThan(100)

      const landed = previewAt(transition, 1, CTX)
      expect(landed.dx).toBe(0)
      expect(landed.dy).toBe(0)
    })
  }

  it('stays at rest once the transition has passed', () => {
    for (const transition of moving) {
      const past = previewAt(transition, 2.5, CTX)
      expect(past, transition.id).toEqual(AT_REST)
    }
  })
})

describe('every fading transition draws the ramp ffmpeg walks', () => {
  const fading = TRANSITIONS.filter((t) => t.incoming?.(CTX).some((f) => f.startsWith('fade=')))

  it('has some to check', () => {
    expect(fading.length).toBeGreaterThanOrEqual(4)
  })

  for (const transition of fading) {
    it(`${transition.id}: alpha is linear over the transition's own length`, () => {
      const filters = transition.incoming!(CTX)
      // `alpha=1` fades the alpha channel; without it the clip fades toward
      // black and the preview's blend would be showing something else entirely.
      expect(filters).toContain(`fade=t=in:st=0:d=${CTX.duration.toFixed(4)}:alpha=1`)

      for (const progress of [0, 0.25, 0.5, 0.75, 1]) {
        expect(previewAt(transition, progress, CTX).alpha).toBeCloseTo(progress, 6)
      }
      // And it holds open afterwards rather than fading back out.
      expect(previewAt(transition, 3, CTX).alpha).toBe(1)
    })
  }
})

describe('a punch-in narrows the preview by exactly what it crops', () => {
  const punching = TRANSITIONS.filter((t) => t.incoming?.(CTX).some((f) => f.startsWith('crop=iw/')))

  it('has some to check', () => {
    expect(punching.length).toBeGreaterThanOrEqual(1)
  })

  for (const transition of punching) {
    it(`${transition.id}: the crop divisor is the preview's scale`, () => {
      const filters = transition.incoming!(CTX)
      const crop = filters.find((f) => f.startsWith('crop=iw/'))!
      const factor = Number(/^crop=iw\/([\d.]+):ih\/([\d.]+)$/.exec(crop)![1])

      expect(factor).toBeGreaterThan(1)
      expect(previewAt(transition, 0.5, CTX).scale).toBe(factor)
      // The enlargement that makes room for the crop has to match it, or the
      // clip comes out a different size rather than a tighter framing.
      expect(filters.some((f) => f.includes(`iw*${factor}`))).toBe(true)
    })

    it(`${transition.id}: does not end with the transition`, () => {
      /*
       * Pinning the surprise rather than hiding it: `scale`/`crop` run on the
       * clip's whole chain, so the punch-in outlives its own transition and
       * leaves the shot permanently tighter. The preview now shows that. If
       * this is ever made to animate, this test is the one to delete — and
       * both halves must move together. docs/FIX.md A2.
       */
      expect(previewAt(transition, 1, CTX).scale).toBeGreaterThan(1)
    })
  }
})

/* ------------------------------------------------------------- luma wipes */

describe('a luma wipe reveals, rather than fading', () => {
  const wipe: TransitionDef = {
    id: 'w', label: 'Wipe', family: 'wipe', tier: 1, defaultFrames: 14,
    mask: 'transitions/extra/ripple.jpg'
  }

  it('asks the canvas for nothing a formula can draw', () => {
    /*
     * The bug this whole item is about: the preview faded EVERY transition,
     * so all 405 wipes dissolved. A wipe's preview is its stencil, and its
     * alpha is 1 throughout — the reveal is in the mask, not in the opacity.
     */
    for (const progress of [0, 0.5, 1]) {
      expect(previewAt(wipe, progress, CTX)).toEqual(AT_REST)
    }
  })

  it('sweeps the same threshold the geq sweeps', () => {
    const expression = lumaAlphaExpression(CTX.duration)

    for (const progress of [0.1, 0.5, 0.9]) {
      for (const luma of [0, 64, 128, 200, 255]) {
        // X and Y are the pixel `p()` is asked about; the evaluator answers
        // with `luma` whatever they are, because every pixel of one brightness
        // behaves identically and that is the whole point of the sweep.
        const ffmpeg = evaluate(expression, { T: progress * CTX.duration, X: 0, Y: 0, luma })
        expect(lumaAlpha(progress, luma), `p=${progress} luma=${luma}`).toBeCloseTo(ffmpeg, 6)
      }
    }
  })

  it('opens from nothing to everything, never going backwards', () => {
    // A left-to-right gradient: one column per brightness, which is every
    // brightness a mask can hold.
    const gradient = Array.from({ length: 256 }, (_, i) => i)
    const revealed = (progress: number): number =>
      gradient.reduce((sum, luma) => sum + lumaAlpha(progress, luma) / 255, 0) / gradient.length

    expect(revealed(0)).toBe(0)
    expect(revealed(1)).toBe(1)

    let previous = -1
    for (let step = 0; step <= 20; step++) {
      const now = revealed(step / 20)
      expect(now, `at ${step / 20}`).toBeGreaterThanOrEqual(previous)
      previous = now
    }
    // And it is a sweep, not a switch: half way through, part of the mask is
    // through and part is not.
    expect(revealed(0.5)).toBeGreaterThan(0.2)
    expect(revealed(0.5)).toBeLessThan(0.8)
  })

  it('the canvas filter carries the same ramp as the formula', () => {
    /*
     * The preview's stencil is an feColorMatrix rather than a per-pixel loop,
     * so the numbers in that matrix are where the wipe could silently differ
     * from the render. Applied to a grey pixel it must reproduce `lumaAlpha`.
     */
    for (const progress of [0, 0.3, 0.7, 1]) {
      const values = lumaAlphaMatrix(progress).split(/\s+/).map(Number)
      expect(values).toHaveLength(20)

      const [r, g, b, , offset] = values.slice(15)
      for (const luma of [0, 90, 255]) {
        const norm = luma / 255
        // Greyscale, so R=G=B and the three weights simply sum.
        const alpha = Math.max(0, Math.min(1, (r + g + b) * norm + offset)) * 255
        // Two decimals, not more: the matrix reaches the DOM as a string of
        // six-decimal numbers, so a third of a thousandth of a level is the
        // serialisation and not a disagreement.
        expect(alpha, `p=${progress} luma=${luma}`).toBeCloseTo(lumaAlpha(progress, luma), 2)
      }
    }
  })

  it('softness widens the band without moving its ends', () => {
    const soft = lumaAlphaRamp(0.5, LUMA_SOFTNESS * 4)
    const hard = lumaAlphaRamp(0.5, LUMA_SOFTNESS)
    // A wider band is a gentler slope.
    expect(Math.abs(soft.slope)).toBeLessThan(Math.abs(hard.slope))
    expect(lumaAlpha(0, 0, 1)).toBe(0)
    expect(lumaAlpha(1, 255, 1)).toBe(255)
  })
})

/* ------------------------------------ the render places it where it rests */

const W = 1080
const H = 1920

function asset(id: string): MediaAsset {
  return {
    id, path: `/tmp/${id}.mp4`, name: id, kind: 'video', durationFrames: 300,
    width: W, height: H, fps: 30, hasVideo: true, hasAudio: false, size: 0
  }
}

function clip(over: Partial<Clip>): Clip {
  return {
    id: 'c', assetId: 'a', trackId: 'v1', start: 0, duration: 60, inPoint: 0, volume: 1,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    color: { brightness: 0, contrast: 1, saturation: 1 },
    ...over
  }
}

/** Two clips on one track, the second one shrunk and moved into a corner. */
function pictureInPicture(transform: Clip['transform']): Project {
  return {
    ...emptyProject(),
    settings: { width: W, height: H, fps: 30, sampleRate: 48000 },
    assets: [asset('a'), asset('b')],
    clips: [
      clip({ id: 'a', assetId: 'a' }),
      clip({ id: 'b', assetId: 'b', start: 60, transform })
    ]
  }
}

/**
 * The overlay expression for the TOP clip — the one carrying the transition.
 *
 * There is one overlay per composited clip, so a two-clip project has two and
 * the first of them belongs to the clip underneath, which sits at `0,0` and
 * would satisfy every assertion below without the transition doing anything at
 * all. It is asserted rather than assumed, because taking the first match of a
 * string that appears more than once has shipped a passing test with the bug
 * still in it three times in this repo (CLAUDE.md).
 */
function topOverlay(project: Project): { x: string; y: string } {
  const args = buildRenderPlan({ project, outputPath: '/o.mp4' }).args.join(' ')
  const all = [...args.matchAll(/overlay=x='([^']*)':y='([^']*)'/g)].map((m) => ({
    x: m[1],
    y: m[2]
  }))
  expect(all).toHaveLength(2)
  return all[1]
}

describe('a transition offsets the clip from its box, not from the canvas', () => {
  const corner = { x: 0.4, y: -0.35, scale: 0.3, rotation: 0, opacity: 1 }

  it('rests exactly where the same clip rests without a transition', () => {
    /*
     * The bug: `position` REPLACED the clip's resting place, and every
     * transition's expression rests at 0 — so sliding a picture-in-picture on
     * flew it to the top-left corner of the canvas and left it there for the
     * rest of the shot. Anything not filling the frame was affected: a corner
     * logo, an inset, a shrunk title card.
     */
    const plain = topOverlay(pictureInPicture(corner))
    const slid = topOverlay(addTransition(pictureInPicture(corner), 'b', 'slide-left', 15))

    // Well past the transition, where both must agree.
    const env = { t: 100, S: 0 }
    expect(evaluate(slid.x, env)).toBeCloseTo(evaluate(plain.x, env), 6)
    expect(evaluate(slid.y, env)).toBeCloseTo(evaluate(plain.y, env), 6)

    // And the box is genuinely off the corner, or the assertion proves nothing.
    expect(evaluate(plain.x, env)).toBeGreaterThan(1)
    expect(evaluate(plain.y, env)).toBeGreaterThan(1)
  })

  it('travels a whole canvas width to get there', () => {
    const slid = topOverlay(addTransition(pictureInPicture(corner), 'b', 'slide-left', 15))

    // `S` is substituted with the clip's real start; the expression must not
    // still be symbolic by the time it reaches ffmpeg.
    expect(slid.x).not.toMatch(/\bS\b/)

    const at = (seconds: number): number => evaluate(slid.x, { t: seconds, S: 0 })
    const rest = at(100)
    // The clip enters from one canvas width to the right of where it rests.
    expect(at(1.5) - rest).toBeCloseTo(W, 0)
    expect(at(1.75) - rest).toBeLessThan(W)
    expect(at(1.75) - rest).toBeGreaterThan(0)
  })

  it('leaves a full-frame clip exactly where it always was', () => {
    // The overwhelmingly common case, and the one the old code got right.
    const full = { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }
    const slid = topOverlay(addTransition(pictureInPicture(full), 'b', 'slide-up', 15))
    expect(evaluate(slid.y, { t: 100, S: 0 })).toBe(0)
    expect(evaluate(slid.x, { t: 100, S: 0 })).toBe(0)
  })
})

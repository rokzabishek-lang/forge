import type { Problem } from './conforms'
import type { Measure } from './gate'
import { headlineCapacity } from './validate'
import { layout, type Grid, type Layout, type ShotIntent } from './rhythm'
import type { Recipe } from './recipes'
import type { Menu2, SpinePlan2 } from './schema2'
import { rampRate } from '../render/speed'

/**
 * A validated `spine@2` plan, timed: the plan's intentions handed to the
 * rhythm engine, and the headlines checked against how long each card is
 * really on screen (docs/PLAN.md §5.3).
 */

export interface Composed {
  plan: SpinePlan2
  recipe: Recipe
  layout: Layout
  problems: Problem[]
}

/**
 * How many characters a reader sees — grapheme clusters, not code points.
 *
 * Measured in C0 (eval/findings.md): a Telugu or Devanagari vowel sign or
 * virama is a code point of its own, so "పెళ్లి కూతురు సిద్ధం" counted 20
 * where a reader sees about 12, and was dropped as too long to read.
 */
export function graphemes(text: string): number {
  const Segmenter = (Intl as unknown as { Segmenter?: new (l?: string, o?: { granularity: string }) => { segment: (t: string) => Iterable<unknown> } }).Segmenter
  if (!Segmenter) return Array.from(text).length
  let n = 0
  for (const _ of new Segmenter(undefined, { granularity: 'grapheme' }).segment(text)) n++
  return n
}

export const SLOW_SPEED = 0.5
/**
 * The Director's ramp: normal speed easing to 0.4× across the shot — the
 * action slows as it lands. One `setpts` (render/speed.ts); the clip plays
 * its footage over 1.53 times its length.
 */
export const DIRECTOR_RAMP = { from: 1, to: 0.4 } as const

/** A clip's footage on the timeline at a speed: slow motion and a ramp stretch it; whole frames. */
function footageAt(frames: number | null, speed: SpinePlan2['shots'][number]['speed']): number | null {
  if (frames === null) return null
  if (speed === 'slow') return Math.floor(frames / SLOW_SPEED)
  if (speed === 'ramp') return Math.floor(frames / rampRate(DIRECTOR_RAMP.from, DIRECTOR_RAMP.to) + 1e-9)
  return frames
}

export function composeAd(
  plan: SpinePlan2,
  recipe: Recipe,
  menu: Menu2,
  grid: Grid,
  extras: { measures?: Record<string, Measure>; subjects?: ReadonlySet<string>; installed?: ReadonlySet<string> } = {}
): Composed {
  const problems: Problem[] = []
  const slotById = new Map(menu.slots.map((s) => [s.id, s]))

  const intents: ShotIntent[] = plan.shots.map((shot) => {
    const slot = slotById.get(shot.slot)!
    const measure = extras.measures?.[slot.assetId]
    const face = Boolean(slot.look && slot.look.people !== 'none' && (slot.look.shot === 'close' || slot.look.shot === 'medium'))
    return {
      slotId: slot.id,
      kind: slot.kind,
      footageFrames: footageAt(slot.frames, shot.speed),
      weight: shot.weight,
      face,
      hero: shot.slot === plan.hero,
      headline: shot.headline,
      ...(measure ? { sharpness: measure.sharpness, luma: measure.luma } : {}),
      hasSubject: extras.subjects?.has(slot.assetId) ?? false
    }
  })

  const timed = layout(recipe, grid, intents, { installed: extras.installed })
  for (const d of timed.dropped) problems.push({ path: '$.shots', message: `${d.slotId} left out — ${d.why}` })
  for (const n of timed.notes) problems.push({ path: '$.layout', message: n })

  // The plan as it was laid out: without the dropped shots.
  // Copies: a headline dropped below must not reach back into the caller's plan.
  const kept = new Set(timed.shots.map((s) => s.slotId))
  const shots = plan.shots.filter((s) => kept.has(s.slot)).map((s) => ({ ...s }))

  // Headlines: readable in the time the card is on screen, or not there.
  const cards = timed.cards.filter((card) => {
    // The kept shots and the layout's shots are the same list, in the same order.
    const shot = shots[card.shot]
    const seconds = (card.endFrame - card.startFrame) / grid.fps
    const capacity = headlineCapacity(seconds)
    const length = graphemes(shot.headline)
    if (length <= capacity) return true
    problems.push({ path: `$.shots.${shot.slot}.headline`, message: `"${shot.headline}" is ${length} characters — too long to read in ${seconds.toFixed(1)}s (${capacity} fit) — card dropped` })
    shot.headline = ''
    shot.punch_word = ''
    return false
  })

  return { plan: { ...plan, shots }, recipe, layout: { ...timed, cards }, problems }
}

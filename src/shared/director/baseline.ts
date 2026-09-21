import type { Brief, Pace, Role, Segment, SpinePlan } from './schema'
import { MAX_SEGMENTS } from './schema'
import type { CutCandidate, Menu, Slot } from './menu'
import { startCut } from './menu'
import { headlineCapacity } from './validate'

/**
 * A plan with no model in it.
 *
 * docs/DIRECTOR.md §3: rules produce a baseline that always works, and the
 * model proposes an improvement that may fail. This is the baseline. It is
 * what lands when the model is absent, times out, or returns a plan the
 * validator cannot accept — and, because it validates against ANY menu, it is
 * also what the harness and the tests use as a provider.
 *
 * It is deliberately dull. Roles by position, spans by even division snapped
 * to the cuts on offer, copy lifted straight from the brief. A marketer who
 * gets this has a working ad to fix; one who gets nothing has a bug report.
 */

/** What goes in the decision record's model stamp when the baseline landed. */
export const BASELINE_MODEL = 'baseline'

/** At most this many of the user's pictures make the standard cut. */
const MAX_BASELINE_SLOTS = 6

/** Which beats an ad hits, by how many pictures it has to hit them with. */
const ROLES_BY_COUNT: Role[][] = [
  [],
  ['product'],
  ['hook', 'cta'],
  ['hook', 'product', 'cta'],
  ['hook', 'problem', 'product', 'cta'],
  ['hook', 'problem', 'product', 'proof', 'cta'],
  ['hook', 'problem', 'product', 'proof', 'offer', 'cta']
]

const WHY: Record<Role, string> = {
  hook: 'opens the ad',
  problem: 'the problem it solves',
  product: 'the product itself',
  proof: 'proof that it works',
  offer: 'the offer',
  cta: 'what to do now'
}

export function paceFor(tone: Brief['tone']): Pace {
  if (tone === 'energetic' || tone === 'urgent') return 'punchy'
  if (tone === 'premium' || tone === 'calm') return 'calm'
  return 'steady'
}

/**
 * The first pictures and the last one.
 *
 * The CTA belongs on the final picture, so with more slots than the standard
 * cut uses, the ones in the middle are the ones skipped.
 */
export function baselineSlots(slots: Slot[]): Slot[] {
  if (slots.length <= MAX_BASELINE_SLOTS) return slots
  return [...slots.slice(0, MAX_BASELINE_SLOTS - 1), slots[slots.length - 1]]
}

/**
 * Copy that fits the time it has, or nothing.
 *
 * Cut at a word boundary rather than mid-word with an ellipsis — a headline
 * that trails off reads as a mistake, a shorter one reads as a choice.
 */
export function fitHeadline(text: string, seconds: number): string {
  const capacity = headlineCapacity(seconds)
  const clean = text.replace(/\s+/g, ' ').trim()
  if (Array.from(clean).length <= capacity) return clean
  const words = clean.split(' ')
  let out = ''
  for (const word of words) {
    const candidate = out ? `${out} ${word}` : word
    if (Array.from(candidate).length > capacity) break
    out = candidate
  }
  return out
}

export function baselineSpine(brief: Brief, menu: Menu): SpinePlan {
  const fps = menu.fps
  const chosen = baselineSlots(menu.slots).slice(0, MAX_SEGMENTS)
  const first = startCut(menu.cuts)
  const ends = menu.cuts.filter((c) => c.reason !== 'start' && c.frame > first.frame)
  const last = ends[ends.length - 1]

  // Fewer places to cut than pictures: use as many pictures as there are cuts.
  const count = Math.min(chosen.length, ends.length)
  const slots = count < chosen.length ? baselineSlots(chosen.slice(0, count)) : chosen
  const roles = ROLES_BY_COUNT[Math.min(slots.length, ROLES_BY_COUNT.length - 1)]

  const segments: Segment[] = []
  let previous: CutCandidate = first
  const total = last ? last.frame - first.frame : 0

  slots.forEach((slot, i) => {
    const isLast = i === slots.length - 1
    let end: CutCandidate
    if (isLast || !last) {
      end = last ?? first
    } else {
      /*
       * Even division, snapped to what is on offer. A video is not given a
       * longer segment than its footage when a cut inside its footage exists —
       * the same rule the validator caps a model's plan by.
       */
      const target = first.frame + Math.round((total * (i + 1)) / slots.length)
      const later = ends.filter((c) => c.frame > previous.frame && c.frame < last.frame)
      // Leave enough cuts for the segments still to come.
      const remaining = slots.length - i - 1
      const usable = later.slice(0, Math.max(1, later.length - (remaining - 1)))
      const within =
        slot.frames !== null ? usable.filter((c) => c.frame - previous.frame <= slot.frames!) : usable
      const pool = within.length > 0 ? within : usable
      end = pool.reduce((best, c) =>
        Math.abs(c.frame - target) < Math.abs(best.frame - target) ? c : best
      )
    }

    const role = roles[i] ?? 'product'
    const seconds = (end.frame - previous.frame) / fps
    const copy =
      role === 'hook'
        ? brief.benefit || brief.product
        : role === 'product'
          ? brief.product
          : role === 'cta'
            ? brief.cta
            : ''
    const headline = copy ? fitHeadline(copy, seconds) : ''
    const punch = headline ? headline.split(' ')[0] : ''

    // Every other boundary, from the second: never more than half, well under
    // the validator's share, and never on the first segment.
    const families = menu.families.filter((f) => f.id !== 'cut').map((f) => f.id)
    const enter =
      i > 0 && i % 2 === 0 && families.length > 0
        ? families.includes('dissolve') && i % 4 === 0
          ? 'dissolve'
          : families.includes('zoom')
            ? 'zoom'
            : families[0]
        : 'cut'

    segments.push({
      slot: slot.id,
      role,
      ends_at: end.id,
      enter,
      headline,
      punch_word: punch,
      why: WHY[role]
    })
    previous = end
  })

  return {
    reasoning: `Standard cut: ${roles.slice(0, segments.length).join(', ')} over ${segments.length} shot${
      segments.length === 1 ? '' : 's'
    }.`,
    pace: paceFor(brief.tone),
    segments
  }
}

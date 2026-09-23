import { conforms, type Problem } from './conforms'
import {
  MAX_HEADLINE_CHARS,
  MAX_REASONING_CHARS,
  MAX_WHY_CHARS,
  spineSchema,
  type Segment,
  type SpinePlan
} from './schema'
import { minSegmentFrames, startCut, type CutCandidate, type Menu, type Slot } from './menu'
import { MIN_CARD_SECONDS, READING_CPS } from '../automation/caption'

/**
 * The second stage: does a plan make SENSE against the menu it was given.
 *
 * A grammar guarantees shape, never sense (docs/DIRECTOR.md §4). Nothing in a
 * schema stops a model ending two segments on the same cut, giving a
 * four-second clip a six-second segment, or opening the ad with a dissolve
 * from nothing. So every row here is a rule about the timeline, and each one
 * does one of two things:
 *
 *  - REPAIR, where the repair is unambiguous — an unknown slot is dropped, a
 *    family that is not installed becomes a cut, a headline too long to read
 *    is taken off. The plan lands with a note saying what changed.
 *  - REJECT, where it is not — the model reordered the slots, ended a segment
 *    before it began, ran out of room. There is no honest way to guess what
 *    was meant, so the baseline plan lands instead and the user is told why.
 *
 * The output carries a LAYOUT beside the plan: the frames each segment
 * occupies, whether a video was capped, the energy of the cut it starts on,
 * the index of its punch word. Apply reads that rather than working any of
 * it out again — two places computing the same frame is two places to
 * disagree.
 */

/** No more than this share of the cuts may carry a transition (docs/AUTOMATION.md §5b). */
export const TRANSITION_SHARE = 0.6

/** A plan must reach at least this share of the ad — the second-last cut, yes; the first second, no. */
export const MIN_COVERAGE = 0.75

export interface SegmentLayout {
  /** Timeline frames the segment occupies. */
  startFrame: number
  endFrame: number
  /** The clip's length: the whole span, or the source length when a video is shorter. */
  clipFrames: number
  capped: boolean
  /** Energy of the cut this segment STARTS on — what its transition is judged by. */
  energy: number
  startReason: CutCandidate['reason']
  /** Word index of the punch word in the headline, or -1 for none. */
  punch: number
}

export interface Validated {
  plan: SpinePlan
  layout: SegmentLayout[]
  problems: Problem[]
}

export interface Rejected {
  /** Plain English, shown in the notice. */
  rejected: string
  problems: Problem[]
}

export type SpineVerdict = Validated | Rejected

/**
 * How many characters a card can carry for the time it is on screen.
 *
 * The same reading-speed rule the One Photo captions use (automation/caption.ts):
 * 16 characters a second, never less than a 1.2 s card's worth, never more
 * than the headline ceiling. A 0.5 s segment allows nineteen characters; a
 * 2.5 s one, the full forty.
 */
export function headlineCapacity(seconds: number): number {
  return Math.min(MAX_HEADLINE_CHARS, Math.round(READING_CPS * Math.max(MIN_CARD_SECONDS, seconds)))
}

const chars = (text: string): number => Array.from(text).length
const clip = (text: string, max: number): string =>
  chars(text) <= max ? text : `${Array.from(text).slice(0, max - 1).join('')}…`

/**
 * Which word of the headline the punch word is.
 *
 * `TextSpec.highlight.word` is an index into the renderer's own split — on
 * whitespace, punctuation left attached (render/textPaint.ts). So this splits
 * the same way and compares with the punctuation taken off both sides, case
 * ignored: a model that copies `scrolling.` with the full stop, or `stop`
 * lower-cased, still lands on the word it meant. Two words, or none, is -1.
 */
export function punchIndex(headline: string, punch: string): number {
  const target = normalise(punch)
  if (!target || /\s/.test(punch.trim())) return -1
  const words = headline.trim().split(/\s+/).filter(Boolean)
  return words.findIndex((w) => normalise(w) === target)
}

function normalise(word: string): string {
  return word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').toLowerCase()
}

/**
 * Check a plan against its menu.
 *
 * `truncated` is the decoder's own report that it stopped at the token cap;
 * that is a reject before anything is parsed, because "ran out of room" is
 * the message, not "does not parse".
 */
export function validateSpine(
  raw: unknown,
  menu: Menu,
  options: {
    truncated?: boolean
    /**
     * How much of the ad the plan must reach; MIN_COVERAGE unless given. Only
     * a test of some OTHER row, validating a deliberately short plan, passes
     * 0 — the app always takes the default.
     */
    minCoverage?: number
  } = {}
): SpineVerdict {
  const problems: Problem[] = []

  if (options.truncated) {
    return { rejected: "The model's plan ran out of room before it finished", problems }
  }

  // Shape, with the menu enums and length limits off: an unknown id or a
  // long headline is repaired by the rows below, not rejected whole here.
  const shape = conforms(spineSchema(menu, { constrained: false }), raw)
  if (shape.length > 0) {
    const first = shape[0]
    return {
      rejected: `The plan is not the shape asked for — ${first.path} ${first.message}`,
      problems: shape
    }
  }
  const plan = raw as SpinePlan
  const fps = menu.fps
  const minFrames = minSegmentFrames(fps)

  /* Slots: unknown dropped, duplicates dropped, order is the user's. */
  const slotById = new Map(menu.slots.map((s, index) => [s.id, { slot: s, index }]))
  const resolved: { segment: Segment; slot: Slot; slotIndex: number; at: string }[] = []
  const seen = new Set<string>()
  plan.segments.forEach((segment, i) => {
    const at = `$.segments[${i}]`
    const hit = slotById.get(segment.slot)
    if (!hit) {
      problems.push({ path: `${at}.slot`, message: `"${segment.slot}" is not on the menu — segment dropped` })
      return
    }
    if (seen.has(segment.slot)) {
      problems.push({ path: `${at}.slot`, message: `"${segment.slot}" is used twice — the second dropped` })
      return
    }
    seen.add(segment.slot)
    resolved.push({ segment, slot: hit.slot, slotIndex: hit.index, at })
  })
  if (resolved.length === 0) return { rejected: 'None of the plan\'s segments used a picture from the menu', problems }

  for (let i = 1; i < resolved.length; i++) {
    if (resolved[i].slotIndex <= resolved[i - 1].slotIndex) {
      /*
       * Rejected rather than re-sorted. `ends_at` is positional — each
       * segment's span runs from the previous one's end — so sorting by slot
       * would hand every span to a different picture, and could turn a plan
       * that ran backwards into one that passes.
       */
      return {
        rejected: `The model put ${resolved[i].segment.slot} after ${resolved[i - 1].segment.slot}, out of the order you placed them`,
        problems
      }
    }
  }

  /* Ends: on the menu, never the start, strictly later each time, never too short. */
  const cutById = new Map(menu.cuts.map((c) => [c.id, c]))
  const first = startCut(menu.cuts)
  let previous: CutCandidate = first
  const spans: { start: CutCandidate; end: CutCandidate }[] = []
  for (const { segment } of resolved) {
    const end = cutById.get(segment.ends_at)
    if (!end || end.reason === 'start') {
      return { rejected: `A segment ends on "${segment.ends_at}", which is not a cut on the menu`, problems }
    }
    if (end.frame <= previous.frame) {
      return { rejected: `${segment.slot} ends on ${end.id}, which is not after the segment before it`, problems }
    }
    if (end.frame - previous.frame < minFrames) {
      return {
        rejected: `${segment.slot} would be on screen for ${((end.frame - previous.frame) / fps).toFixed(2)}s — too short to read as a shot`,
        problems
      }
    }
    spans.push({ start: previous, end })
    previous = end
  }

  /*
   * The ad asked for, not the first second of it.
   *
   * A plan could once end wherever it liked. Measured on Gemma 4 E2B
   * (docs/EVAL.md, run 2): twice the model stopped after ONE segment — its
   * `why` cut off by the schema's length limit mid-sentence, after which it
   * closed the plan — and a twenty-second brief became a one-second ad that
   * passed as "used". Ending at the second-last cut is fine; stopping early is
   * the model having given up, and the standard cut is the honest answer.
   */
  const endCut = menu.cuts[menu.cuts.length - 1]
  const whole = endCut.frame - first.frame
  if (whole > 0 && (previous.frame - first.frame) / whole < (options.minCoverage ?? MIN_COVERAGE)) {
    return {
      rejected: `The plan stops at ${((previous.frame - first.frame) / fps).toFixed(1)}s of a ${(whole / fps).toFixed(1)}s ad — it ended early`,
      problems
    }
  }

  /* Now the repairs, segment by segment. */
  const families = new Set<string>(menu.families.map((f) => f.id))
  const segments: Segment[] = []
  const layout: SegmentLayout[] = []
  let previousCapped = false

  resolved.forEach(({ segment, slot, at }, i) => {
    const { start, end } = spans[i]
    const span = end.frame - start.frame
    const seconds = span / fps
    const out: Segment = { ...segment }

    /* A video shorter than its segment: cap the clip, and the next segment
       arrives with a cut — there is no tail to blend from. One note for both. */
    let clipFrames = span
    let capped = false
    if (slot.frames !== null && span > slot.frames) {
      clipFrames = slot.frames
      capped = true
      const black = ((span - slot.frames) / fps).toFixed(1)
      problems.push({
        path: `${at}.ends_at`,
        message: `${slot.id} is ${(slot.frames / fps).toFixed(1)}s of footage but its segment is ${seconds.toFixed(1)}s — ${black}s of black after it${
          i + 1 < resolved.length ? `, so ${resolved[i + 1].segment.slot} enters with a cut` : ''
        }`
      })
    }

    /* Enter. The note for a forced cut after a capped video is on that video's row above. */
    if (i === 0) {
      if (out.enter !== 'cut') {
        problems.push({
          path: `${at}.enter`,
          message: `the first segment has nothing to blend from — "${out.enter}" became a cut`
        })
        out.enter = 'cut'
      }
    } else if (previousCapped) {
      out.enter = 'cut'
    } else if (!families.has(out.enter)) {
      problems.push({
        path: `${at}.enter`,
        message: `"${out.enter}" is not a transition family on the menu — became a cut`
      })
      out.enter = 'cut'
    }
    previousCapped = capped

    /* Headline: readable in the time it has, or not there. */
    if (out.headline.trim().length === 0) {
      out.headline = ''
    } else {
      const capacity = headlineCapacity(seconds)
      const length = chars(out.headline)
      if (length > capacity) {
        problems.push({
          path: `${at}.headline`,
          message: `"${clip(out.headline, 24)}" is ${length} characters — too long to read in ${seconds.toFixed(1)}s (${capacity} fit) — card dropped`
        })
        out.headline = ''
      }
    }

    /* Punch word: a whole word of the headline, or nothing. */
    let punch = -1
    if (out.headline && out.punch_word.trim()) {
      punch = punchIndex(out.headline, out.punch_word)
      if (punch === -1) {
        problems.push({
          path: `${at}.punch_word`,
          message: `"${out.punch_word}" is not a word of "${out.headline}" — no word highlighted`
        })
      }
    }
    if (punch === -1) out.punch_word = ''

    out.why = clip(out.why.trim(), MAX_WHY_CHARS)

    segments.push(out)
    layout.push({
      startFrame: start.frame,
      endFrame: end.frame,
      clipFrames,
      capped,
      energy: start.energy,
      startReason: start.reason,
      punch
    })
  })

  /* Sparse: most cuts are hard cuts. Drop the extras from the quietest boundaries. */
  const boundaries = segments.length - 1
  const allowed = Math.ceil(boundaries * TRANSITION_SHARE)
  const withTransition = segments
    .map((s, i) => ({ s, i }))
    .filter(({ s, i }) => i > 0 && s.enter !== 'cut')
  if (withTransition.length > allowed) {
    const drop = withTransition
      .slice()
      .sort((a, b) => layout[a.i].energy - layout[b.i].energy || b.i - a.i)
      .slice(0, withTransition.length - allowed)
    for (const { s, i } of drop) {
      problems.push({
        path: `$.segments[${i}].enter`,
        message: `"${s.enter}" became a cut — at most ${allowed} of ${boundaries} cuts may carry a transition`
      })
      s.enter = 'cut'
    }
  }

  return {
    plan: { reasoning: clip(plan.reasoning.trim(), MAX_REASONING_CHARS), pace: plan.pace, segments },
    layout,
    problems
  }
}

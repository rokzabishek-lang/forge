import { describe, it, expect } from 'vitest'
import type { Menu, Slot } from '@shared/director/menu'
import { buildCutMenu, familyMenu } from '@shared/director/menu'
import type { Segment, SpinePlan } from '@shared/director/schema'
import {
  MIN_COVERAGE,
  TRANSITION_SHARE,
  headlineCapacity,
  punchIndex,
  validateSpine,
  type Validated
} from '@shared/director/validate'
import { TRANSITIONS } from '@shared/transitions/registry'
import type { MusicAnalysis } from '@shared/automation/cutPlan'

const fps = 30

function music(bpm = 120, seconds = 30): MusicAnalysis {
  const beatMs = 60_000 / bpm
  const beats: number[] = []
  for (let t = 0; t < seconds * 1000; t += beatMs) beats.push(Math.round(t))
  return {
    bpm,
    beats,
    downbeats: beats.filter((_, i) => i % 4 === 0),
    tiers: beats.map((_, i) => (i % 16 >= 12 ? 3 : 1)),
    drops: [],
    buildups: [],
    sections: [],
    durationMs: seconds * 1000
  }
}

const slot = (n: number, over: Partial<Slot> = {}): Slot => ({
  id: `slot_${String(n).padStart(2, '0')}`,
  assetId: `a${n}`,
  kind: 'image',
  label: `photo ${n}`,
  note: '',
  speech: '',
  seconds: null,
  frames: null,
  ...over
})

/** Three stills and a two-second clip, over thirty seconds of 120 BPM. */
function menu(over: Partial<Menu> = {}): Menu {
  return {
    slots: [slot(1), slot(2), slot(3, { kind: 'video', seconds: 2, frames: 60 }), slot(4)],
    cuts: buildCutMenu(music(), { fps, seconds: 30 }),
    families: familyMenu(TRANSITIONS),
    seconds: 30,
    fps,
    ...over
  }
}

const segment = (over: Partial<Segment> & Pick<Segment, 'slot' | 'ends_at'>): Segment => ({
  role: 'product',
  enter: 'cut',
  headline: '',
  punch_word: '',
  why: 'because',
  ...over
})

const plan = (segments: Segment[], over: Partial<SpinePlan> = {}): SpinePlan => ({
  reasoning: 'A short ad.',
  pace: 'punchy',
  segments,
  ...over
})

/** Cut ids from the menu by position, for readable plans. */
const cutId = (m: Menu, index: number): string => m.cuts[index].id

const ok = (verdict: ReturnType<typeof validateSpine>): Validated => {
  if ('rejected' in verdict) throw new Error(`rejected: ${verdict.rejected}`)
  return verdict
}

describe('validateSpine — accepts', () => {
  it('a plan that uses the menu, in order, and lays it out from the start cut', () => {
    const m = menu()
    const got = ok(
      validateSpine(
        plan([
          segment({ slot: 'slot_01', role: 'hook', ends_at: cutId(m, 2), headline: 'Stop scrolling.', punch_word: 'Stop' }),
          segment({ slot: 'slot_03', ends_at: cutId(m, 3), enter: 'zoom' }),
          segment({ slot: 'slot_04', role: 'cta', ends_at: 'cut_end', enter: 'dissolve', headline: 'Shop the serum' })
        ]),
        m
      )
    )
    expect(got.problems).toEqual([])
    expect(got.plan.segments.map((s) => s.slot)).toEqual(['slot_01', 'slot_03', 'slot_04'])
    expect(got.layout[0].startFrame).toBe(m.cuts[0].frame)
    expect(got.layout[0].endFrame).toBe(m.cuts[2].frame)
    expect(got.layout[1].startFrame).toBe(m.cuts[2].frame)
    expect(got.layout[2].endFrame).toBe(m.cuts[m.cuts.length - 1].frame)
    expect(got.layout[0].punch).toBe(0)
    expect(got.layout[1].energy).toBe(m.cuts[2].energy)
  })

  it('a plan may skip slots, and may end at a late cut short of the end', () => {
    const m = menu()
    const late = m.cuts.length - 2
    expect(m.cuts[late].frame / m.cuts.at(-1)!.frame).toBeGreaterThanOrEqual(MIN_COVERAGE)
    const got = ok(
      validateSpine(plan([segment({ slot: 'slot_02', ends_at: cutId(m, 3) }), segment({ slot: 'slot_04', ends_at: cutId(m, late) })]), m)
    )
    expect(got.plan.segments.map((s) => s.slot)).toEqual(['slot_02', 'slot_04'])
    expect(got.problems).toEqual([])
  })

  it('refuses a plan that stops early — a one-second ad from a thirty-second brief', () => {
    /*
     * Measured (docs/EVAL.md, run 2): Gemma 4 E2B twice stopped after one
     * segment, and the plan passed as "used" — a 20 s brief became a 1 s ad.
     */
    const m = menu()
    const got = validateSpine(plan([segment({ slot: 'slot_01', ends_at: cutId(m, 1) })]), m)
    // The ad is as long as the menu's end — which snaps back onto a beat, so 28 s here, not the 30 asked for.
    const adSeconds = ((m.cuts.at(-1)!.frame - m.cuts[0].frame) / fps).toFixed(1)
    expect('rejected' in got && got.rejected).toBe(`The plan stops at ${(m.cuts[1].frame / fps).toFixed(1)}s of a ${adSeconds}s ad — it ended early`)
    // Between half and three quarters of the ad is still early. Literal numbers, NOT MIN_COVERAGE:
    // a check computed from the constant moves with it, and passed with the line mutated to 0.5.
    const ratio = (c: { frame: number }): number => c.frame / m.cuts.at(-1)!.frame
    const early = m.cuts.findIndex((c) => ratio(c) > 0.55 && ratio(c) < 0.75)
    expect(early).toBeGreaterThan(0)
    expect('rejected' in validateSpine(plan([segment({ slot: 'slot_01', ends_at: cutId(m, early) })]), m)).toBe(true)
  })
})

describe('validateSpine — rejects', () => {
  it('an answer the decoder cut off, before parsing anything', () => {
    const got = validateSpine('{"reasoning": "x', menu(), { truncated: true })
    expect(got).toMatchObject({ rejected: expect.stringContaining('ran out of room') })
  })

  it('the wrong shape, naming the field', () => {
    const got = validateSpine({ reasoning: 'x', segments: [] }, menu())
    expect(got).toMatchObject({ rejected: expect.stringContaining('$.pace') })
  })

  it('slots out of the order the user placed them — never re-sorts', () => {
    /*
     * `ends_at` is positional: each span runs from the previous end. Sorting
     * would hand every span to a different picture — and a plan that ran
     * backwards in the model's order could come out passing.
     */
    const m = menu()
    const a = validateSpine(
      plan([segment({ slot: 'slot_03', ends_at: cutId(m, 2) }), segment({ slot: 'slot_01', ends_at: cutId(m, 4) })]),
      m
    )
    expect(a).toMatchObject({ rejected: expect.stringContaining('order') })
    const b = validateSpine(
      plan([segment({ slot: 'slot_03', ends_at: cutId(m, 4) }), segment({ slot: 'slot_01', ends_at: cutId(m, 2) })]),
      m
    )
    expect(b).toMatchObject({ rejected: expect.stringContaining('order') })
  })

  it('a segment ending on the start, on an unknown cut, or not after the one before', () => {
    const m = menu()
    expect(validateSpine(plan([segment({ slot: 'slot_01', ends_at: 'cut_00' })]), m)).toMatchObject({
      rejected: expect.stringContaining('not a cut on the menu')
    })
    expect(validateSpine(plan([segment({ slot: 'slot_01', ends_at: 'cut_99' })]), m)).toMatchObject({
      rejected: expect.stringContaining('not a cut on the menu')
    })
    expect(
      validateSpine(
        plan([segment({ slot: 'slot_01', ends_at: cutId(m, 4) }), segment({ slot: 'slot_02', ends_at: cutId(m, 4) })]),
        m
      )
    ).toMatchObject({ rejected: expect.stringContaining('not after') })
  })

  it('a segment too short to read as a shot', () => {
    // A hand-built menu with two cuts five frames apart — buildCutMenu would
    // never produce one, which is exactly why the validator must not trust it.
    const m = menu({
      cuts: [
        { id: 'cut_00', ms: 0, frame: 0, reason: 'start', energy: 1 },
        { id: 'cut_01', ms: 166, frame: 5, reason: 'grid', energy: 1 },
        { id: 'cut_end', ms: 6000, frame: 180, reason: 'end', energy: 1 }
      ]
    })
    expect(validateSpine(plan([segment({ slot: 'slot_01', ends_at: 'cut_01' })]), m)).toMatchObject({
      rejected: expect.stringContaining('too short')
    })
  })

  it('a plan with no usable segment left', () => {
    const got = validateSpine(plan([segment({ slot: 'slot_99', ends_at: 'cut_end' })]), menu())
    expect(got).toMatchObject({ rejected: expect.stringContaining('None') })
    expect(got.problems).toHaveLength(1)
  })
})

describe('validateSpine — repairs', () => {
  it('drops an unknown slot and a duplicate, keeping the rest', () => {
    const m = menu()
    const got = ok(
      validateSpine(
        plan([
          segment({ slot: 'slot_01', ends_at: cutId(m, 2) }),
          segment({ slot: 'slot_09', ends_at: cutId(m, 3) }),
          segment({ slot: 'slot_01', ends_at: cutId(m, 3) }),
          segment({ slot: 'slot_04', ends_at: cutId(m, 4) })
        ]),
        m,
        // A short plan on purpose: this tests another row, not coverage.
        { minCoverage: 0 }
      )
    )
    expect(got.plan.segments.map((s) => s.slot)).toEqual(['slot_01', 'slot_04'])
    expect(got.problems.map((p) => p.path)).toEqual(['$.segments[1].slot', '$.segments[2].slot'])
  })

  it('caps a video at its footage and makes the next segment arrive with a cut', () => {
    const m = menu()
    // slot_03 is 60 frames; from cut 2 to cut 5 is far longer.
    const got = ok(
      validateSpine(
        plan([
          segment({ slot: 'slot_01', ends_at: cutId(m, 2) }),
          segment({ slot: 'slot_03', ends_at: cutId(m, 5) }),
          segment({ slot: 'slot_04', ends_at: 'cut_end', enter: 'dissolve' })
        ]),
        m
      )
    )
    expect(got.layout[1]).toMatchObject({ capped: true, clipFrames: 60 })
    expect(got.layout[1].endFrame - got.layout[1].startFrame).toBeGreaterThan(60)
    expect(got.plan.segments[2].enter).toBe('cut')
    const notes = got.problems.filter((p) => p.path.startsWith('$.segments[1]'))
    expect(notes).toHaveLength(1)
    expect(notes[0].message).toContain('black')
    expect(notes[0].message).toContain('slot_04 enters with a cut')
    // One note for both effects, not two.
    expect(got.problems.filter((p) => p.path === '$.segments[2].enter')).toHaveLength(0)
  })

  it('makes the first segment a cut, and an uninstalled family a cut', () => {
    const m = menu()
    const got = ok(
      validateSpine(
        plan([
          segment({ slot: 'slot_01', ends_at: cutId(m, 2), enter: 'zoom' }),
          segment({ slot: 'slot_02', ends_at: cutId(m, 3), enter: 'glitch' })
        ]),
        m,
        // A short plan on purpose: this tests another row, not coverage.
        { minCoverage: 0 }
      )
    )
    expect(got.plan.segments.map((s) => s.enter)).toEqual(['cut', 'cut'])
    expect(got.problems.map((p) => p.path)).toEqual(['$.segments[0].enter', '$.segments[1].enter'])
  })

  it('keeps transitions sparse, dropping them from the quietest boundaries first', () => {
    const m = menu({ slots: [slot(1), slot(2), slot(3), slot(4), slot(5)] })
    const got = ok(
      validateSpine(
        plan([
          segment({ slot: 'slot_01', ends_at: cutId(m, 1) }),
          segment({ slot: 'slot_02', ends_at: cutId(m, 2), enter: 'dissolve' }),
          segment({ slot: 'slot_03', ends_at: cutId(m, 3), enter: 'zoom' }),
          segment({ slot: 'slot_04', ends_at: cutId(m, 4), enter: 'slide' }),
          segment({ slot: 'slot_05', ends_at: cutId(m, 5), enter: 'smooth' })
        ]),
        m,
        // A short plan on purpose: this tests another row, not coverage.
        { minCoverage: 0 }
      )
    )
    const allowed = Math.ceil(4 * TRANSITION_SHARE)
    expect(allowed).toBe(3)
    const kept = got.plan.segments.filter((s, i) => i > 0 && s.enter !== 'cut')
    expect(kept).toHaveLength(allowed)
    // The one that went was the lowest-energy boundary.
    const dropped = got.plan.segments.findIndex((s, i) => i > 0 && s.enter === 'cut')
    const energies = got.layout.slice(1).map((l) => l.energy)
    expect(got.layout[dropped].energy).toBe(Math.min(...energies))
    expect(got.problems.some((p) => p.message.includes(`at most ${allowed}`))).toBe(true)
  })

  it('takes a headline off when it cannot be read in the time it has', () => {
    const m = menu({
      cuts: [
        { id: 'cut_00', ms: 0, frame: 0, reason: 'start', energy: 1 },
        { id: 'cut_01', ms: 500, frame: 15, reason: 'grid', energy: 1 },
        { id: 'cut_end', ms: 4000, frame: 120, reason: 'end', energy: 1 }
      ]
    })
    const long = 'Glow like never before in seven days'
    const got = ok(
      validateSpine(
        plan([
          segment({ slot: 'slot_01', ends_at: 'cut_01', headline: long, punch_word: 'Glow' }),
          segment({ slot: 'slot_02', ends_at: 'cut_end', headline: long, punch_word: 'Glow' })
        ]),
        m
      )
    )
    // Half a second holds nineteen characters; 3.5 s holds the whole line.
    expect(got.plan.segments[0].headline).toBe('')
    expect(got.plan.segments[0].punch_word).toBe('')
    expect(got.layout[0].punch).toBe(-1)
    expect(got.plan.segments[1].headline).toBe(long)
    expect(got.layout[1].punch).toBe(0)
    expect(got.problems).toHaveLength(1)
    expect(got.problems[0].path).toBe('$.segments[0].headline')
    expect(got.problems[0].message).toContain('too long to read')
  })

  it('clears a punch word that is not a word of the headline', () => {
    const m = menu()
    const got = ok(
      validateSpine(
        plan([segment({ slot: 'slot_01', ends_at: cutId(m, 2), headline: 'Glow in 7 days', punch_word: 'glow!' })]),
        m,
        // A short plan on purpose: this tests another row, not coverage.
        { minCoverage: 0 }
      )
    )
    expect(got.layout[0].punch).toBe(0)
    const bad = ok(
      validateSpine(
        plan([segment({ slot: 'slot_01', ends_at: cutId(m, 2), headline: 'Glow in 7 days', punch_word: 'week' })]),
        m,
        // A short plan on purpose: this tests another row, not coverage.
        { minCoverage: 0 }
      )
    )
    expect(bad.plan.segments[0].punch_word).toBe('')
    expect(bad.layout[0].punch).toBe(-1)
    expect(bad.problems[0].path).toBe('$.segments[0].punch_word')
  })

  it('clips reasoning and why to their limits without complaint', () => {
    const m = menu()
    const got = ok(
      validateSpine(
        plan([segment({ slot: 'slot_01', ends_at: cutId(m, 2), why: 'w'.repeat(200) })], { reasoning: 'r'.repeat(900) }),
        m,
        // A short plan on purpose: this tests another row, not coverage.
        { minCoverage: 0 }
      )
    )
    expect(Array.from(got.plan.reasoning).length).toBe(300)
    expect(Array.from(got.plan.segments[0].why).length).toBe(60)
    expect(got.problems).toEqual([])
  })
})

describe('headlineCapacity', () => {
  it('follows reading speed, floored at a short card and capped at the headline ceiling', () => {
    expect(headlineCapacity(0.5)).toBe(19)
    expect(headlineCapacity(1.2)).toBe(19)
    expect(headlineCapacity(2.0)).toBe(32)
    expect(headlineCapacity(2.5)).toBe(40)
    expect(headlineCapacity(10)).toBe(40)
  })
})

describe('punchIndex', () => {
  it('finds the word the way the renderer splits, punctuation and case aside', () => {
    expect(punchIndex('Stop scrolling.', 'scrolling')).toBe(1)
    expect(punchIndex('Stop scrolling.', 'Stop')).toBe(0)
    expect(punchIndex('Stop scrolling.', 'stop')).toBe(0)
    expect(punchIndex('Glow in 7 days', '7')).toBe(2)
    expect(punchIndex('Glow in 7 days', '"days"')).toBe(3)
    expect(punchIndex('  Glow   in 7 days ', 'in')).toBe(1)
  })

  it('refuses two words, nothing, and a word that is not there', () => {
    expect(punchIndex('Glow in 7 days', 'in 7')).toBe(-1)
    expect(punchIndex('Glow in 7 days', '')).toBe(-1)
    expect(punchIndex('Glow in 7 days', '...')).toBe(-1)
    expect(punchIndex('Glow in 7 days', 'glowing')).toBe(-1)
    expect(punchIndex('', 'x')).toBe(-1)
  })
})

import { describe, expect, it } from 'vitest'
import { BLOWN_CLIP, DARK_LUMA, SOFT_RATIO, flagsFor, gate, hamming, type Measure } from '@shared/director/gate'
import type { Look } from '@shared/director/look'
import type { Slot } from '@shared/director/menu'

/**
 * The quality gate (docs/PLAN.md §4.3): every rule against a set built to
 * trip it. The rule that matters most is the one a model cannot follow — a
 * photo the VLM calls strong that the measurement calls soft is not a hero.
 */

const slot = (n: number, kind: Slot['kind'] = 'image'): Slot => ({
  id: `slot_0${n}`, assetId: `a${n}`, kind, label: `photo ${n}`, note: '', speech: '',
  seconds: kind === 'video' ? 4 : null, frames: kind === 'video' ? 120 : null
})

const m = (over: Partial<Measure> = {}): Measure => ({
  sharpness: 500, luma: 0.5, lumaStd: 0.2, darkClip: 0, brightClip: 0, dhash: null, width: 1000, height: 1250, ...over
})

const look = (over: Partial<Look> = {}): Look => ({
  people: 'two', shot: 'close', mood: 'joyful', product_visible: 'no', hero: 'usable', words: 'x', ...over
})

describe('the flags', () => {
  it('soft is relative to the set, dark and blown are absolute', () => {
    expect(flagsFor(m({ sharpness: SOFT_RATIO * 1000 - 1 }), 1000)).toEqual(['soft'])
    expect(flagsFor(m({ sharpness: SOFT_RATIO * 1000 + 1 }), 1000)).toEqual([])
    expect(flagsFor(m({ luma: DARK_LUMA - 0.01 }), 1000)).toEqual(['dark'])
    expect(flagsFor(m({ brightClip: BLOWN_CLIP + 0.01 }), 1000)).toEqual(['blown'])
    expect(flagsFor(undefined, 1000)).toEqual([])
  })

  it('a set that is soft all over keeps every photo: it is a look, not ten rejects', () => {
    const slots = [1, 2, 3, 4].map((n) => slot(n))
    const soft = Object.fromEntries(slots.map((s, i) => [s.assetId, m({ sharpness: 20 + i })]))
    const result = gate(slots, {}, soft, { wantsPeople: false })
    expect(result.slots.every((s) => s.flags.length === 0)).toBe(true)
    expect(result.heroCandidates).toHaveLength(4)
  })
})

describe('near-copies', () => {
  it('the softer of two near-copies is left out, and says which it copied', () => {
    const slots = [slot(1), slot(2), slot(3)]
    const result = gate(
      slots,
      {},
      {
        a1: m({ dhash: 'ff00ff00ff00ff00', sharpness: 300 }),
        a2: m({ dhash: 'ff00ff00ff00ff03', sharpness: 900 }), // two bits off: a copy, and sharper
        a3: m({ dhash: '00ff00ff00ff00ff' })
      },
      { wantsPeople: false }
    )
    expect(result.slots.map((s) => s.id)).toEqual(['slot_02', 'slot_03'])
    expect(result.leftOut).toEqual([{ slot: 'slot_01', why: 'near-duplicate of slot_02 (slot_02 is sharper)' }])
  })

  it('two flat pictures are never copies — they have no hash to compare', () => {
    const result = gate([slot(1), slot(2)], {}, { a1: m({ dhash: null }), a2: m({ dhash: null }) }, { wantsPeople: false })
    expect(result.leftOut).toEqual([])
  })

  it('counts bits as a Hamming distance', () => {
    expect(hamming('0', '0')).toBe(0)
    expect(hamming('ff', '00')).toBe(8)
    expect(hamming('ffffffffffffffff', '7fffffffffffffff')).toBe(1)
  })
})

describe('hero candidates', () => {
  const slots = [slot(1), slot(2), slot(3), slot(4)]
  const sharp = { a1: m({ sharpness: 900 }), a2: m({ sharpness: 800 }), a3: m({ sharpness: 700 }), a4: m({ sharpness: 600 }) }

  it('the measurement wins: a photo the VLM calls strong and the Laplacian calls soft is not a candidate', () => {
    const result = gate(
      slots,
      { a1: look({ hero: 'strong' }), a2: look(), a3: look(), a4: look() },
      { ...sharp, a1: m({ sharpness: 10 }) },
      { wantsPeople: false }
    )
    expect(result.slots.find((s) => s.id === 'slot_01')!.flags).toEqual(['soft'])
    expect(result.heroCandidates).not.toContain('slot_01')
  })

  it('a weak look is not a candidate; a strong one is ranked before usable ones', () => {
    const result = gate(slots, { a1: look({ hero: 'weak' }), a2: look(), a3: look({ hero: 'strong' }), a4: look() }, sharp, { wantsPeople: false })
    expect(result.heroCandidates).toEqual(['slot_03', 'slot_02', 'slot_04'])
  })

  it('a wedding hero has people in it', () => {
    const result = gate(slots, { a1: look({ people: 'none' }), a2: look(), a3: look(), a4: look() }, sharp, { wantsPeople: true })
    expect(result.heroCandidates).not.toContain('slot_01')
  })

  it('with no looks, the sharpest stills lead and a clip is not judged', () => {
    const result = gate([...slots, slot(5, 'video')], {}, sharp, { wantsPeople: true })
    expect(result.heroCandidates).toEqual(['slot_01', 'slot_02', 'slot_03', 'slot_04'])
  })

  it('an empty list loosens in a fixed order and says which rule gave way — never empty', () => {
    const allBad = { a1: m({ luma: 0.05 }), a2: m({ luma: 0.05 }), a3: m({ luma: 0.05 }), a4: m({ luma: 0.05 }) }
    const noPeople = { a1: look({ people: 'none' }), a2: look({ people: 'none' }), a3: look({ people: 'none' }), a4: look({ people: 'none' }) }
    const result = gate(slots, noPeople, allBad, { wantsPeople: true })
    expect(result.loosened).toEqual([
      'no clean photo had people in it — the people rule gave way',
      'no clean photo was well exposed — the exposure rule gave way'
    ])
    expect(result.heroCandidates).toHaveLength(4)

    // Every photo soft AND looked at as weak: only the sharpest one stands in.
    const soft = { a1: m({ sharpness: 1 }), a2: m({ sharpness: 1000 }), a3: m({ sharpness: 1 }), a4: m({ sharpness: 1 }) }
    const weak = { a1: look({ hero: 'weak' }), a2: look({ hero: 'weak' }), a3: look({ hero: 'weak' }), a4: look({ hero: 'weak' }) }
    const last = gate(slots, weak, soft, { wantsPeople: false })
    expect(last.loosened.at(-1)).toBe('no photo passed — the sharpest one stands in')
    expect(last.heroCandidates).toEqual(['slot_02'])
  })

  it('nothing measured and nothing looked at: every still is a candidate, in the user’s order', () => {
    expect(gate(slots, {}, {}, { wantsPeople: false }).heroCandidates).toEqual(['slot_01', 'slot_02', 'slot_03', 'slot_04'])
  })
})

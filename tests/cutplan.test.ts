import { describe, it, expect } from 'vitest'
import {
  chooseBeatsPerCut,
  planCuts,
  shotLengths,
  cutsPerMinute,
  pickTransition,
  tierAt,
  transitionTierFor,
  type MusicAnalysis
} from '@shared/automation/cutPlan'

/** A steady track at a given tempo, with uniform mid energy. */
function analysis(bpm: number, seconds = 60, over: Partial<MusicAnalysis> = {}): MusicAnalysis {
  const beatMs = 60_000 / bpm
  const beats: number[] = []
  for (let t = 0; t < seconds * 1000; t += beatMs) beats.push(Math.round(t))
  return {
    bpm,
    beats,
    downbeats: beats.filter((_, i) => i % 4 === 0),
    tiers: beats.map(() => 1),
    drops: [],
    buildups: [],
    sections: [],
    durationMs: seconds * 1000,
    ...over
  }
}

describe('chooseBeatsPerCut', () => {
  it('lands shot length near the target at any tempo', () => {
    for (const bpm of [75, 90, 110, 128, 145, 174]) {
      const n = chooseBeatsPerCut(bpm)
      const shot = (n * 60) / bpm
      // The whole point: pacing should not depend on tempo.
      expect(shot).toBeGreaterThan(1.2)
      expect(shot).toBeLessThan(3.6)
    }
  })

  it('uses a larger multiple at faster tempos', () => {
    expect(chooseBeatsPerCut(174)).toBeGreaterThan(chooseBeatsPerCut(75))
  })

  it('only ever returns a musical multiple', () => {
    for (const bpm of [60, 90, 128, 200]) {
      expect([1, 2, 4, 8, 16]).toContain(chooseBeatsPerCut(bpm))
    }
  })

  it('survives nonsense input', () => {
    expect(chooseBeatsPerCut(0)).toBe(4)
    expect(chooseBeatsPerCut(Number.NaN)).toBe(4)
  })

  it('respects a different target', () => {
    expect(chooseBeatsPerCut(120, 4)).toBeGreaterThan(chooseBeatsPerCut(120, 1))
  })
})

describe('planCuts pacing', () => {
  it('never cuts on every beat', () => {
    const music = analysis(128)
    const cuts = planCuts(music, { fps: 30 })
    const rate = cutsPerMinute(cuts, music.durationMs)
    // 128 BPM is 128 beats/min; cutting on each would be frantic.
    expect(rate).toBeLessThan(60)
  })

  it('keeps cut density similar across wildly different tempos', () => {
    const slow = analysis(75)
    const fast = analysis(174)
    const slowRate = cutsPerMinute(planCuts(slow, { fps: 30 }), slow.durationMs)
    const fastRate = cutsPerMinute(planCuts(fast, { fps: 30 }), fast.durationMs)
    // Tempo-invariance is the reason for the beat-multiple search.
    expect(Math.abs(slowRate - fastRate)).toBeLessThan(25)
  })

  it('produces shots in the short-form range', () => {
    const music = analysis(120)
    const lengths = shotLengths(planCuts(music, { fps: 30 }), music.durationMs)
    const median = [...lengths].sort((a, b) => a - b)[Math.floor(lengths.length / 2)]
    expect(median).toBeGreaterThan(1000)
    expect(median).toBeLessThan(5000)
  })

  it('lands every cut on a real beat', () => {
    const music = analysis(120)
    const beats = new Set(music.beats)
    for (const cut of planCuts(music, { fps: 30 })) {
      expect(beats.has(cut.ms)).toBe(true)
    }
  })

  it('honours an explicit beats-per-cut override', () => {
    const music = analysis(120)
    const sparse = planCuts(music, { fps: 30, beatsPerCut: 16 })
    const dense = planCuts(music, { fps: 30, beatsPerCut: 2 })
    expect(dense.length).toBeGreaterThan(sparse.length)
  })

  it('cuts faster through peaks than through quiet passages', () => {
    const beatMs = 500
    const beats = Array.from({ length: 120 }, (_, i) => i * beatMs)
    const music: MusicAnalysis = {
      bpm: 120,
      beats,
      downbeats: beats.filter((_, i) => i % 4 === 0),
      // First half quiet, second half peak.
      tiers: beats.map((_, i) => (i < 60 ? 0 : 3)),
      drops: [],
      buildups: [],
      sections: [],
      durationMs: 60_000
    }
    const cuts = planCuts(music, { fps: 30 })
    const half = 30_000
    const quiet = cuts.filter((c) => c.ms < half).length
    const loud = cuts.filter((c) => c.ms >= half).length
    expect(loud).toBeGreaterThan(quiet)
  })

  it('returns nothing for music with no beats', () => {
    expect(planCuts({ ...analysis(120), beats: [], downbeats: [] }, { fps: 30 })).toEqual([])
  })
})

describe('planCuts structure', () => {
  const withStructure = (): MusicAnalysis =>
    analysis(120, 60, {
      drops: [{ ms: 30_000, score: 0.8 }],
      sections: [15_000, 45_000],
      buildups: [{ startMs: 26_000, endMs: 30_000, towardsMs: 30_000 }]
    })

  it('always cuts on a drop', () => {
    const cuts = planCuts(withStructure(), { fps: 30 })
    const atDrop = cuts.find((c) => Math.abs(c.ms - 30_000) < 250)
    expect(atDrop).toBeDefined()
    expect(atDrop?.reason).toBe('drop')
  })

  it('always cuts on a section boundary', () => {
    const cuts = planCuts(withStructure(), { fps: 30 })
    expect(cuts.some((c) => Math.abs(c.ms - 15_000) < 250 && c.reason === 'section')).toBe(true)
  })

  it('converts ms to frames consistently', () => {
    const cuts = planCuts(withStructure(), { fps: 30 })
    for (const cut of cuts) {
      expect(cut.frame).toBe(Math.round((cut.ms / 1000) * 30))
    }
  })

  it('never places two cuts within a few frames', () => {
    const cuts = planCuts(withStructure(), { fps: 30 })
    for (let i = 1; i < cuts.length; i++) {
      expect(cuts[i].ms - cuts[i - 1].ms).toBeGreaterThanOrEqual(120)
    }
  })
})

describe('transitions are rare and earned', () => {
  const music = analysis(120, 60, {
    drops: [{ ms: 30_000, score: 0.8 }],
    sections: [15_000, 45_000],
    buildups: [{ startMs: 26_000, endMs: 30_000, towardsMs: 30_000 }]
  })

  it('leaves the overwhelming majority of cuts hard', () => {
    const cuts = planCuts(music, { fps: 30 })
    const withTransition = cuts.filter((c) => c.transitionTier !== null).length
    // Cycling through a transition library is the clearest tell of auto-editing.
    expect(withTransition / cuts.length).toBeLessThan(0.25)
  })

  it('never puts a transition on a plain grid cut', () => {
    for (const cut of planCuts(music, { fps: 30 })) {
      if (cut.reason === 'grid') expect(cut.transitionTier).toBeNull()
    }
  })

  it('gives the drop the most aggressive treatment', () => {
    const cuts = planCuts(music, { fps: 30 })
    const drop = cuts.find((c) => c.reason === 'drop')
    expect(drop?.transitionTier).toBe(3)
  })

  it('can be turned off entirely', () => {
    const cuts = planCuts(music, { fps: 30, transitionRate: 0 })
    expect(cuts.every((c) => c.transitionTier === null)).toBe(true)
  })
})

describe('helpers', () => {
  it('reads the energy tier at a moment', () => {
    const music = analysis(120, 10, { tiers: [] })
    music.tiers = music.beats.map((_, i) => (i < 5 ? 0 : 3))
    expect(tierAt(music, 0)).toBe(0)
    expect(tierAt(music, 5000)).toBe(3)
  })

  it('falls back sensibly with no tier data', () => {
    expect(tierAt({ ...analysis(120), tiers: [] }, 1000)).toBe(1)
  })

  it('reserves the aggressive tier for peaks and drops', () => {
    expect(transitionTierFor('drop', 0)).toBe(3)
    expect(transitionTierFor('grid', 3)).toBe(3)
    expect(transitionTierFor('section', 1)).toBe(1)
    expect(transitionTierFor('section', 2)).toBe(2)
  })
})

describe('transition eligibility', () => {
  const music = analysis(120, 60, { drops: [{ ms: 30_000, score: 0.9 }] })

  it('reserves transitions for structural moments by default', () => {
    const cuts = planCuts(music, { fps: 30, transitionRate: 0.6 })
    const treated = cuts.filter((c) => c.transitionTier !== null)
    expect(treated.every((c) => c.reason !== 'grid')).toBe(true)
  })

  it('lets grid cuts carry one when asked — stills need it', () => {
    const cuts = planCuts(music, { fps: 30, transitionRate: 0.6, transitionsOn: 'all' })
    const treated = cuts.filter((c) => c.transitionTier !== null)
    expect(treated.some((c) => c.reason === 'grid')).toBe(true)
    expect(treated.length / cuts.length).toBeGreaterThan(0.4)
  })

  it('spreads them rather than piling them into the loud part', () => {
    const cuts = planCuts(music, { fps: 30, transitionRate: 0.5, transitionsOn: 'all' })
    const half = Math.floor(cuts.length / 2)
    const early = cuts.slice(0, half).filter((c) => c.transitionTier !== null).length
    const late = cuts.slice(half).filter((c) => c.transitionTier !== null).length
    // Ranking alone left the first half empty; even spacing is the point.
    expect(early).toBeGreaterThan(0)
    expect(late).toBeGreaterThan(0)
  })

  it('still honours a rate of zero with everything eligible', () => {
    const cuts = planCuts(music, { fps: 30, transitionRate: 0, transitionsOn: 'all' })
    expect(cuts.every((c) => c.transitionTier === null)).toBe(true)
  })
})

describe('pickTransition', () => {
  const catalogue = [
    { id: 'dissolve', family: 'dissolve' },
    { id: 'smooth-1', family: 'smooth' },
    { id: 'slide-left', family: 'slide' },
    { id: 'wipe-1', family: 'wipe' },
    { id: 'zoom-in', family: 'zoom' },
    { id: 'glitch-1', family: 'glitch' }
  ]

  it('matches the family to the tier', () => {
    expect(['zoom-in', 'glitch-1']).toContain(pickTransition(3, 0, catalogue))
    expect(['dissolve', 'smooth-1']).toContain(pickTransition(1, 0, catalogue))
  })

  it('varies with the index so consecutive cuts differ', () => {
    const picks = new Set([0, 1, 2, 3].map((i) => pickTransition(2, i, catalogue)))
    expect(picks.size).toBeGreaterThan(1)
  })

  it('is deterministic — rebuilding does not reshuffle the edit', () => {
    expect(pickTransition(2, 5, catalogue)).toBe(pickTransition(2, 5, catalogue))
  })

  it('falls back down the tiers rather than giving up', () => {
    const soft = [{ id: 'dissolve', family: 'dissolve' }]
    // An install with no glitch masks should still get something on a drop.
    expect(pickTransition(3, 0, soft)).toBe('dissolve')
  })

  it('returns nothing when the catalogue is empty', () => {
    expect(pickTransition(2, 0, [])).toBeNull()
  })
})

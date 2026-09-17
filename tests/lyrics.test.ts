import { describe, it, expect } from 'vitest'
import type { Word } from '@shared/transcript'
import {
  DEFAULT_SNAP_MS,
  accentsFrom,
  offGridShare,
  planLyricCuts,
  punchOf,
  syllableCount
} from '@shared/automation/lyrics'
import { planCuts, type MusicAnalysis } from '@shared/automation/cutPlan'

const FPS = 30

function words(spec: [string, number, number][]): Word[] {
  return spec.map(([text, startMs, endMs], index) => ({
    index,
    text,
    startMs,
    endMs,
    confidence: 0.9
  }))
}

function music(beatCount = 32, bpm = 120): MusicAnalysis {
  const period = 60_000 / bpm
  const beats = Array.from({ length: beatCount }, (_, i) => Math.round(i * period))
  return {
    bpm,
    beats,
    downbeats: beats.filter((_, i) => i % 4 === 0),
    tiers: beats.map(() => 2),
    drops: [],
    buildups: [],
    sections: [],
    durationMs: beatCount * period
  }
}

describe('punchOf', () => {
  it('rates a plosive hardest — it is the only sound with a transient in it', () => {
    for (const word of ['party', 'back', 'take', 'down', 'kick', 'gone']) {
      expect(punchOf(word)).toBe(1)
    }
  })

  it('rates a word opening on a vowel softest', () => {
    for (const word of ['always', 'every', 'inside', 'over', 'under']) {
      expect(punchOf(word)).toBeLessThan(0.3)
    }
  })

  it('puts fricatives and nasals in between', () => {
    expect(punchOf('so')).toBeGreaterThan(punchOf('all'))
    expect(punchOf('so')).toBeLessThan(punchOf('to'))
    expect(punchOf('never')).toBeLessThan(punchOf('so'))
  })

  it('knows a soft c from a hard one', () => {
    expect(punchOf('call')).toBeGreaterThan(0.8)
    expect(punchOf('city')).toBeLessThan(0.7)
  })

  it('reads a digraph as one sound, not as its first letter', () => {
    // "th" is not a hard t, and "sh" is not a hard s.
    expect(punchOf('the')).toBeLessThan(punchOf('to'))
    expect(punchOf('show')).toBeLessThan(punchOf('so') + 0.1)
    expect(punchOf('chase')).toBeGreaterThan(0.9)
  })

  it('survives punctuation and capitals', () => {
    expect(punchOf('“Back!”')).toBe(punchOf('back'))
    expect(punchOf('')).toBeLessThan(0.3)
  })
})

describe('syllableCount', () => {
  it('counts the obvious ones', () => {
    expect(syllableCount('go')).toBe(1)
    expect(syllableCount('never')).toBe(2)
    expect(syllableCount('beautiful')).toBe(3)
    expect(syllableCount('remember')).toBe(3)
  })

  it('does not count a silent e', () => {
    expect(syllableCount('make')).toBe(1)
    expect(syllableCount('time')).toBe(1)
  })

  it('never returns zero for a real word', () => {
    for (const word of ['a', 'I', 'rhythm', 'strength']) {
      expect(syllableCount(word)).toBeGreaterThanOrEqual(1)
    }
  })
})

describe('accentsFrom', () => {
  const line = words([
    ['break', 0, 400],
    ['away', 400, 900],
    ['now', 900, 1100]
  ])

  it('gives every word its opening', () => {
    const accents = accentsFrom(line)
    expect(accents.map((a) => a.ms)).toEqual([0, 400, 900])
    expect(accents.every((a) => a.onset)).toBe(true)
  })

  it('splits a held word into syllables when asked', () => {
    const accents = accentsFrom(line, { syllables: true })
    // "away" is two syllables over 500ms, so it earns an inner accent.
    const inner = accents.filter((a) => !a.onset)
    expect(inner).toHaveLength(1)
    expect(inner[0].ms).toBe(650)
  })

  it('rates an inner syllable below the word’s own attack', () => {
    const accents = accentsFrom(line, { syllables: true })
    const word = accents.find((a) => a.text === 'away' && a.onset)!
    const inner = accents.find((a) => a.text === 'away' && !a.onset)!
    expect(inner.punch).toBeLessThan(word.punch)
  })

  it('leaves a short word alone — three moments nobody can tell apart', () => {
    const quick = words([['never', 0, 120]])
    expect(accentsFrom(quick, { syllables: true })).toHaveLength(1)
  })

  it('comes back in order', () => {
    const jumbled = words([
      ['two', 500, 700],
      ['one', 0, 400]
    ])
    expect(accentsFrom(jumbled).map((a) => a.ms)).toEqual([0, 500])
  })
})

describe('planLyricCuts', () => {
  const line = words([
    ['back', 0, 300],
    ['and', 300, 500],
    ['down', 520, 900],
    ['again', 900, 1400],
    ['take', 1420, 1700]
  ])

  it('cuts on the hard words and leaves the soft ones alone', () => {
    const cuts = planLyricCuts(line, { fps: FPS })
    const text = cuts.map((c) => c.text)
    expect(text).toContain('back')
    expect(text).toContain('down')
    expect(text).toContain('take')
    // "and" and "again" open on vowels and have no edge to cut on.
    expect(text).not.toContain('and')
    expect(text).not.toContain('again')
  })

  it('leaves the vocal where it was sung', () => {
    // Beats every 500ms; the words are deliberately a little off them.
    const cuts = planLyricCuts(line, { fps: FPS, analysis: music() })
    const down = cuts.find((c) => c.text === 'down')!
    expect(down.ms).toBe(520)
    expect(down.snapped).toBe(false)
    expect(offGridShare(cuts)).toBeGreaterThan(0.5)
  })

  it('tidies an accent that was already on the beat', () => {
    const onBeat = words([['beat', 1004, 1300]])
    const cuts = planLyricCuts(onBeat, { fps: FPS, analysis: music() })
    // 4ms off a beat is the same moment; a frame is 33ms.
    expect(cuts[0].ms).toBe(1000)
    expect(cuts[0].snapped).toBe(true)
  })

  it('keeps the snap window under a frame, on purpose', () => {
    expect(DEFAULT_SNAP_MS).toBeLessThan(1000 / FPS / 2)
  })

  it('keeps the harder of two accents that collide', () => {
    const crowded = words([
      ['so', 0, 100],
      ['back', 60, 300]
    ])
    const cuts = planLyricCuts(crowded, { fps: FPS, minGapMs: 200 })
    expect(cuts).toHaveLength(1)
    expect(cuts[0].text).toBe('back')
  })

  it('says why each cut is there', () => {
    const cuts = planLyricCuts(line, { fps: FPS })
    for (const cut of cuts) expect(cut.reason).toMatch(/on “|inside “/)
  })

  it('works with no music at all', () => {
    const cuts = planLyricCuts(line, { fps: FPS, analysis: null })
    expect(cuts.length).toBeGreaterThan(1)
    expect(cuts.every((c) => !c.snapped)).toBe(true)
  })
})

describe('the hybrid — lyrics inside planCuts', () => {
  const analysis = music(64)

  it('puts a lyric cut where the word is, not on the beat beside it', () => {
    const plan = planCuts(analysis, {
      fps: FPS,
      lyrics: [{ ms: 2040, punch: 1, text: 'back' }]
    })
    const lyric = plan.find((c) => c.reason === 'lyric')
    expect(lyric).toBeDefined()
    expect(lyric!.ms).toBe(2040)
    // The grid cut that would have sat at 2000 lost the moment, rather than
    // silently replacing the lyric with the mechanical version of itself.
    expect(plan.filter((c) => Math.abs(c.ms - 2040) < 120)).toHaveLength(1)
  })

  it('still lets a drop outrank a word', () => {
    const withDrop: MusicAnalysis = { ...analysis, drops: [{ ms: 4000, score: 1 }] }
    const plan = planCuts(withDrop, {
      fps: FPS,
      lyrics: [{ ms: 4030, punch: 1, text: 'go' }]
    })
    const near = plan.filter((c) => Math.abs(c.ms - 4000) < 120)
    expect(near).toHaveLength(1)
    expect(near[0].reason).toBe('drop')
  })

  it('ignores a word that does not land hard enough', () => {
    const plan = planCuts(analysis, {
      fps: FPS,
      lyrics: [{ ms: 2040, punch: 0.3, text: 'always' }],
      lyricPunch: 0.7
    })
    expect(plan.some((c) => c.reason === 'lyric')).toBe(false)
  })

  it('never dissolves through a lyric cut, even when asked for transitions on everything', () => {
    const plan = planCuts(analysis, {
      fps: FPS,
      transitionsOn: 'all',
      transitionRate: 1,
      lyrics: [
        { ms: 2040, punch: 1, text: 'back' },
        { ms: 3030, punch: 1, text: 'down' }
      ]
    })
    const lyrics = plan.filter((c) => c.reason === 'lyric')
    expect(lyrics.length).toBeGreaterThan(0)
    for (const cut of lyrics) expect(cut.transitionTier).toBeNull()
  })

  it('changes nothing when no lyrics are handed over', () => {
    const without = planCuts(analysis, { fps: FPS })
    const withEmpty = planCuts(analysis, { fps: FPS, lyrics: [] })
    expect(withEmpty).toEqual(without)
  })
})

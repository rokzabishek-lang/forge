import { describe, expect, it } from 'vitest'
import type { MusicAnalysis } from '@shared/automation/cutPlan'
import { ENERGY, PRODUCT_REVEAL, RECIPES, WEDDING_HIGHLIGHT, type Recipe } from '@shared/director/recipes'
import { MIN_SHOT_SECONDS, layout, rhythmGrid, snapIndices, type Layout, type ShotIntent } from '@shared/director/rhythm'

/** The hero's lead, as a literal: a check computed from the constant under test moves with it. */
const LEAD = 1.3

/**
 * The rhythm engine (docs/PLAN.md §5.3): the three cases the plan's review
 * walked by hand, then every invariant over 500 generated ads. The hero rule
 * is checked GLOBALLY — against every other shot, not its neighbours — and on
 * the case the review said a neighbour-only rule misses: the hero last on an
 * accelerating curve.
 */

const fps = 30

function song(bpm: number, seconds: number, extra: Partial<MusicAnalysis> = {}): MusicAnalysis {
  const beatMs = 60_000 / bpm
  const beats: number[] = []
  for (let t = 0; t <= seconds * 1000; t += beatMs) beats.push(Math.round(t))
  return {
    bpm,
    beats,
    downbeats: beats.filter((_, i) => i % 4 === 0),
    tiers: beats.map((b) => (b > seconds * 500 ? 3 : 1)),
    drops: [],
    buildups: [],
    sections: [],
    durationMs: seconds * 1000,
    ...extra
  }
}

const still = (n: number, over: Partial<ShotIntent> = {}): ShotIntent => ({
  slotId: `slot_${String(n).padStart(2, '0')}`, kind: 'image', footageFrames: null, weight: 'normal', face: false, hero: false, headline: '', ...over
})

const spans = (l: Layout): number[] => l.shots.map((s) => s.endFrame - s.startFrame)

/** Every invariant the engine promises, for one ad. */
function invariants(recipe: Recipe, grid: ReturnType<typeof rhythmGrid>, intents: ShotIntent[], l: Layout): void {
  const minShot = Math.round(MIN_SHOT_SECONDS * fps)
  const ctx = `${recipe.id}, ${intents.length} shots, bpm ${Math.round((60 * fps) / grid.beatFrames)}`
  if (l.shots.length === 0) return
  // Contiguous from the start; every shot at least the shortest; never longer than asked.
  expect(l.shots[0].startFrame, ctx).toBe(grid.start)
  for (let i = 1; i < l.shots.length; i++) expect(l.shots[i].startFrame, ctx).toBe(l.shots[i - 1].endFrame)
  for (const s of spans(l)) expect(s, ctx).toBeGreaterThanOrEqual(minShot - 1)
  // A clip's shot is never longer than its footage: no black after it (C0 measured up to 3 s of it).
  for (const s of l.shots) expect(s.clipFrames, `${ctx}: ${s.slotId}`).toBe(s.endFrame - s.startFrame)
  expect(l.endFrame, ctx).toBeLessThanOrEqual(grid.end)
  // Every inner boundary is a beat.
  for (const s of l.shots.slice(1)) expect(grid.beats, ctx).toContain(s.startFrame)
  // The ending follows the body without a gap: black, then the card, then the end.
  const bodyEnd = l.shots.at(-1)!.endFrame
  const cardStart = l.black ? l.black.endFrame : bodyEnd
  if (l.black) expect(l.black.startFrame, ctx).toBe(bodyEnd)
  if (l.endCard) {
    expect(l.endCard.startFrame, ctx).toBe(cardStart)
    expect(l.endCard.endFrame, ctx).toBe(l.endFrame)
    expect(l.endCard.endFrame - l.endCard.startFrame, ctx).toBeGreaterThanOrEqual(Math.round(1.5 * fps) - 1)
  }
  // The hero: longest by LEAD over EVERY other shot, and at its floor — or a note says why not.
  const heroAt = l.shots.findIndex((s) => s.hero)
  const heroSpan = spans(l)[heroAt]
  const others = spans(l).filter((_, i) => i !== heroAt)
  const said = l.notes.some((n) => /hold|too short|footage/.test(n))
  if (others.length > 0 && !said) {
    // One beat of tolerance: the lead is kept in beats, and beats are whole frames.
    expect(heroSpan + grid.beatFrames, ctx).toBeGreaterThanOrEqual(LEAD * Math.max(...others))
    expect(heroSpan + grid.beatFrames, ctx).toBeGreaterThanOrEqual(Math.min(recipe.hold.heroMinSeconds * fps, bodyEnd - grid.start))
  }
  // Moments: within budget, never on the hook's exit, never within a bar of each other, never where a transition is.
  expect(l.moments.length, ctx).toBeLessThanOrEqual(recipe.moments.budget)
  const bar = grid.beatFrames * 4
  for (const m of l.moments) {
    expect(m.frame, ctx).not.toBe(l.shots[1]?.startFrame)
    for (const o of l.moments) if (o !== m) expect(Math.abs(o.frame - m.frame), ctx).toBeGreaterThanOrEqual(bar - 1)
    for (const t of l.transitions) expect(l.shots[t.shot].startFrame, ctx).not.toBe(m.frame)
  }
  // Treatments: never the hook, the hero or the last shot.
  expect(l.treatments.length, ctx).toBeLessThanOrEqual(recipe.treatments.budget)
  for (const t of l.treatments) expect([0, heroAt, l.shots.length - 1], ctx).not.toContain(t.shot)
  // Hits: at most the recipe's number, none within a bar of another.
  const hits = l.sounds.filter((s) => s.event === 'hit' || (s.event === 'sub' && recipe.sound.rules.some((r) => r.event === 'sub' && r.on === 'drop')))
  expect(hits.length, ctx).toBeLessThanOrEqual(Math.max(recipe.sound.maxHits, 1))
  // Cards: inside their shots, at most maxCards.
  expect(l.cards.length, ctx).toBeLessThanOrEqual(recipe.type.maxCards)
  for (const c of l.cards) {
    expect(c.startFrame, ctx).toBe(l.shots[c.shot].startFrame)
    expect(c.endFrame, ctx).toBeLessThanOrEqual(l.shots[c.shot].endFrame)
  }
}

describe('the three worked cases', () => {
  it('a wedding: six photos, 30 s at 100 BPM, the hero fourth — the hero holds six seconds and leads every shot', () => {
    const grid = rhythmGrid(song(100, 30), { fps, seconds: 30, tempo: WEDDING_HIGHLIGHT.tempo })
    const intents = [1, 2, 3, 4, 5, 6].map((n) => still(n, { hero: n === 4, face: n === 4 || n === 2, headline: n === 1 ? 'Priya & Arjun' : '' }))
    const l = layout(WEDDING_HIGHLIGHT, grid, intents)
    invariants(WEDDING_HIGHLIGHT, grid, intents, l)
    const heroSpan = spans(l)[3]
    expect(heroSpan).toBeGreaterThanOrEqual(6 * fps)
    for (const [i, s] of spans(l).entries()) if (i !== 3) expect(heroSpan).toBeGreaterThanOrEqual(LEAD * s - grid.beatFrames)
    // Black two beats (1.2 s), end card three seconds.
    expect(l.black!.endFrame - l.black!.startFrame).toBe(Math.round(2 * grid.beatFrames))
    expect(l.endCard!.endFrame - l.endCard!.startFrame).toBeGreaterThanOrEqual(3 * fps)
    expect(l.dropped).toEqual([])
    expect(l.cards).toHaveLength(1)
  })

  it('an Energy ad: twelve stills, 10 s at 160 BPM, the hero LAST — shots go, the hero still leads the early ones', () => {
    const drops = [{ ms: 5000, score: 0.9 }]
    const grid = rhythmGrid(song(160, 10, { drops }), { fps, seconds: 10, tempo: ENERGY.tempo })
    const intents = Array.from({ length: 12 }, (_, i) => still(i + 1, { hero: i === 11 }))
    const l = layout(ENERGY, grid, intents)
    invariants(ENERGY, grid, intents, l)
    expect(l.shots.at(-1)!.hero).toBe(true)
    expect(l.shots[0].slotId).toBe('slot_01')
    expect(spans(l).at(-1)!).toBeGreaterThanOrEqual(LEAD * spans(l)[0] - grid.beatFrames)
    expect(l.shots.length).toBeLessThanOrEqual(12)
    if (l.dropped.length > 0) expect(l.dropped.every((d) => d.slotId !== 'slot_01' && d.slotId !== 'slot_12')).toBe(true)
  })

  it('a product reveal: three photos and a 4 s clip, 15 s, no looks — the clip is never longer than its footage', () => {
    const grid = rhythmGrid(song(100, 15), { fps, seconds: 15, tempo: PRODUCT_REVEAL.tempo })
    const intents = [still(1, { hero: true, headline: 'Aura' }), still(2), still(3), { ...still(4), kind: 'video' as const, footageFrames: 4 * fps }]
    const l = layout(PRODUCT_REVEAL, grid, intents)
    invariants(PRODUCT_REVEAL, grid, intents, l)
    const clip = l.shots.find((s) => s.slotId === 'slot_04')!
    expect(clip.endFrame - clip.startFrame).toBeLessThanOrEqual(4 * fps)
    // The hero is the first still, and it leads.
    expect(l.shots[0].hero).toBe(true)
  })
})

describe('the ending and the edges', () => {
  it('a song too short for the recipe’s black cuts straight to the end card, and says so', () => {
    const grid = rhythmGrid(song(100, 5), { fps, seconds: 5, tempo: 100 })
    const l = layout(PRODUCT_REVEAL, grid, [still(1, { hero: true }), still(2)])
    expect(l.black).toBeNull()
    expect(l.notes.join(' ')).toMatch(/black/)
  })

  it('a long song and few shots: the ad ends early, on a beat, and says so', () => {
    const grid = rhythmGrid(song(100, 60), { fps, seconds: 60, tempo: 100 })
    const l = layout(PRODUCT_REVEAL, grid, [still(1), still(2, { hero: true }), still(3)])
    expect(l.endFrame).toBeLessThan(grid.end)
    expect(grid.beats).toContain(l.endFrame)
    expect(l.notes.join(' ')).toMatch(/ends at/)
  })

  it('no music: the recipe’s tempo is the grid', () => {
    const grid = rhythmGrid(null, { fps, seconds: 12, tempo: 120 })
    expect(grid.beatFrames).toBeCloseTo(15, 5)
    expect(grid.beats[1] - grid.beats[0]).toBe(15)
    const l = layout(WEDDING_HIGHLIGHT, grid, [still(1), still(2, { hero: true })])
    invariants(WEDDING_HIGHLIGHT, grid, [still(1), still(2, { hero: true })], l)
  })

  it('a structural beat within half a beat of the target wins', () => {
    // A section at 2.1 s on a 120 BPM grid (0.5 s beats): the cut lands on it.
    const grid = rhythmGrid(song(120, 20, { sections: [2100] }), { fps, seconds: 20, tempo: 120 })
    const section = [...grid.structural.keys()][0]
    expect(grid.structural.get(section)!.reason).toBe('section')
    expect(grid.beats).toContain(section)
  })

  it('the dropped shot is the softest without a headline — never the hook or the hero', () => {
    const grid = rhythmGrid(song(160, 6), { fps, seconds: 6, tempo: 160 })
    const intents = [
      still(1, { sharpness: 10 }),
      // The softest of all, but it carries a headline: a shot without one goes first.
      still(2, { sharpness: 1, headline: 'keep me' }),
      still(3, { sharpness: 5 }),
      still(4, { sharpness: 800 }),
      still(5, { hero: true, sharpness: 1 }),
      ...Array.from({ length: 10 }, (_, i) => still(6 + i, { sharpness: 500 }))
    ]
    const l = layout(ENERGY, grid, intents)
    expect(l.dropped.length).toBeGreaterThan(0)
    expect(l.dropped[0].slotId).toBe('slot_03')
    expect(l.dropped.map((d) => d.slotId)).not.toContain('slot_01')
    expect(l.dropped.map((d) => d.slotId)).not.toContain('slot_05')
    expect(l.dropped.map((d) => d.slotId)).not.toContain('slot_02')
  })

  it('a structural beat one beat from the target wins the cut; without one, the nearest beat does', () => {
    const grid = rhythmGrid(song(120, 20, { sections: [2500] }), { fps, seconds: 20, tempo: 120 })
    const section = grid.beats.indexOf([...grid.structural.keys()][0])
    expect(section).toBe(5)
    // A first shot of 4.2 beats: nearest beat 4, the section at 5 is within one — it wins.
    expect(snapIndices(grid, [4.2, 6], 10, 1, [Infinity, Infinity])[0]).toBe(5)
    // The same without the section: the nearest beat.
    const plain = rhythmGrid(song(120, 20), { fps, seconds: 20, tempo: 120 })
    expect(snapIndices(plain, [4.2, 6], 10, 1, [Infinity, Infinity])[0]).toBe(4)
    // Never past a clip's footage, even when the target is.
    expect(snapIndices(plain, [6.8, 4], 10, 1, [5, Infinity])[0]).toBe(5)
  })

  it('hits: at most the recipe\u2019s number, and never two within a bar', () => {
    // Six drops two seconds apart, and two more half a beat apart.
    const drops = [3000, 5000, 7000, 9000, 11000, 13000, 13250].map((ms) => ({ ms, score: 0.9 }))
    const grid = rhythmGrid(song(120, 20, { drops }), { fps, seconds: 20, tempo: 120 })
    const intents = Array.from({ length: 12 }, (_, i) => still(i + 1, { hero: i === 6 }))
    const l = layout(ENERGY, grid, intents)
    const hits = l.sounds.filter((s) => s.event === 'hit')
    expect(hits.length).toBeLessThanOrEqual(ENERGY.sound.maxHits)
    expect(hits.length).toBeGreaterThan(0)
    for (const a of hits) for (const b of hits) if (a !== b) expect(Math.abs(a.frame - b.frame)).toBeGreaterThanOrEqual(4 * grid.beatFrames - 1)
  })

  it('with footage in the ad, transitions go only on structural cuts', () => {
    const grid = rhythmGrid(song(120, 20, { sections: [6000], drops: [{ ms: 12000, score: 0.9 }] }), { fps, seconds: 20, tempo: 120 })
    const intents = [still(1), still(2), { ...still(3), kind: 'video' as const, footageFrames: 150 }, still(4, { hero: true }), still(5), still(6)]
    const l = layout(WEDDING_HIGHLIGHT, grid, intents)
    for (const t of l.transitions) expect(grid.structural.has(l.shots[t.shot].startFrame)).toBe(true)
    // Stills only: a share of the boundaries, structural or not.
    const stills = layout(WEDDING_HIGHLIGHT, grid, intents.map((x) => ({ ...x, kind: 'image' as const, footageFrames: null })))
    expect(stills.transitions.length).toBeGreaterThan(l.transitions.length)
  })

  it('the grid never runs past the length asked, with or without music', () => {
    for (const analysis of [song(97, 40), null]) {
      const grid = rhythmGrid(analysis, { fps, seconds: 15, offsetFrames: 60, tempo: 100 })
      expect(grid.end).toBeLessThanOrEqual(60 + 15 * fps)
      expect(grid.start).toBe(60)
      expect(grid.end).toBeGreaterThan(60 + 14 * fps)
    }
  })
})

describe('500 generated ads', () => {
  it('keep every invariant, for every recipe, with the hero anywhere — including last on an accelerating curve', () => {
    let seed = 20260923
    const rand = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed / 0x7fffffff
    }
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]
    let excused = 0
    const heroSeconds: number[] = []
    for (let run = 0; run < 500; run++) {
      const recipe = pick(RECIPES)
      const bpm = 80 + Math.round(rand() * 90)
      const seconds = 8 + Math.round(rand() * 32)
      const n = 1 + Math.floor(rand() * 12)
      // One run in five puts the hero last, which is where a neighbour-only rule fails.
      const heroAt = run % 5 === 0 ? n - 1 : Math.floor(rand() * n)
      const drops = rand() < 0.5 ? [{ ms: Math.round(seconds * 1000 * (0.3 + rand() * 0.4)), score: 0.8 }] : []
      const grid = rhythmGrid(song(bpm, seconds, { drops }), { fps, seconds, tempo: recipe.tempo })
      const intents = Array.from({ length: n }, (_, i) =>
        still(i + 1, {
          hero: i === heroAt,
          weight: pick(['quick', 'normal', 'hold'] as const),
          face: rand() < 0.3,
          headline: rand() < 0.4 ? 'A short line' : '',
          sharpness: Math.round(rand() * 1000),
          ...(rand() < 0.15 ? { kind: 'video' as const, footageFrames: Math.round((1 + rand() * 6) * fps) } : {})
        })
      )
      const l = layout(recipe, grid, intents)
      invariants(recipe, grid, intents, l)
      const heroIntent = intents.find((x) => x.hero)!
      const clipHeroTooShort = heroIntent.kind === 'video' && (heroIntent.footageFrames ?? 0) < recipe.hold.heroMinSeconds * fps
      if (l.shots.length > 1 && !clipHeroTooShort && l.notes.some((n) => /hold|too short|footage/.test(n))) excused++
      heroSeconds.push((l.shots.find((s) => s.hero)!.endFrame - l.shots.find((s) => s.hero)!.startFrame) / fps)
    }
    // The hero rule's escape (a note that the music could not give it more) is for songs too short
    // for the recipe — rare. If it became the norm the sweep would prove nothing.
    // A clip hero shorter than the recipe's hold is excused honestly and not counted; everything
    // else excused is a song too short for its shots, which the generator makes only now and then.
    expect(excused, `${excused} of 500 excused`).toBeLessThan(25)
    expect(heroSeconds.filter((s) => s >= 2).length).toBeGreaterThan(400)
  })
})

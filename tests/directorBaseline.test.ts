import { describe, it, expect } from 'vitest'
import { baselineSlots, baselineSpine, fitHeadline, paceFor } from '@shared/director/baseline'
import { buildCutMenu, familyMenu, type Menu, type Slot } from '@shared/director/menu'
import type { Brief } from '@shared/director/schema'
import { validateSpine } from '@shared/director/validate'
import { TRANSITIONS } from '@shared/transitions/registry'
import type { MusicAnalysis } from '@shared/automation/cutPlan'

const fps = 30

function music(bpm = 120, seconds = 30, over: Partial<MusicAnalysis> = {}): MusicAnalysis {
  const beatMs = 60_000 / bpm
  const beats: number[] = []
  for (let t = 0; t < seconds * 1000; t += beatMs) beats.push(Math.round(t))
  return {
    bpm,
    beats,
    downbeats: beats.filter((_, i) => i % 4 === 0),
    tiers: beats.map((_, i) => (i % 16 >= 12 ? 3 : 1)),
    drops: [{ ms: Math.round(seconds * 500), score: 0.9 }],
    buildups: [],
    sections: [],
    durationMs: seconds * 1000,
    ...over
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

const brief: Brief = {
  product: 'Lumen serum',
  benefit: 'Glow in seven days without the sting',
  audience: 'women 25-40',
  tone: 'energetic',
  cta: 'Shop the serum today',
  seconds: 30,
  language: 'English'
}

function menuOf(slots: Slot[], analysis: MusicAnalysis | null, seconds = 30): Menu {
  return {
    slots,
    cuts: buildCutMenu(analysis, { fps, seconds }),
    families: familyMenu(TRANSITIONS),
    seconds,
    fps
  }
}

describe('baselineSpine', () => {
  it('validates against every menu — that is the whole point of it', () => {
    for (let count = 1; count <= 12; count++) {
      for (const analysis of [music(), music(96, 45), null]) {
        for (const withVideo of [false, true]) {
          const slots = Array.from({ length: count }, (_, i) =>
            withVideo && i === 1 ? slot(i + 1, { kind: 'video', seconds: 1.5, frames: 45 }) : slot(i + 1)
          )
          const menu = menuOf(slots, analysis)
          const plan = baselineSpine(brief, menu)
          const verdict = validateSpine(plan, menu)
          expect(verdict, `${count} slots, ${analysis ? analysis.bpm : 'no'} music, video ${withVideo}`).not.toHaveProperty(
            'rejected'
          )
          if (!withVideo && 'problems' in verdict) {
            expect(verdict.problems, `${count} slots, ${analysis ? analysis.bpm : 'no'} music`).toEqual([])
          }
        }
      }
    }
  })

  it('opens with a hook and closes with the call to action, in the user\'s order', () => {
    const menu = menuOf([slot(1), slot(2), slot(3), slot(4)], music())
    const plan = baselineSpine(brief, menu)
    expect(plan.segments.map((s) => s.role)).toEqual(['hook', 'problem', 'product', 'cta'])
    expect(plan.segments.map((s) => s.slot)).toEqual(['slot_01', 'slot_02', 'slot_03', 'slot_04'])
    expect(plan.segments[plan.segments.length - 1].ends_at).toBe('cut_end')
    expect(plan.segments[0].enter).toBe('cut')
    expect(plan.pace).toBe('punchy')
  })

  it('writes the copy from the brief, fitted to the time each card has', () => {
    const menu = menuOf([slot(1), slot(2), slot(3)], music())
    const plan = baselineSpine(brief, menu)
    const [hook, product, cta] = plan.segments
    expect(hook.headline.length).toBeGreaterThan(0)
    expect(brief.benefit.startsWith(hook.headline)).toBe(true)
    expect(product.headline).toBe('Lumen serum')
    expect(cta.headline).toBe('Shop the serum today')
    // The punch word is a word of its own headline.
    for (const s of plan.segments) {
      if (s.headline) expect(s.headline.split(' ')).toContain(s.punch_word)
    }
  })

  it('uses at most six pictures, keeping the last for the close', () => {
    const many = Array.from({ length: 10 }, (_, i) => slot(i + 1))
    expect(baselineSlots(many).map((s) => s.id)).toEqual([
      'slot_01',
      'slot_02',
      'slot_03',
      'slot_04',
      'slot_05',
      'slot_10'
    ])
    const plan = baselineSpine(brief, menuOf(many, music()))
    expect(plan.segments).toHaveLength(6)
    expect(plan.segments[5].slot).toBe('slot_10')
    expect(plan.segments[5].role).toBe('cta')
  })

  it('does not give a clip a longer segment than its footage when a cut inside it exists', () => {
    const menu = menuOf([slot(1), slot(2, { kind: 'video', seconds: 2, frames: 60 }), slot(3), slot(4)], music())
    const plan = baselineSpine(brief, menu)
    const verdict = validateSpine(plan, menu)
    expect(verdict).not.toHaveProperty('rejected')
    if ('layout' in verdict) {
      expect(verdict.layout[1].capped).toBe(false)
      expect(verdict.layout[1].endFrame - verdict.layout[1].startFrame).toBeLessThanOrEqual(60)
    }
  })

  it('uses only a shot per available cut when there are fewer cuts than pictures', () => {
    const menu = menuOf([slot(1), slot(2), slot(3), slot(4), slot(5)], null, 4.5)
    // 0, 2.2, end — two places to end a shot.
    expect(menu.cuts).toHaveLength(3)
    const plan = baselineSpine(brief, menu)
    expect(plan.segments).toHaveLength(2)
    expect(validateSpine(plan, menu)).not.toHaveProperty('rejected')
  })
})

describe('fitHeadline', () => {
  it('keeps a line that fits and cuts a long one at a word, never mid-word', () => {
    expect(fitHeadline('Glow in 7 days', 3)).toBe('Glow in 7 days')
    // Half a second holds nineteen characters.
    expect(fitHeadline('Glow in seven days without the sting', 0.5)).toBe('Glow in seven days')
    expect(fitHeadline('Supercalifragilisticexpialidocious serum', 0.5)).toBe('')
    expect(fitHeadline('  spaced   out  ', 3)).toBe('spaced out')
  })
})

describe('paceFor', () => {
  it('maps tone onto energy', () => {
    expect(paceFor('energetic')).toBe('punchy')
    expect(paceFor('urgent')).toBe('punchy')
    expect(paceFor('premium')).toBe('calm')
    expect(paceFor('calm')).toBe('calm')
    expect(paceFor('playful')).toBe('steady')
  })
})

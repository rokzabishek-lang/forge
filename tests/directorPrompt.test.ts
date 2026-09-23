import { describe, it, expect } from 'vitest'
import { PLAYBOOK, languageLine, maxTokensFor, spinePrompt } from '@shared/director/prompt'
import { buildCutMenu, familyMenu, type Menu, type Slot } from '@shared/director/menu'
import { DEFAULT_MAX_TOKENS } from '@shared/director/provider'
import type { Brief } from '@shared/director/schema'
import { TRANSITIONS } from '@shared/transitions/registry'
import type { MusicAnalysis } from '@shared/automation/cutPlan'

const fps = 30

function music(seconds = 30): MusicAnalysis {
  const beats: number[] = []
  for (let t = 0; t < seconds * 1000; t += 500) beats.push(t)
  return {
    bpm: 120,
    beats,
    downbeats: beats.filter((_, i) => i % 4 === 0),
    tiers: beats.map(() => 1),
    drops: [{ ms: 14_000, score: 0.9 }],
    buildups: [],
    sections: [],
    durationMs: seconds * 1000
  }
}

const slots: Slot[] = [
  { id: 'slot_01', assetId: 'a', kind: 'image', label: 'IMG 4021', note: 'serum bottle on marble', speech: '', seconds: null, frames: null },
  { id: 'slot_02', assetId: 'b', kind: 'video', label: 'unboxing', note: '', speech: 'So I finally got the serum…', seconds: 4.2, frames: 126 },
  { id: 'slot_03', assetId: 'c', kind: 'image', label: 'result', note: '', speech: '', seconds: null, frames: null }
]

const brief: Brief = {
  product: 'Lumen serum',
  benefit: 'Glow in seven days',
  audience: 'women 25-40',
  tone: 'premium',
  cta: 'Shop now',
  seconds: 15,
  language: 'Telugu'
}

const menu: Menu = {
  slots,
  cuts: buildCutMenu(music(), { fps, seconds: 15 }),
  families: familyMenu(TRANSITIONS),
  seconds: 15,
  fps
}

describe('spinePrompt', () => {
  const { system, user } = spinePrompt(brief, menu)

  it('keeps the playbook static, so a server can cache the prefix', () => {
    expect(system).toBe(PLAYBOOK)
    expect(spinePrompt({ ...brief, product: 'Other' }, menu).system).toBe(PLAYBOOK)
    // Roughly the budget the design set: a few hundred tokens, not a chapter.
    expect(system.length).toBeLessThan(2600)
  })

  it('puts every id the model may use in front of it', () => {
    for (const s of menu.slots) expect(user).toContain(s.id)
    for (const c of menu.cuts) expect(user).toContain(c.id)
    for (const f of menu.families) expect(user).toContain(`${f.id} —`)
  })

  it('carries the brief, the notes, the speech and the clip length', () => {
    expect(user).toContain('Lumen serum')
    expect(user).toContain('Glow in seven days')
    expect(user).toContain('serum bottle on marble')
    expect(user).toContain('says: "So I finally got the serum…"')
    expect(user).toContain('video 4.2 s')
    expect(user).toContain('language for all copy: Telugu')
    expect(user).toContain('tone: premium')
  })

  it('shows what the eyes found beside each slot: the look, and a measured flag', () => {
    const seen: Menu = {
      ...menu,
      slots: [
        { ...slots[0], look: { people: 'none', shot: 'detail', mood: 'clean', product_visible: 'yes', hero: 'strong', words: 'amber bottle on white marble' } },
        { ...slots[1] },
        { ...slots[2], flags: ['soft', 'dark'] }
      ]
    }
    const text = spinePrompt(brief, seen).user
    expect(text).toContain('slot_01  image  "IMG 4021"  — serum bottle on marble  — shows: none, detail, clean, strong: "amber bottle on white marble"')
    expect(text).toMatch(/slot_03 {2}image {2}"result" {2}— measured soft, dark\n/)
    expect(text).not.toMatch(/slot_02[^\n]*shows:/)
    expect(PLAYBOOK).toContain('"measured soft", "dark" or "blown" is never the hook or the product')
  })

  it('asks for the copy in the language’s own script, last, where it is read', () => {
    /*
     * Measured (docs/EVAL.md 2026-09-23): the brief line alone got 0 of 24
     * Telugu and Hindi headlines in their language; the rule plus this line
     * got 24 of 24. The line is the last instruction before the answer.
     */
    const lines = user.trim().split('\n')
    expect(lines.at(-2)).toBe('Write all copy in Telugu, in Telugu script (తెలుగు) — a Telugu headline looks like "రుచి అదిరింది".')
    expect(lines.at(-1)).toBe('Answer with the JSON plan.')
    expect(PLAYBOOK).toMatch(/own script — never English when another language is asked, never transliterated/)
  })

  it('says nothing more for English, and names any other language even without a known script', () => {
    const english = spinePrompt({ ...brief, language: 'English' }, menu).user.trim().split('\n')
    expect(english.at(-2)).toBe('')
    expect(languageLine('english')).toBeNull()
    expect(languageLine(' ')).toBeNull()
    expect(languageLine('Hindi')).toContain('Devanagari (हिन्दी)')
    expect(languageLine('Odia')).toBe('Write all copy in Odia, in its own script.')
  })

  it('states the target and where the ad actually ends, naming a drop it lands on', () => {
    const end = menu.cuts[menu.cuts.length - 1]
    expect(end.landsOn).toBe('drop')
    expect(user).toContain('target length: 15.0 s')
    expect(user).toContain(`ends at cut_end (${(end.ms / 1000).toFixed(1)} s), which is a drop`)
    expect(user).toContain('end (drop)')
  })

  it('never leaks an undefined into the text', () => {
    expect(user).not.toContain('undefined')
    expect(user).not.toContain('null')
    const bare = spinePrompt({ ...brief, benefit: '', audience: '', cta: '' }, menu).user
    expect(bare).not.toContain('benefit:')
    expect(bare).not.toContain('audience:')
    expect(bare).not.toContain('call to action:')
  })
})

describe('maxTokensFor', () => {
  it('grows with the menu and holds a full twelve-segment plan', () => {
    const one = maxTokensFor({ slots: slots.slice(0, 1) })
    const three = maxTokensFor({ slots })
    const twelve = maxTokensFor({ slots: Array.from({ length: 12 }, () => slots[0]) })
    expect(three).toBeGreaterThan(one)
    expect(twelve).toBeGreaterThanOrEqual(1200)
    // The schema caps segments at twelve, so more slots cost no more room.
    expect(maxTokensFor({ slots: Array.from({ length: 20 }, () => slots[0]) })).toBe(twelve)
    expect(DEFAULT_MAX_TOKENS).toBeGreaterThanOrEqual(twelve)
  })
})

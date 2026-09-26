import { describe, expect, it } from 'vitest'
import type { MusicAnalysis } from '@shared/automation/cutPlan'
import { emptyProject, type MediaAsset, type Project } from '@shared/timeline'
import { ENERGY, FASHION, PRODUCT_REVEAL, WEDDING_HIGHLIGHT, type Recipe } from '@shared/director/recipes'
import { rhythmGrid, type Layout } from '@shared/director/rhythm'
import type { Composed } from '@shared/director/compose'
import { cohere, intensityFor } from '@shared/director/coherence'
import { applyRecipe, decisionFor2, moveAmount } from '@shared/director/apply2'
import { COPY_RULE, LOOK_RULE, SPINE_RULE } from '@shared/director/apply'
import { buildSlots } from '@shared/director/menu'
import type { Menu2, Shot2 } from '@shared/director/schema2'
import type { Brief } from '@shared/director/schema'

/**
 * Coherence (docs/PLAN.md §5.4): one intensity moves every dial together, and
 * every row of the clash table the rhythm engine and the validator do not
 * already guarantee is repaired, with a note.
 */

const fps = 30

function song(bpm: number, seconds: number): MusicAnalysis {
  const beatMs = 60_000 / bpm
  const beats: number[] = []
  for (let t = 0; t <= seconds * 1000; t += beatMs) beats.push(Math.round(t))
  // Quiet first half, loud second half — so "the quieter cut" is a real question.
  return { bpm, beats, downbeats: beats.filter((_, i) => i % 4 === 0), tiers: beats.map((b) => (b > seconds * 500 ? 3 : 1)), drops: [], buildups: [], sections: [], durationMs: seconds * 1000 }
}
const grid = rhythmGrid(song(120, 20), { fps, seconds: 20, tempo: 120 })
const beat = grid.beatFrames

const shot = (slot: string, over: Partial<Shot2> = {}): Shot2 => ({ slot, role: 'story', weight: 'normal', move: 'in', speed: 'normal', headline: '', punch_word: '', why: 'x', ...over })

/** Four shots of four beats each; slot_03 is a clip. */
function composed(recipe: Recipe, over: { shots?: Shot2[]; style?: string; layout?: Partial<Layout> } = {}): Composed {
  const shots = over.shots ?? [shot('slot_01', { role: 'hook' }), shot('slot_02', { move: 'inLeft' }), shot('slot_03'), shot('slot_04', { move: 'inRight' })]
  const laid = shots.map((s, i) => ({ slotId: s.slot, startFrame: Math.round(i * 4 * beat), endFrame: Math.round((i + 1) * 4 * beat), clipFrames: Math.round(4 * beat), hero: s.slot === 'slot_02' }))
  return {
    plan: { reasoning: 'r', recipe: recipe.id, hero: 'slot_02', style: over.style ?? recipe.type.styles[0], animation: recipe.type.animations[0], shots },
    recipe,
    layout: { shots: laid, dropped: [], black: null, endCard: null, transitions: [], moments: [], treatments: [], sounds: [], cards: [], notes: [], endFrame: laid.at(-1)!.endFrame, ...over.layout },
    problems: []
  }
}
const menu = { slots: ['slot_01', 'slot_02', 'slot_03', 'slot_04'].map((id) => ({ id, kind: id === 'slot_03' ? ('video' as const) : ('image' as const) })) } as unknown as Pick<Menu2, 'slots'>
const tone = { tone: 'premium' as const }
const notes = (c: { problems: { message: string }[] }): string => c.problems.map((p) => p.message).join(' | ')

describe('one intensity per ad', () => {
  it('is the recipe’s, nudged by the tone and clamped', () => {
    expect(intensityFor(ENERGY, 'energetic')).toBeCloseTo(1, 9)
    expect(intensityFor(WEDDING_HIGHLIGHT, 'calm')).toBeCloseTo(0.25, 9)
    expect(intensityFor(FASHION, 'premium')).toBeCloseTo(0.15, 9)
    expect(intensityFor(PRODUCT_REVEAL, 'playful')).toBeCloseTo(0.5, 9)
    expect(intensityFor({ ...ENERGY, intensity: 0.95 }, 'urgent')).toBe(1)
    expect(intensityFor({ ...FASHION, intensity: 0.05 }, 'calm')).toBe(0)
    expect(cohere(composed(ENERGY), grid, { tone: 'urgent' }, menu).intensity).toBeCloseTo(1, 9)
  })

  it('moves every dial together — the camera, the look, the type and the decision C3 and C4 read', () => {
    const asset = (id: string, kind: MediaAsset['kind'] = 'image'): MediaAsset => ({
      id, path: `/m/${id}`, name: id, kind, durationFrames: 300, width: 1080, height: 1920, fps: kind === 'video' ? 30 : null, hasVideo: true, hasAudio: false, size: 1
    })
    const p: Project = { ...emptyProject(), settings: { ...emptyProject().settings, width: 1080, height: 1920, fps }, assets: [asset('a'), asset('b'), asset('c', 'video'), asset('d')] }
    const m = { ...menu, slots: buildSlots(p) } as unknown as Menu2
    const brief: Brief = { product: 'Aura', benefit: '', audience: '', tone: 'premium', cta: 'Shop now', seconds: 20, language: 'English' }
    const withCard = composed(ENERGY, { shots: [shot('slot_01', { role: 'hook', headline: 'Aura' }), shot('slot_02'), shot('slot_03'), shot('slot_04', { move: 'inRight' })] })
    withCard.layout.cards = [{ shot: 0, startFrame: 0, endFrame: Math.round(3 * beat) }]
    const dials = (intensity: number): number[] => {
      const a = applyRecipe(p, { ...withCard, intensity }, m, { fps, videoTrackId: 'v1', brief, model: 'm', catalogue: [], lookFile: { file: '/l.cube', name: 'L' }, newId: (x) => `${x}-${Math.random()}` })
      const first = a.project.clips.find((c) => c.generatedBy?.rule === SPINE_RULE && c.start === 0)!
      const look = a.project.clips.find((c) => c.generatedBy?.rule === LOOK_RULE)!
      const card = a.project.clips.find((c) => c.generatedBy?.rule === COPY_RULE)!
      const op = decisionFor2({ ...withCard, intensity }, { id: 'm', runtime: 'r' }).ops[0] as { intensity: number }
      return [first.motion!.amount, look.color!.lut!.intensity, card.text!.size, op.intensity]
    }
    const calm = dials(0.2)
    const loud = dials(0.9)
    for (const [i, name] of ['the camera move', 'the look', 'the type', 'the decision'].entries()) expect(loud[i], name).toBeGreaterThan(calm[i])
    expect(calm[0]).toBeCloseTo(moveAmount(0.2), 9)
  })
})

describe('the clash table', () => {
  it('a whip beside a slowed or ramped shot becomes a cut, and takes its whoosh with it', () => {
    const c = composed(ENERGY, {
      shots: [shot('slot_01'), shot('slot_02'), shot('slot_03', { speed: 'ramp' }), shot('slot_04', { move: 'inRight' })],
      layout: { transitions: [{ shot: 2, family: 'whip' }, { shot: 3, family: 'whip' }, { shot: 1, family: 'zoom' }] }
    })
    c.layout.sounds = [{ event: 'whoosh', frame: c.layout.shots[2].startFrame }, { event: 'whoosh', frame: c.layout.shots[3].startFrame + 1000 }]
    const out = cohere(c, grid, tone, menu)
    // Into the ramp and out of it: both whips are cuts now; the zoom elsewhere stays.
    expect(out.layout.transitions).toEqual([{ shot: 1, family: 'zoom' }])
    expect(out.layout.sounds.map((s) => s.frame)).not.toContain(c.layout.shots[2].startFrame)
    expect(notes(out)).toMatch(/whip beside a ramp shot/)
  })

  it('no glitch over a warm look — the recipe’s first calm family; and no glitch type either', () => {
    const warm = { ...ENERGY, look: 'warm-film' }
    const out = cohere(composed(warm, { style: 'glitch', layout: { transitions: [{ shot: 1, family: 'glitch' }] } }), grid, tone, menu)
    expect(out.layout.transitions).toEqual([{ shot: 1, family: 'whip' }])
    expect(out.plan.style).toBe('poster-3d')
    // The same glitch under Energy's own teal-orange look is Energy's business.
    const own = cohere(composed(ENERGY, { style: 'glitch', layout: { transitions: [{ shot: 1, family: 'glitch' }] } }), grid, tone, menu)
    expect(own.layout.transitions[0].family).toBe('glitch')
    expect(own.plan.style).toBe('glitch')
  })

  it('chrome, flames and neon type are never a wedding’s', () => {
    for (const style of ['chrome', 'chrome-script', 'flames', 'neon-green']) {
      expect(cohere(composed(WEDDING_HIGHLIGHT, { style }), grid, tone, menu).plan.style, style).toBe('soft-fade')
    }
    expect(cohere(composed(WEDDING_HIGHLIGHT, { style: 'clean' }), grid, tone, menu).plan.style).toBe('clean')
  })

  it('the same move on two stills in a row: the second takes the recipe’s next move; a clip or the hero between them is not a repeat', () => {
    const repeat = composed(ENERGY, { shots: [shot('slot_01', { move: 'inLeft' }), shot('slot_02', { move: 'in' }), shot('slot_03', { move: 'in' }), shot('slot_04', { move: 'in' })] })
    // slot_02 is the hero and slot_03 a clip, so no two STILLS in a row repeat.
    expect(cohere(repeat, grid, tone, menu).plan.shots.map((s) => s.move)).toEqual(['inLeft', 'in', 'in', 'in'])
    const stills = { slots: menu.slots.map((s) => ({ ...s, kind: 'image' })) } as unknown as Pick<Menu2, 'slots'>
    const out = cohere(repeat, grid, tone, stills)
    // slot_02 is the hero (its move is the recipe's heroMove); slot_03 and slot_04 repeat — slot_04 takes the next.
    expect(out.plan.shots.map((s) => s.move)).toEqual(['inLeft', 'in', 'in', 'inLeft'])
    expect(notes(out)).toMatch(/would repeat "in"/)
    expect(repeat.plan.shots[3].move).toBe('in')
  })

  it('a hit and a whoosh within a bar: the quieter cut’s goes — on a tie, the whoosh', () => {
    const quiet = Math.round(8 * beat)
    const loud = Math.round(24 * beat)
    const c = (hit: number, whoosh: number): Composed => {
      const x = composed(ENERGY)
      x.layout.sounds = [{ event: 'hit', frame: hit }, { event: 'whoosh', frame: whoosh }]
      return x
    }
    // Both on the loud half: a tie, and the whoosh goes — the hit is the one the music asked for.
    expect(cohere(c(loud, loud - Math.round(beat)), grid, tone, menu).layout.sounds.map((s) => s.event)).toEqual(['hit'])
    // The whoosh on a louder cut than the hit: the hit goes.
    const half = Math.round(20 * beat)
    expect(cohere(c(half - Math.round(beat), half + Math.round(beat)), grid, tone, menu).layout.sounds.map((s) => s.event)).toEqual(['whoosh'])
    // A bar apart: both stay.
    expect(cohere(c(quiet, quiet + Math.round(4 * beat)), grid, tone, menu).layout.sounds).toHaveLength(2)
  })

  it('is what settle2 lands — the app and the eval both get a coherent ad', async () => {
    const { settle2, gridsFor, menu2For } = await import('@shared/director/run')
    const p: Project = { ...emptyProject(), settings: { ...emptyProject().settings, width: 1080, height: 1920, fps } }
    const photos = ['a', 'b', 'c', 'd'].map((id): MediaAsset => ({ id, path: `/m/${id}`, name: id, kind: 'image', durationFrames: 150, width: 1080, height: 1350, fps: null, hasVideo: true, hasAudio: false, size: 1 }))
    const withPhotos = { ...p, assets: photos }
    const slots = buildSlots(withPhotos)
    const grids = gridsFor(withPhotos, null, null, 15)
    const brief: Brief = { product: 'Aura', benefit: '', audience: '', tone: 'energetic', cta: '', seconds: 15, language: 'English' }
    const m = menu2For(withPhotos, { slots, heroCandidates: slots.map((s) => s.id) }, grids, brief, { pinned: ENERGY })
    const settled = settle2({ error: 'no model' }, m, brief, grids)
    // Energy at an energetic tone: 0.85 + 0.15.
    expect(settled.composed.intensity).toBeCloseTo(1, 9)
  })

  it('never edits the plan it was given', () => {
    const c = composed(WEDDING_HIGHLIGHT, { style: 'neon-green' })
    const before = JSON.stringify(c)
    cohere(c, grid, tone, menu)
    expect(JSON.stringify(c)).toBe(before)
  })
})

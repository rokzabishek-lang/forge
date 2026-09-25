import { describe, expect, it } from 'vitest'
import { emptyProject, type Clip, type MediaAsset, type Project } from '@shared/timeline'
import type { MusicAnalysis } from '@shared/automation/cutPlan'
import { flatViolations, unsupportedKeywords } from '@shared/director/conforms'
import { buildSlots } from '@shared/director/menu'
import { ENERGY, PRODUCT_REVEAL, RECIPES, WEDDING_HIGHLIGHT } from '@shared/director/recipes'
import { rhythmGrid } from '@shared/director/rhythm'
import { SPINE2_PASS, spine2Schema, type Menu2, type Shot2, type SpinePlan2 } from '@shared/director/schema2'
import { PLAYBOOK2, maxTokensFor2, spine2Prompt } from '@shared/director/prompt2'
import { validateSpine2 } from '@shared/director/validate2'
import { baselineSpine2 } from '@shared/director/baseline2'
import { composeAd, graphemes } from '@shared/director/compose'
import { applyRecipe, decisionFor2, endCardText } from '@shared/director/apply2'
import { clearDirector, COPY_RULE, ENDING_RULE, LOOK_RULE, SPINE_RULE } from '@shared/director/apply'
import type { Brief } from '@shared/director/schema'
import { segmentIntoSentences } from '@shared/transcript'

/**
 * `spine@2` end to end without a model (docs/PLAN.md §5.2–5.6): the schema,
 * the prompt, every repair the validator makes, the standard cut, the timing,
 * and the clips. With the timing out of the plan, most of what `spine@1`
 * rejected is repaired here — each repair is pinned so it cannot quietly
 * become a rejection again, or a pass-through.
 */

const fps = 30
const asset = (id: string, kind: MediaAsset['kind'] = 'image', over: Partial<MediaAsset> = {}): MediaAsset => ({
  id, path: `/m/${id}`, name: `${id}.jpg`, kind, durationFrames: kind === 'video' ? 120 : 150, width: 1080, height: 1350, fps: kind === 'video' ? 30 : null, hasVideo: kind !== 'audio', hasAudio: kind !== 'image', size: 100, ...over
})

function project(): Project {
  const music: Clip = { id: 'music', assetId: 'song', trackId: 'a1', start: 0, duration: 20 * fps, inPoint: 0, volume: 1, transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, color: { brightness: 0, contrast: 1, saturation: 1 } }
  return {
    ...emptyProject(),
    settings: { ...emptyProject().settings, width: 1080, height: 1920, fps },
    assets: [asset('p1'), asset('p2'), asset('p3'), asset('clip', 'video'), asset('p5'), asset('song', 'audio', { width: null, height: null, hasVideo: false, durationFrames: 20 * fps })],
    clips: [music]
  }
}

function song(bpm: number, seconds: number): MusicAnalysis {
  const beatMs = 60_000 / bpm
  const beats: number[] = []
  for (let t = 0; t <= seconds * 1000; t += beatMs) beats.push(Math.round(t))
  return { bpm, beats, downbeats: beats.filter((_, i) => i % 4 === 0), tiers: beats.map(() => 2), drops: [{ ms: 9000, score: 0.9 }], buildups: [], sections: [4800], durationMs: seconds * 1000 }
}

const brief: Brief = { product: 'Aura serum', benefit: 'glow', audience: '', tone: 'premium', cta: 'Shop now', seconds: 20, language: 'English' }

function menu(p = project()): Menu2 {
  return { slots: buildSlots(p), recipes: [...RECIPES], fallback: PRODUCT_REVEAL, heroCandidates: ['slot_02', 'slot_01', 'slot_03', 'slot_05'], fps, seconds: 20, bpm: 100, holds: { min: 4, max: 8 }, drops: [9] }
}

const shot = (slot: string, over: Partial<Shot2> = {}): Shot2 => ({ slot, role: 'story', weight: 'normal', move: 'in', speed: 'normal', headline: '', punch_word: '', why: 'x', ...over })
const plan = (shots: Shot2[], over: Partial<SpinePlan2> = {}): SpinePlan2 => ({ reasoning: 'r', recipe: 'product-reveal', hero: 'slot_02', style: 'hero', animation: 'rise', shots, ...over })
const ok = (v: ReturnType<typeof validateSpine2>): Extract<ReturnType<typeof validateSpine2>, { plan: unknown }> => {
  if ('rejected' in v) throw new Error(v.rejected)
  return v
}

describe('the schema', () => {
  it('is flat, reasoning first, every object required in declaration order', () => {
    for (const constrained of [true, false]) {
      const s = spine2Schema(menu(), { constrained })
      expect(unsupportedKeywords(s)).toEqual([])
      expect(flatViolations(s)).toEqual([])
      expect(Object.keys(s.properties)[0]).toBe('reasoning')
      expect(Object.keys(s.properties)).toEqual(s.required)
    }
  })

  it('offers the union of the recipes’ styles and moves, and only the gate’s heroes', () => {
    const s = spine2Schema(menu())
    const styles = (s.properties.style as unknown as { enum: string[] }).enum
    for (const r of RECIPES) for (const st of r.type.styles) expect(styles).toContain(st)
    expect((s.properties.hero as unknown as { enum: string[] }).enum).toEqual(['slot_02', 'slot_01', 'slot_03', 'slot_05'])
    expect(SPINE2_PASS).toBe('spine@2')
  })
})

describe('the prompt', () => {
  const { system, user } = spine2Prompt(brief, menu())
  it('keeps the playbook the same for every ad, so a server caches it', () => {
    expect(system).toBe(PLAYBOOK2)
    expect(spine2Prompt({ ...brief, product: 'Other' }, menu()).system).toBe(PLAYBOOK2)
  })
  it('gives the music in a sentence and no table of cuts — the model times nothing', () => {
    expect(user).toContain('MUSIC: 20.0 s at 100 BPM, a drop at 9.0 s. It holds about 4 to 8 shots.')
    expect(user).not.toContain('CUTS')
    expect(user).not.toContain('cut_')
  })
  it('lists every recipe with its roles, and the heroes', () => {
    for (const r of RECIPES) expect(user).toContain(`${r.id} — ${r.name}`)
    expect(user).toContain('roles: hook, story, cta')
    expect(user).toContain('HERO (choose one): slot_02, slot_01, slot_03, slot_05')
  })
  it('has room for twelve shots at their longest', () => {
    const long = plan(Array.from({ length: 12 }, (_, i) => shot(`slot_${String(i + 1).padStart(2, '0')}`, { headline: 'x'.repeat(40), punch_word: 'x'.repeat(10), why: 'y'.repeat(100), move: 'outRight' })), { reasoning: 'z'.repeat(300) })
    // JSON runs about three characters a token on these fields; a generous estimate, not a tokenizer.
    expect(JSON.stringify(long).length / 3).toBeLessThan(maxTokensFor2({ slots: Array.from({ length: 12 }) as never[] }))
  })
})

describe('the validator repairs what spine@1 had to reject', () => {
  it('shots out of order are put back in order', () => {
    const v = ok(validateSpine2(plan([shot('slot_03'), shot('slot_02'), shot('slot_01')]), menu()))
    expect(v.plan.shots.map((s) => s.slot)).toEqual(['slot_01', 'slot_02', 'slot_03'])
    expect(v.problems.map((p) => p.message).join(' ')).toMatch(/put back in order/)
  })

  it('an unknown recipe falls to the tone’s', () => {
    const v = ok(validateSpine2({ ...plan([shot('slot_02')]), recipe: 'nope' }, menu()))
    expect(v.recipe.id).toBe('product-reveal')
  })

  it('a hero that is not a candidate becomes the first candidate among the shots; one not among the shots joins them', () => {
    const v = ok(validateSpine2(plan([shot('slot_01'), shot('slot_04')], { hero: 'slot_04' }), menu()))
    expect(v.plan.hero).toBe('slot_01')
    const joined = ok(validateSpine2(plan([shot('slot_04')], { hero: 'slot_04' }), menu()))
    expect(joined.plan.hero).toBe('slot_02')
    expect(joined.plan.shots.map((s) => s.slot)).toEqual(['slot_02', 'slot_04'])
  })

  it('a style, animation or move from another recipe becomes the chosen recipe’s own', () => {
    // Wedding chosen, Product reveal's style and an Energy move: legal at the decoder, wrong for the recipe.
    const v = ok(validateSpine2(plan([shot('slot_02', { move: 'inUp', role: 'product' })], { recipe: 'wedding-highlight', style: 'hero', animation: 'pop' }), menu()))
    expect([v.plan.style, v.plan.animation]).toEqual(['soft-fade', 'fade'])
    expect(v.plan.shots[0].move).toBe('hold')
    // Wedding has no product role.
    expect(v.plan.shots[0].role).toBe('story')
  })

  it('a still has no speed, and a clip that speaks gets no ramp', () => {
    const p = project()
    const words = [{ index: 0, text: 'Hello', startMs: 100, endMs: 300, confidence: 1 }, { index: 1, text: 'there.', startMs: 350, endMs: 600, confidence: 1 }]
    p.transcripts = { clip: { assetId: 'clip', language: 'en', model: 'm', durationMs: 4000, words, segments: segmentIntoSentences(words) } }
    const m = { ...menu(p), slots: buildSlots(p) }
    const v = ok(validateSpine2(plan([shot('slot_02', { speed: 'slow' }), shot('slot_04', { speed: 'ramp' })]), m))
    expect(v.plan.shots.map((s) => s.speed)).toEqual(['normal', 'normal'])
  })

  it('a punch word that is not a word of the headline is cleared', () => {
    const v = ok(validateSpine2(plan([shot('slot_02', { headline: 'Glow in days', punch_word: 'week' })]), menu()))
    expect(v.plan.shots[0].punch_word).toBe('')
  })

  it('still rejects: cut off, the wrong shape, nothing usable', () => {
    expect('rejected' in validateSpine2(plan([shot('slot_02')]), menu(), { truncated: true })).toBe(true)
    expect('rejected' in validateSpine2({ reasoning: 'x' }, menu())).toBe(true)
    expect('rejected' in validateSpine2(plan([shot('slot_99')]), menu())).toBe(true)
  })
})

describe('the standard cut, composed and applied', () => {
  const grid = rhythmGrid(song(100, 20), { fps, seconds: 20, tempo: 100 })

  it('validates for every recipe, and times to a full ad', () => {
    for (const recipe of RECIPES) {
      const b = baselineSpine2(brief, menu(), recipe)
      const v = ok(validateSpine2(b, { ...menu(), fallback: recipe }))
      expect(v.recipe.id).toBe(recipe.id)
      const c = composeAd(v.plan, v.recipe, menu(), grid)
      expect(c.layout.shots.length).toBeGreaterThan(0)
      expect(c.layout.endFrame).toBeLessThanOrEqual(grid.end)
      expect(c.layout.shots.find((s) => s.hero)!.slotId).toBe(b.hero)
    }
  })

  it('writes the shots, the black, the end card, the cards and the look — and clearDirector takes them all', () => {
    const p = project()
    const v = ok(validateSpine2(baselineSpine2(brief, menu(p), PRODUCT_REVEAL), menu(p)))
    const c = composeAd(v.plan, v.recipe, menu(p), grid)
    let n = 0
    const a = applyRecipe(p, c, menu(p), { fps, videoTrackId: 'v1', brief, model: 'm', catalogue: [], musicClipId: 'music', lookFile: { file: '/looks/cool.cube', name: 'Cool cine' }, newId: (x) => `${x}-${++n}` })
    const clips = a.project.clips
    const shots = clips.filter((x) => x.generatedBy?.rule === SPINE_RULE).sort((x, y) => x.start - y.start)
    expect(shots.map((s) => s.start)).toEqual(c.layout.shots.map((s) => s.startFrame))
    const ending = clips.filter((x) => x.generatedBy?.rule === ENDING_RULE)
    expect(ending.every((x) => x.solid?.color === '#000000' && x.trackId === 'v1')).toBe(true)
    expect(ending.length).toBe((c.layout.black ? 1 : 0) + (c.layout.endCard ? 1 : 0))
    const cards = clips.filter((x) => x.generatedBy?.rule === COPY_RULE)
    expect(cards.every((x) => x.text!.styleId === 'hero' && x.text!.animationId === 'rise')).toBe(true)
    expect(cards.some((x) => x.text!.content === endCardText('product-cta', brief))).toBe(true)
    // The look sits BELOW every card, so the type is not graded. Later video tracks draw on top
    // (addTrack 'top' appends), so below means a LOWER index.
    const look = clips.find((x) => x.generatedBy?.rule === LOOK_RULE)!
    expect(look.adjustment).toBe(true)
    expect(look.color!.lut!.file).toBe('/looks/cool.cube')
    const order = a.project.tracks.map((t) => t.id)
    expect(order.indexOf(look.trackId)).toBeGreaterThan(order.indexOf('v1'))
    // Every card that is on screen WITH the look is above it; the end card, after the look ends, may share its lane.
    const during = cards.filter((x) => x.start < look.start + look.duration && x.start + x.duration > look.start)
    expect(during.length).toBeGreaterThan(0)
    for (const card of during) expect(order.indexOf(look.trackId)).toBeLessThan(order.indexOf(card.trackId))
    // The music is as long as the ad.
    const music = clips.find((x) => x.id === 'music')!
    expect(music.start + music.duration).toBe(c.layout.endFrame)
    // Everything the director made goes with clearDirector, drawn assets too; the footage stays.
    const cleared = clearDirector(a.project)
    expect(cleared.clips.filter((x) => x.generatedBy)).toEqual([])
    expect(cleared.assets.map((x) => x.id).sort()).toEqual(p.assets.map((x) => x.id).sort())
  })

  it('a clip that speaks keeps its sound and the music ducks under it; a silent clip is muted', () => {
    // Words from a third of a second in: a speech test that compared seconds with milliseconds looked at the
    // first millisecond and heard nothing (a mutation check found it untested).
    const words = [{ index: 0, text: 'Hello', startMs: 350, endMs: 700, confidence: 1 }, { index: 1, text: 'there.', startMs: 750, endMs: 1100, confidence: 1 }]
    const withSpeech = project()
    withSpeech.transcripts = { clip: { assetId: 'clip', language: 'en', model: 'm', durationMs: 4000, words, segments: segmentIntoSentences(words) } }
    for (const [p, speaks] of [[withSpeech, true], [project(), false]] as const) {
      const m = menu(p)
      const v = ok(validateSpine2(plan([shot('slot_01', { role: 'hook' }), shot('slot_02'), shot('slot_04', { weight: 'hold' })], { recipe: 'fashion', style: 'clean', animation: 'fade' }), m))
      const a = applyRecipe(p, composeAd(v.plan, v.recipe, m, grid), m, { fps, videoTrackId: 'v1', brief, model: 'm', catalogue: [], musicClipId: 'music', newId: (x) => `${x}-${Math.random()}` })
      const clip = a.project.clips.find((x) => x.assetId === 'clip')!
      expect(clip.volume, speaks ? 'speaking' : 'silent').toBe(speaks ? 1 : 0)
      const musicTrack = a.project.tracks.find((t) => t.id === 'a1')!
      expect(Boolean(musicTrack.duck), speaks ? 'ducked under speech' : 'not ducked').toBe(speaks)
    }
  })

  it('a slow hero clip plays at half speed and still fits its footage', () => {
    const p = project()
    const m = { ...menu(p), heroCandidates: ['slot_04'] }
    const v = ok(validateSpine2(plan([shot('slot_01'), shot('slot_04', { speed: 'slow', weight: 'hold' }), shot('slot_05')], { hero: 'slot_04', recipe: 'fashion', style: 'clean', animation: 'fade' }), m))
    const c = composeAd(v.plan, v.recipe, m, grid)
    const a = applyRecipe(p, c, m, { fps, videoTrackId: 'v1', brief, model: 'm', catalogue: [], newId: (x) => `${x}-${Math.random()}` })
    const clip = a.project.clips.find((x) => x.assetId === 'clip')!
    expect(clip.speed).toBe(0.5)
    expect(clip.duration * 0.5).toBeLessThanOrEqual(120)
  })
})

describe('compose', () => {
  it('counts graphemes, not code points — a Telugu headline is as long as it looks', () => {
    expect(graphemes('పెళ్లి కూతురు సిద్ధం')).toBeLessThan(Array.from('పెళ్లి కూతురు సిద్ధం').length)
    expect(graphemes('Glow')).toBe(4)
  })

  it('drops a headline too long for its card, without touching the plan it was given', () => {
    const grid = rhythmGrid(song(160, 10), { fps, seconds: 10, tempo: 160 })
    const v = ok(validateSpine2(plan([shot('slot_01', { role: 'hook', headline: 'An extremely long opening line for one quick shot' }), shot('slot_02', { weight: 'hold' })], { recipe: 'energy', style: 'pop' as never, animation: 'pop' }), menu()))
    const before = JSON.stringify(v.plan)
    const c = composeAd(v.plan, v.recipe, menu(), grid)
    expect(c.plan.shots[0].headline).toBe('')
    expect(c.problems.map((x) => x.message).join(' ')).toMatch(/too long to read/)
    expect(JSON.stringify(v.plan)).toBe(before)
  })
})

describe('the decision', () => {
  it('records the plan, the recipe, the layout and the events for C3 and C4', () => {
    const grid = rhythmGrid(song(100, 20), { fps, seconds: 20, tempo: 100 })
    const v = ok(validateSpine2(baselineSpine2(brief, menu(), ENERGY), { ...menu(), fallback: ENERGY }))
    const c = composeAd(v.plan, v.recipe, menu(), grid)
    const d = decisionFor2(c, { id: 'm', runtime: 'baseline' }, { id: 'd1', now: new Date('2026-09-23T00:00:00Z') })
    expect(d.pass).toBe('spine@2')
    const op = d.ops[0] as { recipe: string; events: { moments: unknown[]; sounds: unknown[] } }
    expect(op.recipe).toBe('energy')
    expect(Array.isArray(op.events.moments)).toBe(true)
    expect(Array.isArray(op.events.sounds)).toBe(true)
  })

  it('a wedding brief with no model is a wedding', () => {
    const b = baselineSpine2({ ...brief, tone: 'calm', product: 'Priya & Arjun wedding' }, { ...menu(), fallback: WEDDING_HIGHLIGHT })
    expect(b.recipe).toBe('wedding-highlight')
    expect(b.shots[0].role).toBe('hook')
    expect(b.shots.at(-1)!.role).toBe('cta')
  })
})

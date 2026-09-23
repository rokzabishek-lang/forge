import { describe, it, expect } from 'vitest'
import {
  COPY_RULE,
  MUSIC_FADE_SECONDS,
  PUNCH_COLOR,
  PUNCH_SCALE,
  SPINE_RULE,
  applySpine,
  clearDirector,
  decisionFor,
  memberFor,
  occupiedBy,
  sizeFor,
  trimMusic,
  type ApplyContext
} from '@shared/director/apply'
import { buildCutMenu, buildSlots, familyMenu, type CutCandidate, type Menu } from '@shared/director/menu'
import { SPINE_PASS, type Brief, type Segment, type SpinePlan } from '@shared/director/schema'
import { validateSpine, type Validated } from '@shared/director/validate'
import { TRANSITIONS } from '@shared/transitions/registry'
import type { MusicAnalysis } from '@shared/automation/cutPlan'
import { clipEnd, emptyProject, type Clip, type MediaAsset, type Project } from '@shared/timeline'
import type { Transcript } from '@shared/transcript'

const fps = 30

function music(seconds = 30): MusicAnalysis {
  const beats: number[] = []
  for (let t = 0; t < seconds * 1000; t += 500) beats.push(t)
  return {
    bpm: 120,
    beats,
    downbeats: beats.filter((_, i) => i % 4 === 0),
    tiers: beats.map((_, i) => (i % 16 >= 12 ? 3 : 1)),
    drops: [],
    buildups: [],
    sections: [],
    durationMs: seconds * 1000
  }
}

function asset(over: Partial<MediaAsset> & { id: string }): MediaAsset {
  return {
    path: `/p/${over.id}.jpg`,
    name: `${over.id}.jpg`,
    kind: 'image',
    durationFrames: fps * 5,
    width: 1600,
    height: 1067,
    fps: null,
    hasVideo: true,
    hasAudio: false,
    size: 4_096,
    ...over
  }
}

const words = (count: number): Transcript => ({
  assetId: 'vid',
  language: 'en',
  model: 'test',
  durationMs: count * 300,
  words: Array.from({ length: count }, (_, i) => ({
    index: i,
    text: `w${i}`,
    startMs: i * 300,
    endMs: i * 300 + 200,
    confidence: null
  })),
  segments: []
})

const MUSIC_FRAMES = 900

/** Three stills, a clip, and thirty seconds of music on A1. */
function project(over: { videoFrames?: number; speech?: boolean } = {}): Project {
  const base = emptyProject()
  const musicClip: Clip = {
    id: 'music',
    assetId: 'song',
    trackId: 'a1',
    start: 0,
    duration: MUSIC_FRAMES,
    inPoint: 0,
    volume: 1,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    color: { brightness: 0, contrast: 1, saturation: 1 }
  }
  return {
    ...base,
    assets: [
      asset({ id: 'img1' }),
      asset({ id: 'img2' }),
      asset({ id: 'vid', kind: 'video', durationFrames: over.videoFrames ?? 45, fps, hasAudio: true }),
      asset({ id: 'img3' }),
      asset({ id: 'song', kind: 'audio', hasVideo: false, hasAudio: true, durationFrames: 1800, width: null, height: null })
    ],
    clips: [musicClip],
    transcripts: over.speech === false ? {} : { vid: words(6) }
  }
}

const brief: Brief = {
  product: 'Lumen serum',
  benefit: 'Glow in seven days',
  audience: '',
  tone: 'energetic',
  cta: 'Shop now',
  seconds: 30,
  language: 'English'
}

function menuFor(p: Project, cuts?: CutCandidate[]): Menu {
  return {
    slots: buildSlots(p),
    cuts: cuts ?? buildCutMenu(music(), { fps, seconds: 30, windowMs: 30_000 }),
    families: familyMenu(TRANSITIONS),
    seconds: 30,
    fps
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

const validated = (plan: SpinePlan, menu: Menu): Validated => {
  // Short plans on purpose: these test apply, not the coverage row (validate.ts).
  const v = validateSpine(plan, menu, { minCoverage: 0 })
  if ('rejected' in v) throw new Error(v.rejected)
  return v
}

let counter = 0
const ctx = (over: Partial<ApplyContext> = {}): ApplyContext => ({
  fps,
  videoTrackId: 'v1',
  brief,
  model: 'test-model',
  catalogue: TRANSITIONS,
  musicClipId: 'music',
  newId: (prefix) => `${prefix}-${++counter}`,
  ...over
})

/** The standard four-segment plan against the standard menu. */
function standard(p = project()): { p: Project; menu: Menu; plan: SpinePlan; v: Validated } {
  const menu = menuFor(p)
  const id = (i: number): string => menu.cuts[i].id
  const plan: SpinePlan = {
    reasoning: 'ok',
    pace: 'punchy',
    segments: [
      segment({ slot: 'slot_01', role: 'hook', ends_at: id(2), headline: 'Stop scrolling.', punch_word: 'Stop' }),
      segment({ slot: 'slot_02', role: 'product', ends_at: id(4), enter: 'zoom', headline: 'Glow in 7 days', punch_word: '7' }),
      segment({ slot: 'slot_03', role: 'proof', ends_at: id(5), enter: 'dissolve' }),
      segment({ slot: 'slot_04', role: 'cta', ends_at: id(7), enter: 'dissolve', headline: 'Shop the serum', punch_word: 'Shop' })
    ]
  }
  return { p, menu, plan, v: validated(plan, menu) }
}

const shots = (p: Project): Clip[] =>
  p.clips.filter((c) => c.generatedBy?.rule === SPINE_RULE).sort((a, b) => a.start - b.start)
const cards = (p: Project): Clip[] =>
  p.clips.filter((c) => c.generatedBy?.rule === COPY_RULE).sort((a, b) => a.start - b.start)

describe('applySpine — shots', () => {
  it('places one shot per segment on the video track, tiling the layout exactly', () => {
    const { p, menu, v } = standard()
    const { project: out, problems } = applySpine(p, v.plan, v.layout, menu, ctx())
    const placed = shots(out)
    expect(placed).toHaveLength(4)
    expect(placed.map((c) => c.assetId)).toEqual(['img1', 'img2', 'vid', 'img3'])
    expect(placed.every((c) => c.trackId === 'v1')).toBe(true)
    placed.forEach((c, i) => {
      expect(c.start).toBe(v.layout[i].startFrame)
      expect(c.duration).toBeGreaterThanOrEqual(v.layout[i].clipFrames)
    })
    // The video is 45 frames and its segment is longer: capped, and the gap is
    // noted by the validator, not the apply step.
    expect(placed[2].duration).toBe(45)
    expect(v.layout[2].capped).toBe(true)
    expect(problems.filter((x) => x.path.includes('[3].enter'))).toEqual([])
    for (const c of placed) expect(c.generatedBy?.reason).toMatch(/^(hook|product|proof|cta) · /)
  })

  it('gives stills a camera move by pace and holds a shake on a drop', () => {
    const { p, menu, v } = standard()
    const { project: out } = applySpine(p, v.plan, v.layout, menu, ctx())
    const [hook, product, video] = shots(out)
    expect(hook.motion).toMatchObject({ kind: 'kenburns' })
    expect(product.motion).toMatchObject({ kind: 'kenburns' })
    expect(video.motion).toBeUndefined()
    expect((hook.motion as { amount: number }).amount).toBeGreaterThan(0)
    const calm = applySpine(p, { ...v.plan, pace: 'calm' }, v.layout, menu, ctx()).project
    expect((shots(calm)[0].motion as { amount: number }).amount).toBeLessThan(
      (hook.motion as { amount: number }).amount
    )
  })

  it('keeps a clip\'s sound only when someone speaks in it, and ducks the music under it', () => {
    const talking = standard(project({ speech: true }))
    const outTalking = applySpine(talking.p, talking.v.plan, talking.v.layout, talking.menu, ctx()).project
    expect(shots(outTalking)[2].volume).toBe(1)
    expect(outTalking.tracks.find((t) => t.id === 'a1')?.duck).toBe(true)

    const silent = standard(project({ speech: false }))
    const outSilent = applySpine(silent.p, silent.v.plan, silent.v.layout, silent.menu, ctx()).project
    expect(shots(outSilent)[2].volume).toBe(0)
    expect(outSilent.tracks.find((t) => t.id === 'a1')?.duck).toBeUndefined()
  })
})

describe('applySpine — transitions', () => {
  it('anchors the transition on the clip that STARTS at the boundary and moves nothing', () => {
    const { p, menu, v } = standard()
    const { project: out } = applySpine(p, v.plan, v.layout, menu, ctx())
    const [hook, product, video, cta] = shots(out)
    expect(product.transitionIn).toBeDefined()
    expect(TRANSITIONS.find((t) => t.id === product.transitionIn!.id)?.family).toBe('zoom')
    expect(product.transitionIn!.durationFrames).toBe(Math.round(fps * (v.layout[1].energy >= 2 ? 0.22 : 0.32)))
    // Anchored: the incoming clip stays on its beat; the outgoing one grew.
    expect(product.start).toBe(v.layout[1].startFrame)
    expect(hook.duration).toBe(v.layout[0].clipFrames + product.transitionIn!.durationFrames)
    expect(TRANSITIONS.find((t) => t.id === video.transitionIn!.id)?.family).toBe('dissolve')
    // The capped video before it: the validator already made this a cut.
    expect(cta.transitionIn).toBeUndefined()
    expect(hook.transitionIn).toBeUndefined()
  })

  it('holds the overlap to the footage the outgoing video has left, and skips it when there is none', () => {
    const cuts: CutCandidate[] = [
      { id: 'cut_00', ms: 0, frame: 0, reason: 'start', energy: 1 },
      { id: 'cut_01', ms: 1000, frame: 30, reason: 'grid', energy: 1 },
      { id: 'cut_02', ms: 2000, frame: 60, reason: 'grid', energy: 1 },
      { id: 'cut_end', ms: 3000, frame: 90, reason: 'end', energy: 1 }
    ]
    const build = (videoFrames: number): { out: Project; problems: { path: string; message: string }[]; v: Validated } => {
      const p = project({ videoFrames, speech: false })
      const menu = menuFor(p, cuts)
      const plan: SpinePlan = {
        reasoning: 'ok',
        pace: 'steady',
        segments: [
          segment({ slot: 'slot_01', ends_at: 'cut_01' }),
          segment({ slot: 'slot_03', ends_at: 'cut_02' }),
          segment({ slot: 'slot_04', ends_at: 'cut_end', enter: 'dissolve' })
        ]
      }
      const v = validated(plan, menu)
      const { project: out, problems } = applySpine(p, v.plan, v.layout, menu, ctx())
      return { out, problems, v }
    }

    // 35 frames of footage, 30 used: five left, so the ten-frame dissolve is held to five.
    const clamped = build(35)
    expect(clamped.v.layout[1].capped).toBe(false)
    expect(shots(clamped.out)[2].transitionIn?.durationFrames).toBe(5)
    expect(shots(clamped.out)[1].duration).toBe(35)

    // Exactly 30: nothing left to blend from, so it enters with a cut and says so.
    const none = build(30)
    expect(shots(none.out)[2].transitionIn).toBeUndefined()
    expect(none.problems.some((x) => x.message.includes('no footage left'))).toBe(true)
    expect(shots(none.out)[1].duration).toBe(30)
  })

  it('refuses a transition across a gap', () => {
    // A hand-made layout: the second shot ends early, the third asks to dissolve in.
    const p = project({ speech: false })
    const menu = menuFor(p)
    const { plan, v } = standard(p)
    const layout = v.layout.map((l, i) => (i === 2 ? { ...l, clipFrames: l.clipFrames - 10, capped: true } : l))
    const forced = { ...plan, segments: plan.segments.map((s, i) => (i === 3 ? { ...s, enter: 'dissolve' } : s)) }
    const { project: out, problems } = applySpine(p, forced, layout, menu, ctx())
    expect(shots(out)[3].transitionIn).toBeUndefined()
    expect(problems.some((x) => x.path === '$.segments[3].enter' && x.message.includes('ends'))).toBe(true)
  })
})

describe('applySpine — cards', () => {
  it('puts a headline card over each segment on the lane above, marked as the director\'s copy', () => {
    const { p, menu, v } = standard()
    const { project: out, cardClipIds } = applySpine(p, v.plan, v.layout, menu, ctx())
    const placed = cards(out)
    expect(placed).toHaveLength(3)
    expect(cardClipIds).toHaveLength(3)
    expect(placed.map((c) => c.text?.content)).toEqual(['Stop scrolling.', 'Glow in 7 days', 'Shop the serum'])
    expect(placed.every((c) => c.trackId === 'v2')).toBe(true)
    expect(placed[0].start).toBe(v.layout[0].startFrame)
    expect(placed[0].duration).toBe(v.layout[0].endFrame - v.layout[0].startFrame)
    for (const c of placed) {
      const asset = out.assets.find((a) => a.id === c.assetId)!
      expect(asset).toMatchObject({ path: '', kind: 'image', size: 0, width: 1920, height: 1080 })
      expect(c.generatedBy).toEqual({ rule: COPY_RULE, reason: expect.stringMatching(/headline$/) })
    }
  })

  it('accents the punch word with a colour AND a scale, on the renderer\'s word index', () => {
    const { p, menu, v } = standard()
    const { project: out } = applySpine(p, v.plan, v.layout, menu, ctx())
    const [hook, product] = cards(out)
    expect(hook.text?.highlight).toEqual({ word: 0, color: PUNCH_COLOR, scale: PUNCH_SCALE })
    // "Glow in 7 days" — "7" is the third word.
    expect(product.text?.highlight).toEqual({ word: 2, color: PUNCH_COLOR, scale: PUNCH_SCALE })
  })

  it('sizes and places by role and length', () => {
    const { p, menu, v } = standard()
    const { project: out } = applySpine(p, v.plan, v.layout, menu, ctx())
    const [hook, product, cta] = cards(out)
    expect(hook.text?.position).toBe('center')
    expect(product.text?.position).toBe('lower')
    expect(cta.text?.position).toBe('center')
    expect(hook.text?.size).toBe(sizeFor('hook', 'Stop scrolling.'))
    expect(sizeFor('hook', 'Shop now')).toBe(0.12)
    expect(sizeFor('hook', 'Stop scrolling.')).toBe(0.085)
    expect(sizeFor('product', 'Glow in 7 days')).toBe(0.08)
    expect(sizeFor('hook', 'Glow like never before in seven')).toBe(0.06)
    expect(sizeFor('proof', 'Loved by 12,000 customers')).toBe(0.07)
  })

  it('adds the call to action over the end when the plan forgot one', () => {
    const { p, menu, plan } = standard()
    const noCta = { ...plan, segments: plan.segments.map((s) => (s.role === 'cta' ? { ...s, role: 'proof' as const, headline: '' } : s)) }
    const v = validated(noCta, menu)
    const { project: out } = applySpine(p, v.plan, v.layout, menu, ctx())
    const last = cards(out)[cards(out).length - 1]
    expect(last.text?.content).toBe('Shop now')
    expect(last.generatedBy?.reason).toBe('cta headline')
    const lay = v.layout[3]
    expect(clipEnd(last)).toBe(lay.endFrame)
    expect(last.duration).toBe(Math.round((lay.endFrame - lay.startFrame) * 0.4))
  })

  it('drops a card, with a note, when every layer is taken and no more can be added', () => {
    const { p, menu, v } = standard()
    // Twelve tracks, and every video lane above V1 busy for the whole ad.
    const tracks = [
      ...Array.from({ length: 10 }, (_, i) => ({ id: `v${i + 1}`, kind: 'video' as const, name: `V${i + 1}`, muted: false, hidden: false, locked: false })),
      ...p.tracks.filter((t) => t.kind === 'audio')
    ]
    const busy: Clip[] = tracks
      .filter((t) => t.kind === 'video' && t.id !== 'v1')
      .map((t) => ({
        id: `user-${t.id}`,
        assetId: 'img1',
        trackId: t.id,
        start: 0,
        duration: 900,
        inPoint: 0,
        volume: 1,
        transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
        color: { brightness: 0, contrast: 1, saturation: 1 }
      }))
    const crowded: Project = { ...p, tracks, clips: [...p.clips, ...busy] }
    const { project: out, problems } = applySpine(crowded, v.plan, v.layout, menu, ctx())
    expect(cards(out)).toHaveLength(0)
    expect(shots(out)).toHaveLength(4)
    expect(problems.filter((x) => x.message.includes('no free layer'))).toHaveLength(3)
    expect(out.tracks).toHaveLength(12)
  })
})

describe('applySpine — music', () => {
  it('shortens the music to the ad with a fade, remembering the original', () => {
    const { p, menu, v } = standard()
    const { project: out } = applySpine(p, v.plan, v.layout, menu, ctx())
    const song = out.clips.find((c) => c.id === 'music')!
    const adEnd = v.layout[3].endFrame
    expect(adEnd).toBeLessThan(MUSIC_FRAMES)
    expect(clipEnd(song)).toBe(adEnd)
    expect(song.fadeOut).toBe(Math.round(fps * MUSIC_FADE_SECONDS))
    expect(song.directorTrim).toEqual({ duration: MUSIC_FRAMES })
  })

  it('never lengthens it, and a re-run measures from the ORIGINAL, not the last trim', () => {
    const { p, menu, v, plan } = standard()
    const once = applySpine(p, v.plan, v.layout, menu, ctx()).project

    // A second run that ends later: the song gets LONGER again — a trim is
    // measured from the original clip, never from the last trim. (cut_end
    // itself sits on the 28 s downbeat, not at 30 s, so it is still a trim.)
    const longer = { ...plan, segments: plan.segments.map((s, i) => (i === 3 ? { ...s, ends_at: 'cut_end' } : s)) }
    const v2 = validated(longer, menu)
    const twice = applySpine(once, v2.plan, v2.layout, menu, ctx()).project
    const song1 = once.clips.find((c) => c.id === 'music')!
    const song2 = twice.clips.find((c) => c.id === 'music')!
    expect(clipEnd(song2)).toBe(v2.layout[3].endFrame)
    expect(song2.duration).toBeGreaterThan(song1.duration)
    expect(song2.duration).toBeLessThanOrEqual(MUSIC_FRAMES)
    expect(song2.directorTrim).toEqual({ duration: MUSIC_FRAMES })

    // And a third, short again: the stamp is still the original.
    const thrice = applySpine(twice, v.plan, v.layout, menu, ctx()).project
    expect(thrice.clips.find((c) => c.id === 'music')!.directorTrim).toEqual({ duration: MUSIC_FRAMES })
  })

  it('trimMusic keeps the ORIGINAL in the stamp when trimming an already-trimmed clip', () => {
    const song = project().clips[0]
    const first = trimMusic(song, 600, fps)
    expect(first.directorTrim).toEqual({ duration: MUSIC_FRAMES })
    // Trimmed again without a restore in between — the stamp must not move.
    const second = trimMusic(first, 450, fps)
    expect(second.duration).toBe(450)
    expect(second.directorTrim).toEqual({ duration: MUSIC_FRAMES })
    // And a fade the user had set survives into the record too.
    const faded = trimMusic({ ...song, fadeOut: 40 }, 600, fps)
    expect(faded.directorTrim).toEqual({ duration: MUSIC_FRAMES, fadeOut: 40 })
    expect(trimMusic(faded, 450, fps).directorTrim).toEqual({ duration: MUSIC_FRAMES, fadeOut: 40 })
  })

  it('leaves everything alone when there is no music', () => {
    const { p, menu, v } = standard()
    const { project: out } = applySpine(p, v.plan, v.layout, menu, ctx({ musicClipId: undefined }))
    expect(out.clips.find((c) => c.id === 'music')).toEqual(p.clips[0])
  })
})

describe('re-running and clearing', () => {
  it('replaces its own output rather than stacking, cards and their assets included', () => {
    const { p, menu, v } = standard()
    const once = applySpine(p, v.plan, v.layout, menu, ctx()).project
    const twice = applySpine(once, v.plan, v.layout, menu, ctx()).project
    expect(shots(twice)).toHaveLength(shots(once).length)
    expect(cards(twice)).toHaveLength(cards(once).length)
    expect(twice.assets).toHaveLength(once.assets.length)
    expect(twice.clips).toHaveLength(once.clips.length)
    // Every card asset is referenced by a card; none is an orphan.
    const cardAssetIds = new Set(cards(twice).map((c) => c.assetId))
    expect(twice.assets.filter((a) => a.size === 0).every((a) => cardAssetIds.has(a.id))).toBe(true)
    // And the slot list is the same both times.
    expect(buildSlots(twice).map((s) => s.assetId)).toEqual(buildSlots(p).map((s) => s.assetId))
  })

  it('clearDirector puts the project back exactly as it was', () => {
    const { p, menu, v } = standard()
    const directed = applySpine(p, v.plan, v.layout, menu, ctx()).project
    const cleared = clearDirector(directed)
    expect(cleared.clips).toEqual(p.clips)
    expect(cleared.assets).toEqual(p.assets)
    expect(cleared.tracks.map((t) => t.id)).toEqual(p.tracks.map((t) => t.id))
    // Idempotent, and a no-op returns the same object.
    expect(clearDirector(cleared)).toBe(cleared)
  })

  it('never removes footage, even when a shot was its only reference', () => {
    const { p, menu, v } = standard()
    const directed = applySpine(p, v.plan, v.layout, menu, ctx()).project
    const cleared = clearDirector(directed)
    for (const id of ['img1', 'img2', 'vid', 'img3', 'song']) {
      expect(cleared.assets.some((a) => a.id === id)).toBe(true)
    }
  })
})

describe('occupiedBy', () => {
  it('finds the user\'s clips in the way and ignores the director\'s own', () => {
    const { p, menu, v } = standard()
    const directed = applySpine(p, v.plan, v.layout, menu, ctx()).project
    expect(occupiedBy(directed, 'v1', 0, 900)).toEqual([])
    const user: Clip = { ...p.clips[0], id: 'mine', assetId: 'img1', trackId: 'v1', start: 100, duration: 50 }
    const blocked = { ...p, clips: [...p.clips, user] }
    expect(occupiedBy(blocked, 'v1', 0, 900).map((c) => c.id)).toEqual(['mine'])
    expect(occupiedBy(blocked, 'v1', 150, 900)).toEqual([])
    expect(occupiedBy(blocked, 'v2', 0, 900)).toEqual([])
  })
})

describe('memberFor and decisionFor', () => {
  it('walks a family by index and says when there is none', () => {
    const zoom = memberFor('zoom', 3, TRANSITIONS)
    expect(TRANSITIONS.find((t) => t.id === zoom)?.family).toBe('zoom')
    expect(memberFor('glitch', 0, TRANSITIONS)).toBeNull()
    const slides = TRANSITIONS.filter((t) => t.family === 'slide').map((t) => t.id)
    expect(new Set(Array.from({ length: 8 }, (_, i) => memberFor('slide', i, TRANSITIONS))).size).toBe(slides.length)
  })

  it('records the plan whole, stamped with the pass and the model', () => {
    const { v } = standard()
    const now = new Date('2026-09-21T10:00:00Z')
    const record = decisionFor(v.plan, { id: 'gemma4:e2b', runtime: 'ollama' }, { id: 'd1', now })
    expect(record).toEqual({
      id: 'd1',
      pass: SPINE_PASS,
      ops: [v.plan],
      model: { id: 'gemma4:e2b', runtime: 'ollama' },
      createdAt: '2026-09-21T10:00:00.000Z'
    })
  })
})

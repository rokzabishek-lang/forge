import { describe, expect, it } from 'vitest'
import type { MusicAnalysis } from '@shared/automation/cutPlan'
import { emptyProject, type Clip, type MediaAsset, type Project } from '@shared/timeline'
import { buildSlots } from '@shared/director/menu'
import { PRODUCT_REVEAL } from '@shared/director/recipes'
import { rhythmGrid } from '@shared/director/rhythm'
import type { Menu2 } from '@shared/director/schema2'
import { validateSpine2 } from '@shared/director/validate2'
import { baselineSpine2 } from '@shared/director/baseline2'
import { composeAd } from '@shared/director/compose'
import { BACKDROP_BRIGHTNESS, BACKDROP_KEEP, applyRecipe, type Applied2 } from '@shared/director/apply2'
import { BACKDROP_RULE, SPINE_RULE, clearDirector } from '@shared/director/apply'
import { BACKGROUND_BLUR } from '@shared/render/dropIntent'
import { TRANSITIONS } from '@shared/transitions/registry'
import type { Brief } from '@shared/director/schema'

/**
 * A picture whose shape is far from the frame's is shown whole over a blurred
 * copy of itself (docs/PLAN.md §5.5; apply2.ts BACKDROP_KEEP) — found on the
 * first real run, where a square product photo cropped to 9:16 lost its own
 * text and half the bottle. The copy goes on a lane UNDER the ad that the
 * Director adds, and takes away with the ad.
 */

const fps = 30
const brief: Brief = { product: 'Aura serum', benefit: 'glow', audience: '', tone: 'premium', cta: 'Shop now', seconds: 20, language: 'English' }

function song(bpm: number, seconds: number): MusicAnalysis {
  const beatMs = 60_000 / bpm
  const beats: number[] = []
  for (let t = 0; t <= seconds * 1000; t += beatMs) beats.push(Math.round(t))
  return { bpm, beats, downbeats: beats.filter((_, i) => i % 4 === 0), tiers: beats.map(() => 2), drops: [], buildups: [], sections: [], durationMs: seconds * 1000 }
}

const asset = (id: string, width: number, height: number, over: Partial<MediaAsset> = {}): MediaAsset => ({
  id, path: `/media/${id}`, name: `${id}.jpg`, kind: 'image', durationFrames: 150, width, height, fps: null, hasVideo: true, hasAudio: false, size: 100, ...over
})

/** A 9:16 edit of a square photo, a landscape clip, a 4:5 photo and a 3:4 photo, with a song. */
function edit(assets: MediaAsset[]): Project {
  const music: Clip = {
    id: 'music', assetId: 'song', trackId: 'a1', start: 0, duration: 20 * fps, inPoint: 0, volume: 1,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, color: { brightness: 0, contrast: 1, saturation: 1 }
  }
  const empty = emptyProject()
  return {
    ...empty,
    settings: { ...empty.settings, width: 1080, height: 1920, fps },
    assets: [...assets, asset('song', 0, 0, { name: 'song.m4a', kind: 'audio', durationFrames: 20 * fps, width: null, height: null, hasVideo: false, hasAudio: true })],
    clips: [music]
  }
}

const SET: MediaAsset[] = [
  asset('square', 2000, 2000),
  asset('wide', 1920, 1080, { name: 'wide.mp4', kind: 'video', durationFrames: 4 * fps, fps }),
  asset('tall', 1080, 1350),
  asset('threeFour', 1500, 2000)
]

function menuOf(p: Project): Menu2 {
  const slots = buildSlots(p)
  return { slots, recipes: [PRODUCT_REVEAL], fallback: PRODUCT_REVEAL, heroCandidates: slots.map((s) => s.id), fps, seconds: 20, bpm: 100, holds: { min: 4, max: 8 }, drops: [] }
}

/** The standard cut applied; `transitions` replaces the engine's, so a boundary can be made to blend on purpose. */
function direct(p: Project, transitions?: { shot: number; family: 'dissolve' }[]): Applied2 {
  const menu = menuOf(p)
  const checked = validateSpine2(baselineSpine2(brief, menu, PRODUCT_REVEAL), menu)
  if ('rejected' in checked) throw new Error(checked.rejected)
  const grid = rhythmGrid(song(100, 20), { fps, seconds: 20, tempo: PRODUCT_REVEAL.tempo })
  const composed = composeAd(checked.plan, checked.recipe, menu, grid)
  let n = 0
  return applyRecipe(p, transitions ? { ...composed, layout: { ...composed.layout, transitions } } : composed, menu, {
    fps, videoTrackId: 'v1', brief, model: 'baseline', catalogue: TRANSITIONS.map((t) => ({ id: t.id, family: t.family })), musicClipId: 'music',
    newId: (x) => `${x}-${++n}`
  })
}

const shotsOf = (p: Project): Clip[] => p.clips.filter((c) => c.generatedBy?.rule === SPINE_RULE && c.trackId === 'v1')
const backdropsOf = (p: Project): Clip[] => p.clips.filter((c) => c.generatedBy?.rule === BACKDROP_RULE)
const shotFor = (p: Project, assetId: string): Clip => shotsOf(p).find((c) => c.assetId === assetId)!

describe('a picture whose shape is far from the frame’s', () => {
  const applied = direct(edit(SET))
  const p = applied.project

  it('keeps the rule where it says: a square and a landscape get a backdrop, 4:5 and 3:4 are cropped', () => {
    expect(BACKDROP_KEEP).toBeCloseTo(2 / 3, 6)
    for (const id of ['square', 'wide']) {
      const shot = shotFor(p, id)
      expect(shot.crop, `${id} is not cropped`).toBeUndefined()
      expect(backdropsOf(p).some((b) => b.assetId === id && b.start === shot.start), `${id} has a backdrop`).toBe(true)
    }
    for (const id of ['tall', 'threeFour']) {
      const shot = shotFor(p, id)
      expect(shot.crop, `${id} is cropped to the frame`).toBeDefined()
      expect(backdropsOf(p).some((b) => b.assetId === id), `${id} has no backdrop`).toBe(false)
    }
  })

  it('the backdrop is the editor’s own blurred background: the frame’s crop, covered, blurred, darker, silent, under the shot for its span', () => {
    const shot = shotFor(p, 'square')
    const back = backdropsOf(p).find((b) => b.assetId === 'square')!
    expect([back.start, back.duration, back.inPoint]).toEqual([shot.start, shot.duration, shot.inPoint])
    expect(back.volume).toBe(0)
    expect(back.transform.fit).toBe('cover')
    expect(back.crop).toBeDefined()
    // The largest centred 9:16 window of the square, as the frame's crop would have been.
    expect(back.crop!.width / back.crop!.height).toBeCloseTo(1080 / 1920, 2)
    expect(back.mask).toMatchObject({ mode: 'blur', blur: BACKGROUND_BLUR, shape: { kind: 'rectangle', x: 0.5, y: 0.5, width: 0.5, height: 0.5 } })
    expect(back.color.brightness).toBe(BACKDROP_BRIGHTNESS)
    expect(back.motion).toBeUndefined()
    const lanes = p.tracks.filter((t) => t.kind === 'video')
    expect(lanes.findIndex((t) => t.id === back.trackId)).toBeLessThan(lanes.findIndex((t) => t.id === 'v1'))
  })

  it('a landscape clip’s backdrop plays the same footage at the same speed, muted', () => {
    const shot = shotFor(p, 'wide')
    const back = backdropsOf(p).find((b) => b.assetId === 'wide')!
    expect([back.inPoint, back.duration, back.speed, back.ramp]).toEqual([shot.inPoint, shot.duration, shot.speed, shot.ramp])
    expect(back.volume).toBe(0)
  })

  it('every backdrop shares ONE lane the Director added under the ad, and no backdrop overlaps another', () => {
    const backs = backdropsOf(p)
    const lanes = new Set(backs.map((b) => b.trackId))
    expect(lanes.size).toBe(1)
    const track = p.tracks.find((t) => t.id === [...lanes][0])!
    expect(track.director).toBe(true)
    expect(p.tracks[0].id).toBe(track.id)
    const sorted = [...backs].sort((a, b) => a.start - b.start)
    for (let i = 1; i < sorted.length; i++) expect(sorted[i].start).toBeGreaterThanOrEqual(sorted[i - 1].start + sorted[i - 1].duration - (sorted[i].transitionIn?.durationFrames ?? 0))
  })

  it('a transition into a shot crosses its backdrop the same way — and only when the shot before it has one too', () => {
    expect(TRANSITIONS.some((t) => t.family === 'dissolve'), 'a built-in dissolve to anchor').toBe(true)
    // The standard cut keeps the user's order: square, wide, tall, threeFour. A dissolve into each of the last three.
    const p2 = direct(edit(SET), [{ shot: 1, family: 'dissolve' }, { shot: 2, family: 'dissolve' }, { shot: 3, family: 'dissolve' }]).project
    const backs = backdropsOf(p2)
    const wide = shotFor(p2, 'wide')
    const wideBack = backs.find((b) => b.assetId === 'wide')!
    // Into the landscape clip, from the square: both have backdrops on the one lane, so the copy blends too.
    expect(wide.transitionIn).toBeDefined()
    expect(wideBack.transitionIn).toEqual(wide.transitionIn)
    // The square's backdrop is lengthened to blend from, exactly as the square itself is.
    const square = shotFor(p2, 'square')
    const squareBack = backs.find((b) => b.assetId === 'square')!
    expect(squareBack.duration).toBe(square.duration)
    expect(squareBack.start + squareBack.duration).toBeGreaterThan(wideBack.start)
    // Into the cropped 4:5 photo there is no backdrop to blend; into the cropped 3:4 neither.
    expect(shotFor(p2, 'tall').transitionIn).toBeDefined()
    expect(backs.some((b) => b.assetId === 'tall' || b.assetId === 'threeFour')).toBe(false)

    // The other way round — a square after a cropped photo: its backdrop has nothing before it on the lane, so it cuts.
    const p3 = direct(edit([asset('tall', 1080, 1350), asset('square', 2000, 2000), asset('threeFour', 1500, 2000), asset('wide', 1920, 1080, { name: 'wide.mp4', kind: 'video', durationFrames: 4 * fps, fps })]), [{ shot: 1, family: 'dissolve' }]).project
    expect(shotFor(p3, 'square').transitionIn).toBeDefined()
    expect(backdropsOf(p3).find((b) => b.assetId === 'square')!.transitionIn).toBeUndefined()
  })

  it('clearing the ad takes the backdrops and their lane with it; a re-run adds one lane, not another', () => {
    const cleared = clearDirector(p)
    expect(backdropsOf(cleared)).toEqual([])
    expect(cleared.tracks.map((t) => t.id)).toEqual(edit(SET).tracks.map((t) => t.id))
    const again = direct(p).project
    expect(again.tracks.filter((t) => t.director).length).toBe(1)
    expect(again.tracks.length).toBe(p.tracks.length)
  })

  it('a lane the user has since put a clip on is not taken away', () => {
    const lane = p.tracks[0]
    const own: Clip = { ...shotFor(p, 'tall'), id: 'mine', trackId: lane.id, start: 10_000, generatedBy: undefined }
    const cleared = clearDirector({ ...p, clips: [...p.clips, own] })
    expect(cleared.tracks.some((t) => t.id === lane.id)).toBe(true)
    expect(cleared.clips.some((c) => c.id === 'mine')).toBe(true)
  })

  it('a picture already the frame’s shape gets neither a crop nor a backdrop', () => {
    const p2 = direct(edit([asset('nine16', 1080, 1920), asset('square', 2000, 2000)])).project
    const shot = shotFor(p2, 'nine16')
    expect(shot.crop).toBeUndefined()
    expect(backdropsOf(p2).some((b) => b.assetId === 'nine16')).toBe(false)
  })
})

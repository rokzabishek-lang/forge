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
import { applyRecipe, type Applied2 } from '@shared/director/apply2'
import { SOUND_RULE, clearDirector } from '@shared/director/apply'
import { SOUND_LANE_NAME, pickSound, placeSounds, type PlaceSoundsOptions } from '@shared/director/sound'
import type { SoundPack } from '@shared/director/soundRoles'
import { HIT_TAIL_FADE_SECONDS, HIT_TAIL_MAX_SECONDS, MAX_SOUND_GAIN, PEAK_TAIL_FRAMES, SILENCE_RAMP_FRAMES, SOUND_LEVEL_DB, soundGain } from '@shared/render/soundLevels'
import type { Brief } from '@shared/director/schema'

/**
 * Sound design (docs/PLAN.md §6.1, §6.4): each sound's measured peak lands on
 * the event's frame, the levels come from one table normalised by the file's
 * own peak, the silence is the music's envelope, and the pack is picked by
 * role and length, varying by index. A pack of made-up files with known peaks
 * — the arithmetic is the thing under test, and it has to be right to the
 * frame before a render can show it.
 */

const fps = 30
const file = (id: string, role: SoundPack[number]['role'], seconds: number, peakSeconds: number, peakDb: number): SoundPack[number] => ({
  id, name: `${id}.wav`, file: `/sfx/${id}.wav`, role, seconds, peakSeconds, peakDb
})
const PACK: SoundPack = [
  file('riser4', 'riser', 4, 3.995, -10),
  file('riser2', 'riser', 2, 1.995, -12),
  file('sub1', 'sub', 1, 0.005, -3),
  file('sub2', 'sub', 0.8, 0.005, -1),
  file('whoosh', 'whoosh', 0.5, 0.25, -8),
  file('braam', 'braam', 10, 0.555, -2.4),
  file('swell', 'swell', 3, 2.98, -16.9)
]

function options(over: Partial<PlaceSoundsOptions> = {}): PlaceSoundsOptions {
  let n = 0
  return { fps, musicVolume: 1, intensity: 0.5, transitionFrames: 10, newId: (p) => `${p}-${++n}`, assets: [], laneFor: () => 'sfx-lane', ...over }
}

const peakFrameOf = (c: Clip, f: SoundPack[number]): number => c.start + Math.min(Math.round(f.seconds * fps) - 1, Math.round(f.peakSeconds * fps)) - c.inPoint

describe('where each sound lands', () => {
  it('a riser for a cut at frame 120 ends there: its peak on the cut, a few faded frames after, in over its first fifth', () => {
    const { clips } = placeSounds([{ event: 'riser', frame: 120 }], PACK, options())
    expect(clips).toHaveLength(1)
    const [c] = clips
    // The longest riser, 4 s: peak at its last frame, which is frame 120.
    expect(c.assetId).toBeDefined()
    expect(peakFrameOf(c, PACK[0])).toBe(120)
    expect(c.start).toBe(1)
    expect(c.inPoint).toBe(0)
    // The file has one frame after its peak, so that is the tail there is; a file with more is cut PEAK_TAIL_FRAMES past it.
    expect(c.start + c.duration).toBe(121)
    expect(c.fadeOut).toBe(PEAK_TAIL_FRAMES)
    const long = placeSounds([{ event: 'swell', frame: 120 }], [file('swellTail', 'swell', 5, 3.0, -9)], options()).clips[0]
    expect(long.start).toBe(120 - 90)
    expect(long.start + long.duration).toBe(120 + PEAK_TAIL_FRAMES)
    expect(long.fadeOut).toBe(PEAK_TAIL_FRAMES)
    expect(c.fadeIn).toBe(Math.round(0.2 * 119))
    expect(c.generatedBy?.rule).toBe(SOUND_RULE)
  })

  it('a riser with less room than its length starts part-way in, so the peak still lands', () => {
    const { clips } = placeSounds([{ event: 'riser', frame: 30 }], PACK, options())
    const [c] = clips
    expect(c.start).toBe(0)
    expect(c.inPoint).toBe(119 - 30)
    expect(peakFrameOf(c, PACK[0])).toBe(30)
  })

  it('a whoosh is centred on the transition: for ten frames from 100, its peak lands on 105', () => {
    const { clips } = placeSounds([{ event: 'whoosh', frame: 100 }], PACK, options({ transitionFrames: 10 }))
    const [c] = clips
    expect(peakFrameOf(c, PACK[4])).toBe(105)
    expect(c.start).toBe(105 - 8)
    expect(c.duration).toBe(15)
    expect(c.fadeIn).toBeUndefined()
  })

  it('a hit lands its peak on the frame and keeps its tail — but a ten-second braam is cut to four, faded', () => {
    const { clips } = placeSounds([{ event: 'braam', frame: 200 }], PACK, options())
    const [c] = clips
    expect(peakFrameOf(c, PACK[5])).toBe(200)
    expect(c.start).toBe(200 - Math.round(0.555 * fps))
    expect(c.duration).toBe(Math.round(0.555 * fps) + HIT_TAIL_MAX_SECONDS * fps)
    expect(c.fadeOut).toBe(HIT_TAIL_FADE_SECONDS * fps)
    // A sub-drop shorter than the cap plays out whole, with no fade of its own.
    const sub = placeSounds([{ event: 'sub', frame: 200 }], PACK, options()).clips[0]
    expect(sub.duration).toBe(Math.round(1 * fps))
    expect(sub.fadeOut).toBeUndefined()
  })

  it('the silence is not a clip: it is handed back as the music’s envelope, with where it returns', () => {
    const out = placeSounds([{ event: 'silence', frame: 300, untilFrame: 360 }, { event: 'silence', frame: 500 }], PACK, options())
    expect(out.clips).toEqual([])
    expect(out.silences).toEqual([{ at: 300, until: 360 }, { at: 500, until: null }])
  })
})

describe('which sound, and how loud', () => {
  it('picks by role, the longest first, and varies by index; a hit with no hit in the pack is a braam, then a sub', () => {
    expect(pickSound('riser', PACK, 0)!.id).toBe('riser4')
    expect(pickSound('riser', PACK, 1)!.id).toBe('riser2')
    expect(pickSound('riser', PACK, 2)!.id).toBe('riser4')
    expect(pickSound('hit', PACK, 0)!.id).toBe('braam')
    expect(pickSound('hit', PACK.filter((f) => f.role !== 'braam'), 0)!.id).toBe('sub1')
    expect(pickSound('sub', PACK, 1)!.id).toBe('sub2')
    expect(pickSound('swell', PACK.filter((f) => f.role !== 'swell'), 0)!.id).toBe('riser4')
    expect(pickSound('whoosh', PACK.filter((f) => f.role !== 'whoosh'), 0)).toBeNull()
    // Two subs in one ad are two different sounds.
    const { clips } = placeSounds([{ event: 'sub', frame: 100 }, { event: 'sub', frame: 400 }], PACK, options())
    expect(new Set(clips.map((c) => c.assetId)).size).toBe(2)
  })

  it('a level is the table’s, less the file’s own peak, on the music’s fader, moved by the intensity — and never more than the cap', () => {
    // A hit at −3 whose file peaks at −3: unity.
    expect(soundGain('hit', -3, 1)).toBeCloseTo(1, 6)
    // A quiet swell is lifted to its level: −8 against −12 is +4 dB.
    expect(20 * Math.log10(soundGain('swell', -12, 1))).toBeCloseTo(SOUND_LEVEL_DB.swell + 12, 6)
    // But never past the fader's ceiling the render clamps to: the library's quietest swell, −16.9, would want +8.9.
    expect(soundGain('swell', -16.9, 1)).toBe(MAX_SOUND_GAIN)
    expect(MAX_SOUND_GAIN).toBe(2)
    // On a music fader at half, half.
    expect(soundGain('hit', -3, 0.5)).toBeCloseTo(0.5, 6)
    // A loud ad's hits are hotter, a calm ad's quieter — two dB each way.
    expect(20 * Math.log10(soundGain('hit', -3, 1, 1))).toBeCloseTo(2, 6)
    expect(20 * Math.log10(soundGain('hit', -3, 1, 0))).toBeCloseTo(-2, 6)
    // A whisper is not boosted into hiss.
    expect(soundGain('riser', -40, 1)).toBe(MAX_SOUND_GAIN)
    const { clips } = placeSounds([{ event: 'sub', frame: 100 }], PACK, options({ musicVolume: 0.8, intensity: 0.5 }))
    expect(clips[0].volume).toBeCloseTo(soundGain('sub', -3, 0.8), 6)
  })

  it('with no pack the sounds are dropped with ONE note, and the silence still fires', () => {
    const out = placeSounds([{ event: 'riser', frame: 100 }, { event: 'sub', frame: 100 }, { event: 'silence', frame: 300, untilFrame: 340 }], [], options())
    expect(out.clips).toEqual([])
    expect(out.silences).toHaveLength(1)
    expect(out.problems).toHaveLength(1)
    expect(out.problems[0].message).toMatch(/no sound library is installed.*2 sounds not placed/)
  })

  it('a file already in the pool is reused; a new one is added once however often it plays', () => {
    const had: MediaAsset = { id: 'have', path: '/sfx/sub1.wav', name: 'sub1.wav', kind: 'audio', durationFrames: 30, width: null, height: null, fps: null, hasVideo: false, hasAudio: true, size: 1 }
    const out = placeSounds([{ event: 'sub', frame: 100 }, { event: 'sub', frame: 300 }, { event: 'sub', frame: 500 }], PACK, options({ assets: [had] }))
    expect(out.clips.map((c) => c.assetId)).toEqual(['have', out.assets[0].id, 'have'])
    expect(out.assets).toHaveLength(1)
    expect(out.assets[0]).toMatchObject({ path: '/sfx/sub2.wav', kind: 'audio', hasAudio: true, durationFrames: 24 })
  })

  it('with no lane to be had, the sound is not placed and says so', () => {
    const out = placeSounds([{ event: 'sub', frame: 100 }], PACK, options({ laneFor: () => null }))
    expect(out.clips).toEqual([])
    expect(out.problems[0].message).toMatch(/no lane for the sub/)
  })
})

/* ------------------------------------------------- through the whole ad */

const brief: Brief = { product: 'Aura serum', benefit: 'glow', audience: '', tone: 'premium', cta: 'Shop now', seconds: 20, language: 'English' }

function song(bpm: number, seconds: number): MusicAnalysis {
  const beatMs = 60_000 / bpm
  const beats: number[] = []
  for (let t = 0; t <= seconds * 1000; t += beatMs) beats.push(Math.round(t))
  return { bpm, beats, downbeats: beats.filter((_, i) => i % 4 === 0), tiers: beats.map(() => 2), drops: [], buildups: [], sections: [], durationMs: seconds * 1000 }
}

function edit(musicVolume = 1): Project {
  const asset = (id: string): MediaAsset => ({ id, path: `/media/${id}.jpg`, name: `${id}.jpg`, kind: 'image', durationFrames: 150, width: 1080, height: 1920, fps: null, hasVideo: true, hasAudio: false, size: 100 })
  const music: Clip = {
    id: 'music', assetId: 'song', trackId: 'a1', start: 0, duration: 20 * fps, inPoint: 0, volume: musicVolume,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, color: { brightness: 0, contrast: 1, saturation: 1 }
  }
  const empty = emptyProject()
  return {
    ...empty,
    settings: { ...empty.settings, width: 1080, height: 1920, fps },
    assets: [asset('p1'), asset('p2'), asset('p3'), asset('p4'), { ...asset('song'), name: 'song.m4a', kind: 'audio', width: null, height: null, hasVideo: false, hasAudio: true, durationFrames: 20 * fps }],
    clips: [music]
  }
}

function direct(p: Project, sounds: SoundPack | undefined): Applied2 {
  const slots = buildSlots(p)
  // The hero is the third picture: a riser has to have something before it to rise from.
  const heroes = [slots[2].id, ...slots.filter((_, i) => i !== 2).map((s) => s.id)]
  const menu: Menu2 = { slots, recipes: [PRODUCT_REVEAL], fallback: PRODUCT_REVEAL, heroCandidates: heroes, fps, seconds: 20, bpm: 100, holds: { min: 4, max: 8 }, drops: [] }
  const checked = validateSpine2(baselineSpine2(brief, menu, PRODUCT_REVEAL), menu)
  if ('rejected' in checked) throw new Error(checked.rejected)
  const grid = rhythmGrid(song(100, 20), { fps, seconds: 20, tempo: PRODUCT_REVEAL.tempo })
  let n = 0
  return applyRecipe(p, composeAd(checked.plan, checked.recipe, menu, grid), menu, {
    fps, videoTrackId: 'v1', brief, model: 'baseline', catalogue: [], musicClipId: 'music', newId: (x) => `${x}-${++n}`, ...(sounds ? { sounds } : {})
  })
}

const soundsOf = (p: Project): Clip[] => p.clips.filter((c) => c.generatedBy?.rule === SOUND_RULE)

describe('a product reveal, with its sounds', () => {
  const applied = direct(edit(0.8), PACK)
  const p = applied.project
  const music = p.clips.find((c) => c.id === 'music')!

  it('fires the recipe’s riser and sub on the hero, each on its own lane the Director added and named', () => {
    const placed = soundsOf(p)
    expect(placed.map((c) => c.generatedBy!.reason.split(' ')[0]).sort()).toEqual(['riser', 'sub'])
    const lanes = new Set(placed.map((c) => c.trackId))
    // Both peak on the hero's first frame: they overlap, so they need two lanes.
    expect(lanes.size).toBe(2)
    for (const id of lanes) {
      const track = p.tracks.find((t) => t.id === id)!
      expect(track.kind).toBe('audio')
      expect(track.director).toBe(true)
      expect(track.name).toBe(SOUND_LANE_NAME)
    }
    expect(applied.soundClipIds.sort()).toEqual(placed.map((c) => c.id).sort())
    // Their files are in the pool, once each, and their levels ride the music's fader.
    for (const c of placed) {
      expect(p.assets.find((a) => a.id === c.assetId)!.kind).toBe('audio')
      expect(c.volume).toBeLessThanOrEqual(MAX_SOUND_GAIN * 0.8)
    }
  })

  it('draws the silence on the music: gone over four frames before the black, back on the end card', () => {
    const keys = music.keyframes?.volume ?? []
    expect(keys).toHaveLength(4)
    const black = applied.project.clips.find((c) => c.generatedBy?.rule === 'director.ending' && c.generatedBy.reason.includes('before the end card'))!
    const endCard = applied.project.clips.find((c) => c.generatedBy?.rule === 'director.ending' && c.generatedBy.reason.includes('under the end card'))!
    expect(keys.map((k) => [k.frame, k.value])).toEqual([
      [black.start - SILENCE_RAMP_FRAMES, 0.8],
      [black.start, 0],
      [endCard.start, 0],
      [endCard.start + SILENCE_RAMP_FRAMES, 0.8]
    ])
    expect(music.directorTrim?.silenced).toBe(true)
  })

  it('clearing the ad takes the sounds, their files, their lanes and the silence with it', () => {
    const cleared = clearDirector(p)
    expect(soundsOf(cleared)).toEqual([])
    expect(cleared.assets.map((a) => a.id).sort()).toEqual(edit().assets.map((a) => a.id).sort())
    expect(cleared.tracks.map((t) => t.id)).toEqual(edit().tracks.map((t) => t.id))
    const restored = cleared.clips.find((c) => c.id === 'music')!
    expect(restored.keyframes?.volume).toBeUndefined()
    expect(restored.directorTrim).toBeUndefined()
    expect(restored.duration).toBe(20 * fps)
  })

  it('with no library the ad lands with one note and the silence still drawn', () => {
    const bare = direct(edit(), [])
    expect(soundsOf(bare.project)).toEqual([])
    expect(bare.problems.map((x) => x.message).join(' ')).toMatch(/no sound library is installed/)
    expect(bare.project.clips.find((c) => c.id === 'music')!.keyframes?.volume).toHaveLength(4)
    expect(bare.project.tracks.some((t) => t.kind === 'audio' && t.director)).toBe(false)
  })

  it('an envelope of the user’s own on the music is left alone, with a note', () => {
    const own = edit()
    own.clips[0] = { ...own.clips[0], keyframes: { volume: [{ frame: 0, value: 1 }, { frame: 100, value: 0.5 }] } }
    const out = direct(own, PACK)
    const m = out.project.clips.find((c) => c.id === 'music')!
    expect(m.keyframes?.volume).toHaveLength(2)
    expect(m.directorTrim?.silenced).toBeUndefined()
    expect(out.problems.map((x) => x.message).join(' ')).toMatch(/envelope of its own/)
  })
})

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
const byPath = new Map(PACK.map((f) => [f.file, f]))

function options(over: Partial<PlaceSoundsOptions> = {}): PlaceSoundsOptions {
  let n = 0
  return {
    fps, musicVolume: 1, intensity: 0.5, transitions: [{ frame: 100, frames: 10 }], endFrame: 100_000,
    newId: (p) => `${p}-${++n}`, assets: [], laneFor: () => 'sfx-lane', ...over
  }
}

const peakFrameOf = (c: Clip, f: SoundPack[number]): number => c.start + Math.min(Math.round(f.seconds * fps) - 1, Math.round(f.peakSeconds * fps)) - c.inPoint

describe('where each sound lands', () => {
  it('a riser for a cut at frame 120 ends there: its peak on the cut, in over its first fifth — and no fade over the peak itself', () => {
    const { clips } = placeSounds([{ event: 'riser', frame: 120 }], PACK, options())
    expect(clips).toHaveLength(1)
    const [c] = clips
    // The longest riser, 4 s: peak at its last frame, which is frame 120.
    expect(peakFrameOf(c, PACK[0])).toBe(120)
    expect(c.start).toBe(1)
    expect(c.inPoint).toBe(0)
    expect(c.start + c.duration).toBe(121)
    expect(c.fadeIn).toBe(Math.round(0.2 * 119))
    // The file stops dead at its peak: nothing after it to fade, and a fade over the peak would cut the climax.
    expect(c.fadeOut).toBeUndefined()
    expect(c.generatedBy?.rule).toBe(SOUND_RULE)
    // A file with a tail after its peak keeps a few frames of it, faded — the peak frame itself untouched.
    const long = placeSounds([{ event: 'swell', frame: 120 }], [file('swellTail', 'swell', 5, 3.0, -9)], options()).clips[0]
    expect(long.start).toBe(120 - 90)
    expect(long.start + long.duration).toBe(120 + 1 + PEAK_TAIL_FRAMES)
    expect(long.fadeOut).toBe(PEAK_TAIL_FRAMES)
    // A 3.1 s file is 93 frames, its peak frame 90: two frames after it, both kept, both the fade.
    const two = placeSounds([{ event: 'swell', frame: 120 }], [file('swellTwo', 'swell', 3.1, 3.0, -9)], options()).clips[0]
    expect(two.start + two.duration).toBe(120 + 1 + 2)
    expect(two.fadeOut).toBe(2)
  })

  it('a riser with less room than its length starts part-way in, so the peak still lands', () => {
    const { clips } = placeSounds([{ event: 'riser', frame: 30 }], PACK, options())
    const [c] = clips
    expect(c.start).toBe(0)
    expect(c.inPoint).toBe(119 - 30)
    expect(peakFrameOf(c, PACK[0])).toBe(30)
  })

  it('a whoosh is centred on the transition that landed there; a whip that became a cut takes its whoosh with it', () => {
    const { clips } = placeSounds([{ event: 'whoosh', frame: 100 }], PACK, options({ transitions: [{ frame: 100, frames: 10 }] }))
    const [c] = clips
    expect(peakFrameOf(c, PACK[4])).toBe(105)
    expect(c.start).toBe(105 - 8)
    expect(c.duration).toBe(15)
    expect(c.fadeIn).toBeUndefined()
    // The blend was shortened to the footage there: the whoosh is centred on what actually runs.
    expect(peakFrameOf(placeSounds([{ event: 'whoosh', frame: 100 }], PACK, options({ transitions: [{ frame: 100, frames: 4 }] })).clips[0], PACK[4])).toBe(102)
    // No transition landed at that frame — the apply step cut instead — so the whoosh is dropped, and says so.
    const cut = placeSounds([{ event: 'whoosh', frame: 100 }], PACK, options({ transitions: [{ frame: 400, frames: 10 }] }))
    expect(cut.clips).toEqual([])
    expect(cut.problems.map((p) => p.message).join(' ')).toMatch(/whip at 3\.33 s became a cut — its whoosh goes/)
  })

  it('a hit lands its peak on the frame and keeps its tail — but a ten-second braam is cut to four, faded', () => {
    const { clips } = placeSounds([{ event: 'braam', frame: 200 }], PACK, options())
    const [c] = clips
    expect(peakFrameOf(c, PACK[5])).toBe(200)
    expect(c.start).toBe(200 - Math.round(0.555 * fps))
    expect(c.duration).toBe(Math.round(0.555 * fps) + 1 + HIT_TAIL_MAX_SECONDS * fps)
    expect(c.fadeOut).toBe(HIT_TAIL_FADE_SECONDS * fps)
    // A sub-drop shorter than the cap plays out whole, with no fade of its own.
    const sub = placeSounds([{ event: 'sub', frame: 200 }], PACK, options()).clips[0]
    expect(sub.duration).toBe(Math.round(1 * fps))
    expect(sub.fadeOut).toBeUndefined()
  })

  it('no sound runs past the ad’s end: a braam before the black stops with the end card, faded over what is left', () => {
    // The ad ends 30 frames after the braam's frame: its four-second tail is cut to those frames.
    const { clips } = placeSounds([{ event: 'braam', frame: 200 }], PACK, options({ endFrame: 230 }))
    const [c] = clips
    expect(peakFrameOf(c, PACK[5])).toBe(200)
    expect(c.start + c.duration).toBe(230)
    expect(c.fadeOut).toBe(230 - 200 - 1)
    // A riser whose peak would fall after the end is not placed at all.
    const late = placeSounds([{ event: 'riser', frame: 200 }], PACK, options({ endFrame: 199 }))
    expect(late.clips).toEqual([])
    expect(late.problems[0].message).toMatch(/falls after the ad ends/)
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

  it('a level is the table’s, less the file’s own peak, on the music’s fader, moved by the intensity — capped only where the render would clamp it', () => {
    // A hit at −3 whose file peaks at −3: unity.
    expect(soundGain('hit', -3, 1)).toBeCloseTo(1, 6)
    // A quiet swell is lifted to its level: −8 against −12 is +4 dB.
    expect(20 * Math.log10(soundGain('swell', -12, 1))).toBeCloseTo(SOUND_LEVEL_DB.swell + 12, 6)
    // On a music fader at half, half.
    expect(soundGain('hit', -3, 0.5)).toBeCloseTo(0.5, 6)
    // A loud ad's hits are hotter, a calm ad's quieter — two dB each way.
    expect(20 * Math.log10(soundGain('hit', -3, 1, 1))).toBeCloseTo(2, 6)
    expect(20 * Math.log10(soundGain('hit', -3, 1, 0))).toBeCloseTo(-2, 6)
    // The cap is the fader's ceiling the render clamps to — on what is WRITTEN, fader included: a quiet swell
    // that would want +8.9 dB is capped on a fader at unity, and not on a fader at half, where it fits.
    expect(MAX_SOUND_GAIN).toBe(2)
    expect(soundGain('swell', -16.9, 1)).toBe(MAX_SOUND_GAIN)
    expect(soundGain('swell', -16.9, 0.5)).toBeCloseTo(Math.pow(10, (SOUND_LEVEL_DB.swell + 16.9) / 20) * 0.5, 6)
    expect(soundGain('hit', -3, 4)).toBe(MAX_SOUND_GAIN)
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

  it('a file already in the pool is reused; a new one is added once, marked as the Director’s, however often it plays', () => {
    const had: MediaAsset = { id: 'have', path: '/sfx/sub1.wav', name: 'sub1.wav', kind: 'audio', durationFrames: 30, width: null, height: null, fps: null, hasVideo: false, hasAudio: true, size: 1 }
    const out = placeSounds([{ event: 'sub', frame: 100 }, { event: 'sub', frame: 300 }, { event: 'sub', frame: 500 }], PACK, options({ assets: [had] }))
    expect(out.clips.map((c) => c.assetId)).toEqual(['have', out.assets[0].id, 'have'])
    expect(out.assets).toHaveLength(1)
    expect(out.assets[0]).toMatchObject({ path: '/sfx/sub2.wav', kind: 'audio', hasAudio: true, durationFrames: 24, broughtBy: SOUND_RULE })
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

/** Four photos and a song, the song's clip at `musicStart` with its fader at `musicVolume`. */
function edit(musicVolume = 1, musicStart = 0, extraAssets: MediaAsset[] = []): Project {
  const asset = (id: string): MediaAsset => ({ id, path: `/media/${id}.jpg`, name: `${id}.jpg`, kind: 'image', durationFrames: 150, width: 1080, height: 1920, fps: null, hasVideo: true, hasAudio: false, size: 100 })
  const music: Clip = {
    id: 'music', assetId: 'song', trackId: 'a1', start: musicStart, duration: 20 * fps, inPoint: 0, volume: musicVolume,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, color: { brightness: 0, contrast: 1, saturation: 1 }
  }
  const empty = emptyProject()
  return {
    ...empty,
    settings: { ...empty.settings, width: 1080, height: 1920, fps },
    assets: [asset('p1'), asset('p2'), asset('p3'), asset('p4'), { ...asset('song'), name: 'song.m4a', kind: 'audio', width: null, height: null, hasVideo: false, hasAudio: true, durationFrames: 20 * fps }, ...extraAssets],
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
  // The ad starts where the music does, as the store lays it (offsetFrames).
  const grid = rhythmGrid(song(100, 20), { fps, seconds: 20, tempo: PRODUCT_REVEAL.tempo, offsetFrames: p.clips[0].start })
  let n = 0
  return applyRecipe(p, composeAd(checked.plan, checked.recipe, menu, grid), menu, {
    fps, videoTrackId: 'v1', brief, model: 'baseline', catalogue: [], musicClipId: 'music', newId: (x) => `${x}-${++n}`, ...(sounds ? { sounds } : {})
  })
}

const soundsOf = (p: Project): Clip[] => p.clips.filter((c) => c.generatedBy?.rule === SOUND_RULE)
const endingClip = (p: Project, reason: string): Clip => p.clips.find((c) => c.generatedBy?.rule === 'director.ending' && c.generatedBy.reason.includes(reason))!

describe('a product reveal, with its sounds', () => {
  const applied = direct(edit(0.8), PACK)
  const p = applied.project
  const music = p.clips.find((c) => c.id === 'music')!

  it('fires the recipe’s riser and sub on the hero, each on its own lane the Director added and named, at levels on the music’s fader', () => {
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
    // Their files are in the pool, once each, and each level is exactly the table's on the music's 0.8.
    for (const c of placed) {
      const asset = p.assets.find((a) => a.id === c.assetId)!
      expect(asset.kind).toBe('audio')
      const entry = byPath.get(asset.path)!
      expect(c.volume).toBeCloseTo(soundGain(c.generatedBy!.reason.split(' ')[0] as 'riser' | 'sub', entry.peakDb, 0.8, PRODUCT_REVEAL.intensity), 6)
    }
  })

  it('draws the silence on the music: gone over four frames before the black, back on the end card', () => {
    const keys = music.keyframes?.volume ?? []
    expect(keys).toHaveLength(4)
    const black = endingClip(p, 'before the end card')
    const endCard = endingClip(p, 'under the end card')
    expect(keys.map((k) => [k.frame, k.value])).toEqual([
      [black.start - SILENCE_RAMP_FRAMES, 0.8],
      [black.start, 0],
      [endCard.start, 0],
      [endCard.start + SILENCE_RAMP_FRAMES, 0.8]
    ])
    expect(music.directorTrim?.silenced).toBe(true)
  })

  it('a song placed later on the timeline gets the same silence, in its own frames', () => {
    const later = direct(edit(1, 45), PACK).project
    const m = later.clips.find((c) => c.id === 'music')!
    const black = endingClip(later, 'before the end card')
    const endCard = endingClip(later, 'under the end card')
    expect(black.start).toBeGreaterThan(45)
    expect(m.keyframes!.volume!.map((k) => k.frame)).toEqual([black.start - 45 - SILENCE_RAMP_FRAMES, black.start - 45, endCard.start - 45, endCard.start - 45 + SILENCE_RAMP_FRAMES])
    // The sounds land on the hero's timeline frame, wherever the song sits.
    const hero = later.clips.find((c) => c.generatedBy?.rule === 'director.spine' && c.generatedBy.reason.includes('hero'))!
    for (const c of soundsOf(later)) expect(peakFrameOf(c, byPath.get(later.assets.find((a) => a.id === c.assetId)!.path)!)).toBe(hero.start)
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

  it('a sound the user imported is reused and kept on Clear; only what the Director brought goes', () => {
    const mine: MediaAsset = { id: 'my-sub', path: '/sfx/sub1.wav', name: 'sub1.wav', kind: 'audio', durationFrames: 30, width: null, height: null, fps: null, hasVideo: false, hasAudio: true, size: 4000 }
    const out = direct(edit(1, 0, [mine]), PACK)
    const sub = soundsOf(out.project).find((c) => c.generatedBy!.reason.startsWith('sub'))!
    expect(sub.assetId).toBe('my-sub')
    const cleared = clearDirector(out.project)
    expect(cleared.assets.some((a) => a.id === 'my-sub')).toBe(true)
    expect(cleared.assets.some((a) => a.broughtBy === SOUND_RULE)).toBe(false)
  })

  it('with no library the ad lands with one note and the silence still drawn', () => {
    const bare = direct(edit(), [])
    expect(soundsOf(bare.project)).toEqual([])
    expect(bare.problems.map((x) => x.message).join(' ')).toMatch(/no sound library is installed/)
    expect(bare.project.clips.find((c) => c.id === 'music')!.keyframes?.volume).toHaveLength(4)
    expect(bare.project.tracks.some((t) => t.kind === 'audio' && t.director)).toBe(false)
  })

  it('music turned all the way down: the sounds stand at their own level, with a note, rather than vanishing', () => {
    const out = direct(edit(0), PACK)
    const placed = soundsOf(out.project)
    expect(placed.length).toBe(2)
    for (const c of placed) expect(c.volume).toBeGreaterThan(0)
    expect(out.problems.map((x) => x.message).join(' ')).toMatch(/music is turned all the way down/)
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

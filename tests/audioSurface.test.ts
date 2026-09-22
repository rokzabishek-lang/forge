import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { EMPTY_MENU_STATE, mustAskBeforeClosing } from '../src/main/menu'
import {
  MAX_GAIN,
  SILENT_DB,
  FADER_FLOOR_DB,
  clampGain,
  gainToDb,
  dbToGain,
  formatDb,
  faderPosition,
  gainAtPosition,
  anySolo,
  isAudible,
  audioRole,
  clipLevelAt
} from '@shared/render/audibility'
import {
  METER_SILENT,
  METER_FLOOR_DB,
  METER_HOLD_MS,
  METER_FALL_DB_PER_SECOND,
  METER_CLIP_DB,
  meterStep,
  peakToDb,
  meterFraction,
  isClipping
} from '@shared/render/meter'
import { PROPERTY_INFO, axisPosition, formatKeyed, valueAt, valueAtAxis } from '@shared/render/keyframes'
import { detachAudio, detachRefusalMessage, reattachAudio, placeTake } from '@shared/edit/recipes'
import { voiceOverArgs, takeName, recorderType, RECORDER_TYPES, safeTakeBase } from '@shared/render/voiceover'
import { buildRenderPlan } from '@shared/render/plan'
import { MAX_TRACKS, emptyProject, type Clip, type MediaAsset, type Project, type Track } from '@shared/timeline'

const track = (over: Partial<Track> = {}): Track => ({
  id: 't', kind: 'audio', name: 'A1', muted: false, hidden: false, locked: false, ...over
})

/* ---------------------------------------------------------------- level */

describe('the level ceiling', () => {
  it('is +6 dB, and every editor of it reads the same number', () => {
    expect(MAX_GAIN).toBe(2)
    expect(gainToDb(MAX_GAIN)).toBeCloseTo(6.02, 2)
    // The curve editor, the keyframe lane and the curve panel all take their
    // range from here — this is the number that lets an envelope lift a clip.
    expect(PROPERTY_INFO.volume.max).toBe(MAX_GAIN)
  })

  it('clamps into range and treats nonsense as silence', () => {
    expect(clampGain(1.5)).toBe(1.5)
    expect(clampGain(50)).toBe(MAX_GAIN)
    for (const bad of [-1, 0, Number.NaN, Number.NEGATIVE_INFINITY, undefined]) {
      expect(clampGain(bad), String(bad)).toBe(0)
    }
    // Infinity is nonsense too, and nonsense is SILENCE rather than the
    // ceiling: a corrupt level should fail quiet, never at full blast.
    expect(clampGain(Number.POSITIVE_INFINITY)).toBe(0)
  })

  it('converts between gain and dB both ways', () => {
    expect(gainToDb(1)).toBe(0)
    expect(gainToDb(0.5)).toBeCloseTo(-6.02, 2)
    expect(gainToDb(0)).toBe(Number.NEGATIVE_INFINITY)
    expect(dbToGain(0)).toBe(1)
    expect(dbToGain(6)).toBeCloseTo(1.995, 3)
    // At or below the floor is silence, not a very small number.
    expect(dbToGain(SILENT_DB)).toBe(0)
    expect(dbToGain(-200)).toBe(0)
    // And dB above the ceiling comes back clamped.
    expect(dbToGain(20)).toBe(MAX_GAIN)
  })

  it('reads the way a fader is read', () => {
    expect(formatDb(1)).toBe('0 dB')
    expect(formatDb(0)).toBe('−∞ dB')
    expect(formatDb(2)).toBe('+6 dB')
    expect(formatDb(0.5)).toBe('−6 dB')
    // A real minus sign, so a column of them does not wobble.
    expect(formatDb(0.25)).toMatch(/^−/)
  })
})

describe('the fader curve', () => {
  it('puts unity high on the travel, the way a desk does', () => {
    /*
     * Linear in dB. With a ceiling of 2, a fader linear in GAIN would put
     * unity exactly half-way and every existing envelope would look turned
     * down by half.
     */
    const unity = faderPosition(1)
    expect(unity).toBeGreaterThan(0.8)
    expect(unity).toBeLessThan(0.95)
    expect(faderPosition(MAX_GAIN)).toBe(1)
    expect(faderPosition(0)).toBe(0)
  })

  it('moves in equal steps of loudness', () => {
    // −6 dB to 0 dB takes the same travel as −12 dB to −6 dB.
    const a = faderPosition(dbToGain(-12))
    const b = faderPosition(dbToGain(-6))
    const c = faderPosition(dbToGain(0))
    expect(b - a).toBeCloseTo(c - b, 6)
  })

  it('round-trips a level through the fader', () => {
    /*
     * Above the floor. −40 dB (0.01) IS the bottom of the travel, which reads
     * as silence by design — the same place a desk puts −∞ — and the fader's
     * smallest non-zero step, 1/1000 of the way up, lands just above it.
     */
    expect(faderPosition(0.01)).toBe(0)
    expect(gainAtPosition(0.001)).toBeGreaterThan(0.01)
    for (const gain of [0.012, 0.1, 0.25, 0.5, 1, 1.5, 2]) {
      expect(gainAtPosition(faderPosition(gain)), String(gain)).toBeCloseTo(gain, 4)
    }
    // The bottom of the travel is silence, not the floor level.
    expect(gainAtPosition(0)).toBe(0)
    expect(faderPosition(dbToGain(FADER_FLOOR_DB - 10))).toBe(0)
  })
})

/* ----------------------------------------------------------- who is heard */

describe('who is heard', () => {
  it('drops a muted track, of either kind', () => {
    /*
     * The bug: a muted VIDEO track was silenced by the preview and ignored by
     * the export, so it played silently in the editor and spoke in the file.
     */
    const tracks = [track({ id: 'v', kind: 'video', muted: true }), track({ id: 'a' })]
    expect(isAudible(tracks[0], tracks)).toBe(false)
    expect(isAudible(tracks[1], tracks)).toBe(true)
  })

  it('drops a hidden video track, but ignores hidden on an audio track', () => {
    const v = track({ id: 'v', kind: 'video', hidden: true })
    const a = track({ id: 'a', hidden: true })
    expect(isAudible(v, [v, a])).toBe(false)
    // An audio track has no picture to hide; the flag has no meaning there.
    expect(isAudible(a, [v, a])).toBe(true)
  })

  it('hears only soloed tracks while any is soloed — video included', () => {
    const tracks = [
      track({ id: 'v', kind: 'video' }),
      track({ id: 'music' }),
      track({ id: 'vo', solo: true })
    ]
    expect(anySolo(tracks)).toBe(true)
    expect(isAudible(tracks[2], tracks)).toBe(true)
    expect(isAudible(tracks[1], tracks)).toBe(false)
    // A solo that let the dialogue through would isolate nothing.
    expect(isAudible(tracks[0], tracks)).toBe(false)
  })

  it('never lets a solo override a mute', () => {
    const tracks = [track({ id: 'a', solo: true, muted: true }), track({ id: 'b' })]
    expect(isAudible(tracks[0], tracks)).toBe(false)
  })

  it('hears everything unmuted when nothing is soloed', () => {
    const tracks = [track({ id: 'v', kind: 'video' }), track({ id: 'a' })]
    expect(anySolo(tracks)).toBe(false)
    expect(tracks.every((t) => isAudible(t, tracks))).toBe(true)
  })
})

describe('which bus a track plays on', () => {
  it('makes video dialogue, a marked audio track dialogue, a ducked one music', () => {
    expect(audioRole(track({ kind: 'video' }))).toBe('dialogue')
    expect(audioRole(track({ dialogue: true }))).toBe('dialogue')
    expect(audioRole(track({ duck: true }))).toBe('music')
    expect(audioRole(track())).toBe('other')
  })

  it('lets dialogue win over duck when an audio track asks for both', () => {
    // A voice cannot duck under itself, and losing it under the bed is worse.
    expect(audioRole(track({ dialogue: true, duck: true }))).toBe('dialogue')
  })
})

/* ---------------------------------------------------------------- meters */

describe('meter ballistics', () => {
  it('reads a peak the frame it happens', () => {
    const next = meterStep(METER_SILENT, 0.5, 1000, 16)
    expect(next.level).toBeCloseTo(peakToDb(0.5), 6)
    expect(next.hold).toBeCloseTo(peakToDb(0.5), 6)
  })

  it('falls back at a steady rate, not instantly', () => {
    const hot = meterStep(METER_SILENT, 1, 0, 16)
    const after = meterStep(hot, 0, 500, 500)
    // Half a second at the fall rate.
    expect(hot.level - after.level).toBeCloseTo(METER_FALL_DB_PER_SECOND / 2, 6)
  })

  it('holds the peak marker, then lets it fall', () => {
    const hot = meterStep(METER_SILENT, 1, 0, 16)
    const holding = meterStep(hot, 0, METER_HOLD_MS - 1, METER_HOLD_MS - 1)
    expect(holding.hold).toBe(hot.hold)

    const released = meterStep(holding, 0, METER_HOLD_MS + 500, 501)
    expect(released.hold).toBeLessThan(hot.hold)
    // Never below the bar it is marking.
    expect(released.hold).toBeGreaterThanOrEqual(released.level)
  })

  it('lets a released hold settle ON the bar, never under it', () => {
    /*
     * The case that shows it: a loud peak, then a steady signal held just
     * beneath it for longer than the hold. The marker falls — and must stop
     * where the bar is, because a hold marker below the level it marks is
     * marking nothing. A silent signal after the peak cannot show this: the
     * bar falls too, and stays under the marker either way.
     */
    let s = meterStep(METER_SILENT, 1, 0, 16)
    for (let t = 100; t <= METER_HOLD_MS + 4000; t += 100) {
      s = meterStep(s, 0.5, t, 100)
      expect(s.hold, `at ${t}ms`).toBeGreaterThanOrEqual(s.level)
    }
    expect(s.hold).toBeCloseTo(peakToDb(0.5), 6)
  })

  it('bottoms out at the floor and survives a huge step', () => {
    const hot = meterStep(METER_SILENT, 1, 0, 16)
    const later = meterStep(hot, 0, 1e9, 1e9)
    expect(later.level).toBe(METER_FLOOR_DB)
    expect(Number.isFinite(later.level)).toBe(true)
    // A negative elapsed time is a clock going backwards, not a rise.
    expect(meterStep(hot, 0, 0, -500).level).toBe(hot.level)
  })

  it('turns red within a dB of full scale', () => {
    expect(isClipping(METER_CLIP_DB)).toBe(true)
    expect(isClipping(-1.5)).toBe(false)
    expect(meterFraction(0)).toBe(1)
    expect(meterFraction(METER_FLOOR_DB)).toBe(0)
    expect(meterFraction(Number.NEGATIVE_INFINITY)).toBe(0)
    expect(peakToDb(0)).toBe(METER_FLOOR_DB)
  })
})

/* ---------------------------------------------------------- detach audio */

const W = 320
const H = 240
const asset = (over: Partial<MediaAsset> = {}): MediaAsset => ({
  id: 'v', path: '/tmp/v.mp4', name: 'v.mp4', kind: 'video', durationFrames: 300,
  width: W, height: H, fps: 30, hasVideo: true, hasAudio: true, size: 1, ...over
})
const clip = (over: Partial<Clip> = {}): Clip => ({
  id: 'c', assetId: 'v', trackId: 'v1', start: 30, duration: 90, inPoint: 12, volume: 0.8,
  transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
  color: { brightness: 0, contrast: 1, saturation: 1 }, ...over
})
const project = (clips: Clip[], assets: MediaAsset[] = [asset()]): Project => ({
  ...emptyProject(),
  settings: { width: W, height: H, fps: 30, sampleRate: 48000 },
  assets,
  clips
})
const at = (p: Project, id: string): Clip => p.clips.find((c) => c.id === id)!

/** A detach that must succeed — and a readable failure if it did not. */
function lifted(p: Project, id = 'c'): { project: Project; audioClipId: string } {
  const result = detachAudio(p, id)
  if (!result.ok) throw new Error(`detach refused: ${result.reason}`)
  return result
}
const laneOf = (r: { project: Project; audioClipId: string }): Track =>
  r.project.tracks.find((t) => t.id === at(r.project, r.audioClipId).trackId)!
const withTracks = (p: Project, over: Record<string, Partial<Track>>): Project => ({
  ...p,
  tracks: p.tracks.map((t) => ({ ...t, ...(over[t.id] ?? {}) }))
})

describe('detaching a clip’s sound', () => {
  it('lands the sound at exactly the same frame, carrying everything about it', () => {
    const envelope = [{ frame: 0, value: 1 }, { frame: 60, value: 0.2 }]
    const p = project([
      clip({ speed: 1.5, fadeIn: 5, fadeOut: 9, voice: { id: 'deep' }, keyframes: { volume: envelope } })
    ])
    const result = lifted(p)
    const sound = at(result.project, result.audioClipId)

    // One frame off is lip-sync drift.
    expect(sound.start).toBe(30)
    expect(sound.duration).toBe(90)
    expect(sound.inPoint).toBe(12)
    expect(sound.speed).toBe(1.5)
    expect(sound.volume).toBe(0.8)
    expect(sound.fadeIn).toBe(5)
    expect(sound.fadeOut).toBe(9)
    expect(sound.voice).toEqual({ id: 'deep' })
    expect(sound.keyframes?.volume).toEqual(envelope)
    expect(laneOf(result).kind).toBe('audio')
  })

  it('FLAGS the original rather than zeroing its fader', () => {
    /*
     * The render keeps a zero-volume clip that has an envelope — the guard is
     * `volume === 0 && !hasEnvelope` — so zeroing the fader would have left a
     * drawn envelope still speaking in the file. The fader is left as it was,
     * which is also what lets the sound be put back exactly.
     */
    const p = project([clip({ keyframes: { volume: [{ frame: 0, value: 1 }] } })])
    const original = at(lifted(p).project, 'c')
    expect(original.audioDetached).toBe(true)
    expect(original.volume).toBe(0.8)
  })

  it('makes a new lane rather than sliding the sound to find room', () => {
    const busy = project([
      clip(),
      clip({ id: 'bed', trackId: 'a1', start: 0, duration: 600, assetId: 'v' }),
      clip({ id: 'bed2', trackId: 'a2', start: 0, duration: 600, assetId: 'v' })
    ])
    const before = busy.tracks.length
    const result = lifted(busy)
    const sound = at(result.project, result.audioClipId)
    expect(result.project.tracks.length).toBe(before + 1)
    expect(sound.start).toBe(30)
    expect(['a1', 'a2']).not.toContain(sound.trackId)
  })

  it('uses a free lane when there is one', () => {
    const result = lifted(project([clip()]))
    expect(at(result.project, result.audioClipId).trackId).toBe('a1')
    expect(result.project.tracks).toHaveLength(emptyProject().tracks.length)
  })

  it('says WHY it refused, one reason per case', () => {
    /*
     * Every refusal used to be a bare null, and the store read every null as
     * "that clip has no sound" — including a clip that plainly had sound and
     * was refused for want of room. Found by the B1 review.
     */
    const refused = (p: Project, id = 'c'): unknown => detachAudio(p, id)
    expect(refused(project([clip()], [asset({ hasAudio: false })]))).toEqual({ ok: false, reason: 'no-sound' })
    expect(refused(project([clip()], [asset({ kind: 'image' })]))).toEqual({ ok: false, reason: 'no-sound' })
    expect(refused(project([clip({ trackId: 'a1' })]))).toEqual({ ok: false, reason: 'no-sound' })
    expect(refused(project([clip({ audioDetached: true })]))).toEqual({ ok: false, reason: 'already-detached' })
    expect(refused(project([clip()]), 'nope')).toEqual({ ok: false, reason: 'no-clip' })
  })

  it('refuses at the track limit — as NO ROOM, not as no sound', () => {
    let p = project([clip()])
    // Fill every audio lane for the clip's span, then fill the track limit.
    const lanes: Clip[] = []
    while (p.tracks.length < MAX_TRACKS) {
      p = { ...p, tracks: [...p.tracks, track({ id: `x${p.tracks.length}` })] }
    }
    for (const t of p.tracks.filter((t) => t.kind === 'audio')) {
      lanes.push(clip({ id: `fill-${t.id}`, trackId: t.id, start: 0, duration: 600 }))
    }
    p = { ...p, clips: [...p.clips, ...lanes] }
    expect(detachAudio(p, 'c')).toEqual({ ok: false, reason: 'no-room' })
  })

  it('tells each refusal apart in words, and never calls a sound-carrying clip silent', () => {
    const reasons = ['no-clip', 'no-sound', 'already-detached', 'no-room'] as const
    const said = reasons.map((r) => detachRefusalMessage(r))
    expect(new Set(said).size).toBe(reasons.length)
    expect(detachRefusalMessage('no-room')).not.toMatch(/no sound/i)
    expect(detachRefusalMessage('no-room')).toContain(String(MAX_TRACKS))
    expect(detachRefusalMessage('no-sound')).toMatch(/no sound/i)
  })

  it('reattaches by clearing the flag and leaving the lifted clip alone', () => {
    const detached = lifted(project([clip()]))
    const back = reattachAudio(detached.project, 'c')
    expect(at(back, 'c').audioDetached).toBeUndefined()
    expect('audioDetached' in at(back, 'c')).toBe(false)
    // Deleting someone's edit to undo a different one is not done silently.
    expect(back.clips.some((c) => c.id === detached.audioClipId)).toBe(true)
    // Nothing to reattach leaves the project alone.
    expect(reattachAudio(back, 'c')).toBe(back)
  })
})

describe('the lifted sound plays as it did', () => {
  /** Heard before (from the picture's track) and after (from its lane) alike. */
  const heardTheSame = (before: Project, r: { project: Project; audioClipId: string }): void => {
    const source = before.tracks.find((t) => t.id === 'v1')!
    expect(isAudible(laneOf(r), r.project.tracks)).toBe(isAudible(source, before.tracks))
  }

  it('skips a MUTED free lane — the sound would vanish there', () => {
    const p = withTracks(project([clip()]), { a1: { muted: true } })
    const r = lifted(p)
    expect(laneOf(r).id).toBe('a2')
    heardTheSame(p, r)
  })

  it('makes a new, unmuted lane when every free lane is muted', () => {
    const p = withTracks(project([clip()]), { a1: { muted: true }, a2: { muted: true } })
    const r = lifted(p)
    expect(r.project.tracks).toHaveLength(p.tracks.length + 1)
    expect(laneOf(r).muted).toBe(false)
    heardTheSame(p, r)
  })

  it('stays audible while the picture’s own track is soloed', () => {
    // v1 soloed: an unsoloed lane would silence the sound the moment it moved.
    const p = withTracks(project([clip()]), { v1: { solo: true } })
    const r = lifted(p)
    expect(laneOf(r).solo).toBe(true)
    heardTheSame(p, r)
    // And the new lane is the ONLY thing that changed about who is soloed.
    expect(r.project.tracks.filter((t) => t.solo).map((t) => t.id).sort()).toEqual(
      ['v1', laneOf(r).id].sort()
    )
  })

  it('uses a soloed free lane when the picture’s track is soloed', () => {
    const p = withTracks(project([clip()]), { v1: { solo: true }, a2: { solo: true } })
    const r = lifted(p)
    expect(laneOf(r).id).toBe('a2')
    expect(r.project.tracks).toHaveLength(p.tracks.length)
    heardTheSame(p, r)
  })

  it('stays silent while something ELSE is soloed, rather than jumping in', () => {
    // a1 is soloed and free; v1 is not soloed, so the sound is not heard now.
    const p = withTracks(project([clip()]), { a1: { solo: true } })
    const r = lifted(p)
    expect(laneOf(r).id).toBe('a2')
    heardTheSame(p, r)
  })

  it('keeps footage’s sound as DIALOGUE, so music still ducks under it', () => {
    // a1 is an empty ducked music lane: dialogue there would duck under itself.
    const p = withTracks(project([clip()]), { a1: { duck: true } })
    const r = lifted(p)
    expect(laneOf(r).id).toBe('a2')
    expect(audioRole(laneOf(r))).toBe('dialogue')
    // The ducked lane is left as it was.
    expect(r.project.tracks.find((t) => t.id === 'a1')).toEqual(p.tracks.find((t) => t.id === 'a1'))
  })

  it('never re-roles a lane that has other clips on it', () => {
    // a1 has a sound effect elsewhere; marking a1 as dialogue would make the
    // music duck under that effect too. a2 is empty and becomes the lane.
    const sfx = clip({ id: 'sfx', trackId: 'a1', start: 400, duration: 30 })
    const p = project([clip(), sfx])
    const r = lifted(p)
    expect(laneOf(r).id).toBe('a2')
    expect(r.project.tracks.find((t) => t.id === 'a1')?.dialogue).toBeUndefined()
  })

  it('shares a lane that is already dialogue, where the span is free', () => {
    const earlier = clip({ id: 'vo', trackId: 'a1', start: 400, duration: 30 })
    const p = withTracks(project([clip(), earlier]), { a1: { dialogue: true } })
    expect(laneOf(lifted(p)).id).toBe('a1')
  })

  it('marks a new lane as dialogue too', () => {
    const p = withTracks(project([clip()]), { a1: { duck: true }, a2: { locked: true } })
    const r = lifted(p)
    expect(r.project.tracks).toHaveLength(p.tracks.length + 1)
    expect(audioRole(laneOf(r))).toBe('dialogue')
  })
})

/* ------------------------------------------------------------ voice-over */

describe('a recorded take', () => {
  const take = asset({ id: 'take', kind: 'audio', hasVideo: false, durationFrames: 75, width: null, height: null })

  it('lands where it was spoken, on the armed track, marked as speech', () => {
    const result = placeTake(project([]), 'a1', take, 42)!
    const placed = at(result.project, result.clipId)
    expect(placed.start).toBe(42)
    expect(placed.duration).toBe(75)
    expect(placed.trackId).toBe('a1')
    expect(result.project.tracks.find((t) => t.id === 'a1')?.dialogue).toBe(true)
    expect(result.project.assets.filter((a) => a.id === 'take')).toHaveLength(1)
  })

  it('takes a new track rather than sliding a busy one', () => {
    // A voice-over a second late is talking about the wrong shot.
    const busy = project([clip({ id: 'bed', trackId: 'a1', start: 0, duration: 600 })])
    const result = placeTake(busy, 'a1', take, 42)!
    expect(result.trackId).not.toBe('a1')
    expect(at(result.project, result.clipId).start).toBe(42)
    expect(result.project.tracks.find((t) => t.id === result.trackId)?.dialogue).toBe(true)
  })

  it('does not add the asset twice', () => {
    const p = { ...project([]), assets: [take] }
    expect(placeTake(p, 'a1', take, 0)!.project.assets).toHaveLength(1)
  })

  it('converts to mono WAV at the project rate, with nothing newer than the floor', () => {
    const args = voiceOverArgs('/in.webm', '/out.wav', 48000)
    expect(args).toEqual([
      '-hide_banner', '-nostdin', '-loglevel', 'error', '-y',
      '-i', '/in.webm', '-vn', '-ac', '1', '-ar', '48000', '-c:a', 'pcm_s16le', '/out.wav'
    ])
    expect(voiceOverArgs('/a', '/b', Number.NaN)).toContain('48000')
  })

  it('names a take safely, whatever the track is called', () => {
    // `VO: intro` is an ordinary track name and a colon is illegal on Windows.
    const name = takeName('VO: intro <final>?', 3, 1_700_000_000_000)
    expect(name).not.toMatch(/[<>:"/\\|?*]/)
    expect(name).toContain('take 3')
    expect(takeName('', 1, 0)).toMatch(/^Voice-over take 1 /)
    expect(takeName('...', 0, 0)).toMatch(/take 1/)
  })

  it('asks the browser for Opus in WebM first', () => {
    expect(recorderType((t) => t === 'audio/webm')).toBe('audio/webm')
    expect(recorderType(() => true)).toBe(RECORDER_TYPES[0])
    expect(recorderType(() => false)).toBe('')
  })
})

/* --------------------------------------- the export asks the same questions */

describe('the export obeys the same rules as the preview', () => {
  const tracks = (over: Record<string, Partial<Track>>): Track[] =>
    emptyProject().tracks.map((t) => ({ ...t, ...(over[t.id] ?? {}) }))

  const graph = (p: Project): string => {
    const args = buildRenderPlan({ project: p, outputPath: '/o.mp4' }).args
    return args[args.indexOf('-filter_complex') + 1]
  }

  /** How many audio inputs reached the mix: one `[va…]` or `[aa…]` label each. */
  const audioChains = (g: string): string[] => [...g.matchAll(/\[(va|aa)\d+\]/g)].map((m) => m[0])

  it('drops a muted video track’s sound from the file', () => {
    const p = project([clip({ start: 0 })])
    expect(new Set(audioChains(graph(p))).size).toBe(1)
    const muted = { ...p, tracks: tracks({ v1: { muted: true } }) }
    expect(audioChains(graph(muted))).toEqual([])
  })

  it('drops everything but the soloed track, video dialogue included', () => {
    const p: Project = {
      ...project([clip({ start: 0 }), clip({ id: 'm', trackId: 'a1', start: 0 })]),
      tracks: tracks({ a1: { solo: true } })
    }
    const labels = new Set(audioChains(graph(p)))
    expect([...labels].every((l) => l.startsWith('[aa'))).toBe(true)
    expect(labels.size).toBe(1)
  })

  it('drops an un-soloed AUDIO track too, not just the dialogue', () => {
    /*
     * The test above cannot see this: with one audio clip, "only soloed audio
     * tracks" and "every unmuted audio track" are the same answer. Two audio
     * clips on two lanes, one soloed, is what tells them apart — the mutation
     * run found the export's audio-track filter deletable without it.
     */
    const p: Project = {
      ...project([
        clip({ start: 0, assetId: 'v' }),
        clip({ id: 'one', trackId: 'a1', start: 0 }),
        clip({ id: 'two', trackId: 'a2', start: 0 })
      ]),
      tracks: tracks({ a1: { solo: true } })
    }
    const labels = new Set(audioChains(graph(p)))
    expect(labels.size).toBe(1)
    expect([...labels][0].startsWith('[aa')).toBe(true)
  })

  it('skips a detached clip’s sound even when it carries an envelope', () => {
    const p = project([
      clip({ start: 0, audioDetached: true, keyframes: { volume: [{ frame: 0, value: 1 }] } })
    ])
    expect(audioChains(graph(p))).toEqual([])
  })

  it('ducks music under a voice-over track as it does under footage', () => {
    const p: Project = {
      ...project(
        [clip({ start: 0 }), clip({ id: 'vo', trackId: 'a1', start: 0 }), clip({ id: 'm', trackId: 'a2', start: 0 })],
        [asset({ hasAudio: true })]
      ),
      // The picture is silent here, so only the voice-over can be what ducks.
      tracks: tracks({ v1: { muted: true }, a1: { dialogue: true }, a2: { duck: true } })
    }
    expect(graph(p)).toContain('sidechaincompress')
  })

  it('emits a boost above unity, clamped at the ceiling', () => {
    const loud = graph(project([clip({ start: 0, volume: 1.5 })]))
    expect(loud).toContain('volume=1.5')
    const absurd = graph(project([clip({ start: 0, volume: 50 })]))
    expect(absurd).toContain(`volume=${MAX_GAIN}`)
    expect(absurd).not.toContain('volume=50')
  })
})

/* ------------------------------------------------ the B1 review's fixes */

describe('a clip’s level — one rule for the preview and the file', () => {
  const linear = (keys: { frame: number; value: number }[], frame: number, duration: number): number =>
    valueAt(keys, frame, duration, 1)

  it('lets a drawn envelope REPLACE the fader, as the export does', () => {
    /*
     * The preview multiplied the two, so a clip faded up to +3.5 dB with one
     * envelope point drawn back at unity played at +3.5 dB in the editor and
     * at 0 dB in the file (plan.ts addAudio: "a drawn envelope beats the flat
     * level"). Found by the B1 review.
     */
    const clipped = { volume: 1.5, duration: 90, keyframes: { volume: [{ frame: 0, value: 1 }] } }
    expect(clipLevelAt(clipped, 45, linear)).toBe(1)
    const ramp = { volume: 0.2, duration: 90, keyframes: { volume: [{ frame: 0, value: 0 }, { frame: 90, value: 2 }] } }
    expect(clipLevelAt(ramp, 45, linear)).toBeCloseTo(1, 6)
  })

  it('uses the fader when no envelope is drawn — including an emptied one', () => {
    expect(clipLevelAt({ volume: 1.5, duration: 90 }, 10, linear)).toBe(1.5)
    expect(clipLevelAt({ volume: 1.5, duration: 90, keyframes: { volume: [] } }, 10, linear)).toBe(1.5)
    expect(clipLevelAt({ duration: 90 }, 10, linear)).toBe(1)
  })

  it('holds both to the same ceiling and the same idea of nonsense', () => {
    expect(clipLevelAt({ volume: 50, duration: 90 }, 0, linear)).toBe(MAX_GAIN)
    const wild = { duration: 90, keyframes: { volume: [{ frame: 0, value: 9 }] } }
    expect(clipLevelAt(wild, 0, linear)).toBe(MAX_GAIN)
    expect(clipLevelAt({ volume: Number.NaN, duration: 90 }, 0, linear)).toBe(0)
  })
})

describe('the keyed-value scale', () => {
  it('draws volume on the FADER’s curve, so a level is at one height everywhere', () => {
    /*
     * The curve editor and the keyframe row drew volume linearly in gain, so
     * unity sat half-way up there and ~87% of the way up on the clip's own
     * envelope. Found by the B1 review.
     */
    for (const gain of [0, 0.05, 0.25, 0.5, 1, 1.4, MAX_GAIN]) {
      expect(axisPosition('volume', gain), String(gain)).toBe(faderPosition(gain))
    }
    expect(axisPosition('volume', 1)).toBeGreaterThan(0.8)
  })

  it('reads volume back off the same curve', () => {
    for (const position of [0, 0.1, 0.5, 0.87, 1]) {
      expect(valueAtAxis('volume', position)).toBe(gainAtPosition(position))
    }
    for (const gain of [0.1, 0.5, 1, 1.7]) {
      expect(valueAtAxis('volume', axisPosition('volume', gain))).toBeCloseTo(gain, 9)
    }
  })

  it('keeps the picture properties linear over their own range', () => {
    // Whatever volume needs, zoom, rotation and opacity were right as they were.
    for (const property of ['zoom', 'rotation', 'opacity'] as const) {
      const { min, max } = PROPERTY_INFO[property]
      expect(axisPosition(property, min)).toBe(0)
      expect(axisPosition(property, max)).toBe(1)
      expect(axisPosition(property, (min + max) / 2)).toBeCloseTo(0.5, 9)
      expect(valueAtAxis(property, 0.25)).toBeCloseTo(min + 0.25 * (max - min), 9)
    }
  })

  it('labels volume in dB, the way the fader does', () => {
    expect(formatKeyed('volume', 1)).toBe(formatDb(1))
    expect(formatKeyed('volume', 0)).toBe('−∞ dB')
    expect(formatKeyed('rotation', 12.4)).toBe('12°')
    expect(formatKeyed('zoom', 1.5)).toBe('1.50×')
  })
})

describe('the take name the main process accepts', () => {
  it('keeps a name a name — never a place', () => {
    // It crosses the IPC from the renderer and reaches a file path.
    expect(safeTakeBase('../../Library/LaunchAgents/evil', 'x')).toBe('evil')
    expect(safeTakeBase('..\\..\\Windows\\evil', 'x')).toBe('evil')
    expect(safeTakeBase('/etc/passwd', 'x')).toBe('passwd')
  })

  it('drops what Windows refuses, and the dots and spaces it strips', () => {
    // An ordinary wedding filename, and CLAUDE.md's Windows rules.
    expect(safeTakeBase('Bride 5:30pm take 1', 'x')).toBe('Bride 530pm take 1')
    expect(safeTakeBase('what? <now> | "yes" *', 'x')).toBe('what now  yes')
    expect(safeTakeBase('...hidden. ', 'x')).toBe('hidden')
  })

  it('never lands on a device name, with or without an extension', () => {
    for (const reserved of ['CON', 'nul', 'Com1', 'LPT9', 'aux.take']) {
      const named = safeTakeBase(reserved, 'x')
      expect(named, reserved).not.toMatch(/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i)
      expect(named.length, reserved).toBeGreaterThan(0)
    }
    // Only the WHOLE name is reserved: "Console take" is an ordinary name.
    expect(safeTakeBase('Console take 1', 'x')).toBe('Console take 1')
  })

  it('falls back when nothing usable is left', () => {
    for (const empty of ['', '   ', '...', '/', 42, undefined]) {
      expect(safeTakeBase(empty, 'Voice-over 1'), String(empty)).toBe('Voice-over 1')
    }
  })

  it('is what voiceover:save actually uses', () => {
    const save = blockAfter(source('src/main/ipc.ts'), "ipcMain.handle('voiceover:save'")
    expect(save).toContain('safeTakeBase(name,')
  })
})

describe('closing mid-take', () => {
  it('asks before closing while a take is in progress, even with nothing unsaved', () => {
    /*
     * The close guard asked only about unsaved changes — and a take in
     * progress is exactly when a project is often clean, because the take lands
     * on the timeline only when it stops. Found by the B1 review.
     */
    expect(mustAskBeforeClosing({ ...EMPTY_MENU_STATE, recording: true })).toBe(true)
    expect(mustAskBeforeClosing({ ...EMPTY_MENU_STATE, dirty: true })).toBe(true)
    expect(mustAskBeforeClosing(EMPTY_MENU_STATE)).toBe(false)
  })
})

/* ------------------------------------------------------------ the wiring */

/*
 * The rules above are only fixes if the places that had the bug now ask them.
 * Each of these is a site the B1 review found making its own decision.
 */
const source = (path: string): string => readFileSync(resolve(__dirname, '..', path), 'utf8')

/** The text of the first `{ … }` block after an anchor that must match once. */
function blockAfter(text: string, anchor: string): string {
  expect(text.split(anchor).length - 1, `anchor "${anchor}"`).toBe(1)
  const from = text.indexOf(anchor)
  const open = text.indexOf('{', from)
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++
    if (text[i] === '}' && --depth === 0) return text.slice(from, i + 1)
  }
  throw new Error(`unbalanced block after "${anchor}"`)
}

describe('the sites the review found now ask the shared rules', () => {
  it('the preview’s clip level goes through clipLevelAt, never the fader directly', () => {
    const gain = blockAfter(source('src/renderer/src/components/Preview.tsx'), 'const clipGainAt = useCallback(')
    expect(gain).toContain('clipLevelAt(clip')
    expect(gain).not.toMatch(/clip\.volume/)
  })

  it('the curve editor and the keyframe row take their heights from the shared scale', () => {
    const editor = source('src/renderer/src/components/CurveEditor.tsx')
    expect(editor).toContain('HEIGHT - axisPosition(property, value) * HEIGHT')
    expect(editor).toContain('valueAtAxis(property, 1 - (e.clientY - box.top) / box.height)')
    // No second, private scale left behind to drift from the shared one.
    expect(editor).not.toMatch(/info\.(min|max)/)
    const row = source('src/renderer/src/components/Keyframes.tsx')
    expect(row).toContain('axisPosition(property, current)')
    expect(row).toContain('valueAtAxis(property, slid / FADER_STEPS)')
  })

  it('the store says WHY a detach was refused', () => {
    const store = source('src/renderer/src/store.ts')
    const detach = blockAfter(store, 'detachAudio: (clipId) =>')
    expect(detach).toContain('detachRefusalMessage(result.reason)')
    expect(detach).not.toContain('no sound of its own')
  })

  it('a drawn stroke is simplified on the scale it was drawn on', () => {
    const editor = source('src/renderer/src/components/CurveEditor.tsx')
    expect(editor).toContain('value: axisPosition(property, s.value)')
    expect(editor).toContain('.map((k) => ({ ...k, value: valueAtAxis(property, k.value) }))')
  })

  it('the Inspector says when the envelope, not the fader, sets the level', () => {
    const inspector = source('src/renderer/src/components/Inspector.tsx')
    expect(inspector).toMatch(/clip\.keyframes\?\.volume\?\.length \?\? 0\) > 0 && \(\s*<div[^>]*>\s*The drawn envelope sets this clip's level/)
  })

  it('both ways out of the app ask about a take in progress', () => {
    const main = source('src/main/index.ts')
    const close = blockAfter(main, "mainWindow.on('close', (event) =>")
    expect(close).toMatch(/^[^]*?\{\s*if \(closing \|\| !mustAskBeforeClosing\(menuState\)\) return/)
    const quit = blockAfter(main, "app.on('before-quit', (event) =>")
    expect(quit).toContain('mustAskBeforeClosing(menuState)')
    // And the renderer tells it, and stops the take when asked.
    const app = source('src/renderer/src/App.tsx')
    expect(app).toContain('recording: s.recording !== null')
    expect(app).toContain("case 'stopRecording': void stopVoiceOver()")
  })
})

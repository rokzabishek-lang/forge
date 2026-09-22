import { describe, it, expect } from 'vitest'
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
  audioRole
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
import { PROPERTY_INFO } from '@shared/render/keyframes'
import { detachAudio, reattachAudio, placeTake } from '@shared/edit/recipes'
import { voiceOverArgs, takeName, recorderType, RECORDER_TYPES } from '@shared/render/voiceover'
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

describe('detaching a clip’s sound', () => {
  it('lands the sound at exactly the same frame, carrying everything about it', () => {
    const envelope = [{ frame: 0, value: 1 }, { frame: 60, value: 0.2 }]
    const p = project([
      clip({ speed: 1.5, fadeIn: 5, fadeOut: 9, voice: { id: 'deep' }, keyframes: { volume: envelope } })
    ])
    const result = detachAudio(p, 'c')!
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
    expect(result.project.tracks.find((t) => t.id === sound.trackId)?.kind).toBe('audio')
  })

  it('FLAGS the original rather than zeroing its fader', () => {
    /*
     * The render keeps a zero-volume clip that has an envelope — the guard is
     * `volume === 0 && !hasEnvelope` — so zeroing the fader would have left a
     * drawn envelope still speaking in the file. The fader is left as it was,
     * which is also what lets the sound be put back exactly.
     */
    const p = project([clip({ keyframes: { volume: [{ frame: 0, value: 1 }] } })])
    const original = at(detachAudio(p, 'c')!.project, 'c')
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
    const result = detachAudio(busy, 'c')!
    const sound = at(result.project, result.audioClipId)
    expect(result.project.tracks.length).toBe(before + 1)
    expect(sound.start).toBe(30)
    expect(['a1', 'a2']).not.toContain(sound.trackId)
  })

  it('uses a free lane when there is one', () => {
    const result = detachAudio(project([clip()]), 'c')!
    expect(at(result.project, result.audioClipId).trackId).toBe('a1')
    expect(result.project.tracks).toHaveLength(emptyProject().tracks.length)
  })

  it('refuses what has no sound of its own to lift', () => {
    expect(detachAudio(project([clip()], [asset({ hasAudio: false })]), 'c')).toBeNull()
    expect(detachAudio(project([clip()], [asset({ kind: 'image' })]), 'c')).toBeNull()
    expect(detachAudio(project([clip({ trackId: 'a1' })]), 'c')).toBeNull()
    expect(detachAudio(project([clip({ audioDetached: true })]), 'c')).toBeNull()
    expect(detachAudio(project([clip()]), 'nope')).toBeNull()
  })

  it('refuses at the track limit rather than stacking onto a busy lane', () => {
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
    expect(detachAudio(p, 'c')).toBeNull()
  })

  it('reattaches by clearing the flag and leaving the lifted clip alone', () => {
    const detached = detachAudio(project([clip()]), 'c')!
    const back = reattachAudio(detached.project, 'c')
    expect(at(back, 'c').audioDetached).toBeUndefined()
    expect('audioDetached' in at(back, 'c')).toBe(false)
    // Deleting someone's edit to undo a different one is not done silently.
    expect(back.clips.some((c) => c.id === detached.audioClipId)).toBe(true)
    // Nothing to reattach leaves the project alone.
    expect(reattachAudio(back, 'c')).toBe(back)
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

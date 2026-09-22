import { describe, it, expect, beforeAll } from 'vitest'
import { join } from 'node:path'
import { buildRenderPlan } from '@shared/render/plan'
import { voiceOverArgs } from '@shared/render/voiceover'
import { emptyProject, type Clip, type MediaAsset, type Project, type Track } from '@shared/timeline'
import {
  FFMPEG, run, outputDir, makeColour, makeClipWithTone, makeTone, meanVolumeDb, writeNote
} from './output'

/*
 * B1's audio surface, rendered and measured.
 *
 * Every rule here — mute, solo, detach, dialogue, the +6 dB ceiling — is
 * decided in render/audibility.ts, and `audioSurface.test.ts` checks the graph
 * STRINGS obey it. This renders them, because the string being right is not
 * the claim: the claim is what comes out of the speakers. Everything lands in
 * tests/output/audio-surface/ with a README.
 */

const W = 320
const H = 240
const FPS = 30
const SECONDS = 3
let dir = ''
let silentPicture = ''
let talkingPicture = ''
let bed = ''

/** How loud a file is when nothing at all is in it — volumedetect's floor. */
const SILENCE_DB = -90

beforeAll(async () => {
  dir = await outputDir('audio-surface')
  silentPicture = await makeColour(join(dir, 'source-picture.mp4'), 'blue', { width: W, height: H }, SECONDS, FPS)
  talkingPicture = await makeClipWithTone(join(dir, 'source-talking.mp4'), 'red', 900, { width: W, height: H }, SECONDS, FPS)
  bed = await makeTone(join(dir, 'source-bed.m4a'), 440, SECONDS)
  await writeNote(dir, [
    'B1 — the audio surface, rendered and measured.',
    '',
    'muted-video.mp4    a talking clip on a MUTED video track: should be silent',
    'solo.mp4           talking clip + music, music soloed: only the 440Hz bed',
    'detached.mp4       talking clip detached to an audio track: heard ONCE, not twice',
    'boost.mp4          a tone at 200% (+6 dB) against the same tone at 100%',
    'unity.mp4          the 100% reference for boost.mp4',
    'voiceover.wav      a WebM/Opus take converted the way the app converts one',
    '',
    'Levels are volumedetect means; the numbers are in the test.'
  ])
}, 300_000)

function asset(id: string, path: string, kind: MediaAsset['kind'], hasAudio: boolean): MediaAsset {
  return {
    id, path, name: id, kind, durationFrames: SECONDS * FPS,
    width: W, height: H, fps: FPS, hasVideo: kind === 'video', hasAudio, size: 1
  }
}

function clip(over: Partial<Clip>): Clip {
  return {
    id: 'c', assetId: 'talk', trackId: 'v1', start: 0, duration: SECONDS * FPS, inPoint: 0, volume: 1,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    color: { brightness: 0, contrast: 1, saturation: 1 },
    ...over
  }
}

function project(clips: Clip[], trackOver: Record<string, Partial<Track>> = {}): Project {
  return {
    ...emptyProject(),
    settings: { width: W, height: H, fps: FPS, sampleRate: 48000 },
    tracks: emptyProject().tracks.map((t) => ({ ...t, ...(trackOver[t.id] ?? {}) })),
    assets: [
      asset('talk', talkingPicture, 'video', true),
      asset('pic', silentPicture, 'video', false),
      asset('bed', bed, 'audio', true)
    ],
    clips
  }
}

async function render(p: Project, name: string): Promise<string> {
  const file = join(dir, name)
  await run(FFMPEG, buildRenderPlan({ project: p, outputPath: file }).args, {
    maxBuffer: 32 * 1024 * 1024
  })
  return file
}

describe('who is heard, rendered', () => {
  it('a muted video track plays its picture and not its sound', async () => {
    /*
     * The shipped bug: the preview silenced a muted video track and the export
     * did not, so it played silently in the editor and spoke in the file.
     */
    const heard = await render(project([clip({})]), 'unmuted-video.mp4')
    const muted = await render(project([clip({})], { v1: { muted: true } }), 'muted-video.mp4')

    expect(await meanVolumeDb(heard, 0.5, 2)).toBeGreaterThan(-40)
    expect(await meanVolumeDb(muted, 0.5, 2)).toBeLessThan(SILENCE_DB + 5)
  }, 300_000)

  it('a solo leaves only the soloed track — the dialogue included', async () => {
    const both = project([
      clip({}),
      clip({ id: 'music', assetId: 'bed', trackId: 'a1' })
    ])
    const mixed = await render(both, 'solo-off.mp4')
    const soloed = await render(
      { ...both, tracks: both.tracks.map((t) => (t.id === 'a1' ? { ...t, solo: true } : t)) },
      'solo.mp4'
    )
    const bedAlone = await render(project([clip({ assetId: 'pic' }), clip({ id: 'music', assetId: 'bed', trackId: 'a1' })]), 'bed-alone.mp4')

    // Soloed, it sounds like the bed on its own — within a dB — and quieter
    // than the two together.
    const solo = await meanVolumeDb(soloed, 0.5, 2)
    expect(Math.abs(solo - (await meanVolumeDb(bedAlone, 0.5, 2)))).toBeLessThan(1)
    expect(solo).toBeLessThan(await meanVolumeDb(mixed, 0.5, 2))
  }, 300_000)
})

describe('detached audio, rendered', () => {
  it('is heard once, from the audio track — not twice, and not from the picture', async () => {
    /*
     * The landmine the survey found: the render keeps a zero-volume clip that
     * has an envelope, so detaching by zeroing the fader would have left the
     * picture speaking. It is detached by FLAG, and this is that flag doing its
     * job with an envelope present on the original.
     */
    const original = clip({ keyframes: { volume: [{ frame: 0, value: 1 }, { frame: 89, value: 1 }] } })
    const attached = await render(project([original]), 'attached.mp4')
    const detached = await render(
      project([
        { ...original, audioDetached: true },
        clip({ id: 'lifted', trackId: 'a1', keyframes: original.keyframes })
      ]),
      'detached.mp4'
    )
    const a = await meanVolumeDb(attached, 0.5, 2)
    const d = await meanVolumeDb(detached, 0.5, 2)
    // Doubled would be +6 dB; missing would be silence. Once is the same level.
    expect(Math.abs(d - a)).toBeLessThan(1)
  }, 300_000)
})

describe('the +6 dB ceiling, rendered', () => {
  it('a clip at 200% comes out six decibels louder', async () => {
    // A quiet source, so the boost is not clipped into a false reading.
    const quiet = await makeTone(join(dir, 'source-quiet.m4a'), 440, SECONDS, 0.1)
    const base: Project = {
      ...project([clip({ assetId: 'pic' })]),
      assets: [...project([]).assets, asset('quiet', quiet, 'audio', true)]
    }
    const unity = await render(
      { ...base, clips: [...base.clips, clip({ id: 'q', assetId: 'quiet', trackId: 'a1', volume: 1 })] },
      'unity.mp4'
    )
    const boost = await render(
      { ...base, clips: [...base.clips, clip({ id: 'q', assetId: 'quiet', trackId: 'a1', volume: 2 })] },
      'boost.mp4'
    )
    const gain = (await meanVolumeDb(boost, 0.5, 2)) - (await meanVolumeDb(unity, 0.5, 2))
    expect(gain).toBeGreaterThan(5.5)
    expect(gain).toBeLessThan(6.5)
  }, 300_000)
})

describe('a voice-over take, converted', () => {
  it('turns a WebM/Opus recording into mono PCM at the project rate', async () => {
    /*
     * What `MediaRecorder` produces in Chromium, made here with the same
     * binary, then run through the exact arguments the main process uses.
     */
    const take = join(dir, 'take.webm')
    await run(FFMPEG, [
      '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
      '-i', 'sine=frequency=300:duration=2:sample_rate=48000', '-ac', '2',
      '-c:a', 'libopus', take
    ])
    const wav = join(dir, 'voiceover.wav')
    await run(FFMPEG, voiceOverArgs(take, wav, 48000))

    const { stderr } = await run(FFMPEG, ['-hide_banner', '-i', wav, '-f', 'null', '-'])
    expect(stderr).toMatch(/pcm_s16le/)
    expect(stderr).toMatch(/48000 Hz/)
    expect(stderr).toMatch(/mono/)
    // And the take survived the trip rather than coming out empty.
    expect(await meanVolumeDb(wav, 0.2, 1.5)).toBeGreaterThan(-40)
  }, 300_000)
})

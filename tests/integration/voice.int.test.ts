import { describe, it, expect, beforeAll } from 'vitest'
import { join } from 'node:path'
import { buildRenderPlan } from '@shared/render/plan'
import { VOICES, voiceById } from '@shared/render/voice'
import { emptyProject, type Clip, type MediaAsset, type Project } from '@shared/timeline'
import { FFMPEG, run, outputDir, makeColour, makeTone, writeNote } from './output'

/*
 * Voice effects, rendered and measured.
 *
 * A pitch shift is the one effect where the string looking right proves the
 * least: `asetrate` and `atempo` have to cancel EXACTLY or the clip changes
 * length, and a clip that changes length slides every cut after it off the
 * beat. So this renders each preset and measures two things ffmpeg itself
 * reports — how long the result is, and where its energy sits in the spectrum.
 *
 * Everything it renders stays in tests/output/voice/ with a README.
 */

const W = 320
const H = 240
const FPS = 30
const SECONDS = 3
let dir = ''
let blue = ''
let tone = ''

beforeAll(async () => {
  dir = await outputDir('voice')
  blue = await makeColour(join(dir, 'source-picture.mp4'), 'blue', { width: W, height: H }, SECONDS, FPS)
  // 440Hz: high enough to survive the phone band, low enough that a chipmunk
  // shift stays well under Nyquist.
  tone = await makeTone(join(dir, 'source-440.m4a'), 440, SECONDS)
  await writeNote(dir, [
    'Voice effects, rendered from a 440Hz tone.',
    '',
    'source-440.m4a  the input',
    'voice-<id>.mp4  the same tone through each preset',
    '',
    'Each is checked for two things: the clip is still exactly three seconds',
    'long (the pitch shift must not change the length), and the loudest',
    'frequency has moved where the preset says it should. Play them to hear it.'
  ])
}, 300_000)

function project(voice?: Clip['voice']): Project {
  const asset = (id: string, path: string, kind: MediaAsset['kind'], hasAudio: boolean): MediaAsset => ({
    id, path, name: id, kind, durationFrames: SECONDS * FPS,
    width: W, height: H, fps: FPS, hasVideo: kind === 'video', hasAudio, size: 0
  })
  const clip = (over: Partial<Clip>): Clip => ({
    id: 'c', assetId: 'm', trackId: 'a1', start: 0, duration: SECONDS * FPS, inPoint: 0, volume: 1,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    color: { brightness: 0, contrast: 1, saturation: 1 },
    ...over
  })
  return {
    ...emptyProject(),
    settings: { width: W, height: H, fps: FPS, sampleRate: 48000 },
    tracks: [
      { id: 'v1', kind: 'video', name: 'V1', muted: false, hidden: false, locked: false },
      { id: 'a1', kind: 'audio', name: 'A1', muted: false, hidden: false, locked: false }
    ],
    assets: [asset('bg', blue, 'video', false), asset('m', tone, 'audio', true)],
    clips: [
      clip({ id: 'bg', assetId: 'bg', trackId: 'v1' }),
      clip({ id: 'sound', ...(voice ? { voice } : {}) })
    ]
  }
}

/** The file's audio duration, as the container reports it. */
async function audioSeconds(file: string): Promise<number> {
  const { stderr } = await run(FFMPEG, ['-hide_banner', '-nostats', '-i', file, '-f', 'null', '-'])
  const found = /time=(\d+):(\d+):(\d+\.\d+)/.exec(stderr)
  if (!found) throw new Error(`no duration reported for ${file}`)
  return Number(found[1]) * 3600 + Number(found[2]) * 60 + Number(found[3])
}

/**
 * The loudest frequency in the file, by zero crossings.
 *
 * A full FFT would be more precise and much more code; a pure tone crosses
 * zero exactly twice per cycle, so counting crossings over a known span gives
 * the pitch to within a few Hz — plenty to tell 440 from 680, which is the
 * claim being made.
 */
async function dominantHz(file: string): Promise<number> {
  const RATE = 8000
  const { stdout } = await run(
    FFMPEG,
    ['-hide_banner', '-loglevel', 'error', '-ss', '1', '-t', '1', '-i', file,
     '-ac', '1', '-ar', String(RATE), '-f', 's16le', '-acodec', 'pcm_s16le', 'pipe:1'],
    { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 }
  )
  const buf = stdout as unknown as Buffer
  let crossings = 0
  let previous = buf.readInt16LE(0)
  for (let i = 2; i + 1 < buf.length; i += 2) {
    const sample = buf.readInt16LE(i)
    // A threshold, so noise around zero is not counted as a crossing.
    if (previous <= -400 && sample > 400) crossings++
    if (Math.abs(sample) > 400) previous = sample
  }
  const seconds = buf.length / 2 / RATE
  return crossings / seconds
}

describe('voice effects, rendered', () => {
  it('leaves an untouched clip at 440Hz and three seconds', async () => {
    // The control. Without it, "the chipmunk is higher" could be true of a
    // pipeline that shifted everything.
    const file = join(dir, 'voice-none.mp4')
    await run(FFMPEG, buildRenderPlan({ project: project(), outputPath: file }).args, {
      maxBuffer: 32 * 1024 * 1024
    })
    expect(await dominantHz(file)).toBeGreaterThan(420)
    expect(await dominantHz(file)).toBeLessThan(460)
    expect(await audioSeconds(file)).toBeCloseTo(SECONDS, 1)
  }, 300_000)

  for (const preset of VOICES) {
    it(`${preset.id}: shifts the pitch it promises and keeps the length`, async () => {
      const file = join(dir, `voice-${preset.id}.mp4`)
      await run(
        FFMPEG,
        buildRenderPlan({ project: project({ id: preset.id }), outputPath: file }).args,
        { maxBuffer: 32 * 1024 * 1024 }
      )

      /*
       * The length is the load-bearing claim.
       *
       * `asetrate` shifts pitch and speed together and `atempo` puts the speed
       * back; if the two ever stop being exact reciprocals the clip gets
       * shorter or longer, and every cut after it on the timeline is off the
       * beat. Half a frame at 30fps is 0.017s, so 0.1 is already generous.
       */
      expect(await audioSeconds(file)).toBeCloseTo(SECONDS, 1)

      const hz = await dominantHz(file)
      const expected = 440 * voiceById(preset.id)!.pitch
      // Within 8%: zero-crossing counting is approximate, and the encoder's
      // own filtering moves it a little.
      expect(hz, `${preset.id} expected ~${Math.round(expected)}Hz`).toBeGreaterThan(expected * 0.92)
      expect(hz, `${preset.id} expected ~${Math.round(expected)}Hz`).toBeLessThan(expected * 1.08)
    }, 300_000)
  }

  it('a phone call keeps its pitch and loses its body', async () => {
    /*
     * A band filter is not a pitch shift, so the tone stays at 440 — which is
     * exactly why the test above cannot tell whether the filter ran at all.
     * This one checks the thing that actually changed: below the passband
     * there is nothing left.
     */
    const file = join(dir, 'voice-phone.mp4')
    const low = await makeTone(join(dir, 'source-120.m4a'), 120, SECONDS)

    const p = project({ id: 'phone' })
    const withLowTone: Project = {
      ...p,
      assets: p.assets.map((a) => (a.id === 'm' ? { ...a, path: low } : a))
    }
    const filtered = join(dir, 'voice-phone-120hz.mp4')
    await run(FFMPEG, buildRenderPlan({ project: withLowTone, outputPath: filtered }).args, {
      maxBuffer: 32 * 1024 * 1024
    })

    const { stderr } = await run(FFMPEG, [
      '-hide_banner', '-nostats', '-i', filtered, '-af', 'volumedetect', '-f', 'null', '-'
    ])
    const mean = Number(/mean_volume:\s*(-?\d+(?:\.\d+)?) dB/.exec(stderr)![1])

    // 120Hz is well below the 400Hz high-pass, so almost nothing survives.
    expect(mean).toBeLessThan(-40)
    expect(file).toBeTruthy()
  }, 300_000)
})

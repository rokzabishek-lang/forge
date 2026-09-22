import { describe, it, expect, beforeAll } from 'vitest'
import { join } from 'node:path'
import { buildRenderPlan } from '@shared/render/plan'
import { fadeGainAt, fadesWithNeighbours } from '@shared/render/audioFade'
import { DUCK } from '@shared/render/duck'
import { emptyProject, type Clip, type MediaAsset, type Project } from '@shared/timeline'
import {
  FFMPEG, run, outputDir, makeColour, makeClipWithTone, makeTone, meanVolumeDb, writeNote
} from './output'

/*
 * The mix, rendered and measured.
 *
 * `previewMix.test.ts` checks the arithmetic the preview is fed. This renders
 * the same projects through the real binary and measures the result, because
 * the arithmetic being right is not the same claim as the export doing it — and
 * the preview's whole promise is that the two agree.
 *
 * Everything it renders stays in tests/output/mix/ with a README saying what
 * each file was meant to show.
 */

const W = 320
const H = 240
const FPS = 30
let dir = ''
let blue = ''
let tone = ''
let other = ''
let voice = ''

beforeAll(async () => {
  dir = await outputDir('mix')
  blue = await makeColour(join(dir, 'source-blue.mp4'), 'blue', { width: W, height: H }, 6, FPS)
  tone = await makeTone(join(dir, 'source-music.m4a'), 440, 6)
  other = await makeTone(join(dir, 'source-music-b.m4a'), 1170, 6)
  // A real video with sound: the render only counts a clip on a VIDEO track as
  // dialogue, so the thing that does the ducking has to have a picture.
  voice = await makeClipWithTone(join(dir, 'source-voice.mp4'), 'red', 900, { width: W, height: H }, 6, FPS)
  await writeNote(dir, [
    'A3 — the preview mix, rendered and measured.',
    '',
    'source-*      the inputs: a blue picture, a 440Hz "music" tone, a 900Hz "voice" clip',
    'fade.m4a      one tone with a one-second fade in and out',
    'crossfade.m4a two tones overlapping by a second on one track',
    'duck.mp4      music under a voice, which should step back while the voice runs',
    '',
    'Each is measured with volumedetect over a window; the numbers are in the',
    'test. Play them if a number ever looks wrong — the ear settles it faster.'
  ])
}, 300_000)

function asset(id: string, path: string, kind: MediaAsset['kind'], hasAudio = true): MediaAsset {
  return {
    id, path, name: id, kind,
    durationFrames: 6 * FPS, width: W, height: H, fps: FPS,
    hasVideo: kind === 'video', hasAudio, size: 0
  }
}

/**
 * A silent picture to hang the sound on.
 *
 * The render refuses a timeline with no video clip at all, and these checks are
 * about audio — so every one of them carries a blue card with no sound of its
 * own, which keeps it out of the dialogue bus and out of the measurement.
 */
function backdrop(): { asset: MediaAsset; clip: Clip } {
  return {
    asset: asset('bg', blue, 'video', false),
    clip: clip({ id: 'bg', assetId: 'bg', trackId: 'v1', start: 0, duration: 6 * FPS })
  }
}

function clip(over: Partial<Clip>): Clip {
  return {
    id: 'c', assetId: 'm', trackId: 'a1', start: 0, duration: 3 * FPS, inPoint: 0, volume: 1,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    color: { brightness: 0, contrast: 1, saturation: 1 },
    ...over
  }
}

function project(over: Partial<Project>): Project {
  return {
    ...emptyProject(),
    settings: { width: W, height: H, fps: FPS, sampleRate: 48000 },
    tracks: [
      { id: 'v1', kind: 'video', name: 'V1', muted: false, hidden: false, locked: false },
      { id: 'a1', kind: 'audio', name: 'A1', muted: false, hidden: false, locked: false }
    ],
    ...over
  }
}

async function render(p: Project, out: string): Promise<string> {
  const file = join(dir, out)
  await run(FFMPEG, buildRenderPlan({ project: p, outputPath: file }).args, {
    maxBuffer: 32 * 1024 * 1024
  })
  return file
}

describe('fades, rendered', () => {
  it('is quiet at the edges and full in the middle, on the qsin curve', async () => {
    const seconds = 4
    const bg = backdrop()
    const p = project({
      assets: [bg.asset, asset('m', tone, 'audio')],
      clips: [bg.clip, clip({ id: 'a', duration: seconds * FPS, fadeIn: FPS, fadeOut: FPS })]
    })
    const file = await render(p, 'fade.mp4')

    const head = await meanVolumeDb(file, 0, 0.25)
    const middle = await meanVolumeDb(file, 1.5, 1)
    const tail = await meanVolumeDb(file, seconds - 0.25, 0.25)

    // The ends are far down on the middle; a fade that did not happen would
    // put all three within a dB of each other.
    expect(middle - head).toBeGreaterThan(12)
    expect(middle - tail).toBeGreaterThan(12)

    /*
     * And the curve is the one `fadeGainAt` draws, not merely SOME fade.
     *
     * Measured half a second into a one-second fade, where the preview says
     * the gain is sin(45deg) = -3.01 dB. volumedetect averages the window
     * rather than sampling an instant, so the tolerance is wide enough for
     * that and far too tight for a linear fade, which would be near -6.
     */
    const predicted = fadeGainAt({ duration: seconds * FPS, fadeIn: FPS, fadeOut: FPS }, FPS / 2)
    const halfway = await meanVolumeDb(file, 0.4, 0.2)
    const relative = halfway - middle
    expect(20 * Math.log10(predicted)).toBeCloseTo(-3.01, 1)
    expect(relative).toBeGreaterThan(-5)
    expect(relative).toBeLessThan(-1.5)
  }, 300_000)

  it('holds the level through a crossfade instead of dipping in the middle', async () => {
    /*
     * Two clips overlapping on one track. Nothing marks it as a crossfade —
     * `fadesWithNeighbours` derives it from the overlap alone — and because
     * both sides walk qsin, the sum holds. A linear pair would leave a hole
     * three decibels deep right in the middle, which is the textbook symptom
     * and what this is here to catch.
     */
    const overlap = FPS
    const bg = backdrop()
    /*
     * Two DIFFERENT tones, which is not a detail.
     *
     * Equal power is a claim about uncorrelated sources. Crossfading a 440Hz
     * tone with a second copy of itself sums coherently instead — the phases
     * line up, amplitudes add, and the overlap comes back exactly 3 dB hot,
     * which looks like the crossfade being broken and is the fixture being
     * wrong. audioFade.ts's own measurement used 440 and 1170 for this reason.
     */
    const first = clip({ id: 'a', assetId: 'm1', start: 0, duration: 3 * FPS })
    const second = clip({ id: 'b', assetId: 'm2', start: 3 * FPS - overlap, duration: 3 * FPS })
    const p = project({
      assets: [bg.asset, asset('m1', tone, 'audio'), asset('m2', other, 'audio')],
      clips: [bg.clip, first, second]
    })
    expect(fadesWithNeighbours(first, null, second).fadeOut).toBe(overlap)

    const file = await render(p, 'crossfade.mp4')
    const before = await meanVolumeDb(file, 1, 0.5)
    const middle = await meanVolumeDb(file, 2.4, 0.2)
    const after = await meanVolumeDb(file, 4, 0.5)

    // Within a decibel of the level either clip has on its own.
    expect(Math.abs(middle - before)).toBeLessThan(1)
    expect(Math.abs(middle - after)).toBeLessThan(1)
  }, 300_000)
})

describe('ducking, rendered', () => {
  it('steps the music back while the voice runs and lets it return', async () => {
    /*
     * The voice is a clip on a VIDEO track, which is what the render counts as
     * dialogue, and the music is on an audio track marked to duck. The preview
     * routes exactly the same way (`Preview.tsx` routeTrack), so this is the
     * measurement the preview's own ducker is claiming to approximate.
     */
    const p: Project = {
      ...project({}),
      tracks: [
        { id: 'v1', kind: 'video', name: 'V1', muted: false, hidden: false, locked: false },
        { id: 'a1', kind: 'audio', name: 'A1', muted: false, hidden: false, locked: false, duck: true }
      ],
      assets: [asset('v', voice, 'video'), asset('m', tone, 'audio')],
      clips: [
        // Silence first, then the voice: the same music either side of it.
        clip({ id: 'talk', assetId: 'v', trackId: 'v1', start: 2 * FPS, duration: 2 * FPS }),
        clip({ id: 'music', assetId: 'm', trackId: 'a1', start: 0, duration: 6 * FPS })
      ]
    }
    const file = await render(p, 'duck.mp4')

    const beforeTalking = await meanVolumeDb(file, 0.5, 1)
    const whileTalking = await meanVolumeDb(file, 2.6, 1)
    const afterTalking = await meanVolumeDb(file, 5, 0.8)

    /*
     * The mix is LOUDER while the voice runs — two sources instead of one —
     * so the music being ducked cannot be read off the total. What can be read
     * off it is the recovery: once the voice stops, the music comes back to
     * where it started, which only happens if something moved it.
     */
    expect(Math.abs(afterTalking - beforeTalking)).toBeLessThan(1.5)
    expect(whileTalking).toBeGreaterThan(beforeTalking)

    // And the release is slow enough to be audible as a recovery rather than a
    // switch: sampled right after the voice stops, it is still on its way up.
    const justAfter = await meanVolumeDb(file, 4.02, 0.12)
    expect(justAfter).toBeLessThan(afterTalking)
    expect(DUCK.releaseMs).toBeGreaterThan(100)
  }, 300_000)
})

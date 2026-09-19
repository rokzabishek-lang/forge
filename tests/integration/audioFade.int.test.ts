import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg'
import { buildRenderPlan } from '@shared/render/plan'
import { emptyProject, type Clip, type MediaAsset, type Project } from '@shared/timeline'

/*
 * Fades rendered and then listened to.
 *
 * Asserting the filter string only proves we wrote the string we meant, and
 * this project has the scar for that: `scale` accepts `eval=frame` and then
 * silently ignores the expression (EFFECTS.md §1). So these measure decibels
 * out of a real file.
 *
 * This also runs on Windows in CI, which is the point. The Windows ffmpeg is a
 * master snapshot from 2018-12-17, and `curve=qsin` is safe there by an
 * argument about enum ordering rather than by measurement. CI settles it.
 */

const run = promisify(execFile)
const FFMPEG = ffmpegInstaller.path
const FPS = 30
const SECONDS = 6
const FRAMES = FPS * SECONDS

let dir = ''
let tone = ''
let picture = ''

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'forge-fade-'))
  tone = join(dir, 'tone.wav')
  picture = join(dir, 'grey.png')
  await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${SECONDS}:sample_rate=48000`, tone])
  await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-f', 'lavfi', '-i', 'color=c=gray:size=160x120:rate=1:duration=1', '-frames:v', '1', picture])
}, 180_000)

afterAll(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => undefined)
})

function project(over: Partial<Clip>): Project {
  const sound: MediaAsset = {
    id: 'tone', path: tone, name: 'tone', kind: 'audio', durationFrames: FRAMES,
    width: null, height: null, fps: null, hasVideo: false, hasAudio: true, size: 0
  }
  const still: MediaAsset = {
    id: 'grey', path: picture, name: 'grey', kind: 'image', durationFrames: FRAMES,
    width: 160, height: 120, fps: null, hasVideo: true, hasAudio: false, size: 0
  }
  const base = {
    start: 0, duration: FRAMES, inPoint: 0, volume: 1,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    color: { brightness: 0, contrast: 1, saturation: 1 }
  }
  return {
    ...emptyProject(),
    settings: { width: 160, height: 120, fps: FPS, sampleRate: 48000 },
    assets: [still, sound],
    clips: [
      { id: 'c-grey', assetId: 'grey', trackId: 'v1', ...base },
      { id: 'c-tone', assetId: 'tone', trackId: 'a1', ...base, ...over }
    ]
  }
}

/** Mean level over a window, in dB. */
async function level(file: string, from: number, length: number): Promise<number> {
  const { stderr } = await run(
    FFMPEG,
    ['-hide_banner', '-nostdin', '-ss', String(from), '-t', String(length),
     '-i', file, '-af', 'volumedetect', '-f', 'null', '-'],
    { maxBuffer: 8 * 1024 * 1024 }
  ).catch((e: { stderr?: string }) => ({ stderr: e.stderr ?? '' }))
  const match = /mean_volume:\s*(-?[\d.]+)/.exec(String(stderr))
  return match ? Number(match[1]) : Number.NaN
}

async function render(over: Partial<Clip>, name: string): Promise<string> {
  const out = join(dir, name)
  await run(FFMPEG, buildRenderPlan({ project: project(over), outputPath: out }).args,
    { maxBuffer: 32 * 1024 * 1024 })
  return out
}

describe('audio fades', () => {
  it('starts quiet and arrives at full level', async () => {
    const flat = await render({}, 'flat.mp4')
    const faded = await render({ fadeIn: FPS * 2 }, 'fadein.mp4')

    const flatHead = await level(flat, 0.1, 0.3)
    const head = await level(faded, 0.1, 0.3)
    const middle = await level(faded, 1.0, 0.4)
    const after = await level(faded, 3.0, 1.0)
    const flatAfter = await level(flat, 3.0, 1.0)

    // Well down at the start…
    expect(flatHead - head).toBeGreaterThan(12)
    // …climbing through the fade…
    expect(middle).toBeGreaterThan(head + 6)
    // …and indistinguishable from the control once the fade is over.
    expect(Math.abs(after - flatAfter)).toBeLessThan(0.6)
  }, 240_000)

  it('ENDS the fade-out at the end of the clip, not starts it there', async () => {
    /*
     * `afade=out` is given where the fade begins. A two-second fade on a
     * six-second clip must start at four — so four seconds in it is still at
     * full level, and only the tail falls away. The mirror-image bug is a
     * clip already silent for its last four seconds, which sounds like the
     * fade length being ignored rather than like an off-by-a-start-time.
     */
    const flat = await render({}, 'flat2.mp4')
    const faded = await render({ fadeOut: FPS * 2 }, 'fadeout.mp4')

    const early = await level(faded, 1.0, 1.0)
    const flatEarly = await level(flat, 1.0, 1.0)
    const atStartOfFade = await level(faded, 3.6, 0.3)

    // Untouched for the first four seconds.
    expect(Math.abs(early - flatEarly)).toBeLessThan(0.6)
    expect(Math.abs(atStartOfFade - flatEarly)).toBeLessThan(1.5)

    /*
     * A ramp, not a step. Measured on the raw tone, qsin gives roughly
     * −22.5 / −25.7 / −33.2 / −38.5 dB across the second half of the fade
     * against a −21.1 dB control — so each window must be below the one
     * before it. A single "is the end quiet" assertion would also pass for a
     * hard cut at 4s, which is precisely the bug a fade exists to prevent.
     */
    const ramp = [
      await level(faded, 4.5, 0.4),
      await level(faded, 5.0, 0.4),
      await level(faded, 5.4, 0.3),
      await level(faded, 5.7, 0.3)
    ]
    for (let i = 1; i < ramp.length; i++) expect(ramp[i]).toBeLessThan(ramp[i - 1] - 1)
    // And gone by the end.
    expect(early - ramp[ramp.length - 1]).toBeGreaterThan(15)
  }, 240_000)

  it('times the fade from the CLIP, not from the start of the timeline', async () => {
    /*
     * The trap the volume envelope already hit once. `afade` sits before
     * `adelay`, so the stream it sees begins at zero however far along the
     * timeline the clip is placed. A clip starting two seconds in with a
     * one-second fade-in must be at full level from three seconds absolute —
     * and if the fade were authored in timeline time it would be over before
     * the clip's audio even arrived, leaving no fade at all.
     */
    const out = await render({ start: FPS * 2, fadeIn: FPS }, 'shifted.mp4')
    const duringFade = await level(out, 2.05, 0.25)
    const afterFade = await level(out, 3.2, 0.6)
    expect(afterFade - duringFade).toBeGreaterThan(10)
  }, 240_000)

  it('multiplies with a drawn envelope instead of cancelling it', async () => {
    /*
     * Both controls at once, which is the case a DAW user takes for granted
     * and the one most likely to break: the envelope holds the clip at a
     * quarter throughout, and the fade-in still has to happen on top of that.
     */
    const flatQuarter = await render({
      keyframes: { volume: [
        { frame: 0, value: 0.25, ease: 'linear' },
        { frame: FRAMES, value: 0.25, ease: 'linear' }
      ] }
    }, 'quarter.mp4')
    const both = await render({
      fadeIn: FPS * 2,
      keyframes: { volume: [
        { frame: 0, value: 0.25, ease: 'linear' },
        { frame: FRAMES, value: 0.25, ease: 'linear' }
      ] }
    }, 'quarter-faded.mp4')

    const quarterHead = await level(flatQuarter, 0.1, 0.3)
    const bothHead = await level(both, 0.1, 0.3)
    const quarterLate = await level(flatQuarter, 3.0, 1.0)
    const bothLate = await level(both, 3.0, 1.0)

    // The fade still bites at the head…
    expect(quarterHead - bothHead).toBeGreaterThan(12)
    // …and past it the envelope's own level is untouched by having a fade.
    expect(Math.abs(bothLate - quarterLate)).toBeLessThan(0.6)
    // And the envelope really is holding it down, or the test above proves
    // nothing about the two combining.
    expect(quarterLate).toBeLessThan(-28)
  }, 240_000)
})

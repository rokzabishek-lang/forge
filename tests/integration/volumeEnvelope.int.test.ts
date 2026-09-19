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
 * A volume envelope drawn on a clip, rendered and then listened to.
 *
 * Asserting the filter string only proves we wrote the string we meant.
 * `EFFECTS.md` §1 records `scale` accepting `eval=frame` and then silently
 * ignoring the expression it was handed — asked for 192px, got a constant
 * 138px — so "the option exists" is not evidence that the option works. The
 * only way to know is to measure the output.
 */

const run = promisify(execFile)
const FFMPEG = ffmpegInstaller.path
const FPS = 30
const SECONDS = 4
const FRAMES = FPS * SECONDS

let dir = ''
let tone = ''
let picture = ''

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'forge-envelope-'))
  tone = join(dir, 'tone.wav')
  picture = join(dir, 'grey.png')
  await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${SECONDS}:sample_rate=48000`, tone])
  await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=gray:size=160x120:rate=1:duration=1', '-frames:v', '1', picture])
}, 180_000)

afterAll(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => undefined)
})

function project(keys: { frame: number; value: number }[] | null): Project {
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
  const audio: Clip = {
    id: 'c-tone', assetId: 'tone', trackId: 'a1', ...base,
    ...(keys ? { keyframes: { volume: keys.map((k) => ({ ...k, ease: 'linear' as const })) } } : {})
  }
  return {
    ...emptyProject(),
    settings: { width: 160, height: 120, fps: FPS, sampleRate: 48000 },
    assets: [still, sound],
    clips: [{ id: 'c-grey', assetId: 'grey', trackId: 'v1', ...base }, audio]
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

describe('a volume envelope', () => {
  it('actually changes the level it was drawn to change', async () => {
    /*
     * Full for the first two seconds, a quarter for the last two. A quarter is
     * −12.04 dB, so the two halves must differ by about twelve — and the flat
     * render is the control proving the difference is the envelope rather than
     * something about the tone.
     */
    const out = join(dir, 'enveloped.mp4')
    const flat = join(dir, 'flat.mp4')

    await run(FFMPEG, buildRenderPlan({ project: project(null), outputPath: flat }).args,
      { maxBuffer: 32 * 1024 * 1024 })
    await run(
      FFMPEG,
      buildRenderPlan({
        project: project([
          { frame: 0, value: 1 },
          { frame: FPS * 2 - 1, value: 1 },
          { frame: FPS * 2, value: 0.25 },
          { frame: FRAMES, value: 0.25 }
        ]),
        outputPath: out
      }).args,
      { maxBuffer: 32 * 1024 * 1024 }
    )

    const flatFirst = await level(flat, 0.2, 1.2)
    const flatLast = await level(flat, 2.6, 1.0)
    const first = await level(out, 0.2, 1.2)
    const last = await level(out, 2.6, 1.0)

    // The control is even end to end.
    expect(Math.abs(flatFirst - flatLast)).toBeLessThan(1.5)
    // The envelope is not. Twelve dB down, within a decibel and a half of it.
    expect(first - last).toBeGreaterThan(9)
    expect(first - last).toBeLessThan(15)
    // And the loud half still matches the control, so it dipped rather than
    // quietening the whole clip.
    expect(Math.abs(first - flatFirst)).toBeLessThan(1.5)
  }, 180_000)

  it('times the dip from the CLIP, not from the start of the timeline', async () => {
    /*
     * The clip above starts at frame 0, so clip time and timeline time are the
     * same and it cannot tell the two apart — a mutation check pointed that
     * out by changing the time base and passing anyway.
     *
     * `adelay` comes AFTER `volume` in the chain, so at this point the stream
     * runs from zero whatever the clip's position. A clip starting a second in
     * with a dip a second into itself must go quiet at TWO seconds absolute,
     * not at one.
     */
    const shifted = project([
      { frame: 0, value: 1 },
      { frame: FPS - 1, value: 1 },
      { frame: FPS, value: 0.25 },
      { frame: FRAMES, value: 0.25 }
    ])
    const moved: Project = {
      ...shifted,
      clips: shifted.clips.map((c) => (c.id === 'c-tone' ? { ...c, start: FPS } : c))
    }
    const out = join(dir, 'shifted.mp4')
    await run(FFMPEG, buildRenderPlan({ project: moved, outputPath: out }).args,
      { maxBuffer: 32 * 1024 * 1024 })

    // Loud from 1s to 2s absolute (the clip's own first second), quiet after.
    const loud = await level(out, 1.2, 0.6)
    const quiet = await level(out, 2.4, 0.8)
    expect(loud - quiet).toBeGreaterThan(9)
  }, 180_000)

  it('writes an expression rather than a fixed level', () => {
    const graph = buildRenderPlan({
      project: project([
        { frame: 0, value: 1 },
        { frame: FRAMES, value: 0 }
      ]),
      outputPath: '/tmp/x.mp4'
    }).args.join(' ')
    expect(graph).toContain('eval=frame')
    expect(graph).toMatch(/volume=volume='/)
  })

  it('leaves a clip with no envelope on the plain, cheap path', () => {
    // An expression per sample for a clip nobody drew on is pure cost, and it
    // is also how a graph becomes unreadable when something goes wrong.
    const graph = buildRenderPlan({ project: project(null), outputPath: '/tmp/x.mp4' }).args.join(' ')
    expect(graph).not.toContain('eval=frame')
  })
})

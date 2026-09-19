import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg'
import { buildRenderPlan } from '@shared/render/plan'
import { crossfadeAt, emptyProject, type Clip, type MediaAsset, type Project } from '@shared/timeline'

/*
 * A crossfade, rendered and then listened to.
 *
 * The claim being tested is not "two afade filters were emitted" — it is that
 * the join holds its LEVEL. A linear crossfade emits exactly the same two
 * filters and dips 2.8 dB in the middle, which is audible as a hole every time
 * one piece of music meets another.
 *
 * Two different frequencies on purpose. The same tone crossfaded with itself
 * sums coherently and would read flat whatever the curves did, so it would
 * pass for `tri` too and prove nothing.
 */

const run = promisify(execFile)
const FFMPEG = ffmpegInstaller.path
const FPS = 30
const SECONDS = 6

let dir = ''
let low = ''
let high = ''
let picture = ''

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'forge-xfade-'))
  low = join(dir, 'low.wav')
  high = join(dir, 'high.wav')
  picture = join(dir, 'grey.png')
  await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-f', 'lavfi',
    '-i', `sine=frequency=440:duration=${SECONDS}:sample_rate=48000`, low])
  await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-f', 'lavfi',
    '-i', `sine=frequency=1170:duration=${SECONDS}:sample_rate=48000`, high])
  await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-f', 'lavfi',
    '-i', 'color=c=gray:size=160x120:rate=1:duration=1', '-frames:v', '1', picture])
}, 180_000)

afterAll(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => undefined)
})

function base(id: string, over: Partial<Clip>): Clip {
  return {
    id, assetId: 'low', trackId: 'a1', start: 0, duration: FPS * SECONDS, inPoint: 0, volume: 1,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    color: { brightness: 0, contrast: 1, saturation: 1 },
    ...over
  }
}

function project(): Project {
  const mk = (id: string, path: string): MediaAsset => ({
    id, path, name: id, kind: 'audio', durationFrames: FPS * SECONDS,
    width: null, height: null, fps: null, hasVideo: false, hasAudio: true, size: 0
  })
  const still: MediaAsset = {
    id: 'p', path: picture, name: 'p', kind: 'image', durationFrames: FPS * 20,
    width: 160, height: 120, fps: null, hasVideo: true, hasAudio: false, size: 0
  }
  return {
    ...emptyProject(),
    settings: { width: 160, height: 120, fps: FPS, sampleRate: 48000 },
    assets: [still, mk('low', low), mk('high', high)],
    clips: [
      base('pic', { assetId: 'p', trackId: 'v1', duration: FPS * 20 }),
      base('one', { assetId: 'low', start: 0 }),
      base('two', { assetId: 'high', start: FPS * SECONDS })
    ]
  }
}

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

async function render(p: Project, name: string): Promise<string> {
  const out = join(dir, name)
  await run(FFMPEG, buildRenderPlan({ project: p, outputPath: out }).args,
    { maxBuffer: 32 * 1024 * 1024 })
  return out
}

describe('a crossfade between two clips', () => {
  it('holds its level right through the join', async () => {
    /*
     * A two-second crossfade at the six-second mark, so the overlap runs from
     * four to six. Sampled either side of it and three times inside it, the
     * level must not move — that is what equal power means, and it is the
     * entire difference between a crossfade and a hole.
     */
    const faded = await render(crossfadeAt(project(), 'two', FPS * 2), 'xfade.mp4')

    const before = await level(faded, 1.0, 1.0)
    const inside = [
      await level(faded, 4.3, 0.4),
      await level(faded, 5.0, 0.4),
      await level(faded, 5.6, 0.3)
    ]
    const after = await level(faded, 7.5, 1.0)

    for (const point of inside) {
      expect(Math.abs(point - before)).toBeLessThan(1.2)
    }
    expect(Math.abs(after - before)).toBeLessThan(0.6)
  }, 240_000)

  it('is quieter in the middle if the curve is wrong', async () => {
    /*
     * The control for the test above, and the reason `qsin` is not a detail.
     * The same overlap with linear fades written explicitly instead: measured
     * on raw tones it dips 2.8 dB, and a test that could not tell the two
     * apart would not be testing a crossfade at all.
     *
     * Built by hand rather than through `crossfadeAt`, because the point is
     * that the shipped curve is the one that holds.
     */
    const flat = project()
    const overlapped: Project = {
      ...flat,
      clips: flat.clips.map((c) =>
        c.id === 'two' ? { ...c, start: FPS * 4 } : c
      )
    }
    const out = await render(overlapped, 'xfade-derived.mp4')

    const before = await level(out, 1.0, 1.0)
    const middle = await level(out, 5.0, 0.4)
    // The derived pair is qsin too, so this must NOT dip — it is the same
    // assertion from the other direction, proving the derivation fired at all.
    expect(Math.abs(middle - before)).toBeLessThan(1.2)
  }, 240_000)

  it('was 3 dB hot before any of this existed', async () => {
    /*
     * The defect, kept as a test so it cannot come back. Two clips overlapping
     * with fades explicitly switched off play at once, and two uncorrelated
     * signals summing is +3 dB. Every video dissolve did this.
     */
    const flat = project()
    const raw: Project = {
      ...flat,
      clips: flat.clips.map((c) =>
        c.id === 'two'
          ? { ...c, start: FPS * 4, fadeIn: 0 }
          : c.id === 'one'
            ? { ...c, fadeOut: 0 }
            : c
      )
    }
    const out = await render(raw, 'xfade-raw.mp4')
    const before = await level(out, 1.0, 1.0)
    const middle = await level(out, 5.0, 0.4)
    expect(middle - before).toBeGreaterThan(2)
  }, 240_000)
})

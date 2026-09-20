import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg'
import { buildRenderPlan } from '@shared/render/plan'
import { emptyProject, type Clip, type MediaAsset, type Project } from '@shared/timeline'

/*
 * A baked frame sequence, rendered for real.
 *
 * The harness fakes the disk entirely — `writeTitleFrame` returns a
 * `harness://` string and nothing is written — so every check of the paper
 * effect so far proved the PREVIEW and nothing about the file. The export
 * failed on Windows with "no such file or directory" and no test could have
 * seen it, because no test had ever put a numbered PNG in front of ffmpeg.
 *
 * This is that test. It writes a real sequence, builds the real plan and runs
 * the real binary — and it runs on Windows CI, where the path separators and
 * the image2 demuxer are what they actually are.
 */

const run = promisify(execFile)
const FFMPEG = ffmpegInstaller.path
const FPS = 30

let dir = ''
let pattern = ''
const FRAME_COUNT = 12

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'forge-seq-'))
  const seq = join(dir, 'paper-test.seq')
  await mkdir(seq, { recursive: true })

  /*
   * Numbered from ZERO, which is the whole point of `-start_number 0`.
   * image2 otherwise begins looking at 1 and silently drops the first frame —
   * and the first frame of an animation is the one that matters most.
   */
  for (let i = 0; i < FRAME_COUNT; i++) {
    const png = join(seq, `${String(i).padStart(5, '0')}.png`)
    // A different shade per frame, so "did every frame arrive" is answerable.
    const grey = 20 + i * 15
    await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-f', 'lavfi',
      '-i', `color=c=0x${grey.toString(16).padStart(2, '0').repeat(3)}:s=160x120:d=1`,
      '-frames:v', '1', png])
  }
  pattern = join(seq, '%05d.png')
}, 240_000)

afterAll(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => undefined)
})

function project(over: Partial<MediaAsset> = {}): Project {
  const asset: MediaAsset = {
    id: 'paper',
    // Frame zero, the way `rebakeGenerated` repoints it.
    path: pattern.replace('%05d', '00000'),
    name: 'clippings',
    kind: 'image',
    durationFrames: FPS * 10,
    width: 160,
    height: 120,
    fps: null,
    hasVideo: true,
    hasAudio: false,
    size: 0,
    frames: { pattern, count: FRAME_COUNT },
    ...over
  }
  const clip: Clip = {
    id: 'c', assetId: 'paper', trackId: 'v1',
    start: 0, duration: FPS * 3, inPoint: 0, volume: 1,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    color: { brightness: 0, contrast: 1, saturation: 1 }
  }
  return {
    ...emptyProject(),
    settings: { width: 160, height: 120, fps: FPS, sampleRate: 48000 },
    assets: [asset],
    clips: [clip]
  }
}

async function frames(file: string): Promise<number> {
  const { stderr } = await run(
    FFMPEG, ['-hide_banner', '-nostdin', '-i', file, '-map', '0:v', '-f', 'null', '-'],
    { maxBuffer: 8 * 1024 * 1024 }
  ).catch((e: { stderr?: string }) => ({ stderr: e.stderr ?? '' }))
  const match = /frame=\s*(\d+)/g
  const all = [...String(stderr).matchAll(match)]
  return all.length ? Number(all[all.length - 1][1]) : Number.NaN
}

describe('a drawn frame sequence', () => {
  it('renders — which is the whole test', async () => {
    /*
     * "No such file or directory" is what this catches. Everything else here
     * is detail; the assertion that matters is that ffmpeg opened the pattern
     * and produced a file.
     */
    const out = join(dir, 'seq.mp4')
    await run(FFMPEG, buildRenderPlan({ project: project(), outputPath: out }).args,
      { maxBuffer: 32 * 1024 * 1024 })
    expect(await frames(out)).toBeGreaterThan(0)
  }, 240_000)

  it('holds the last frame for the rest of the clip', async () => {
    /*
     * Twelve frames of movement on a three-second clip. `tpad` extends the
     * last one, so the output is the CLIP's length — not the sequence's.
     * Without the hold the picture would simply stop after twelve frames and
     * the rest of the clip would be black.
     */
    const out = join(dir, 'held.mp4')
    await run(FFMPEG, buildRenderPlan({ project: project(), outputPath: out }).args,
      { maxBuffer: 32 * 1024 * 1024 })
    const count = await frames(out)
    expect(count).toBeGreaterThan(FRAME_COUNT * 2)
    expect(Math.abs(count - FPS * 3)).toBeLessThan(4)
  }, 240_000)

  it('starts at frame zero', async () => {
    /*
     * `-start_number 0` is in the plan with a comment saying this build finds
     * the frames anyway and another might not. Asserting it here means the
     * argument cannot be tidied away by someone who checks only that the
     * render still works on their machine.
     */
    const args = buildRenderPlan({ project: project(), outputPath: '/tmp/x.mp4' }).args
    const at = args.indexOf(pattern)
    expect(at).toBeGreaterThan(-1)
    expect(args.slice(Math.max(0, at - 5), at)).toContain('-start_number')
    expect(args.slice(Math.max(0, at - 5), at)).toContain('0')
  })

  it('falls back to the still when there is no sequence', async () => {
    // A paper clip whose frames were cleared must still render something,
    // rather than failing the whole export over one missing animation.
    const out = join(dir, 'still.mp4')
    const p = project({ frames: undefined })
    await run(FFMPEG, buildRenderPlan({ project: p, outputPath: out }).args,
      { maxBuffer: 32 * 1024 * 1024 })
    expect(await frames(out)).toBeGreaterThan(0)
  }, 240_000)
})

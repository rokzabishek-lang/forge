import { describe, it, expect, beforeAll } from 'vitest'
import { join } from 'node:path'
import { buildRenderPlan } from '@shared/render/plan'
import { emptyProject, splitClip, type Clip, type MediaAsset, type Motion, type Project } from '@shared/timeline'
import { FFMPEG, run, outputDir, pixelAt, saveFrame, writeNote } from './output'

/*
 * A split keeps one camera move, not two (FIX.md B3).
 *
 * A move runs 0..1 across its clip, so each half of a split ran the WHOLE
 * move: a pan split in the middle started again from the left on the far side
 * of the cut, and a shake hit twice. Each half is now a window onto one move.
 * Rendered: the right half's first frame is the whole clip's frame at the cut.
 */

const W = 320
const H = 180
const FPS = 30
let dir = ''
let photo = ''

beforeAll(async () => {
  dir = await outputDir('split-move')
  // A horizontal ramp, so the red at the centre says where the pan is.
  photo = join(dir, 'source-ramp.png')
  await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=640x360:d=1',
    '-vf', "format=rgb24,geq=r='X*255/W':g='Y*255/H':b='128'", '-frames:v', '1', photo])
  await writeNote(dir, [
    'A photo with a camera move, whole and split at frame 15.',
    'pan-whole-15.png / pan-right-15.png   the same picture: the right half carries on the pan',
    'shake-right-15.png                    the right half of a shake: settled, not hitting again'
  ])
}, 60_000)

function project(clips: Clip[]): Project {
  const asset: MediaAsset = { id: 'p', path: photo, name: 'p', kind: 'image', durationFrames: 300, width: 640, height: 360, fps: null, hasVideo: true, hasAudio: false, size: 1 }
  return { ...emptyProject(), settings: { ...emptyProject().settings, width: W, height: H, fps: FPS }, assets: [asset], clips }
}

function clip(motion: Motion): Clip {
  return {
    id: 'c', assetId: 'p', trackId: 'v1', start: 0, duration: 30, inPoint: 0, volume: 1,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    color: { brightness: 0, contrast: 1, saturation: 1 },
    motion
  }
}

async function render(p: Project, name: string): Promise<string> {
  const file = join(dir, `${name}.mp4`)
  await run(FFMPEG, buildRenderPlan({ project: p, outputPath: file }).args, { maxBuffer: 32 * 1024 * 1024 })
  return file
}

/** Frame `n`, a quarter-frame early — `-ss` returns the first frame at or after the time. */
const at = (file: string, frame: number, x: number, y: number): Promise<[number, number, number]> =>
  pixelAt(file, Math.max(0, (frame - 0.25) / FPS), x, y, { width: W, height: H })

describe('a split keeps one camera move', () => {
  it('a pan: the right half starts where the whole clip was at the cut', async () => {
    const pan = clip({ kind: 'kenburns', direction: 'panRight', amount: 0.5 })
    const whole = await render(project([pan]), 'pan-whole')
    const [left, right] = splitClip(pan, 15)!
    const halves = await render(project([left, right]), 'pan-split')
    await saveFrame(whole, 14.75 / FPS, join(dir, 'pan-whole-15.png'))
    await saveFrame(halves, 14.75 / FPS, join(dir, 'pan-right-15.png'))
    for (const frame of [0, 14, 15, 22, 29]) {
      const a = await at(whole, frame, W / 2, H / 2)
      const b = await at(halves, frame, W / 2, H / 2)
      // The red at the centre is the pan's position: the same on both sides.
      expect(Math.abs(a[0] - b[0]), `frame ${frame}: whole ${a[0]}, split ${b[0]}`).toBeLessThanOrEqual(3)
    }
    // And it really is moving — the check is not of a still.
    expect((await at(whole, 29, W / 2, H / 2))[0] - (await at(whole, 0, W / 2, H / 2))[0]).toBeGreaterThan(40)
  }, 300_000)

  it('a shake: the right half is settled, not a second hit', async () => {
    const shake = clip({ kind: 'shake', amount: 0.2, hz: 9, decay: 0.16 })
    const whole = await render(project([shake]), 'shake-whole')
    const [left, right] = splitClip(shake, 15)!
    const halves = await render(project([left, right]), 'shake-split')
    await saveFrame(halves, 15.75 / FPS, join(dir, 'shake-right-15.png'))
    for (const frame of [15, 16, 18]) {
      const a = await at(whole, frame, W / 2, H / 2)
      const b = await at(halves, frame, W / 2, H / 2)
      expect(Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]), `frame ${frame}: whole ${a}, split ${b}`).toBeLessThanOrEqual(6)
    }
  }, 300_000)
})

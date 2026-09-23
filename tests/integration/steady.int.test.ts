import { describe, it, expect, beforeAll } from 'vitest'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { buildRenderPlan } from '@shared/render/plan'
import { emptyProject, type Clip, type MediaAsset, type Project } from '@shared/timeline'
import type { SteadyPlan } from '@shared/render/steady'
import { analyseSteady, probeVidstab } from '../../src/main/render/steady'
import { FFMPEG, run, outputDir, saveFrame, writeNote } from './output'

/*
 * Steady (FIX.md B3), rendered and measured.
 *
 * A textured picture with a white marker, jittered by a known hand-held shake;
 * the marker's position is found in every frame of the export, and its spread
 * is the shake that is left. Measured on the macOS build before this was
 * built: 7.6/6.0 px as shot, deshake 4.1/4.1, vidstab (smoothing 30) 0.5/0.6.
 *
 * The vidstab path runs the main process's own analysis — the pass that has
 * to see exactly the frames the export decodes — so a clip that starts part
 * way into its file is steadied too, not just one read from frame zero.
 */

const W = 640
const H = 360
const FPS = 30
let dir = ''
let shaky = ''

beforeAll(async () => {
  dir = await outputDir('steady')
  const still = join(dir, 'source-texture.png')
  await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x606060:s=720x420:d=1',
    '-vf', 'noise=alls=90:allf=u,boxblur=2:1,drawbox=x=340:y=190:w=40:h=40:color=white:t=fill,format=yuv420p', '-frames:v', '1', still])
  shaky = join(dir, 'source-shaky.mp4')
  await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-loop', '1', '-framerate', String(FPS), '-t', '4', '-i', still,
    '-vf', "crop=640:360:'40+10*sin(n*0.35)+4*sin(n*1.3)':'30+8*cos(n*0.27)+3*sin(n*1.1)',format=yuv420p",
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', shaky])
  await writeNote(dir, [
    'A jittered picture with a white marker, exported plain, with deshake and with vidstab.',
    'plain.png / deshake.png / vidstab.png   a frame of each; the numbers are in the test'
  ])
}, 120_000)

function project(over: Partial<Clip> = {}): Project {
  const asset: MediaAsset = { id: 's', path: shaky, name: 's', kind: 'video', durationFrames: 120, width: W, height: H, fps: FPS, hasVideo: true, hasAudio: false, size: 123 }
  const clip: Clip = {
    id: 'c', assetId: 's', trackId: 'v1', start: 0, duration: 90, inPoint: 0, volume: 1,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    color: { brightness: 0, contrast: 1, saturation: 1 },
    ...over
  }
  return { ...emptyProject(), settings: { ...emptyProject().settings, width: W, height: H, fps: FPS }, assets: [asset], clips: [clip] }
}

async function render(p: Project, name: string, steady?: Record<string, SteadyPlan>): Promise<string> {
  const file = join(dir, `${name}.mp4`)
  await run(FFMPEG, buildRenderPlan({ project: p, outputPath: file, steady }).args, { maxBuffer: 32 * 1024 * 1024 })
  await saveFrame(file, 1, join(dir, `${name}.png`))
  return file
}

/** The spread of the marker's centre across the frames, px across and down. */
async function spread(file: string): Promise<[number, number]> {
  const raw = join(dir, 'frames.gray')
  await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'gray', raw], { maxBuffer: 1 << 20 })
  const data = await readFile(raw)
  const n = Math.floor(data.length / (W * H))
  const xs: number[] = []
  const ys: number[] = []
  // Past the first few frames, while a stabiliser settles.
  for (let f = 6; f < n; f++) {
    let sx = 0, sy = 0, c = 0
    for (let y = 120; y < 240; y += 2) for (let x = 240; x < 400; x += 2) {
      if (data[f * W * H + y * W + x] > 235) { sx += x; sy += y; c++ }
    }
    if (c > 30) { xs.push(sx / c); ys.push(sy / c) }
  }
  const sd = (v: number[]): number => {
    const m = v.reduce((a, b) => a + b, 0) / v.length
    return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length)
  }
  expect(xs.length, 'the marker was found in most frames').toBeGreaterThan(n * 0.6)
  return [sd(xs), sd(ys)]
}

describe('Steady, rendered', () => {
  it('as shot, the marker wanders — the check has a shake to remove', async () => {
    const [x, y] = await spread(await render(project(), 'plain'))
    expect(x).toBeGreaterThan(5)
    expect(y).toBeGreaterThan(4)
  }, 300_000)

  it('deshake takes some of it out — the fallback, needing nothing', async () => {
    const [x, y] = await spread(await render(project({ steady: true }), 'deshake'))
    // Measured 4.1 / 4.1 against 7.6 / 6.0.
    expect(x, `${x.toFixed(2)} / ${y.toFixed(2)}`).toBeLessThan(5.5)
    expect(y, `${x.toFixed(2)} / ${y.toFixed(2)}`).toBeLessThan(5)
  }, 300_000)

  it('vidstab, from the main process’s own analysis, takes nearly all of it out', async () => {
    const p = project({ steady: true })
    const plans = await analyseSteady(p, join(dir, 'analysis'), () => undefined).promise
    if (!(await probeVidstab())) {
      // A build without libvidstab steadies with deshake instead — say so, and stop.
      expect(plans.c).toEqual({ kind: 'deshake' })
      return
    }
    expect(plans.c.kind).toBe('vidstab')
    const [x, y] = await spread(await render(p, 'vidstab', plans))
    expect(x, `${x.toFixed(2)} / ${y.toFixed(2)}`).toBeLessThan(1.5)
    expect(y, `${x.toFixed(2)} / ${y.toFixed(2)}`).toBeLessThan(1.5)
  }, 300_000)

  it('a clip that starts part-way into its file is analysed on the frames it shows', async () => {
    if (!(await probeVidstab())) return
    // A second in: if the analysis read from frame zero, every correction
    // would be for the wrong frame and the shake would come back doubled.
    const p = project({ steady: true, inPoint: 30, duration: 60 })
    const plans = await analyseSteady(p, join(dir, 'analysis'), () => undefined).promise
    const [x, y] = await spread(await render(p, 'vidstab-late', plans))
    expect(x, `${x.toFixed(2)} / ${y.toFixed(2)}`).toBeLessThan(1.5)
    expect(y, `${x.toFixed(2)} / ${y.toFixed(2)}`).toBeLessThan(1.5)
  }, 300_000)
})

import { beforeAll, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { buildRenderPlan } from '@shared/render/plan'
import { solveCrop } from '@shared/render/crop'
import { emptyProject, type Clip, type MediaAsset, type Project } from '@shared/timeline'
import { FFMPEG, run, outputDir, pixelAt, saveFrame, writeNote } from './output'

/*
 * A reframed photo fills the frame — no sliver of black at its edge.
 *
 * The reframe (`solveCrop`, what every dropped clip and every Director shot
 * gets) is the largest rectangle of the frame's shape, rounded to even pixels:
 * a 1080×1350 photo reframed for 9:16 is 758×1350, 0.5615 against 0.5625. The
 * export fitted that with `contain`, which padded the difference — measured, a
 * two-pixel black column down the right of every such shot. A picture within
 * 1 % of its box's shape is now filled instead (render/plan.ts `fitFor`); a real
 * mismatch is still letterboxed, which is the second check.
 */

let dir = ''
const canvas = { width: 540, height: 960 }

async function photo(name: string, width: number, height: number): Promise<string> {
  const file = join(dir, name)
  await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=red:s=${width}x${height}`, '-frames:v', '1', file])
  return file
}

function project(path: string, size: { width: number; height: number }, over: Partial<Clip> = {}): Project {
  const asset: MediaAsset = {
    id: 'p', path, name: 'p.png', kind: 'image', durationFrames: 60, width: size.width, height: size.height, fps: null, hasVideo: true, hasAudio: false, size: 1
  }
  const clip: Clip = {
    id: 'c', assetId: 'p', trackId: 'v1', start: 0, duration: 30, inPoint: 0, volume: 1,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    color: { brightness: 0, contrast: 1, saturation: 1 },
    ...over
  }
  const empty = emptyProject()
  return { ...empty, settings: { ...empty.settings, ...canvas, fps: 30 }, assets: [asset], clips: [clip] }
}

async function render(p: Project, name: string): Promise<string> {
  const file = join(dir, `${name}.mp4`)
  await run(FFMPEG, buildRenderPlan({ project: p, outputPath: file, canvas }).args, { maxBuffer: 32 * 1024 * 1024 })
  await saveFrame(file, 0.5, join(dir, `${name}.png`))
  return file
}

const isRed = ([r, g, b]: number[]): boolean => r > 180 && g < 70 && b < 70
const isBlack = ([r, g, b]: number[]): boolean => r < 30 && g < 30 && b < 30
const lines: string[] = []

beforeAll(async () => {
  dir = await outputDir('reframe-fill')
  lines.push('# reframe-fill', '', 'A red photo, reframed for 9:16 by solveCrop and exported at 540x960.', '')
}, 120_000)

describe('a reframed photo fills the frame', () => {
  it('a 4:5 photo reframed for 9:16 reaches every edge, still and under a Ken Burns move', async () => {
    const size = { width: 1080, height: 1350 }
    const file = await photo('portrait.png', size.width, size.height)
    const crop = solveCrop(size, canvas)!
    expect(crop.width / crop.height).not.toBe(canvas.width / canvas.height)
    for (const [name, over] of [
      ['still', {}],
      ['kenburns', { motion: { kind: 'kenburns' as const, direction: 'in' as const, amount: 0.12 } }]
    ] as const) {
      const out = await render(project(file, size, { crop, ...over }), name)
      const edges = {
        right: await pixelAt(out, 0.5, canvas.width - 1, 480, canvas),
        left: await pixelAt(out, 0.5, 0, 480, canvas),
        top: await pixelAt(out, 0.5, 270, 0, canvas),
        bottom: await pixelAt(out, 0.5, 270, canvas.height - 1, canvas)
      }
      lines.push(`- ${name}: crop ${crop.width}x${crop.height}; edges ${Object.entries(edges).map(([k, v]) => `${k} rgb(${v.join(', ')})`).join(', ')}`)
      for (const [edge, px] of Object.entries(edges)) expect(isRed(px), `${name}: ${edge} edge rgb(${px.join(', ')})`).toBe(true)
    }
  }, 300_000)

  it('a real mismatch is still letterboxed: a 16:9 photo with no reframe in a 9:16 frame', async () => {
    const size = { width: 1920, height: 1080 }
    const file = await photo('landscape.png', size.width, size.height)
    const out = await render(project(file, size), 'landscape')
    const top = await pixelAt(out, 0.5, 270, 40, canvas)
    const middle = await pixelAt(out, 0.5, 270, 480, canvas)
    lines.push(`- landscape, no reframe: top rgb(${top.join(', ')}), middle rgb(${middle.join(', ')}) — black above, the photo across the middle`)
    await writeNote(dir, lines)
    expect(isBlack(top)).toBe(true)
    expect(isRed(middle)).toBe(true)
  }, 300_000)
})

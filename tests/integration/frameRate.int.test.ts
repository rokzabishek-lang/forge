import { describe, it, expect, beforeAll } from 'vitest'
import { join } from 'node:path'
import { buildRenderPlan } from '@shared/render/plan'
import { convertFrameRate } from '@shared/project/frameRate'
import { emptyProject, type Clip, type MediaAsset, type Project } from '@shared/timeline'
import { FFMPEG, run, outputDir, makeClipWithTone, meanVolumeDb, pixelAt, writeNote } from './output'

/*
 * A 30 fps edit converted to 25 renders as the SAME edit (FIX.md B2).
 *
 * Same length, the same shot on screen at the same moment, the same sound — and
 * a file that really is 25 fps. Kept in tests/output/frame-rate/.
 */

const W = 320
const H = 240
let dir = ''
const files: Record<string, string> = {}

beforeAll(async () => {
  dir = await outputDir('frame-rate')
  files.red = await makeClipWithTone(join(dir, 'source-red.mp4'), 'red', 300, { width: W, height: H }, 2, 30)
  files.green = await makeClipWithTone(join(dir, 'source-green.mp4'), 'green', 600, { width: W, height: H }, 2, 30)
  files.blue = await makeClipWithTone(join(dir, 'source-blue.mp4'), 'blue', 900, { width: W, height: H }, 2, 30)
  await writeNote(dir, [
    'The same edit at 30 fps, and converted to 25 fps.',
    '',
    'at-30.mp4   red | green | blue, cuts at 1.0 s and 2.1 s (frames 30 and 63)',
    'at-25.mp4   the same project after convertFrameRate(…, 25): same cuts, same length'
  ])
}, 120_000)

function edit(): Project {
  const asset = (id: string): MediaAsset => ({
    id, path: files[id], name: id, kind: 'video', durationFrames: 60,
    width: W, height: H, fps: 30, hasVideo: true, hasAudio: true, size: 1
  })
  const clip = (id: string, start: number, duration: number): Clip => ({
    id, assetId: id, trackId: 'v1', start, duration, inPoint: 0, volume: 1,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    color: { brightness: 0, contrast: 1, saturation: 1 }
  })
  const empty = emptyProject()
  const { loudness: _off, ...settings } = empty.settings
  return {
    ...empty,
    settings: { ...settings, width: W, height: H, fps: 30 },
    assets: [asset('red'), asset('green'), asset('blue')],
    // Cuts that do not fall on a 25 fps frame: 63 frames is 2.1 s.
    clips: [clip('red', 0, 30), clip('green', 30, 33), clip('blue', 63, 27)]
  }
}

async function render(project: Project, name: string): Promise<string> {
  const file = join(dir, name)
  await run(FFMPEG, buildRenderPlan({ project, outputPath: file }).args, { maxBuffer: 32 * 1024 * 1024 })
  return file
}

async function info(file: string): Promise<string> {
  const { stderr } = await run(FFMPEG, ['-hide_banner', '-i', file]).catch((e: { stderr: string }) => e)
  return stderr
}

const colourAt = async (file: string, seconds: number): Promise<string> => {
  const [r, g, b] = await pixelAt(file, seconds, W / 2, H / 2, { width: W, height: H })
  return r > 150 && g < 90 ? 'red' : g > 90 && r < 90 && b < 90 ? 'green' : b > 150 && r < 90 ? 'blue' : `${r},${g},${b}`
}

describe('a converted frame rate, rendered', () => {
  it('is the same edit: same length, same shots at the same moments, same sound', async () => {
    const at30 = await render(edit(), 'at-30.mp4')
    const at25 = await render(convertFrameRate(edit(), 25), 'at-25.mp4')

    expect(await info(at25)).toMatch(/\b25 fps\b/)
    const length = async (file: string): Promise<number> => {
      const m = /Duration: \d+:\d+:([\d.]+)/.exec(await info(file))
      return Number(m?.[1])
    }
    // 3.0 s either way, within a frame of the slower rate.
    expect(Math.abs((await length(at25)) - (await length(at30)))).toBeLessThan(1 / 25 + 0.03)

    // Either side of each cut, the same shot in both.
    for (const [seconds, colour] of [[0.5, 'red'], [0.9, 'red'], [1.1, 'green'], [2.0, 'green'], [2.2, 'blue'], [2.8, 'blue']] as const) {
      expect(await colourAt(at30, seconds), `30 fps at ${seconds}s`).toBe(colour)
      expect(await colourAt(at25, seconds), `25 fps at ${seconds}s`).toBe(colour)
    }
    // And the green shot's sound is the green shot's sound, as loud.
    expect(Math.abs((await meanVolumeDb(at25, 1.3, 0.5)) - (await meanVolumeDb(at30, 1.3, 0.5)))).toBeLessThan(1)
  }, 300_000)
})

import { describe, it, expect, beforeAll } from 'vitest'
import { join } from 'node:path'
import { buildRenderPlan } from '@shared/render/plan'
import { effectiveCrop } from '@shared/render/crop'
import { emptyProject, type Clip, type CropRect, type MediaAsset, type Project } from '@shared/timeline'
import { FFMPEG, run, outputDir, pixelAt, saveFrame, writeNote } from './output'

/*
 * The preview and the export crop to the same rectangle.
 *
 * The preview drew the raw `clip.crop`; the export clamps it, so a crop hanging
 * off an edge showed one piece of the picture on screen and exported another.
 * The preview now draws `effectiveCrop` — and this proves `effectiveCrop` IS
 * what the export cuts, by rendering and reading the pixels back.
 *
 * The source is red with a green stripe at x 880–960 and blue from x 1180. A
 * 400×400 crop asked for at x 1000 lands at x 880 once slid inside: its left
 * edge is the green stripe. The raw rectangle's left edge would be red.
 */

let dir = ''
let source = ''
const SRC = { width: 1280, height: 720 }

beforeAll(async () => {
  dir = await outputDir('crop-parity')
  source = join(dir, 'source.png')
  await run(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=red:s=${SRC.width}x${SRC.height}:d=1`,
    '-vf', 'drawbox=x=880:y=0:w=80:h=720:color=lime:t=fill,drawbox=x=1180:y=0:w=100:h=720:color=blue:t=fill',
    '-frames:v', '1', source
  ])
  await writeNote(dir, [
    'A crop hanging off the right edge: asked for at x=1000, 400x400.',
    'source.png   red, a green stripe at x 880-960, blue from x 1180',
    'cropped.png  what the export shows — green on the left edge (the crop slid to x=880),',
    '             which is what the preview now draws too'
  ])
}, 120_000)

function project(crop: CropRect): Project {
  const asset: MediaAsset = {
    id: 'a', path: source, name: 'source.png', kind: 'image', durationFrames: 30,
    width: SRC.width, height: SRC.height, fps: null, hasVideo: true, hasAudio: false, size: 1
  }
  const clip: Clip = {
    id: 'c', assetId: 'a', trackId: 'v1', start: 0, duration: 15, inPoint: 0, volume: 1,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    color: { brightness: 0, contrast: 1, saturation: 1 },
    crop
  }
  // A canvas the crop's own size and shape, so export pixels map 1:1 to source pixels.
  return { ...emptyProject(), settings: { ...emptyProject().settings, width: 400, height: 400, fps: 30 }, assets: [asset], clips: [clip] }
}

const kind = ([r, g, b]: number[]): string =>
  g > 150 && r < 100 && b < 100 ? 'green' : r > 150 && g < 100 && b < 100 ? 'red' : b > 150 && r < 100 && g < 100 ? 'blue' : `${r},${g},${b}`

describe('the crop on screen is the crop in the file', () => {
  it('slides a crop off the edge exactly as effectiveCrop says', async () => {
    const asked: CropRect = { x: 1000, y: 100, width: 400, height: 400 }
    const file = join(dir, 'cropped.mp4')
    await run(FFMPEG, buildRenderPlan({ project: project(asked), outputPath: file }).args, { maxBuffer: 32 * 1024 * 1024 })
    await saveFrame(file, 0.1, join(dir, 'cropped.png'))

    const predicted = effectiveCrop(asked, SRC)
    expect(predicted.x).toBe(880)
    const sourceKindAt = (x: number): string => (x >= 1180 ? 'blue' : x >= 880 && x < 960 ? 'green' : 'red')
    // Across the frame, the export's pixel is the source's pixel at the predicted offset.
    for (const x of [10, 60, 150, 250, 330, 390]) {
      const got = kind(await pixelAt(file, 0.1, x, 200, { width: 400, height: 400 }))
      expect(got, `export x=${x}`).toBe(sourceKindAt(predicted.x + x))
    }
    // And the raw rectangle would have shown red at the left edge, not green.
    expect(sourceKindAt(asked.x + 10)).toBe('red')
  }, 300_000)
})

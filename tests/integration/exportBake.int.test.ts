import { describe, it, expect, beforeAll } from 'vitest'
import { join } from 'node:path'
import { buildRenderPlan } from '@shared/render/plan'
import { bakeForExport, type Bakers } from '@shared/render/exportBake'
import { emptyProject, type Clip, type MediaAsset, type Project } from '@shared/timeline'
import { FFMPEG, run, outputDir, pixelAt, saveFrame, writeNote } from './output'

/*
 * A 16:9 edit exported through the 9:16 preset: its colour card must FILL the
 * reel, not sit in it as a letterboxed landscape band.
 *
 * The editor's rebake drew the card at the project's 1920×1080 and ffmpeg
 * fitted it into 1080×1920 — the size check compared pixel AREA, and those two
 * are the same area. `bakeForExport` draws at the export's own canvas. The
 * drawing is faked with ffmpeg — a PNG of the card's colour at whatever size
 * was asked for — because the real one is canvas code; what is under test is
 * the size asked for and what the render makes of it. Found by the B2 review.
 */

let dir = ''

beforeAll(async () => {
  dir = await outputDir('export-bake')
  await writeNote(dir, [
    'A 16:9 edit with a full-frame red card, exported at 9:16.',
    '',
    'old-way.mp4 / .png   the card drawn at the project size (1920x1080): letterboxed, black above and below',
    'new-way.mp4 / .png   the card drawn by bakeForExport at the export size (1080x1920): red edge to edge'
  ])
}, 120_000)

/** A PNG of one colour at exactly the size asked for — what a solid card is. */
async function drawCard(color: string, key: string, width: number, height: number): Promise<string> {
  const file = join(dir, `${key}-${width}x${height}.png`)
  await run(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=${color}:s=${width}x${height}:d=1`, '-frames:v', '1', file
  ])
  return file
}

const unused = async (): Promise<never> => {
  throw new Error('not drawn in this check')
}
const bakers: Bakers = {
  solid: (spec, key, w, h) => drawCard(spec.color, key, w, h),
  text: unused, textSequence: unused, title: unused, paper: unused, carousel: unused
}

async function landscapeEdit(): Promise<Project> {
  // What the edit holds: the card as the editor last drew it, at 1920×1080.
  const drawn = await drawCard('red', 'card', 1920, 1080)
  const asset: MediaAsset = {
    id: 's', path: drawn, name: 'card', kind: 'image', durationFrames: 30,
    width: 1920, height: 1080, fps: null, hasVideo: true, hasAudio: false, size: 1
  }
  const clip: Clip = {
    id: 'card', assetId: 's', trackId: 'v1', start: 0, duration: 30, inPoint: 0, volume: 1,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    color: { brightness: 0, contrast: 1, saturation: 1 },
    solid: { color: 'red', opacity: 1, version: 1 }
  }
  const empty = emptyProject()
  return {
    ...empty,
    settings: { ...empty.settings, width: 1920, height: 1080, fps: 30 },
    assets: [asset],
    clips: [clip]
  }
}

const reel = { width: 1080, height: 1920 }
const isRed = ([r, g, b]: number[]): boolean => r > 180 && g < 60 && b < 60
const isBlack = ([r, g, b]: number[]): boolean => r < 30 && g < 30 && b < 30

async function render(project: Project, name: string): Promise<string> {
  const file = join(dir, `${name}.mp4`)
  await run(FFMPEG, buildRenderPlan({ project, outputPath: file, canvas: reel }).args, { maxBuffer: 32 * 1024 * 1024 })
  await saveFrame(file, 0.2, join(dir, `${name}.png`))
  return file
}

describe('an export’s cards are drawn for the export', () => {
  it('fills a 9:16 reel with a 16:9 edit’s card, where the old bake letterboxed it', async () => {
    const edit = await landscapeEdit()
    const oldWay = await render(edit, 'old-way')
    const newWay = await render(await bakeForExport(edit, reel, bakers), 'new-way')

    const top = (file: string): Promise<[number, number, number]> => pixelAt(file, 0.2, 540, 40, reel)
    const middle = (file: string): Promise<[number, number, number]> => pixelAt(file, 0.2, 540, 960, reel)
    // The measurement can see the bug: the old way is black at the top.
    expect(isBlack(await top(oldWay))).toBe(true)
    expect(isRed(await middle(oldWay))).toBe(true)
    // And the new way is the card, edge to edge.
    expect(isRed(await top(newWay))).toBe(true)
    expect(isRed(await middle(newWay))).toBe(true)
  }, 300_000)
})

import { beforeAll, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { emptyProject, type Clip, type MediaAsset, type Project } from '@shared/timeline'
import { buildSlots } from '@shared/director/menu'
import { PRODUCT_REVEAL } from '@shared/director/recipes'
import { rhythmGrid } from '@shared/director/rhythm'
import type { Menu2 } from '@shared/director/schema2'
import { validateSpine2 } from '@shared/director/validate2'
import { baselineSpine2 } from '@shared/director/baseline2'
import { composeAd } from '@shared/director/compose'
import { applyRecipe } from '@shared/director/apply2'
import { BACKDROP_RULE, SPINE_RULE } from '@shared/director/apply'
import type { Brief } from '@shared/director/schema'
import { evalRenderPlan, renderEval } from '../eval/pipeline'
import { FFMPEG, outputDir, pixelAt, run, saveFrame, writeNote } from './output'
import { writeFile } from 'node:fs/promises'

/*
 * A square photo in a 9:16 ad, rendered (docs/PLAN.md §5.5, apply2.ts
 * BACKDROP_KEEP).
 *
 * The photo is blue with a red band down its left edge and a green one down
 * its right — the parts a frame's crop throws away. Shown whole over its
 * blurred copy, the render has red at the left of the frame and green at the
 * right, blue in the middle, and above the picture a band that is the copy:
 * darker than the picture, blue where the copy is blue, and with the red
 * smeared into it where the copy's edge was red — the blur. A 4:5 photo in the
 * same ad is simply cropped, yellow to every edge, with nothing under it.
 */

const fps = 30
const canvas = { width: 90, height: 160 }
const brief: Brief = { product: 'Aura serum', benefit: 'glow', audience: '', tone: 'premium', cta: 'Shop now', seconds: 8, language: 'English' }
let dir = ''
let out = ''
let square: Clip
let tall: Clip
let backdrop: Clip
let graph = ''
const lines: string[] = []

async function banded(file: string): Promise<string> {
  // Blue, with 25-px red and green bands at the sides — `t=fill` boxes are as old as drawbox.
  await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=100x100', '-vf', 'drawbox=x=0:y=0:w=25:h=100:c=red:t=fill,drawbox=x=75:y=0:w=25:h=100:c=green:t=fill', '-frames:v', '1', file])
  return file
}

async function yellow(file: string): Promise<string> {
  await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=yellow:s=80x100', '-frames:v', '1', file])
  return file
}

beforeAll(async () => {
  dir = await outputDir('backdrop')
  const media = join(dir, 'media')
  await mkdir(media, { recursive: true })
  const asset = (id: string, path: string, width: number, height: number): MediaAsset => ({
    id, path, name: `${id}.png`, kind: 'image', durationFrames: 150, width, height, fps: null, hasVideo: true, hasAudio: false, size: 100
  })
  const empty = emptyProject()
  const project: Project = {
    ...empty,
    settings: { ...empty.settings, ...canvas, fps },
    assets: [asset('square', await banded(join(media, 'square.png')), 100, 100), asset('tall', await yellow(join(media, 'tall.png')), 80, 100)],
    clips: []
  }
  const slots = buildSlots(project)
  const menu: Menu2 = { slots, recipes: [PRODUCT_REVEAL], fallback: PRODUCT_REVEAL, heroCandidates: slots.map((s) => s.id), fps, seconds: 8, bpm: PRODUCT_REVEAL.tempo, holds: { min: 2, max: 2 }, drops: [] }
  const checked = validateSpine2(baselineSpine2(brief, menu, PRODUCT_REVEAL), menu)
  if ('rejected' in checked) throw new Error(checked.rejected)
  const grid = rhythmGrid(null, { fps, seconds: 8, tempo: PRODUCT_REVEAL.tempo })
  let n = 0
  const applied = applyRecipe(project, composeAd(checked.plan, checked.recipe, menu, grid), menu, {
    fps, videoTrackId: 'v1', brief, model: 'baseline', catalogue: [], newId: (x) => `${x}-${++n}`
  })
  const shots = applied.project.clips.filter((c) => c.generatedBy?.rule === SPINE_RULE)
  square = shots.find((c) => c.assetId === 'square')!
  tall = shots.find((c) => c.assetId === 'tall')!
  backdrop = applied.project.clips.find((c) => c.generatedBy?.rule === BACKDROP_RULE)!
  out = join(dir, 'backdrop.mp4')
  graph = (await evalRenderPlan(applied.project, out, { extraTransitions: [], canvas })).args.join(' ')
  await writeFile(join(dir, 'graph.txt'), graph.replace(/;/g, ';\n'))
  await renderEval(applied.project, out, { extraTransitions: [], canvas })
}, 300_000)

const mid = (c: Clip): number => (c.start + c.duration / 2) / fps

describe('a square photo in a 9:16 ad', () => {
  it('is shown whole over its blurred, darkened copy; the 4:5 photo beside it is simply cropped', async () => {
    expect(backdrop).toBeDefined()
    expect(backdrop.assetId).toBe('square')
    const t = mid(square)
    await saveFrame(out, t, join(dir, 'square.png'))
    await saveFrame(out, mid(tall), join(dir, 'tall.png'))
    // The picture, contained: 100×100 into 90 wide, so 90×90, centred — rows 35 to 125.
    const centre = await pixelAt(out, t, 45, 80, canvas)
    const left = await pixelAt(out, t, 4, 80, canvas)
    const right = await pixelAt(out, t, 85, 80, canvas)
    // Above the picture: the copy — the frame's crop of the square, blurred and darker.
    const above = await pixelAt(out, t, 45, 12, canvas)
    // Six pixels in: past the mask's own edge column, whose 4:2:0 chroma pair stays the unblurred copy's.
    const aboveEdge = await pixelAt(out, t, 6, 12, canvas)
    const aboveIn = await pixelAt(out, t, 25, 12, canvas)
    const yellowMid = await pixelAt(out, mid(tall), 45, 80, canvas)
    const yellowTop = await pixelAt(out, mid(tall), 45, 12, canvas)
    const yellowEdge = await pixelAt(out, mid(tall), 4, 80, canvas)
    lines.push(
      '# backdrop', '',
      `A blue 100×100 photo with red and green side bands, and an 80×100 yellow one, in a ${canvas.width}×${canvas.height} product reveal.`, '',
      `- the square at ${t.toFixed(2)} s: centre rgb(${centre.join(', ')}), left edge rgb(${left.join(', ')}), right edge rgb(${right.join(', ')})`,
      `- above it, the backdrop: middle rgb(${above.join(', ')}), 6 px from the left rgb(${aboveEdge.join(', ')}), 25 px in rgb(${aboveIn.join(', ')})`,
      `  (the copy's crop keeps 3 px of the red band, 4.8 px once scaled: unblurred, x=6 would be pure blue)`,
      `- the 4:5 photo: middle rgb(${yellowMid.join(', ')}), top rgb(${yellowTop.join(', ')}), left edge rgb(${yellowEdge.join(', ')})`
    )
    await writeNote(dir, lines)

    // The whole picture: red at the left, green at the right, blue between.
    expect(centre[2]).toBeGreaterThan(180)
    expect(centre[0]).toBeLessThan(60)
    expect(left[0]).toBeGreaterThan(180)
    expect(left[2]).toBeLessThan(60)
    expect(right[1]).toBeGreaterThan(120)
    expect(right[0]).toBeLessThan(60)
    // The copy above it: blue, and darker than the picture's blue.
    expect(above[2]).toBeGreaterThan(above[0] + 40)
    expect(above[2]).toBeGreaterThan(above[1] + 40)
    expect(above[2]).toBeLessThan(centre[2] - 30)
    // Blurred: the copy's red edge has run into the blue beside it — at x=6 neither pure red nor pure
    // blue, and bluer again further in. Unblurred, x=6 is past the 4.8-px strip: pure blue.
    expect(aboveEdge[0]).toBeGreaterThan(25)
    expect(aboveEdge[2]).toBeGreaterThan(25)
    expect(aboveIn[2]).toBeGreaterThan(aboveEdge[2] + 20)
    expect(aboveIn[0]).toBeLessThan(aboveEdge[0] - 20)
    // The 4:5 photo: yellow everywhere, its crop filling the frame.
    for (const px of [yellowMid, yellowTop, yellowEdge]) {
      expect(px[0]).toBeGreaterThan(180)
      expect(px[1]).toBeGreaterThan(180)
      expect(px[2]).toBeLessThan(60)
    }
  }, 300_000)
})

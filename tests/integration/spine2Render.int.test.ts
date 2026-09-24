import { beforeAll, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import type { MusicAnalysis } from '@shared/automation/cutPlan'
import { buildRenderPlan } from '@shared/render/plan'
import { bakeForExport, type Bakers } from '@shared/render/exportBake'
import { emptyProject, type Clip, type MediaAsset, type Project } from '@shared/timeline'
import { buildSlots } from '@shared/director/menu'
import { PRODUCT_REVEAL, RECIPES } from '@shared/director/recipes'
import { rhythmGrid } from '@shared/director/rhythm'
import type { Menu2 } from '@shared/director/schema2'
import { validateSpine2 } from '@shared/director/validate2'
import { baselineSpine2 } from '@shared/director/baseline2'
import { composeAd, type Composed } from '@shared/director/compose'
import { applyRecipe } from '@shared/director/apply2'
import { COPY_RULE, LOOK_RULE } from '@shared/director/apply'
import type { Brief } from '@shared/director/schema'
import { FFMPEG, makeColour, makeTone, outputDir, pixelAt, run, saveFrame, writeNote } from './output'

/**
 * A `spine@2` ad, applied and RENDERED (docs/PLAN.md §5.6).
 *
 * The standard cut of a product reveal — four photos and a four-second clip,
 * a 20 s song at 100 BPM — through validate, compose and `applyRecipe`, then
 * through ffmpeg, twice: once with the recipe's look installed, once without.
 * The frames are read back: each shot shows its own picture for the span the
 * rhythm engine gave it; the clip is never shown past its footage; the black
 * is black; the end card is on it; the look grades every shot and NOT the
 * headline card above it; and the ad is as long as the layout says.
 *
 * The drawn pictures are stand-ins, as in exportBake.int.test.ts: a colour
 * card is a PNG of its colour, a headline a white square on transparent, and
 * the look layer's own picture the transparent 16×16 the store's
 * `addAdjustmentLayer` draws. The look is a LUT that maps everything to black,
 * so its strength can be read off a pixel.
 */

const fps = 30
const canvas = { width: 540, height: 960 }
let dir = ''
let lut = ''
let blank = ''

/** Each picture's colour, in slot order. */
const COLOURS = ['#d03030', '#30b050', '#3050d0', '#c040c0', '#d0b030']
const rgbOf = (hex: string): number[] => [1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16))

const brief: Brief = { product: 'Aura serum', benefit: 'glow', audience: '', tone: 'premium', cta: 'Shop now', seconds: 20, language: 'English' }

function song(bpm: number, seconds: number): MusicAnalysis {
  const beatMs = 60_000 / bpm
  const beats: number[] = []
  for (let t = 0; t <= seconds * 1000; t += beatMs) beats.push(Math.round(t))
  return { bpm, beats, downbeats: beats.filter((_, i) => i % 4 === 0), tiers: beats.map(() => 2), drops: [{ ms: 9000, score: 0.9 }], buildups: [], sections: [4800], durationMs: seconds * 1000 }
}

async function still(file: string, colour: string): Promise<string> {
  await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${colour}:s=1080x1350`, '-frames:v', '1', file])
  return file
}

/** A white square in the middle of a transparent frame — where a headline's pixels are. */
async function whiteSquare(file: string, width: number, height: number): Promise<string> {
  const x = Math.round(width / 2) - 50
  const y = Math.round(height / 2) - 50
  // `drawbox` and `geq` on rgba leave the alpha at 0 on the bundled ffmpeg (measured); overlay writes it.
  await run(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
    `color=c=black@0:s=${width}x${height},format=rgba[bg];color=c=white:s=100x100,format=rgba[b];[bg][b]overlay=${x}:${y}:format=rgb,format=rgba`,
    '-frames:v', '1', file
  ])
  return file
}

const bakers = (): Bakers => ({
  solid: async (spec, key, w, h) => {
    const file = join(dir, `${key}.png`)
    await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${spec.color.replace('#', '0x')}:s=${w}x${h}`, '-frames:v', '1', file])
    return file
  },
  text: (_spec, key, w, h) => whiteSquare(join(dir, `${key}.png`), w, h),
  textSequence: async () => null,
  title: async () => { throw new Error('no titles in this ad') },
  paper: async () => { throw new Error('no paper in this ad') },
  carousel: async () => { throw new Error('no carousel in this ad') }
})

async function edit(): Promise<Project> {
  const media = join(dir, 'media')
  await mkdir(media, { recursive: true })
  const asset = (id: string, path: string, over: Partial<MediaAsset> = {}): MediaAsset => ({
    id, path, name: `${id}.jpg`, kind: 'image', durationFrames: 150, width: 1080, height: 1350, fps: null, hasVideo: true, hasAudio: false, size: 100, ...over
  })
  const assets: MediaAsset[] = [
    asset('p1', await still(join(media, 'p1.png'), COLOURS[0])),
    asset('p2', await still(join(media, 'p2.png'), COLOURS[1])),
    asset('p3', await still(join(media, 'p3.png'), COLOURS[2])),
    asset('clip', await makeColour(join(media, 'clip.mp4'), COLOURS[3], { width: 1080, height: 1920 }, 4, fps), {
      name: 'clip.mp4', kind: 'video', durationFrames: 4 * fps, width: 1080, height: 1920, fps
    }),
    asset('p5', await still(join(media, 'p5.png'), COLOURS[4])),
    asset('song', await makeTone(join(media, 'song.m4a'), 220, 20, 0.3), {
      name: 'song.m4a', kind: 'audio', durationFrames: 20 * fps, width: null, height: null, hasVideo: false, hasAudio: true
    })
  ]
  const music: Clip = {
    id: 'music', assetId: 'song', trackId: 'a1', start: 0, duration: 20 * fps, inPoint: 0, volume: 1,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, color: { brightness: 0, contrast: 1, saturation: 1 }
  }
  const empty = emptyProject()
  return { ...empty, settings: { ...empty.settings, ...canvas, fps }, assets, clips: [music] }
}

function menuOf(p: Project): Menu2 {
  return { slots: buildSlots(p), recipes: [...RECIPES], fallback: PRODUCT_REVEAL, heroCandidates: ['slot_02', 'slot_01', 'slot_03', 'slot_05'], fps, seconds: 20, bpm: 100, holds: { min: 4, max: 8 }, drops: [9] }
}

/** Apply, draw what the store draws, render. */
async function renderAd(p: Project, composed: Composed, withLook: boolean, name: string): Promise<{ file: string; project: Project }> {
  let n = 0
  const menu = menuOf(p)
  const applied = applyRecipe(p, composed, menu, {
    fps, videoTrackId: 'v1', brief, model: 'baseline', catalogue: [], musicClipId: 'music',
    lookFile: withLook ? { file: lut, name: 'All black' } : null,
    newId: (x) => `${x}-${++n}`
  })
  // The look layer's picture: the transparent square the store draws for every adjustment layer.
  const lookIds = new Set(applied.project.clips.filter((c) => c.generatedBy?.rule === LOOK_RULE).map((c) => c.assetId))
  const drawn: Project = { ...applied.project, assets: applied.project.assets.map((a) => (lookIds.has(a.id) ? { ...a, path: blank, width: 16, height: 16, size: 1 } : a)) }
  const baked = await bakeForExport(drawn, canvas, bakers(), (clip, err) => { throw new Error(`${clip.id}: ${String(err)}`) })
  const file = join(dir, `${name}.mp4`)
  await run(FFMPEG, buildRenderPlan({ project: baked, outputPath: file, canvas }).args, { maxBuffer: 64 * 1024 * 1024 })
  return { file, project: baked }
}

async function durationOf(file: string): Promise<number> {
  const out = await run(FFMPEG, ['-hide_banner', '-i', file]).catch((err: { stderr: string }) => err)
  const m = /Duration: (\d+):(\d+):(\d+\.\d+)/.exec(out.stderr)
  if (!m) throw new Error(`no duration for ${file}`)
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
}

let composed: Composed
let plain: { file: string; project: Project }
let graded: { file: string; project: Project }
const lines: string[] = []

beforeAll(async () => {
  dir = await outputDir('spine2Render')
  lut = join(dir, 'black.cube')
  await writeFile(lut, `LUT_3D_SIZE 2\n${'0 0 0\n'.repeat(8)}`)
  blank = join(dir, 'blank.png')
  await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black@0:s=16x16,format=rgba', '-frames:v', '1', blank])

  const p = await edit()
  const menu = menuOf(p)
  const checked = validateSpine2(baselineSpine2(brief, menu, PRODUCT_REVEAL), menu)
  if ('rejected' in checked) throw new Error(checked.rejected)
  const grid = rhythmGrid(song(100, 20), { fps, seconds: 20, tempo: PRODUCT_REVEAL.tempo })
  composed = composeAd(checked.plan, checked.recipe, menu, grid)
  plain = await renderAd(p, composed, false, 'plain')
  graded = await renderAd(p, composed, true, 'look')
  lines.push('# spine2Render', '', 'The standard cut of a product reveal, applied by applyRecipe and rendered at 540×960.', '',
    'plain.mp4 — without the look; look.mp4 — the recipe look installed, a LUT that maps everything to black at the recipe’s strength.', '')
}, 600_000)

const at = (frame: number): number => frame / fps
const mid = (a: number, b: number): number => at((a + b) / 2)
/** Off the headline square and inside a 4:5 photo however it is fitted. */
const PHOTO = { x: 60, y: 300 }
const CENTRE = { x: 270, y: 480 }

describe('a spine@2 ad, rendered', () => {
  it('shows each shot’s own picture for the span the engine gave it, and the clip never past its footage', async () => {
    const slotColour = new Map(menuOf(plain.project).slots.map((s, i) => [s.id, rgbOf(COLOURS[i])]))
    lines.push('Each shot, sampled at the middle of its span, off the card (plain / look):', '')
    for (const [i, shot] of composed.layout.shots.entries()) {
      const t = mid(shot.startFrame, shot.endFrame)
      const want = slotColour.get(shot.slotId)!
      const got = await pixelAt(plain.file, t, PHOTO.x, PHOTO.y, canvas)
      await saveFrame(plain.file, t, join(dir, `shot${i + 1}-plain.png`))
      lines.push(`- shot ${i + 1} ${shot.slotId}${shot.hero ? ' (hero)' : ''} ${(at(shot.startFrame)).toFixed(2)}–${at(shot.endFrame).toFixed(2)} s: rgb(${got.join(', ')}), want rgb(${want.join(', ')})`)
      for (let k = 0; k < 3; k++) expect(Math.abs(got[k] - want[k]), `shot ${i + 1} channel ${k}`).toBeLessThan(14)
    }
    // The clip's last frame of its shot is still the clip, not black: the engine never gives it more than its footage.
    const clipShot = composed.layout.shots.find((s) => s.slotId === 'slot_04')!
    expect(clipShot.endFrame - clipShot.startFrame).toBeLessThanOrEqual(4 * fps)
    const lastOfClip = await pixelAt(plain.file, at(clipShot.endFrame - 2), PHOTO.x, PHOTO.y, canvas)
    lines.push('', `- the clip two frames before its shot ends (${at(clipShot.endFrame - 2).toFixed(2)} s): rgb(${lastOfClip.join(', ')})`)
    for (let k = 0; k < 3; k++) expect(Math.abs(lastOfClip[k] - rgbOf(COLOURS[3])[k])).toBeLessThan(14)
  }, 300_000)

  it('the black is black, the end card is over it, and the ad is as long as the layout', async () => {
    const { black, endCard, endFrame } = composed.layout
    expect(black).not.toBeNull()
    expect(endCard).not.toBeNull()
    const inBlack = await pixelAt(plain.file, mid(black!.startFrame, black!.endFrame), CENTRE.x, CENTRE.y, canvas)
    const cardAt = mid(endCard!.startFrame, endCard!.endFrame)
    const cardCentre = await pixelAt(plain.file, cardAt, CENTRE.x, CENTRE.y, canvas)
    const cardEdge = await pixelAt(plain.file, cardAt, PHOTO.x, PHOTO.y, canvas)
    await saveFrame(plain.file, cardAt, join(dir, 'end-card.png'))
    const seconds = await durationOf(plain.file)
    lines.push('', `- the black, centre: rgb(${inBlack.join(', ')})`, `- the end card, centre: rgb(${cardCentre.join(', ')}); edge: rgb(${cardEdge.join(', ')})`,
      `- length: ${seconds.toFixed(2)} s, the layout ${at(endFrame).toFixed(2)} s`)
    expect(Math.max(...inBlack)).toBeLessThan(24)
    expect(Math.min(...cardCentre)).toBeGreaterThan(230)
    expect(Math.max(...cardEdge)).toBeLessThan(24)
    expect(Math.abs(seconds - at(endFrame))).toBeLessThan(0.1)
  }, 300_000)

  it('the look grades every shot and not the headline above it', async () => {
    const intensity = graded.project.clips.find((c) => c.generatedBy?.rule === LOOK_RULE)!.color!.lut!.intensity
    lines.push('', `The look at ${intensity.toFixed(2)}: a black LUT leaves ${(1 - intensity).toFixed(2)} of each shot.`, '')
    for (const [i, shot] of composed.layout.shots.entries()) {
      const t = mid(shot.startFrame, shot.endFrame)
      const before = await pixelAt(plain.file, t, PHOTO.x, PHOTO.y, canvas)
      const after = await pixelAt(graded.file, t, PHOTO.x, PHOTO.y, canvas)
      await saveFrame(graded.file, t, join(dir, `shot${i + 1}-look.png`))
      lines.push(`- shot ${i + 1}: rgb(${before.join(', ')}) → rgb(${after.join(', ')})`)
      // Darkened to about what the LUT's strength leaves — well under half of every lit channel.
      const lit = before.reduce((a, b) => a + b, 0)
      expect(after.reduce((a, b) => a + b, 0), `shot ${i + 1}`).toBeLessThan(0.5 * lit)
    }
    // A headline over a graded shot is its own white: the look sits below the cards.
    const card = graded.project.clips.find((c) => c.generatedBy?.rule === COPY_RULE && c.start < composed.layout.shots.at(-1)!.endFrame)!
    expect(card).toBeDefined()
    const t = at(card.start + card.duration / 2)
    const onCard = await pixelAt(graded.file, t, CENTRE.x, CENTRE.y, canvas)
    const offCard = await pixelAt(graded.file, t, PHOTO.x, PHOTO.y, canvas)
    await saveFrame(graded.file, t, join(dir, 'headline-over-look.png'))
    lines.push('', `- a headline over the graded shot at ${t.toFixed(2)} s: on the card rgb(${onCard.join(', ')}), beside it rgb(${offCard.join(', ')})`)
    expect(Math.min(...onCard)).toBeGreaterThan(230)
    expect(Math.max(...offCard)).toBeLessThan(140)
    await writeNote(dir, lines)
  }, 300_000)
})

import { beforeAll, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { buildRenderPlan } from '@shared/render/plan'
import { bakeForExport, type Bakers } from '@shared/render/exportBake'
import { emptyProject, type MediaAsset, type Project } from '@shared/timeline'
import type { MusicAnalysis } from '@shared/automation/cutPlan'
import { segmentIntoSentences } from '@shared/transcript'
import { buildSlots } from '@shared/director/menu'
import { FASHION, RECIPES } from '@shared/director/recipes'
import { rhythmGrid } from '@shared/director/rhythm'
import type { Menu2 } from '@shared/director/schema2'
import { validateSpine2 } from '@shared/director/validate2'
import { composeAd } from '@shared/director/compose'
import { applyRecipe } from '@shared/director/apply2'
import type { Brief } from '@shared/director/schema'
import { FFMPEG, makeClipWithTone, meanVolumeDb, outputDir, run, writeNote } from './output'

/*
 * A J-cut, heard in the export (docs/PLAN.md §5.5).
 *
 * A photo, then a clip that speaks (a 440 Hz tone with a transcript on it). The
 * Director lifts the clip's sound onto a dialogue lane and starts it a fifth of
 * a second before its picture: in the file, the 0.2 s before the cut carries
 * the tone at its own level and the 0.2 s before THAT is silent. When the clip
 * has no footage to lead with, the J-cut is refused and the cut is plain — the
 * same window is silent. The oracle is `volumedetect` over a span, the one the
 * mix checks already use.
 */

const fps = 30
const canvas = { width: 360, height: 640 }
let dir = ''

const brief: Brief = { product: 'Our day', benefit: '', audience: '', tone: 'calm', cta: '', seconds: 20, language: 'English' }

function song(bpm: number, seconds: number): MusicAnalysis {
  const beatMs = 60_000 / bpm
  const beats: number[] = []
  for (let t = 0; t <= seconds * 1000; t += beatMs) beats.push(Math.round(t))
  return { bpm, beats, downbeats: beats.filter((_, i) => i % 4 === 0), tiers: beats.map(() => 2), drops: [], buildups: [], sections: [], durationMs: seconds * 1000 }
}

async function still(file: string, colour: string): Promise<string> {
  await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${colour}:s=360x640`, '-frames:v', '1', file])
  return file
}

const bakers = (): Bakers => ({
  solid: async (spec, key, w, h) => {
    const file = join(dir, `${key}.png`)
    await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${spec.color.replace('#', '0x')}:s=${w}x${h}`, '-frames:v', '1', file])
    return file
  },
  text: async (_spec, key, w, h) => {
    const file = join(dir, `${key}.png`)
    await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=black@0:s=${w}x${h},format=rgba`, '-frames:v', '1', file])
    return file
  },
  textSequence: async () => null,
  title: async () => { throw new Error('no titles') },
  paper: async () => { throw new Error('no paper') },
  carousel: async () => { throw new Error('no carousel') }
})

/** Two photos and a speaking clip of `clipSeconds`; the Director's standard shots, applied and rendered. */
async function renderAd(name: string, clipSeconds: number): Promise<{ file: string; cut: number; notes: string[] }> {
  const media = join(dir, name)
  await mkdir(media, { recursive: true })
  const photo = (id: string, path: string): MediaAsset => ({ id, path, name: `${id}.png`, kind: 'image', durationFrames: 150, width: 360, height: 640, fps: null, hasVideo: true, hasAudio: false, size: 1 })
  const clipFile = await makeClipWithTone(join(media, 'talk.mp4'), 'blue', 440, canvas, clipSeconds, fps)
  const assets: MediaAsset[] = [
    photo('p1', await still(join(media, 'p1.png'), 'red')),
    photo('p2', await still(join(media, 'p2.png'), 'green')),
    { id: 'talk', path: clipFile, name: 'talk.mp4', kind: 'video', durationFrames: Math.round(clipSeconds * fps), width: 360, height: 640, fps, hasVideo: true, hasAudio: true, size: 1 }
  ]
  const words = [{ index: 0, text: 'We', startMs: 100, endMs: 400, confidence: 1 }, { index: 1, text: 'did.', startMs: 450, endMs: 900, confidence: 1 }]
  const empty = emptyProject()
  const p: Project = {
    ...empty,
    settings: { ...empty.settings, ...canvas, fps },
    assets,
    transcripts: { talk: { assetId: 'talk', language: 'en', model: 'm', durationMs: clipSeconds * 1000, words, segments: segmentIntoSentences(words) } }
  }
  const slots = buildSlots(p)
  const menu: Menu2 = { slots, recipes: [...RECIPES], fallback: FASHION, heroCandidates: ['slot_02'], fps, seconds: 20, bpm: 90, holds: { min: 2, max: 3 }, drops: [] }
  const shot = (slot: string, weight: 'quick' | 'normal' | 'hold') => ({ slot, role: 'story', weight, move: 'hold', speed: 'normal', headline: '', punch_word: '', why: 'x' })
  const checked = validateSpine2({ reasoning: 'r', recipe: 'fashion', hero: 'slot_02', style: 'clean', animation: 'fade', shots: [shot('slot_01', 'normal'), shot('slot_02', 'hold'), shot('slot_03', 'quick')] }, menu)
  if ('rejected' in checked) throw new Error(checked.rejected)
  const composed = composeAd(checked.plan, checked.recipe, menu, rhythmGrid(song(90, 20), { fps, seconds: 20, tempo: 90 }))
  const applied = applyRecipe(p, composed, menu, { fps, videoTrackId: 'v1', brief, model: 'm', catalogue: [], lookFile: null, newId: ((n) => (x: string) => `${x}-${++n}`)(0) })
  const baked = await bakeForExport(applied.project, canvas, bakers(), (clip, err) => { throw new Error(`${clip.id}: ${String(err)}`) })
  const file = join(dir, `${name}.mp4`)
  await run(FFMPEG, buildRenderPlan({ project: baked, outputPath: file, canvas }).args, { maxBuffer: 64 * 1024 * 1024 })
  const picture = applied.project.clips.find((c) => c.assetId === 'talk' && c.trackId === 'v1')!
  if (!picture) throw new Error(JSON.stringify({ shots: composed.layout.shots, dropped: composed.layout.dropped, notes: composed.layout.notes, problems: applied.problems, clips: applied.project.clips.map((c) => [c.assetId, c.trackId, c.start, c.duration]) }))
  return { file, cut: picture.start / fps, notes: applied.problems.map((x) => x.message) }
}

const lines: string[] = []

beforeAll(async () => {
  dir = await outputDir('jcut')
  lines.push('# jcut', '', 'A photo, a photo, then a clip that speaks (a 440 Hz tone). Levels by volumedetect over spans.', '')
}, 60_000)

describe('a J-cut', () => {
  it('is heard a fifth of a second before its picture, and silent before that', async () => {
    const { file, cut } = await renderAd('jcut', 4)
    const lead = await meanVolumeDb(file, cut - 0.2, 0.18)
    const before = await meanVolumeDb(file, cut - 0.45, 0.2)
    const body = await meanVolumeDb(file, cut + 0.5, 0.5)
    lines.push(`- J-cut: the picture cuts at ${cut.toFixed(2)} s; the 0.2 s before it ${lead.toFixed(1)} dB; before that ${before.toFixed(1)} dB; the clip itself ${body.toFixed(1)} dB`)
    expect(Math.abs(lead - body), 'the lead is the clip’s own level').toBeLessThan(3)
    expect(before).toBeLessThan(-60)
  }, 300_000)

  it('refused for a clip with no footage to lead with: a plain cut, silent up to the picture', async () => {
    // 0.8 s of footage, under Fashion's 3 s floor: its shot is all of it, so there is nothing to lead with.
    const { file, cut, notes } = await renderAd('plain', 0.8)
    const lead = await meanVolumeDb(file, cut - 0.2, 0.18)
    const body = await meanVolumeDb(file, cut + 0.2, 0.4)
    lines.push(`- refused (${notes.find((n) => /cuts in with its sound/.test(n)) ?? 'no note'}): the 0.2 s before the cut ${lead.toFixed(1)} dB; the clip ${body.toFixed(1)} dB`)
    await writeNote(dir, lines)
    expect(notes.join(' ')).toMatch(/no footage to lead with/)
    expect(lead).toBeLessThan(-60)
    expect(body).toBeGreaterThan(-40)
  }, 300_000)
})

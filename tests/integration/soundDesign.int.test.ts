import { beforeAll, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { mkdir } from 'node:fs/promises'
import type { MusicAnalysis } from '@shared/automation/cutPlan'
import { emptyProject, type Clip, type MediaAsset, type Project } from '@shared/timeline'
import { buildSlots } from '@shared/director/menu'
import { PRODUCT_REVEAL } from '@shared/director/recipes'
import { rhythmGrid } from '@shared/director/rhythm'
import type { Menu2 } from '@shared/director/schema2'
import { validateSpine2 } from '@shared/director/validate2'
import { baselineSpine2 } from '@shared/director/baseline2'
import { composeAd, type Composed } from '@shared/director/compose'
import { applyRecipe, type Applied2 } from '@shared/director/apply2'
import { SOUND_RULE } from '@shared/director/apply'
import type { SoundPack } from '@shared/director/soundRoles'
import type { Brief } from '@shared/director/schema'
import { DEFAULT_LOUDNESS } from '@shared/render/loudness'
import { measureSound } from '../../scripts/measure-sfx.mjs'
import { evalRenderPlan, renderEval } from '../eval/pipeline'
import { writeFile } from 'node:fs/promises'
import { FFMPEG, bandVolumeDb, meanVolumeDb, outputDir, peakLevelDb, run, writeNote } from './output'

/*
 * Sound design, rendered and listened to (docs/PLAN.md §6.4).
 *
 * A product reveal over a quiet tone: the recipe fires a riser and a sub on
 * the hero and silence before the black. The library is not in the
 * repository, so the pack is two sounds made here — a low thump that peaks at
 * its first frame and a noise that rises to its last — measured with the
 * same script that filled the real table. Read back with `volumedetect`: the
 * hero's first tenth of a second is well above the half-second before it (the
 * sub landed there, on top of the music, not ducked under it); the black is
 * silent; the end card has the music back; and the whole mix, through the
 * loudness pass, peaks under −1 dBFS. Runs on both builds — `adelay` without
 * `all`, `amix` without `normalize`.
 */

const fps = 30
const canvas = { width: 90, height: 160 }
const brief: Brief = { product: 'Aura serum', benefit: 'glow', audience: '', tone: 'premium', cta: 'Shop now', seconds: 12, language: 'English' }
let dir = ''
let pack: SoundPack = []
let applied: Applied2
let composed: Composed
let out = ''
let loud = ''
const lines: string[] = []

function song(bpm: number, seconds: number): MusicAnalysis {
  const beatMs = 60_000 / bpm
  const beats: number[] = []
  for (let t = 0; t <= seconds * 1000; t += beatMs) beats.push(Math.round(t))
  return { bpm, beats, downbeats: beats.filter((_, i) => i % 4 === 0), tiers: beats.map(() => 2), drops: [], buildups: [], sections: [], durationMs: seconds * 1000 }
}

async function lavfi(file: string, source: string, extra: string[] = []): Promise<string> {
  await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', source, ...extra, file])
  return file
}

/** A pack entry from a made file, measured as the real table is. */
async function packed(id: string, role: SoundPack[number]['role'], file: string): Promise<SoundPack[number]> {
  const m = await measureSound(file)
  return { id, name: `${id}.wav`, file, role, seconds: m.seconds, peakSeconds: m.peakSeconds, peakDb: m.peakDb }
}

beforeAll(async () => {
  dir = await outputDir('soundDesign')
  const media = join(dir, 'media')
  await mkdir(media, { recursive: true })
  // The bed: a tone twelve seconds long at −20 dBFS — `sine` generates at an eighth of full scale (measured: −18 dB),
  // so 0.8 of it is the level meant. Two grey stills to cut between.
  const music = await lavfi(join(media, 'bed.wav'), 'sine=frequency=220:duration=12:sample_rate=48000', ['-af', 'volume=0.8'])
  const still = async (name: string, colour: string): Promise<string> => lavfi(join(media, name), `color=c=${colour}:s=90x160`, ['-frames:v', '1'])
  const p1 = await still('p1.png', 'gray')
  const p2 = await still('p2.png', 'darkgray')
  // The pack: a thump that peaks at once and decays; pink noise rising over two seconds to its end.
  const sub = await lavfi(join(media, 'sub.wav'), 'sine=frequency=60:duration=0.5:sample_rate=48000', ['-af', 'afade=t=out:st=0.02:d=0.48'])
  const riser = await lavfi(join(media, 'riser.wav'), 'anoisesrc=d=2:c=pink:r=48000:a=0.5', ['-af', "volume=volume='0.02+0.98*t/2':eval=frame"])
  pack = [await packed('sub', 'sub', sub), await packed('riser', 'riser', riser)]

  const asset = (id: string, path: string, over: Partial<MediaAsset> = {}): MediaAsset => ({
    id, path, name: `${id}.png`, kind: 'image', durationFrames: 150, width: 90, height: 160, fps: null, hasVideo: true, hasAudio: false, size: 100, ...over
  })
  const musicClip: Clip = {
    id: 'music', assetId: 'song', trackId: 'a1', start: 0, duration: 12 * fps, inPoint: 0, volume: 1,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, color: { brightness: 0, contrast: 1, saturation: 1 }
  }
  const empty = emptyProject()
  // No loudness pass on the render the levels are read from: its gain ride would hide them (a first version read the bare music at −37 dB).
  const { loudness: _default, ...plainSettings } = empty.settings
  const project: Project = {
    ...empty,
    settings: { ...plainSettings, ...canvas, fps },
    assets: [asset('p1', p1), asset('p2', p2), asset('song', music, { name: 'bed.wav', kind: 'audio', width: null, height: null, hasVideo: false, hasAudio: true, durationFrames: 12 * fps })],
    clips: [musicClip]
  }
  const slots = buildSlots(project)
  // The hero is the second picture, so the riser has the first to rise over.
  const menu: Menu2 = { slots, recipes: [PRODUCT_REVEAL], fallback: PRODUCT_REVEAL, heroCandidates: [slots[1].id, slots[0].id], fps, seconds: 12, bpm: 100, holds: { min: 2, max: 2 }, drops: [] }
  const checked = validateSpine2(baselineSpine2(brief, menu, PRODUCT_REVEAL), menu)
  if ('rejected' in checked) throw new Error(checked.rejected)
  const grid = rhythmGrid(song(100, 12), { fps, seconds: 12, tempo: PRODUCT_REVEAL.tempo })
  composed = composeAd(checked.plan, checked.recipe, menu, grid)
  let n = 0
  applied = applyRecipe(project, composed, menu, { fps, videoTrackId: 'v1', brief, model: 'baseline', catalogue: [], musicClipId: 'music', sounds: pack, newId: (x) => `${x}-${++n}` })
  // Plain, for the levels against each other; and through the loudness pass, whose gain ride would hide them, for the peak.
  out = join(dir, 'ad.mp4')
  const plan = await evalRenderPlan(applied.project, out, { extraTransitions: [], canvas })
  await writeFile(join(dir, 'graph.txt'), plan.args.join(' ').replace(/;/g, ';\n'))
  await renderEval(applied.project, out, { extraTransitions: [], canvas })
  loud = join(dir, 'ad-loud.mp4')
  await renderEval({ ...applied.project, settings: { ...applied.project.settings, loudness: DEFAULT_LOUDNESS } }, loud, { extraTransitions: [], canvas })
}, 300_000)

describe('the sound design, rendered', () => {
  it('the sub lands on the hero over the music, the black is silent, the music returns on the end card, and nothing clips', async () => {
    const hero = composed.layout.shots.find((s) => s.hero)!
    const black = composed.layout.black!
    const endCard = composed.layout.endCard!
    const sounds = applied.project.clips.filter((c) => c.generatedBy?.rule === SOUND_RULE)
    expect(sounds.map((c) => c.generatedBy!.reason.split(' ')[0]).sort()).toEqual(['riser', 'sub'])

    const at = hero.startFrame / fps
    const sub = sounds.find((c) => c.generatedBy!.reason.startsWith('sub'))!
    // The music alone: after the sub has died away, before the black.
    const quietFrom = (sub.start + sub.duration) / fps + 0.5
    const quiet = await meanVolumeDb(out, quietFrom, Math.min(1, black.startFrame / fps - quietFrom - 0.2))
    const building = await meanVolumeDb(out, at - 0.5, 0.4)
    const onHit = await meanVolumeDb(out, at, 0.1)
    // The sub alone: under 120 Hz, where the 220 Hz music and the riser's pink noise barely reach — the riser peaks
    // on the same frame, so the plain level at the hero would read high with the sub missing altogether.
    const lowHit = await bandVolumeDb(out, at, 0.1, 'lowpass=f=120')
    const lowQuiet = await bandVolumeDb(out, quietFrom, Math.min(1, black.startFrame / fps - quietFrom - 0.2), 'lowpass=f=120')
    const inBlack = await meanVolumeDb(out, black.startFrame / fps + 0.2, (black.endFrame - black.startFrame) / fps - 0.3)
    const onCard = await meanVolumeDb(out, endCard.startFrame / fps + 0.3, 0.5)
    const peakPlain = await peakLevelDb(out, 0, endCard.endFrame / fps)
    const peakLoud = await peakLevelDb(loud, 0, endCard.endFrame / fps)
    lines.push(
      '# soundDesign', '',
      `A product reveal over a −20 dBFS tone, 12 s: hero at ${at.toFixed(2)} s, black ${(black.startFrame / fps).toFixed(2)}–${(black.endFrame / fps).toFixed(2)} s, end card to ${(endCard.endFrame / fps).toFixed(2)} s.`, '',
      `- pack: ${pack.map((f) => `${f.id} ${f.seconds.toFixed(2)} s, peak ${f.peakSeconds.toFixed(3)} s at ${f.peakDb.toFixed(1)} dB`).join('; ')}`,
      `- placed: ${sounds.map((c) => `${c.generatedBy!.reason} → frames ${c.start}–${c.start + c.duration}, volume ${c.volume.toFixed(2)}`).join('; ')}`,
      `- ad.mp4 (no loudness pass): the music alone from ${quietFrom.toFixed(2)} s: ${quiet.toFixed(1)} dB; the riser building, the 0.4 s before the hero: ${building.toFixed(1)} dB; the hero's first 0.1 s: ${onHit.toFixed(1)} dB`,
      `- under 120 Hz (the sub's band): the hero's first 0.1 s ${lowHit.toFixed(1)} dB against the music alone ${lowQuiet.toFixed(1)} dB`,
      `- inside the black: ${inBlack.toFixed(1)} dB; on the end card: ${onCard.toFixed(1)} dB; true peak ${peakPlain.toFixed(1)} dBFS (astats, floats)`,
      `- ad-loud.mp4 (through loudnorm at ${DEFAULT_LOUDNESS} LUFS): true peak ${peakLoud.toFixed(1)} dBFS`
    )
    await writeNote(dir, lines)

    // The riser is heard building into the hero; the hit lands on the hero's frame, well over the music alone —
    // and the SUB is there, not just the riser's peak: its band is far above the music's in that tenth of a second.
    expect(building - quiet).toBeGreaterThanOrEqual(3)
    expect(onHit - quiet).toBeGreaterThanOrEqual(6)
    expect(lowHit - lowQuiet).toBeGreaterThanOrEqual(12)
    // The silence reaches nothing before the black is a fifth of a second old, and holds.
    expect(inBlack).toBeLessThan(-60)
    // The end card has the music back, at the music's own level.
    expect(Math.abs(onCard - quiet)).toBeLessThan(3)
    // Nothing clips; through the loudness pass the mix stays under its true-peak ceiling — read after the AAC
    // encode, which overshoots a limited peak by a few tenths of a dB, so the line is drawn half a dB above it.
    expect(peakPlain).toBeLessThanOrEqual(0)
    expect(peakLoud).toBeLessThanOrEqual(-0.5)
  }, 300_000)
})

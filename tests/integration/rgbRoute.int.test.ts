import { describe, it, expect, beforeAll } from 'vitest'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { buildRenderPlan } from '@shared/render/plan'
import { emptyProject, type Clip, type MediaAsset, type Project } from '@shared/timeline'
import { FFMPEG, run, outputDir, pixelAt, writeNote, keyScale } from './output'

/*
 * An RGB filter that changes nothing must change nothing.
 *
 * ffmpeg converts a yuva420p stream to packed `rgba` for colorchannelmixer,
 * curves, lut3d and despill, and that route loses about two levels — measured,
 * a mid grey through a mixer set to 1,1,1 came out 124 from 126, and on the
 * Windows build every white balance 3–4 levels under its gains. The plan now
 * runs them on planar `gbrap`, which is exact. White balance's own check
 * allows 5 levels for chroma rounding, so it could never see two; this one
 * asks for 1, of settings that should be invisible.
 */

const W = 160
const H = 90
let dir = ''
let grey = ''
let cube = ''

beforeAll(async () => {
  dir = await outputDir('rgb-route')
  grey = join(dir, 'source-grey.png')
  await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=0x808080:s=${W}x${H}:d=1`, '-frames:v', '1', grey])
  cube = join(dir, 'identity.cube')
  await writeFile(cube, 'LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n')
  await writeNote(dir, ['A grey through settings that should leave it alone: each must read within 1 level of the untouched grey.'])
}, 60_000)

function project(over: Partial<Clip>): Project {
  const asset: MediaAsset = { id: 'g', path: grey, name: 'g', kind: 'image', durationFrames: 30, width: W, height: H, fps: null, hasVideo: true, hasAudio: false, size: 1 }
  const clip: Clip = {
    id: 'c', assetId: 'g', trackId: 'v1', start: 0, duration: 10, inPoint: 0, volume: 1,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    color: { brightness: 0, contrast: 1, saturation: 1 },
    ...over
  }
  return { ...emptyProject(), settings: { ...emptyProject().settings, width: W, height: H, fps: 30 }, assets: [asset], clips: [clip] }
}

async function centre(p: Project, name: string): Promise<number[]> {
  const file = join(dir, `${name}.mp4`)
  await run(FFMPEG, buildRenderPlan({ project: p, outputPath: file, keyScale: await keyScale() }).args, { maxBuffer: 32 * 1024 * 1024 })
  return pixelAt(file, 0.1, W / 2, H / 2, { width: W, height: H })
}

const neutral = { brightness: 0, contrast: 1, saturation: 1 }

describe('an RGB filter that changes nothing, changes nothing', () => {
  it('holds a grey to within a level through each of them', async () => {
    const base = await centre(project({}), 'untouched')
    const cases: [string, Partial<Clip>][] = [
      ['a balance too small to see', { color: { ...neutral, temperature: 0.0001 } }],
      ['an identity curve', { color: { ...neutral, curves: { master: [{ x: 0, y: 0 }, { x: 0.5, y: 0.5001 }, { x: 1, y: 1 }] } } }],
      ['an identity look', { color: { ...neutral, lut: { file: cube, intensity: 1 } } }],
      ['an identity look at half strength', { color: { ...neutral, lut: { file: cube, intensity: 0.5 } } }],
      ['all but full opacity', { transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 0.999 } }],
      ['despill on a grey, which has no spill', { key: { color: '#00ff00', similarity: 0.01, blend: 0, despill: 1 } }]
    ]
    const rows: string[] = [`untouched ${base.join(',')}`]
    let worst = 0
    for (const [name, over] of cases) {
      const got = await centre(project(over), name.replace(/\W+/g, '-'))
      rows.push(`${name}: ${got.join(',')}`)
      for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(got[c] - base[c]))
    }
    expect(worst, rows.join(' | ')).toBeLessThanOrEqual(1)
  }, 300_000)
})

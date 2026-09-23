import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  DEFAULT_KEY,
  KEY_SCALES,
  chromakeyFilter,
  keyProbeAlpha,
  keyProbeArgs,
  keyScaleFromProbe
} from '@shared/render/chromaKey'
import { buildRenderPlan } from '@shared/render/plan'
import { emptyProject, type Clip, type MediaAsset, type Project } from '@shared/timeline'

/*
 * The two ffmpegs key at different distances (render/chromaKey.ts).
 *
 * Found by CI: the 2018 Windows build measures a key's distance √2 larger than
 * the macOS build, so the same Similarity keyed less there. The app probes the
 * binary it is running and scales Similarity and Soften to match the model.
 * The probe itself is rendered on both builds by integration/chromaKey.int.
 */

describe('reading the probe', () => {
  it('names the newer formula from its alpha, and the 2018 one from its', () => {
    expect(keyScaleFromProbe(94)).toBe(1)
    expect(keyScaleFromProbe(186)).toBe(Math.SQRT2)
    // A level or two of rounding either way does not change the answer.
    expect(keyScaleFromProbe(99)).toBe(1)
    expect(keyScaleFromProbe(181)).toBe(Math.SQRT2)
    expect(KEY_SCALES).toEqual([1, Math.SQRT2])
  })

  it('reads the alpha from the middle of the yuva420p patch, or nothing from a short answer', () => {
    const bytes = new Uint8Array(16 * 16 + 2 * 8 * 8 + 16 * 16)
    bytes[16 * 16 + 2 * 8 * 8 + 8 * 16 + 8] = 186
    expect(keyProbeAlpha(bytes)).toBe(186)
    expect(keyProbeAlpha(new Uint8Array(100))).toBeNull()
  })

  it('keys one patch through the export’s own filter, unscaled', () => {
    const args = keyProbeArgs()
    expect(args).toContain('color=c=0x00e000:s=16x16:d=1')
    expect(args.join(' ')).toContain('chromakey=color=0x00ff00:similarity=0.0500:blend=0.1000')
    expect(args.slice(-3)).toEqual(['-pix_fmt', 'yuva420p', '-'])
  })
})

describe('the scaled key', () => {
  it('multiplies similarity and blend, both distances, by the scale', () => {
    expect(chromakeyFilter(DEFAULT_KEY, Math.SQRT2)).toBe('chromakey=color=0x00b140:similarity=0.1697:blend=0.1131')
    expect(chromakeyFilter(DEFAULT_KEY)).toBe('chromakey=color=0x00b140:similarity=0.1200:blend=0.0800')
    // Nonsense is the model's own scale.
    expect(chromakeyFilter(DEFAULT_KEY, Number.NaN)).toBe(chromakeyFilter(DEFAULT_KEY))
    expect(chromakeyFilter(DEFAULT_KEY, 0)).toBe(chromakeyFilter(DEFAULT_KEY))
  })

  it('reaches the export graph', () => {
    const asset: MediaAsset = { id: 'a', path: '/a.png', name: 'a', kind: 'image', durationFrames: 30, width: 320, height: 180, fps: null, hasVideo: true, hasAudio: false, size: 1 }
    const clip: Clip = {
      id: 'c', assetId: 'a', trackId: 'v1', start: 0, duration: 15, inPoint: 0, volume: 1,
      transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
      color: { brightness: 0, contrast: 1, saturation: 1 },
      key: DEFAULT_KEY
    }
    const p: Project = { ...emptyProject(), settings: { ...emptyProject().settings, width: 320, height: 180, fps: 30 }, assets: [asset], clips: [clip] }
    const args = buildRenderPlan({ project: p, outputPath: '/o.mp4', keyScale: Math.SQRT2 }).args
    expect(args[args.indexOf('-filter_complex') + 1]).toContain('similarity=0.1697:blend=0.1131')
  })
})

describe('the export asks the probe', () => {
  it('passes the measured scale into every export that keys', () => {
    const ipc = readFileSync(resolve(__dirname, '../src/main/ipc.ts'), 'utf8')
    expect(ipc).toContain('keyScale: request.project.clips.some((c) => c.key) ? await keyDistanceScale() : undefined')
    const job = readFileSync(resolve(__dirname, '../src/main/render/renderJob.ts'), 'utf8')
    expect(job).toContain('keyScale?: number')
    expect(job).toContain('buildRenderPlan(options as RenderRequest)')
  })
})

/* ------------------------------------------------ the main-process probe */

const child = vi.hoisted(() => ({ answer: [] as (Uint8Array | null)[], calls: 0 }))
vi.mock('node:child_process', () => ({
  execFile: (_file: string, _args: string[], _opts: unknown, done: (e: Error | null, out: Uint8Array) => void) => {
    child.calls++
    const next = child.answer.shift() ?? null
    if (next) done(null, next)
    else done(new Error('ffmpeg exited 1'), new Uint8Array())
  }
}))

const patch = (alpha: number): Uint8Array => {
  const bytes = new Uint8Array(16 * 16 + 2 * 8 * 8 + 16 * 16)
  bytes.fill(alpha, 16 * 16 + 2 * 8 * 8)
  return bytes
}

describe('the probe in the main process', () => {
  beforeEach(() => {
    vi.resetModules()
    child.answer = []
    child.calls = 0
  })

  it('answers √2 for the 2018 build and asks only once', async () => {
    child.answer = [patch(186)]
    const { keyDistanceScale } = await import('../src/main/render/keyScale')
    expect(await keyDistanceScale()).toBe(Math.SQRT2)
    expect(await keyDistanceScale()).toBe(Math.SQRT2)
    expect(child.calls).toBe(1)
  })

  it('answers the model’s scale when it could not run — and asks again next time', async () => {
    child.answer = [null, patch(94)]
    const { keyDistanceScale } = await import('../src/main/render/keyScale')
    expect(await keyDistanceScale()).toBe(1)
    expect(await keyDistanceScale()).toBe(1)
    expect(child.calls).toBe(2)
  })
})

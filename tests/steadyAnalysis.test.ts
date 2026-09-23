import { describe, it, expect, vi, beforeEach } from 'vitest'
import { emptyProject, type Clip, type MediaAsset, type Project } from '@shared/timeline'

/*
 * The main process's Steady analysis, with ffmpeg and the disk faked — the
 * branches a machine that HAS vidstab never takes: no vidstab, a listing that
 * could not be read, an analysis already on disk, an analysis that failed.
 * integration/steady.int.test.ts runs the real thing where vidstab exists.
 */

const fake = vi.hoisted(() => ({
  listing: [] as (string | null)[],
  listed: 0,
  onDisk: new Set<string>(),
  analyses: [] as string[],
  failNext: false
}))

vi.mock('node:child_process', () => ({
  execFile: (_file: string, _args: string[], _opts: unknown, done: (e: Error | null, out: string) => void) => {
    fake.listed++
    const next = fake.listing.shift() ?? null
    if (next === null) done(new Error('ffmpeg would not start'), '')
    else done(null, next)
  }
}))
vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>()),
  mkdir: vi.fn(async () => undefined),
  stat: vi.fn(async (path: string) => {
    if (fake.onDisk.has(path)) return { size: 1000 }
    throw new Error('ENOENT')
  })
}))
vi.mock('../src/main/ffmpeg/run', async (original) => {
  const real = await original<typeof import('../src/main/ffmpeg/run')>()
  return {
    ...real,
    runFfmpeg: (options: { outputPath: string }) => {
      fake.analyses.push(options.outputPath)
      const fail = fake.failNext
      fake.failNext = false
      return { promise: fail ? Promise.reject(new Error('Invalid data')) : Promise.resolve(), cancel: () => undefined }
    }
  }
})

const WITH = ' ... vidstabdetect  V->V  x\n ... vidstabtransform  V->V  y\n ... deshake  V->V  z\n'
const WITHOUT = ' ... deshake  V->V  z\n'

function project(clips: Partial<Clip>[]): Project {
  const asset: MediaAsset = { id: 'v', path: '/f/v.mp4', name: 'v', kind: 'video', durationFrames: 300, width: 640, height: 360, fps: 30, hasVideo: true, hasAudio: false, size: 9 }
  return {
    ...emptyProject(),
    assets: [asset],
    clips: clips.map((c, i) => ({
      id: `c${i}`, assetId: 'v', trackId: 'v1', start: i * 60, duration: 60, inPoint: i * 60, volume: 1,
      transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
      color: { brightness: 0, contrast: 1, saturation: 1 },
      steady: true,
      ...c
    }))
  }
}

beforeEach(() => {
  vi.resetModules()
  fake.listing = []
  fake.listed = 0
  fake.onDisk = new Set()
  fake.analyses = []
  fake.failNext = false
})

describe('which stabiliser the machine has', () => {
  it('asks once, and answers no for a build without vidstab', async () => {
    fake.listing = [WITHOUT]
    const { probeVidstab } = await import('../src/main/render/steady')
    expect(await probeVidstab()).toBe(false)
    expect(await probeVidstab()).toBe(false)
    expect(fake.listed).toBe(1)
  })

  it('answers no when the listing could not be read — and asks again next time', async () => {
    fake.listing = [null, WITH]
    const { probeVidstab } = await import('../src/main/render/steady')
    expect(await probeVidstab()).toBe(false)
    expect(await probeVidstab()).toBe(true)
    expect(fake.listed).toBe(2)
  })
})

describe('the analysis before an export', () => {
  it('without vidstab, every steady clip is steadied with deshake, and nothing is analysed', async () => {
    fake.listing = [WITHOUT]
    const { analyseSteady } = await import('../src/main/render/steady')
    const plans = await analyseSteady(project([{}, {}]), '/cache', () => undefined).promise
    expect(plans).toEqual({ c0: { kind: 'deshake' }, c1: { kind: 'deshake' } })
    expect(fake.analyses).toHaveLength(0)
  })

  it('analyses each steady clip once, and reuses what is already on disk', async () => {
    fake.listing = [WITH]
    const { analyseSteady, steadyFileName } = await import('../src/main/render/steady')
    const { steadyKey } = await import('@shared/render/steady')
    const p = project([{}, {}, { steady: undefined }])
    const kept = `/cache/${steadyFileName(steadyKey(p.clips[0], 60, p.assets[0], 30))}`
    fake.onDisk.add(kept)
    const plans = await analyseSteady(p, '/cache', () => undefined).promise
    // The first was on disk; only the second was analysed; the third is not steady.
    expect(fake.analyses).toHaveLength(1)
    expect(fake.analyses[0]).not.toBe(kept)
    expect(plans.c0).toEqual({ kind: 'vidstab', transforms: kept })
    expect(plans.c1).toEqual({ kind: 'vidstab', transforms: fake.analyses[0] })
    expect(plans.c2).toBeUndefined()
  })

  it('a clip whose analysis fails is steadied with deshake, not a failed export', async () => {
    fake.listing = [WITH]
    fake.failNext = true
    const { analyseSteady } = await import('../src/main/render/steady')
    const plans = await analyseSteady(project([{}, {}]), '/cache', () => undefined).promise
    expect(plans.c0).toEqual({ kind: 'deshake' })
    expect(plans.c1.kind).toBe('vidstab')
  })

  it('reports its progress through the clips, ending at the whole', async () => {
    fake.listing = [WITH]
    const { analyseSteady } = await import('../src/main/render/steady')
    const seen: number[] = []
    await analyseSteady(project([{}, {}]), '/cache', (f) => seen.push(f)).promise
    expect(seen.at(-1)).toBe(1)
    expect(seen).toContain(0.5)
  })
})

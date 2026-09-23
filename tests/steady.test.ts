import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { STEADY_SMOOTHING, canSteady, hasVidstab, steadyDetectFilter, steadyFilter, steadyKey } from '@shared/render/steady'
import { buildRenderPlan, videoInputArgs } from '@shared/render/plan'
import { emptyProject, type Clip, type MediaAsset, type Project } from '@shared/timeline'
import { steadyFileName } from '../src/main/render/steady'

/*
 * Steady (FIX.md B3): the rules, the filters, and the wiring.
 * tests/integration/steady.int.test.ts renders and measures it.
 */

const video: MediaAsset = { id: 'v', path: 'C:\\Footage\\Bride 5:30pm.mp4', name: 'v', kind: 'video', durationFrames: 300, width: 640, height: 360, fps: 30, hasVideo: true, hasAudio: false, size: 99 }

function clip(over: Partial<Clip> = {}): Clip {
  return {
    id: 'c', assetId: 'v', trackId: 'v1', start: 0, duration: 60, inPoint: 30, volume: 1,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    color: { brightness: 0, contrast: 1, saturation: 1 },
    ...over
  }
}

describe('what can be steadied', () => {
  it('footage, and nothing else', () => {
    expect(canSteady({}, video)).toBe(true)
    expect(canSteady({}, { ...video, kind: 'image' })).toBe(false)
    expect(canSteady({}, { ...video, frames: { pattern: 'f_%04d.png', count: 10 } } as MediaAsset)).toBe(false)
    expect(canSteady({}, { ...video, hasVideo: false })).toBe(false)
    expect(canSteady({}, undefined)).toBe(false)
    for (const drawn of [{ text: {} }, { title: {} }, { paper: {} }, { carousel: {} }, { solid: {} }, { adjustment: true }]) {
      expect(canSteady(drawn as Parameters<typeof canSteady>[0], video), JSON.stringify(drawn)).toBe(false)
    }
  })
})

describe('the filters', () => {
  it('analyses into a bare file name, so no drive colon reaches the parser', () => {
    expect(steadyDetectFilter('abc.trf')).toBe('vidstabdetect=result=abc.trf:shakiness=5:accuracy=15')
  })

  it('applies the analysis with the measured smoothing, zooming just enough to hide the edge', () => {
    const f = steadyFilter({ kind: 'vidstab', transforms: 'C:\\cache\\abc.trf' })
    expect(f).toContain(`smoothing=${STEADY_SMOOTHING}`)
    expect(f).toContain(':optzoom=1')
    // The drive letter's colon escaped for both parsers (captions/timeline.ts).
    expect(f).toContain('input=C\\\\:')
    expect(steadyFilter({ kind: 'deshake' })).toBe('deshake')
    expect(STEADY_SMOOTHING).toBe(30)
  })

  it('knows vidstab only when both halves are listed', () => {
    expect(hasVidstab(' ... vidstabdetect     V->V   x\n ... vidstabtransform  V->V   y\n')).toBe(true)
    expect(hasVidstab(' ... vidstabdetect     V->V   x\n')).toBe(false)
    expect(hasVidstab(' ... deshake  V->V  z\n')).toBe(false)
  })
})

describe('the analysis is for exactly the frames the export decodes', () => {
  it('names the file for the stretch of the file, so the same frames reuse it', () => {
    const a = steadyFileName(steadyKey(clip(), 60, video, 30))
    expect(a).toMatch(/^[0-9a-f]{24}\.trf$/)
    expect(steadyFileName(steadyKey(clip(), 60, video, 30))).toBe(a)
    expect(steadyFileName(steadyKey(clip({ inPoint: 31 }), 60, video, 30))).not.toBe(a)
    expect(steadyFileName(steadyKey(clip(), 61, video, 30))).not.toBe(a)
    expect(steadyFileName(steadyKey(clip(), 60, { ...video, size: 100 }, 30))).not.toBe(a)
  })

  it('the export and the analysis read the input with one function', () => {
    expect(videoInputArgs(clip({ speed: 2 }), video, 30)).toEqual(['-ss', '1.000000', '-t', '4.000000', '-i', video.path])
    const main = readFileSync(resolve(__dirname, '../src/main/render/steady.ts'), 'utf8')
    expect(main).toContain("args: [...videoInputArgs(clip, asset!, fps), '-vf', steadyDetectFilter(file), '-f', 'null', '-']")
    expect(main).toContain('cwd: dir')
  })
})

describe('the plan', () => {
  const project = (over: Partial<Clip>, steady?: Parameters<typeof buildRenderPlan>[0]['steady']): string => {
    const p: Project = { ...emptyProject(), settings: { ...emptyProject().settings, width: 320, height: 180, fps: 30 }, assets: [video], clips: [clip(over)] }
    const args = buildRenderPlan({ project: p, outputPath: '/o.mp4', steady }).args
    return args[args.indexOf('-filter_complex') + 1]
  }

  it('steadies first, on the decoded frames — before speed, crop and fit', () => {
    const graph = project({ steady: true, speed: 2, crop: { x: 10, y: 10, width: 300, height: 160 } }, { c: { kind: 'vidstab', transforms: '/cache/x.trf' } })
    const chain = graph.split(';').find((f) => f.startsWith('[0:v]'))!
    expect(chain.startsWith('[0:v]vidstabtransform=input=/cache/x.trf')).toBe(true)
    expect(chain.indexOf('vidstabtransform')).toBeLessThan(chain.indexOf('setpts'))
    expect(chain.indexOf('vidstabtransform')).toBeLessThan(chain.indexOf('crop='))
  })

  it('falls back to deshake for a steady clip it has no analysis for', () => {
    expect(project({ steady: true }).split(';').find((f) => f.startsWith('[0:v]'))!.startsWith('[0:v]deshake,')).toBe(true)
  })

  it('does nothing for a clip that is not steady', () => {
    expect(project({})).not.toMatch(/vidstab|deshake/)
  })
})

describe('the wiring', () => {
  const source = (path: string): string => readFileSync(resolve(__dirname, '..', path), 'utf8')

  it('the export job analyses first, then renders, one cancel for both', () => {
    const job = source('src/main/render/renderJob.ts')
    expect(job).toContain('const analysis = analyseSteady(options.project, options.steadyDir!, (f) => onProgress(f * ANALYSIS_SHARE, null))')
    expect(job).toContain('const render = run({ ...options, steady } as RenderRequest')
    expect(source('src/main/ipc.ts')).toContain("steadyDir: join(app.getPath('userData'), 'steady'),")
  })

  it('the Inspector offers Steady on footage only', () => {
    const inspector = source('src/renderer/src/components/Inspector.tsx')
    expect(inspector).toContain('{canSteady(clip, asset ?? undefined) && <SteadyToggle clip={clip} />}')
  })
})

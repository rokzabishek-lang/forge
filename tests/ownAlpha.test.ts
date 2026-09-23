import { describe, it, expect } from 'vitest'
import { buildRenderPlan } from '@shared/render/plan'
import { emptyProject, type Clip, type MediaAsset, type Project } from '@shared/timeline'

/*
 * The graph shapes behind tests/integration/gradeAlpha.int.test.ts and the
 * adjustment layer's look — cheap enough to run on every change, where the
 * renders are the proof that the shapes are right.
 */

function project(over: Partial<Clip>, extra: Clip[] = []): Project {
  const asset = (id: string): MediaAsset => ({
    id, path: `/m/${id}.mp4`, name: id, kind: 'video', durationFrames: 30, width: 240, height: 180,
    fps: 30, hasVideo: true, hasAudio: false, size: 1
  })
  const clip = (id: string, trackId: string, o: Partial<Clip> = {}): Clip => ({
    id, assetId: 'a', trackId, start: 0, duration: 15, inPoint: 0, volume: 1,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    color: { brightness: 0, contrast: 1, saturation: 1 }, ...o
  })
  return {
    ...emptyProject(),
    settings: { ...emptyProject().settings, width: 320, height: 180, fps: 30 },
    assets: [asset('a')],
    clips: [clip('bg', 'v1'), clip('top', 'v2', over), ...extra]
  }
}

const graphOf = (p: Project): string => {
  const args = buildRenderPlan({ project: p, outputPath: '/o.mp4' }).args
  return args[args.indexOf('-filter_complex') + 1]
}

describe('eq is handed back the alpha it drops', () => {
  it('lifts the alpha off before eq and merges it on after', () => {
    const graph = graphOf(project({ color: { brightness: 0.1, contrast: 1.1, saturation: 1.2 } }))
    expect(graph).toContain('split[qa1][qb1]')
    expect(graph).toContain('[qa1]format=yuva420p,alphaextract[ql1]')
    expect(graph).toMatch(/\[qb1\]eq=[^;]*\[qe1\]/)
    expect(graph).toContain('[qe1][ql1]alphamerge[qm1]')
  })

  it('runs every clip’s eq inside that wrap — at every site, not the first', () => {
    // Two graded clips, so there are two sites to get right.
    const graded = { color: { brightness: 0.1, contrast: 1, saturation: 1 } }
    const both = project(graded)
    const graph = graphOf({ ...both, clips: both.clips.map((c) => ({ ...c, ...graded })) })
    const sites = graph.split(';').filter((f) => f.includes('eq=brightness'))
    expect(sites.length).toBeGreaterThanOrEqual(2)
    for (const site of sites) expect(site, site).toMatch(/^\[qb\d+\]eq=/)
  })

  it('costs an ungraded clip nothing', () => {
    expect(graphOf(project({}))).not.toContain('alphaextract')
  })
})

describe('a keyframed opacity multiplies into the alpha that is there', () => {
  it('reads the pixel’s own alpha into its expression', () => {
    const keyframes = { opacity: [{ frame: 0, value: 0 }, { frame: 14, value: 1 }] } as Clip['keyframes']
    const graph = graphOf(project({ keyframes }))
    expect(graph).toMatch(/geq=r='r\(X,Y\)':g='g\(X,Y\)':b='b\(X,Y\)':a='alpha\(X,Y\)\*\(.+\)\/255'/)
  })
})

describe('an adjustment layer builds nothing on its own picture', () => {
  it('leaves no loose ends for its grade or its look — ffmpeg refuses a graph with one', () => {
    const adjust = {
      adjustment: true,
      color: { brightness: 0.2, contrast: 1, saturation: 1, lut: { file: '/l/x.cube', intensity: 0.5 } }
    }
    const graph = graphOf(project(adjust))
    // Its own input is never drawn, so nothing may be split or looked off it.
    expect(graph).not.toContain('[qa1]')
    expect(graph).not.toContain('[gs1]')
    // The grade and the look still reach the tracks below.
    expect(graph).toMatch(/\[o0\]eq=brightness=0\.200[^;]*enable=/)
    expect(graph).toContain('lut3d')
  })
})

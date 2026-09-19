import { describe, it, expect } from 'vitest'
import {
  audioFadeFilters,
  clipFades,
  defaultFadeFrames,
  hasFades,
  FADE_CURVE
} from '@shared/render/audioFade'
import { buildRenderPlan } from '@shared/render/plan'
import { emptyProject, type Clip, type MediaAsset, type Project } from '@shared/timeline'

const FPS = 30

function clip(over: Partial<Clip> = {}): Clip {
  return {
    id: 'c',
    assetId: 'a',
    trackId: 'a1',
    start: 0,
    duration: 300,
    inPoint: 0,
    volume: 1,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    color: { brightness: 0, contrast: 1, saturation: 1 },
    ...over
  }
}

describe('clipFades', () => {
  it('reads nothing when nothing is set', () => {
    expect(clipFades(clip())).toEqual({ in: 0, out: 0 })
    expect(hasFades(clip())).toBe(false)
  })

  it('refuses a fade longer than the clip', () => {
    expect(clipFades(clip({ duration: 60, fadeIn: 200 })).in).toBe(60)
  })

  it('makes two overlapping fades meet instead of overlapping', () => {
    /*
     * Not a hypothetical. Trim a clip down under fades that were already set
     * and the two walk through each other — `afade=out` would then start
     * before `afade=in` finished, and the clip would go quiet in the middle
     * and stay there rather than swelling once.
     */
    const fades = clipFades(clip({ duration: 100, fadeIn: 80, fadeOut: 60 }))
    expect(fades.in + fades.out).toBe(100)
    expect(fades.in).toBeGreaterThan(fades.out)
    expect(fades.in).toBeLessThan(80)
  })

  it('treats nonsense as no fade', () => {
    for (const bad of [-5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(clipFades(clip({ fadeIn: bad })).in).toBe(0)
    }
    expect(clipFades(clip({ duration: 0, fadeIn: 10 }))).toEqual({ in: 0, out: 0 })
  })
})

describe('audioFadeFilters', () => {
  it('emits nothing for a clip with no fades', () => {
    expect(audioFadeFilters(clip(), FPS)).toEqual([])
  })

  it('starts the fade-in at zero, in the clip’s own time', () => {
    const [filter] = audioFadeFilters(clip({ fadeIn: 45 }), FPS)
    expect(filter).toContain('t=in')
    expect(filter).toContain('st=0')
    expect(filter).toContain('d=1.5000')
  })

  it('places the fade-out so it ENDS at the end of the clip', () => {
    /*
     * The one arithmetic worth stating twice. `afade=out` is given where the
     * fade starts, not where it finishes, so a two-second fade on a ten-second
     * clip starts at eight. Getting this backwards gives a clip that is
     * already silent for its last eight seconds and sounds like the fade
     * length being ignored.
     */
    const [filter] = audioFadeFilters(clip({ duration: FPS * 10, fadeOut: FPS * 2 }), FPS)
    expect(filter).toContain('t=out')
    expect(filter).toContain('st=8.0000')
    expect(filter).toContain('d=2.0000')
  })

  it('emits the in before the out', () => {
    const filters = audioFadeFilters(clip({ fadeIn: 10, fadeOut: 10 }), FPS)
    expect(filters).toHaveLength(2)
    expect(filters[0]).toContain('t=in')
    expect(filters[1]).toContain('t=out')
  })

  it('uses a curve that the oldest bundled ffmpeg has', () => {
    /*
     * `curve` is an append-only enum in af_afade.c. `tri` is 0 and `qsin` is
     * 1, so both are from the filter's first commit in 2013; everything added
     * later sits higher (`ipar` 5, `iqsin` 12, `dese` 14, `losi` 16). The
     * Windows build is a master snapshot from 2018-12-17, which is the floor
     * this project actually has (CLAUDE.md), and anything numbered near the
     * top of that list is a coin flip against it.
     */
    expect(['tri', 'qsin']).toContain(FADE_CURVE)
    expect(audioFadeFilters(clip({ fadeIn: 10 }), FPS)[0]).toContain(`curve=${FADE_CURVE}`)
  })

  it('survives a frame rate of zero rather than dividing by it', () => {
    expect(audioFadeFilters(clip({ fadeIn: 10 }), 0)).toEqual([])
  })
})

describe('defaultFadeFrames', () => {
  it('is half a second at any frame rate', () => {
    expect(defaultFadeFrames(30)).toBe(15)
    expect(defaultFadeFrames(60)).toBe(30)
    expect(defaultFadeFrames(24)).toBe(12)
  })
})

/* -------------------------------------------------------- in the graph */

function project(over: Partial<Clip>): Project {
  const asset: MediaAsset = {
    id: 'a',
    path: '/tmp/tone.wav',
    name: 'tone.wav',
    kind: 'audio',
    durationFrames: 600,
    width: null,
    height: null,
    fps: null,
    hasVideo: false,
    hasAudio: true,
    size: 0
  }
  const still: MediaAsset = { ...asset, id: 'p', path: '/tmp/p.png', name: 'p.png', kind: 'image', hasVideo: true, hasAudio: false, width: 160, height: 120 }
  return {
    ...emptyProject(),
    settings: { width: 160, height: 120, fps: FPS, sampleRate: 48000 },
    assets: [still, asset],
    clips: [clip({ id: 'pic', assetId: 'p', trackId: 'v1' }), clip({ ...over, id: 'snd' })]
  }
}

describe('fades in the render plan', () => {
  it('puts the fade after the level and before the delay', () => {
    /*
     * Order is the whole correctness of this. AFTER the volume so a fade
     * multiplies whatever the envelope drew instead of replacing it; BEFORE
     * the delay because until `adelay` runs the clip's stream still starts at
     * zero, and `afade` is given an absolute time. A fade written after the
     * delay on a clip that starts a minute in would be handed a time a minute
     * too early — and a fade-out whose start lands past the end of the stream
     * does nothing at all, quietly.
     */
    const graph = buildRenderPlan({
      project: project({ start: FPS * 5, volume: 0.5, fadeIn: 15, fadeOut: 15 }),
      outputPath: '/tmp/x.mp4'
    }).args.join(' ')
    const chain = graph.split(';').find((part) => part.includes('afade')) ?? ''
    expect(chain).toContain('volume=0.5')
    expect(chain.indexOf('volume=0.5')).toBeLessThan(chain.indexOf('afade'))
    expect(chain.indexOf('afade')).toBeLessThan(chain.indexOf('adelay'))
    // Clip time, not timeline time: the clip starts at 5s and the fade does not.
    expect(chain).toContain('afade=t=in:st=0')
  })

  it('multiplies with a drawn envelope rather than replacing it', () => {
    const graph = buildRenderPlan({
      project: project({
        fadeIn: 15,
        keyframes: { volume: [{ frame: 0, value: 1, ease: 'linear' }, { frame: 300, value: 0.2, ease: 'linear' }] }
      }),
      outputPath: '/tmp/x.mp4'
    }).args.join(' ')
    expect(graph).toContain('eval=frame')
    expect(graph).toContain('afade=t=in')
  })

  it('leaves a clip with no fades off the afade path entirely', () => {
    const graph = buildRenderPlan({ project: project({}), outputPath: '/tmp/x.mp4' }).args.join(' ')
    expect(graph).not.toContain('afade')
  })
})

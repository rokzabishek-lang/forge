import { describe, it, expect } from 'vitest'
import {
  DEFAULT_LOUDNESS,
  LOUDNESS_TARGETS,
  TRUE_PEAK_CEILING,
  isLoudnessTarget,
  loudnessFilters
} from '@shared/render/loudness'
import { buildRenderPlan } from '@shared/render/plan'
import { DEFAULT_SETTINGS, emptyProject, type Clip, type MediaAsset, type Project } from '@shared/timeline'

const FPS = 30

function project(over: { loudness?: number; withAudio?: boolean } = {}): Project {
  const { loudness, withAudio = true } = over
  const still: MediaAsset = {
    id: 'p', path: '/tmp/p.png', name: 'p.png', kind: 'image', durationFrames: FPS * 4,
    width: 160, height: 120, fps: null, hasVideo: true, hasAudio: false, size: 0
  }
  const sound: MediaAsset = {
    id: 'a', path: '/tmp/a.wav', name: 'a.wav', kind: 'audio', durationFrames: FPS * 4,
    width: null, height: null, fps: null, hasVideo: false, hasAudio: true, size: 0
  }
  const base = {
    start: 0, duration: FPS * 4, inPoint: 0, volume: 1,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    color: { brightness: 0, contrast: 1, saturation: 1 }
  }
  const clips: Clip[] = [{ id: 'pic', assetId: 'p', trackId: 'v1', ...base }]
  if (withAudio) clips.push({ id: 'snd', assetId: 'a', trackId: 'a1', ...base })
  const settings = { width: 160, height: 120, fps: FPS, sampleRate: 48000 }
  return {
    ...emptyProject(),
    settings: loudness === undefined ? settings : { ...settings, loudness },
    assets: [still, sound],
    clips
  }
}

describe('loudnessFilters', () => {
  it('emits nothing when normalisation is off', () => {
    expect(loudnessFilters(undefined, 48000)).toEqual([])
  })

  it('aims at the target and leaves a decibel of true-peak headroom', () => {
    const [filter] = loudnessFilters(-14, 48000)
    expect(filter).toContain('loudnorm=I=-14')
    expect(filter).toContain(`TP=${TRUE_PEAK_CEILING}`)
    expect(TRUE_PEAK_CEILING).toBeLessThan(0)
  })

  it('always pins the sample rate back afterwards', () => {
    /*
     * Not cosmetic. `loudnorm` resamples internally and emits 192 kHz —
     * measured on this build, every time, whatever went in. Without this every
     * export's audio would be 192 kHz instead of the project's own rate, four
     * times the samples into the AAC encoder, and disagreeing with
     * `settings.sampleRate` everywhere else in the app that reads it.
     */
    const filters = loudnessFilters(-14, 44100)
    expect(filters).toHaveLength(2)
    expect(filters[1]).toContain('sample_rates=44100')
  })

  it('pins the channel layout in the same breath', () => {
    /*
     * `loudnorm` followed by a bare `aresample` fails outright — "Cannot
     * select channel layout for the link between filters" — because nothing
     * downstream can work out what came out of it. Measured; it is a render
     * failure, not a warning.
     */
    expect(loudnessFilters(-14, 48000)[1]).toContain('channel_layouts=stereo')
  })

  it('refuses a target that is not a loudness', () => {
    for (const bad of [0, -100, 5, Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
      expect(loudnessFilters(bad as number | undefined, 48000)).toEqual([])
      expect(isLoudnessTarget(bad)).toBe(false)
    }
    expect(isLoudnessTarget(-14)).toBe(true)
    expect(isLoudnessTarget(-23)).toBe(true)
  })

  it('refuses a nonsense sample rate rather than emitting one', () => {
    expect(loudnessFilters(-14, 0)).toEqual([])
    expect(loudnessFilters(-14, Number.NaN)).toEqual([])
  })

  it('offers targets that are all valid targets', () => {
    for (const target of LOUDNESS_TARGETS) expect(isLoudnessTarget(target.lufs)).toBe(true)
    expect(LOUDNESS_TARGETS.some((t) => t.lufs === DEFAULT_LOUDNESS)).toBe(true)
  })
})

describe('loudness in the render plan', () => {
  it('normalises the finished mix, not each clip', () => {
    /*
     * The measurement is of everything together. Normalising a clip before the
     * music joins it would target a number that stops being true the moment
     * anything else is added.
     */
    const graph = buildRenderPlan({ project: project({ loudness: -14 }), outputPath: '/tmp/x.mp4' })
      .args.join(' ')
    expect(graph).toContain('loudnorm=I=-14')
    // Exactly once, at the end, on the mix — not once per clip.
    expect(graph.match(/loudnorm/g)).toHaveLength(1)
    expect(graph.indexOf('loudnorm')).toBeGreaterThan(graph.indexOf('[amixed]'))
    expect(graph).toContain('[aout]')
  })

  it('leaves the graph untouched when it is off', () => {
    const graph = buildRenderPlan({ project: project(), outputPath: '/tmp/x.mp4' }).args.join(' ')
    expect(graph).not.toContain('loudnorm')
    expect(graph).not.toContain('[amixed]')
  })

  it('never normalises silence', () => {
    /*
     * `loudnorm` measures silence at -inf LUFS, so asking it for a finite
     * target is a request to amplify nothing by an unbounded amount. A project
     * with no audio at all takes the `anullsrc` branch and must stay on it.
     */
    const graph = buildRenderPlan({
      project: project({ loudness: -14, withAudio: false }),
      outputPath: '/tmp/x.mp4'
    }).args.join(' ')
    expect(graph).toContain('anullsrc')
    expect(graph).not.toContain('loudnorm')
  })

  it('normalises a single audio clip too, not just a mix', () => {
    // One clip takes `mixFilters`' `anull` shortcut, which is a different
    // branch and the one a simple project actually uses.
    const graph = buildRenderPlan({ project: project({ loudness: -23 }), outputPath: '/tmp/x.mp4' })
      .args.join(' ')
    expect(graph).toContain('loudnorm=I=-23')
  })
})

describe('the default', () => {
  it('is on for a new project', () => {
    expect(DEFAULT_SETTINGS.loudness).toBe(DEFAULT_LOUDNESS)
    expect(emptyProject().settings.loudness).toBe(DEFAULT_LOUDNESS)
  })

  it('stays off for a project saved before it existed', () => {
    /*
     * The asymmetry is the point. Two exports landing at different levels is
     * the thing being fixed, so the default has to be on — but switching it on
     * for a project someone has already finished would change how it sounds
     * with nothing on screen to say why.
     */
    const old = project()
    expect(old.settings.loudness).toBeUndefined()
    expect(buildRenderPlan({ project: old, outputPath: '/tmp/x.mp4' }).args.join(' '))
      .not.toContain('loudnorm')
  })
})

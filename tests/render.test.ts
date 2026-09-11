import { describe, it, expect } from 'vitest'
import { buildRenderPlan, RenderError } from '@shared/render/plan'
import { emptyProject, type Clip, type MediaAsset, type Project } from '@shared/timeline'

function asset(over: Partial<MediaAsset> = {}): MediaAsset {
  return {
    id: 'a1',
    path: '/media/talk.mp4',
    name: 'talk.mp4',
    kind: 'video',
    durationFrames: 3000,
    width: 1920,
    height: 1080,
    fps: 30,
    hasVideo: true,
    hasAudio: true,
    size: 1024,
    ...over
  }
}

function clip(over: Partial<Clip> = {}): Clip {
  return {
    id: 'c1',
    assetId: 'a1',
    trackId: 'v1',
    start: 0,
    duration: 90,
    inPoint: 300,
    volume: 1,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    color: { brightness: 0, contrast: 1, saturation: 1 },
    ...over
  }
}

function project(over: Partial<Project> = {}): Project {
  return { ...emptyProject(), assets: [asset()], clips: [clip()], ...over }
}

const argString = (args: string[]): string => args.join(' ')

describe('buildRenderPlan', () => {
  it('seeks the source with -ss before -i, using the clip in-point', () => {
    const plan = buildRenderPlan({ project: project(), outputPath: '/out.mp4' })
    const i = plan.args.indexOf('-i')
    // 300 frames at 30fps = 10s in, 90 frames = 3s long.
    expect(plan.args[i - 4]).toBe('-ss')
    expect(plan.args[i - 3]).toBe('10.000000')
    expect(plan.args[i - 2]).toBe('-t')
    expect(plan.args[i - 1]).toBe('3.000000')
  })

  it('reports the output duration in frames', () => {
    const plan = buildRenderPlan({
      project: project({ clips: [clip({ id: 'a', start: 0, duration: 90 }), clip({ id: 'b', start: 90, duration: 60 })] }),
      outputPath: '/out.mp4'
    })
    expect(plan.durationFrames).toBe(150)
  })

  it('emits the crop filter before the scale, in source pixels', () => {
    const plan = buildRenderPlan({
      project: project({ clips: [clip({ crop: { x: 420, y: 0, width: 1080, height: 1080 } })] }),
      outputPath: '/out.mp4'
    })
    const filters = argString(plan.args)
    expect(filters).toContain('crop=1080:1080:420:0')
    // Cropping after scaling would crop the wrong region entirely.
    expect(filters.indexOf('crop=')).toBeLessThan(filters.indexOf('scale='))
  })

  it('forces even crop dimensions for H.264', () => {
    const plan = buildRenderPlan({
      project: project({ clips: [clip({ crop: { x: 0, y: 0, width: 1081, height: 607 } })] }),
      outputPath: '/out.mp4'
    })
    expect(argString(plan.args)).toContain('crop=1082:608:0:0')
  })

  it('renders to an overridden canvas, so one edit exports at several aspects', () => {
    const plan = buildRenderPlan({
      project: project(),
      outputPath: '/out.mp4',
      canvas: { width: 1080, height: 1920 }
    })
    expect(argString(plan.args)).toContain('scale=1080:1920:force_original_aspect_ratio=decrease')
    expect(argString(plan.args)).toContain('pad=1080:1920')
  })

  it('substitutes silence when nothing in the timeline has audio', () => {
    const plan = buildRenderPlan({
      project: project({
        assets: [asset({ id: 'img', kind: 'image', hasAudio: false, path: '/media/p.jpg' })],
        clips: [clip({ assetId: 'img' })]
      }),
      outputPath: '/out.mp4'
    })
    // The output shape stays the same whether or not anything has audio, so
    // downstream tools never get a video-only file by surprise.
    expect(argString(plan.args)).toContain('anullsrc')
  })

  it('loops stills for their clip duration instead of emitting one frame', () => {
    const plan = buildRenderPlan({
      project: project({
        assets: [asset({ id: 'img', kind: 'image', hasAudio: false })],
        clips: [clip({ assetId: 'img', duration: 60 })]
      }),
      outputPath: '/out.mp4'
    })
    const args = argString(plan.args)
    expect(args).toContain('-loop 1')
    expect(args).toContain('-t 2.000000')
  })

  it('orders clips by timeline position, not array order', () => {
    const plan = buildRenderPlan({
      project: project({
        clips: [
          clip({ id: 'second', start: 90, duration: 30, inPoint: 0 }),
          clip({ id: 'first', start: 0, duration: 90, inPoint: 300 })
        ]
      }),
      outputPath: '/out.mp4'
    })
    expect(plan.clips.map((c) => c.clip.id)).toEqual(['first', 'second'])
  })

  it('offsets each clip to its timeline position with setpts', () => {
    const filters = argString(
      buildRenderPlan({
        project: project({ clips: [clip({ start: 90, duration: 30 })] }),
        outputPath: '/o.mp4'
      }).args
    )
    // 90 frames at 30fps = 3s. Without this every clip starts at zero.
    expect(filters).toContain('setpts=PTS-STARTPTS+3.000000/TB')
  })

  it('enables each overlay only for the clip\'s own window', () => {
    const filters = argString(
      buildRenderPlan({
        project: project({ clips: [clip({ start: 30, duration: 60 })] }),
        outputPath: '/o.mp4'
      }).args
    )
    expect(filters).toContain("enable='between(t,1.000000,3.000000)'")
    // The clip's last frame must not be held for the rest of the timeline.
    expect(filters).toContain('repeatlast=0')
  })

  it('generates a base canvas so gaps render black instead of shifting clips', () => {
    const filters = argString(
      buildRenderPlan({
        project: project({ clips: [clip({ start: 300, duration: 30 })] }),
        outputPath: '/o.mp4'
      }).args
    )
    expect(filters).toContain('color=c=black:s=1920x1080')
    expect(filters).toContain('[base]')
  })

  it('applies per-clip volume', () => {
    const plan = buildRenderPlan({
      project: project({ clips: [clip({ volume: 0.5 })] }),
      outputPath: '/out.mp4'
    })
    expect(argString(plan.args)).toContain('volume=0.5')
  })

  it('rejects a timeline with no clips', () => {
    expect(() => buildRenderPlan({ project: project({ clips: [] }), outputPath: '/o.mp4' })).toThrow(RenderError)
  })

  it('rejects a clip pointing at a missing asset', () => {
    expect(() =>
      buildRenderPlan({ project: project({ clips: [clip({ assetId: 'ghost' })] }), outputPath: '/o.mp4' })
    ).toThrow(/missing asset/)
  })
})


describe('audio track mixing', () => {
  const withMusic = (over: Partial<Clip> = {}): Project =>
    project({
      assets: [asset(), asset({ id: 'music', path: '/m/bgm.mp3', kind: 'audio', hasVideo: false })],
      clips: [
        clip({ id: 'v', trackId: 'v1', start: 0, duration: 90 }),
        clip({ id: 'm', trackId: 'a1', assetId: 'music', start: 30, duration: 60, inPoint: 0, ...over })
      ]
    })

  it('mixes an audio-track clip over the picture audio', () => {
    const filters = argString(buildRenderPlan({ project: withMusic(), outputPath: '/o.mp4' }).args)
    expect(filters).toContain('amix=inputs=2:duration=longest:normalize=0[aout]')
  })

  it('delays the clip to its timeline position', () => {
    const filters = argString(buildRenderPlan({ project: withMusic(), outputPath: '/o.mp4' }).args)
    // 30 frames at 30fps = 1000ms. Without adelay every clip stacks at zero.
    expect(filters).toContain('adelay=1000:all=1')
  })

  it('omits adelay for a clip that starts at zero', () => {
    const filters = argString(
      buildRenderPlan({ project: withMusic({ start: 0 }), outputPath: '/o.mp4' }).args
    )
    expect(filters).not.toContain('adelay')
  })

  it('applies volume to the music clip', () => {
    const filters = argString(
      buildRenderPlan({ project: withMusic({ volume: 0.3 }), outputPath: '/o.mp4' }).args
    )
    expect(filters).toContain('volume=0.3')
  })

  it('passes a single audio source straight through without a mixer', () => {
    const filters = argString(buildRenderPlan({ project: project(), outputPath: '/o.mp4' }).args)
    expect(filters).toContain('anull[aout]')
    expect(filters).not.toContain('amix')
  })

  it('skips muted audio tracks entirely', () => {
    const base = withMusic()
    const muted = {
      ...base,
      tracks: base.tracks.map((t) => (t.id === 'a1' ? { ...t, muted: true } : t))
    }
    const filters = argString(buildRenderPlan({ project: muted, outputPath: '/o.mp4' }).args)
    expect(filters).not.toContain('amix')
  })
})


describe('multi-track compositing', () => {
  const twoTracks = (over: Partial<Clip> = {}): Project => {
    const base = project()
    return {
      ...base,
      tracks: [
        { id: 'v1', kind: 'video', name: 'V1', muted: false, hidden: false, locked: false },
        { id: 'v2', kind: 'video', name: 'V2', muted: false, hidden: false, locked: false },
        { id: 'a1', kind: 'audio', name: 'A1', muted: false, hidden: false, locked: false }
      ],
      assets: [asset(), asset({ id: 'b', path: '/media/over.mp4' })],
      clips: [
        clip({ id: 'bottom', trackId: 'v1', start: 0, duration: 90 }),
        clip({ id: 'top', trackId: 'v2', assetId: 'b', start: 0, duration: 90, ...over })
      ]
    }
  }

  it('composites lower tracks first, so higher tracks land on top', () => {
    const plan = buildRenderPlan({ project: twoTracks(), outputPath: '/o.mp4' })
    // Render order is track order: v1 then v2.
    expect(plan.clips.map((c) => c.clip.id)).toEqual(['bottom', 'top'])

    const filters = argString(plan.args)
    // The chain runs base -> bottom -> top.
    expect(filters.indexOf('[v0]overlay')).toBeLessThan(filters.indexOf('[v1]overlay'))
  })

  it('chains an overlay per clip rather than concatenating', () => {
    const filters = argString(buildRenderPlan({ project: twoTracks(), outputPath: '/o.mp4' }).args)
    expect(filters.match(/overlay=/g)).toHaveLength(2)
    expect(filters).not.toContain('concat=')
  })

  it('skips hidden video tracks', () => {
    const base = twoTracks()
    const hidden = {
      ...base,
      tracks: base.tracks.map((t) => (t.id === 'v2' ? { ...t, hidden: true } : t))
    }
    const plan = buildRenderPlan({ project: hidden, outputPath: '/o.mp4' })
    expect(plan.clips.map((c) => c.clip.id)).toEqual(['bottom'])
  })

  it('mixes audio from clips on every video track', () => {
    const filters = argString(buildRenderPlan({ project: twoTracks(), outputPath: '/o.mp4' }).args)
    expect(filters).toContain('amix=inputs=2')
  })

  it('bounds the output to the timeline length', () => {
    const plan = buildRenderPlan({
      project: twoTracks({ duration: 150 }),
      outputPath: '/o.mp4'
    })
    // Longest clip ends at 150 frames = 5s.
    expect(plan.durationFrames).toBe(150)
    expect(plan.args).toContain('5.000000')
  })
})

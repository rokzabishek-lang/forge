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
    expect(filters).toContain("crop=w='min(1080,in_w)'")
    expect(filters).toContain("x='max(0,min(420,in_w-out_w))'")
    // Cropping after scaling would crop the wrong region entirely.
    expect(filters.indexOf('crop=')).toBeLessThan(filters.indexOf('scale='))
  })

  /*
   * The crop is emitted as EXPRESSIONS, not numbers.
   *
   * It used to be numbers, and a user's export died on
   *   Invalid too big or non positive size for width '3210' or height '1808'
   * because the dimensions were rounded to the NEAREST even number, which
   * rounds an odd number up — so a 3209-wide source was asked for 3210 pixels.
   * Swept over every realistic source size and all three aspects, HALF of them
   * produced a crop reaching outside the frame.
   *
   * Rounding down fixed that arithmetic, but not the other ways the app's idea
   * of a source's size can be wrong: rotation metadata the probe never reads, a
   * parallax plane composite that has already been scaled, a file re-exported
   * at a different resolution under the same path. `in_w`/`in_h` are measured
   * from what actually arrives, so the filter now clamps itself.
   */
  it('rounds crop dimensions DOWN to even, never up', () => {
    const plan = buildRenderPlan({
      project: project({ clips: [clip({ crop: { x: 0, y: 0, width: 1081, height: 607 } })] }),
      outputPath: '/out.mp4'
    })
    const args = argString(plan.args)
    expect(args).toContain('min(1080,in_w)')
    expect(args).toContain('min(606,in_h)')
    expect(args).not.toContain('1082')
    expect(args).not.toContain('608')
  })

  it('clamps itself against the real stream, not the believed size', () => {
    const plan = buildRenderPlan({
      project: project({ clips: [clip({ crop: { x: 0, y: 0, width: 1919, height: 1079 } })] }),
      outputPath: '/out.mp4'
    })
    const args = argString(plan.args)
    // Whatever number is asked for, in_w/in_h bound it at render time.
    expect(args).toMatch(/crop=w='min\(\d+,in_w\)':h='min\(\d+,in_h\)'/)
  })

  it('keeps an off-edge crop its size and slides it inside', () => {
    // Shrinking it instead would change the shape the user framed: a 400x400
    // square at x=1800 became a 120x80 sliver in the first version of this.
    const plan = buildRenderPlan({
      project: project({ clips: [clip({ crop: { x: 1800, y: 1000, width: 400, height: 400 } })] }),
      outputPath: '/out.mp4'
    })
    const args = argString(plan.args)
    expect(args).toContain('min(400,in_w)')
    expect(args).toContain('min(400,in_h)')
    // 1920-400 and 1080-400: the origin moved, the size did not.
    expect(args).toContain('min(1520,in_w-out_w)')
    expect(args).toContain('min(680,in_h-out_h)')
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

  it('mixes an audio-track clip over the picture audio at full level', () => {
    const filters = argString(buildRenderPlan({ project: withMusic(), outputPath: '/o.mp4' }).args)

    /*
     * Both streams reach the output, and neither is halved on the way.
     *
     * This used to assert `normalize=0`, which is the one-word way to say the
     * second half and is an ffmpeg 4.2 option the Windows build does not have.
     * So the test did not merely miss the bug — it required it. Asserting the
     * compensation rather than the spelling leaves the graph free to change
     * shape again when it has to.
     */
    expect(filters).toContain('amix=inputs=2:')
    expect(filters).toMatch(/amix=inputs=2:[^;]*\bvolume=2\[aout\]/)
    expect(filters).not.toMatch(/\bnormalize=/)
  })

  it('delays the clip to its timeline position', () => {
    const filters = argString(buildRenderPlan({ project: withMusic(), outputPath: '/o.mp4' }).args)
    // 30 frames at 30fps = 1000ms. Without adelay every clip stacks at zero.
    // Repeated per channel rather than `:all=1`, which the Windows ffmpeg does
    // not have. A bare `adelay=1000` would delay only the left channel.
    expect(filters).toContain('adelay=1000|1000|1000|1000|1000|1000|1000|1000')
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

  /*
   * A clip muted to zero is not an input.
   *
   * Mixing it is not WRONG — padding plus `volume=N` cancels amix's
   * renormalisation exactly, so silence in is silence out — which is why this
   * went unnoticed. The cost is that it decodes a stream and drags the audio
   * tail off the single-source `anull` path onto the full apad/atrim/amix
   * workaround, the branch carrying every 2018-ffmpeg compromise.
   *
   * Not a hypothetical: stickers land muted, and their `.colour.mp4` files DO
   * carry an aac stream (the `.matte.mp4` does not), so a timeline of stickers
   * made this the normal case rather than an edge one.
   */
  it('drops an audio-track clip muted to zero rather than mixing silence', () => {
    const filters = argString(
      buildRenderPlan({ project: withMusic({ volume: 0 }), outputPath: '/o.mp4' }).args
    )
    // Only the picture's audio is left, so no mixer at all.
    expect(filters).not.toContain('amix')
    expect(filters).toContain('anull[aout]')
  })

  it('drops the picture’s own audio when the clip is muted to zero', () => {
    const base = withMusic()
    const muted = {
      ...base,
      clips: base.clips.map((c) => (c.id === 'v' ? { ...c, volume: 0 } : c))
    }
    const filters = argString(buildRenderPlan({ project: muted, outputPath: '/o.mp4' }).args)
    // The guard sits inside addAudio, so picture audio and audio-track clips
    // cannot drift apart — this is the same rule as the test above, other side.
    expect(filters).not.toContain('[va0]')
    expect(filters).not.toContain('amix')
  })

  /*
   * A drawn envelope outranks the flat level, including when the flat level is
   * zero.
   *
   * Stickers land at `volume: 0` on purpose (store.ts — six of them at once is
   * six people talking), and the design is that you turn them back up. Through
   * the Sound row that works, because `setClipVolume` lifts the scalar off
   * zero. Through the envelope it did not: the keyframes were written without
   * touching `clip.volume`, so the mute guard threw the clip away before the
   * expression it had just built was ever used. Drawn curve on screen, silence
   * in the file.
   */
  it('keeps a clip muted flat but drawn back up by an envelope', () => {
    const filters = argString(
      buildRenderPlan({
        project: withMusic({
          volume: 0,
          keyframes: { volume: [{ frame: 0, value: 0 }, { frame: 30, value: 1 }] }
        }),
        outputPath: '/o.mp4'
      }).args
    )
    expect(filters).toContain('eval=frame')
    expect(filters).toContain('amix=inputs=2:')
  })

  it('still drops a flat-muted clip that has no envelope at all', () => {
    // The other side of the same rule: an empty track must not resurrect it.
    const filters = argString(
      buildRenderPlan({
        project: withMusic({ volume: 0, keyframes: { volume: [] } }),
        outputPath: '/o.mp4'
      }).args
    )
    expect(filters).not.toContain('amix')
    expect(filters).toContain('anull[aout]')
  })

  it('still mixes a clip that is merely quiet', () => {
    // The boundary the guard must not overshoot: 0.0001 is audible work.
    const filters = argString(
      buildRenderPlan({ project: withMusic({ volume: 0.0001 }), outputPath: '/o.mp4' }).args
    )
    expect(filters).toContain('volume=0.0001')
    expect(filters).toContain('amix=inputs=2:')
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

describe('ken burns motion', () => {
  const withMotion = (direction: 'in' | 'out'): Project =>
    project({
      assets: [asset({ id: 'img', kind: 'image', hasAudio: false, path: '/m/p.jpg' })],
      clips: [clip({ assetId: 'img', duration: 60, motion: { kind: 'kenburns', direction, amount: 0.12 } })]
    })

  it('uses zoompan, since crop cannot animate its dimensions', () => {
    const args = argString(buildRenderPlan({ project: withMotion('in'), outputPath: '/o.mp4' }).args)
    // crop evaluates w/h once at configuration; only zoompan animates per frame.
    expect(args).toContain('zoompan=')
    expect(args).toContain('d=60')
  })

  it('drives the move from the output frame index', () => {
    const args = argString(buildRenderPlan({ project: withMotion('in'), outputPath: '/o.mp4' }).args)
    expect(args).toContain('on/59')
  })

  it('pushes in and pulls out differently', () => {
    const push = argString(buildRenderPlan({ project: withMotion('in'), outputPath: '/o.mp4' }).args)
    const pull = argString(buildRenderPlan({ project: withMotion('out'), outputPath: '/o.mp4' }).args)
    expect(push).not.toBe(pull)
    expect(pull).toContain('*(1-on/')
  })

  it('runs motion before the fit, so the move is in source pixels', () => {
    const args = argString(buildRenderPlan({ project: withMotion('in'), outputPath: '/o.mp4' }).args)
    expect(args.indexOf('zoompan=')).toBeLessThan(args.indexOf('scale='))
  })

  it('adds nothing for a clip without motion', () => {
    const args = argString(buildRenderPlan({ project: project(), outputPath: '/o.mp4' }).args)
    expect(args).not.toContain('zoompan=')
  })
})

/*
 * Animated text.
 *
 * The editor draws the frames that MOVE and nothing else — a third of a second
 * of a three-second caption — so the render has to read a numbered sequence and
 * then hold its last frame for the rest of the clip. Everything downstream in
 * the graph assumes a stream of exactly `duration` frames, so the hold is not a
 * nicety; without it the caption would vanish part-way through.
 */
describe('a drawn animation', () => {
  const animated = (over: Partial<Clip> = {}): Project =>
    project({
      assets: [
        asset({
          id: 'txt',
          kind: 'image',
          hasAudio: false,
          path: '/titles/c.png',
          frames: { pattern: '/titles/c.seq/%05d.png', count: 12 }
        })
      ],
      clips: [clip({ assetId: 'txt', duration: 90, inPoint: 0, text: undefined, ...over })]
    })

  it('reads the sequence rather than the still', () => {
    const args = buildRenderPlan({ project: animated(), outputPath: '/o.mp4' }).args
    expect(args).toContain('/titles/c.seq/%05d.png')
    expect(args).not.toContain('/titles/c.png')
  })

  it('numbers the sequence from zero', () => {
    // image2 starts looking at 1 by default. A build that did not guess would
    // silently drop the first frame of every animation — the one that matters.
    const args = buildRenderPlan({ project: animated(), outputPath: '/o.mp4' }).args
    const i = args.indexOf('/titles/c.seq/%05d.png')
    expect(args.slice(0, i)).toContain('-start_number')
    expect(args[args.indexOf('-start_number') + 1]).toBe('0')
  })

  it('reads the frames at the project rate', () => {
    const args = buildRenderPlan({ project: animated(), outputPath: '/o.mp4' }).args
    const i = args.indexOf('/titles/c.seq/%05d.png')
    expect(args[i - 1]).toBe('-i')
    expect(args[i - 3]).toBe('-framerate')
    expect(args[i - 2]).toBe('30')
  })

  it('never loops a sequence — it is held, not repeated', () => {
    // -loop 1 would replay the movement over and over for the whole caption.
    const args = buildRenderPlan({ project: animated(), outputPath: '/o.mp4' }).args
    expect(args).not.toContain('-loop')
  })

  it('holds the last frame across the rest of the clip', () => {
    const args = argString(buildRenderPlan({ project: animated(), outputPath: '/o.mp4' }).args)
    expect(args).toContain('tpad=stop_mode=clone:stop_duration=3.000000')
    expect(args).toContain('trim=duration=3.000000')
  })

  it('holds before anything else reads the stream', () => {
    // Speed, motion, the fit and every transition read clip-relative time and
    // assume a full-length stream.
    const args = argString(buildRenderPlan({ project: animated(), outputPath: '/o.mp4' }).args)
    expect(args.indexOf('tpad=')).toBeLessThan(args.indexOf('scale='))
  })

  it('holds a matte shape too, or the hole closes part-way through', () => {
    // Footage seen through animated words: the shape is the sequence, and a
    // shape that ran out would leave the footage with no alpha at all.
    const shaped = project({
      assets: [
        asset({ id: 'a1' }),
        asset({
          id: 'txt',
          kind: 'image',
          hasAudio: false,
          path: '/titles/c.png',
          frames: { pattern: '/titles/c.seq/%05d.png', count: 12 }
        })
      ],
      clips: [
        clip({ id: 'shape', assetId: 'txt', duration: 90, inPoint: 0, matteOnly: true }),
        clip({ id: 'shot', duration: 90, matte: { clipId: 'shape' } })
      ]
    })
    const args = argString(buildRenderPlan({ project: shaped, outputPath: '/o.mp4' }).args)
    expect(args).toContain('tpad=stop_mode=clone:stop_duration=3.000000,trim')
    expect(args).toContain('format=gray')
  })

  it('leaves an ordinary still looping as it always did', () => {
    const still = project({
      assets: [asset({ id: 'img', kind: 'image', hasAudio: false, path: '/m/p.jpg' })],
      clips: [clip({ assetId: 'img', duration: 60 })]
    })
    const args = argString(buildRenderPlan({ project: still, outputPath: '/o.mp4' }).args)
    expect(args).toContain('-loop 1')
    expect(args).not.toContain('tpad=')
    expect(args).not.toContain('-start_number')
  })
})

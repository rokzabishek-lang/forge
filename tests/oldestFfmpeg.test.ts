import { describe, it, expect } from 'vitest'
import { buildRenderPlan } from '@shared/render/plan'
import { emptyProject, type Clip, type MediaAsset, type Project } from '@shared/timeline'

/*
 * Nothing in a filter graph may be newer than the OLDEST bundled ffmpeg.
 *
 * `@ffmpeg-installer` ships a different build per platform — 4.4 on macOS
 * arm64, 4.1-or-older on Windows — so an option added in 4.2 works perfectly
 * on the machine it is written on and kills every render on the machine it
 * ships to. That has now happened three times:
 *
 *     anullsrc  d=          4.2   every render died before a frame
 *     adelay    all=        4.2   and the naive fix was worse than the bug
 *     amix      normalize=  4.2   and the forum workaround is 6dB hot
 *
 * Each was found by a Windows CI run, which is a slow and expensive way to
 * learn it. This test fails on a Mac instead. It is a blocklist, so it cannot
 * catch something nobody has thought of — but each entry is a thing that has
 * either bitten us or is one autocomplete away from it, and the version beside
 * it is why. The real rule is in docs/EFFECTS.md §25.
 *
 * If ffmpeg is ever unified across platforms, delete this file rather than
 * maintaining it — the whole class of bug goes with it.
 */

/** Option or filter, the version it arrived in, and where it would tempt us. */
const TOO_NEW: { pattern: RegExp; since: string; why: string }[] = [
  { pattern: /\bnormalize=/, since: '4.2', why: 'amix — pad the inputs and scale by N instead' },
  { pattern: /\bweights=/, since: '4.2', why: 'amix — no pre-4.2 equivalent; mix in stages' },
  { pattern: /anullsrc[^;,]*\bd(uration)?=/, since: '4.2', why: 'bound the stream with -t' },
  { pattern: /\badelay=[^;,]*\ball=/, since: '4.2', why: 'repeat the delay once per channel' },
  { pattern: /\b(pad_dur|whole_dur)=/, since: '4.2', why: 'apad — follow it with atrim=end=' },
  { pattern: /\bxfade\b/, since: '4.3', why: 'the transition registry builds these by hand' },
  { pattern: /\bspeechnorm\b/, since: '4.3', why: 'dynaudnorm is the old one' },
  { pattern: /\b(colorize|exposure|dblur|shufflepixels|thistogram)\b/, since: '4.3', why: 'no' },
  { pattern: /\b(colorcorrect|colorcontrast|monochrome|estdif|adenorm)\b/, since: '4.4', why: 'no' },
  { pattern: /\b(asupercut|asubcut|asuperpass|asuperstop)\b/, since: '4.4', why: 'highpass/lowpass' }
]

const W = 640
const H = 360

function asset(id: string): MediaAsset {
  return {
    id, path: `/tmp/${id}.mp4`, name: `${id}.mp4`, kind: 'video',
    durationFrames: 300, width: W, height: H, fps: 30,
    hasVideo: true, hasAudio: true, size: 0
  }
}

function clip(over: Partial<Clip>): Clip {
  return {
    id: 'c', assetId: 'v', trackId: 'v1', start: 0, duration: 60, inPoint: 0, volume: 1,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    color: { brightness: 0, contrast: 1, saturation: 1 },
    ...over
  }
}

function project(over: Partial<Project>): Project {
  return {
    ...emptyProject(),
    settings: { width: W, height: H, fps: 30, sampleRate: 48000 },
    tracks: [
      { id: 'v1', kind: 'video', name: 'V1', muted: false, hidden: false, locked: false },
      { id: 'a1', kind: 'audio', name: 'A1', muted: false, hidden: false, locked: false, duck: true }
    ],
    assets: [asset('v'), asset('m')],
    ...over
  }
}

/** Every filter graph the plan builds for a project, as one string. */
function graphOf(p: Project): string {
  const args = buildRenderPlan({ project: p, outputPath: '/tmp/out.mp4' }).args
  const at = args.indexOf('-filter_complex')
  expect(at).toBeGreaterThan(-1)
  return args[at + 1]
}

/*
 * The shapes that between them reach every branch of the audio tail — which is
 * where all three bugs were, because it is the part that only appears once a
 * project has more than one of something.
 */
const SHAPES: { name: string; project: Project }[] = [
  {
    name: 'one clip, no mixing at all',
    project: project({ clips: [clip({ id: 'a' })] })
  },
  {
    name: 'two clips, so the dialogue mix appears',
    project: project({
      clips: [clip({ id: 'a' }), clip({ id: 'b', start: 60, duration: 30, inPoint: 150 })]
    })
  },
  {
    name: 'music under dialogue, so the duck and the final mix appear',
    project: project({
      clips: [
        clip({ id: 'a' }),
        clip({ id: 'b', start: 60, duration: 30, inPoint: 150 }),
        clip({ id: 'm', assetId: 'm', trackId: 'a1', start: 0, duration: 90 })
      ]
    })
  },
  {
    name: 'silent picture, which takes the anullsrc branch',
    project: project({
      assets: [{ ...asset('v'), hasAudio: false }],
      clips: [clip({ id: 'a' })]
    })
  }
]

describe('a filter graph runs on the oldest bundled ffmpeg', () => {
  for (const { name, project: p } of SHAPES) {
    it(`uses nothing newer than 4.1 — ${name}`, () => {
      const graph = graphOf(p)
      for (const { pattern, since, why } of TOO_NEW) {
        const hit = pattern.exec(graph)
        expect(
          hit,
          `"${hit?.[0]}" arrived in ffmpeg ${since}, which the Windows build predates — ${why}`
        ).toBeNull()
      }
    })
  }

  it('still mixes rather than silently dropping a stream', () => {
    /*
     * The guard above is satisfied by emitting no audio at all, so this pins
     * the thing it is guarding: three sources still reach one output, and the
     * amix that joins them still compensates for its own normalisation.
     */
    const graph = graphOf(SHAPES[2].project)
    expect(graph).toMatch(/amix=inputs=2:duration=longest:dropout_transition=0,volume=2/)
    expect(graph).toContain('apad,atrim=end=')
    expect(graph).toContain('sidechaincompress')
  })
})

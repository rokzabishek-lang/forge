import { describe, it, expect } from 'vitest'
import { buildRenderPlan } from '@shared/render/plan'
import { emptyProject, type Clip, type MediaAsset, type Project } from '@shared/timeline'

/*
 * Nothing in a filter graph may be newer than the OLDEST bundled ffmpeg.
 *
 * `@ffmpeg-installer` ships a different build per platform, and the Windows one
 * is not a release at all. `@ffmpeg-installer/win32-x64@4.1.0` declares
 * `"ffmpeg": "20181217-f22fcd4"` — a static nightly of ffmpeg MASTER taken on
 * **17 December 2018**, a week after the 4.1 branch point. (macOS arm64 is
 * `92718-g092cb17983`, which reports itself as 4.4.)
 *
 * So the real floor is a DATE, not a version: whatever was merged to master by
 * 2018-12-17. That distinction is not pedantry, and `tpad` is the proof —
 * it first appears in the 4.2 release, so "added in 4.2" says it cannot be
 * used, but it was merged on 30 October 2018 and is therefore present in the
 * Windows build. `holdFilter` has emitted it all along and Windows CI renders
 * fine. Judging by release number alone would have sent us rewriting working
 * code.
 *
 * It nearly did. `amix`'s `weights` was blocked here as "4.2 — no pre-4.2
 * equivalent", and both halves were wrong: the Windows build lists it
 * (`weights <string> ... (default "1 1")`) and renders it at equal and unequal
 * weights, and it IS the pre-4.2 equivalent the note said did not exist. It was
 * blocked by reading a release number; it was unblocked by running the binary.
 * If you reach for it to mix at unequal levels, it works — measure before
 * adding it back here.
 *
 * The rule that actually holds: an option works on Windows if it was MERGED
 * before 2018-12-17, whatever release first carried it. Three have not been:
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

/** Option or filter, the release it first shipped in, and what to use instead. */
const TOO_NEW: { pattern: RegExp; since: string; why: string }[] = [
  { pattern: /\bnormalize=/, since: '4.2', why: 'amix — pad the inputs and scale by N instead' },
  { pattern: /anullsrc[^;,]*\bd(uration)?=/, since: '4.2', why: 'bound the stream with -t' },
  { pattern: /\badelay=[^;,]*\ball=/, since: '4.2', why: 'repeat the delay once per channel' },
  { pattern: /\b(pad_dur|whole_dur)=/, since: '4.2', why: 'apad — follow it with atrim=end=' },
  { pattern: /\bxfade\b/, since: '4.3', why: 'the transition registry builds these by hand' },
  { pattern: /\bspeechnorm\b/, since: '4.3', why: 'dynaudnorm is the old one' },
  { pattern: /\b(colorize|exposure|dblur|shufflepixels|thistogram)\b/, since: '4.3', why: 'no' },
  { pattern: /\b(colorcorrect|colorcontrast|monochrome|estdif|adenorm)\b/, since: '4.4', why: 'no' },
  /*
   * Temperature and tint are the obvious reach for a white-balance slider,
   * and the macOS build HAS `colortemperature` — measured 2026-09-22 — which
   * is exactly how it would ship broken. It merged in January 2021. The
   * same slider is a 3×3 matrix on `colorchannelmixer` (2013), and the
   * preview's WebGL grade can apply the identical matrix. docs/FIX.md B3.
   */
  { pattern: /\bcolortemperature\b/, since: '4.4', why: 'colorchannelmixer with a temperature/tint matrix' },
  { pattern: /\b(asupercut|asubcut|asuperpass|asuperstop)\b/, since: '4.4', why: 'highpass/lowpass' },
  /*
   * `afade` itself is from 2013 and is safe. Its CURVE list is not uniformly
   * safe, and it is an unusually easy thing to reach for: the names sit in one
   * dropdown-looking list in `-h filter=afade`, and nothing about `losi`
   * announces that it is fifteen years newer than `tri`.
   *
   * The list is an append-only enum, so the index IS the age ordering. The
   * curves we use are `tri` (0) and `qsin` (1) — both from the filter's first
   * commit. These four are the top of the list on the 4.4 build here and are
   * not verified against the 2018-12-17 Windows snapshot; `sinc`/`isinc` are
   * plainly newer than it. If one of them is genuinely wanted, run it on
   * Windows CI first and move it out of this list with the measurement.
   */
  {
    pattern: /curve=(losi|nofade|sinc|isinc)\b/,
    since: 'unverified on the 2018 build',
    why: 'afade — tri and qsin are curve 0 and 1, from the original commit'
  }
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
function graphOf(p: Project, range?: { start: number; end: number }): string {
  const args = buildRenderPlan({ project: p, outputPath: '/tmp/out.mp4', range }).args
  const at = args.indexOf('-filter_complex')
  expect(at).toBeGreaterThan(-1)
  return args[at + 1]
}

/*
 * The shapes that between them reach every branch of the audio tail — which is
 * where all three bugs were, because it is the part that only appears once a
 * project has more than one of something.
 */
const SHAPES: { name: string; project: Project; range?: { start: number; end: number } }[] = [
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
  },
  {
    // B3's white balance: must stay colorchannelmixer (2013), never become
    // colortemperature (2021), which is on the blocklist above.
    name: 'a white balance on a clip',
    project: project({
      clips: [clip({ id: 'a', color: { brightness: 0, contrast: 1, saturation: 1, temperature: 0.6, tint: -0.2 } })]
    })
  },
  {
    // B3's chroma key with everything that meets it: despill, a graded `eq`
    // (wrapped to keep alpha), a turn and a keyframed fade (geq's alpha()).
    // chromakey is 2015 and despill 2017; the Windows CI renders prove it.
    name: 'a keyed, graded, turned clip with a keyframed fade',
    project: project({
      clips: [
        clip({
          id: 'a',
          key: { color: '#00b140', similarity: 0.12, blend: 0.08, despill: 0.6 },
          color: { brightness: 0.1, contrast: 1.1, saturation: 1.2 },
          transform: { x: 0, y: 0, scale: 0.9, rotation: 10, opacity: 1 },
          keyframes: { opacity: [{ frame: 0, value: 0 }, { frame: 30, value: 1 }] } as Clip['keyframes']
        })
      ]
    })
  },
  {
    // B3's moving mask: keyed curves in the mask's geq, held with st()/ld().
    name: 'a mask whose centre and size are keyed',
    project: project({
      clips: [
        clip({
          id: 'a',
          mask: { mode: 'reveal', blur: 0, shape: { kind: 'rectangle', x: 0.5, y: 0.5, width: 0.3, height: 0.3, rotation: 10, feather: 0.1, radius: 0.2, invert: false } },
          keyframes: {
            maskX: [{ frame: 0, value: 0.3 }, { frame: 30, value: 0.7 }],
            maskWidth: [{ frame: 0, value: 0.1 }, { frame: 30, value: 0.4, ease: 'smooth' }]
          }
        })
      ]
    })
  },
  {
    // B2's range export trims the finished picture and the finished mix; the
    // branch only exists with a range, so without this shape nothing checks it.
    name: 'a range export, so the picture and the mix are trimmed',
    project: project({
      clips: [
        clip({ id: 'a' }),
        clip({ id: 'b', start: 60, duration: 30, inPoint: 150 }),
        clip({ id: 'm', assetId: 'm', trackId: 'a1', start: 0, duration: 90 })
      ]
    }),
    range: { start: 20, end: 80 }
  }
]

describe('a filter graph runs on the oldest bundled ffmpeg', () => {
  for (const { name, project: p, range } of SHAPES) {
    it(`uses nothing merged after 2018-12-17 — ${name}`, () => {
      const graph = graphOf(p, range)
      for (const { pattern, since, why } of TOO_NEW) {
        const hit = pattern.exec(graph)
        expect(
          hit,
          `"${hit?.[0]}" first shipped in ffmpeg ${since}, and was merged after ` +
            `the Windows build's 2018-12-17 snapshot of master — ${why}`
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

  it('reaches the range trims, so the scan above is not of a graph without them', () => {
    const shape = SHAPES.find((s) => s.range)!
    const graph = graphOf(shape.project, shape.range)
    expect(graph).toContain('trim=start=')
    expect(graph).toContain('atrim=start=')
  })
})

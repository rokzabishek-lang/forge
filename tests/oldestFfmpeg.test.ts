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
    it(`uses nothing merged after 2018-12-17 — ${name}`, () => {
      const graph = graphOf(p)
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
})

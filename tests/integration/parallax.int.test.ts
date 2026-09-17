import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg'
import { buildRenderPlan } from '@shared/render/plan'
import {
  emptyProject,
  type Clip,
  type MediaAsset,
  type ParallaxBake,
  type Project
} from '@shared/timeline'

const run = promisify(execFile)
const FFMPEG = ffmpegInstaller.path
const W = 640
const H = 360
const PLANE_W = 800
const PLANE_H = 450

let dir = ''
let planes: string[] = []
let flat = ''

/**
 * Three synthetic planes standing in for a bake.
 *
 * Each carries a distinct marker at a known place so a rendered frame can be
 * interrogated for where that plane ended up — which is the only way to prove
 * the planes moved by *different* amounts rather than merely rendering.
 */
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'forge-px-'))

  // Back plane: opaque, so the composite is never transparent.
  const back = join(dir, 'plane0.png')
  await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=#202060:s=${PLANE_W}x${PLANE_H}`,
    '-frames:v', '1', back])

  /*
   * Two cutouts, placed EQUIDISTANT from the frame centre.
   *
   * Under a centred zoom a point's travel is its distance from the centre times
   * (zoom - 1), so a marker further out moves further whatever its depth. Put
   * the markers at different offsets and that geometry swamps the parallax the
   * test is trying to measure.
   */
  const MARKER = 60
  const cutouts = [
    { file: join(dir, 'plane1.png'), x: 150, colour: '#20a020' },
    { file: join(dir, 'plane2.png'), x: PLANE_W - MARKER - 150, colour: '#e04040' }
  ]
  for (const { file, x, colour } of cutouts) {
    await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', `color=c=black@0:s=${PLANE_W}x${PLANE_H},format=rgba`,
      '-f', 'lavfi', '-i', `color=c=${colour}:s=60x60`,
      '-filter_complex', `[0:v][1:v]overlay=${x}:195:format=auto`,
      '-frames:v', '1', file])
  }

  planes = [back, cutouts[0].file, cutouts[1].file]
  flat = join(dir, 'flat.png')
  await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=#202060:s=${PLANE_W}x${PLANE_H}`,
    '-frames:v', '1', flat])
}, 180_000)

afterAll(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => undefined)
})

function bake(over: Partial<ParallaxBake> = {}): ParallaxBake {
  return {
    width: PLANE_W,
    height: PLANE_H,
    separated: true,
    spread: 0.8,
    layers: [
      { file: planes[0], index: 0, depth: 0.05, coverage: 0.8 },
      { file: planes[1], index: 1, depth: 0.4, coverage: 0.1 },
      { file: planes[2], index: 2, depth: 0.95, coverage: 0.1 }
    ],
    ...over
  }
}

function parallaxProject(
  over: { bake?: ParallaxBake | null; extraClip?: boolean } = {}
): Project {
  const asset: MediaAsset = {
    id: 'img', path: flat, name: 'flat.png', kind: 'image', durationFrames: 90,
    width: PLANE_W, height: PLANE_H, fps: 30, hasVideo: true, hasAudio: false, size: 0
  }
  const clip: Clip = {
    id: 'c1', assetId: 'img', trackId: 'v1', start: 0, duration: 90, inPoint: 0, volume: 1,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    color: { brightness: 0, contrast: 1, saturation: 1 },
    motion: { kind: 'parallax', direction: 'in', amount: 0.3 }
  }
  const resolved = over.bake === undefined ? bake() : over.bake
  return {
    ...emptyProject(),
    settings: { width: W, height: H, fps: 30, sampleRate: 48000 },
    assets: [asset],
    clips: [clip],
    ...(resolved ? { parallax: { img: resolved } } : {})
  }
}

async function frameAt(file: string, seconds: number): Promise<Buffer> {
  const { stdout } = await run(
    FFMPEG,
    ['-hide_banner', '-loglevel', 'error', '-ss', String(seconds), '-i', file,
     '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
    { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 }
  )
  return stdout as unknown as Buffer
}

/** Horizontal centre of mass of pixels matching a colour, in canvas x. */
function centroidX(frame: Buffer, match: (r: number, g: number, b: number) => boolean): number | null {
  let total = 0
  let weighted = 0
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3
      if (match(frame[i], frame[i + 1], frame[i + 2])) {
        total++
        weighted += x
      }
    }
  }
  return total === 0 ? null : weighted / total
}

const isGreen = (r: number, g: number, b: number): boolean => g > 110 && r < 110 && b < 110
const isRed = (r: number, g: number, b: number): boolean => r > 150 && g < 110 && b < 110

describe('parallax rendering', () => {
  it('renders the planes as one composite', async () => {
    const out = join(dir, 'composite.mp4')
    const { stderr } = await run(
      FFMPEG,
      buildRenderPlan({ project: parallaxProject(), outputPath: out }).args,
      { maxBuffer: 16 * 1024 * 1024 }
    )
    expect(String(stderr)).not.toMatch(/Error when evaluating|Invalid|No such filter/i)

    const frame = await frameAt(out, 0.1)
    expect(frame.length).toBe(W * H * 3)
    // Both cutouts survived the composite — an overlay that dropped alpha would
    // leave only the topmost plane visible.
    expect(centroidX(frame, isGreen)).not.toBeNull()
    expect(centroidX(frame, isRed)).not.toBeNull()
  }, 180_000)

  /*
   * The whole point of the feature, stated as an assertion.
   *
   * A composite where every plane moved by the same amount would render, look
   * plausible, and be worth nothing — it is just a Ken Burns move with extra
   * inputs. So measure how far each marker actually travelled and require the
   * near one to have travelled further.
   */
  it('moves near planes further than far ones', async () => {
    const out = join(dir, 'rates.mp4')
    await run(FFMPEG, buildRenderPlan({ project: parallaxProject(), outputPath: out }).args, {
      maxBuffer: 16 * 1024 * 1024
    })

    const start = await frameAt(out, 0.1)
    const end = await frameAt(out, 2.8)

    const greenStart = centroidX(start, isGreen)
    const greenEnd = centroidX(end, isGreen)
    const redStart = centroidX(start, isRed)
    const redEnd = centroidX(end, isRed)
    expect(greenStart).not.toBeNull()
    expect(redStart).not.toBeNull()

    // Equidistant from the centre, so a push-in drives each outward by its own
    // plane's rate and nothing else.
    const nearTravel = Math.abs(redEnd! - redStart!)
    const midTravel = Math.abs(greenEnd! - greenStart!)
    // depth 0.95 vs 0.40 is a rate ratio of about 1.45 through planeAmount.
    expect(nearTravel).toBeGreaterThan(midTravel * 1.2)
  }, 180_000)

  it('falls back to a flat move when the photo would not separate', async () => {
    const out = join(dir, 'flatfall.mp4')
    const project = parallaxProject({ bake: bake({ separated: false }) })
    const plan = buildRenderPlan({ project, outputPath: out })

    // One input for the photo itself, not three for planes that will not be used.
    expect(plan.args.filter((a) => a === '-loop')).toHaveLength(1)
    const { stderr } = await run(FFMPEG, plan.args, { maxBuffer: 16 * 1024 * 1024 })
    expect(String(stderr)).not.toMatch(/Error|Invalid/i)
    expect((await frameAt(out, 1)).length).toBe(W * H * 3)
  }, 180_000)

  it('falls back when there is no bake at all', async () => {
    const out = join(dir, 'nobake.mp4')
    const plan = buildRenderPlan({ project: parallaxProject({ bake: null }), outputPath: out })
    expect(plan.args.filter((a) => a === '-loop')).toHaveLength(1)
    await run(FFMPEG, plan.args, { maxBuffer: 16 * 1024 * 1024 })
    expect((await frameAt(out, 1)).length).toBe(W * H * 3)
  }, 180_000)

  /*
   * A parallax clip consumes N inputs where a still consumes one. If the input
   * loop and the filter loop ever disagree about that, every input index after
   * it shifts and the render silently composites the wrong sources.
   */
  it('keeps input indices straight with a plain clip after a parallax one', async () => {
    const base = parallaxProject()
    const second: Clip = {
      ...base.clips[0],
      id: 'c2', start: 90, motion: { kind: 'kenburns', direction: 'out', amount: 0.2 }
    }
    const out = join(dir, 'mixed.mp4')
    const plan = buildRenderPlan({
      project: { ...base, clips: [base.clips[0], second] },
      outputPath: out
    })
    // Three planes plus one ordinary still.
    expect(plan.args.filter((a) => a === '-loop')).toHaveLength(4)

    const { stderr } = await run(FFMPEG, plan.args, { maxBuffer: 16 * 1024 * 1024 })
    expect(String(stderr)).not.toMatch(/Error|Invalid/i)
    // The second clip is a flat still: its frame must still fill the canvas.
    expect((await frameAt(out, 3.5)).length).toBe(W * H * 3)
  }, 180_000)
})

/*
 * Clip.transform existed from the first commit and was rendered by nothing.
 *
 * A 3D prop dropped onto a track filled the entire frame, and no control in the
 * app could shrink it, because scale/opacity/position were carried on every
 * clip and read by neither the renderer nor the preview. These assert on real
 * pixels, since "the argv contains scale=" would have passed for a filter that
 * did nothing.
 */
describe('clip transform', () => {
  function overlaid(transform: Partial<Clip['transform']>): Project {
    const base = parallaxProject({ bake: null })
    const marker: MediaAsset = {
      id: 'fx', path: planes[2], name: 'fx.png', kind: 'image', durationFrames: 90,
      width: PLANE_W, height: PLANE_H, fps: 30, hasVideo: true, hasAudio: false, size: 0
    }
    const flatClip: Clip = { ...base.clips[0], motion: undefined }
    const over: Clip = {
      ...flatClip, id: 'fx1', assetId: 'fx', trackId: 'v2', motion: undefined,
      transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, ...transform }
    }
    return {
      ...base,
      assets: [...base.assets, marker],
      clips: [flatClip, over]
    }
  }

  const redPixels = (frame: Buffer): number => {
    let n = 0
    for (let i = 0; i < frame.length; i += 3) {
      if (isRed(frame[i], frame[i + 1], frame[i + 2])) n++
    }
    return n
  }

  it('makes a clip smaller when scale is reduced', async () => {
    const big = join(dir, 'tf-big.mp4')
    const small = join(dir, 'tf-small.mp4')
    await run(FFMPEG, buildRenderPlan({ project: overlaid({}), outputPath: big }).args,
      { maxBuffer: 16 * 1024 * 1024 })
    await run(FFMPEG, buildRenderPlan({ project: overlaid({ scale: 0.4 }), outputPath: small }).args,
      { maxBuffer: 16 * 1024 * 1024 })

    const bigCount = redPixels(await frameAt(big, 1))
    const smallCount = redPixels(await frameAt(small, 1))
    expect(bigCount).toBeGreaterThan(0)
    expect(smallCount).toBeGreaterThan(0)
    // Area scales with the square of the factor, so 0.4 is well under half.
    expect(smallCount).toBeLessThan(bigCount * 0.5)
  }, 240_000)

  it('moves a clip when x is offset', async () => {
    const centre = join(dir, 'tf-centre.mp4')
    const right = join(dir, 'tf-right.mp4')
    await run(FFMPEG, buildRenderPlan({ project: overlaid({ scale: 0.4 }), outputPath: centre }).args,
      { maxBuffer: 16 * 1024 * 1024 })
    await run(FFMPEG,
      buildRenderPlan({ project: overlaid({ scale: 0.4, x: 0.5 }), outputPath: right }).args,
      { maxBuffer: 16 * 1024 * 1024 })

    const at = centroidX(await frameAt(centre, 1), isRed)
    const moved = centroidX(await frameAt(right, 1), isRed)
    expect(at).not.toBeNull()
    expect(moved).not.toBeNull()
    expect(moved!).toBeGreaterThan(at! + 40)
  }, 240_000)

  it('fades a clip when opacity is reduced', async () => {
    const solid = join(dir, 'tf-solid.mp4')
    const faded = join(dir, 'tf-faded.mp4')
    await run(FFMPEG, buildRenderPlan({ project: overlaid({ scale: 0.4 }), outputPath: solid }).args,
      { maxBuffer: 16 * 1024 * 1024 })
    await run(FFMPEG,
      buildRenderPlan({ project: overlaid({ scale: 0.4, opacity: 0.25 }), outputPath: faded }).args,
      { maxBuffer: 16 * 1024 * 1024 })

    // At a quarter opacity the marker blends into the backdrop and stops
    // reading as its own colour.
    expect(redPixels(await frameAt(faded, 1))).toBeLessThan(redPixels(await frameAt(solid, 1)) * 0.5)
  }, 240_000)

  it('leaves an untouched clip exactly as it was', async () => {
    // scale 1 / x 0 / y 0 must remain byte-for-byte the old full-frame fit, or
    // every project built before transform was implemented would shift.
    const plan = buildRenderPlan({ project: overlaid({}), outputPath: join(dir, 'tf-id.mp4') })
    const fc = plan.args[plan.args.indexOf('-filter_complex') + 1]
    expect(fc).not.toMatch(/colorchannelmixer/)
    expect(fc).not.toMatch(/rotate=/)
  }, 60_000)
})

describe('shake', () => {
  function shakeProject(motion: Extract<Clip['motion'], { kind: 'shake' }>): Project {
    const base = parallaxProject()
    return { ...base, clips: [{ ...base.clips[0], motion }] }
  }

  /*
   * A drop is an impact, not a vibration.
   *
   * Without a decay envelope the wobble ran for the whole shot — a rendered reel
   * shook for 2.23 continuous seconds, which reads as a fault rather than a hit.
   */
  it('dies away instead of rattling for the whole shot', async () => {
    const out = join(dir, 'shake-decay.mp4')
    // Anchored, so the planes are used and there is a marker to track. The
    // green plane is the one that takes the hit.
    await run(FFMPEG,
      buildRenderPlan({
        project: shakeProject({
          kind: 'shake', amount: 0.25, hz: 11, decay: 0.16, anchor: 'subject'
        }),
        outputPath: out
      }).args,
      { maxBuffer: 16 * 1024 * 1024 })

    const roam = async (times: number[]): Promise<number> => {
      const xs: number[] = []
      for (const t of times) {
        const x = centroidX(await frameAt(out, t), isGreen)
        if (x !== null) xs.push(x)
      }
      return xs.length < 2 ? 0 : Math.max(...xs) - Math.min(...xs)
    }

    const early = await roam([0.0, 0.02, 0.045, 0.07])
    const late = await roam([2.5, 2.52, 2.545, 2.57])
    expect(early).toBeGreaterThan(1)
    // Three time constants in, the impact is visually over.
    expect(late).toBeLessThan(early * 0.3)
  }, 240_000)

  /*
   * The whole point of anchoring: the subject holds while the world moves.
   *
   * A shake where every plane moved together would render, look plausible, and
   * be exactly the camera wobble this replaces.
   */
  it('holds the near plane and shakes the far one', async () => {
    const out = join(dir, 'shake-anchored.mp4')
    await run(FFMPEG,
      buildRenderPlan({
        project: shakeProject({ kind: 'shake', amount: 0.25, hz: 11, decay: 4, anchor: 'subject' }),
        outputPath: out
      }).args,
      { maxBuffer: 16 * 1024 * 1024 })

    // Sample across a full wobble cycle and measure how far each marker roamed.
    const spread = async (match: typeof isRed): Promise<number> => {
      const xs: number[] = []
      for (const t of [0.0, 0.02, 0.045, 0.07, 0.09]) {
        const x = centroidX(await frameAt(out, t), match)
        if (x !== null) xs.push(x)
      }
      return xs.length < 2 ? 0 : Math.max(...xs) - Math.min(...xs)
    }

    const near = await spread(isRed) // depth 0.95 — the subject
    const far = await spread(isGreen) // depth 0.40 — the scene
    expect(far).toBeGreaterThan(near * 1.5)
  }, 240_000)

  it('falls back to shaking the whole frame without a bake', async () => {
    const out = join(dir, 'shake-flat.mp4')
    const base = parallaxProject({ bake: null })
    const plan = buildRenderPlan({
      project: { ...base, clips: [{ ...base.clips[0], motion: { kind: 'shake', amount: 0.2, anchor: 'subject' } }] },
      outputPath: out
    })
    // One input, not three: an anchor with nothing to anchor is just a shake.
    expect(plan.args.filter((a) => a === '-loop')).toHaveLength(1)
    const { stderr } = await run(FFMPEG, plan.args, { maxBuffer: 16 * 1024 * 1024 })
    expect(String(stderr)).not.toMatch(/Error when evaluating|Invalid/i)
  }, 240_000)
})

/*
 * Keyframed position.
 *
 * Only position: `scale` with `eval=frame` re-evaluates but does not follow its
 * own expression — measured, a width that should have grown from 192px to 495px
 * shrank to 138px instead, the same trap as `crop` resolving w/h once. Overlay
 * x/y expressions are the one animation mechanism in the renderer that is known
 * to work, because the transition system already depends on them.
 */
describe('clip path', () => {
  function travelling(path: { frame: number; x: number; y: number }[]): Project {
    const base = parallaxProject({ bake: null })
    const marker: MediaAsset = {
      id: 'fx', path: planes[2], name: 'fx.png', kind: 'image', durationFrames: 90,
      width: PLANE_W, height: PLANE_H, fps: 30, hasVideo: true, hasAudio: false, size: 0
    }
    const flatClip: Clip = { ...base.clips[0], motion: undefined }
    const over: Clip = {
      ...flatClip, id: 'fx1', assetId: 'fx', trackId: 'v2', motion: undefined,
      transform: { x: 0, y: 0, scale: 0.4, rotation: 0, opacity: 1 },
      path
    }
    return { ...base, assets: [...base.assets, marker], clips: [flatClip, over] }
  }

  it('carries a clip across the frame', async () => {
    const out = join(dir, 'path-travel.mp4')
    await run(FFMPEG,
      buildRenderPlan({
        project: travelling([{ frame: 0, x: -0.5, y: 0 }, { frame: 89, x: 0.5, y: 0 }]),
        outputPath: out
      }).args,
      { maxBuffer: 16 * 1024 * 1024 })

    const start = centroidX(await frameAt(out, 0.05), isRed)
    const end = centroidX(await frameAt(out, 2.85), isRed)
    expect(start).not.toBeNull()
    expect(end).not.toBeNull()
    expect(end!).toBeGreaterThan(start! + 100)
  }, 240_000)

  it('holds still where the path does', async () => {
    const out = join(dir, 'path-hold.mp4')
    await run(FFMPEG,
      buildRenderPlan({
        project: travelling([{ frame: 0, x: 0.3, y: 0 }, { frame: 89, x: 0.3, y: 0 }]),
        outputPath: out
      }).args,
      { maxBuffer: 16 * 1024 * 1024 })
    const a = centroidX(await frameAt(out, 0.05), isRed)
    const b = centroidX(await frameAt(out, 2.85), isRed)
    expect(Math.abs(b! - a!)).toBeLessThan(3)
  }, 240_000)

  it('changes nothing for a clip with no path', async () => {
    const plan = buildRenderPlan({
      project: travelling([]),
      outputPath: join(dir, 'path-none.mp4')
    })
    const fc = plan.args[plan.args.indexOf('-filter_complex') + 1]
    expect(fc).not.toMatch(/if\(lt\(t,/)
  }, 60_000)
})

/*
 * Text behind the subject, proven in pixels.
 *
 * The claim is a compositing ORDER: background, then text, then the subject
 * cutout. A version that drew the text on top would render, look fine on a
 * photo with a small subject, and be exactly the effect this is not.
 */
describe('text behind subject', () => {
  const isYellow = (r: number, g: number, b: number): boolean => r > 150 && g > 150 && b < 110

  function scene(behind: boolean): Project {
    const base = parallaxProject()
    const banner: MediaAsset = {
      id: 'txt', path: join(dir, 'banner.png'), name: 'banner.png', kind: 'image',
      durationFrames: 90, width: PLANE_W, height: PLANE_H, fps: 30,
      hasVideo: true, hasAudio: false, size: 0
    }
    const common = {
      duration: 90, inPoint: 0, volume: 1,
      transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
      color: { brightness: 0, contrast: 1, saturation: 1 },
      motion: undefined
    }
    const background: Clip = {
      ...base.clips[0], ...common, id: 'bg', trackId: 'v1',
      ...(behind ? { planes: 'background' as const } : {})
    }
    const text: Clip = { ...base.clips[0], ...common, id: 'txt1', assetId: 'txt', trackId: 'v2' }
    const clips: Clip[] = [background, text]
    if (behind) {
      clips.push({ ...base.clips[0], ...common, id: 'front', trackId: 'v3', planes: 'front' })
    }
    return {
      ...base,
      tracks: [
        ...base.tracks.filter((t) => t.kind === 'video'),
        { id: 'v3', kind: 'video', name: 'V3', muted: false, hidden: false, locked: false },
        ...base.tracks.filter((t) => t.kind === 'audio')
      ],
      assets: [...base.assets, banner],
      clips
    }
  }

  beforeAll(async () => {
    // A yellow band across the middle — it crosses the red subject marker.
    await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', `color=c=black@0:s=${PLANE_W}x${PLANE_H},format=rgba`,
      '-f', 'lavfi', '-i', `color=c=#f0d020:s=${PLANE_W}x70`,
      '-filter_complex', '[0:v][1:v]overlay=0:190:format=auto',
      '-frames:v', '1', join(dir, 'banner.png')])
  }, 120_000)

  it('lets the subject cover the text', async () => {
    const over = join(dir, 'text-over.mp4')
    const under = join(dir, 'text-under.mp4')
    await run(FFMPEG, buildRenderPlan({ project: scene(false), outputPath: over }).args,
      { maxBuffer: 16 * 1024 * 1024 })
    await run(FFMPEG, buildRenderPlan({ project: scene(true), outputPath: under }).args,
      { maxBuffer: 16 * 1024 * 1024 })

    const count = (frame: Buffer, match: typeof isYellow): number => {
      let n = 0
      for (let i = 0; i < frame.length; i += 3) if (match(frame[i], frame[i + 1], frame[i + 2])) n++
      return n
    }

    const yellowOver = count(await frameAt(over, 1), isYellow)
    const yellowUnder = count(await frameAt(under, 1), isYellow)
    const redUnder = count(await frameAt(under, 1), isRed)

    expect(yellowOver).toBeGreaterThan(0)
    // The subject now occludes part of the band, so less of it survives...
    expect(yellowUnder).toBeLessThan(yellowOver)
    // ...and the subject itself is visible, which is the whole point.
    expect(redUnder).toBeGreaterThan(0)
  }, 240_000)

  it('draws a background clip without its subject', async () => {
    const out = join(dir, 'bg-only.mp4')
    const project = scene(true)
    const plan = buildRenderPlan({
      project: { ...project, clips: project.clips.filter((c) => c.planes !== 'front') },
      outputPath: out
    })
    // Two planes for the background clip, not three.
    expect(plan.args.filter((a) => a === '-loop').length).toBe(3)
    await run(FFMPEG, plan.args, { maxBuffer: 16 * 1024 * 1024 })
    expect((await frameAt(out, 1)).length).toBe(W * H * 3)
  }, 240_000)
})

/*
 * Filmstrip panels, in pixels.
 *
 * The whole effect is that panels FILL narrow full-height boxes and travel
 * together. A version that letterboxed each photo inside its strip would render
 * a row of thin floating bands, and a version where `cover` squashed instead of
 * cropping would render distorted ones — both plausible, both wrong.
 */
describe('filmstrip panels', () => {
  function panelProject(fit: 'contain' | 'cover'): Project {
    const base = parallaxProject({ bake: null })
    // A wide source in a narrow tall box is the case that separates the modes.
    const wide: MediaAsset = {
      id: 'wide', path: planes[0], name: 'wide.png', kind: 'image', durationFrames: 90,
      width: PLANE_W, height: PLANE_H, fps: 30, hasVideo: true, hasAudio: false, size: 0
    }
    const panel: Clip = {
      ...base.clips[0], id: 'p1', assetId: 'wide', motion: undefined,
      transform: { x: 0, y: 0, scale: 0.25, scaleY: 1, fit, rotation: 0, opacity: 1 }
    }
    return { ...base, assets: [wide], clips: [panel] }
  }

  const litRows = (frame: Buffer): number => {
    let rows = 0
    for (let y = 0; y < H; y++) {
      let lit = false
      for (let x = 0; x < W && !lit; x++) {
        const i = (y * W + x) * 3
        if (frame[i] > 12 || frame[i + 1] > 12 || frame[i + 2] > 12) lit = true
      }
      if (lit) rows++
    }
    return rows
  }

  it('fills the full height of its strip with cover, and does not with contain', async () => {
    const a = join(dir, 'panel-contain.mp4')
    const b = join(dir, 'panel-cover.mp4')
    await run(FFMPEG, buildRenderPlan({ project: panelProject('contain'), outputPath: a }).args,
      { maxBuffer: 16 * 1024 * 1024 })
    await run(FFMPEG, buildRenderPlan({ project: panelProject('cover'), outputPath: b }).args,
      { maxBuffer: 16 * 1024 * 1024 })

    const contained = litRows(await frameAt(a, 1))
    const covered = litRows(await frameAt(b, 1))
    expect(covered).toBeGreaterThan(contained * 1.5)
    // Cover means the panel reaches top and bottom of the frame.
    expect(covered).toBeGreaterThan(H * 0.95)
  }, 240_000)

  it('keeps the panel narrow — cover fills height, not width', async () => {
    const out = join(dir, 'panel-narrow.mp4')
    await run(FFMPEG, buildRenderPlan({ project: panelProject('cover'), outputPath: out }).args,
      { maxBuffer: 16 * 1024 * 1024 })
    const frame = await frameAt(out, 1)
    let lit = 0
    for (let x = 0; x < W; x++) {
      for (let y = 0; y < H; y++) {
        const i = (y * W + x) * 3
        if (frame[i] > 12 || frame[i + 1] > 12 || frame[i + 2] > 12) { lit++; break }
      }
    }
    // A quarter-width panel, not a full-frame image.
    expect(lit).toBeLessThan(W * 0.4)
    expect(lit).toBeGreaterThan(W * 0.1)
  }, 240_000)
})

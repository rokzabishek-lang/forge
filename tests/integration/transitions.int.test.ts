import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg'
import { buildRenderPlan } from '@shared/render/plan'
import { addTransition, removeTransition, emptyProject, projectDuration, type Clip, type MediaAsset, type Project } from '@shared/timeline'

const run = promisify(execFile)
const FFMPEG = ffmpegInstaller.path

const W = 320
const H = 240
let dir = ''
let blue = ''
let red = ''

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'forge-tr-'))
  blue = join(dir, 'blue.mp4')
  red = join(dir, 'red.mp4')
  for (const [file, colour] of [[blue, 'blue'], [red, 'red']] as const) {
    await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
      '-i', `color=c=${colour}:size=${W}x${H}:rate=30:duration=5`,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file])
  }
}, 180_000)

afterAll(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => undefined)
})

function asset(id: string, path: string): MediaAsset {
  return {
    id, path, name: id, kind: 'video', durationFrames: 150,
    width: W, height: H, fps: 30, hasVideo: true, hasAudio: false, size: 0
  }
}

function clip(over: Partial<Clip>): Clip {
  return {
    id: 'c', assetId: 'blue', trackId: 'v1', start: 0, duration: 60, inPoint: 0, volume: 1,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    color: { brightness: 0, contrast: 1, saturation: 1 },
    ...over
  }
}

/** Two adjacent clips: blue 0-2s, red 2-4s. */
function pair(): Project {
  return {
    ...emptyProject(),
    settings: { width: W, height: H, fps: 30, sampleRate: 48000 },
    assets: [asset('blue', blue), asset('red', red)],
    clips: [
      clip({ id: 'a', assetId: 'blue', start: 0, duration: 60 }),
      clip({ id: 'b', assetId: 'red', start: 60, duration: 60 })
    ]
  }
}

async function centrePixel(file: string, atSeconds: number): Promise<[number, number, number]> {
  const { stdout } = await run(
    FFMPEG,
    ['-hide_banner', '-loglevel', 'error', '-ss', String(atSeconds), '-i', file,
     '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
    { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 }
  )
  const buf = stdout as unknown as Buffer
  const i = ((H / 2) * W + W / 2) * 3
  return [buf[i], buf[i + 1], buf[i + 2]]
}

describe('transition model', () => {
  it('creates a real overlap and shortens the timeline', () => {
    const before = pair()
    const after = addTransition(before, 'b', 'dissolve', 15)

    expect(projectDuration(before)).toBe(120)
    // A dissolve consumes time from both sides rather than adding any.
    expect(projectDuration(after)).toBe(105)

    const b = after.clips.find((c) => c.id === 'b')!
    expect(b.start).toBe(45)
    expect(b.transitionIn).toEqual({ id: 'dissolve', durationFrames: 15 })
  })

  it('does not stack when the transition is changed', () => {
    let project = addTransition(pair(), 'b', 'dissolve', 15)
    project = addTransition(project, 'b', 'slide-left', 20)
    const b = project.clips.find((c) => c.id === 'b')!
    // Shift by the delta only: 60 - 20, not 60 - 15 - 20.
    expect(b.start).toBe(40)
    expect(b.transitionIn?.id).toBe('slide-left')
  })

  it('restores the consumed time when removed', () => {
    const original = pair()
    const roundTrip = removeTransition(addTransition(original, 'b', 'dissolve', 15), 'b')
    expect(roundTrip.clips.find((c) => c.id === 'b')!.start).toBe(60)
    expect(projectDuration(roundTrip)).toBe(projectDuration(original))
  })

  /*
   * This used to assert the opposite, and the opposite was wrong.
   *
   * A transition on the first clip of a track is not a mistake: it blends
   * against whatever is composited underneath, and against nothing at all it is
   * a fade from black — one of the commonest edits there is. Refusing it meant
   * a title over footage could be offered a transition that silently did
   * nothing when clicked.
   */
  it('allows a transition on the first clip of a track', () => {
    const applied = addTransition(pair(), 'a', 'dissolve', 15)
    expect(applied.clips.find((c) => c.id === 'a')!.transitionIn).toEqual({
      id: 'dissolve',
      durationFrames: 15
    })
  })

  it('takes no time from the timeline when there is nothing to overlap', () => {
    const original = pair()
    const applied = addTransition(original, 'a', 'dissolve', 15)
    expect(applied.clips.find((c) => c.id === 'a')!.start).toBe(0)
    expect(applied.clips.find((c) => c.id === 'b')!.start).toBe(
      original.clips.find((c) => c.id === 'b')!.start
    )
    expect(projectDuration(applied)).toBe(projectDuration(original))
  })

  it('clamps a transition longer than the clips it joins', () => {
    const project = addTransition(pair(), 'b', 'dissolve', 9999)
    const b = project.clips.find((c) => c.id === 'b')!
    // Must leave at least a frame of each clip unblended.
    expect(b.transitionIn!.durationFrames).toBeLessThanOrEqual(59)
    expect(b.start).toBeGreaterThanOrEqual(0)
  })
})

describe('transition rendering', () => {
  it('blends both clips mid-dissolve', async () => {
    const out = join(dir, 'dissolve.mp4')
    const project = addTransition(pair(), 'b', 'dissolve', 30)

    await run(FFMPEG, buildRenderPlan({ project, outputPath: out }).args, {
      maxBuffer: 16 * 1024 * 1024
    })

    // Overlap runs 1.0s-2.0s; sample the middle of it.
    const mid = await centrePixel(out, 1.5)
    const before = await centrePixel(out, 0.4)
    const after = await centrePixel(out, 2.5)

    expect(before[2]).toBeGreaterThan(120) // blue
    expect(after[0]).toBeGreaterThan(120) // red

    // Mid-dissolve must be neither pure blue nor pure red.
    expect(mid[0]).toBeGreaterThan(25)
    expect(mid[2]).toBeGreaterThan(25)
  }, 180_000)

  it('emits the alpha fade for a dissolve', () => {
    const project = addTransition(pair(), 'b', 'dissolve', 15)
    const args = buildRenderPlan({ project, outputPath: '/o.mp4' }).args.join(' ')
    // alpha=1 fades the alpha channel; without it the clip fades toward black
    // instead of revealing what is underneath.
    expect(args).toContain('fade=t=in:st=0:d=0.5000:alpha=1')
  })

  it('emits a position expression for a slide, anchored to the clip start', () => {
    const project = addTransition(pair(), 'b', 'slide-left', 15)
    const args = buildRenderPlan({ project, outputPath: '/o.mp4' }).args.join(' ')
    expect(args).toContain('overlay=x=')
    // S must be substituted with the real start time, not left symbolic.
    expect(args).not.toMatch(/t-S/)
    expect(args).toContain('1.500000')
  })

  it('leaves clips without a transition at a hard cut', () => {
    const args = buildRenderPlan({ project: pair(), outputPath: '/o.mp4' }).args.join(' ')
    expect(args).not.toContain('fade=t=in')
    expect(args).toContain("overlay=x='0':y='0'")
  })
})

describe('luma mask wipes', () => {
  const MASK = join(process.cwd(), 'assets/transitions/extra/barr_ripple_1.jpg')
  const hasMask = existsSync(MASK)
  const maybe = hasMask ? it : it.skip

  const withMask = (): Project => {
    const project = addTransition(pair(), 'b', 'mask-test', 30)
    return project
  }

  const extras = [
    {
      id: 'mask-test',
      label: 'Ripple',
      family: 'smooth' as const,
      tier: 1 as const,
      defaultFrames: 30,
      mask: 'transitions/extra/barr_ripple_1.jpg'
    }
  ]

  maybe('adds one input per masked transition and merges it as alpha', () => {
    const args = buildRenderPlan({
      project: withMask(),
      outputPath: '/o.mp4',
      extraTransitions: extras,
      resolveAsset: (p) => join(process.cwd(), 'assets', p)
    }).args.join(' ')

    expect(args).toContain('barr_ripple_1.jpg')
    // The mask must outlive the wipe or alphamerge runs out of frames.
    expect(args).toContain('-loop 1')
    expect(args).toContain('format=gray')
    expect(args).toContain('geq=lum=')
    expect(args).toContain('alphamerge')
  })

  maybe('renders a real wipe that is mid-blend part-way through', async () => {
    const out = join(dir, 'luma.mp4')
    const plan = buildRenderPlan({
      project: withMask(),
      outputPath: out,
      extraTransitions: extras,
      resolveAsset: (p) => join(process.cwd(), 'assets', p)
    })

    await run(FFMPEG, plan.args, { maxBuffer: 16 * 1024 * 1024 })

    const before = await centrePixel(out, 0.3)
    const after = await centrePixel(out, 2.6)
    expect(before[2]).toBeGreaterThan(120) // blue first
    expect(after[0]).toBeGreaterThan(120) // red after

    // Somewhere in the overlap the frame must contain BOTH colours — a wipe
    // reveals progressively, so a mid frame is part blue and part red.
    const { stdout } = await run(
      FFMPEG,
      ['-hide_banner', '-loglevel', 'error', '-ss', '1.5', '-i', out,
       '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
      { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 }
    )
    const frame = stdout as unknown as Buffer
    let reddish = 0
    let bluish = 0
    for (let i = 0; i < frame.length; i += 3) {
      if (frame[i] > 120 && frame[i + 2] < 90) reddish++
      if (frame[i + 2] > 120 && frame[i] < 90) bluish++
    }
    expect(reddish).toBeGreaterThan(0)
    expect(bluish).toBeGreaterThan(0)
  }, 180_000)
})

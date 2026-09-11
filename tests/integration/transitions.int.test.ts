import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
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

  it('refuses a transition on the first clip of a track', () => {
    const project = pair()
    expect(addTransition(project, 'a', 'dissolve', 15)).toBe(project)
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

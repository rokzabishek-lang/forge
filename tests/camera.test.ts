import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { canMoveCamera, depthFor, saneMotion, withMotion, withoutMotionForZoom } from '@shared/edit/camera'
import { MAX_PARALLAX_AMOUNT, moveAt, moveExpressions } from '@shared/render/motion'
import { buildRenderPlan } from '@shared/render/plan'
import { convertFrameRate } from '@shared/project/frameRate'
import { emptyProject, moveWindow, splitClip, trimStart, type Clip, type MediaAsset, type Motion, type Project } from '@shared/timeline'

/*
 * Camera moves by hand (FIX.md B3): the rules the Camera panel and the zoom
 * keyframes share, and the window that lets a split keep one move.
 * tests/integration/splitMove.int.test.ts renders the split.
 */

const photo: MediaAsset = { id: 'p', path: '/p.png', name: 'p', kind: 'image', durationFrames: 300, width: 640, height: 360, fps: null, hasVideo: true, hasAudio: false, size: 1 }

function clip(over: Partial<Clip> = {}): Clip {
  return {
    id: 'c', assetId: 'p', trackId: 'v1', start: 0, duration: 60, inPoint: 0, volume: 1,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    color: { brightness: 0, contrast: 1, saturation: 1 },
    ...over
  }
}

const pan: Motion = { kind: 'kenburns', direction: 'panRight', amount: 0.3 }

describe('which clips take a move', () => {
  it('photographs, and nothing else', () => {
    expect(canMoveCamera({}, { kind: 'image' })).toBe(true)
    // zoompan holds each input frame for the whole move: right for a still,
    // wrong for footage.
    expect(canMoveCamera({}, { kind: 'video' })).toBe(false)
    expect(canMoveCamera({}, undefined)).toBe(false)
    for (const drawn of [{ text: {} }, { title: {} }, { paper: {} }, { carousel: {} }, { solid: {} }, { adjustment: true }]) {
      expect(canMoveCamera(drawn as Parameters<typeof canMoveCamera>[0], { kind: 'image' }), JSON.stringify(drawn)).toBe(false)
    }
  })

  it('offers depth only with a separated bake, and holding the subject only with a subject', () => {
    const layers = [{ file: 'a', index: 0, depth: 0, coverage: 1 }, { file: 'b', index: 1, depth: 1, coverage: 0.3 }]
    expect(depthFor({ parallax: {} }, 'p')).toEqual({ planes: false, subject: false })
    expect(depthFor({ parallax: { p: { width: 1, height: 1, separated: true, spread: 0.5, layers } } }, 'p')).toEqual({ planes: true, subject: false })
    expect(depthFor({ parallax: { p: { width: 1, height: 1, separated: true, spread: 0.5, layers, subject: true } } }, 'p')).toEqual({ planes: true, subject: true })
    expect(depthFor({ parallax: { p: { width: 1, height: 1, separated: false, spread: 0, layers, subject: true } } }, 'p')).toEqual({ planes: false, subject: false })
  })
})

describe('a move in range', () => {
  it('clamps the amount, caps parallax at the fill band, and bounds a shake', () => {
    expect(saneMotion({ ...pan, amount: 3 }).amount).toBe(0.5)
    expect(saneMotion({ kind: 'parallax', direction: 'in', amount: 0.4 }).amount).toBe(MAX_PARALLAX_AMOUNT)
    const shake = saneMotion({ kind: 'shake', amount: 0.2, hz: 99, decay: -1 })
    expect(shake).toMatchObject({ hz: 30, decay: 0 })
    expect(saneMotion({ kind: 'shake', amount: 0.2, hz: Number.NaN })).toMatchObject({ hz: 9, decay: 0.16 })
  })
})

describe('a move and zoom keyframes, never both', () => {
  it('a move takes the zoom keys off, and says so; the others stay', () => {
    const keyed = clip({ keyframes: { zoom: [{ frame: 0, value: 1 }, { frame: 30, value: 1.4 }], opacity: [{ frame: 0, value: 1 }] } })
    const { clip: moved, droppedZoom } = withMotion(keyed, pan)
    expect(droppedZoom).toBe(true)
    expect(moved.motion).toEqual(pan)
    expect(moved.keyframes).toEqual({ opacity: [{ frame: 0, value: 1 }] })
    expect(withMotion(clip(), pan).droppedZoom).toBe(false)
  })

  it('a move chosen by hand is the clip’s own — a split’s window goes', () => {
    const { clip: moved } = withMotion(clip(), { ...pan, window: { from: 30, length: 60 } })
    expect(moved.motion!.window).toBeUndefined()
  })

  it('none takes the move off', () => {
    expect('motion' in withMotion(clip({ motion: pan }), undefined).clip).toBe(false)
  })

  it('zoom keys take a move off, and say so', () => {
    expect(withoutMotionForZoom(clip({ motion: pan }))).toMatchObject({ droppedMotion: true })
    expect('motion' in withoutMotionForZoom(clip({ motion: pan })).clip).toBe(false)
    const still = clip()
    expect(withoutMotionForZoom(still)).toEqual({ clip: still, droppedMotion: false })
  })
})

describe('where in its move a clip is', () => {
  it('runs 0..1 across the clip when the move is its own', () => {
    expect(moveAt(pan, 60, 0, 30)).toEqual({ progress: 0, seconds: 0 })
    expect(moveAt(pan, 60, 59, 30).progress).toBe(1)
    expect(moveAt(pan, 60, 30, 30).seconds).toBe(1)
  })

  it('starts part-way in for a window onto a longer move', () => {
    const right = { ...pan, window: { from: 30, length: 60 } }
    expect(moveAt(right, 30, 0, 30).progress).toBeCloseTo(30 / 59, 12)
    expect(moveAt(right, 30, 29, 30).progress).toBe(1)
    expect(moveAt(right, 30, 0, 30).seconds).toBe(1)
  })

  it('the export’s expressions say the same numbers at every frame', () => {
    const evaluate = (e: string, on: number): number => Function(`return ${e.replace(/\bon\b/g, String(on))}`)() as number
    for (const motion of [pan, { ...pan, window: { from: 30, length: 60 } }, { ...pan, window: { from: 0, length: 90 } }]) {
      const duration = 30
      const ex = moveExpressions(motion, duration, 30)
      for (const on of [0, 7, 29]) {
        const want = moveAt(motion, duration, on, 30)
        expect(evaluate(ex.progress, on), `${JSON.stringify(motion.window)} @${on}`).toBeCloseTo(want.progress, 12)
        expect(evaluate(ex.seconds, on)).toBeCloseTo(want.seconds, 12)
      }
    }
  })
})

describe('the window through every edit', () => {
  it('a split gives each half a window onto the one move', () => {
    const [left, right] = splitClip(clip({ motion: pan }), 20)!
    expect(left.motion!.window).toEqual({ from: 0, length: 60 })
    expect(right.motion!.window).toEqual({ from: 20, length: 60 })
    // Split again, and the windows nest.
    const [, far] = splitClip(right, 45)!
    expect(far.motion!.window).toEqual({ from: 45, length: 60 })
    expect(moveWindow(clip())).toEqual({ from: 0, length: 60 })
  })

  it('a clip that was never split still fits its move to its length', () => {
    const trimmed = trimStart(clip({ motion: pan }), 10)
    expect(trimmed.motion!.window).toBeUndefined()
  })

  it('a head trim on a shared move starts further into it', () => {
    const [, right] = splitClip(clip({ motion: pan }), 20)!
    expect(trimStart(right, 25).motion!.window).toEqual({ from: 25, length: 60 })
  })

  it('a frame-rate change converts the window', () => {
    const [, right] = splitClip(clip({ motion: pan }), 20)!
    const p: Project = { ...emptyProject(), settings: { ...emptyProject().settings, fps: 30 }, assets: [photo], clips: [right] }
    expect(convertFrameRate(p, 60).clips[0].motion!.window).toEqual({ from: 40, length: 120 })
  })

  it('reaches the export: a window shows in the zoompan expressions', () => {
    const [, right] = splitClip(clip({ motion: { kind: 'shake', amount: 0.2 } }), 15)!
    const p: Project = { ...emptyProject(), settings: { ...emptyProject().settings, width: 320, height: 180, fps: 30 }, assets: [photo], clips: [right] }
    const args = buildRenderPlan({ project: p, outputPath: '/o.mp4' }).args
    expect(args[args.indexOf('-filter_complex') + 1]).toContain('(15+on)/30')
  })
})

const source = (path: string): string => readFileSync(resolve(__dirname, '..', path), 'utf8')

describe('the wiring', () => {
  it('the preview asks the same rule for its place in the move', () => {
    const preview = source('src/renderer/src/components/Preview.tsx')
    expect(preview).toContain('moveAt(clip.motion ?? {}, clip.duration, into, project.settings.fps)')
    expect(preview).not.toMatch(/into \/ \(clip\.duration - 1\)/)
  })

  it('the export’s move reads its window', () => {
    const plan = source('src/shared/render/plan.ts')
    expect(plan).toContain('const { progress, seconds } = moveExpressions(motion, durationFrames, fps)')
    expect(plan).not.toContain('const seconds = `on/${fps}`')
  })

  it('the Camera panel is offered on photographs only', () => {
    const inspector = source('src/renderer/src/components/Inspector.tsx')
    expect(inspector).toContain('{canMoveCamera(clip, asset ?? undefined) && <CameraPanel clip={clip} />}')
    expect([...inspector.matchAll(/<CameraPanel /g)]).toHaveLength(1)
  })
})

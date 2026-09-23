import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  defaultMask,
  isMaskAnimated,
  maskAt,
  maskExpression,
  maskFieldOf,
  maskKeyFrames,
  maskShapeAt,
  withMaskAnimation,
  withMaskEdit,
  withoutMaskKeys,
  type Mask
} from '@shared/render/mask'
import { formatKeyed, graphWindow, type KeyframeTracks } from '@shared/render/keyframes'
import { buildRenderPlan } from '@shared/render/plan'
import { convertFrameRate } from '@shared/project/frameRate'
import { emptyProject, splitClip, type Clip, type MediaAsset, type Project } from '@shared/timeline'

/*
 * A mask that moves (FIX.md B3): its centre and size are four keyframe tracks
 * on the clip. tests/integration/maskKeyframes.int.test.ts renders it; these
 * pin the model, the edit rules and the wiring.
 */

const mask: Mask = { ...defaultMask('reveal'), shape: { ...defaultMask('reveal').shape, x: 0.5, y: 0.5, width: 0.2, height: 0.3 } }

function clip(over: Partial<Clip> = {}): Clip {
  return {
    id: 'c', assetId: 'a', trackId: 'v1', start: 100, duration: 60, inPoint: 0, volume: 1,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    color: { brightness: 0, contrast: 1, saturation: 1 },
    mask,
    ...over
  }
}

const moving: KeyframeTracks = { maskX: [{ frame: 0, value: 0.2 }, { frame: 40, value: 0.6 }] }

describe('the shape at a frame', () => {
  it('is the shape itself when nothing is keyed', () => {
    expect(maskShapeAt(mask.shape, undefined, 10, 60)).toBe(mask.shape)
    expect(maskAt(clip(), 10)).toBe(mask)
    expect(maskAt(clip({ mask: undefined }), 10)).toBeUndefined()
  })

  it('follows a keyed number and leaves the others at the shape', () => {
    const at = maskShapeAt(mask.shape, moving, 20, 60)
    expect(at.x).toBeCloseTo(0.4, 9)
    expect(at.y).toBe(0.5)
    expect(at.width).toBe(0.2)
    // Held past the last key.
    expect(maskShapeAt(mask.shape, moving, 55, 60).x).toBeCloseTo(0.6, 9)
  })

  it('takes a single key as the value — as the export does', () => {
    expect(maskShapeAt(mask.shape, { maskWidth: [{ frame: 5, value: 0.45 }] }, 30, 60).width).toBe(0.45)
  })
})

describe('editing a mask', () => {
  it('changes the shape when nothing is animated, as it always did', () => {
    const edited = withMaskEdit(clip(), { x: 0.7, feather: 0.4 }, 10)
    expect(edited.mask!.shape.x).toBe(0.7)
    expect(edited.mask!.shape.feather).toBe(0.4)
    expect(edited.keyframes).toBeUndefined()
  })

  it('keys an animated number at the frame, and leaves the resting shape alone', () => {
    const edited = withMaskEdit(clip({ keyframes: moving }), { x: 0.9, feather: 0.4 }, 20)
    expect(edited.keyframes!.maskX).toEqual([
      { frame: 0, value: 0.2 },
      { frame: 20, value: 0.9 },
      { frame: 40, value: 0.6 }
    ])
    expect(edited.mask!.shape.x).toBe(0.5)
    // Not keyable: the angle, softness and kind are the shape's.
    expect(edited.mask!.shape.feather).toBe(0.4)
  })

  it('replaces a key already at that frame, keeping how it eases', () => {
    const eased: KeyframeTracks = { maskX: [{ frame: 0, value: 0.2, ease: 'smooth' }, { frame: 40, value: 0.6 }] }
    const edited = withMaskEdit(clip({ keyframes: eased }), { x: 0.3 }, 0)
    expect(edited.keyframes!.maskX![0]).toEqual({ frame: 0, value: 0.3, ease: 'smooth' })
    expect(edited.keyframes!.maskX).toHaveLength(2)
  })

  it('keeps the key inside the clip when the playhead is not', () => {
    const edited = withMaskEdit(clip({ keyframes: moving }), { x: 0.1 }, 500)
    expect(edited.keyframes!.maskX!.at(-1)!.frame).toBe(59)
  })

  it('does nothing to a clip with no mask', () => {
    const bare = clip({ mask: undefined })
    expect(withMaskEdit(bare, { x: 0.1 }, 0)).toBe(bare)
  })
})

describe('Animate, on and off', () => {
  it('on: one key for each of the four, where the shape is, at the frame', () => {
    const on = withMaskAnimation(clip({ keyframes: { zoom: [{ frame: 0, value: 1.2 }] } }), true, 12)
    expect(on.keyframes!.maskX).toEqual([{ frame: 12, value: 0.5 }])
    expect(on.keyframes!.maskY).toEqual([{ frame: 12, value: 0.5 }])
    expect(on.keyframes!.maskWidth).toEqual([{ frame: 12, value: 0.2 }])
    expect(on.keyframes!.maskHeight).toEqual([{ frame: 12, value: 0.3 }])
    // Nothing moves until something changes somewhere else.
    expect(maskAt(on, 40)!.shape).toEqual(mask.shape)
    expect(on.keyframes!.zoom).toEqual([{ frame: 0, value: 1.2 }])
  })

  it('on again changes nothing', () => {
    const animated = clip({ keyframes: moving })
    expect(withMaskAnimation(animated, true, 5)).toBe(animated)
  })

  it('off keeps what is on screen, and only the mask’s tracks go', () => {
    const off = withMaskAnimation(clip({ keyframes: { ...moving, zoom: [{ frame: 0, value: 1.2 }] } }), false, 20)
    expect(off.mask!.shape.x).toBeCloseTo(0.4, 9)
    expect(off.keyframes).toEqual({ zoom: [{ frame: 0, value: 1.2 }] })
    expect(isMaskAnimated(off.keyframes)).toBe(false)
  })

  it('takes the mask’s tracks out and leaves nothing behind when they were all there was', () => {
    expect(withoutMaskKeys(moving)).toBeUndefined()
    expect(withoutMaskKeys({ ...moving, opacity: [] })).toEqual({ opacity: [] })
    expect(withoutMaskKeys(undefined)).toBeUndefined()
  })

  it('lists every frame any of the four has a key on, once, in order', () => {
    expect(maskKeyFrames({ maskX: [{ frame: 30, value: 0 }, { frame: 0, value: 0 }], maskHeight: [{ frame: 30, value: 0 }, { frame: 10, value: 0 }], zoom: [{ frame: 5, value: 1 }] })).toEqual([0, 10, 30])
    expect(maskFieldOf('maskWidth')).toBe('width')
    expect(maskFieldOf('zoom')).toBeNull()
  })
})

describe('the export’s expression', () => {
  const shape = { ...mask.shape, kind: 'rectangle' as const, radius: 0.3 }
  const motion = (keyframes: KeyframeTracks | undefined) => ({ keyframes, fps: 30, durationFrames: 60 })

  it('is exactly the still one when nothing about the mask is keyed', () => {
    expect(maskExpression(shape, motion(undefined))).toBe(maskExpression(shape))
    expect(maskExpression(shape, motion({ zoom: [{ frame: 0, value: 1 }, { frame: 9, value: 2 }] }))).toBe(maskExpression(shape))
  })

  it('works each keyed curve out once per row, in the clip’s own seconds, and reads it back', () => {
    const e = maskExpression(shape, motion({ ...moving, maskWidth: [{ frame: 0, value: 0.1 }, { frame: 30, value: 0.3 }] }))
    expect(e.startsWith('if(eq(X,0),st(0,')).toBe(true)
    expect(e).toContain('+st(2,max(0.002,abs(')
    // T, from 0 at the clip's first frame — never timeline seconds.
    expect(e).toContain('if(lt(T,0.0000)')
    expect(e).not.toMatch(/\bt\b/)
    expect(e).toContain('(X-ld(0)*W)')
    // The size is read everywhere it is used: the half-extent, the rounded corner.
    expect(e).toContain('ld(2)*W')
    expect(e).toContain('min(ld(2),')
    // Y is not keyed: still a number.
    expect(e).toContain('(Y-0.50000*H)')
  })

  it('keeps each number in its own slot, and the feather follows a keyed size', () => {
    const e = maskExpression({ ...shape, radius: 0, feather: 0.2 }, motion({
      maskY: [{ frame: 0, value: 0.3 }, { frame: 30, value: 0.6 }],
      maskHeight: [{ frame: 0, value: 0.1 }, { frame: 30, value: 0.3 }]
    }))
    expect(e).toContain('st(1,')
    expect(e).toContain('(Y-ld(1)*H)')
    expect(e).toContain('st(3,max(0.002,abs(')
    // The soft band is a fraction of the keyed half-extent, not the still one.
    expect(e).toContain('ld(3)*0.20000*H')
    expect(e).not.toContain('st(4,')
    // And across: a keyed width feathers off the keyed width.
    const across = maskExpression({ ...shape, radius: 0, feather: 0.2 }, motion({ maskWidth: [{ frame: 0, value: 0.1 }, { frame: 30, value: 0.3 }] }))
    expect(across).toContain('ld(2)*0.20000*W')
  })
})

describe('the keyframe model knows the mask’s tracks', () => {
  it('reads them as the mask panel does', () => {
    expect(formatKeyed('maskX', 0.25)).toBe('25%')
    expect(formatKeyed('maskWidth', 0.25)).toBe('50%')
  })

  it('fits the graph round the mask’s own resting value, not a constant', () => {
    const w = graphWindow('maskX', [], 0.9)
    expect(w.hi).toBeGreaterThan(0.9 - 1e-9)
    expect(w.lo).toBeLessThan(0.9)
  })
})

describe('everything that moves keyframes moves the mask’s', () => {
  it('a split: the right half starts where the whole clip was', () => {
    const [, right] = splitClip({ ...clip({ keyframes: moving }), start: 0 }, 20)!
    expect(maskAt(right, 0)!.shape.x).toBeCloseTo(0.4, 9)
  })

  it('a frame-rate change: the keys land on the same moments', () => {
    const asset: MediaAsset = { id: 'a', path: '/a.mp4', name: 'a', kind: 'video', durationFrames: 600, width: 320, height: 180, fps: 30, hasVideo: true, hasAudio: false, size: 1 }
    const p: Project = { ...emptyProject(), settings: { ...emptyProject().settings, fps: 30 }, assets: [asset], clips: [{ ...clip({ keyframes: moving }), start: 0 }] }
    const converted = convertFrameRate(p, 60)
    expect(converted.clips[0].keyframes!.maskX!.map((k) => k.frame)).toEqual([0, 80])
  })
})

const source = (path: string): string => readFileSync(resolve(__dirname, '..', path), 'utf8')

describe('the wiring', () => {
  it('the plan hands the mask its clip’s keys, fps and length', () => {
    const plan = source('src/shared/render/plan.ts')
    expect(plan).toContain('const motion = { keyframes: clip.keyframes, fps, durationFrames: clip.duration }')
    expect(plan).toContain("geq=lum='${maskExpression(mask.shape, motion)}'")
    // And it reaches the graph.
    const p: Project = {
      ...emptyProject(),
      settings: { ...emptyProject().settings, width: 320, height: 180, fps: 30 },
      assets: [{ id: 'a', path: '/a.mp4', name: 'a', kind: 'video', durationFrames: 60, width: 320, height: 180, fps: 30, hasVideo: true, hasAudio: false, size: 1 }],
      clips: [{ ...clip({ keyframes: moving }), start: 0 }]
    }
    const args = buildRenderPlan({ project: p, outputPath: '/o.mp4' }).args
    expect(args[args.indexOf('-filter_complex') + 1]).toContain('geq=lum=\'if(eq(X,0),st(0,')
  })

  it('the preview draws the mask, and puts its handles, where it is at the playhead', () => {
    const preview = source('src/renderer/src/components/Preview.tsx')
    expect(preview).toContain('const mask = raw ? undefined : maskAt(layer.clip, playhead - layer.clip.start)')
    expect(preview).toContain('mask={maskAt(selectedClip, playhead - selectedClip.start) ?? selectedClip.mask}')
  })

  it('the curve graph offers the mask’s four tracks on a masked clip, resting at its shape', () => {
    const panel = source('src/renderer/src/components/CurvePanel.tsx')
    expect(panel).toContain('const offered = [...KEYED_PROPERTIES, ...(clip?.mask ? MASK_PROPERTIES : [])]')
    expect(panel).toContain('offered.map((key) =>')
    expect(panel).toContain('const rest = field && clip?.mask ? clip.mask.shape[field] : undefined')
    expect(panel).toContain('rest={rest}')
    const editor = source('src/renderer/src/components/CurveEditor.tsx')
    expect(editor).toContain('const resting = rest ?? info.neutral')
    // Both the curve and the window read the resting value, not the constant.
    expect(editor).toContain('valueAt(shown, frame, durationFrames, resting)')
    expect(editor).not.toMatch(/valueAt\([^)]*info\.neutral\)/)
  })

  it('the panel writes to the stored mask, never the one showing', () => {
    const panel = source('src/renderer/src/components/MaskPanel.tsx')
    expect(panel).not.toMatch(/setMask\(clip\.id, \{ \.\.\.mask[,\s]/)
    expect([...panel.matchAll(/setMask\(clip\.id, \{ \.\.\.clip\.mask!/g)]).toHaveLength(2)
  })
})

import { describe, it, expect, beforeEach } from 'vitest'
import { defaultMask, maskAt, type Mask } from '@shared/render/mask'
import { emptyProject, type Clip } from '@shared/timeline'
import { useEditor } from '../../src/renderer/src/store'

/*
 * The store's mask actions with a moving mask (FIX.md B3): an edit keys the
 * playhead, and a mask removed or replaced takes its keys with it.
 */

const mask: Mask = { ...defaultMask('reveal'), shape: { ...defaultMask('reveal').shape, x: 0.5 } }

beforeEach(() => {
  const clip: Clip = {
    id: 'c', assetId: 'a', trackId: 'v1', start: 100, duration: 60, inPoint: 0, volume: 1,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    color: { brightness: 0, contrast: 1, saturation: 1 },
    mask,
    keyframes: { zoom: [{ frame: 0, value: 1 }, { frame: 30, value: 1.3 }] }
  }
  useEditor.setState({ project: { ...emptyProject(), clips: [clip] }, past: [], future: [], playhead: 110 })
})

const get = (): Clip => useEditor.getState().project.clips[0]

describe('a moving mask in the store', () => {
  it('Animate keys the playhead, in the clip’s own frames', () => {
    useEditor.getState().animateMask('c', true)
    expect(get().keyframes!.maskX).toEqual([{ frame: 10, value: 0.5 }])
  })

  it('a move at another moment keys there, and the mask glides between', () => {
    useEditor.getState().animateMask('c', true)
    useEditor.setState({ playhead: 140 })
    useEditor.getState().setMaskShape('c', { x: 0.9 })
    expect(get().keyframes!.maskX).toEqual([{ frame: 10, value: 0.5 }, { frame: 40, value: 0.9 }])
    expect(get().mask!.shape.x).toBe(0.5)
    expect(maskAt(get(), 25)!.shape.x).toBeCloseTo(0.7, 9)
  })

  it('a mask that is not animated is edited as it always was', () => {
    useEditor.getState().setMaskShape('c', { x: 0.2 })
    expect(get().mask!.shape.x).toBe(0.2)
    expect(get().keyframes!.maskX).toBeUndefined()
  })

  it('changing the mode keeps the animation; removing the mask removes it, and only it', () => {
    useEditor.getState().animateMask('c', true)
    useEditor.getState().setMask('c', { ...get().mask!, mode: 'blur' })
    expect(get().keyframes!.maskX).toHaveLength(1)
    useEditor.getState().setMask('c', undefined)
    expect(get().keyframes!.maskX).toBeUndefined()
    expect(get().keyframes!.zoom).toHaveLength(2)
  })

  it('a new mask where there was none starts still, whatever keys were left lying', () => {
    useEditor.setState({
      project: { ...useEditor.getState().project, clips: [{ ...get(), mask: undefined, keyframes: { maskX: [{ frame: 0, value: 0.1 }] } }] }
    })
    useEditor.getState().setMask('c', defaultMask('blur'))
    expect(get().keyframes).toBeUndefined()
  })

  it('a picture-in-picture replaces the mask, and its keys', () => {
    useEditor.getState().animateMask('c', true)
    useEditor.getState().makePip('c', { shape: 'circle' })
    expect(get().keyframes!.maskX).toBeUndefined()
  })

  it('Animate off keeps the shape where it is at the playhead', () => {
    useEditor.getState().animateMask('c', true)
    useEditor.setState({ playhead: 140 })
    useEditor.getState().setMaskShape('c', { x: 0.9 })
    useEditor.setState({ playhead: 125 })
    useEditor.getState().animateMask('c', false)
    expect(get().mask!.shape.x).toBeCloseTo(0.7, 9)
    expect(get().keyframes!.maskX).toBeUndefined()
  })
})

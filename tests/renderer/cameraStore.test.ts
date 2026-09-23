import { describe, it, expect, beforeEach } from 'vitest'
import { emptyProject, type Clip } from '@shared/timeline'
import { useEditor } from '../../src/renderer/src/store'

/*
 * A camera move set by hand, in the store (FIX.md B3): a move and zoom keys
 * never both, one history entry each, and a notice that says what went.
 */

beforeEach(() => {
  const clip: Clip = {
    id: 'c', assetId: 'p', trackId: 'v1', start: 0, duration: 60, inPoint: 0, volume: 1,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    color: { brightness: 0, contrast: 1, saturation: 1 }
  }
  useEditor.setState({ project: { ...emptyProject(), clips: [clip] }, past: [], future: [], notices: [] })
})

const get = (): Clip => useEditor.getState().project.clips[0]
const lastNotice = (): string | undefined => useEditor.getState().notices.at(-1)?.text

describe('the camera in the store', () => {
  it('a move takes zoom keys off and says so', () => {
    useEditor.getState().setKeyframe('c', 'zoom', 0, 1.3)
    useEditor.getState().setMotion('c', { kind: 'kenburns', direction: 'in', amount: 0.2 })
    expect(get().motion).toEqual({ kind: 'kenburns', direction: 'in', amount: 0.2 })
    expect(get().keyframes?.zoom).toBeUndefined()
    expect(lastNotice()).toMatch(/Zoom keyframes taken off/)
  })

  it('a zoom key takes a move off, in the same history entry, and says so', () => {
    useEditor.getState().setMotion('c', { kind: 'kenburns', direction: 'in', amount: 0.2 })
    const before = useEditor.getState().past.length
    useEditor.getState().setKeyframe('c', 'zoom', 5, 1.2)
    expect(get().motion).toBeUndefined()
    expect(useEditor.getState().past.length).toBe(before + 1)
    expect(lastNotice()).toMatch(/Camera move taken off/)
    useEditor.getState().undo()
    expect(get().motion?.kind).toBe('kenburns')
  })

  it('drawing zoom keys in the graph takes the move off too; clearing them does not', () => {
    useEditor.getState().setMotion('c', { kind: 'kenburns', direction: 'in', amount: 0.2 })
    useEditor.getState().setKeyframes('c', 'zoom', [])
    expect(get().motion?.kind).toBe('kenburns')
    useEditor.getState().setKeyframes('c', 'zoom', [{ frame: 0, value: 1 }, { frame: 20, value: 1.3 }])
    expect(get().motion).toBeUndefined()
  })

  it('other keys leave a move alone', () => {
    useEditor.getState().setMotion('c', { kind: 'shake', amount: 0.2 })
    useEditor.getState().setKeyframe('c', 'opacity', 5, 0.5)
    expect(get().motion?.kind).toBe('shake')
  })
})

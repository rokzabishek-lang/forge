import { describe, it, expect } from 'vitest'
import { DEFAULT_KEY } from '@shared/render/chromaKey'
import { emptyProject, type Clip } from '@shared/timeline'
import { useEditor } from '../../src/renderer/src/store'

/*
 * The chroma key's store action (FIX.md B3). Here rather than beside the model
 * in tests/chromaKey.test.ts because the store is renderer code: it needs the
 * DOM types tsconfig.web.json gives this directory, and the node project that
 * checks tests/ has none.
 */

describe('the store', () => {
  it('puts a key on, changes it, and takes it off — one history entry each', () => {
    const clip: Clip = {
      id: 'k', assetId: 'a', trackId: 'v1', start: 0, duration: 30, inPoint: 0, volume: 1,
      transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
      color: { brightness: 0, contrast: 1, saturation: 1 }
    }
    useEditor.setState({ project: { ...emptyProject(), clips: [clip] }, past: [], future: [] })
    const get = (): Clip => useEditor.getState().project.clips[0]

    useEditor.getState().setKey('k', { ...DEFAULT_KEY, similarity: 7 })
    // Stored in range.
    expect(get().key).toEqual({ ...DEFAULT_KEY, similarity: 0.5 })
    expect(useEditor.getState().past).toHaveLength(1)

    useEditor.getState().setKey('k', undefined)
    // Gone, not a key at zero: a stored key would still cost the export a split.
    expect('key' in get()).toBe(false)
    expect(useEditor.getState().past).toHaveLength(2)
    useEditor.getState().undo()
    expect(get().key?.similarity).toBe(0.5)
  })
})

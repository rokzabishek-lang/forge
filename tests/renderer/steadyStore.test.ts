import { describe, it, expect } from 'vitest'
import { emptyProject, type Clip } from '@shared/timeline'
import { useEditor } from '../../src/renderer/src/store'

describe('Steady in the store', () => {
  it('turns on, and off means gone', () => {
    const clip: Clip = {
      id: 'c', assetId: 'v', trackId: 'v1', start: 0, duration: 60, inPoint: 0, volume: 1,
      transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
      color: { brightness: 0, contrast: 1, saturation: 1 }
    }
    useEditor.setState({ project: { ...emptyProject(), clips: [clip] }, past: [], future: [] })
    useEditor.getState().setSteady('c', true)
    expect(useEditor.getState().project.clips[0].steady).toBe(true)
    useEditor.getState().setSteady('c', false)
    expect('steady' in useEditor.getState().project.clips[0]).toBe(false)
    expect(useEditor.getState().past).toHaveLength(2)
  })
})

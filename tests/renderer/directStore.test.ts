import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyProject, type MediaAsset } from '@shared/timeline'
import type { CompletionRequest, CompletionResult } from '@shared/director/provider'
import { useEditor } from '../../src/renderer/src/store'

/**
 * `direct()` end to end through the store, with a fake bridge: the eyes run
 * before the menu is built, and the MENU is built from what the gate kept —
 * the near-copy it left out never reaches the model, and the panel says why.
 */

const photo = (id: string): MediaAsset => ({
  id, path: `/p/${id}.jpg`, name: `${id}.jpg`, kind: 'image', durationFrames: 150, width: 1080, height: 1350, fps: null, hasVideo: true, hasAudio: false, size: 10
})

let spine: CompletionRequest[]

beforeEach(() => {
  spine = []
  vi.stubGlobal('window', {
    forge: {
      fileKeys: async (paths: string[]) => Object.fromEntries(paths.map((p) => [p, `k:${p}`])),
      measurePhotos: async (paths: string[]) => ({
        // b is a near-copy of a (two bits apart) and softer; c is its own picture.
        measures: paths.map((p) => ({
          path: p,
          sharpness: p.includes('/b.') ? 100 : 400,
          luma: 0.5, lumaStd: 0.2, darkClip: 0, brightClip: 0,
          dhash: p.includes('/c.') ? '00ff00ff00ff00ff' : p.includes('/b.') ? 'ff00ff00ff00ff03' : 'ff00ff00ff00ff00',
          width: 1080, height: 1350
        })),
        keys: Object.fromEntries(paths.map((p) => [p, `k:${p}`]))
      }),
      directorComplete: async (r: CompletionRequest): Promise<CompletionResult> => {
        if (!r.images) spine.push(r)
        // Prose: the looks come back unreadable and the spine falls to the standard cut.
        return { text: 'I cannot answer in JSON.', provider: 'openai', model: 'fake', promptTokens: 1, outputTokens: 1, durationMs: 1, truncated: false }
      }
    }
  })
  useEditor.setState({
    project: { ...emptyProject(), assets: [photo('a'), photo('b'), photo('c')] },
    directBrief: { ...useEditor.getState().directBrief, product: 'Aura serum', seconds: 12 },
    past: [],
    future: []
  })
})

afterEach(() => vi.unstubAllGlobals())

describe('direct() with eyes', () => {
  it('builds the menu from what the gate kept: the softer near-copy never reaches the model', async () => {
    await useEditor.getState().direct()
    expect(spine.length).toBeGreaterThan(0)
    const user = spine[0].user
    expect(user).toContain('"a"')
    expect(user).toContain('"c"')
    expect(user).not.toContain('"b"')
    const notes = useEditor.getState().lastDirection!.problems.join(' | ')
    expect(notes).toContain('left out — near-duplicate of slot_01 (slot_01 is sharper)')
    // The measurements were kept on the project.
    expect(useEditor.getState().project.vision!.b.measure!.sharpness).toBe(100)
  })
})

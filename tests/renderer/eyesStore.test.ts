import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyProject, type MediaAsset } from '@shared/timeline'
import type { CompletionRequest, CompletionResult } from '@shared/director/provider'
import type { Slot } from '@shared/director/menu'
import { useEditor } from '../../src/renderer/src/store'

/**
 * The store's `seeSlots` (docs/PLAN.md §4): measure the stills, show each to
 * the model once, cache both on the project without an undo step — and when
 * there is no model, or it cannot see, stop and say so rather than failing
 * once per photo.
 */

const asset = (id: string, kind: MediaAsset['kind'] = 'image'): MediaAsset => ({
  id, path: `/p/${id}.jpg`, name: `${id}.jpg`, kind, durationFrames: 150, width: 100, height: 100, fps: null, hasVideo: true, hasAudio: false, size: 10
})
const slot = (n: number, assetId: string, kind: Slot['kind'] = 'image'): Slot => ({
  id: `slot_0${n}`, assetId, kind, label: assetId, note: '', speech: '', seconds: null, frames: null
})

const look = JSON.stringify({ reasoning: 'r', people: 'two', shot: 'close', mood: 'joyful', product_visible: 'no', hero: 'strong', words: 'two people laughing' })
const answer = (text: string): CompletionResult => ({ text, provider: 'openai', model: 'gemma', promptTokens: 1, outputTokens: 1, durationMs: 1, truncated: false })

let keys: Record<string, string>
let asked: CompletionRequest[]
let complete: (r: CompletionRequest) => Promise<CompletionResult>

beforeEach(() => {
  keys = { '/p/a.jpg': 'k-a', '/p/b.jpg': 'k-b' }
  asked = []
  complete = async (r) => {
    asked.push(r)
    return answer(look)
  }
  vi.stubGlobal('window', {
    forge: {
      fileKeys: async (paths: string[]) => Object.fromEntries(paths.map((p) => [p, keys[p] ?? null])),
      measurePhotos: async (paths: string[]) => ({
        measures: paths.map((p) => ({ path: p, sharpness: 300, luma: 0.5, lumaStd: 0.2, darkClip: 0, brightClip: 0, dhash: 'ff', width: 100, height: 100 })),
        keys: Object.fromEntries(paths.map((p) => [p, keys[p] ?? null]))
      }),
      directorComplete: (r: CompletionRequest) => complete(r)
    }
  })
  useEditor.setState({ project: { ...emptyProject(), assets: [asset('a'), asset('b'), asset('v', 'video')] }, past: [], future: [] })
})

afterEach(() => vi.unstubAllGlobals())

const slots = [slot(1, 'a'), slot(2, 'b'), slot(3, 'v', 'video')]

describe('seeing the photos', () => {
  it('measures and looks at each still once, shows the picture, and keeps it without an undo step', async () => {
    const notes = await useEditor.getState().seeSlots(slots, { product: 'Wedding film', language: 'English' })
    expect(notes).toEqual([])
    expect(asked.map((r) => r.images)).toEqual([['/p/a.jpg'], ['/p/b.jpg']])
    const vision = useEditor.getState().project.vision!
    expect(vision.a).toMatchObject({ key: 'k-a', measure: { sharpness: 300 }, look: { people: 'two', hero: 'strong', key: 'k-a', model: 'gemma' } })
    expect(vision.v).toBeUndefined()
    expect(useEditor.getState().past).toHaveLength(0)
    expect(useEditor.getState().dirty).toBe(true)
  })

  it('a second run asks nothing; a changed file is looked at again', async () => {
    await useEditor.getState().seeSlots(slots, { product: 'x', language: 'English' })
    asked = []
    await useEditor.getState().seeSlots(slots, { product: 'x', language: 'English' })
    expect(asked).toHaveLength(0)
    keys['/p/b.jpg'] = 'k-b2'
    await useEditor.getState().seeSlots(slots, { product: 'x', language: 'English' })
    expect(asked.map((r) => r.images)).toEqual([['/p/b.jpg']])
    expect(useEditor.getState().project.vision!.b.key).toBe('k-b2')
  })

  it('no model, or one that cannot see: stops after the first photo and says so', async () => {
    complete = async (r) => {
      asked.push(r)
      throw new Error('No model available')
    }
    const notes = await useEditor.getState().seeSlots(slots, { product: 'x', language: 'English' })
    expect(asked).toHaveLength(1)
    expect(notes).toEqual(['the pictures were not looked at — No model available'])
    // The measurements still landed.
    expect(useEditor.getState().project.vision!.b.measure).toBeDefined()
  })

  it('an answer that is not a look costs that photo only', async () => {
    let n = 0
    complete = async (r) => {
      asked.push(r)
      n++
      // Valid JSON that is not a look: no think-on retry (that is for prose), so photo a is simply lost.
      return answer(n === 1 ? '{"people":"crowd"}' : look)
    }
    const notes = await useEditor.getState().seeSlots(slots, { product: 'x', language: 'English' })
    expect(notes).toEqual(["slot_01: the model's description could not be read"])
    expect(useEditor.getState().project.vision!.a.look).toBeUndefined()
    expect(useEditor.getState().project.vision!.b.look).toBeDefined()
  })
})

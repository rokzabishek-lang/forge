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

describe('direct() runs spine@2', () => {
  /* Three distinct photos (nothing gated out), no music: the grid is the recipe's tempo. */
  let solids: { color: string; opacity: number; width: number; height: number }[]
  let answer: string
  let looks: () => Promise<{ id: string; name: string; description: string; file: string }[]>

  beforeEach(() => {
    solids = []
    answer = 'I cannot answer in JSON.'
    looks = async () => [{ id: 'cool-cine', name: 'Cool cine', description: '', file: '/looks/cool-cine.cube' }]
    const forge = (window as unknown as { forge: Record<string, unknown> }).forge
    forge.measurePhotos = async (paths: string[]) => ({
      measures: paths.map((p, i) => ({
        path: p, sharpness: 400, luma: 0.5, lumaStd: 0.2, darkClip: 0, brightClip: 0,
        dhash: ['ff00ff00ff00ff00', '00ff00ff00ff00ff', 'f0f0f0f00f0f0f0f'][i % 3], width: 1080, height: 1350
      })),
      keys: Object.fromEntries(paths.map((p) => [p, `k:${p}`]))
    })
    forge.directorComplete = async (r: CompletionRequest): Promise<CompletionResult> => {
      if (!r.images) spine.push(r)
      return { text: r.images ? 'prose' : answer, provider: 'openai', model: 'fake', promptTokens: 1, outputTokens: 1, durationMs: 1, truncated: false }
    }
    forge.builtInLooks = () => looks()
    forge.renderSolid = async (o: { color: string; opacity: number; width: number; height: number; clipId: string }) => {
      solids.push({ color: o.color, opacity: o.opacity, width: o.width, height: o.height })
      return `/drawn/${o.clipId}.png`
    }
    useEditor.setState({
      project: { ...emptyProject(), assets: [photo('a'), photo('b'), photo('c')] },
      directBrief: { ...useEditor.getState().directBrief, product: 'Aura serum', tone: 'premium', seconds: 12 },
      directRecipe: 'auto',
      decisions: [],
      // A run that fails leaves the last run's panel: without this a test reads the previous test's notes.
      lastDirection: null
    })
  })

  const settle = (): Promise<void> => new Promise((done) => setTimeout(done, 0))

  it('asks for a spine@2 plan — recipes and a music sentence, no table of cuts', async () => {
    await useEditor.getState().direct()
    const { user, schema } = spine[0] as CompletionRequest & { schema: { properties: Record<string, unknown> } }
    expect(Object.keys(schema.properties)).toContain('recipe')
    expect(Object.keys(schema.properties)).not.toContain('segments')
    expect(user).toMatch(/MUSIC: 12\.0 s at \d+ BPM/)
    expect(user).toContain('product-reveal — Product reveal')
    expect(user).not.toContain('cut_')
  })

  it('prose falls to the standard cut of the tone’s recipe, recorded as spine@2, with the look and the ending drawn', async () => {
    await useEditor.getState().direct()
    await settle()
    const s = useEditor.getState()
    expect(s.lastDirection!.baseline).toBe(true)
    expect(s.lastDirection!.recipe!.id).toBe('product-reveal')
    expect(s.lastDirection!.hero).toBeTruthy()
    expect(s.decisions.at(-1)!.pass).toBe('spine@2')
    const clips = s.project.clips.filter((c) => c.generatedBy)
    expect(clips.filter((c) => c.generatedBy!.rule === 'director.spine').length).toBeGreaterThan(0)
    const lookClip = clips.find((c) => c.generatedBy!.rule === 'director.look')!
    expect(lookClip.color!.lut!.file).toBe('/looks/cool-cine.cube')
    // The look layer's picture is the transparent square; the black and the end card's are opaque black at the canvas.
    const { width, height } = s.project.settings
    expect(solids).toContainEqual({ color: '#000000', opacity: 0, width: 16, height: 16 })
    expect(solids).toContainEqual({ color: '#000000', opacity: 1, width, height })
    // And every one of those pictures landed on its asset.
    const lookAsset = s.project.assets.find((a) => a.id === lookClip.assetId)!
    expect(lookAsset.path).toBe(`/drawn/${lookClip.id}.png`)
    for (const c of clips.filter((x) => x.generatedBy!.rule === 'director.ending')) {
      expect(s.project.assets.find((a) => a.id === c.assetId)!.path).toBe(`/drawn/${c.id}.png`)
    }
  })

  it('a square photo is shown whole over a blurred copy on a lane under the ad — and the next run builds on the user’s track again', async () => {
    // A tall ad, so the 4:5 photos are merely cropped and only the square one needs a backdrop.
    const empty = emptyProject()
    useEditor.setState({ project: { ...empty, settings: { ...empty.settings, width: 1080, height: 1920 }, assets: [{ ...photo('a'), width: 2000, height: 2000 }, photo('b'), photo('c')] } })
    await useEditor.getState().direct()
    const first = useEditor.getState().project
    const lanes = first.tracks.filter((t) => t.director)
    expect(lanes).toHaveLength(1)
    expect(first.tracks[0].id).toBe(lanes[0].id)
    const backs = first.clips.filter((c) => c.generatedBy?.rule === 'director.backdrop')
    expect(backs.length).toBeGreaterThan(0)
    expect(backs.every((b) => b.trackId === lanes[0].id && b.assetId === 'a')).toBe(true)
    expect(first.clips.filter((c) => c.generatedBy?.rule === 'director.spine').every((c) => c.trackId === 'v1')).toBe(true)

    await useEditor.getState().direct()
    const second = useEditor.getState().project
    expect(second.tracks.filter((t) => t.director)).toHaveLength(1)
    expect(second.tracks.length).toBe(first.tracks.length)
    expect(second.clips.filter((c) => c.generatedBy?.rule === 'director.spine').every((c) => c.trackId === 'v1')).toBe(true)
  })

  it('a plan the model wrote lands as directed, in the recipe it chose', async () => {
    const shot = (slot: string, role: string, headline = ''): object => ({ slot, role, weight: 'normal', move: 'hold', speed: 'normal', headline, punch_word: '', why: 'x' })
    answer = JSON.stringify({
      reasoning: 'a fast one',
      recipe: 'energy',
      hero: 'slot_02',
      style: 'poster-3d',
      animation: 'pop',
      shots: [shot('slot_01', 'hook', 'Aura'), shot('slot_02', 'product'), shot('slot_03', 'cta')]
    })
    await useEditor.getState().direct()
    const s = useEditor.getState()
    expect(s.lastDirection!.baseline).toBe(false)
    expect(s.lastDirection!.recipe!.id).toBe('energy')
    expect(s.lastDirection!.reasoning).toBe('a fast one')
  })

  it('a wedding brief with the length left blank is a sixty-second teaser', async () => {
    useEditor.setState({
      directBrief: { ...useEditor.getState().directBrief, product: 'Priya & Arjun', benefit: 'our wedding day', tone: 'premium', seconds: null }
    })
    await useEditor.getState().direct()
    expect(spine[0].user).toMatch(/MUSIC: 60\.0 s/)
    // The same brief pinned to Energy is a thirty-second spot.
    spine.length = 0
    useEditor.getState().setDirectRecipe('energy')
    await useEditor.getState().direct()
    expect(spine[0].user).toMatch(/MUSIC: 30\.0 s/)
  })

  it('a pinned recipe is the only one offered, and the standard cut uses it too', async () => {
    useEditor.getState().setDirectRecipe('wedding-highlight')
    await useEditor.getState().direct()
    const { user } = spine[0]
    expect(user).toContain('wedding-highlight — Wedding highlight')
    expect(user).not.toContain('product-reveal — Product reveal')
    expect(useEditor.getState().lastDirection!.recipe!.id).toBe('wedding-highlight')
  })

  it('a look library that will not list leaves the ad ungraded, with a note — not a failed run', async () => {
    looks = async () => {
      throw new Error('no looks folder')
    }
    await useEditor.getState().direct()
    const s = useEditor.getState()
    expect(s.lastDirection).not.toBeNull()
    expect(s.project.clips.some((c) => c.generatedBy?.rule === 'director.look')).toBe(false)
    expect(s.lastDirection!.problems.join(' ')).toMatch(/not installed — not graded/)
  })
})

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

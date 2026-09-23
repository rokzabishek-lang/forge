import { describe, it, expect } from 'vitest'
import { bakeForExport, exportBakeSizes, exportKey, type Bakers } from '@shared/render/exportBake'
import { emptyProject, type Clip, type MediaAsset, type Project } from '@shared/timeline'

/*
 * An export draws its own cards, at its own canvas, into a copy.
 *
 * The editor's rebake drew at the PROJECT's canvas and wrote into the edit, so
 * a 16:9 project through the 9:16 preset got its titles letterboxed, and every
 * export added undo entries and marked the project unsaved. Found by the B2
 * review. The drawing itself is canvas code; here it is faked, recording what
 * it was asked for, because what is under test is what gets ASKED.
 */

interface Call { kind: string; key: string; width: number; height: number }

function fakeBakers(fail: string[] = []): { bakers: Bakers; calls: Call[] } {
  const calls: Call[] = []
  const record = (kind: string, key: string, width: number, height: number): void => {
    calls.push({ kind, key, width, height })
    if (fail.includes(key)) throw new Error(`could not draw ${key}`)
  }
  const bakers: Bakers = {
    text: async (_s, key, w, h) => { record('text', key, w, h); return `/cache/${key}.png` },
    textSequence: async (spec, key, w, h) => {
      record('textSequence', key, w, h)
      return spec.animationId ? { pattern: `/cache/${key}.seq/%05d.png`, frames: 30 } : null
    },
    solid: async (_s, key, w, h) => { record('solid', key, w, h); return `/cache/${key}.png` },
    title: async (_s, key, w, h) => { record('title', key, w, h); return `/cache/${key}.png` },
    paper: async (_s, key, w, h, frames) => {
      record('paper', key, w, h)
      return { pattern: `/cache/${key}.seq/%05d.png`, frames }
    },
    carousel: async (_s, key, _p, w, h, frames) => {
      record('carousel', key, w, h)
      return { pattern: `/cache/${key}.seq/%05d.png`, frames }
    }
  }
  return { bakers, calls }
}

const asset = (id: string, over: Partial<MediaAsset> = {}): MediaAsset => ({
  id, path: `/edit/${id}.png`, name: id, kind: 'image', durationFrames: 90,
  width: 1920, height: 1080, fps: null, hasVideo: true, hasAudio: false, size: 0, ...over
})
const clip = (over: Partial<Clip> & { id: string; assetId: string }): Clip => ({
  trackId: 'v1', start: 0, duration: 60, inPoint: 0, volume: 1,
  transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
  color: { brightness: 0, contrast: 1, saturation: 1 }, ...over
})

/** A 16:9 project with one of each generated card and a real video clip. */
function landscape(): Project {
  return {
    ...emptyProject(),
    settings: { ...emptyProject().settings, width: 1920, height: 1080, fps: 30 },
    assets: [
      asset('video', { kind: 'video', path: '/media/shot.mp4', hasAudio: true, fps: 30 }),
      asset('t'), asset('s'), asset('ti'), asset('p'), asset('photo', { path: '/media/photo.jpg' }), asset('r')
    ],
    clips: [
      clip({ id: 'shot', assetId: 'video' }),
      clip({ id: 'words', assetId: 't', text: { content: 'Hello', version: 3 } as NonNullable<Clip['text']> }),
      clip({ id: 'card', assetId: 's', solid: { color: '#ff0000', opacity: 1, version: 1 } }),
      clip({ id: 'name', assetId: 'ti', title: { template: '/t/lower.svg', texts: {}, version: 2 } as NonNullable<Clip['title']> }),
      clip({ id: 'news', assetId: 'p', paper: { holdFrames: 10 } as NonNullable<Clip['paper']> }),
      clip({ id: 'ring', assetId: 'r', carousel: { assetIds: ['photo'] } as NonNullable<Clip['carousel']> })
    ]
  }
}

const sizeOf = (calls: Call[], kind: string): { width: number; height: number } => {
  const call = calls.find((c) => c.kind === kind)!
  return { width: call.width, height: call.height }
}

describe('the sizes an export draws its cards at', () => {
  it('draws in the EXPORT’s shape when it differs, though the pixel count is the same', () => {
    // 1920×1080 and 1080×1920 are the same area — which is why an area test missed it.
    const { stills, runs } = exportBakeSizes({ width: 1920, height: 1080 }, { width: 1080, height: 1920 })
    expect(stills).toEqual({ width: 1080, height: 1920 })
    expect(runs).toEqual({ width: 1080, height: 1920 })
  })

  it('draws stills at 4K for a 4K export, and keeps picture runs to the canvas’s pixels', () => {
    const { stills, runs } = exportBakeSizes({ width: 1920, height: 1080 }, { width: 3840, height: 2160 })
    expect(stills).toEqual({ width: 3840, height: 2160 })
    expect(runs).toEqual({ width: 1920, height: 1080 })
  })

  it('draws smaller for a smaller export', () => {
    const { stills, runs } = exportBakeSizes({ width: 1920, height: 1080 }, { width: 1280, height: 720 })
    expect(stills).toEqual({ width: 1280, height: 720 })
    expect(runs).toEqual({ width: 1280, height: 720 })
  })

  it('keeps a portrait 4K run portrait while bringing it down to the canvas’s pixels', () => {
    const { runs } = exportBakeSizes({ width: 1920, height: 1080 }, { width: 2160, height: 3840 })
    expect(runs.height).toBeGreaterThan(runs.width)
    expect(runs.width * runs.height).toBeLessThanOrEqual(1920 * 1080 + 4000)
    expect(runs.width % 2 + (runs.height % 2)).toBe(0)
  })
})

describe('baking for one export', () => {
  it('draws every card at the export’s canvas — a 16:9 edit through the 9:16 preset', async () => {
    const { bakers, calls } = fakeBakers()
    await bakeForExport(landscape(), { width: 1080, height: 1920 }, bakers)
    for (const kind of ['text', 'solid', 'title', 'paper', 'carousel']) {
      expect(sizeOf(calls, kind), kind).toEqual({ width: 1080, height: 1920 })
    }
  })

  it('points the copy at the export’s files, with their real sizes', async () => {
    const { bakers } = fakeBakers()
    const out = await bakeForExport(landscape(), { width: 1080, height: 1920 }, bakers)
    const card = out.assets.find((a) => a.id === 's')!
    expect(card.path).toBe(`/cache/${exportKey('card')}.png`)
    expect({ width: card.width, height: card.height }).toEqual({ width: 1080, height: 1920 })
    const news = out.assets.find((a) => a.id === 'p')!
    expect(news.frames).toEqual({ pattern: `/cache/${exportKey('news')}.seq/%05d.png`, count: 60 })
    // A still caption has no frames — it must not inherit the edit's old ones.
    const words = out.assets.find((a) => a.id === 't')!
    expect(words.frames).toBeUndefined()
  })

  it('never writes to the edit: the project handed in is unchanged, and its files untouched', async () => {
    const { bakers, calls } = fakeBakers()
    const edit = landscape()
    const before = structuredClone(edit)
    await bakeForExport(edit, { width: 1080, height: 1920 }, bakers)
    expect(edit).toEqual(before)
    // Every file drawn is the export's own, never a name the edit points at.
    for (const call of calls) expect(call.key.endsWith('-export'), call.key).toBe(true)
  })

  it('leaves footage alone', async () => {
    const { bakers } = fakeBakers()
    const edit = landscape()
    const out = await bakeForExport(edit, { width: 1080, height: 1920 }, bakers)
    expect(out.assets.find((a) => a.id === 'video')).toBe(edit.assets.find((a) => a.id === 'video'))
    expect(out.clips).toBe(edit.clips)
  })

  it('uses a card’s last picture when it will not redraw, and says so', async () => {
    const { bakers } = fakeBakers([exportKey('card')])
    const heard: string[] = []
    const edit = landscape()
    const out = await bakeForExport(edit, { width: 1080, height: 1920 }, bakers, (c) => heard.push(c.id))
    expect(heard).toEqual(['card'])
    expect(out.assets.find((a) => a.id === 's')).toEqual(edit.assets.find((a) => a.id === 's'))
    // And the rest were still drawn.
    expect(out.assets.find((a) => a.id === 't')!.path).toBe(`/cache/${exportKey('words')}.png`)
  })
})

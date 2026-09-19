import { describe, it, expect } from 'vitest'
import { acceptsKind, DRAG_MIME, type DragPayload } from '@shared/dragPayload'

const payload = (kind: DragPayload['kind']): DragPayload => ({
  kind,
  file: `x/${kind}.png`,
  name: kind
})

describe('drop acceptance', () => {
  it('sends sounds to audio tracks only', () => {
    expect(acceptsKind(payload('sfx'), 'audio')).toBe(true)
    expect(acceptsKind(payload('sfx'), 'video')).toBe(false)
  })

  it('sends pictures to video tracks only', () => {
    for (const kind of ['prop', 'sticker', 'title'] as const) {
      expect(acceptsKind(payload(kind), 'video')).toBe(true)
      expect(acceptsKind(payload(kind), 'audio')).toBe(false)
    }
  })

  it('keeps transitions on video tracks, where cuts live', () => {
    expect(acceptsKind(payload('transition'), 'video')).toBe(true)
    expect(acceptsKind(payload('transition'), 'audio')).toBe(false)
  })

  it('uses a private MIME type so external file drops stay distinguishable', () => {
    // A Finder drop must import media; a library drop must place an asset. They
    // are different operations and cannot share text/plain.
    expect(DRAG_MIME).toMatch(/^application\//)
    expect(DRAG_MIME).not.toBe('text/plain')
  })
})

describe('dragging out of the media pool', () => {
  it('sends a sound to an audio track and a picture to a video one', () => {
    /*
     * `kind` only says where the drag came from — the library or the pool —
     * so it cannot answer this on its own. A pool asset carries what it
     * actually is alongside it.
     */
    const song: DragPayload = { kind: 'media', file: '/x/a.mp3', name: 'song', assetId: 'a1', mediaKind: 'audio' }
    const photo: DragPayload = { kind: 'media', file: '/x/a.jpg', name: 'photo', assetId: 'a2', mediaKind: 'image' }
    const shot: DragPayload = { kind: 'media', file: '/x/a.mp4', name: 'shot', assetId: 'a3', mediaKind: 'video' }

    expect(acceptsKind(song, 'audio')).toBe(true)
    expect(acceptsKind(song, 'video')).toBe(false)
    expect(acceptsKind(photo, 'video')).toBe(true)
    expect(acceptsKind(photo, 'audio')).toBe(false)
    expect(acceptsKind(shot, 'video')).toBe(true)
    expect(acceptsKind(shot, 'audio')).toBe(false)
  })

  it('leaves every library kind exactly as it was', () => {
    // Widening `kind` must not quietly change where a sticker or a transition
    // is allowed to land.
    const of = (kind: DragPayload['kind']): DragPayload => ({ kind, file: 'f', name: 'n' })
    expect(acceptsKind(of('sfx'), 'audio')).toBe(true)
    expect(acceptsKind(of('sfx'), 'video')).toBe(false)
    expect(acceptsKind(of('transition'), 'video')).toBe(true)
    expect(acceptsKind(of('sticker'), 'video')).toBe(true)
    expect(acceptsKind(of('prop'), 'video')).toBe(true)
    expect(acceptsKind(of('title'), 'video')).toBe(true)
    expect(acceptsKind(of('title'), 'audio')).toBe(false)
  })
})

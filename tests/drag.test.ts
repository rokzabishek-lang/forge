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

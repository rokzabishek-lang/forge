import { describe, it, expect } from 'vitest'
import {
  STILL,
  TEXT_ANIMATIONS,
  animationFrames,
  piecesOf,
  stepAt,
  textAnimationById,
  type TextAnimation
} from '@shared/render/textAnimation'

/*
 * How the words arrive.
 *
 * An animation is a tiny pure function — (progress, index, count) to a
 * displacement — and everything expensive downstream is decided by it: how many
 * frames the export bakes, when the preview may stop redrawing, whether the
 * last word ever reaches its place. So the properties worth guarding are not
 * the shapes of the curves but the promises the rest of the system makes on
 * their behalf.
 */

const find = (id: string): TextAnimation => {
  const animation = textAnimationById(id)
  if (!animation) throw new Error(`no animation ${id}`)
  return animation
}

describe('the library', () => {
  it('has unique ids', () => {
    const ids = TEXT_ANIMATIONS.map((a) => a.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('gives every animation a name and a reason to exist', () => {
    for (const a of TEXT_ANIMATIONS) {
      expect(a.name.length, a.id).toBeGreaterThan(0)
      expect(a.description.length, a.id).toBeGreaterThan(10)
    }
  })

  it('keeps every move short enough to catch a scroll', () => {
    // A caption that takes a second to arrive has already lost the viewer it
    // was supposed to stop.
    for (const a of TEXT_ANIMATIONS) {
      expect(a.seconds, a.id).toBeGreaterThan(0)
      expect(a.seconds, a.id).toBeLessThanOrEqual(0.6)
      expect(a.stagger, a.id).toBeGreaterThanOrEqual(0)
      expect(a.stagger, a.id).toBeLessThanOrEqual(1)
    }
  })

  it('unknown ids resolve to nothing rather than throwing', () => {
    expect(textAnimationById('not-an-animation')).toBeNull()
    expect(textAnimationById(undefined)).toBeNull()
  })
})

describe('every animation', () => {
  it('ends exactly where the type is set', () => {
    // The last baked frame is held for the rest of the clip by `tpad`. If an
    // animation did not settle on STILL, the words would sit permanently
    // wherever it happened to stop — offset, shrunk or half transparent — for
    // the whole caption.
    for (const a of TEXT_ANIMATIONS) {
      expect(stepAt(a, 1000, 30, 0, 3), a.id).toEqual(STILL)
    }
  })

  it('starts somewhere other than where it ends', () => {
    // An animation whose first frame is already the final one is not an
    // animation; it would bake frames that all look the same.
    for (const a of TEXT_ANIMATIONS) {
      expect(stepAt(a, 0, 30, 0, 3), a.id).not.toEqual(STILL)
    }
  })

  it('never asks for a scale that would vanish or blow up the line', () => {
    for (const a of TEXT_ANIMATIONS) {
      for (let frame = 0; frame <= 60; frame++) {
        const step = stepAt(a, frame, 60, 0, 4)
        expect(step.scale, `${a.id} @${frame}`).toBeGreaterThan(0.05)
        expect(step.scale, `${a.id} @${frame}`).toBeLessThan(3)
        expect(step.alpha, `${a.id} @${frame}`).toBeGreaterThanOrEqual(0)
        expect(step.alpha, `${a.id} @${frame}`).toBeLessThanOrEqual(1)
      }
    }
  })

  it('has every piece settled by the time the baked frames run out', () => {
    /*
     * The load-bearing promise of the whole design.
     *
     * `animationFrames` decides how many frames are drawn and written; the last
     * one is then held forever. If any piece were still moving at that frame,
     * the export would freeze it mid-flight and no test of the curves would
     * have noticed.
     */
    const fps = 30
    for (const a of TEXT_ANIMATIONS) {
      for (const count of [1, 2, 5, 12]) {
        const last = animationFrames(a, fps, count) - 1
        for (let index = 0; index < count; index++) {
          expect(stepAt(a, last, fps, index, count), `${a.id} piece ${index}/${count}`).toEqual(
            STILL
          )
        }
      }
    }
  })
})

describe('stagger', () => {
  it('starts the first piece immediately and the last one latest', () => {
    const rise = find('rise')
    const first = stepAt(rise, 4, 30, 0, 4)
    const last = stepAt(rise, 4, 30, 3, 4)
    // Both are still arriving, but the last one has further to go.
    expect(Math.abs(last.dy)).toBeGreaterThan(Math.abs(first.dy))
  })

  it('moves a single piece as one, with no offset to spread', () => {
    const rise = find('rise')
    expect(stepAt(rise, 0, 30, 0, 1)).toEqual(rise.at(0))
  })

  it('costs no extra frames when there is only one piece', () => {
    for (const a of TEXT_ANIMATIONS) {
      const one = animationFrames(a, 30, 1)
      const many = animationFrames(a, 30, 8)
      expect(one, a.id).toBeLessThanOrEqual(many)
      if (a.stagger > 0) expect(many, a.id).toBeGreaterThan(one)
    }
  })
})

describe('animationFrames', () => {
  it('bakes a fraction of a three-second caption', () => {
    // The entire reason this is affordable: a caption on screen for three
    // seconds at 30fps is ninety frames, and a pop costs about fifteen.
    const pop = find('pop')
    expect(animationFrames(pop, 30, 4)).toBeLessThan(90 / 3)
  })

  it('never returns nothing to draw', () => {
    for (const a of TEXT_ANIMATIONS) {
      expect(animationFrames(a, 1, 1), a.id).toBeGreaterThanOrEqual(1)
      expect(Number.isInteger(animationFrames(a, 30, 3)), a.id).toBe(true)
    }
  })

  it('scales with the frame rate', () => {
    const pop = find('pop')
    expect(animationFrames(pop, 60, 3)).toBeGreaterThan(animationFrames(pop, 30, 3))
  })
})

describe('piecesOf', () => {
  it('keeps a block whole', () => {
    expect(piecesOf('two words', 'block')).toEqual(['two words'])
  })

  it('splits characters, spaces included', () => {
    expect(piecesOf('ab c', 'char')).toEqual(['a', 'b', ' ', 'c'])
  })

  it('keeps the gaps when splitting words', () => {
    // The pieces are re-joined to lay the line out, so dropping the spaces
    // would run the words together.
    expect(piecesOf('one two', 'word').join('')).toBe('one two')
  })

  it('never produces an empty piece', () => {
    for (const scope of ['word', 'char', 'block'] as const) {
      for (const piece of piecesOf('  spaced  out  ', scope)) {
        expect(piece.length, scope).toBeGreaterThan(0)
      }
    }
  })

  it('survives text with nothing in it', () => {
    expect(piecesOf('', 'word')).toEqual([])
    expect(piecesOf('', 'char')).toEqual([])
  })
})

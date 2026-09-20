import { describe, it, expect } from 'vitest'
import {
  DEFAULT_CAROUSEL,
  carouselCameraZ,
  carouselCards,
  carouselSettings,
  carouselTilt,
  carouselTurnSeconds
} from '@shared/render/carousel'

/*
 * A ring of cards, as numbers.
 *
 * Tested without three.js on purpose — the geometry is where this goes wrong
 * and a GPU cannot tell you that a partial arc is hanging off to one side or
 * that the front card is facing away. Those are arithmetic, and arithmetic is
 * assertable.
 */

/** The nearest card to the camera, which looks down −Z from +Z. */
const front = (cards: ReturnType<typeof carouselCards>) =>
  cards.reduce((best, c) => (c.position.z > best.position.z ? c : best))

describe('carouselCards', () => {
  it('puts every card on the ring', () => {
    const cards = carouselCards({ cards: 8, radius: 3 }, 0)
    expect(cards).toHaveLength(8)
    for (const card of cards) {
      const r = Math.hypot(card.position.x, card.position.z)
      expect(r).toBeCloseTo(3, 6)
      expect(card.position.y).toBe(0)
    }
  })

  it('centres a partial arc on the front of frame', () => {
    /*
     * The bug this prevents: spreading from angle zero instead of around it
     * hangs a shallow fan off to one side, so the middle of the picture —
     * the thing the viewer is looking straight at — is a gap. Costs half a
     * term and is the difference between a fan and a mistake.
     */
    const cards = carouselCards({ cards: 5, arc: 0.25, radius: 3 }, 0)
    const xs = cards.map((c) => c.position.x)
    // Symmetric about the centre line.
    expect(Math.min(...xs) + Math.max(...xs)).toBeCloseTo(0, 5)
    // And the nearest card really is near the middle.
    expect(Math.abs(front(cards).position.x)).toBeLessThan(0.7)
  })

  it('rates the front card highest and the back card lowest', () => {
    const cards = carouselCards({ cards: 8, arc: 1 }, 0)
    const nearest = front(cards)
    const farthest = cards.reduce((worst, c) => (c.position.z < worst.position.z ? c : worst))
    expect(nearest.facing).toBeGreaterThan(0.9)
    expect(farthest.facing).toBeLessThan(0.1)
    for (const card of cards) {
      expect(card.facing).toBeGreaterThanOrEqual(0)
      expect(card.facing).toBeLessThanOrEqual(1)
    }
  })

  it('sorts far to near', () => {
    // So a renderer drawing in order composites correctly even with no depth
    // buffer, and so "which card is in front" has an answer.
    const cards = carouselCards({ cards: 10 }, 0.3)
    for (let i = 1; i < cards.length; i++) {
      expect(cards[i].position.z).toBeGreaterThanOrEqual(cards[i - 1].position.z)
    }
  })

  it('turns over time, and returns to where it started', () => {
    const at0 = front(carouselCards({ cards: 6, spin: 0.25 }, 0))
    const quarter = front(carouselCards({ cards: 6, spin: 0.25 }, 1))
    expect(quarter.index).not.toBe(at0.index)

    // One full turn is 1/spin seconds; the ring must be back where it began.
    const full = carouselCards({ cards: 6, spin: 0.25 }, 4)
    const start = carouselCards({ cards: 6, spin: 0.25 }, 0)
    for (let i = 0; i < full.length; i++) {
      expect(full[i].position.x).toBeCloseTo(start[i].position.x, 4)
      expect(full[i].position.z).toBeCloseTo(start[i].position.z, 4)
    }
  })

  it('stands still at zero spin', () => {
    const a = carouselCards({ spin: 0 }, 0)
    const b = carouselCards({ spin: 0 }, 9)
    expect(b).toEqual(a)
  })

  it('faces cards outward along the ring, or square to the camera', () => {
    const outward = carouselCards({ cards: 4, facingCamera: false }, 0)
    const square = carouselCards({ cards: 4, facingCamera: true }, 0)
    expect(new Set(square.map((c) => c.rotation.y))).toEqual(new Set([0]))
    expect(new Set(outward.map((c) => c.rotation.y)).size).toBeGreaterThan(1)
  })

  it('never puts two cards in the same place', () => {
    // Cards intersecting is the failure that reads as a rendering glitch
    // rather than as a layout bug.
    const cards = carouselCards({ cards: 12, radius: 3 }, 0)
    for (let i = 1; i < cards.length; i++) {
      const a = cards[i - 1].position
      const b = cards[i].position
      expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThan(0.01)
    }
  })

  it('handles a single card without dividing by anything', () => {
    const [only] = carouselCards({ cards: 1, arc: 0.3 }, 0)
    expect(only.position.x).toBeCloseTo(0, 6)
    expect(only.facing).toBeGreaterThan(0.99)
  })

  it('refuses nonsense rather than producing NaN', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -5]) {
      const cards = carouselCards(
        { cards: bad, radius: bad, arc: bad, spin: bad, cardWidth: bad },
        bad
      )
      expect(cards.length).toBeGreaterThan(0)
      for (const card of cards) {
        expect(Number.isFinite(card.position.x)).toBe(true)
        expect(Number.isFinite(card.position.z)).toBe(true)
        expect(Number.isFinite(card.rotation.y)).toBe(true)
        expect(card.width).toBeGreaterThan(0)
        expect(card.height).toBeGreaterThan(0)
      }
    }
  })
})

describe('carouselSettings', () => {
  it('is the defaults when nothing is given', () => {
    expect(carouselSettings({})).toEqual(DEFAULT_CAROUSEL)
  })

  it('clamps every slider into a ring that can exist', () => {
    const wild = carouselSettings({ cards: 9999, radius: -4, arc: 8, aspect: 0 })
    expect(wild.cards).toBeLessThanOrEqual(40)
    expect(wild.radius).toBeGreaterThan(0)
    expect(wild.arc).toBeLessThanOrEqual(1)
    expect(wild.aspect).toBeGreaterThan(0)
  })
})

describe('the camera', () => {
  it('backs off far enough to see the whole ring', () => {
    /*
     * Derived rather than set. A radius slider that silently pushed the ring
     * out of frame would read as the ring vanishing, not as the camera being
     * too close — the failure would show up somewhere other than the control
     * that caused it.
     */
    for (const radius of [1, 3, 8, 20]) {
      const z = carouselCameraZ({ radius, cardWidth: 1.6 }, 45)
      const cards = carouselCards({ radius, cardWidth: 1.6, cards: 8 }, 0)
      const widest = Math.max(...cards.map((c) => Math.abs(c.position.x))) + 1.6 / 2
      // Half the frustum width at the ring's own depth must cover it.
      const halfWidth = Math.tan((45 / 2) * (Math.PI / 180)) * (z - radius)
      expect(halfWidth).toBeGreaterThanOrEqual(widest - 1e-6)
    }
  })

  it('moves back as the ring grows', () => {
    expect(carouselCameraZ({ radius: 8 })).toBeGreaterThan(carouselCameraZ({ radius: 2 }))
  })
})

describe('tilt and timing', () => {
  it('tilts the whole ring, not each card', () => {
    const tilt = carouselTilt({ tilt: 0.05, roll: -0.02 })
    expect(tilt.x).toBeCloseTo(0.05 * Math.PI * 2, 6)
    expect(tilt.z).toBeCloseTo(-0.02 * Math.PI * 2, 6)
    // Cards themselves stay upright; only the group leans.
    for (const card of carouselCards({ tilt: 0.05 }, 0)) expect(card.rotation.x).toBe(0)
  })

  it('reports how long a full turn takes', () => {
    expect(carouselTurnSeconds({ spin: 0.25 })).toBeCloseTo(4, 6)
    expect(carouselTurnSeconds({ spin: -0.5 })).toBeCloseTo(2, 6)
    expect(carouselTurnSeconds({ spin: 0 })).toBe(0)
  })
})

/**
 * Photographs as cards on a ring, in 3D.
 *
 * `docs/REFERENCES.md` §2 — the MachiCut recording, whose own control panel
 * named every parameter worth having: curvature, spacing, visible arc, cards,
 * corner, and an X-tilt / Y-spin / Z-roll. This is that, and the names are
 * kept because they came from a tool people actually use.
 *
 * **Nothing here imports three.js.** This module works out where each card
 * goes and which way it faces, in ordinary numbers; the renderer turns that
 * into meshes. That split is the same one `paper.ts` has and it exists for the
 * same reason — a ring is a dozen interacting measurements and every way of
 * getting them wrong produces a picture that looks deliberate. Being able to
 * assert "the front card faces the camera" and "cards never intersect" without
 * a GPU is the only way to know.
 *
 * It also means the geometry is testable in `tsconfig.node.json`, which does
 * not compile the renderer at all.
 */

/** A point or a rotation in 3D. */
export interface Vec3 {
  x: number
  y: number
  z: number
}

export interface Card {
  /** Which asset this card shows, as an index into the spec's list. */
  index: number
  position: Vec3
  /** Euler rotation in radians, applied XYZ. */
  rotation: Vec3
  /** Card size in world units. */
  width: number
  height: number
  /**
   * 0 at the back of the ring, 1 dead centre front.
   *
   * The renderer fades and dims by this rather than culling: a card that
   * vanishes at the edge of the arc pops, and a ring that pops reads as
   * dropped frames rather than as depth.
   */
  facing: number
}

export interface CarouselSpec {
  /** How many cards. The photographs repeat if there are fewer. */
  cards: number
  /** Ring radius in world units. Bigger is a wider, flatter sweep. */
  radius: number
  /** Card width in world units; height follows `aspect`. */
  cardWidth: number
  /** Card height ÷ width. 1.4 is a portrait photo. */
  aspect: number
  /**
   * How much of the ring is in front of the camera, in turns (0..1).
   *
   * The MachiCut panel calls it VISIBLE ARC. Below 1 the cards are spread over
   * part of the circle rather than all of it, which is what makes a shallow
   * fan rather than a full carousel.
   */
  arc: number
  /** Turns per second. Negative spins the other way. */
  spin: number
  /** Where the ring starts, in turns. */
  offset: number
  /** X-tilt, Y-spin and Z-roll of the whole ring, in turns. */
  tilt: number
  roll: number
  /** Cards face the camera rather than outward along the ring. */
  facingCamera: boolean
}

export const DEFAULT_CAROUSEL: CarouselSpec = {
  cards: 8,
  radius: 3.2,
  cardWidth: 1.6,
  aspect: 1.4,
  arc: 1,
  spin: 0.18,
  offset: 0,
  tilt: 0.03,
  roll: 0,
  facingCamera: false
}

const TAU = Math.PI * 2

function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, value))
}

/** Every setting made sane, so a slider cannot produce a degenerate ring. */
export function carouselSettings(spec: Partial<CarouselSpec>): CarouselSpec {
  return {
    cards: Math.round(clamp(spec.cards, DEFAULT_CAROUSEL.cards, 1, 40)),
    radius: clamp(spec.radius, DEFAULT_CAROUSEL.radius, 0.5, 20),
    cardWidth: clamp(spec.cardWidth, DEFAULT_CAROUSEL.cardWidth, 0.1, 10),
    aspect: clamp(spec.aspect, DEFAULT_CAROUSEL.aspect, 0.2, 5),
    arc: clamp(spec.arc, DEFAULT_CAROUSEL.arc, 0.05, 1),
    spin: clamp(spec.spin, DEFAULT_CAROUSEL.spin, -3, 3),
    offset: clamp(spec.offset, DEFAULT_CAROUSEL.offset, -10, 10),
    tilt: clamp(spec.tilt, DEFAULT_CAROUSEL.tilt, -0.25, 0.25),
    roll: clamp(spec.roll, DEFAULT_CAROUSEL.roll, -0.5, 0.5),
    facingCamera: spec.facingCamera ?? DEFAULT_CAROUSEL.facingCamera
  }
}

/**
 * Where every card is at a moment in time.
 *
 * The camera looks down −Z from the origin, so the FRONT of the ring is the
 * nearest point on +Z. A card at angle 0 sits there and faces the camera; the
 * rest are spread around by `arc`.
 */
export function carouselCards(spec: Partial<CarouselSpec>, seconds: number): Card[] {
  const s = carouselSettings(spec)
  const turn = s.offset + (Number.isFinite(seconds) ? seconds : 0) * s.spin
  const cards: Card[] = []

  for (let i = 0; i < s.cards; i++) {
    /*
     * Spread across the arc, CENTRED on the front.
     *
     * Spread from zero instead and a partial arc hangs off to one side with
     * nothing in the middle of frame — the thing the user is looking straight
     * at is a gap. Centring costs half a term and is the difference between a
     * fan and a mistake.
     */
    /*
     * A closed ring and an open fan need different denominators.
     *
     * On a FULL circle the ends wrap, so the last card must stop one step
     * short of the first or the two sit on top of each other — that is
     * `i / cards`. On a partial arc the ends are distinct and both should be
     * ON the arc, which is `i / (cards - 1)`. Using `cards` for both looks
     * right and is not: the last card stops short, so the whole fan is
     * biased sideways and the middle of frame is off-centre.
     */
    const closed = s.arc >= 1
    const denom = closed ? s.cards : Math.max(1, s.cards - 1)
    const spread = s.cards === 1 ? 0 : (i / denom - 0.5) * s.arc
    const angle = (spread + turn) * TAU

    const position: Vec3 = {
      x: Math.sin(angle) * s.radius,
      y: 0,
      z: Math.cos(angle) * s.radius
    }

    /*
     * `facing` is the cosine of the angle from the front, remapped to 0..1.
     * A card at the front is 1, one at the back is 0, and it changes smoothly
     * all the way round — which is what the renderer fades by.
     */
    const facing = (Math.cos(angle) + 1) / 2

    cards.push({
      index: i,
      position,
      rotation: {
        x: 0,
        // Outward along the ring, or square to the camera. Outward is the
        // carousel; square is a flat fan of cards that all face you.
        y: s.facingCamera ? 0 : angle,
        z: 0
      },
      width: s.cardWidth,
      height: s.cardWidth * s.aspect,
      facing
    })
  }

  /*
   * Far to near, so a renderer drawing in order composites correctly even
   * without a depth buffer — and so "which card is in front" is answerable.
   *
   * Tie-broken on index, and that is not tidiness. Cards at mirrored angles
   * share a z exactly, so their order is otherwise decided by whatever the
   * sort happens to do with equal keys: two coincident cards could swap
   * between frames, which on screen is a flicker with no cause you could
   * find.
   */
  const EPS = 1e-6
  return cards.sort((a, b) => {
    const dz = a.position.z - b.position.z
    // Compared against an epsilon, not against zero. Two mirrored cards are
    // at the same depth in arithmetic and a hair apart in floating point, so
    // `dz || index` never reaches the tie-break — the order still flips on
    // noise, which is exactly the flicker this was written to stop.
    return Math.abs(dz) > EPS ? dz : a.index - b.index
  })
}

/** The whole ring's own rotation, applied to the group rather than per card. */
export function carouselTilt(spec: Partial<CarouselSpec>): Vec3 {
  const s = carouselSettings(spec)
  return { x: s.tilt * TAU, y: 0, z: s.roll * TAU }
}

/**
 * How far back the camera must sit to see the whole ring.
 *
 * Derived rather than set, because a radius slider that silently pushed the
 * ring out of frame would read as the ring vanishing. `fov` in degrees.
 */
export function carouselCameraZ(spec: Partial<CarouselSpec>, fov = 45): number {
  const s = carouselSettings(spec)
  const half = (fov / 2) * (Math.PI / 180)
  // The widest thing to fit is the ring plus a card either side of it.
  const extent = s.radius + s.cardWidth
  return s.radius + extent / Math.tan(half)
}

/** How long one full turn takes, for choosing a clip length. */
export function carouselTurnSeconds(spec: Partial<CarouselSpec>): number {
  const s = carouselSettings(spec)
  return s.spin === 0 ? 0 : Math.abs(1 / s.spin)
}

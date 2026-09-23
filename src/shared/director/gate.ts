import type { Look } from './look'
import type { Slot } from './menu'

/**
 * The quality gate — the objective checks turned into decisions (docs/PLAN.md §4.3).
 *
 * The sidecar's `vision.measure` returns numbers; this says what they mean,
 * RELATIVE TO THE SET, and decides three things before the model is asked:
 * which near-copies to leave out, which photos may never be the hero, and
 * which may. Pure, and blind to where the numbers came from, so every rule is
 * a test.
 *
 * Where the VLM's look and a measurement disagree about what the measurement
 * measures, the measurement wins: a small model shown a 640-px thumbnail
 * cannot see blur, and a photo it calls "strong" that the Laplacian calls soft
 * is not a candidate.
 */

/** One photo's measurement, as `vision.measure` returns it. */
export interface Measure {
  sharpness: number
  luma: number
  lumaStd: number
  darkClip: number
  brightClip: number
  /** 64-bit dHash as hex; null for a flat picture, whose hash would mean nothing. */
  dhash: string | null
  width: number
  height: number
}

/** Softer than this share of the set's median sharpness is soft. Relative: a soft-focus set is a look. */
export const SOFT_RATIO = 0.35
/** Mean luma below this is too dark to lead an ad. */
export const DARK_LUMA = 0.18
/** More than this share of pixels clipped to white is blown. */
export const BLOWN_CLIP = 0.06
/** dHashes this close are the same picture. */
export const DUPLICATE_BITS = 6

export type Flag = 'soft' | 'dark' | 'blown'

export interface GateOptions {
  /** The recipe's hero must have people in it (wedding). */
  wantsPeople: boolean
}

export interface GatedSlot extends Slot {
  measure?: Measure
  look?: Look
  flags: Flag[]
}

export interface GateResult {
  slots: GatedSlot[]
  /** Slot ids the spine may name as hero, best first. Never empty when there is a slot. */
  heroCandidates: string[]
  leftOut: { slot: string; why: string }[]
  /** When no photo passed the whole filter: which rule gave way, in order. */
  loosened: string[]
}

export function hamming(a: string, b: string): number {
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`)
  let n = 0
  while (x > 0n) {
    n += Number(x & 1n)
    x >>= 1n
  }
  return n
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const v = [...values].sort((a, b) => a - b)
  const m = Math.floor(v.length / 2)
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2
}

/** Soft, dark, blown — measured, never guessed. A photo with no measurement has no flags. */
export function flagsFor(measure: Measure | undefined, setMedianSharpness: number): Flag[] {
  if (!measure) return []
  const flags: Flag[] = []
  if (setMedianSharpness > 0 && measure.sharpness < SOFT_RATIO * setMedianSharpness) flags.push('soft')
  if (measure.luma < DARK_LUMA) flags.push('dark')
  if (measure.brightClip > BLOWN_CLIP) flags.push('blown')
  return flags
}

/** Better first: sharper, then exposure nearer the middle, then the user's order. */
function byQuality(a: GatedSlot, b: GatedSlot): number {
  const sa = a.measure?.sharpness ?? 0
  const sb = b.measure?.sharpness ?? 0
  if (sa !== sb) return sb - sa
  const ea = Math.abs((a.measure?.luma ?? 0.5) - 0.5)
  const eb = Math.abs((b.measure?.luma ?? 0.5) - 0.5)
  if (ea !== eb) return ea - eb
  return 0
}

export function gate(
  slots: Slot[],
  looks: Record<string, Look | undefined>,
  measures: Record<string, Measure | undefined>,
  options: GateOptions
): GateResult {
  const images = slots.filter((s) => s.kind === 'image')
  const setMedian = median(images.map((s) => measures[s.assetId]?.sharpness).filter((v): v is number => typeof v === 'number'))

  const gated: GatedSlot[] = slots.map((s) => {
    const measure = measures[s.assetId]
    const look = looks[s.assetId]
    return {
      ...s,
      ...(measure ? { measure } : {}),
      ...(look ? { look } : {}),
      flags: s.kind === 'image' ? flagsFor(measure, setMedian) : []
    }
  })

  /* 1. Near-copies: of each pair, the softer goes, and says which it copied. */
  const leftOut: GateResult['leftOut'] = []
  const gone = new Set<string>()
  for (let i = 0; i < gated.length; i++) {
    for (let j = i + 1; j < gated.length; j++) {
      const a = gated[i]
      const b = gated[j]
      if (gone.has(a.id) || gone.has(b.id)) continue
      if (!a.measure?.dhash || !b.measure?.dhash) continue
      if (hamming(a.measure.dhash, b.measure.dhash) > DUPLICATE_BITS) continue
      // The softer of the two; on a tie, the later one, so the user's first choice stays.
      const [keep, drop] = a.measure.sharpness >= b.measure.sharpness ? [a, b] : [b, a]
      gone.add(drop.id)
      leftOut.push({ slot: drop.id, why: `near-duplicate of ${keep.id} (${keep.id} is sharper)` })
    }
  }
  const survivors = gated.filter((s) => !gone.has(s.id))

  /* 2–4. Candidates: unflagged, a look that is not weak, people when the recipe wants them. */
  const lookOk = (s: GatedSlot): boolean => !s.look || s.look.hero !== 'weak'
  const people = (s: GatedSlot): boolean => !options.wantsPeople || !s.look || s.look.people !== 'none'
  const anyLooks = survivors.some((s) => s.look)
  // With no looks at all, a clip cannot be judged, so only the stills are candidates — unless there are no stills.
  const judgeable = (s: GatedSlot): boolean => anyLooks || s.kind === 'image' || !survivors.some((x) => x.kind === 'image')

  const loosened: string[] = []
  let pool = survivors.filter((s) => judgeable(s) && s.flags.length === 0 && lookOk(s) && people(s))
  if (pool.length === 0 && options.wantsPeople) {
    loosened.push('no clean photo had people in it — the people rule gave way')
    pool = survivors.filter((s) => judgeable(s) && s.flags.length === 0 && lookOk(s))
  }
  if (pool.length === 0) {
    loosened.push('no clean photo was well exposed — the exposure rule gave way')
    pool = survivors.filter((s) => judgeable(s) && !s.flags.includes('soft') && lookOk(s))
  }
  if (pool.length === 0 && survivors.length > 0) {
    loosened.push('no photo passed — the sharpest one stands in')
    pool = [[...survivors].sort(byQuality)[0]]
  }

  const heroCandidates = [...pool].sort((a, b) => {
    // A look that calls it strong outranks one that calls it usable; then the measurements.
    const rank = (s: GatedSlot): number => (s.look?.hero === 'strong' ? 0 : 1)
    return rank(a) - rank(b) || byQuality(a, b)
  }).map((s) => s.id)

  return { slots: survivors, heroCandidates, leftOut, loosened }
}

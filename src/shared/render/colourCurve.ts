/**
 * Colour curves — the grading tool, not the keyframe one.
 *
 * A curve maps input brightness to output brightness for a channel. It is what
 * a colourist reaches for before any LUT: lift the shadows, roll off the
 * highlights, put a little blue in the blacks.
 *
 * Two facts about ffmpeg's `curves` filter, both measured against the binary
 * rather than taken from documentation, because getting either wrong makes the
 * preview disagree with the export:
 *
 *  1. It interpolates with a NATURAL CUBIC SPLINE, not linearly. Through
 *     (0,0), (0.5,0.75), (1,1) the value at x=0.75 is 0.921875 — a straight line
 *     would give 0.875. The spline overshoots, and that overshoot is the look.
 *  2. Per-channel curves are applied FIRST, and the master curve on top of the
 *     result. Probing a grey pixel with a red curve gave 0xC0; adding the same
 *     curve as master gave 0xEB, which is the master curve evaluated at 0.75.
 */

export interface CurvePoint {
  /** Input level, 0..1. */
  x: number
  /** Output level, 0..1. */
  y: number
}

export type CurveChannel = 'master' | 'r' | 'g' | 'b'

export const CURVE_CHANNELS: CurveChannel[] = ['master', 'r', 'g', 'b']

export const CHANNEL_LABEL: Record<CurveChannel, string> = {
  master: 'RGB',
  r: 'Red',
  g: 'Green',
  b: 'Blue'
}

export type Curves = Partial<Record<CurveChannel, CurvePoint[]>>

/** A curve that does nothing: a straight line from black to white. */
export const IDENTITY: CurvePoint[] = [
  { x: 0, y: 0 },
  { x: 1, y: 1 }
]

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)

/** Sorted, clamped, de-duplicated, and always anchored at both ends. */
export function normaliseCurve(points: CurvePoint[]): CurvePoint[] {
  const sorted = [...points]
    .map((p) => ({ x: clamp01(p.x), y: clamp01(p.y) }))
    .sort((a, b) => a.x - b.x)

  const unique: CurvePoint[] = []
  for (const point of sorted) {
    // Two outputs for one input is not a curve, it is a contradiction.
    if (unique.length > 0 && Math.abs(unique[unique.length - 1].x - point.x) < 1e-6) unique.pop()
    unique.push(point)
  }

  if (unique.length === 0) return [...IDENTITY]
  // Anchored: ffmpeg extends the end segments flat, and a curve that starts at
  // 0.3 would silently crush everything below it.
  if (unique[0].x > 1e-6) unique.unshift({ x: 0, y: unique[0].y })
  if (unique[unique.length - 1].x < 1 - 1e-6) {
    unique.push({ x: 1, y: unique[unique.length - 1].y })
  }
  return unique
}

/** True when the curve leaves every level where it found it. */
export function isIdentityCurve(points: CurvePoint[] | undefined): boolean {
  if (!points || points.length === 0) return true
  const curve = normaliseCurve(points)
  if (curve.length !== 2) return false
  return (
    Math.abs(curve[0].x) < 1e-4 &&
    Math.abs(curve[0].y) < 1e-4 &&
    Math.abs(curve[1].x - 1) < 1e-4 &&
    Math.abs(curve[1].y - 1) < 1e-4
  )
}

export function isNeutralCurves(curves: Curves | undefined): boolean {
  if (!curves) return true
  return CURVE_CHANNELS.every((channel) => isIdentityCurve(curves[channel]))
}

/**
 * Evaluate the curve at `x`, matching ffmpeg exactly.
 *
 * Natural cubic spline: second derivative zero at both ends, solved with the
 * usual tridiagonal pass. Two points reduce to a straight line, which is what
 * the identity curve needs to stay identity.
 */
export function curveAt(points: CurvePoint[], x: number): number {
  const p = normaliseCurve(points)
  const n = p.length
  if (n === 0) return clamp01(x)
  if (n === 1) return clamp01(p[0].y)

  const at = clamp01(x)
  if (at <= p[0].x) return clamp01(p[0].y)
  if (at >= p[n - 1].x) return clamp01(p[n - 1].y)

  const m = secondDerivatives(p)

  // The segment holding `at`.
  let i = 0
  while (i < n - 2 && at > p[i + 1].x) i++

  const h = p[i + 1].x - p[i].x
  if (h <= 1e-9) return clamp01(p[i + 1].y)
  const t = at - p[i].x
  const b = (p[i + 1].y - p[i].y) / h - (h * (2 * m[i] + m[i + 1])) / 6
  const value = p[i].y + b * t + (m[i] / 2) * t * t + ((m[i + 1] - m[i]) / (6 * h)) * t * t * t
  return clamp01(value)
}

/** Natural cubic spline second derivatives, zero at both ends. */
function secondDerivatives(p: CurvePoint[]): number[] {
  const n = p.length
  const m = new Array<number>(n).fill(0)
  if (n < 3) return m

  const sub = new Array<number>(n).fill(0)
  const diag = new Array<number>(n).fill(0)
  const sup = new Array<number>(n).fill(0)
  const rhs = new Array<number>(n).fill(0)

  for (let i = 1; i < n - 1; i++) {
    const h0 = p[i].x - p[i - 1].x
    const h1 = p[i + 1].x - p[i].x
    sub[i] = h0
    diag[i] = 2 * (h0 + h1)
    sup[i] = h1
    rhs[i] = 6 * ((p[i + 1].y - p[i].y) / h1 - (p[i].y - p[i - 1].y) / h0)
  }

  // Thomas algorithm over the interior rows; the ends are zero by definition.
  for (let i = 2; i < n - 1; i++) {
    const factor = sub[i] / diag[i - 1]
    diag[i] -= factor * sup[i - 1]
    rhs[i] -= factor * rhs[i - 1]
  }
  for (let i = n - 2; i >= 1; i--) {
    m[i] = (rhs[i] - sup[i] * m[i + 1]) / diag[i]
  }
  return m
}

/**
 * Apply the whole set to one colour, in ffmpeg's order.
 *
 * Per-channel first, master on top — verified against the binary.
 */
export function applyCurves(
  curves: Curves | undefined,
  rgb: [number, number, number]
): [number, number, number] {
  if (!curves) return rgb
  const channel = (points: CurvePoint[] | undefined, value: number): number =>
    points && !isIdentityCurve(points) ? curveAt(points, value) : value

  const perChannel: [number, number, number] = [
    channel(curves.r, rgb[0]),
    channel(curves.g, rgb[1]),
    channel(curves.b, rgb[2])
  ]
  if (!curves.master || isIdentityCurve(curves.master)) return perChannel
  return [
    curveAt(curves.master, perChannel[0]),
    curveAt(curves.master, perChannel[1]),
    curveAt(curves.master, perChannel[2])
  ]
}

/** The filter argument for one channel: `0/0 0.5/0.75 1/1`. */
export function curveArgument(points: CurvePoint[]): string {
  return normaliseCurve(points)
    .map((p) => `${p.x.toFixed(4)}/${p.y.toFixed(4)}`)
    .join(' ')
}

/** The whole `curves=...` filter, or null when nothing would change. */
export function curvesFilter(curves: Curves | undefined): string | null {
  if (isNeutralCurves(curves)) return null
  const parts: string[] = []
  const named: Record<CurveChannel, string> = {
    master: 'master',
    r: 'r',
    g: 'g',
    b: 'b'
  }
  for (const channel of CURVE_CHANNELS) {
    const points = curves?.[channel]
    if (!points || isIdentityCurve(points)) continue
    parts.push(`${named[channel]}='${curveArgument(points)}'`)
  }
  return parts.length > 0 ? `curves=${parts.join(':')}` : null
}

/**
 * The curve set as a 256-entry lookup, for the GPU preview.
 *
 * Sampling once on the CPU and handing the shader a table is both faster and
 * exactly what ffmpeg does internally — it builds a 256-entry LUT too.
 */
export function sampleCurves(curves: Curves | undefined): Uint8Array {
  const table = new Uint8Array(256 * 4)
  for (let i = 0; i < 256; i++) {
    const level = i / 255
    const [r, g, b] = applyCurves(curves, [level, level, level])
    table[i * 4 + 0] = Math.round(clamp01(r) * 255)
    table[i * 4 + 1] = Math.round(clamp01(g) * 255)
    table[i * 4 + 2] = Math.round(clamp01(b) * 255)
    table[i * 4 + 3] = 255
  }
  return table
}

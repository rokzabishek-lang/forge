/**
 * Temperature and tint — white balance, as three channel gains.
 *
 * The one correction every wedding reel needs first: an indoor reception shot
 * under tungsten comes out orange, a cloudy ceremony blue, and no look fixes
 * that because a look is applied ON TOP of the colour it is given.
 *
 * Gains rather than a full matrix, because white balance IS a per-channel gain
 * — it is what a camera does. Temperature trades red against blue (warm is more
 * red, less blue); tint trades green against magenta. The three are then
 * normalised so a grey keeps its brightness (BT.709 luma weights), or warming
 * a shot would also brighten it.
 *
 * ONE function for both sides. The export feeds the gains to
 * `colorchannelmixer` (2013, safe on the 2018 Windows build — NOT
 * `colortemperature`, which merged in 2021 and is on the floor blocklist), and
 * the preview's WebGL grade multiplies by the same three numbers, so the two
 * cannot drift. Measured on the bundled binary: the mixer applies the gains
 * exactly, keeps the alpha plane of `yuva420p`, and supports `enable`, which an
 * adjustment layer needs.
 */

export interface Gains {
  r: number
  g: number
  b: number
}

/** Full temperature shifts red and blue by a quarter; full tint green by a fifth. */
const TEMPERATURE_SPAN = 0.25
const TINT_SPAN = 0.2

const clampUnit = (v: number | undefined): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0

/**
 * The gains for a temperature and a tint, each −1..1.
 *
 * Temperature +1 is warm (tungsten corrected the other way is −1); tint +1 is
 * magenta, −1 green. Zero for both is exactly 1, 1, 1.
 */
export function whiteBalanceGains(temperature?: number, tint?: number): Gains {
  const t = clampUnit(temperature)
  const k = clampUnit(tint)
  const r = 1 + TEMPERATURE_SPAN * t
  const g = 1 - TINT_SPAN * k
  const b = 1 - TEMPERATURE_SPAN * t
  // Keep a grey's luminance where it was.
  const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b
  return { r: r / luma, g: g / luma, b: b / luma }
}

export function isNeutralBalance(temperature?: number, tint?: number): boolean {
  return Math.abs(clampUnit(temperature)) < 0.001 && Math.abs(clampUnit(tint)) < 0.001
}

/** The export's half: a `colorchannelmixer`, or null when there is nothing to do. */
export function whiteBalanceFilter(temperature?: number, tint?: number): string | null {
  if (isNeutralBalance(temperature, tint)) return null
  const { r, g, b } = whiteBalanceGains(temperature, tint)
  return `colorchannelmixer=rr=${r.toFixed(4)}:gg=${g.toFixed(4)}:bb=${b.toFixed(4)}`
}

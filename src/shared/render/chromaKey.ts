/**
 * Chroma key — green or blue screen — and despill.
 *
 * The export keys with ffmpeg's `chromakey` (2015) and cleans the fringe with
 * `despill` (2017), both older than the 2018 Windows build. The preview's WebGL
 * grade has to key THE SAME pixels, so ffmpeg's arithmetic is written down here
 * once, measured rather than recalled, and both sides take their numbers from it.
 *
 * What was measured on the bundled binary (tests/integration/chromaKey.int.test.ts):
 *
 * - A pixel's chroma is the stream's own U and V. For a picture that arrived as
 *   RGB that is swscale's BT.601 limited-range conversion — pure green is
 *   (54, 34), exactly the textbook formula.
 * - The KEY colour is converted with the full-range (JPEG) formula in 10-bit
 *   fixed point — `RGB_TO_U`/`RGB_TO_V` in ffmpeg's colorspace.h — so pure green
 *   keys at (44, 21), not (54, 34). Copying the pixel formula for the key would
 *   put every key slightly off.
 * - The distance is `sqrt((du² + dv²) / (255² · 2))`, averaged over the pixel's
 *   3×3 neighbourhood, and alpha is `clip((d − similarity) / blend, 0, 1) · 255`,
 *   truncated — or a hard cut at `similarity` when blend is 0. These reproduce
 *   every measured alpha exactly (212, 237, 42, 57 among them).
 *
 * The preview decodes pictures to RGB in the browser, so it computes U and V
 * with the BT.601 matrix. Footage encoded BT.709 keys on its OWN chroma in
 * ffmpeg, so on such a file the edge of a key can sit a few percent differently
 * between the two — the export is the one to trust, and both use these numbers.
 */

export interface ChromaKey {
  /** The screen colour, `#rrggbb`. */
  color: string
  /** 0.01..0.5 — how far from the colour still counts as screen. */
  similarity: number
  /** 0..0.5 — how soft the edge is. 0 is a hard cut. */
  blend: number
  /** 0..1 — how much of the screen's colour to pull out of what is left. */
  despill: number
}

/** A typical chroma green, with settings that hold on a lit screen. */
export const DEFAULT_KEY: ChromaKey = { color: '#00b140', similarity: 0.12, blend: 0.08, despill: 0.6 }

export const SIMILARITY_RANGE = { min: 0.01, max: 0.5 } as const
export const BLEND_RANGE = { min: 0, max: 0.5 } as const

type RGB = [number, number, number]

/** `#rrggbb` (or `rrggbb`) as 0–255 channels; anything else is the default green. */
export function parseHex(color: string): RGB {
  const m = /^#?([0-9a-f]{6})$/i.exec(color.trim())
  const hex = m ? m[1] : DEFAULT_KEY.color.slice(1)
  return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)]
}

/**
 * The key colour's chroma, as ffmpeg's chromakey computes it: the JPEG
 * (full-range BT.601) formula in 10-bit fixed point, with its rounding.
 */
export function keyChroma(color: string): [number, number] {
  const [r, g, b] = parseHex(color)
  const FIX = (x: number): number => Math.round(x * 1024)
  const ONE_HALF = 1 << 9
  const u = ((-FIX(0.16874) * r - FIX(0.33126) * g + FIX(0.5) * b + ONE_HALF - 1) >> 10) + 128
  const v = ((FIX(0.5) * r - FIX(0.41869) * g - FIX(0.08131) * b + ONE_HALF - 1) >> 10) + 128
  return [u, v]
}

/** A pixel's chroma the way a picture that arrived as RGB carries it: BT.601 limited range. */
export function pixelChroma(r: number, g: number, b: number): [number, number] {
  const u = 128 + (-0.1482 * r - 0.291 * g + 0.4392 * b)
  const v = 128 + (0.4392 * r - 0.3678 * g - 0.0714 * b)
  return [Math.round(u), Math.round(v)]
}

/** The chroma distance ffmpeg measures, 0..1. */
export function chromaDistance(u: number, v: number, key: [number, number]): number {
  const du = u - key[0]
  const dv = v - key[1]
  return Math.sqrt((du * du + dv * dv) / (255 * 255 * 2))
}

/** ffmpeg's alpha for one distance (already averaged): 0 = screen, 255 = kept. */
export function keyAlpha(distance: number, similarity: number, blend: number): number {
  if (blend > 0.0001) return Math.trunc(Math.max(0, Math.min(1, (distance - similarity) / blend)) * 255)
  return distance > similarity ? 255 : 0
}

/** Which screen it is, for despill — which takes only green or blue. */
export function screenOf(color: string): 'green' | 'blue' {
  const [, g, b] = parseHex(color)
  return b > g ? 'blue' : 'green'
}

const clampTo = (v: number, lo: number, hi: number): number =>
  Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : lo

/** A stored key brought into range. */
export function saneKey(key: Partial<ChromaKey> | undefined): ChromaKey {
  const color = typeof key?.color === 'string' && /^#?[0-9a-f]{6}$/i.test(key.color.trim())
    ? `#${key.color.trim().replace('#', '').toLowerCase()}`
    : DEFAULT_KEY.color
  return {
    color,
    similarity: clampTo(key?.similarity ?? DEFAULT_KEY.similarity, SIMILARITY_RANGE.min, SIMILARITY_RANGE.max),
    blend: clampTo(key?.blend ?? DEFAULT_KEY.blend, BLEND_RANGE.min, BLEND_RANGE.max),
    despill: clampTo(key?.despill ?? DEFAULT_KEY.despill, 0, 1)
  }
}

/** The export's key: `chromakey`, whose alpha the plan multiplies into the clip's own. */
export function chromakeyFilter(key: ChromaKey): string {
  const k = saneKey(key)
  return (
    `chromakey=color=0x${k.color.slice(1)}` +
    `:similarity=${k.similarity.toFixed(4)}:blend=${k.blend.toFixed(4)}`
  )
}

/**
 * The export's despill, or null for none.
 *
 * ffmpeg's arithmetic, per pixel in RGB: the spill is how far the screen's
 * channel stands above the mix of the other two, `max(g − (r·mix + b·(1−mix)), 0)`
 * for green, and `green=−amount` takes that much of it back out. `mix` 0.5 and
 * `expand` 0 are ffmpeg's defaults, written out so they cannot change under us.
 */
export function despillFilter(key: ChromaKey): string | null {
  const k = saneKey(key)
  if (k.despill < 0.001) return null
  const screen = screenOf(k.color)
  const amount = (-k.despill).toFixed(4)
  return `despill=type=${screen}:mix=0.5:expand=0:${screen}=${amount}`
}

/** The same despill on one pixel, for the preview and the tests. */
export function despillPixel(r: number, g: number, b: number, key: ChromaKey): RGB {
  const k = saneKey(key)
  if (k.despill < 0.001) return [r, g, b]
  if (screenOf(k.color) === 'green') {
    const spill = Math.max(g - (r * 0.5 + b * 0.5), 0)
    return [r, Math.max(g - k.despill * spill, 0), b]
  }
  const spill = Math.max(b - (r * 0.5 + g * 0.5), 0)
  return [r, g, Math.max(b - k.despill * spill, 0)]
}

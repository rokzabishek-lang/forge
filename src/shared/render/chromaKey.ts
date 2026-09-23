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

import type { Clip, MediaAsset } from '../timeline'

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

/**
 * BT.601 limited-range chroma, per RGB channel — swscale's conversion, measured.
 *
 * One copy: `pixelChroma` reads these and so does the preview's shader, which
 * has them written into its source rather than typed out a second time.
 */
export const PIXEL_U: readonly [number, number, number] = [-0.1482, -0.291, 0.4392]
export const PIXEL_V: readonly [number, number, number] = [0.4392, -0.3678, -0.0714]

/** A pixel's chroma the way a picture that arrived as RGB carries it: BT.601 limited range. */
export function pixelChroma(r: number, g: number, b: number): [number, number] {
  const u = 128 + (PIXEL_U[0] * r + PIXEL_U[1] * g + PIXEL_U[2] * b)
  const v = 128 + (PIXEL_V[0] * r + PIXEL_V[1] * g + PIXEL_V[2] * b)
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

/**
 * The export's key: `chromakey`, whose alpha the plan multiplies into the clip's own.
 *
 * `scale` is how much larger the running ffmpeg measures a distance than the
 * model does (`keyScaleFromProbe`) — 1 on the macOS build, √2 on the 2018
 * Windows one. Similarity and blend are both distances, so multiplying them by
 * it gives `clip((√2·d − √2·s) / (√2·b))`, which is the model's
 * `clip((d − s) / b)` exactly, and a hard cut at `√2·d > √2·s` is `d > s`.
 */
export function chromakeyFilter(key: ChromaKey, scale = 1): string {
  const k = saneKey(key)
  const s = Number.isFinite(scale) && scale > 0 ? scale : 1
  return (
    `chromakey=color=0x${k.color.slice(1)}` +
    `:similarity=${(k.similarity * s).toFixed(4)}:blend=${(k.blend * s).toFixed(4)}`
  )
}

/**
 * The two ffmpegs measure a key's distance differently.
 *
 * Found by CI, not by reading: the Windows runner keyed far less than the
 * macOS build at the same settings, and every mismatch was the same factor.
 * The 2018 snapshot's `chromakey` takes `sqrt(du² + dv²) / 255`; the newer one
 * divides by a further √2 — `sqrt((du² + dv²) / (255² · 2))`, the model here.
 * Scaling the model's distance by √2 predicts the Windows numbers exactly:
 * #00b140 over pure green, model 53, √2 predicts 234, Windows gave 234.
 *
 * So the app does not guess which build it has: it keys one patch and reads
 * the alpha back. `00e000` against a `00ff00` key at similarity 0.05, blend
 * 0.1 comes out near 94 with the newer formula and near 186 with the old one —
 * far enough apart that a level of rounding either way cannot confuse them.
 */
export const KEY_SCALES = [1, Math.SQRT2] as const
const PROBE_PIXEL: [number, number, number] = [0, 224, 0]
const PROBE_KEY: ChromaKey = { color: '#00ff00', similarity: 0.05, blend: 0.1, despill: 0 }

/** The ffmpeg arguments for the probe: one 16×16 patch, keyed, as raw yuva420p. */
export function keyProbeArgs(): string[] {
  const hex = PROBE_PIXEL.map((c) => c.toString(16).padStart(2, '0')).join('')
  return [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `color=c=0x${hex}:s=16x16:d=1`,
    '-vf', `format=yuv420p,${chromakeyFilter(PROBE_KEY)}`,
    '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'yuva420p', '-'
  ]
}

/**
 * The probe's alpha at the middle of the patch: yuva420p is Y (16×16), U and V
 * (8×8 each), then alpha (16×16). Null if the output is not that shape.
 */
export function keyProbeAlpha(bytes: ArrayLike<number>): number | null {
  const alphaAt = 16 * 16 + 2 * 8 * 8
  if (bytes.length < alphaAt + 16 * 16) return null
  return bytes[alphaAt + 8 * 16 + 8]
}

/** Which scale the probe's alpha says this ffmpeg measures with. */
export function keyScaleFromProbe(alpha: number): number {
  const [u, v] = pixelChroma(...PROBE_PIXEL)
  const d = chromaDistance(u, v, keyChroma(PROBE_KEY.color))
  let best: number = KEY_SCALES[0]
  let error = Infinity
  for (const scale of KEY_SCALES) {
    const off = Math.abs(keyAlpha(d * scale, PROBE_KEY.similarity, PROBE_KEY.blend) - alpha)
    if (off < error) {
      error = off
      best = scale
    }
  }
  return best
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

/**
 * Whether a clip is a picture that can be keyed.
 *
 * Footage and photographs. Not the things the app draws itself — a text card,
 * a clipping, a solid — which have no screen behind them to take out, nor an
 * adjustment layer, which has no picture of its own at all.
 */
export function isKeyable(
  clip: Pick<Clip, 'adjustment' | 'text' | 'title' | 'paper' | 'carousel' | 'solid'>,
  asset: Pick<MediaAsset, 'kind' | 'hasVideo'> | undefined
): boolean {
  if (clip.adjustment || clip.text || clip.title || clip.paper || clip.carousel || clip.solid) return false
  return Boolean(asset && asset.hasVideo && (asset.kind === 'video' || asset.kind === 'image'))
}

/**
 * The screen colour under a click: the average of the opaque pixels sampled.
 *
 * Averaged because a real screen is never one colour — it is lit unevenly and
 * the camera adds noise — and a key taken from a single pixel is a key taken
 * from that pixel's noise. `rgba` is canvas `getImageData` order. Pixels that
 * are mostly see-through belong to whatever is behind the clip, so they do
 * not count; with none left there is nothing to pick and the answer is null.
 */
export function pickedColor(rgba: ArrayLike<number>, minAlpha = 200): string | null {
  let r = 0
  let g = 0
  let b = 0
  let n = 0
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    if (rgba[i + 3] < minAlpha) continue
    r += rgba[i]
    g += rgba[i + 1]
    b += rgba[i + 2]
    n++
  }
  if (n === 0) return null
  const hex = (v: number): string => Math.round(v / n).toString(16).padStart(2, '0')
  return `#${hex(r)}${hex(g)}${hex(b)}`
}

/**
 * The square of pixels a pick averages, centred on the click and kept inside
 * the picture — or null for a click that is not on it at all.
 */
export function pickRegion(
  x: number,
  y: number,
  width: number,
  height: number,
  radius = 3
): { x: number; y: number; width: number; height: number } | null {
  const cx = Math.floor(x)
  const cy = Math.floor(y)
  if (width < 1 || height < 1 || cx < 0 || cy < 0 || cx >= width || cy >= height) return null
  const x0 = Math.max(0, cx - radius)
  const y0 = Math.max(0, cy - radius)
  const x1 = Math.min(width, cx + radius + 1)
  const y1 = Math.min(height, cy + radius + 1)
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
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

/**
 * What a luma mask actually does, measured from its pixels.
 *
 * There are 413 masks in the library and their filenames are the only thing
 * describing them, so a grid reveal — which the library has 48 of — is
 * unfindable unless you already know it is called `luminous_boxes_17`. The
 * behaviour is in the image: a mask is a map of *when* each pixel flips, so
 * brightness rising left-to-right is a left wipe, brightness rising with
 * distance from centre is an iris, and many separate bright islands is a grid.
 *
 * Pure, and deliberately not in the main process: it is arithmetic over a small
 * array, and the interesting part is whether the arithmetic is right.
 */

export type MaskTag =
  | 'wipe-left'
  | 'wipe-right'
  | 'wipe-up'
  | 'wipe-down'
  | 'iris-in'
  | 'iris-out'
  | 'grid'
  | 'blinds'
  | 'soft'
  | 'hard'

export interface MaskMetrics {
  /** +1 brightness rises to the right, -1 to the left. */
  dirX: number
  /** +1 brightness rises downward. */
  dirY: number
  /** +1 brightness rises away from centre, -1 towards it. */
  radial: number
  /** Separate bright islands at the midpoint — many means cellular. */
  islands: number
  /**
   * The largest brightness jump between neighbours, 0..1 — 99th percentile so
   * JPEG ringing does not decide it. Low is a smooth ramp.
   *
   * NOT the mean: a linear ramp and a hard step across the same width have the
   * *same* mean gradient, because both travel from 0 to 1. What separates them
   * is whether that travel is spread out or concentrated in one jump.
   */
  softness: number
}

/** Above this a directional ramp is the mask's dominant behaviour. */
const DIRECTIONAL = 0.55
const RADIAL = 0.45
const GRID_ISLANDS = 6
/** A jump bigger than a quarter of the range in one pixel is a hard edge. */
const SOFT_EDGE = 0.25

function correlation(values: number[], against: number[]): number {
  const n = values.length
  if (n === 0) return 0
  let sx = 0
  let sy = 0
  for (let i = 0; i < n; i++) {
    sx += values[i]
    sy += against[i]
  }
  const mx = sx / n
  const my = sy / n
  let num = 0
  let dx = 0
  let dy = 0
  for (let i = 0; i < n; i++) {
    const a = values[i] - mx
    const b = against[i] - my
    num += a * b
    dx += a * a
    dy += b * b
  }
  const denominator = Math.sqrt(dx * dy)
  return denominator < 1e-9 ? 0 : num / denominator
}

/** Connected bright regions, 4-connectivity, flood filled iteratively. */
function countIslands(bright: boolean[], size: number): number {
  const seen = new Uint8Array(bright.length)
  let islands = 0
  const stack: number[] = []

  for (let start = 0; start < bright.length; start++) {
    if (!bright[start] || seen[start]) continue
    islands++
    stack.length = 0
    stack.push(start)
    seen[start] = 1
    let area = 0
    while (stack.length > 0) {
      const index = stack.pop()!
      area++
      const x = index % size
      const y = (index - x) / size
      const neighbours = [
        x > 0 ? index - 1 : -1,
        x < size - 1 ? index + 1 : -1,
        y > 0 ? index - size : -1,
        y < size - 1 ? index + size : -1
      ]
      for (const next of neighbours) {
        if (next < 0 || seen[next] || !bright[next]) continue
        seen[next] = 1
        stack.push(next)
      }
    }
    // A handful of pixels is noise from JPEG ringing, not a cell.
    if (area < 3) islands--
  }
  return Math.max(0, islands)
}

/** `gray` is row-major, `size` x `size`, values 0..255. */
export function maskMetrics(gray: ArrayLike<number>, size: number): MaskMetrics {
  const values: number[] = []
  const xs: number[] = []
  const ys: number[] = []
  const rs: number[] = []

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = gray[y * size + x] / 255
      values.push(v)
      const nx = x / (size - 1) - 0.5
      const ny = y / (size - 1) - 0.5
      xs.push(nx)
      ys.push(ny)
      rs.push(Math.hypot(nx, ny))
    }
  }

  let mid = 0
  for (const v of values) mid += v
  mid /= values.length

  const bright = values.map((v) => v > mid)

  const steps: number[] = []
  for (let y = 0; y < size; y++) {
    for (let x = 0; x + 1 < size; x++) {
      steps.push(Math.abs(values[y * size + x + 1] - values[y * size + x]))
    }
    for (let x = 0; x < size; x++) {
      if (y + 1 < size) steps.push(Math.abs(values[(y + 1) * size + x] - values[y * size + x]))
    }
  }
  steps.sort((a, b) => a - b)

  return {
    dirX: correlation(values, xs),
    dirY: correlation(values, ys),
    radial: correlation(values, rs),
    islands: countIslands(bright, size),
    softness: steps.length === 0 ? 0 : steps[Math.floor(steps.length * 0.99)] ?? 0
  }
}

/**
 * Tags for a mask, most specific first.
 *
 * A mask can be several things at once — a soft left wipe is both — so this
 * returns a set rather than picking one bucket. Order matters only for display.
 */
export function tagsForMetrics(metrics: MaskMetrics): MaskTag[] {
  const tags: MaskTag[] = []

  // Cellularity first: a grid of boxes often also has a slight diagonal ramp,
  // and "grid" is the more useful description of what you will see.
  if (metrics.islands >= GRID_ISLANDS) {
    tags.push(metrics.islands >= 14 ? 'grid' : 'blinds')
  }

  if (Math.abs(metrics.dirX) >= DIRECTIONAL || Math.abs(metrics.dirY) >= DIRECTIONAL) {
    if (Math.abs(metrics.dirX) >= Math.abs(metrics.dirY)) {
      tags.push(metrics.dirX > 0 ? 'wipe-right' : 'wipe-left')
    } else {
      tags.push(metrics.dirY > 0 ? 'wipe-down' : 'wipe-up')
    }
  } else if (Math.abs(metrics.radial) >= RADIAL) {
    // Bright at the centre flips there first, so the image opens outward.
    tags.push(metrics.radial < 0 ? 'iris-out' : 'iris-in')
  }

  tags.push(metrics.softness <= SOFT_EDGE ? 'soft' : 'hard')
  return tags
}

export function classifyMask(gray: ArrayLike<number>, size: number): MaskTag[] {
  return tagsForMetrics(maskMetrics(gray, size))
}

/** Human-readable, for the picker. */
export const TAG_LABELS: Record<MaskTag, string> = {
  'wipe-left': 'Wipe left',
  'wipe-right': 'Wipe right',
  'wipe-up': 'Wipe up',
  'wipe-down': 'Wipe down',
  'iris-in': 'Iris in',
  'iris-out': 'Iris out',
  grid: 'Grid reveal',
  blinds: 'Blinds',
  soft: 'Soft',
  hard: 'Hard'
}

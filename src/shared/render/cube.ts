/**
 * Read an Adobe `.cube` 3D LUT.
 *
 * The file is the interchange format every grading tool exports and CapCut and
 * Resolve both import, so supporting it is what makes a look bought, downloaded
 * or built elsewhere usable here. ffmpeg reads these directly at render time —
 * this parser exists for the *preview*, which has to apply the same look on the
 * GPU so what you grade is what you export.
 *
 * Entries run with RED VARYING FASTEST, then green, then blue. Getting that
 * order backwards produces a LUT that looks plausible and is wrong on every
 * colour that is not grey, which is the kind of bug that ships.
 */

export interface CubeLut {
  size: number
  /** size³ × 3 floats, RGB, red-fastest. */
  data: Float32Array
  title?: string
  domainMin: [number, number, number]
  domainMax: [number, number, number]
}

export class CubeError extends Error {}

/** The largest cube we will load. 64³ is already 786k entries. */
export const MAX_CUBE_SIZE = 64

export function parseCube(text: string): CubeLut {
  let size = 0
  let title: string | undefined
  let domainMin: [number, number, number] = [0, 0, 0]
  let domainMax: [number, number, number] = [1, 1, 1]
  const values: number[] = []

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    // '#' is the documented comment marker.
    if (!line || line.startsWith('#')) continue

    const upper = line.toUpperCase()
    if (upper.startsWith('TITLE')) {
      title = line.slice(5).trim().replace(/^"|"$/g, '')
      continue
    }
    if (upper.startsWith('LUT_1D_SIZE')) {
      // Reported rather than silently misread as a 3D table.
      throw new CubeError('That is a 1D LUT — only 3D .cube LUTs are supported')
    }
    if (upper.startsWith('LUT_3D_SIZE')) {
      size = Number(line.slice(11).trim())
      continue
    }
    if (upper.startsWith('DOMAIN_MIN')) {
      domainMin = triple(line.slice(10), domainMin)
      continue
    }
    if (upper.startsWith('DOMAIN_MAX')) {
      domainMax = triple(line.slice(10), domainMax)
      continue
    }

    const parts = line.split(/\s+/)
    if (parts.length < 3) continue
    const r = Number(parts[0])
    const g = Number(parts[1])
    const b = Number(parts[2])
    if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) continue
    values.push(r, g, b)
  }

  if (!Number.isFinite(size) || size < 2) {
    throw new CubeError('No LUT_3D_SIZE in that file — it may not be a .cube LUT')
  }
  if (size > MAX_CUBE_SIZE) {
    throw new CubeError(`That LUT is ${size}³, larger than the ${MAX_CUBE_SIZE}³ limit`)
  }

  const expected = size * size * size * 3
  if (values.length !== expected) {
    throw new CubeError(
      `That LUT says it is ${size}³ but has ${values.length / 3} entries, not ${expected / 3}`
    )
  }

  return { size, data: Float32Array.from(values), title, domainMin, domainMax }
}

function triple(
  text: string,
  fallback: [number, number, number]
): [number, number, number] {
  const parts = text.trim().split(/\s+/).map(Number)
  if (parts.length < 3 || parts.some((n) => !Number.isFinite(n))) return fallback
  return [parts[0], parts[1], parts[2]]
}

/**
 * Look a colour up in the table, nearest-neighbour.
 *
 * Not what the GPU or ffmpeg use — both interpolate — but it is what lets a test
 * assert that a LUT does what it claims without standing up a WebGL context.
 */
export function sampleNearest(
  lut: CubeLut,
  r: number,
  g: number,
  b: number
): [number, number, number] {
  const axis = (value: number, min: number, max: number): number => {
    const span = max - min || 1
    const t = (value - min) / span
    return Math.max(0, Math.min(lut.size - 1, Math.round(t * (lut.size - 1))))
  }
  const ri = axis(r, lut.domainMin[0], lut.domainMax[0])
  const gi = axis(g, lut.domainMin[1], lut.domainMax[1])
  const bi = axis(b, lut.domainMin[2], lut.domainMax[2])
  // Red fastest, then green, then blue.
  const index = (ri + gi * lut.size + bi * lut.size * lut.size) * 3
  return [lut.data[index], lut.data[index + 1], lut.data[index + 2]]
}

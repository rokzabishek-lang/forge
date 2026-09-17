/**
 * Looks that ship with the app.
 *
 * A LUT picker that only says "load a .cube file" is useless to anyone who does
 * not already own LUTs, which is almost everyone. These are generated rather
 * than licensed: each one is an ordinary colour transform written out as a
 * standard `.cube`, so ffmpeg reads them at render time and the GPU reads the
 * same file for the preview — no special path for "our" looks versus a user's.
 *
 * The transforms are deliberately plain and explainable. Lift, gamma and gain
 * per channel; a contrast S-curve; saturation; and split-toning that pushes
 * shadows and highlights in opposite directions. That is most of what a
 * film-emulation look actually is.
 */

export type Rgb = [number, number, number]

export interface Look {
  id: string
  name: string
  /** What it does, in the words someone choosing it would use. */
  description: string
  apply: (rgb: Rgb) => Rgb
}

/** Rec.709 luma, which is what "how bright is this pixel" means for HD. */
export function luma([r, g, b]: Rgb): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value
}

/** Lift shadows, set midtone gamma, scale highlights — the classic three. */
function lgg(rgb: Rgb, lift: Rgb, gamma: Rgb, gain: Rgb): Rgb {
  return rgb.map((v, i) => {
    const lifted = lift[i] + v * (1 - lift[i])
    return clamp01(Math.pow(Math.max(0, lifted), gamma[i]) * gain[i])
  }) as Rgb
}

/**
 * A contrast S-curve around 0.5.
 *
 * `amount` 0 is untouched. Uses a smooth curve rather than a straight multiply
 * so highlights roll off instead of clipping to white, which is the difference
 * between "contrasty" and "blown".
 */
export function sCurve(value: number, amount: number): number {
  if (amount === 0) return value
  const x = clamp01(value)
  const curved = x * x * (3 - 2 * x)
  return clamp01(x + (curved - x) * amount)
}

function saturate(rgb: Rgb, amount: number): Rgb {
  const y = luma(rgb)
  return rgb.map((v) => clamp01(y + (v - y) * amount)) as Rgb
}

/** Push shadows one way and highlights the other — the teal/orange mechanism. */
function splitTone(rgb: Rgb, shadow: Rgb, highlight: Rgb, strength: number): Rgb {
  const y = luma(rgb)
  return rgb.map((v, i) => {
    const tint = shadow[i] * (1 - y) + highlight[i] * y
    return clamp01(v + tint * strength)
  }) as Rgb
}

export const LOOKS: Look[] = [
  {
    id: 'warm-film',
    name: 'Warm Film',
    description: 'Soft warmth and lifted blacks. The safe one for skin.',
    apply: (rgb) => {
      // A touch of blue in the shadows is what reads as film stock rather than
      // as an orange filter.
      const base = lgg(rgb, [0.012, 0.014, 0.028], [0.98, 1.0, 1.04], [1.06, 1.01, 0.96])
      return saturate(base.map((v) => sCurve(v, 0.18)) as Rgb, 1.04)
    }
  },
  {
    id: 'golden-hour',
    name: 'Golden Hour',
    description: 'Late sun. Warm highlights, gentle rolloff.',
    apply: (rgb) => {
      const base = lgg(rgb, [0.02, 0.012, 0.0], [0.94, 0.99, 1.08], [1.1, 1.02, 0.9])
      return saturate(base.map((v) => sCurve(v, 0.1)) as Rgb, 1.1)
    }
  },
  {
    id: 'teal-orange',
    name: 'Teal & Orange',
    description: 'The trailer look — cold shadows, warm skin.',
    apply: (rgb) => {
      const toned = splitTone(rgb, [-0.03, 0.01, 0.06], [0.07, 0.02, -0.05], 1)
      return saturate(toned.map((v) => sCurve(v, 0.26)) as Rgb, 1.08)
    }
  },
  {
    id: 'cool-cine',
    name: 'Cool Cine',
    description: 'Blue and restrained. Good for night and city.',
    apply: (rgb) => {
      const base = lgg(rgb, [0.01, 0.018, 0.035], [1.04, 1.0, 0.95], [0.95, 0.99, 1.07])
      return saturate(base.map((v) => sCurve(v, 0.2)) as Rgb, 0.92)
    }
  },
  {
    id: 'faded',
    name: 'Faded',
    description: 'Matte blacks, low contrast. Quiet and editorial.',
    apply: (rgb) => {
      // Lifting the black point without touching contrast is the whole effect.
      const base = lgg(rgb, [0.07, 0.068, 0.075], [1.0, 1.0, 1.0], [0.96, 0.96, 0.97])
      return saturate(base.map((v) => sCurve(v, -0.22)) as Rgb, 0.88)
    }
  },
  {
    id: 'bleach-bypass',
    name: 'Bleach Bypass',
    description: 'Harsh and silvery. Strong — try it at half intensity.',
    apply: (rgb) => {
      const grey = saturate(rgb, 0.35)
      return grey.map((v) => sCurve(sCurve(v, 0.5), 0.35)) as Rgb
    }
  },
  {
    id: 'noir',
    name: 'Noir',
    description: 'Black and white with real contrast.',
    apply: (rgb) => {
      const y = sCurve(sCurve(luma(rgb), 0.4), 0.3)
      return [y, y, y]
    }
  }
]

export function lookById(id: string): Look | undefined {
  return LOOKS.find((l) => l.id === id)
}

/**
 * The default cube resolution.
 *
 * 17³ is 4,913 entries — smooth enough that a gradient does not band, small
 * enough that the file stays around 100KB and uploads to the GPU instantly.
 */
export const CUBE_SIZE = 17

/**
 * Write a look out as a `.cube`.
 *
 * Entries run with RED VARYING FASTEST, then green, then blue — the order the
 * format specifies and the one both ffmpeg and our own parser expect.
 */
export function cubeFor(look: Look, size = CUBE_SIZE): string {
  const lines: string[] = [
    `# ${look.name} — generated by Forge`,
    `TITLE "${look.name}"`,
    `LUT_3D_SIZE ${size}`,
    'DOMAIN_MIN 0 0 0',
    'DOMAIN_MAX 1 1 1'
  ]
  const last = size - 1
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        const out = look.apply([r / last, g / last, b / last])
        lines.push(out.map((v) => clamp01(v).toFixed(6)).join(' '))
      }
    }
  }
  return `${lines.join('\n')}\n`
}

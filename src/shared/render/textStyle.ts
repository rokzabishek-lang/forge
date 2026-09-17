/**
 * Text styles — the look, separate from the letters.
 *
 * The trending caption packs are not fonts. Look closely at any of them and the
 * same small vocabulary is doing all the work: a gradient or metallic FILL, a
 * coloured OUTER GLOW, an OUTLINE, a soft SHADOW — and, over and over, a second
 * line treated completely differently from the first. "SUGAR" in metallic caps
 * with "Daddy" underneath in green script is two paints and two typefaces, not
 * one exotic font.
 *
 * That is the whole reason this is worth building as a system rather than as
 * fifty pictures: a style is a recipe, a font is a face, and they are
 * independent. Twenty-four recipes across fifty faces is twelve hundred looks,
 * every one of them showing YOUR words — which is the thing a screenshot of
 * somebody else's words can never tell you.
 *
 * Everything here is drawable with Canvas 2D, which is where our text is
 * rasterised for both the preview and the export. Nothing needs ffmpeg to
 * cooperate, and nothing can therefore look different once rendered.
 */

/** A colour, or a gradient running across the line's own box. */
export type Fill =
  | { kind: 'solid'; color: string }
  /** No fill at all — hollow type, carried entirely by its outline. */
  | { kind: 'none' }
  | {
      kind: 'gradient'
      /**
       * Degrees. 90 runs top to bottom, which is what nearly every one of these
       * looks uses — a metallic band and a sunset fade are both vertical.
       */
      angle: number
      stops: { at: number; color: string }[]
    }

export interface Paint {
  fill: Fill
  /** Width as a fraction of the font size, so it scales with the type. */
  stroke?: { width: number; color: string }
  /** Offsets and blur are fractions of the font size, for the same reason. */
  shadow?: { dy: number; blur: number; color: string; opacity: number }
  /**
   * Outer glow. Drawn as repeated blurred passes behind the fill, because one
   * canvas shadow pass is too faint to read as a glow at any sane blur.
   */
  glow?: { blur: number; color: string; opacity: number; passes?: number }
  /**
   * Hard three-dimensional extrusion — the stacked poster look.
   *
   * Not a blurred shadow: the same glyph drawn again and again at one-pixel
   * steps, which is what gives it a solid side rather than a soft one. `steps`
   * is how deep, `dx`/`dy` the direction, both as fractions of the font size.
   */
  extrude?: { dx: number; dy: number; steps: number; color: string }
  /**
   * A filled block behind the words.
   *
   * The single most common caption treatment there is — a bar of colour with
   * the type knocked out of it — and impossible to build from a fill and an
   * outline. Padding is in fractions of the font size.
   */
  box?: { color: string; padX: number; padY: number; radius: number; opacity?: number }
  /** A rule through the words, or under them. */
  line?: { kind: 'strike' | 'under'; color: string; width: number }
  /**
   * Chromatic split — the glitch.
   *
   * The glyph drawn twice more in two opposed colours, offset either side of
   * the fill. It is the whole of what people mean by "broken" text, and it is
   * two extra passes rather than anything exotic.
   */
  split?: { dx: number; dy?: number; colorA: string; colorB: string; opacity?: number }
}

/** Type choices a style may override, per role. */
export interface Face {
  /**
   * A family to prefer for this role. Falls back to the clip's own font when
   * the catalogue does not have it, so a style is never broken by a missing
   * face — it just looks a little plainer.
   */
  font?: string
  weight?: number
  italic?: boolean
  uppercase?: boolean
  /** Multiplier on the clip's size. */
  sizeScale?: number
  /** Overrides the clip's tracking, in ems. */
  tracking?: number
}

export interface TextStyle {
  id: string
  name: string
  /** One line of what it is for, in the words someone choosing would use. */
  description: string
  /** Every line gets this. */
  base: Paint & Face
  /**
   * Lines after the first.
   *
   * The signature move of every one of these packs: a heavy metallic first line
   * with a light script second, a white word followed by a coloured one. Absent
   * means every line looks the same, which is also a legitimate style.
   */
  accent?: Partial<Paint> & Face
  /**
   * What the accent applies to.
   *
   * `line` — every line after the first, the usual two-line pairing.
   * `lastWord` / `firstWord` — one word within each line instead.
   *
   * The word modes are not a variation on the line mode, they are a different
   * look entirely: "Smooth **Ocean**" colours the second WORD of a single line,
   * which no amount of per-line styling can express. Half the reference set
   * does this and none of it was reachable before.
   */
  accentScope?: 'line' | 'lastWord' | 'firstWord'
}

/* ------------------------------------------------------------------ helpers */

const white = (color = '#ffffff'): Fill => ({ kind: 'solid', color })

function vertical(...colors: string[]): Fill {
  return {
    kind: 'gradient',
    angle: 90,
    stops: colors.map((color, i) => ({ at: colors.length === 1 ? 0 : i / (colors.length - 1), color }))
  }
}

/**
 * The metallic ramp.
 *
 * A chrome look is not a two-colour fade — it is a bright band, a hard dark
 * band, then bright again, which is what reads as a reflective surface. Evenly
 * spaced stops look like plastic.
 */
function metal(light: string, mid: string, dark: string): Fill {
  return {
    kind: 'gradient',
    angle: 90,
    stops: [
      { at: 0, color: light },
      { at: 0.42, color: mid },
      { at: 0.5, color: dark },
      { at: 0.58, color: mid },
      { at: 1, color: light }
    ]
  }
}

const softShadow = (opacity = 0.55): Paint['shadow'] => ({
  dy: 0.06,
  blur: 0.16,
  color: '#000000',
  opacity
})

/* ------------------------------------------------------------------- styles */

export const TEXT_STYLES: TextStyle[] = [
  {
    id: 'clean',
    name: 'Clean',
    description: 'Plain white with a soft lift. The Apple-ish default.',
    base: { fill: white(), weight: 700, shadow: softShadow(0.5) }
  },
  {
    id: 'white-glow',
    name: 'White glow',
    description: 'White with a halo, so it reads on any picture.',
    base: {
      fill: white(),
      weight: 700,
      glow: { blur: 0.5, color: '#ffffff', opacity: 0.5, passes: 3 },
      shadow: softShadow(0.4)
    }
  },
  {
    id: 'outline',
    name: 'Outline',
    description: 'White with a hard black edge. Survives a busy background.',
    base: {
      fill: white(),
      weight: 800,
      stroke: { width: 0.09, color: '#000000' },
      shadow: softShadow(0.35)
    }
  },
  {
    id: 'shadow-pop',
    name: 'Shadow pop',
    description: 'Yellow over a heavy drop shadow, with a small caption under it.',
    base: {
      fill: white('#ffe14d'),
      weight: 800,
      shadow: { dy: 0.1, blur: 0.06, color: '#000000', opacity: 0.85 },
      glow: { blur: 0.45, color: '#ffd400', opacity: 0.35, passes: 2 }
    },
    accent: { fill: white(), weight: 500, sizeScale: 0.45, italic: true }
  },
  {
    id: 'shiny',
    name: 'Shiny',
    description: 'Cool blue with a bright sheen through the middle.',
    base: {
      fill: metal('#e8f6ff', '#5aa9e6', '#2f6fa8'),
      weight: 800,
      glow: { blur: 0.55, color: '#3f9bdc', opacity: 0.5, passes: 3 },
      shadow: softShadow(0.4)
    }
  },
  {
    id: 'chrome',
    name: 'Chrome',
    description: 'Polished metal. Heavy caps, hard edge.',
    base: {
      fill: metal('#ffffff', '#b4b4b4', '#4a4a4a'),
      weight: 800,
      uppercase: true,
      tracking: 0.02,
      stroke: { width: 0.03, color: '#1a1a1a' },
      shadow: softShadow(0.6)
    }
  },
  {
    id: 'chrome-script',
    name: 'Chrome & script',
    description: 'Metallic caps with a flowing second line. The luxury pairing.',
    base: {
      fill: metal('#ffffff', '#c9c9c9', '#5b5b5b'),
      weight: 800,
      uppercase: true,
      tracking: 0.06,
      shadow: softShadow(0.6)
    },
    accent: {
      fill: vertical('#c8f7a0', '#4e9b2f'),
      italic: true,
      weight: 600,
      sizeScale: 0.9,
      glow: { blur: 0.4, color: '#6dd34a', opacity: 0.35, passes: 2 }
    }
  },
  {
    id: 'two-tone',
    name: 'Two tone',
    description: 'Grey line, coloured line. Reads instantly as a hook.',
    base: { fill: white('#d4d4d8'), weight: 800, shadow: softShadow(0.5) },
    accent: { fill: vertical('#ffb347', '#f4712c') }
  },
  {
    id: 'cross-fade',
    name: 'Cross',
    description: 'A plain word and a purple italic one, set against each other.',
    base: { fill: white(), weight: 800, shadow: softShadow(0.5) },
    accent: {
      fill: vertical('#c084fc', '#6d28d9'),
      italic: true,
      weight: 700,
      glow: { blur: 0.45, color: '#8b5cf6', opacity: 0.45, passes: 2 }
    }
  },
  {
    id: 'gradient-sunset',
    name: 'Sunset',
    description: 'Warm top to bottom. The default "make it pop".',
    base: {
      fill: vertical('#ffd36e', '#f4772c', '#c0392b'),
      weight: 800,
      shadow: softShadow(0.5)
    }
  },
  {
    id: 'flames',
    name: 'Flames',
    description: 'Hot orange with a burning glow.',
    base: {
      fill: vertical('#fff1a8', '#ff8a1f', '#e02f14'),
      weight: 900,
      glow: { blur: 0.6, color: '#ff5a1f', opacity: 0.6, passes: 3 },
      stroke: { width: 0.02, color: '#7a1d05' }
    }
  },
  {
    id: 'ocean',
    name: 'Ocean',
    description: 'White into cold blue. Clean and cinematic.',
    base: {
      fill: vertical('#ffffff', '#bfe6ff', '#3aa0e0'),
      weight: 800,
      glow: { blur: 0.5, color: '#4fb2ef', opacity: 0.4, passes: 2 },
      shadow: softShadow(0.45)
    }
  },
  {
    id: 'waves',
    name: 'Waves',
    description: 'Soft cyan, rounded and friendly.',
    base: {
      fill: vertical('#d6f6ff', '#57c8f0'),
      weight: 900,
      glow: { blur: 0.55, color: '#3fbde8', opacity: 0.55, passes: 3 }
    }
  },
  {
    id: 'violet',
    name: 'Violet',
    description: 'Purple into pink, with a matching halo.',
    base: {
      fill: vertical('#e9d5ff', '#a855f7', '#6d28d9'),
      weight: 800,
      glow: { blur: 0.55, color: '#a855f7', opacity: 0.55, passes: 3 },
      shadow: softShadow(0.4)
    }
  },
  {
    id: 'cinematic',
    name: 'Cinematic',
    description: 'Wide violet caps over a small spaced subtitle.',
    base: {
      fill: vertical('#dbc7ff', '#7c3aed'),
      weight: 900,
      uppercase: true,
      tracking: 0.04,
      glow: { blur: 0.5, color: '#8b5cf6', opacity: 0.45, passes: 2 },
      shadow: softShadow(0.5)
    },
    accent: { fill: white(), weight: 600, uppercase: true, tracking: 0.3, sizeScale: 0.34 }
  },
  {
    id: 'neon-green',
    name: 'Neon',
    description: 'Acid green on a dark halo. Loud on purpose.',
    base: {
      fill: vertical('#e7ffb0', '#68d43a'),
      weight: 800,
      italic: true,
      glow: { blur: 0.6, color: '#63d92f', opacity: 0.65, passes: 3 }
    },
    accent: { fill: white(), weight: 500, sizeScale: 0.42, italic: false }
  },
  {
    id: 'hot-pink',
    name: 'Hot pink',
    description: 'Condensed caps with a pink burn.',
    base: {
      fill: vertical('#ffd6e8', '#ff2d78'),
      weight: 900,
      uppercase: true,
      tracking: 0.02,
      glow: { blur: 0.5, color: '#ff2d78', opacity: 0.55, passes: 3 }
    },
    accent: { fill: white(), weight: 700, uppercase: true, sizeScale: 0.4, tracking: 0.14 }
  },
  {
    id: 'hero',
    name: 'Hero',
    description: 'A small lead-in, a big italic middle, a small tail.',
    base: { fill: white(), weight: 500, sizeScale: 0.42, shadow: softShadow(0.5) },
    accent: {
      fill: vertical('#d8b4fe', '#7c3aed'),
      italic: true,
      weight: 800,
      sizeScale: 1.6,
      glow: { blur: 0.5, color: '#8b5cf6', opacity: 0.5, passes: 3 }
    }
  },
  {
    id: 'ice',
    name: 'Ice',
    description: 'Steel grey over electric blue. Two hard lines.',
    base: {
      fill: metal('#ffffff', '#a9b4bd', '#4a5560'),
      weight: 900,
      uppercase: true,
      tracking: 0.05,
      shadow: softShadow(0.6)
    },
    accent: {
      fill: vertical('#bfe9ff', '#2f9fe0'),
      weight: 900,
      uppercase: true,
      tracking: 0.05,
      glow: { blur: 0.45, color: '#37a8e8', opacity: 0.5, passes: 2 }
    }
  },
  {
    id: 'gold',
    name: 'Gold',
    description: 'Warm metal. Weddings, titles, anything that wants weight.',
    base: {
      fill: metal('#fff6d5', '#e0b558', '#8a6316'),
      weight: 800,
      shadow: softShadow(0.55),
      glow: { blur: 0.4, color: '#e9c46a', opacity: 0.3, passes: 2 }
    }
  },
  {
    id: 'glow-bar',
    name: 'Highlight',
    description: 'Small bright caps with a tight glow — a label, not a title.',
    base: {
      fill: white('#ffe600'),
      weight: 800,
      sizeScale: 0.7,
      glow: { blur: 0.35, color: '#ffe600', opacity: 0.7, passes: 3 },
      stroke: { width: 0.02, color: '#4a3f00' }
    }
  },
  {
    id: 'deep-shadow',
    name: 'Deep shadow',
    description: 'Hard offset shadow, no blur. A poster look.',
    base: {
      fill: white(),
      weight: 900,
      uppercase: true,
      shadow: { dy: 0.12, blur: 0, color: '#000000', opacity: 0.9 }
    }
  },
  {
    id: 'soft-fade',
    name: 'Soft fade',
    description: 'Pink caps fading down, with a quiet second line.',
    base: {
      fill: vertical('#ffffff', '#ff7aa8', '#c2185b'),
      weight: 900,
      uppercase: true,
      tracking: 0.03,
      shadow: softShadow(0.45)
    },
    accent: { fill: white(), weight: 600, uppercase: true, sizeScale: 0.38, tracking: 0.2 }
  },
  {
    id: 'mint',
    name: 'Mint',
    description: 'Pale green with a script tail. Light and calm.',
    base: {
      fill: vertical('#eafff4', '#7fe3c0'),
      weight: 700,
      glow: { blur: 0.4, color: '#6fe0bd', opacity: 0.4, passes: 2 }
    },
    accent: { fill: white(), italic: true, weight: 600, sizeScale: 0.95 }
  }
,
  /* ---- looks the first pass could not express, and the pieces they needed ---- */
  {
    id: 'poster-3d',
    name: 'Poster 3D',
    description: 'Blue caps on a hard stacked edge. The big cover-title look.',
    base: {
      fill: vertical('#8fd4ff', '#1f7fd0'),
      weight: 900,
      uppercase: true,
      tracking: 0.01,
      extrude: { dx: 0.012, dy: 0.016, steps: 8, color: '#0a3358' },
      stroke: { width: 0.035, color: '#06243e' }
    }
  },
  {
    id: 'sticker-3d',
    name: 'Sticker',
    description: 'White caps with a thick outline and a solid drop. Cut-out look.',
    base: {
      fill: white(),
      weight: 900,
      uppercase: true,
      stroke: { width: 0.1, color: '#111114' },
      extrude: { dx: 0, dy: 0.02, steps: 6, color: '#111114' }
    }
  },
  {
    id: 'highlight-bar',
    name: 'Highlight bar',
    description: 'Dark words on a yellow block. The most readable caption there is.',
    base: {
      fill: white('#16161a'),
      weight: 800,
      box: { color: '#ffe600', padX: 0.22, padY: 0.16, radius: 0.1 },
      shadow: { dy: 0.05, blur: 0.2, color: '#000000', opacity: 0.45 }
    }
  },
  {
    id: 'highlight-word',
    name: 'Highlight word',
    description: 'One word on a coloured block — the podcast-clip caption.',
    base: { fill: white(), weight: 800, shadow: softShadow(0.5) },
    accent: {
      fill: white('#16161a'),
      box: { color: '#ffe600', padX: 0.16, padY: 0.12, radius: 0.08 },
      shadow: undefined
    },
    accentScope: 'lastWord'
  },
  {
    id: 'ocean-word',
    name: 'Second word',
    description: 'Plain first word, coloured second. "Smooth Ocean".',
    base: { fill: white(), weight: 800, shadow: softShadow(0.5) },
    accent: {
      fill: vertical('#d9f2ff', '#2b9fe3'),
      glow: { blur: 0.4, color: '#37a8e8', opacity: 0.45, passes: 2 }
    },
    accentScope: 'lastWord'
  },
  {
    id: 'first-word',
    name: 'First word',
    description: 'Coloured opener, plain rest. Good for a name or a hook.',
    base: { fill: white(), weight: 800, shadow: softShadow(0.5) },
    accent: { fill: vertical('#ffd36e', '#f4772c') },
    accentScope: 'firstWord'
  },
  {
    id: 'strike',
    name: 'Struck out',
    description: 'A word crossed through in red. For a correction or a joke.',
    base: { fill: white('#f3a8c0'), weight: 800, shadow: softShadow(0.5) },
    accent: { line: { kind: 'strike', color: '#e11d48', width: 0.07 } },
    accentScope: 'lastWord'
  },
  {
    id: 'underline',
    name: 'Underlined',
    description: 'A coloured rule under the words.',
    base: {
      fill: white(),
      weight: 800,
      line: { kind: 'under', color: '#f97a4b', width: 0.055 },
      shadow: softShadow(0.45)
    }
  },
  {
    id: 'glitch',
    name: 'Glitch',
    description: 'Split into red and cyan. Broken on purpose.',
    base: {
      fill: white(),
      weight: 900,
      uppercase: true,
      split: { dx: 0.022, colorA: '#ff2d55', colorB: '#00e5ff', opacity: 0.85 }
    }
  },
  {
    id: 'glitch-red',
    name: 'Broken',
    description: 'Hot red with a hard shear. The most aggressive of the set.',
    base: {
      fill: vertical('#ff5a5a', '#b00020'),
      weight: 900,
      uppercase: true,
      split: { dx: 0.03, dy: 0.012, colorA: '#000000', colorB: '#ff9d9d', opacity: 0.7 },
      stroke: { width: 0.02, color: '#3b0008' }
    }
  },
  {
    id: 'hollow',
    name: 'Hollow',
    description: 'Outline only, nothing inside. Quiet and modern.',
    base: {
      fill: { kind: 'none' },
      weight: 800,
      uppercase: true,
      tracking: 0.08,
      stroke: { width: 0.045, color: '#ffffff' },
      shadow: softShadow(0.4)
    }
  },
  {
    id: 'hollow-accent',
    name: 'Hollow & solid',
    description: 'Outlined first line, filled second. A strong pairing.',
    base: {
      fill: { kind: 'none' },
      weight: 900,
      uppercase: true,
      tracking: 0.06,
      stroke: { width: 0.04, color: '#ffffff' }
    },
    accent: {
      fill: vertical('#ffd36e', '#f4772c'),
      stroke: undefined,
      glow: { blur: 0.4, color: '#f4772c', opacity: 0.4, passes: 2 }
    }
  },
  {
    id: 'subtitle-block',
    name: 'Subtitle block',
    description: 'White on a dark bar. The classic burned-in subtitle.',
    base: {
      fill: white(),
      weight: 700,
      sizeScale: 0.8,
      box: { color: '#000000', padX: 0.2, padY: 0.14, radius: 0.06, opacity: 0.72 }
    }
  },
  {
    id: 'lead-in',
    name: 'Lead-in',
    description: 'A small spaced label over a big line. Editorial.',
    base: { fill: white('#f97a4b'), weight: 700, uppercase: true, tracking: 0.34, sizeScale: 0.34 },
    accent: { fill: white(), weight: 900, sizeScale: 1.25, tracking: 0 }
  },
  {
    id: 'emerald',
    name: 'Emerald',
    description: 'Deep green metal. Rich without shouting.',
    base: {
      fill: metal('#eaffe0', '#3fae6a', '#12492c'),
      weight: 800,
      shadow: softShadow(0.55),
      glow: { blur: 0.35, color: '#3fae6a', opacity: 0.3, passes: 2 }
    }
  },
  {
    id: 'candy',
    name: 'Candy',
    description: 'Pink to violet with a thick white edge. Playful.',
    base: {
      fill: vertical('#ff9ad5', '#8b5cf6'),
      weight: 900,
      stroke: { width: 0.07, color: '#ffffff' },
      extrude: { dx: 0, dy: 0.014, steps: 5, color: '#6b21a8' }
    }
  },
  {
    id: 'midnight',
    name: 'Midnight',
    description: 'Near-black words with a bright rim. Works on pale footage.',
    base: {
      fill: white('#101014'),
      weight: 900,
      stroke: { width: 0.05, color: '#ffffff' },
      shadow: { dy: 0.04, blur: 0.24, color: '#ffffff', opacity: 0.5 }
    }
  },
  {
    id: 'sunrise-word',
    name: 'Sunrise word',
    description: 'White line with a burning last word.',
    base: { fill: white(), weight: 900, uppercase: true, shadow: softShadow(0.5) },
    accent: {
      fill: vertical('#fff1a8', '#ff8a1f', '#e02f14'),
      glow: { blur: 0.5, color: '#ff5a1f', opacity: 0.5, passes: 3 }
    },
    accentScope: 'lastWord'
  }
]

export const DEFAULT_TEXT_STYLE = 'clean'

export function textStyleById(id: string | undefined): TextStyle | null {
  if (!id) return null
  return TEXT_STYLES.find((s) => s.id === id) ?? null
}

/**
 * What a given line should be painted with.
 *
 * Line 0 gets `base`; every line after it gets `accent` layered over `base`, so
 * an accent that only changes the fill keeps the base's glow and shadow rather
 * than silently dropping them.
 */
export function paintForLine(style: TextStyle, line: number): Paint & Face {
  if (line === 0 || !style.accent) return style.base
  /*
   * A word-scoped accent leaves the line itself alone.
   *
   * Otherwise a two-line caption in "Smooth Ocean" would get the accent twice —
   * once on the whole second line and again on its last word — which is not the
   * style, it is two styles fighting.
   */
  if (style.accentScope === 'lastWord' || style.accentScope === 'firstWord') return style.base
  return { ...style.base, ...style.accent }
}

/** Resolve a gradient's direction into a line across a box of this size. */
export function gradientVector(
  angle: number,
  width: number,
  height: number
): { x0: number; y0: number; x1: number; y1: number } {
  const radians = (angle * Math.PI) / 180
  // Half-extent along the gradient's own axis, so the ramp spans the box
  // corner to corner rather than being cut off at a diagonal.
  const dx = (Math.cos(radians) * width) / 2
  const dy = (Math.sin(radians) * height) / 2
  return { x0: -dx, y0: -dy, x1: dx, y1: dy }
}

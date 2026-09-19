/**
 * Newspaper clippings, as a layout.
 *
 * The look is the one paperanimation.ai sells: a keyword highlighted across a
 * run of torn newsprint clippings, each with its own masthead, headline and
 * justified columns, cutting frame to frame. It is a hook device — the word
 * lands, the paper cuts, the word lands again — and it reaches the timeline as
 * an ordinary animated-text clip with alpha, so no green screen is involved.
 *
 * This module decides WHERE everything goes and nothing about how it is
 * painted. The split matters more here than it does for a caption: a clipping
 * is a dozen interacting measurements — column widths, justified word gaps,
 * where the highlight has to sit to land on the keyword — and all of it is
 * wrong in ways that look plausible. Being able to assert "the highlight box
 * covers the keyword and nothing else" without a canvas is the only way to
 * know.
 *
 * Every typeface it asks for already ships in `assets/fonts`: Playfair Display
 * and Georgia for the serif work, Cinzel for a masthead, Alfa Slab and Abril
 * Fatface for a tabloid shout, Courier New for a press release.
 */

/* ------------------------------------------------------------------ chance */

/**
 * A seeded generator, so a clipping is the same clipping every time.
 *
 * `Math.random` would make each bake different from the last — the preview
 * would not match the export, re-baking after an unrelated edit would silently
 * reshuffle every page, and no test could assert anything. mulberry32 is four
 * lines and good enough for deciding where a tear goes.
 */
export function seeded(seed: number): () => number {
  let a = (seed >>> 0) || 1
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/* ------------------------------------------------------------------- looks */

export interface PaperLook {
  id: string
  label: string
  /** Masthead face, headline face, body face. All ship in assets/fonts. */
  masthead: string
  headline: string
  body: string
  /**
   * Faces the run rotates through, one per clipping.
   *
   * A run of thirty pages in one face is thirty of the same page with the
   * words moved. Changing the headline face every cut is most of what makes a
   * long run read as a stack of different papers — it is the first thing
   * paperanimation.ai's own copy claims ("each with different fonts") and the
   * cheapest variety available, since all of these already ship.
   */
  headlineFaces: string[]
  /** Paper colour and ink colour. */
  paper: string
  ink: string
  /** Marker colour laid under the keyword. */
  highlight: string
  /** How rough the torn edge is, as a fraction of the clipping's size. */
  tear: number
  uppercaseHeadline: boolean
}

export const PAPER_LOOKS: PaperLook[] = [
  {
    id: 'newsprint',
    label: 'Newsprint',
    masthead: 'Cinzel',
    headline: 'Playfair Display',
    body: 'Georgia',
    paper: '#efe9dc',
    ink: '#1a1712',
    highlight: '#ffe14d',
    tear: 0.012,
    headlineFaces: ['Playfair Display', 'Abril Fatface', 'Cinzel', 'Georgia'],
    uppercaseHeadline: false
  },
  {
    id: 'tabloid',
    label: 'Tabloid',
    masthead: 'Alfa Slab One',
    headline: 'Alfa Slab One',
    body: 'Georgia',
    paper: '#f6f2e8',
    ink: '#141414',
    highlight: '#ff5b3a',
    tear: 0.02,
    headlineFaces: ['Alfa Slab One', 'Abril Fatface', 'Playfair Display'],
    uppercaseHeadline: true
  },
  {
    id: 'aged',
    label: 'Aged',
    masthead: 'Playfair Display',
    headline: 'Abril Fatface',
    body: 'Georgia',
    paper: '#e3d7bd',
    ink: '#2a2015',
    highlight: '#8fd6a0',
    tear: 0.024,
    headlineFaces: ['Abril Fatface', 'Playfair Display', 'Cinzel'],
    uppercaseHeadline: false
  },
  {
    id: 'press',
    label: 'Press release',
    masthead: 'Courier New',
    headline: 'Courier New',
    body: 'Courier New',
    paper: '#fbfaf6',
    ink: '#1d1d1d',
    highlight: '#9fd0ff',
    tear: 0.004,
    headlineFaces: ['Courier New'],
    uppercaseHeadline: true
  }
]

export function paperLookById(id: string): PaperLook {
  return PAPER_LOOKS.find((l) => l.id === id) ?? PAPER_LOOKS[0]
}

/* ------------------------------------------------------------------ copy */

/**
 * Mastheads and headline scaffolding the keyword gets dropped into.
 *
 * Deliberately generic and unbranded: these are props, and a clipping that
 * named a real newspaper would be passing itself off as one. `%s` is where the
 * keyword goes.
 */
const MASTHEADS = [
  'THE DAILY CHRONICLE',
  'THE EVENING POST',
  'NATIONAL HERALD',
  'THE CITY TRIBUNE',
  'MORNING GAZETTE',
  'THE WEEKLY REVIEW'
]

const HEADLINES = [
  '%s takes over every feed in sight',
  'Nobody saw %s coming, say sources',
  'Experts baffled as %s breaks records',
  'The rise of %s, and what comes next',
  '%s named the story of the year',
  'Inside the %s phenomenon'
]

/** Ordinary English filler, so the columns read as text rather than as Latin. */
const FILLER = (
  'the report said a spokesman told reporters that early figures point to a ' +
  'sharp change across every region measured this quarter and officials have ' +
  'declined to comment further while the review continues although several ' +
  'observers noted the pattern had been building for some months before anyone ' +
  'thought to look at it closely and the numbers now appear to bear that out in ' +
  'almost every market where the question has been put to a vote by members of ' +
  'the public who were asked to rank what mattered most to them this year'
).split(' ')

/* ----------------------------------------------------------------- layout */

/** Measures a string at a size in a family. Supplied by whoever has a canvas. */
export type Measure = (text: string, fontPx: number, family: string, bold: boolean) => number

export interface PaperSpec {
  /** The word that gets highlighted. */
  keyword: string
  lookId: string
  /** Fixes every random choice. Same seed, same page. */
  seed: number
  /** Frames each clipping holds before cutting to the next. */
  holdFrames: number
  /** How many different clippings the run cuts between. */
  clippings: number

  /*
   * The custom half. Everything below is optional and falls back to the look,
   * so a spec that sets none of it is exactly the spec that existed before —
   * and a preset stays a preset rather than becoming a pile of defaults
   * somebody has to keep in step.
   */

  /** How much of the frame the page fills. 1 is the preset size. */
  scale?: number
  /** Multiplier on the tilt and the tear. 0 is a clean rectangle, square on. */
  distortion?: number
  /** Multiplier on the fibre and creases. 0 is flat colour. */
  texture?: number
  /** Marker colour, overriding the look's. */
  highlight?: string
  /** Paper and ink, overriding the look's. */
  paper?: string
  ink?: string
  /** Your own headline. `%s` is where the keyword goes; without it, appended. */
  headline?: string
  /** Your own masthead. */
  masthead?: string
}

/** A number with a default, guarded against nonsense arriving from a slider. */
function amount(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, value))
}

export const DEFAULT_PAPER: Omit<PaperSpec, 'keyword'> = {
  lookId: 'newsprint',
  seed: 1,
  holdFrames: 5,
  /*
   * Twenty pages, not five. The effect is a RIPPLE of clippings — the word
   * landing over and over on a different paper each time — and five reads as
   * a slideshow. The site's own pitch is "10+ unique frames"; twenty at five
   * frames each is a little over three seconds, which is a hook.
   */
  clippings: 20
}

/** As many pages as a run may hold. Past this it is a strobe, not a ripple. */
export const MAX_CLIPPINGS = 40

export interface Word {
  text: string
  x: number
  /** Width at the body size, so the painter never re-measures. */
  w: number
}

export interface Line {
  y: number
  words: Word[]
}

export interface Column {
  x: number
  w: number
  lines: Line[]
}

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

export interface Clipping {
  /** The page rectangle, before rotation, in canvas pixels. */
  box: Box
  /** Radians. Small — a clipping lies slightly askew, it does not spin. */
  rotation: number
  look: PaperLook
  masthead: { text: string; fontPx: number; y: number }
  rules: { y: number }[]
  headline: { lines: { text: string; y: number }[]; fontPx: number }
  /**
   * The size the body words were MEASURED at.
   *
   * Carried rather than re-derived, because the painter re-deriving it is a
   * bug that has already happened: the layout moved to a column-based size,
   * the painter kept a page-based one, and every column came out as
   * overlapping mush. A painter that recomputes a layout number is a second
   * source of truth for it — the same thing `textLayout.ts` exists to stop.
   */
  bodyPx: number
  /** Fibre and crease strength, for the painter. 1 is the preset amount. */
  texture: number
  /**
   * Where the marker goes. Null when the keyword did not make it onto the
   * headline at all — which must be possible to detect rather than guessed at,
   * because a highlight drawn over the wrong words is the one failure that
   * still looks deliberate.
   */
  highlight: Box | null
  columns: Column[]
  /** Torn edge, as points around the box. Painter closes the path. */
  tear: { x: number; y: number }[]
}

const PADDING = 0.055
const GUTTER = 0.035
/**
 * Target characters per column line, as a divisor of the column width.
 *
 * A serif averages around half its point size per character, so a column
 * thirteen body-sizes wide runs roughly twenty-six characters — inside the
 * twenty-five to thirty-five a newspaper sets.
 */
const CHARS_PER_LINE = 13

/**
 * Lay out one clipping.
 *
 * `index` picks the masthead and headline, so a run of clippings differs
 * without being random each bake.
 */
export function layoutClipping(
  spec: PaperSpec,
  index: number,
  width: number,
  height: number,
  measure: Measure
): Clipping {
  const preset = paperLookById(spec.lookId)
  const distortion = amount(spec.distortion, 1, 0, 3)
  const look: PaperLook = {
    ...preset,
    highlight: spec.highlight ?? preset.highlight,
    paper: spec.paper ?? preset.paper,
    ink: spec.ink ?? preset.ink,
    tear: preset.tear * distortion,
    headline:
      preset.headlineFaces[pick(index, spec.seed, 1, preset.headlineFaces.length)] ??
      preset.headline
  }
  const scale = amount(spec.scale, 1, 0.4, 1.6)
  const rand = seeded(spec.seed * 7919 + index * 104729)

  // A clipping fills most of the frame but never all of it: the torn edge and
  // the tilt both need somewhere to go, or they get cropped and stop reading
  // as paper.
  const boxW = Math.min(width * 0.98, width * (0.78 + rand() * 0.1) * scale)
  const boxH = Math.min(height * 0.96, height * (0.42 + rand() * 0.16) * scale)
  const box: Box = {
    x: (width - boxW) / 2 + (rand() - 0.5) * width * 0.04,
    y: (height - boxH) / 2 + (rand() - 0.5) * height * 0.05,
    w: boxW,
    h: boxH
  }
  const rotation = (rand() - 0.5) * 0.06 * distortion

  const pad = boxW * PADDING
  const innerX = box.x + pad
  const innerW = boxW - pad * 2

  /* ---- masthead */
  const mastheadPx = Math.max(8, boxH * 0.055)
  const mastheadText =
    spec.masthead?.trim() || MASTHEADS[pick(index, spec.seed, 1, MASTHEADS.length)]
  let y = box.y + pad + mastheadPx
  const masthead = { text: mastheadText, fontPx: mastheadPx, y }
  const rules: { y: number }[] = [{ y: y + mastheadPx * 0.45 }]
  y += mastheadPx * 1.15

  /* ---- headline, with the keyword in it */
  const custom = spec.headline?.trim()
  const template = custom || HEADLINES[pick(index, spec.seed, 5, HEADLINES.length)]
  /*
   * A custom headline that forgets `%s` still has to carry the keyword, or the
   * marker has nothing to land on and the clipping silently loses its point.
   * Appending is the honest repair: visibly not what was typed, rather than a
   * highlight quietly vanishing.
   */
  const raw = template.includes('%s')
    ? template.replace('%s', spec.keyword)
    : spec.keyword
      ? `${template} ${spec.keyword}`
      : template
  const headlineText = look.uppercaseHeadline ? raw.toUpperCase() : raw
  const keyword = look.uppercaseHeadline ? spec.keyword.toUpperCase() : spec.keyword

  /*
   * Shrink the headline until it fits, rather than picking a size and hoping.
   *
   * A size chosen as a fraction of the page is right for a short headline and
   * catastrophic for a long one: at 13% of the height, six wrapped lines ate
   * the entire clipping and the body columns came out with **zero rows**. The
   * page still looked like a page, which is exactly why it needs asserting
   * rather than eyeballing — a headline with no story under it reads as a
   * design choice.
   *
   * Three lines is the budget. Past that a clipping stops being a clipping and
   * becomes a poster.
   */
  const fitted = fitHeadline(headlineText, innerW, boxH, look.headline, measure)
  const headlinePx = fitted.fontPx
  const wrapped = fitted.lines
  const headlineLineHeight = headlinePx * 1.06
  const headlineLines = wrapped.map((text, i) => ({ text, y: y + headlinePx + i * headlineLineHeight }))
  const headline = { lines: headlineLines, fontPx: headlinePx }

  /*
   * Find the keyword by measuring the run of text before it, on whichever line
   * carries it. Searching the joined string would find the right characters on
   * the wrong line as soon as the headline wraps — and the highlight would be
   * drawn confidently one line up.
   */
  let highlight: Box | null = null
  // `''.indexOf('')` is 0, so an empty keyword "matches" at the start of the
  // first line and draws a sliver of marker over nothing.
  for (const line of keyword.length > 0 ? headlineLines : []) {
    const at = line.text.indexOf(keyword)
    if (at < 0) continue
    const before = measure(line.text.slice(0, at), headlinePx, look.headline, true)
    const wide = measure(keyword, headlinePx, look.headline, true)
    highlight = {
      x: innerX + before - headlinePx * 0.04,
      y: line.y - headlinePx * 0.76,
      w: wide + headlinePx * 0.08,
      h: headlinePx * 0.94
    }
    break
  }

  y = (headlineLines.at(-1)?.y ?? y) + headlinePx * 0.5
  rules.push({ y })
  y += headlinePx * 0.28

  /* ---- two justified columns of body text */
  const gutter = boxW * GUTTER
  const colW = (innerW - gutter) / 2
  /*
   * The body size comes from the COLUMN, not from the page.
   *
   * Derived from the page height it looked right on screen and was wrong as
   * typography: three words fitted a line, so justification stretched
   * "report said a" across the whole column and the block read as a ransom
   * note. Newspapers run twenty-five to thirty-five characters a line, and
   * that is a statement about the column, which is what the words have to fit
   * into. Every test passed while this was wrong — it is a thing you can only
   * catch by looking at it.
   */
  const bodyPx = Math.max(6, Math.min(boxH * 0.042, colW / CHARS_PER_LINE))
  const lineHeight = bodyPx * 1.36
  const bottom = box.y + boxH - pad
  const rows = Math.max(0, Math.floor((bottom - y) / lineHeight))

  const columns: Column[] = []
  let cursor = Math.floor(rand() * FILLER.length)
  for (const side of [0, 1]) {
    const colX = innerX + side * (colW + gutter)
    const lines: Line[] = []
    for (let row = 0; row < rows; row++) {
      const taken: string[] = []
      let used = 0
      const space = measure(' ', bodyPx, look.body, false)
      while (cursor < FILLER.length * 4) {
        const word = FILLER[cursor % FILLER.length]
        const w = measure(word, bodyPx, look.body, false)
        const next = taken.length === 0 ? w : used + space + w
        if (taken.length > 0 && next > colW) break
        taken.push(word)
        used = next
        cursor++
      }
      if (taken.length === 0) break
      /*
       * Justify every row but the last of a column, and not a row that broke
       * early. A line holding far less than its column did not fill up — it
       * ran out of words — and stretching it to the edges turns three words
       * into three words at arm's length.
       */
      const last = row === rows - 1
      const natural = used
      const sparse = natural < colW * 0.62
      lines.push({
        y: y + bodyPx + row * lineHeight,
        words: place(taken, colX, colW, bodyPx, look.body, measure, !last && !sparse)
      })
    }
    columns.push({ x: colX, w: colW, lines })
  }

  return {
    box,
    rotation,
    look,
    masthead,
    rules,
    headline,
    bodyPx,
    texture: amount(spec.texture, 1, 0, 3),
    highlight,
    columns,
    tear: tornEdge(box, look.tear * Math.min(width, height), rand)
  }
}

/**
 * Choose the `index`th entry of a list, stepping by `stride`.
 *
 * `stride` must be coprime with the list length or the walk closes early. This
 * is not hypothetical tidiness: the headline was chosen with
 * `(index * 3) % 6`, and three and six are not coprime — so the walk visited
 * **0, 3, 0, 3, …** and a run of thirty clippings had exactly TWO headlines
 * in it. Nothing looked broken; the pages simply repeated, which is what a run
 * of clippings is supposed to avoid.
 */
function pick(index: number, seed: number, stride: number, length: number): number {
  const step = coprime(stride, length)
  return (((index * step + seed) % length) + length) % length
}

/** The first value at or above `want` that shares no factor with `length`. */
function coprime(want: number, length: number): number {
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b))
  for (let n = Math.max(1, want); n < want + length; n++) {
    if (gcd(n, length) === 1) return n
  }
  return 1
}

/** The most lines a headline may take before it stops being a clipping. */
const MAX_HEADLINE_LINES = 3

/**
 * The largest headline size that fits the line budget.
 *
 * Steps down rather than solving, because the wrap is greedy and the
 * relationship between size and line count is not smooth — a size that fits in
 * three lines does not guarantee the one just above it fits in four.
 */
function fitHeadline(
  text: string,
  innerW: number,
  boxH: number,
  family: string,
  measure: Measure
): { fontPx: number; lines: string[] } {
  const start = Math.max(10, boxH * 0.13)
  const floor = Math.max(9, boxH * 0.05)
  let fontPx = start
  let lines = wrap(text, innerW, fontPx, family, true, measure)
  while (lines.length > MAX_HEADLINE_LINES && fontPx > floor) {
    fontPx = Math.max(floor, fontPx * 0.88)
    lines = wrap(text, innerW, fontPx, family, true, measure)
  }
  return { fontPx, lines }
}

/** Greedy wrap. The headline is a handful of words; nothing needs Knuth here. */
function wrap(
  text: string,
  maxW: number,
  fontPx: number,
  family: string,
  bold: boolean,
  measure: Measure
): string[] {
  const words = text.split(' ').filter(Boolean)
  const lines: string[] = []
  let line = ''
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word
    if (line && measure(candidate, fontPx, family, bold) > maxW) {
      lines.push(line)
      line = word
    } else {
      line = candidate
    }
  }
  if (line) lines.push(line)
  return lines
}

/** Spread words across the column, stretching the gaps when justified. */
function place(
  words: string[],
  x: number,
  colW: number,
  fontPx: number,
  family: string,
  measure: Measure,
  justify: boolean
): Word[] {
  const widths = words.map((w) => measure(w, fontPx, family, false))
  const ink = widths.reduce((a, b) => a + b, 0)
  const gaps = words.length - 1
  const space = measure(' ', fontPx, family, false)
  // A single word cannot be justified, and stretching one gap to fill a whole
  // column turns two words into a word at each edge.
  const gap = justify && gaps > 0 && ink < colW ? (colW - ink) / gaps : space
  const out: Word[] = []
  let cursor = x
  words.forEach((text, i) => {
    out.push({ text, x: cursor, w: widths[i] })
    cursor += widths[i] + gap
  })
  return out
}

/** A rough edge around the box — points the painter joins up. */
function tornEdge(box: Box, amount: number, rand: () => number): { x: number; y: number }[] {
  const points: { x: number; y: number }[] = []
  const steps = 14
  const push = (x: number, y: number): void => {
    points.push({ x: x + (rand() - 0.5) * amount * 2, y: y + (rand() - 0.5) * amount * 2 })
  }
  for (let i = 0; i < steps; i++) push(box.x + (box.w * i) / steps, box.y)
  for (let i = 0; i < steps; i++) push(box.x + box.w, box.y + (box.h * i) / steps)
  for (let i = steps; i > 0; i--) push(box.x + (box.w * i) / steps, box.y + box.h)
  for (let i = steps; i > 0; i--) push(box.x, box.y + (box.h * i) / steps)
  return points
}

/* -------------------------------------------------------------- animation */

/** How long the whole run lasts. */
export function paperFrames(spec: PaperSpec): number {
  return Math.max(1, Math.round(spec.holdFrames) * clippingCount(spec))
}

/** How many pages the run really has, whatever the spec asked for. */
export function clippingCount(spec: PaperSpec): number {
  return Math.max(1, Math.min(MAX_CLIPPINGS, Math.round(spec.clippings) || 1))
}

export interface PaperFrame {
  /** Which clipping is on screen. */
  index: number
  /** 0..1 through this clipping's hold. */
  through: number
  /** 0..1 of the keyword covered by the marker. */
  sweep: number
}

/**
 * What to draw at a frame.
 *
 * The marker sweeps on over the first part of each hold and then stays, rather
 * than sweeping for the whole time: the word has to be readable *highlighted*
 * for a beat, or the effect is a wipe rather than an emphasis.
 */
export function paperFrameAt(spec: PaperSpec, frame: number): PaperFrame {
  const hold = Math.max(1, Math.round(spec.holdFrames))
  const total = paperFrames(spec)
  const clamped = Math.max(0, Math.min(total - 1, Math.round(frame)))
  const index = Math.min(clippingCount(spec) - 1, Math.floor(clamped / hold))
  const through = (clamped % hold) / hold
  return { index, through, sweep: Math.max(0, Math.min(1, through / 0.45)) }
}

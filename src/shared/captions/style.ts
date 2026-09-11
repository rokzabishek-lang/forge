/**
 * Caption styling.
 *
 * Sizes are expressed against a 1080-pixel-tall reference frame and scaled to the
 * real canvas at render time, so one style looks the same in 16:9 and 9:16.
 */

export type CaptionPosition = 'top' | 'center' | 'bottom'

export interface CaptionStyle {
  id: string
  label: string
  /** Font family name. Must match a family the renderer can resolve. */
  fontFamily: string
  /** Points at 1080p reference height. */
  fontSize: number
  bold: boolean
  uppercase: boolean
  /** #RRGGBB */
  primaryColor: string
  /** Colour of the word currently being spoken. */
  highlightColor: string
  outlineColor: string
  outlineWidth: number
  shadowDepth: number
  position: CaptionPosition
  /** Distance from the frame edge, at 1080p reference. */
  marginV: number
  /** How many words appear on screen at once. */
  wordsPerLine: number
  /** Size multiplier applied to the active word. 1 disables the pop. */
  highlightScale: number
}

export const CAPTION_STYLES: CaptionStyle[] = [
  {
    id: 'pop',
    label: 'Pop',
    fontFamily: 'Anton',
    fontSize: 84,
    bold: false,
    uppercase: true,
    primaryColor: '#FFFFFF',
    highlightColor: '#FFD400',
    outlineColor: '#000000',
    outlineWidth: 7,
    shadowDepth: 3,
    position: 'bottom',
    marginV: 220,
    wordsPerLine: 3,
    highlightScale: 1.18
  },
  {
    id: 'clean',
    label: 'Clean',
    fontFamily: 'Montserrat',
    fontSize: 62,
    bold: true,
    uppercase: false,
    primaryColor: '#FFFFFF',
    highlightColor: '#FFFFFF',
    outlineColor: '#000000',
    outlineWidth: 4,
    shadowDepth: 2,
    position: 'bottom',
    marginV: 160,
    wordsPerLine: 6,
    highlightScale: 1
  },
  {
    id: 'bold-center',
    label: 'Bold centre',
    fontFamily: 'Bebas Neue',
    fontSize: 110,
    bold: false,
    uppercase: true,
    primaryColor: '#FFFFFF',
    highlightColor: '#FF4D2E',
    outlineColor: '#000000',
    outlineWidth: 8,
    shadowDepth: 0,
    position: 'center',
    marginV: 0,
    wordsPerLine: 2,
    highlightScale: 1.25
  }
]

export const DEFAULT_CAPTION_STYLE = CAPTION_STYLES[0]

export function styleById(id: string): CaptionStyle {
  return CAPTION_STYLES.find((s) => s.id === id) ?? DEFAULT_CAPTION_STYLE
}

/** Fields a user may change without leaving the preset. */
export type StyleOverrides = Partial<
  Pick<
    CaptionStyle,
    | 'fontFamily'
    | 'fontSize'
    | 'primaryColor'
    | 'highlightColor'
    | 'outlineColor'
    | 'outlineWidth'
    | 'uppercase'
    | 'position'
    | 'marginV'
    | 'wordsPerLine'
    | 'highlightScale'
  >
>

/**
 * A preset plus the user's edits.
 *
 * Storing overrides separately rather than a flattened copy means a preset can
 * be improved later and every project that only tweaked the font still picks up
 * the improvement.
 */
export function resolveStyle(styleId: string, overrides?: StyleOverrides): CaptionStyle {
  const base = styleById(styleId)
  if (!overrides) return base
  const merged = { ...base, ...overrides }
  // Guard the numbers the renderer divides or scales by.
  merged.fontSize = Math.max(8, merged.fontSize)
  merged.wordsPerLine = Math.max(1, Math.round(merged.wordsPerLine))
  merged.highlightScale = Math.max(0.1, merged.highlightScale)
  merged.outlineWidth = Math.max(0, merged.outlineWidth)
  return merged
}

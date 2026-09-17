import type { Clip, MediaAsset, PathPoint } from '../timeline'

/**
 * A row of panels travelling across the frame.
 *
 * Several photographs laid side by side as full-height strips, the whole row
 * panning as one. Each panel is an ordinary clip: a narrow `cover` box so the
 * picture fills its strip instead of letterboxing inside it, and a path that
 * carries it the width of the row.
 *
 * Every panel shares the same travel, which is what makes it read as one moving
 * object rather than several clips that happen to be sliding.
 */

export const FILMSTRIP_RULE = 'filmstrip.row'

export interface FilmstripOptions {
  /** Panels visible across the frame at once. */
  visible?: number
  /** Left, or right. */
  direction?: 'left' | 'right'
  /** Extra travel beyond one screen width, in screen widths. */
  distance?: number
}

export const DEFAULT_VISIBLE = 4

export interface FilmstripPanel {
  assetId: string
  /** Box width as a fraction of the canvas. */
  width: number
  path: PathPoint[]
}

/**
 * Lay `images` out as a row and move it.
 *
 * Positions are in the same units as `Transform.x`: fractions of a HALF canvas,
 * so a panel one quarter of the frame wide steps by 0.5 between neighbours.
 */
export function planFilmstrip(
  images: MediaAsset[],
  durationFrames: number,
  options: FilmstripOptions = {}
): FilmstripPanel[] {
  if (images.length === 0 || durationFrames < 2) return []

  const visible = Math.max(1, Math.min(8, Math.round(options.visible ?? DEFAULT_VISIBLE)))
  const width = 1 / visible
  // Half-canvas units: a panel of width w spans 2w of them.
  const step = width * 2
  const direction = options.direction === 'right' ? 1 : -1
  const distance = Math.max(0.5, options.distance ?? 1)

  const row = images.length * step
  // Travel far enough that the row enters from one edge and fully leaves by the
  // other: its own width, plus the two half-canvases of the frame itself.
  const travel = (row + 2) * distance * direction

  /*
   * The row starts entirely OFF the leading edge.
   *
   * Travelling left it waits off the right of frame; travelling right, off the
   * left. Getting this wrong does not look like an offset — it looks like the
   * feature is broken. The leftward case used to start the row already filling
   * the frame and then walk it away, so a filmstrip showed four photographs,
   * drained to none by the halfway point and played black for the rest of its
   * length. That is measured, not guessed: panels on screen went 4, 4, 3, 2, 1,
   * 0, 0, 0, 0, 0, 0.
   */
  const rowStart = direction < 0 ? 1 : -1 - row

  return images.map((image, index) => {
    /*
     * Order along the row runs from the leading edge inward, so the first
     * photograph is the first one seen whichever way the row travels. Laid in
     * index order regardless, a rightward strip would play the set backwards.
     */
    const place = direction < 0 ? index : images.length - 1 - index
    const origin = rowStart + width + place * step
    return {
      assetId: image.id,
      width,
      path: [
        { frame: 0, x: origin, y: 0 },
        { frame: Math.max(1, durationFrames - 1), x: origin + travel, y: 0 }
      ]
    }
  })
}

export function filmstripClips(
  panels: FilmstripPanel[],
  trackId: string,
  startFrame: number,
  durationFrames: number
): Clip[] {
  return panels.map((panel, index) => ({
    id: `strip-${index}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    assetId: panel.assetId,
    trackId,
    start: startFrame,
    duration: durationFrames,
    inPoint: 0,
    volume: 1,
    transform: {
      // Narrow and full height — one uniform scale cannot say that, and
      // `cover` is what stops a landscape photo becoming a thin floating band.
      x: 0,
      y: 0,
      scale: panel.width,
      scaleY: 1,
      fit: 'cover' as const,
      rotation: 0,
      opacity: 1
    },
    color: { brightness: 0, contrast: 1, saturation: 1 },
    path: panel.path,
    generatedBy: { rule: FILMSTRIP_RULE, reason: `panel ${index + 1} of the strip` }
  }))
}

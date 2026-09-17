import type { Transform } from '../timeline'

/**
 * Split screen and picture-in-picture, as transforms.
 *
 * Neither needs anything new in the renderer. A clip's transform already says
 * how wide its box is, how tall, and where it sits — `scale` and `scaleY` as
 * fractions of the canvas, `x` and `y` as offsets in half-canvas units, and
 * `cover` to fill the box rather than letterbox inside it. Those four were added
 * for the film strip, and a split screen is the same idea with the panels
 * stacked instead of side by side.
 *
 * So this module is arithmetic and nothing else: it works out the numbers, the
 * clips carry them, and the preview and the export both already know what to do
 * with them. That is the whole reason this feature is small.
 */

/* ------------------------------------------------------------ split screen */

export type SplitLayout = 'rows' | 'columns'

export const SPLIT_LABEL: Record<SplitLayout, string> = {
  rows: 'Stacked',
  columns: 'Side by side'
}

export const SPLIT_HINT: Record<SplitLayout, string> = {
  rows: 'One above the other — the reaction layout for a tall frame.',
  columns: 'One beside the other — for a wide frame, or a before and after.'
}

/**
 * Where one panel of a split sits.
 *
 * `slot` counts from the top (or the left) and `count` is how many panels share
 * the frame, so a three-way split costs nothing extra.
 *
 * The offset is the part worth writing down. A box of 1/N the frame sits
 * centred by default, and the panel has to move to `slot/N` of the way down; in
 * half-canvas units that difference works out at `(2·slot + 1)/N − 1`, which is
 * −0.5 and +0.5 for a two-way split and ±2/3 with a zero in the middle for a
 * three-way.
 */
export function splitTransform(
  layout: SplitLayout,
  slot: number,
  count = 2
): Transform {
  const panels = Math.max(1, Math.round(count))
  const index = Math.min(panels - 1, Math.max(0, Math.round(slot)))
  const share = 1 / panels
  const offset = (2 * index + 1) * share - 1

  return {
    x: layout === 'columns' ? offset : 0,
    y: layout === 'rows' ? offset : 0,
    scale: layout === 'columns' ? share : 1,
    scaleY: layout === 'rows' ? share : 1,
    // Without `cover` a landscape shot in a half-height panel becomes a thin
    // band floating in black, which is the whole failure the film strip hit.
    fit: 'cover',
    rotation: 0,
    opacity: 1
  }
}

/* --------------------------------------------------------------------- pip */

export type PipSpot = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'centre'

export const PIP_SPOTS: PipSpot[] = [
  'top-left',
  'top-right',
  'bottom-left',
  'bottom-right',
  'centre'
]

export const PIP_SPOT_LABEL: Record<PipSpot, string> = {
  'top-left': 'Top left',
  'top-right': 'Top right',
  'bottom-left': 'Bottom left',
  'bottom-right': 'Bottom right',
  centre: 'Centre'
}

/**
 * The shape of the inset box.
 *
 * `frame` matches the video's own aspect, which is what a reaction cam wants;
 * `square` and `circle` share a box and differ only in the mask over it.
 */
export type PipShape = 'frame' | 'square' | 'circle' | 'portrait'

export const PIP_SHAPE_LABEL: Record<PipShape, string> = {
  frame: 'Same shape as the video',
  square: 'Square',
  circle: 'Circle',
  portrait: 'Tall'
}

export interface PipOptions {
  spot: PipSpot
  shape: PipShape
  /** Width of the inset, as a fraction of the frame's width. */
  size: number
  /** Gap from the frame edge, also as a fraction of the frame's WIDTH. */
  inset: number
  canvas: { width: number; height: number }
}

export const DEFAULT_PIP: Omit<PipOptions, 'canvas'> = {
  spot: 'bottom-right',
  shape: 'frame',
  // Big enough to read a face, small enough not to argue with the main picture.
  size: 0.3,
  inset: 0.04
}

/**
 * How tall the inset box is, as a fraction of the frame's height.
 *
 * A fraction of the WIDTH has to be converted, because `scaleY` is measured
 * against the height — 0.3 of the width and 0.3 of the height are the same
 * number and very different boxes in a 9:16 frame.
 */
function heightShare(shape: PipShape, size: number, canvas: PipOptions['canvas']): number {
  const aspect = canvas.width / Math.max(1, canvas.height)
  switch (shape) {
    case 'square':
    case 'circle':
      return size * aspect
    case 'portrait':
      return size * aspect * (16 / 9)
    case 'frame':
    default:
      // The same proportions as the frame: a fraction of the width is the same
      // fraction of the height.
      return size
  }
}

/** Where a picture-in-picture inset sits, and how big it is. */
export function pipTransform(options: PipOptions): Transform {
  const { spot, shape, canvas } = options
  const size = Math.min(0.9, Math.max(0.05, options.size))
  const inset = Math.min(0.4, Math.max(0, options.inset))

  const wide = size
  const tall = Math.min(0.9, heightShare(shape, size, canvas))

  // The gap is given against the width so a corner inset looks square; against
  // the height it converts through the aspect.
  const gapX = inset
  const gapY = (inset * canvas.width) / Math.max(1, canvas.height)

  const left = gapX
  const right = 1 - gapX - wide
  const top = gapY
  const bottom = 1 - gapY - tall

  const cornerX = spot === 'centre' ? (1 - wide) / 2 : spot.endsWith('left') ? left : right
  const cornerY = spot === 'centre' ? (1 - tall) / 2 : spot.startsWith('top') ? top : bottom

  /*
   * Fraction-of-frame position back into the transform's units.
   *
   * A box sits centred unless told otherwise, and `x`/`y` are measured in HALF
   * canvases — so reaching a left edge of `cornerX` means moving by
   * `2·cornerX + width − 1`. Getting this wrong puts the inset a half-frame
   * away from where it was asked for, which is the sort of thing that looks
   * like the drag handle is broken.
   */
  return {
    x: 2 * cornerX + wide - 1,
    y: 2 * cornerY + tall - 1,
    scale: wide,
    scaleY: tall,
    fit: 'cover',
    rotation: 0,
    opacity: 1
  }
}

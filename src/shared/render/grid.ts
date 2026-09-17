import type { CropRect, Transform } from '../timeline'
import { evenDown } from './crop'
import type { Mask, MaskShape, WaveEdges } from './mask'

/**
 * One photograph, cut into pieces.
 *
 * Not a collage — that is the split screen, and it lays several pictures side by
 * side. This is the opposite operation: a SINGLE picture diced into a grid, so
 * each piece can arrive on its own beat and the photograph assembles itself.
 * Sheet ① of the notebook, where the same box is drawn split down the middle,
 * split across the middle, and then as a four-by-five.
 *
 * The arithmetic is the interesting part, and it is small, because two things
 * already existed and do all the work:
 *
 *   crop       says which pixels of the source a clip shows
 *   transform  says how big its box is and where that box sits
 *
 * A cell is therefore an ordinary clip with a crop of one twentieth of the
 * photograph and a box of one twentieth of the canvas — no compositing mode, no
 * new renderer path, nothing hidden. Twenty of them tile the frame exactly and
 * cost, between them, one canvas of pixels rather than twenty.
 *
 * That last point is why this is crops and not masks. A cell could equally be
 * the whole photograph with a rectangle masked out of it, and the masks would
 * register perfectly with no arithmetic at all — but a mask is a `geq` pass over
 * the full frame, so twenty cells would be twenty full-frame per-pixel
 * expressions on every frame of the render. Cropping first means each shape,
 * when there is one, is evaluated over a twentieth of the area.
 */

/* ------------------------------------------------------------------ shapes */

export type CellShape = 'square' | 'circle' | 'wave'

export const CELL_SHAPE_LABEL: Record<CellShape, string> = {
  square: 'Square',
  circle: 'Circle',
  wave: 'Waves'
}

export const CELL_SHAPE_HINT: Record<CellShape, string> = {
  square: 'Straight cuts. The pieces tile the frame with no seam.',
  circle: 'A circle inside each piece, so the photograph arrives as dots.',
  wave: 'Wavy cuts that interlock — one piece’s edge IS the next one’s.'
}

export interface GridSpec {
  rows: number
  cols: number
  shape: CellShape
  /** Gutter between pieces, as a fraction of the cell. 0 tiles seamlessly. */
  gap: number
  /** Corner rounding on a square cell, 0..1 of its shorter half-extent. */
  radius: number
  /** Edge softness, as a fraction of the cell. 0 is a hard cut. */
  feather: number
  /**
   * The widest angle a piece is turned by, in degrees.
   *
   * A scatter rather than a lean: every cell turned the same way reads as one
   * tilted picture, which is a different effect and a duller one.
   */
  tilt: number
  /** How deep the waves cut, 0..1 of the cell. Only used by the wave shape. */
  waveDepth: number
  /** Wave cycles across the whole canvas, so neighbours share one curve. */
  waveCycles: number
}

export const DEFAULT_GRID: GridSpec = {
  rows: 2,
  cols: 2,
  shape: 'square',
  gap: 0,
  radius: 0,
  feather: 0,
  tilt: 0,
  waveDepth: 0.22,
  waveCycles: 3
}

/* ------------------------------------------------------------- the shape of it */

/**
 * Rows and columns for a plain count.
 *
 * The sheet asks for "2, 3, 4, 5, 6 … N", not for rows and columns, so the
 * number has to be turned into a rectangle. Only a factor pair will do: this is
 * one picture being divided, so every piece must be used and 5 cannot become a
 * 2×3 with a hole in it. Primes therefore give strips, which is exactly right —
 * five horizontal bands across a tall frame is a real effect, and a five-piece
 * grid is not a thing.
 *
 * Among the factor pairs, the one whose CELLS come out closest to square wins,
 * which is why the canvas aspect is needed. In a 9:16 frame two pieces stack one
 * above the other; in a 16:9 frame the same two sit side by side. Both are drawn
 * on the sheet, and neither needed to be a separate option.
 */
export function gridFor(count: number, aspectRatio: number): { rows: number; cols: number } {
  const n = Math.max(1, Math.round(count))
  const aspect = aspectRatio > 0 ? aspectRatio : 1

  let best = { rows: 1, cols: n }
  let bestError = Infinity
  for (let rows = 1; rows <= n; rows++) {
    if (n % rows !== 0) continue
    const cols = n / rows
    // Cell aspect = canvas aspect × rows / cols. Closest to 1 is squarest, and
    // the comparison is on the log so 2× too wide loses to 1.5× too tall.
    const error = Math.abs(Math.log((aspect * rows) / cols))
    if (error < bestError) {
      bestError = error
      best = { rows, cols }
    }
  }
  return best
}

/**
 * The part of the photograph the canvas actually shows.
 *
 * Every cell is a slice of THIS, not of the whole file. A 3:2 photograph in a
 * 9:16 frame has most of its width off screen, and dicing the file rather than
 * the visible rectangle would build the grid out of pixels nobody can see — the
 * pieces would assemble into a picture the user has never been shown.
 */
export function coverRect(
  source: { width: number; height: number },
  aspectRatio: number
): CropRect {
  const aspect = aspectRatio > 0 ? aspectRatio : 1
  const sourceAspect = source.width / Math.max(1, source.height)

  if (sourceAspect > aspect) {
    // Wider than the frame: full height, and the sides are trimmed.
    const width = source.height * aspect
    return {
      x: Math.round((source.width - width) / 2),
      y: 0,
      width: Math.round(width),
      height: Math.round(source.height)
    }
  }
  const height = source.width / aspect
  return {
    x: 0,
    y: Math.round((source.height - height) / 2),
    width: Math.round(source.width),
    height: Math.round(height)
  }
}

/* -------------------------------------------------------------------- cells */

export interface GridCell {
  /** Reading order: left to right, top to bottom. */
  index: number
  row: number
  col: number
  /** The pixels of the source this piece shows. */
  crop: CropRect
  /** Its box on the canvas, and how far it is turned. */
  transform: Transform
  /** A shape inside that box, for anything but a plain square. */
  mask?: Mask
}

/**
 * A stream on whole pixels, sized evenly, never smaller than asked for.
 *
 * The renderer rounds a clip's box to an even number of pixels and its position
 * to a whole one, because that is what the encoder needs. Working in exact
 * fractions here and letting it round afterwards puts the box up to a pixel
 * away from where the shape inside it was measured — which does not matter for
 * a sticker and matters a great deal for a grid, where the shape's edge IS the
 * join. Two halves of one photograph came out with a 1.6px black line down the
 * middle of the frame from exactly this.
 *
 * So the rounding happens HERE, once, and everything downstream is told about
 * it. Growing rather than shrinking is deliberate: where the division does not
 * come out evenly, neighbouring pieces overlap by a pixel instead of parting by
 * one, and an overlap between two pieces of the same picture is invisible.
 */
function quantise(from: number, to: number, floor: number, ceiling: number): [number, number] {
  const start = Math.max(floor, from)
  const end = Math.min(ceiling, to)
  const span = Math.max(2, end - start)
  const width = Math.max(2, Math.ceil(span / 2) * 2)
  // Grown about its own middle, then pushed back inside the picture.
  let origin = Math.round(start - (width - span) / 2)
  if (origin < floor) origin = Math.ceil(floor)
  if (origin + width > ceiling) origin = Math.floor(ceiling - width)
  return [origin, width]
}

/**
 * A deterministic angle for a cell, in [-1, 1].
 *
 * Deterministic because a rebuild must not reshuffle a grid the user has
 * already watched — the same photograph and the same settings have to produce
 * the same picture, every time. A hash of the position rather than a random
 * number is what buys that, and it costs nothing.
 */
function scatter(row: number, col: number, salt: number): number {
  const h = Math.sin((row + 1) * 127.1 + (col + 1) * 311.7 + salt * 74.7) * 43758.5453
  return (h - Math.floor(h)) * 2 - 1
}

/**
 * The pieces, as crops and boxes.
 *
 * Each piece is worked out in CANVAS pixels first — where it sits, how much
 * headroom its edges need, where the rounding lands — and only then converted
 * into a crop of the photograph. Doing it the other way round, from the source
 * outwards, means the box and the crop are rounded independently and `cover`
 * silently scales the picture to reconcile them.
 */
export function gridCells(
  spec: GridSpec,
  source: { width: number; height: number },
  canvas: { width: number; height: number }
): GridCell[] {
  const rows = Math.max(1, Math.round(spec.rows))
  const cols = Math.max(1, Math.round(spec.cols))
  const aspect = canvas.width / Math.max(1, canvas.height)
  const cover = coverRect(source, aspect)

  const gap = Math.max(0, Math.min(0.5, spec.gap))
  const shrink = 1 - gap
  const slotW = canvas.width / cols
  const slotH = canvas.height / rows

  /*
   * How far the wave reaches beyond a cell's own slot.
   *
   * A cell can only draw inside its own stream, so an edge that bulges outward
   * has nowhere to land: the picture stops at the box and the wave is shaved
   * flat on every crest. The fix is not in the shape but in the frame around
   * it — the stream is widened by the wave's reach, the crop is widened to
   * match, and the shape is then free to move within it. Without this the
   * effect half-works, which is worse than not working: the troughs interlock
   * and the crests leave gaps.
   */
  const depth = spec.shape === 'wave' ? Math.max(0, Math.min(1, spec.waveDepth)) : 0

  /*
   * Headroom, for the wave AND for the soft edge.
   *
   * The wave's reason is above. The feather's is the same shape of problem: a
   * ramp that fades to nothing AT the cell's edge means both sides of a join
   * are transparent there, and `over` compositing of two zeros is a zero — a
   * hairline of the black canvas along every seam, widening with the feather.
   * `edgeBias` lets the ramp finish OUTSIDE the cell instead, so a fading piece
   * always sits over a still-opaque neighbour.
   *
   * The floor of one pixel applies even at feather zero, because the shape's
   * boundary pixel is a boundary either way and something has to own it.
   */
  const soft = Math.max(0, Math.min(1, spec.feather))
  /*
   * Only shapes that TILE get the headroom.
   *
   * A plain square has no shape at all — the cell IS the box, opaque to its own
   * edge — so headroom would overlap the neighbour's picture by a pixel with
   * nothing to trim it back. A circle does not meet its neighbours either: it
   * is supposed to fade into the gap between them, and biasing it outward would
   * be pushing an edge against something that is not there.
   */
  const shaped = spec.shape === 'wave' || spec.radius > 0.001 || soft > 0.001
  const biasX = shaped ? Math.max(1, (soft * (slotW * shrink)) / 2) : 0
  const biasY = shaped ? Math.max(1, (soft * (slotH * shrink)) / 2) : 0
  const bleedX = depth * (slotW * shrink) * 0.5 + biasX
  const bleedY = depth * (slotH * shrink) * 0.5 + biasY

  /** Canvas pixels to source pixels, along the cover rectangle, and back. */
  const toSourceX = (x: number): number => cover.x + (x / canvas.width) * cover.width
  const toSourceY = (y: number): number => cover.y + (y / canvas.height) * cover.height
  const toCanvasX = (x: number): number => ((x - cover.x) / cover.width) * canvas.width
  const toCanvasY = (y: number): number => ((y - cover.y) / cover.height) * canvas.height

  // How far outside the visible rectangle the photograph still has pixels. A
  // gutter or a wave can reach into them; past them there is nothing to show.
  const reachX = [toCanvasX(0), toCanvasX(source.width)] as const
  const reachY = [toCanvasY(0), toCanvasY(source.height)] as const

  const cells: GridCell[] = []
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      // The visible cell, in canvas pixels, after the gutter has been taken out
      // of it. This is the piece the user sees; everything else is headroom.
      const inset = (1 - shrink) / 2
      const sx0 = (col + inset) * slotW
      const sx1 = (col + 1 - inset) * slotW
      const sy0 = (row + inset) * slotH
      const sy1 = (row + 1 - inset) * slotH

      /*
       * The frame's own edge stays straight when the cells are touching.
       *
       * Inside the grid a wavy cut is the point. On the outside it is a bite
       * out of the picture, showing whatever is on the track below. With a
       * gutter the cell is already clear of the frame edge, so every side may
       * wave freely.
       */
      const free = gap > 0
      const waveLeft = free || col > 0 ? depth : 0
      const waveRight = free || col < cols - 1 ? depth : 0
      const waveTop = free || row > 0 ? depth : 0
      const waveBottom = free || row < rows - 1 ? depth : 0

      /*
       * The stream: the visible cell plus headroom on every edge that has
       * somewhere to go.
       *
       * An edge on the frame's own border gets none — there is nothing out
       * there, and the shape simply runs off the end of the stream, which fills
       * its boundary pixel rather than fading it out. That is the wanted result
       * at the frame edge and the wrong one at a seam, which is why the two
       * cases are separated here rather than in the shape.
       */
      const [bx0, boxW] = quantise(
        sx0 - (free || col > 0 ? bleedX : 0),
        sx1 + (free || col < cols - 1 ? bleedX : 0),
        reachX[0],
        reachX[1]
      )
      const [by0, boxH] = quantise(
        sy0 - (free || row > 0 ? bleedY : 0),
        sy1 + (free || row < rows - 1 ? bleedY : 0),
        reachY[0],
        reachY[1]
      )

      /*
       * The crop follows the box, and is grown OUTWARD to a whole even
       * rectangle — the same "grow, never shrink" rule `quantise` uses above.
       *
       * An odd crop is not merely untidy. The export runs every rectangle
       * through `safeCrop`, which rounds a dimension DOWN to even, so an odd
       * crop silently loses a source pixel that the box still expects to be
       * there. `cover` then takes the larger of the two axis scales to fill the
       * box, amplifying that lost pixel by the cell's aspect ratio — which on a
       * grid of narrow strips came out as a visible staircase, each strip
       * showing its slice at a slightly different magnification.
       *
       * Rounding out instead means `safeCrop` has nothing left to do and
       * `cover` can only ever under-scale by a hair, which it then re-centres.
       */
      const u0 = toSourceX(bx0)
      const u1 = toSourceX(bx0 + boxW)
      const v0 = toSourceY(by0)
      const v1 = toSourceY(by0 + boxH)
      let cropX = Math.max(0, Math.floor(u0))
      let cropY = Math.max(0, Math.floor(v0))
      let cropW = Math.ceil(Math.min(source.width, u1)) - cropX
      let cropH = Math.ceil(Math.min(source.height, v1)) - cropY
      cropW = Math.min(evenDown(source.width), Math.max(2, cropW + (cropW % 2)))
      cropH = Math.min(evenDown(source.height), Math.max(2, cropH + (cropH % 2)))
      cropX = Math.max(0, Math.min(cropX, source.width - cropW))
      cropY = Math.max(0, Math.min(cropY, source.height - cropH))
      const crop = { x: cropX, y: cropY, width: cropW, height: cropH }
      const tilt = spec.tilt === 0 ? 0 : scatter(row, col, 1) * spec.tilt

      cells.push({
        index: row * cols + col,
        row,
        col,
        crop,
        transform: {
          /*
           * `x` and `y` are offsets from the centre in HALF-canvas units, so a
           * box whose middle should sit at `m` of the way across the frame has
           * to move by `2m − 1`. Same arithmetic as the split screen, on both
           * axes at once — and because `quantise` has already put the box on
           * whole even pixels, the renderer's own rounding of these numbers is
           * the identity rather than a nudge of up to a pixel.
           */
          x: (2 * bx0 + boxW - canvas.width) / canvas.width,
          y: (2 * by0 + boxH - canvas.height) / canvas.height,
          scale: boxW / canvas.width,
          scaleY: boxH / canvas.height,
          // Without `cover` a landscape photograph in a tall cell becomes a
          // band floating in black — the same failure the filmstrip hit.
          fit: 'cover',
          rotation: tilt,
          opacity: 1
        },
        ...(() => {
          const mask = cellMask(spec, {
            boxWidth: boxW,
            boxHeight: boxH,
            originX: bx0,
            originY: by0,
            canvasWidth: canvas.width,
            canvasHeight: canvas.height,
            cellWidth: sx1 - sx0,
            cellHeight: sy1 - sy0,
            offsetX: sx0 - bx0,
            offsetY: sy0 - by0,
            waves: { left: waveLeft, right: waveRight, top: waveTop, bottom: waveBottom }
          })
          return mask ? { mask } : {}
        })()
      })
    }
  }
  return cells
}

export interface CellGeometry {
  /** The stream, in canvas pixels — the space a mask's fractions are read in. */
  boxWidth: number
  boxHeight: number
  /** Where that stream sits on the canvas, and how big the canvas is. */
  originX: number
  originY: number
  canvasWidth: number
  canvasHeight: number
  /** The visible cell inside the stream. */
  cellWidth: number
  cellHeight: number
  offsetX: number
  offsetY: number
  /** Per-edge wave depth, zero where the edge must stay straight. */
  waves: { left: number; right: number; top: number; bottom: number }
}

/**
 * The shape inside one cell's box.
 *
 * Null for a plain square with no rounding and no feather, which is the common
 * case and the one that should cost nothing: with no mask the cell is a crop
 * and a box, and the renderer never reaches for `geq` at all.
 */
export function cellMask(spec: GridSpec, geometry: CellGeometry): Mask | null {
  const feather = Math.max(0, Math.min(1, spec.feather))
  const { boxWidth, boxHeight, cellWidth, cellHeight, offsetX, offsetY } = geometry

  // The visible cell's centre and half-extents, as fractions of the stream —
  // which is not simply the middle when the wave's headroom is one-sided.
  const cx = (offsetX + cellWidth / 2) / Math.max(1, boxWidth)
  const cy = (offsetY + cellHeight / 2) / Math.max(1, boxHeight)

  /*
   * The shape is grown by exactly one feather, so the ramp lands OUTSIDE it.
   *
   * `maskExpression` runs its softness inward from the edge it is given: full
   * coverage a feather inside, nothing at the edge itself. Two cells meeting at
   * a seam are then both transparent along it, and compositing one zero over
   * another leaves the canvas showing — a dark hairline down every join, a
   * pixel wide at feather zero and wider as the feather grows. Biasing by half
   * a feather is not enough either: `over` of two half-covered edges comes to
   * three quarters, which reads as a grey line rather than a black one.
   *
   * Growing the shape and shrinking the feather FRACTION to match moves the
   * ramp bodily outwards without changing how wide it is: coverage is 1 at the
   * cell's own edge and 0 a feather beyond it, inside the neighbour's solid
   * area. The two have to move together — `maskExpression` derives the ramp
   * width from `width x feather`, so changing one alone reintroduces the gap.
   *
   * The same `grown` factor serves both axes because the bias is proportional
   * to each axis's own half-extent, which cancels.
   */
  const biasX = Math.max(1, (feather * cellWidth) / 2)
  const biasY = Math.max(1, (feather * cellHeight) / 2)
  const grownW = cellWidth / 2 + biasX
  const grownH = cellHeight / 2 + biasY
  const halfW = grownW / Math.max(1, boxWidth)
  const halfH = grownH / Math.max(1, boxHeight)
  // Whichever axis needs the wider ramp wins, so neither is left short of one.
  const edge = Math.max(biasX / grownW, biasY / grownH)

  if (spec.shape === 'circle') {
    /*
     * A circle, not an ellipse.
     *
     * Half-extents are fractions of the stream's own width and height, so equal
     * fractions in a cell that is not square describe an oval. The radius is
     * taken in pixels off the shorter side and converted back per axis, which
     * is what keeps it round in a 9:16 cell.
     */
    const radius = Math.min(cellWidth, cellHeight) / 2
    return reveal({
      kind: 'ellipse',
      x: cx,
      y: cy,
      width: radius / Math.max(1, boxWidth),
      height: radius / Math.max(1, boxHeight),
      rotation: 0,
      // Not the tiling bias: a circle has no neighbour to fade into, so its
      // softness is the look rather than a seam to be closed.
      feather: Math.max(0.01, feather),
      invert: false
    })
  }

  if (spec.shape === 'wave' && spec.waveDepth > 0.001) {
    /*
     * One wave across the whole canvas, read in pieces.
     *
     * Every piece is looking at its own stretch of a single continuous curve.
     * That is the entire trick: cell 3's left edge and cell 2's right edge are
     * then the same sine at the same places, and the photograph goes back
     * together with no seam and no overlap.
     *
     * The frequency and phase are derived from where the STREAM sits on the
     * canvas, not from the cell's row and column. Those two agree only while
     * every stream is the same size — and they are not, because a cell in the
     * middle of the grid is widened for the wave on both sides while one at the
     * border is widened on one. Counting in rows instead put a slightly
     * different frequency on the middle row, which is invisible within a cell
     * and shows up as a jog in the seam every time it crosses a row boundary.
     *
     * The driver axes are crossed on purpose — the left and right edges wander
     * sideways as you travel DOWN the frame — which is what makes the cut read
     * as a wave rather than as a bulge.
     *
     * Amplitudes are fractions of the STREAM, so they are scaled through rather
     * than handed over: the pixels each cell moves by have to match its
     * neighbour's even though their streams are different sizes at the border.
     */
    const reachX = (spec.waveDepth * cellWidth) / 2
    const reachY = (spec.waveDepth * cellHeight) / 2
    const spanX = Math.max(1, geometry.canvasWidth)
    const spanY = Math.max(1, geometry.canvasHeight)
    const wave: WaveEdges = {
      vertical: {
        cycles: (spec.waveCycles * boxHeight) / spanY,
        phase: (spec.waveCycles * geometry.originY) / spanY,
        from: (geometry.waves.left > 0 ? reachX : 0) / Math.max(1, boxWidth),
        to: (geometry.waves.right > 0 ? reachX : 0) / Math.max(1, boxWidth)
      },
      horizontal: {
        cycles: (spec.waveCycles * boxWidth) / spanX,
        phase: (spec.waveCycles * geometry.originX) / spanX,
        from: (geometry.waves.top > 0 ? reachY : 0) / Math.max(1, boxHeight),
        to: (geometry.waves.bottom > 0 ? reachY : 0) / Math.max(1, boxHeight)
      }
    }
    return reveal({
      kind: 'rectangle',
      x: cx,
      y: cy,
      width: halfW,
      height: halfH,
      rotation: 0,
      feather: edge,
      wave,
      invert: false
    })
  }

  const radius = Math.max(0, Math.min(1, spec.radius))
  // Nothing to draw: a hard-edged square is exactly the box already.
  if (radius <= 0.001 && feather <= 0.001) return null
  return reveal({
    kind: 'rectangle',
    x: cx,
    y: cy,
    width: halfW,
    height: halfH,
    rotation: 0,
    feather: edge,
    radius,
    invert: false
  })
}

function reveal(shape: MaskShape): Mask {
  return { shape, mode: 'reveal', blur: 0 }
}

/* ------------------------------------------------------------------- order */

export type RevealOrder = 'rows' | 'columns' | 'centre' | 'diagonal' | 'random' | 'together'

export const REVEAL_ORDER_LABEL: Record<RevealOrder, string> = {
  rows: 'Left to right',
  columns: 'Top to bottom',
  centre: 'Out from the middle',
  diagonal: 'Diagonal sweep',
  random: 'Scattered',
  together: 'All at once'
}

/**
 * Which piece lands on which beat.
 *
 * `random` is seeded from the grid rather than from the clock, for the same
 * reason the tilt is: rebuilding a reel must not reshuffle it. A user who
 * rebuilds to change the music and finds the pieces arriving in a different
 * order has been given a different edit, not the same edit re-rendered.
 */
export function revealOrder(rows: number, cols: number, order: RevealOrder): number[] {
  const count = Math.max(1, rows * cols)
  const indices = Array.from({ length: count }, (_, i) => i)
  if (order === 'rows' || order === 'together') return indices

  const rowOf = (i: number): number => Math.floor(i / cols)
  const colOf = (i: number): number => i % cols

  const key = (i: number): number => {
    const row = rowOf(i)
    const col = colOf(i)
    switch (order) {
      case 'columns':
        return col * rows + row
      case 'diagonal':
        // Every cell on one diagonal shares a rank, so the grid fills as a
        // front sweeping across it rather than one piece at a time in a line.
        return (row + col) * Math.max(rows, cols) + row
      case 'centre': {
        const dr = row - (rows - 1) / 2
        const dc = col - (cols - 1) / 2
        return Math.hypot(dr, dc) * 1000 + i
      }
      case 'random':
        return scatter(row, col, 7) * 1000 + i * 0.001
      default:
        return i
    }
  }

  return indices.sort((a, b) => key(a) - key(b))
}

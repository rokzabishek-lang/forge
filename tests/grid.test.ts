import { describe, it, expect } from 'vitest'
import {
  DEFAULT_GRID,
  coverRect,
  gridCells,
  gridFor,
  revealOrder,
  type GridSpec
} from '@shared/render/grid'

const TALL = { width: 1080, height: 1920 }
const WIDE = { width: 1920, height: 1080 }

function spec(over: Partial<GridSpec> = {}): GridSpec {
  return { ...DEFAULT_GRID, ...over }
}

/** Where a cell's box actually sits, in canvas pixels. Mirrors clipBox. */
function boxOf(
  cell: ReturnType<typeof gridCells>[number],
  canvas: { width: number; height: number }
): { x0: number; y0: number; x1: number; y1: number } {
  const w = cell.transform.scale * canvas.width
  const h = (cell.transform.scaleY ?? cell.transform.scale) * canvas.height
  const x0 = (canvas.width - w) / 2 + (cell.transform.x * canvas.width) / 2
  const y0 = (canvas.height - h) / 2 + (cell.transform.y * canvas.height) / 2
  return { x0, y0, x1: x0 + w, y1: y0 + h }
}

describe('gridFor', () => {
  it('only ever returns a factor pair — one photo has to be fully used', () => {
    for (let n = 1; n <= 24; n++) {
      const { rows, cols } = gridFor(n, 9 / 16)
      expect(rows * cols).toBe(n)
    }
  })

  it('stacks two in a tall frame and sits them side by side in a wide one', () => {
    expect(gridFor(2, 1080 / 1920)).toEqual({ rows: 2, cols: 1 })
    expect(gridFor(2, 1920 / 1080)).toEqual({ rows: 1, cols: 2 })
  })

  it('makes four a two by two whichever way the frame points', () => {
    expect(gridFor(4, 1080 / 1920)).toEqual({ rows: 2, cols: 2 })
    expect(gridFor(4, 1920 / 1080)).toEqual({ rows: 2, cols: 2 })
  })

  it('gives a prime count strips, because there is no other honest answer', () => {
    expect(gridFor(5, 1080 / 1920)).toEqual({ rows: 5, cols: 1 })
    expect(gridFor(7, 1920 / 1080)).toEqual({ rows: 1, cols: 7 })
  })

  it('reaches the four by five on the sheet', () => {
    expect(gridFor(20, 1080 / 1920)).toEqual({ rows: 5, cols: 4 })
  })
})

describe('coverRect', () => {
  it('trims the sides of a photo wider than the frame', () => {
    const rect = coverRect({ width: 4000, height: 3000 }, 1080 / 1920)
    expect(rect.height).toBe(3000)
    expect(rect.width).toBe(Math.round(3000 * (1080 / 1920)))
    // Centred: the same amount comes off each side.
    expect(rect.x).toBe(Math.round((4000 - rect.width) / 2))
    expect(rect.y).toBe(0)
  })

  it('trims the top and bottom of a photo taller than the frame', () => {
    const rect = coverRect({ width: 3000, height: 4000 }, 1920 / 1080)
    expect(rect.width).toBe(3000)
    expect(rect.height).toBe(Math.round(3000 / (1920 / 1080)))
    expect(rect.x).toBe(0)
  })

  it('leaves a photo of the frame’s own shape alone', () => {
    const rect = coverRect({ width: 1080, height: 1920 }, 1080 / 1920)
    expect(rect).toEqual({ x: 0, y: 0, width: 1080, height: 1920 })
  })
})

describe('gridCells', () => {
  it('tiles the canvas exactly — no seam down the middle', () => {
    const cells = gridCells(spec({ rows: 2, cols: 2 }), { width: 4000, height: 3000 }, TALL)
    expect(cells).toHaveLength(4)

    const boxes = cells.map((c) => boxOf(c, TALL))
    // The four boxes meet at the centre and reach all four edges.
    expect(Math.min(...boxes.map((b) => b.x0))).toBeCloseTo(0, 6)
    expect(Math.max(...boxes.map((b) => b.x1))).toBeCloseTo(TALL.width, 6)
    expect(Math.min(...boxes.map((b) => b.y0))).toBeCloseTo(0, 6)
    expect(Math.max(...boxes.map((b) => b.y1))).toBeCloseTo(TALL.height, 6)
    // Left column's right edge IS the right column's left edge.
    expect(boxes[0].x1).toBeCloseTo(boxes[1].x0, 6)
    expect(boxes[0].y1).toBeCloseTo(boxes[2].y0, 6)
  })

  it('tiles the visible photograph exactly, not the file', () => {
    const source = { width: 4000, height: 3000 }
    const cells = gridCells(spec({ rows: 1, cols: 3 }), source, TALL)
    const cover = coverRect(source, TALL.width / TALL.height)

    /*
     * The crops cover the visible rectangle end to end, rounded OUTWARD to
     * whole even rectangles — so consecutive ones may share a pixel, and must
     * never leave one out. An odd crop would be rounded down by the export's
     * own `safeCrop` and lose a pixel the box still expected.
     */
    expect(cells[0].crop.x).toBeLessThanOrEqual(cover.x)
    expect(cells[2].crop.x + cells[2].crop.width).toBeGreaterThanOrEqual(cover.x + cover.width)
    for (let i = 1; i < 3; i++) {
      const previousEnd = cells[i - 1].crop.x + cells[i - 1].crop.width
      expect(cells[i].crop.x).toBeLessThanOrEqual(previousEnd)
      expect(previousEnd - cells[i].crop.x).toBeLessThan(4)
    }
    for (const cell of cells) {
      expect(cell.crop.width % 2).toBe(0)
      expect(cell.crop.height % 2).toBe(0)
      expect(cell.crop.height).toBeGreaterThanOrEqual(cover.height - 2)
    }
  })

  it('a crop and its box describe the same rectangle, so nothing is squeezed', () => {
    const source = { width: 4000, height: 3000 }
    const cells = gridCells(spec({ rows: 3, cols: 2 }), source, TALL)
    const cover = coverRect(source, TALL.width / TALL.height)
    for (const cell of cells) {
      const box = boxOf(cell, TALL)
      const cropAspect = cell.crop.width / cell.crop.height
      const boxAspect = (box.x1 - box.x0) / (box.y1 - box.y0)
      // Within a pixel of rounding on a 4000px source.
      expect(cropAspect / boxAspect).toBeCloseTo(1, 2)
      expect(cell.crop.x).toBeGreaterThanOrEqual(cover.x)
      expect(cell.crop.x + cell.crop.width).toBeLessThanOrEqual(cover.x + cover.width)
    }
  })

  it('costs nothing for a plain square: no mask, so no per-pixel pass', () => {
    const cells = gridCells(spec({ rows: 4, cols: 5 }), WIDE, TALL)
    expect(cells).toHaveLength(20)
    expect(cells.every((c) => c.mask === undefined)).toBe(true)
    expect(cells.every((c) => c.transform.fit === 'cover')).toBe(true)
  })

  it('opens a gutter without changing what each piece shows', () => {
    const tight = gridCells(spec({ rows: 2, cols: 2 }), WIDE, TALL)
    const loose = gridCells(spec({ rows: 2, cols: 2, gap: 0.1 }), WIDE, TALL)
    for (let i = 0; i < 4; i++) {
      expect(loose[i].transform.scale).toBeLessThan(tight[i].transform.scale)
      // Same middle: the piece shrinks in place rather than sliding.
      const a = boxOf(tight[i], TALL)
      const b = boxOf(loose[i], TALL)
      expect((a.x0 + a.x1) / 2).toBeCloseTo((b.x0 + b.x1) / 2, 6)
      expect((a.y0 + a.y1) / 2).toBeCloseTo((b.y0 + b.y1) / 2, 6)
    }
  })

  it('makes a circle round in a cell that is not square', () => {
    const cells = gridCells(spec({ rows: 2, cols: 2, shape: 'circle' }), WIDE, TALL)
    const cell = cells[0]
    const shape = cell.mask!.shape
    expect(shape.kind).toBe('ellipse')
    const box = boxOf(cell, TALL)
    const rx = shape.width * (box.x1 - box.x0)
    const ry = shape.height * (box.y1 - box.y0)
    expect(rx).toBeCloseTo(ry, 4)
    // Inscribed: it touches the short sides and no more.
    expect(rx).toBeCloseTo(Math.min(box.x1 - box.x0, box.y1 - box.y0) / 2, 4)
  })

  it('scatters the tilt rather than leaning every piece the same way', () => {
    const cells = gridCells(spec({ rows: 3, cols: 3, tilt: 8 }), WIDE, TALL)
    const angles = cells.map((c) => c.transform.rotation)
    expect(Math.max(...angles.map(Math.abs))).toBeLessThanOrEqual(8)
    expect(new Set(angles).size).toBeGreaterThan(4)
    expect(angles.some((a) => a > 0)).toBe(true)
    expect(angles.some((a) => a < 0)).toBe(true)
  })

  it('gives the same tilt every rebuild — the same edit, re-rendered', () => {
    const a = gridCells(spec({ rows: 3, cols: 3, tilt: 8 }), WIDE, TALL)
    const b = gridCells(spec({ rows: 3, cols: 3, tilt: 8 }), WIDE, TALL)
    expect(a.map((c) => c.transform.rotation)).toEqual(b.map((c) => c.transform.rotation))
  })
})

describe('wave cells', () => {
  const waveSpec = spec({ rows: 2, cols: 3, shape: 'wave', waveDepth: 0.3, waveCycles: 3 })

  /**
   * Where one of a cell's vertical edges sits, in CANVAS pixels, at an absolute
   * canvas y. This is the whole question: two cells interlock only if the curve
   * comes out at the same place for both of them.
   */
  function verticalEdge(
    cell: ReturnType<typeof gridCells>[number],
    which: 'left' | 'right',
    canvasY: number
  ): number {
    const box = boxOf(cell, TALL)
    const boxW = box.x1 - box.x0
    const boxH = box.y1 - box.y0
    const shape = cell.mask!.shape
    const edge = shape.wave!.vertical!
    const amplitude = which === 'left' ? edge.from : edge.to
    // The expression reads the sine off the stream's own normalised y.
    const localY = canvasY - box.y0
    const slide = amplitude * boxW * Math.sin(2 * Math.PI * (edge.cycles * (localY / boxH) + edge.phase))
    const centre = box.x0 + shape.x * boxW
    const half = shape.width * boxW
    return which === 'left' ? centre - half + slide : centre + half + slide
  }

  it('makes one cell’s right edge the same curve as its neighbour’s left', () => {
    const cells = gridCells(waveSpec, WIDE, TALL)
    const left = cells[0]
    const right = cells[1]
    for (const y of [0, 120, 337, 640, 900, 1200, 1919]) {
      const a = verticalEdge(left, 'right', y)
      const b = verticalEdge(right, 'left', y)
      /*
       * They OVERLAP by the tiling bias, and never part.
       *
       * Each shape is pushed a little past its own cell so its soft edge lands
       * on a neighbour that is still solid there — see cellMask. So the two
       * curves are the same curve a couple of pixels apart, and what has to
       * hold is that the left piece always reaches at least as far as the right
       * piece begins. Equality would mean the ramps met at a shared edge where
       * both are transparent, which is the black hairline this replaced.
       */
      expect(a).toBeGreaterThanOrEqual(b - 0.001)
      expect(a - b).toBeLessThan(4)
    }
  })

  it('runs the seam on through a row boundary without a jog', () => {
    const cells = gridCells(spec({ rows: 3, cols: 2, shape: 'wave', waveDepth: 0.3, waveCycles: 3 }), WIDE, TALL)
    const above = cells.find((c) => c.row === 0 && c.col === 0)!
    const below = cells.find((c) => c.row === 1 && c.col === 0)!
    /*
     * The two streams overlap in y — that is what the wave's headroom IS — so
     * both cells can be asked where the seam is at the same height, on either
     * side of the row boundary at 640. Same answer means one continuous curve;
     * a frequency that drifted per row would part company here.
     */
    for (const y of [580, 620, 660, 700]) {
      expect(verticalEdge(above, 'right', y)).toBeCloseTo(verticalEdge(below, 'right', y), 3)
    }
    // And it is genuinely displaced there, rather than sitting on the seam.
    expect(Math.abs(verticalEdge(above, 'right', 580) - TALL.width / 2)).toBeGreaterThan(10)
  })

  it('actually moves — a flat seam would pass the test above too', () => {
    const cells = gridCells(waveSpec, WIDE, TALL)
    const samples = [0, 200, 400, 600, 800].map((y) => verticalEdge(cells[0], 'right', y))
    const spread = Math.max(...samples) - Math.min(...samples)
    expect(spread).toBeGreaterThan(20)
  })

  it('leaves the frame’s own border straight when the pieces touch', () => {
    const cells = gridCells(waveSpec, WIDE, TALL)
    const cols = 3
    for (const cell of cells) {
      const vertical = cell.mask!.shape.wave!.vertical!
      const horizontal = cell.mask!.shape.wave!.horizontal!
      if (cell.col === 0) expect(vertical.from).toBe(0)
      if (cell.col === cols - 1) expect(vertical.to).toBe(0)
      if (cell.row === 0) expect(horizontal.from).toBe(0)
      if (cell.row === 1) expect(horizontal.to).toBe(0)
    }
  })

  it('and every outer edge lands exactly on the frame', () => {
    const cells = gridCells(waveSpec, WIDE, TALL)
    for (const cell of cells) {
      const box = boxOf(cell, TALL)
      // At or just past the frame, never inside it: a shape that stopped short
      // would leave a line of canvas down the edge of the picture. Anything
      // beyond is clipped by the stream, which costs nothing.
      if (cell.col === 0) expect(verticalEdge(cell, 'left', 500)).toBeLessThanOrEqual(0.001)
      if (cell.col === 2) {
        expect(verticalEdge(cell, 'right', 500)).toBeGreaterThanOrEqual(TALL.width - 0.001)
      }
      /*
       * The stream reaches the frame edge. It may overshoot it by a pixel or
       * two — rounding a box up to an even width grows it about its middle, and
       * whatever lands off-canvas is clipped by the overlay for nothing. What
       * must not happen is stopping short, which shows as a line of bare canvas.
       */
      if (cell.col === 0) expect(box.x0).toBeLessThanOrEqual(0.001)
      if (cell.col === 2) expect(box.x1).toBeGreaterThanOrEqual(TALL.width - 0.001)
      expect(box.x0).toBeGreaterThan(-4)
      expect(box.x1).toBeLessThan(TALL.width + 4)
    }
  })

  it('widens the stream so a crest has somewhere to land', () => {
    const flat = gridCells(spec({ rows: 2, cols: 3 }), WIDE, TALL)
    const wavy = gridCells(waveSpec, WIDE, TALL)
    // The middle cell waves on both sides, so its stream grows both ways.
    const middle = wavy.find((c) => c.row === 0 && c.col === 1)!
    const plain = flat.find((c) => c.row === 0 && c.col === 1)!
    expect(middle.transform.scale).toBeGreaterThan(plain.transform.scale)
    expect(middle.crop.width).toBeGreaterThan(plain.crop.width)
  })
})

describe('revealOrder', () => {
  it('is always a permutation of the cells', () => {
    for (const order of ['rows', 'columns', 'centre', 'diagonal', 'random', 'together'] as const) {
      const out = revealOrder(4, 5, order)
      expect([...out].sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i))
    }
  })

  it('reads left to right by default and top to bottom for columns', () => {
    expect(revealOrder(2, 3, 'rows')).toEqual([0, 1, 2, 3, 4, 5])
    expect(revealOrder(2, 3, 'columns')).toEqual([0, 3, 1, 4, 2, 5])
  })

  it('starts a centre-out reveal in the middle', () => {
    const out = revealOrder(3, 3, 'centre')
    expect(out[0]).toBe(4)
    // The corners are furthest, so they come last.
    expect(out.slice(-4).sort((a, b) => a - b)).toEqual([0, 2, 6, 8])
  })

  it('does not reshuffle between builds', () => {
    expect(revealOrder(4, 5, 'random')).toEqual(revealOrder(4, 5, 'random'))
  })
})

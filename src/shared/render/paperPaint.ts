import {
  layoutClipping,
  paperFrameAt,
  seeded,
  type Clipping,
  type Measure,
  type PaperSpec
} from './paper'

/**
 * Painting a clipping.
 *
 * Everything about WHERE is in `paper.ts` and tested without a canvas. This is
 * only ink: the torn shape, the fibre, the creases, the marker sweep.
 *
 * Same contract as `textPaint.ts` — hand it a 2D context and a size and it
 * draws. That is what lets a clipping ride the animated-text rails: the
 * existing baker calls a painter once per frame and writes numbered PNGs with
 * alpha, so a paper run reaches the timeline as an ordinary clip that
 * composites over footage with no green screen anywhere.
 */

/**
 * The fibre is a small tile, not per-pixel noise over the page.
 *
 * A 1080×1920 bake is two million pixels, and a run is thirty frames of it.
 * Generating noise per pixel per frame is sixty million operations for a
 * texture nobody can resolve; one 96px tile repeated is indistinguishable and
 * costs it once.
 */
const FIBRE_TILE = 96

let fibreCache: { key: string; pattern: CanvasPattern | null } | null = null

function fibre(
  ctx: CanvasRenderingContext2D,
  ink: string,
  seed: number
): CanvasPattern | null {
  const key = `${ink}:${seed}`
  if (fibreCache?.key === key) return fibreCache.pattern
  const tile = document.createElement('canvas')
  tile.width = FIBRE_TILE
  tile.height = FIBRE_TILE
  const tctx = tile.getContext('2d')
  if (!tctx) return null
  const rand = seeded(seed)
  tctx.strokeStyle = ink
  for (let i = 0; i < 260; i++) {
    const x = rand() * FIBRE_TILE
    const y = rand() * FIBRE_TILE
    const len = 1 + rand() * 3
    const angle = rand() * Math.PI
    tctx.globalAlpha = 0.03 + rand() * 0.05
    tctx.lineWidth = rand() < 0.8 ? 0.6 : 1.1
    tctx.beginPath()
    tctx.moveTo(x, y)
    tctx.lineTo(x + Math.cos(angle) * len, y + Math.sin(angle) * len)
    tctx.stroke()
  }
  const pattern = ctx.createPattern(tile, 'repeat')
  fibreCache = { key, pattern }
  return pattern
}

/** Trace the torn outline. */
function tearPath(ctx: CanvasRenderingContext2D, clip: Clipping): void {
  ctx.beginPath()
  clip.tear.forEach((point, i) => {
    if (i === 0) ctx.moveTo(point.x, point.y)
    else ctx.lineTo(point.x, point.y)
  })
  ctx.closePath()
}

function face(family: string, px: number, bold: boolean): string {
  return `${bold ? '700 ' : '400 '}${px}px "${family}", Georgia, serif`
}

/** Draw one clipping, with the marker swept to `sweep` (0..1). */
export function paintClipping(
  ctx: CanvasRenderingContext2D,
  clip: Clipping,
  sweep: number
): void {
  const { box, look } = clip
  ctx.save()
  ctx.translate(box.x + box.w / 2, box.y + box.h / 2)
  ctx.rotate(clip.rotation)
  ctx.translate(-(box.x + box.w / 2), -(box.y + box.h / 2))

  /* ---- the paper itself, lifted off whatever is behind it */
  ctx.save()
  ctx.shadowColor = 'rgba(0,0,0,0.38)'
  ctx.shadowBlur = box.h * 0.035
  ctx.shadowOffsetY = box.h * 0.012
  tearPath(ctx, clip)
  ctx.fillStyle = look.paper
  ctx.fill()
  ctx.restore()

  // Everything from here is inside the torn shape.
  ctx.save()
  tearPath(ctx, clip)
  ctx.clip()

  const grain = clip.texture > 0 ? fibre(ctx, look.ink, Math.round(box.w)) : null
  if (grain) {
    ctx.save()
    ctx.globalAlpha = Math.min(1, clip.texture)
    ctx.fillStyle = grain
    ctx.fillRect(box.x, box.y, box.w, box.h)
    ctx.restore()
  }

  /*
   * Two creases, and they are what sells it as paper rather than as a beige
   * rectangle: a bright fold and its shadow, slightly apart.
   */
  const rand = seeded(Math.round(box.w + box.h))
  for (let i = 0; i < (clip.texture > 0 ? 2 : 0); i++) {
    const at = box.y + box.h * (0.25 + rand() * 0.5)
    const lean = (rand() - 0.5) * box.h * 0.06
    ctx.globalAlpha = 0.5 * Math.min(1, clip.texture)
    ctx.strokeStyle = 'rgba(255,255,255,0.55)'
    ctx.lineWidth = Math.max(1, box.h * 0.004)
    ctx.beginPath()
    ctx.moveTo(box.x, at)
    ctx.lineTo(box.x + box.w, at + lean)
    ctx.stroke()
    ctx.strokeStyle = 'rgba(0,0,0,0.13)'
    ctx.beginPath()
    ctx.moveTo(box.x, at + ctx.lineWidth * 1.6)
    ctx.lineTo(box.x + box.w, at + lean + ctx.lineWidth * 1.6)
    ctx.stroke()
    ctx.globalAlpha = 1
  }

  /* ---- masthead */
  ctx.fillStyle = look.ink
  ctx.textBaseline = 'alphabetic'
  ctx.textAlign = 'center'
  ctx.font = face(look.masthead, clip.masthead.fontPx, true)
  ctx.fillText(clip.masthead.text, box.x + box.w / 2, clip.masthead.y)

  /* ---- rules */
  ctx.textAlign = 'left'
  ctx.strokeStyle = look.ink
  for (const rule of clip.rules) {
    ctx.globalAlpha = 0.75
    ctx.lineWidth = Math.max(1, box.h * 0.0035)
    ctx.beginPath()
    ctx.moveTo(box.x + box.w * 0.055, rule.y)
    ctx.lineTo(box.x + box.w * 0.945, rule.y)
    ctx.stroke()
    ctx.globalAlpha = 1
  }

  /*
   * The marker goes UNDER the headline, and it is swept rather than revealed.
   *
   * Under, because a highlighter is ink on paper and the type is already
   * there — laying it over the words greys them out and reads as a redaction.
   * Swept from the left with a slightly ragged right end, because a marker
   * drawn as a clean rectangle reads as a UI selection.
   */
  if (clip.highlight && sweep > 0) {
    const h = clip.highlight
    ctx.save()
    ctx.globalAlpha = 0.85
    ctx.fillStyle = look.highlight
    const w = h.w * Math.max(0, Math.min(1, sweep))
    ctx.beginPath()
    ctx.moveTo(h.x, h.y + h.h * 0.08)
    ctx.lineTo(h.x + w, h.y)
    ctx.lineTo(h.x + w, h.y + h.h)
    ctx.lineTo(h.x, h.y + h.h * 0.92)
    ctx.closePath()
    ctx.fill()
    ctx.restore()
  }

  /* ---- headline */
  ctx.fillStyle = look.ink
  ctx.font = face(look.headline, clip.headline.fontPx, true)
  const innerX = box.x + box.w * 0.055
  for (const line of clip.headline.lines) ctx.fillText(line.text, innerX, line.y)

  /* ---- body */
  ctx.font = face(look.body, clip.bodyPx, false)
  ctx.globalAlpha = 0.86
  for (const column of clip.columns) {
    for (const line of column.lines) {
      for (const word of line.words) ctx.fillText(word.text, word.x, line.y)
    }
  }
  ctx.globalAlpha = 1

  ctx.restore()
  ctx.restore()
}

/**
 * Draw the whole effect at a frame. The signature the baker already speaks.
 */
export function drawPaperOnto(
  ctx: CanvasRenderingContext2D,
  spec: PaperSpec,
  width: number,
  height: number,
  at: { frame: number },
  measure: Measure
): void {
  const state = paperFrameAt(spec, at.frame)
  const clip = layoutClipping(spec, state.index, width, height, measure)
  paintClipping(ctx, clip, state.sweep)
}

/** The measurer the layout needs, backed by a real canvas. */
export function canvasMeasure(ctx: CanvasRenderingContext2D): Measure {
  return (text, fontPx, family, bold) => {
    ctx.save()
    ctx.font = face(family, fontPx, bold)
    const w = ctx.measureText(text).width
    ctx.restore()
    return w
  }
}

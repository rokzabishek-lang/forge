/// <reference lib="dom" />
//
// DOM types for this file alone. `src/shared` is compiled into the main process
// too, where a canvas does not exist and where a stray `document` would be a
// real bug — so the lib is asked for here rather than widened for everything.
import type { TextSpec } from '../timeline'
import { layoutText, type TextLayout } from './textLayout'
import { piecesOf, stepAt, textAnimationById, type TextAnimation } from './textAnimation'
import {
  gradientVector,
  paintForLine,
  textStyleById,
  type Face,
  type Fill,
  type Paint
} from './textStyle'

/**
 * Painting type onto a canvas.
 *
 * Pure: a context, a spec, a size, and optionally where the clip is. No store,
 * no window, no files — which is what lets the SAME code draw a text clip in the
 * preview, bake a frame for the export, fill a style tile, and render a caption
 * in the offscreen graphics window.
 *
 * That last one is the reason this lives in shared rather than in the renderer.
 * Captions used to be drawn by a second painter of their own, which is how they
 * ended up unable to use any of the styles: two painters means every look has to
 * be built twice, so in practice it is built once and the other one goes without.
 */

/**
 * Draw the type onto a context that is already the right size.
 *
 * Split out from the PNG bake so the preview can draw the same letters with the
 * same layout without going near a file. Typing used to cost a full-canvas PNG
 * encode, an IPC transfer, a disk write and a re-decode on every pause in
 * typing, and the picture on screen could not change until all of that had
 * finished. This is the drawing on its own — microseconds, no round trip.
 *
 * The font must already be loaded; `renderTextPng` awaits it, and the preview
 * warms it when the clip is selected.
 */
export function drawTextOnto(
  ctx: CanvasRenderingContext2D,
  spec: TextSpec,
  width: number,
  height: number,
  /**
   * Where the clip is, for an animation. Frames from the clip's first frame.
   *
   * Optional so every existing caller draws the settled text — a tile, a still
   * preview and the plain bake all want the finished state, not frame zero.
   */
  clock?: { frame: number; fps: number }
): void {
  const layout = layoutText(spec, width, height)
  const style = textStyleById(spec.styleId)
  const animation = clock ? textAnimationById(spec.animationId) : null

  ctx.textAlign = layout.anchor === 'middle' ? 'center' : layout.anchor === 'end' ? 'right' : 'left'
  ctx.textBaseline = 'alphabetic'

  /*
   * Re-centre when a style changes a line's size.
   *
   * `layoutText` sizes the block from the clip's own font size, which is right
   * until a style makes the second line 1.6x or 0.4x of it. Then the real block
   * is taller or shorter than the layout assumed and the whole thing drifts off
   * its anchor — a "Hero" style, whose entire shape is a big middle line, would
   * sit visibly high. Measuring the styled heights first and shifting by the
   * difference keeps the block anchored where the layout promised.
   */
  /*
   * Long text wraps; it does not shrink away.
   *
   * The first version scaled the whole block down until it fitted, which meant
   * a long headline became a small headline — and the on-picture editing box,
   * which is HTML and wraps by itself, showed something different from the
   * render. Two answers to the same question is the bug, whichever is prettier.
   *
   * So the canvas wraps at the same safe margin the editing box uses, and only
   * falls back to shrinking when a single unbreakable word is still too wide —
   * because there is nowhere for that word to go, and clipping it would hide
   * part of what was written.
   */
  const safeWidth = Math.max(1, width - layout.marginX * 2)

  interface Row {
    text: string
    paint: (Paint & Face) | null
    /** Set only for the word-accent modes, where one word differs. */
    accent?: { paint: Paint & Face; word: number }
    /** Index of this row's first word within the whole text. */
    firstWord: number
    px: number
  }

  const rows: Row[] = []
  let wordsSoFar = 0
  layout.lines.forEach((paragraph, index) => {
    const paint = style ? paintForLine(style, index) : null
    const px = Math.max(6, Math.round(layout.fontPx * (paint?.sizeScale ?? 1)))
    ctx.font = fontString(paint, spec, px)
    ctx.letterSpacing = `${((paint?.tracking ?? spec.tracking) * px).toFixed(2)}px`
    const cased = paint?.uppercase ? paragraph.toUpperCase() : paragraph

    if (!cased.trim()) {
      rows.push({ text: ' ', paint, px, firstWord: wordsSoFar })
      return
    }

    // Greedy wrapping, the same rule a browser and libass both use.
    let current = ''
    let firstWord = wordsSoFar
    for (const word of cased.split(/\s+/).filter(Boolean)) {
      const candidate = current ? `${current} ${word}` : word
      if (current && ctx.measureText(candidate).width > safeWidth) {
        rows.push({ text: current, paint, px, firstWord })
        firstWord = wordsSoFar
        current = word
      } else {
        current = candidate
      }
      wordsSoFar++
    }
    rows.push({ text: current, paint, px, firstWord })
  })

  /*
   * Word accents are resolved after wrapping, not before.
   *
   * "the last word of the line" has no meaning until the line exists — a
   * paragraph that wraps into three rows has three last words, and highlighting
   * the last word of the PARAGRAPH would leave two rows plain and look like a
   * mistake rather than a style.
   */
  const scope = style?.accentScope
  if (style?.accent && (scope === 'lastWord' || scope === 'firstWord')) {
    const merged = { ...style.base, ...style.accent } as Paint & Face
    for (const row of rows) {
      const count = row.text.trim().split(/\s+/).length
      if (count > 1) row.accent = { paint: merged, word: scope === 'lastWord' ? count - 1 : 0 }
    }
  }

  /*
   * The word being spoken.
   *
   * This is what a caption is: the same line, held, with the highlight walking
   * along it. It is deliberately NOT a style — it rides on top of whichever
   * style the line already has, so a gradient caption keeps its gradient and
   * only the active word changes colour and size. A style could not express it
   * anyway: the index moves every few frames.
   *
   * Resolved after wrapping for the same reason as the accents above: which ROW
   * a word is in is not known until the rows exist.
   */
  const highlight = spec.highlight
  if (highlight && highlight.word >= 0) {
    for (const row of rows) {
      const count = row.text.trim() ? row.text.trim().split(/\s+/).length : 0
      const within = highlight.word - row.firstWord
      if (within < 0 || within >= count) continue
      const base = row.paint ?? plainPaint(spec)
      row.accent = {
        paint: {
          ...base,
          ...(highlight.color ? { fill: { kind: 'solid', color: highlight.color } } : {}),
          sizeScale: (base.sizeScale ?? 1) * (highlight.scale ?? 1)
        } as Paint & Face,
        word: within
      }
      // A row also carrying a style's own word accent would be two answers to
      // one question; the spoken word wins, because it is the one that moves.
      break
    }
  }

  /*
   * One word wider than the frame still has to fit somehow.
   *
   * Scaled as a whole rather than per row, so the proportion between a heavy
   * first line and its accent — which in these styles IS the design — survives.
   */
  let fit = 1
  for (const row of rows) {
    ctx.font = fontString(row.paint, spec, row.px)
    ctx.letterSpacing = `${((row.paint?.tracking ?? spec.tracking) * row.px).toFixed(2)}px`
    const measured = ctx.measureText(row.text).width
    if (measured > safeWidth) fit = Math.min(fit, safeWidth / measured)
  }

  const sizes = rows.map((row) => Math.max(6, Math.round(row.px * fit)))
  const lineHeights = sizes.map((px) => Math.round(px * 1.18))
  const styledBlock = lineHeights.reduce((sum, h) => sum + h, 0)
  const drift = layout.blockHeight - styledBlock
  const shift =
    spec.position === 'top' ? 0 : spec.position === 'lower' ? drift : Math.round(drift / 2)

  let y = layout.firstBaseline + shift
  rows.forEach((row, index) => {
    const paint = row.paint
    const fontPx = sizes[index]
    ctx.font = fontString(paint, spec, fontPx)
    const tracking = (paint?.tracking ?? spec.tracking) * fontPx
    ctx.letterSpacing = `${tracking.toFixed(2)}px`

    const text = row.text || ' '
    // The trailing letter-space shifts centred text; the nudge follows tracking,
    // which a per-row size may have just changed.
    const x = layout.x + (layout.anchor === 'middle' ? tracking / 2 : 0)

    if (animation && clock) {
      paintAnimated(ctx, text, paint, row.accent, fontPx, x, y, layout.anchor, spec, {
        animation,
        frame: clock.frame,
        fps: clock.fps,
        layout
      })
    } else if (!paint && !row.accent) {
      drawPlain(ctx, text, x, y, layout, spec)
    } else if (row.accent) {
      /*
       * One word painted differently from the rest of its line.
       *
       * "Smooth Ocean" colours the second WORD, which no amount of per-line
       * styling can express — and half the reference set does it. Segments are
       * measured and placed by hand, because two fonts on one line means the
       * canvas cannot centre it for us.
       */
      paintSegments(
        ctx,
        row.text,
        paint ?? plainPaint(spec),
        row.accent,
        fontPx,
        x,
        y,
        layout.anchor,
        spec
      )
    } else {
      paintLine(ctx, text, x, y, fontPx, paint ?? plainPaint(spec), spec)
    }

    y += lineHeights[index]
  })
}

/**
 * The bare spec, as a Paint.
 *
 * A caption with no style chosen still has to be able to highlight one word, and
 * the segment painter speaks only Paint. This says what the styleless drawing
 * has always done — fill, outline, soft shadow — in the vocabulary the rest of
 * the painter uses, so "no style" is one more style rather than a special case.
 */
export function plainPaint(spec: TextSpec): Paint & Face {
  return {
    fill: { kind: 'solid', color: spec.color },
    ...(spec.stroke > 0
      ? { stroke: { width: spec.stroke, color: spec.strokeColor } }
      : {}),
    ...(spec.shadow > 0
      ? { shadow: { blur: 0.08, dy: 0.05, color: '#000000', opacity: spec.shadow } }
      : {})
  }
}

/** The canvas font shorthand for a line, with the clip's own face as fallback. */
function fontString(paint: (Paint & Face) | null, spec: TextSpec, px: number): string {
  const italic = paint?.italic ? 'italic ' : ''
  const weight = Math.round(paint?.weight ?? spec.weight)
  const family = paint?.font ?? spec.font
  return `${italic}${weight} ${px}px "${family}", "${spec.font}", sans-serif`
}

/** The original, styleless drawing. Kept exactly as it was for untouched clips. */
function drawPlain(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  layout: ReturnType<typeof layoutText>,
  spec: TextSpec
): void {
  /*
   * Shadow first, on its own pass.
   *
   * Canvas applies the shadow to the stroke as well as the fill, so drawing
   * both in one pass with a shadow set doubles it up round the outline and
   * reads as a smear rather than a lift.
   */
  if (layout.shadow) {
    ctx.save()
    ctx.shadowColor = `rgba(0,0,0,${layout.shadow.opacity})`
    ctx.shadowBlur = layout.shadow.blur
    ctx.shadowOffsetY = layout.shadow.dy
    ctx.fillStyle = spec.color
    ctx.fillText(text, x, y)
    ctx.restore()
  }

  if (layout.strokeWidth > 0) {
    ctx.lineWidth = layout.strokeWidth
    ctx.lineJoin = 'round'
    ctx.strokeStyle = spec.strokeColor
    ctx.strokeText(text, x, y)
  }

  ctx.fillStyle = spec.color
  ctx.fillText(text, x, y)
}

/**
 * One styled line.
 *
 * Order: box, glow, extrude, split, shadow, outline, fill, rule. Each of the
 * soft ones is its own pass with the others switched off, because canvas
 * applies a shadow to everything drawn in that pass — set a shadow and stroke
 * in one go and the outline grows its own smeared copy, which is exactly what
 * makes a hand-rolled version of these looks read as cheap.
 */
function paintLine(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  fontPx: number,
  paint: Paint & Face,
  spec: TextSpec
): void {
  const w = ctx.measureText(text).width
  const left =
    ctx.textAlign === 'center' ? x - w / 2 : ctx.textAlign === 'right' ? x - w : x

  drawBox(ctx, left, y, w, fontPx, paint)

  /*
   * Glow: several blurred passes, not one.
   *
   * A single canvas shadow at a large blur is far too faint to read as a glow —
   * the energy is spread over the whole radius. Redrawing the same blurred
   * shape two or three times accumulates it, which is how a compositor builds
   * one.
   */
  if (paint.glow && paint.glow.opacity > 0) {
    const { blur, color, opacity } = paint.glow
    ctx.save()
    ctx.shadowColor = withAlpha(color, opacity)
    ctx.shadowBlur = blur * fontPx
    ctx.shadowOffsetX = 0
    ctx.shadowOffsetY = 0
    ctx.fillStyle = withAlpha(color, Math.min(1, opacity))
    for (let pass = 0; pass < (paint.glow.passes ?? 2); pass++) ctx.fillText(text, x, y)
    ctx.restore()
  }

  /*
   * Extrude: the same glyph stepped, not blurred.
   *
   * Drawn back to front so the nearest step covers the ones behind it and the
   * side reads as solid. A blurred shadow can never do this — the hard edge IS
   * the effect.
   */
  if (paint.extrude && paint.extrude.steps > 0) {
    const { dx, dy, steps, color } = paint.extrude
    ctx.save()
    ctx.fillStyle = color
    for (let step = steps; step >= 1; step--) {
      ctx.fillText(text, x + dx * fontPx * step, y + dy * fontPx * step)
    }
    ctx.restore()
  }

  // Chromatic split, behind the fill so the fill stays legible on top of it.
  if (paint.split) {
    const { dx, dy = 0, colorA, colorB, opacity = 1 } = paint.split
    ctx.save()
    ctx.globalAlpha = opacity
    ctx.fillStyle = colorA
    ctx.fillText(text, x - dx * fontPx, y - dy * fontPx)
    ctx.fillStyle = colorB
    ctx.fillText(text, x + dx * fontPx, y + dy * fontPx)
    ctx.restore()
  }

  if (paint.shadow && paint.shadow.opacity > 0) {
    const { dy, blur, color, opacity } = paint.shadow
    ctx.save()
    ctx.shadowColor = withAlpha(color, opacity)
    ctx.shadowBlur = blur * fontPx
    ctx.shadowOffsetY = dy * fontPx
    ctx.fillStyle = '#000000'
    ctx.fillText(text, x, y)
    ctx.restore()
  }

  if (paint.stroke && paint.stroke.width > 0) {
    ctx.save()
    ctx.lineWidth = paint.stroke.width * fontPx
    ctx.lineJoin = 'round'
    ctx.miterLimit = 2
    ctx.strokeStyle = paint.stroke.color
    ctx.strokeText(text, x, y)
    ctx.restore()
  }

  // Hollow type has no fill at all; its outline is carrying the whole look.
  if (paint.fill.kind !== 'none') {
    ctx.save()
    ctx.fillStyle = fillStyleFor(ctx, paint.fill, text, x, y, fontPx)
    ctx.fillText(text, x, y)
    ctx.restore()
  }

  // A style with no stroke of its own still honours the clip's outline control,
  // so the manual slider is not silently disabled by picking a style.
  if (!paint.stroke && spec.stroke > 0) {
    ctx.save()
    ctx.lineWidth = spec.stroke * fontPx
    ctx.lineJoin = 'round'
    ctx.strokeStyle = spec.strokeColor
    ctx.strokeText(text, x, y)
    ctx.restore()
  }

  drawRule(ctx, left, y, w, fontPx, paint)
}

/**
 * One row, in motion.
 *
 * The row is cut into the pieces the animation moves — words, characters, or
 * the whole line — and each is drawn at its own offset, size and opacity. The
 * pieces are laid out at their RESTING positions first and then displaced, so
 * an animation never changes where the text ends up: the settled frame is
 * identical to the unanimated one, which is what lets the export bake a handful
 * of moving frames and hold the last one for the rest of the clip.
 *
 * Each piece is painted by the ordinary single-paint path, so an animated word
 * still gets its glow, its extrude and its outline.
 */
function paintAnimated(
  ctx: CanvasRenderingContext2D,
  text: string,
  paint: (Paint & Face) | null,
  accent: { paint: Paint & Face; word: number } | undefined,
  fontPx: number,
  x: number,
  baseline: number,
  anchor: 'start' | 'middle' | 'end',
  spec: TextSpec,
  motion: { animation: TextAnimation; frame: number; fps: number; layout: TextLayout }
): void {
  const { animation, frame, fps } = motion
  const parts = piecesOf(text, animation.scope)

  // Whitespace keeps its width but is never a piece in its own right: a gap
  // that pops in would read as a stutter.
  const movable = parts.map((part) => part.trim().length > 0)
  const count = Math.max(1, movable.filter(Boolean).length)

  const widths = parts.map((part) => ctx.measureText(part).width)
  const total = widths.reduce((sum, w) => sum + w, 0)
  const left = anchor === 'middle' ? x - total / 2 : anchor === 'end' ? x - total : x

  /*
   * Which pieces the accent lands on.
   *
   * The accent is indexed by WORD, but a character-scope animation counts
   * LETTERS — so an accent on word two has to become "every letter of word two",
   * or it would land on the second letter of word one. Word scope is the easy
   * case, where a piece and a word are the same thing.
   */
  const accentPieces = new Set<number>()
  if (accent) {
    let piece = -1
    let word = 0
    let started = false
    parts.forEach((part, index) => {
      if (!movable[index]) {
        // A gap ends the current word; the next real piece starts the next one.
        if (started) word += 1
        started = false
        return
      }
      piece += 1
      started = true
      if (animation.scope === 'char') {
        if (word === accent.word) accentPieces.add(piece)
      } else if (piece === accent.word) {
        accentPieces.add(piece)
      }
    })
  }

  const previousAlign = ctx.textAlign
  ctx.textAlign = 'left'

  let cursor = left
  let moving = -1
  parts.forEach((part, index) => {
    const width = widths[index]
    if (!movable[index]) {
      cursor += width
      return
    }
    moving += 1

    const step = stepAt(animation, frame, fps, moving, count)
    if (step.alpha > 0.002) {
      const piecePaint = accentPieces.has(moving) ? accent!.paint : (paint ?? null)

      ctx.save()
      ctx.globalAlpha = Math.max(0, Math.min(1, step.alpha))
      /*
       * Scaled about the piece's own centre, not the canvas origin.
       *
       * Scaling about the origin would fling every word off toward the corner —
       * the classic version of this bug, where a "pop" turns into a slide.
       */
      const cx = cursor + width / 2
      const cy = baseline - fontPx * 0.37
      ctx.translate(cx + step.dx * fontPx, cy + step.dy * fontPx)
      ctx.scale(step.scale, step.scale)
      ctx.translate(-cx, -cy)

      if (piecePaint) {
        paintLine(ctx, part, cursor, baseline, fontPx, piecePaint, spec)
      } else {
        drawPlain(ctx, part, cursor, baseline, motion.layout, spec)
      }
      ctx.restore()
    }

    cursor += width
  })

  ctx.textAlign = previousAlign
}

/** The block behind the words. */
function drawBox(
  ctx: CanvasRenderingContext2D,
  left: number,
  baseline: number,
  width: number,
  fontPx: number,
  paint: Paint
): void {
  if (!paint.box) return
  const { color, padX, padY, radius, opacity = 1 } = paint.box
  // Cap height rather than the em box: a bar sized to the em floats away from
  // the letters it is supposed to be holding.
  const capHeight = fontPx * 0.74
  const x = left - padX * fontPx
  const y = baseline - capHeight - padY * fontPx
  const w = width + padX * fontPx * 2
  const h = capHeight + padY * fontPx * 2
  ctx.save()
  ctx.globalAlpha = opacity
  ctx.fillStyle = color
  ctx.beginPath()
  ctx.roundRect(x, y, w, h, radius * fontPx)
  ctx.fill()
  ctx.restore()
}

/** A rule through the words, or under them. */
function drawRule(
  ctx: CanvasRenderingContext2D,
  left: number,
  baseline: number,
  width: number,
  fontPx: number,
  paint: Paint
): void {
  if (!paint.line) return
  const { kind, color, width: thickness } = paint.line
  const y = kind === 'strike' ? baseline - fontPx * 0.26 : baseline + fontPx * 0.14
  ctx.save()
  ctx.strokeStyle = color
  ctx.lineWidth = thickness * fontPx
  ctx.lineCap = 'round'
  ctx.beginPath()
  ctx.moveTo(left - fontPx * 0.04, y)
  ctx.lineTo(left + width + fontPx * 0.04, y)
  ctx.stroke()
  ctx.restore()
}

/**
 * A line where one word is painted differently from the rest.
 *
 * Two paints on one line means the canvas cannot centre it for us, so the
 * pieces are measured and placed by hand from a computed left edge. Each piece
 * is then drawn by the ordinary single-paint path, so a highlighted word gets
 * the same glow, extrude and outline treatment as anything else.
 */
function paintSegments(
  ctx: CanvasRenderingContext2D,
  text: string,
  base: Paint & Face,
  accent: { paint: Paint & Face; word: number },
  fontPx: number,
  x: number,
  baseline: number,
  anchor: 'start' | 'middle' | 'end',
  spec: TextSpec
): void {
  const words = text.trim().split(/\s+/)
  const pieces = words.map((word, index) => {
    const paint = index === accent.word ? accent.paint : base
    /*
     * Each word gets its own size.
     *
     * The spoken word in a caption is bigger than the rest of its line — that
     * pop IS the trending look, and one shared size for the whole row could not
     * express it. The sizes are relative to the row's, so the accent's scale
     * multiplies rather than replaces.
     */
    const scale = (paint.sizeScale ?? 1) / (base.sizeScale ?? 1)
    return { text: word, paint, px: Math.max(6, Math.round(fontPx * scale)) }
  })

  ctx.font = fontString(base, spec, fontPx)
  const space = ctx.measureText(' ').width
  const widths = pieces.map((piece) => {
    ctx.font = fontString(piece.paint, spec, piece.px)
    return ctx.measureText(piece.text).width
  })
  const total = widths.reduce((sum, w) => sum + w, 0) + space * (pieces.length - 1)

  const left = anchor === 'middle' ? x - total / 2 : anchor === 'end' ? x - total : x

  const previousAlign = ctx.textAlign
  ctx.textAlign = 'left'
  let cursor = left
  pieces.forEach((piece, index) => {
    ctx.font = fontString(piece.paint, spec, piece.px)
    paintLine(ctx, piece.text, cursor, baseline, piece.px, piece.paint, spec)
    cursor += widths[index] + space
  })
  ctx.textAlign = previousAlign
}

/**
 * A fill, measured against the line it is filling.
 *
 * A gradient has to be built around THIS line's box — its measured width and
 * its own cap height — or a two-line style ramps across the wrong distance and
 * the second line comes out a flat slab of the end colour.
 */
function fillStyleFor(
  ctx: CanvasRenderingContext2D,
  fill: Fill,
  text: string,
  x: number,
  y: number,
  fontPx: number
): string | CanvasGradient {
  if (fill.kind === 'solid') return fill.color
  // Hollow type never reaches here, but the narrowing has to be explicit.
  if (fill.kind === 'none') return 'transparent'

  const measured = ctx.measureText(text)
  const w = Math.max(1, measured.width)
  // Cap height, roughly: the ramp should span the letters, not the em box with
  // its empty shoulders, or the bright and dark bands land off the glyphs.
  const h = Math.max(1, fontPx * 0.74)
  const cx = ctx.textAlign === 'center' ? x : ctx.textAlign === 'right' ? x - w / 2 : x + w / 2
  const cy = y - h / 2

  const v = gradientVector(fill.angle, w, h)
  const gradient = ctx.createLinearGradient(cx + v.x0, cy + v.y0, cx + v.x1, cy + v.y1)
  for (const stop of fill.stops) {
    gradient.addColorStop(Math.max(0, Math.min(1, stop.at)), stop.color)
  }
  return gradient
}

/** #rrggbb plus an opacity, as the only colour form these styles use. */
function withAlpha(color: string, alpha: number): string {
  const hex = color.replace('#', '')
  if (hex.length !== 6) return color
  const r = parseInt(hex.slice(0, 2), 16)
  const g = parseInt(hex.slice(2, 4), 16)
  const b = parseInt(hex.slice(4, 6), 16)
  return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, alpha))})`
}

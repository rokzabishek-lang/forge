import type { Clip, Project } from '@shared/timeline'
import { framesToSeconds, sourceFrameFor } from '@shared/timeline'
import { groupWords, REFERENCE_HEIGHT } from '@shared/captions/ass'
import { resolveStyle, type CaptionStyle, type StyleOverrides } from '@shared/captions/style'
import type { Word } from '@shared/transcript'

/**
 * Draw captions onto the preview canvas.
 *
 * This mirrors what libass will burn at export rather than rendering the same
 * pixels — close enough to judge font, size, colour, position and timing, which
 * is what a preview is for. Waiting for a render to see whether a caption style
 * works is the single most tedious loop in this kind of tool.
 */
export interface CaptionPreviewTarget {
  /** Where the output frame is drawn, in canvas pixels. */
  x: number
  y: number
  width: number
  height: number
}

export function activeCaptionStyle(project: Project): CaptionStyle {
  return resolveStyle(
    project.captions.styleId,
    project.captions.overrides as StyleOverrides | undefined
  )
}

/** The words on screen at a playhead frame, and which of them is being spoken. */
export function captionAt(
  project: Project,
  clip: Clip,
  frame: number,
  style: CaptionStyle
): { words: Word[]; activeIndex: number } | null {
  const transcript = project.transcripts[clip.assetId]
  if (!transcript) return null

  const sourceMs = framesToSeconds(sourceFrameFor(clip, frame), project.settings.fps) * 1000
  const groups = groupWords(transcript.segments, transcript.words, style.wordsPerLine)

  for (const group of groups) {
    const first = group[0]
    const last = group[group.length - 1]
    if (sourceMs < first.startMs || sourceMs >= last.endMs) continue

    // The spoken word holds until the next begins, matching the ASS output.
    let activeIndex = 0
    for (let i = 0; i < group.length; i++) {
      const end = group[i + 1]?.startMs ?? group[i].endMs
      if (sourceMs >= group[i].startMs && sourceMs < end) {
        activeIndex = i
        break
      }
      if (sourceMs >= group[i].startMs) activeIndex = i
    }
    return { words: group, activeIndex }
  }
  return null
}

export function drawCaptions(
  ctx: CanvasRenderingContext2D,
  target: CaptionPreviewTarget,
  style: CaptionStyle,
  caption: { words: Word[]; activeIndex: number }
): void {
  // Every style dimension is authored against a 1080-tall frame.
  const scale = target.height / REFERENCE_HEIGHT
  const fontSize = style.fontSize * scale
  const outline = style.outlineWidth * scale
  const marginV = style.marginV * scale

  const weight = style.bold ? '700' : '400'
  const baseFont = `${weight} ${fontSize}px "${style.fontFamily}", sans-serif`

  const pieces = caption.words.map((word, index) => ({
    text: style.uppercase ? word.text.toUpperCase() : word.text,
    active: index === caption.activeIndex
  }))

  const spaceWidth = (): number => {
    ctx.font = baseFont
    return ctx.measureText(' ').width
  }

  const widths = pieces.map((piece) => {
    const size = piece.active ? fontSize * style.highlightScale : fontSize
    ctx.font = `${weight} ${size}px "${style.fontFamily}", sans-serif`
    return ctx.measureText(piece.text).width
  })

  const gap = spaceWidth()
  const totalWidth = widths.reduce((sum, w) => sum + w, 0) + gap * (pieces.length - 1)

  const centreX = target.x + target.width / 2
  const y =
    style.position === 'top'
      ? target.y + marginV + fontSize
      : style.position === 'center'
        ? target.y + target.height / 2 + fontSize / 3
        : target.y + target.height - marginV

  let cursor = centreX - totalWidth / 2

  ctx.save()
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
  ctx.lineJoin = 'round'

  pieces.forEach((piece, index) => {
    const size = piece.active ? fontSize * style.highlightScale : fontSize
    ctx.font = `${weight} ${size}px "${style.fontFamily}", sans-serif`

    if (style.shadowDepth > 0) {
      ctx.shadowColor = 'rgba(0,0,0,0.75)'
      ctx.shadowBlur = 0
      ctx.shadowOffsetX = style.shadowDepth * scale
      ctx.shadowOffsetY = style.shadowDepth * scale
    }

    if (outline > 0) {
      // Stroke first, fill second: stroking over the fill eats into thin glyphs.
      ctx.strokeStyle = style.outlineColor
      ctx.lineWidth = outline * 2
      ctx.strokeText(piece.text, cursor, y)
    }

    ctx.shadowColor = 'transparent'
    ctx.fillStyle = piece.active ? style.highlightColor : style.primaryColor
    ctx.fillText(piece.text, cursor, y)

    cursor += widths[index] + gap
  })

  ctx.restore()
}

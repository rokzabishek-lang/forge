import type { Clip, Project } from '@shared/timeline'
import { framesToSeconds, secondsToFrames, sourceFrameFor } from '@shared/timeline'
import { groupWords } from '@shared/captions/ass'
import { activeWordAt, captionSpec } from '@shared/captions/line'
import { resolveStyle, type CaptionStyle, type StyleOverrides } from '@shared/captions/style'
import { drawTextOnto } from '@shared/render/textPaint'
import type { Word } from '@shared/transcript'

/**
 * Draw captions onto the preview canvas.
 *
 * This used to be a painter of its own, mirroring what libass would burn in.
 * Two painters for one thing is why captions could never have a gradient or a
 * glow: every look would have had to be built twice, so in practice it was built
 * once for text clips and captions went without.
 *
 * Now the line is built by the shared caption builder and drawn by the shared
 * text painter — the same two functions the export calls. Whatever the preview
 * shows, the render draws, because there is only one answer to give.
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

export interface PreviewCaption {
  words: Word[]
  activeIndex: number
  /** Frames since this line appeared, so its animation plays as it arrives. */
  sinceStart: number
}

/** The words on screen at a playhead frame, and which of them is being spoken. */
export function captionAt(
  project: Project,
  clip: Clip,
  frame: number,
  style: CaptionStyle
): PreviewCaption | null {
  const transcript = project.transcripts[clip.assetId]
  if (!transcript) return null

  const fps = project.settings.fps
  const sourceMs = framesToSeconds(sourceFrameFor(clip, frame), fps) * 1000
  const groups = groupWords(transcript.segments, transcript.words, style.wordsPerLine)

  for (const group of groups) {
    const activeIndex = activeWordAt(group, sourceMs)
    if (activeIndex < 0) continue
    return {
      words: group,
      activeIndex,
      sinceStart: secondsToFrames((sourceMs - group[0].startMs) / 1000, fps)
    }
  }
  return null
}

export function drawCaptions(
  ctx: CanvasRenderingContext2D,
  target: CaptionPreviewTarget,
  style: CaptionStyle,
  caption: PreviewCaption,
  fps: number
): void {
  const spec = captionSpec(style, caption.words, caption.activeIndex)

  /*
   * Drawn into the target box directly, rather than at output size and scaled.
   *
   * Every dimension in the spec is a fraction — of the height for the type, of
   * the width for the margin — so painting into a 400px preview box and into a
   * 1920px frame produce the same picture at two sizes. That is what makes this
   * a preview of the export rather than an impression of it.
   */
  ctx.save()
  ctx.translate(target.x, target.y)
  drawTextOnto(
    ctx,
    spec,
    target.width,
    target.height,
    spec.animationId ? { frame: caption.sinceStart, fps } : undefined
  )
  ctx.restore()
}

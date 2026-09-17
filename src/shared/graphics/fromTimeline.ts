import type { Project } from '../timeline'
import { clipsOnTrack, framesToSeconds, secondsToFrames } from '../timeline'
import { groupWords } from '../captions/ass'
import { captionSpec } from '../captions/line'
import { resolveStyle, type CaptionStyle, type StyleOverrides } from '../captions/style'
import type { CaptionLayer, GraphicsSpec } from './spec'
import { captionTrack } from '../captions/timeline'

/**
 * Compile a timeline into a graphics spec for the frame server.
 *
 * Only the things ASS genuinely cannot draw end up here. Everything flat and
 * text-shaped stays on tier 1, where libass renders it during the normal encode
 * at no extra cost. See docs/PLAN.md §3b.
 */

export interface GraphicsBuildOptions {
  width: number
  height: number
}

/**
 * True when the project needs the frame server at all.
 *
 * Deliberately a property of the request rather than of the feature: "captions"
 * is not a tier, *these* captions with *these* options are.
 */
export function needsFrameServer(_project: Project): boolean {
  /*
   * Nothing does, any more.
   *
   * Captions were the only thing that ever went to the offscreen browser, and
   * they are baked in the renderer now — one pass instead of two, and no
   * `capturePage()` per frame. Kept as a function rather than deleted because
   * the frame server itself still works and is where a future graphics layer
   * that genuinely needs a DOM would go; what changed is that captions are not
   * that thing. See docs/EFFECTS.md §13.
   */
  return false
}

/** Whether these captions have to be drawn rather than burned in by libass. */
export function captionsNeedBaking(project: Project): boolean {
  if (!project.captions?.enabled) return false
  if (Object.keys(project.transcripts).length === 0) return false
  return captionNeedsCanvas(
    resolveStyle(
      project.captions.styleId,
      project.captions.overrides as StyleOverrides | undefined
    )
  )
}

/**
 * Whether these captions have to be drawn rather than burned in.
 *
 * ASS is genuinely cheaper — libass runs inside the normal encode and costs
 * nothing extra — so it stays the answer for anything it can actually express.
 * What it cannot express is a gradient or metallic fill, a glow, an extrusion, a
 * highlight block, and any per-word easing: karaoke tags recolour but cannot
 * scale, and there is no timing curve to reach.
 */
export function captionNeedsCanvas(style: CaptionStyle): boolean {
  return (
    style.animated === true ||
    style.textStyleId !== undefined ||
    style.animationId !== undefined
  )
}

/**
 * Caption layers, one per LINE.
 *
 * This used to emit one layer per word, each placed by guessing that a word is
 * about 2.2 font sizes wide — which is not true of any real font, and left the
 * spacing of every caption slightly wrong in a way no amount of style work could
 * fix. A line is now one layer carrying a text spec, and the page measures and
 * lays it out with the same painter the rest of the app uses. The per-word part
 * that genuinely varies — which word is lit — survives as `wordFrames`.
 */
export function buildGraphicsSpec(
  project: Project,
  options: GraphicsBuildOptions
): GraphicsSpec | null {
  const fps = project.settings.fps
  const style = resolveStyle(
    project.captions.styleId,
    project.captions.overrides as StyleOverrides | undefined
  )

  // The same track the burned-in path builds from, so the two cannot disagree.
  const videoTrack = captionTrack(project)
  if (!videoTrack) return null

  const layers: CaptionLayer[] = []

  for (const clip of clipsOnTrack(project, videoTrack.id)) {
    const transcript = project.transcripts[clip.assetId]
    if (!transcript) continue

    const clipStartMs = framesToSeconds(clip.inPoint, fps) * 1000
    const clipEndMs = clipStartMs + framesToSeconds(clip.duration, fps) * 1000
    /*
     * Source ms -> timeline frames, through where the clip actually SITS.
     *
     * This used to accumulate durations into a running cursor, which equals
     * `clip.start` only while every clip is packed against its neighbour from
     * zero. One gap and every caption after it drifts.
     */
    const at = (ms: number): number =>
      clip.start + secondsToFrames((ms - clipStartMs) / 1000, fps)

    for (const group of groupWords(transcript.segments, transcript.words, style.wordsPerLine)) {
      // A line the clip does not actually show is not a line.
      const visible = group.filter((w) => w.endMs > clipStartMs && w.startMs < clipEndMs)
      if (visible.length === 0) continue

      const startFrame = Math.max(clip.start, at(visible[0].startMs))
      const endFrame = Math.min(
        clip.start + clip.duration,
        at(visible[visible.length - 1].endMs)
      )
      if (endFrame <= startFrame) continue

      layers.push({
        id: `cap-${clip.id}-${visible[0].index}`,
        kind: 'caption',
        startFrame,
        endFrame,
        // The highlight is left off: it moves, so the page sets it per frame.
        spec: captionSpec(style, visible, -1),
        wordFrames: visible.map((w) => at(w.startMs)),
        highlight: { color: style.highlightColor, scale: style.highlightScale }
      })
    }
  }

  if (layers.length === 0) return null

  return {
    width: options.width,
    height: options.height,
    fps,
    durationFrames: Math.max(...layers.map((l) => l.endFrame)),
    layers
  }
}

export function captionStyleIsAnimated(style: CaptionStyle): boolean {
  return style.animated === true
}

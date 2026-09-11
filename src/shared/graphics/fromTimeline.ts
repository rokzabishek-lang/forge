import type { Project } from '../timeline'
import { clipsOnTrack, framesToSeconds, secondsToFrames } from '../timeline'
import { groupWords, REFERENCE_HEIGHT } from '../captions/ass'
import { resolveStyle, type CaptionStyle, type StyleOverrides } from '../captions/style'
import type { GraphicsSpec, TextLayer } from './spec'
import { popIn } from './spec'

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

/** Frames a word's pop-in takes, at the reference frame rate. */
const POP_FRAMES = 5

/**
 * True when the project needs the frame server at all.
 *
 * Deliberately a property of the request rather than of the feature: "captions"
 * is not a tier, *these* captions with *these* options are.
 */
export function needsFrameServer(project: Project): boolean {
  if (!project.captions?.enabled) return false
  const style = resolveStyle(
    project.captions.styleId,
    project.captions.overrides as StyleOverrides | undefined
  )
  // Animation per word is the thing ASS cannot express: karaoke tags recolour
  // but cannot scale, and there is no per-word easing.
  return style.animated === true && Object.keys(project.transcripts).length > 0
}

/**
 * Caption layers, one text layer per word.
 *
 * Word-level layers rather than one layer per line: each word needs its own
 * entry time and its own scale curve, which is the entire point of coming to
 * tier 2 for this.
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

  const videoTrack = project.tracks.find((t) => t.kind === 'video' && !t.hidden)
  if (!videoTrack) return null

  const scale = options.height / REFERENCE_HEIGHT
  const fontSize = style.fontSize * scale
  const layers: TextLayer[] = []

  // Where the caption sits vertically, as a fraction of the frame.
  const anchorY =
    style.position === 'top'
      ? (style.marginV * scale) / options.height + 0.06
      : style.position === 'center'
        ? 0.5
        : 1 - (style.marginV * scale) / options.height

  let timelineCursorFrames = 0

  for (const clip of clipsOnTrack(project, videoTrack.id)) {
    const transcript = project.transcripts[clip.assetId]
    if (!transcript) {
      timelineCursorFrames += clip.duration
      continue
    }

    const clipStartMs = framesToSeconds(clip.inPoint, fps) * 1000
    const clipEndMs = clipStartMs + framesToSeconds(clip.duration, fps) * 1000

    for (const group of groupWords(transcript.segments, transcript.words, style.wordsPerLine)) {
      // Lay the group out horizontally around the centre. Real text metrics live
      // in the browser, so this is an approximation the page refines — but the
      // ordering and timing it encodes are exact.
      const count = group.length
      group.forEach((word, index) => {
        if (word.endMs <= clipStartMs || word.startMs >= clipEndMs) return

        // Source ms -> timeline frames, through this clip's placement.
        const intoClipMs = word.startMs - clipStartMs
        const startFrame =
          timelineCursorFrames + secondsToFrames(intoClipMs / 1000, fps)
        const lastOfGroup = group[count - 1]
        const endFrame =
          timelineCursorFrames +
          secondsToFrames((lastOfGroup.endMs - clipStartMs) / 1000, fps)

        if (endFrame <= startFrame) return

        const offset = (index - (count - 1) / 2) * fontSize * 2.2
        const active = true

        layers.push({
          id: `w-${clip.id}-${word.index}`,
          kind: 'text',
          text: style.uppercase ? word.text.toUpperCase() : word.text,
          startFrame,
          endFrame,
          fontFamily: style.fontFamily,
          fontSize,
          color: active ? style.highlightColor : style.primaryColor,
          strokeColor: style.outlineColor,
          strokeWidth: style.outlineWidth * scale,
          anchorX: 0.5,
          anchorY,
          align: 'center',
          uppercase: style.uppercase,
          transform: {
            ...popIn(startFrame, POP_FRAMES),
            x: offset,
            y: 0
          }
        })
      })
    }

    timelineCursorFrames += clip.duration
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

import type { TextSpec } from '@shared/timeline'
import {
  animationFrames,
  piecesOf,
  textAnimationById,
  type TextAnimation
} from '@shared/render/textAnimation'
import { drawTextOnto } from '@shared/render/textPaint'
import { useCatalog } from './catalog'

export { drawTextOnto }

/**
 * Bake a text clip to a PNG, in the renderer.
 *
 * This used to happen in the main process: an SVG through sharp, which uses
 * librsvg, which resolves fonts through fontconfig. Measured rather than
 * assumed — `font-family="Anton"`, `font-family="sans-serif"` and a deliberately
 * bogus name all produced byte-identical output, at every setting of
 * FONTCONFIG_FILE and FONTCONFIG_PATH. That build of librsvg has one face and
 * ignores the family entirely, so choosing a font could never have worked.
 *
 * The renderer already loads the catalogue's fonts properly, as FontFace objects
 * built from bytes — it is how captions have always shown the right face. So the
 * type is drawn here, where the fonts are, and only the finished pixels go to
 * the main process to be written.
 *
 * Placement comes from the shared layout, so the baked PNG, the SVG and the
 * on-picture editing box cannot disagree.
 */
export async function renderTextPng(
  spec: TextSpec,
  width: number,
  height: number
): Promise<ArrayBuffer> {
  // A face that is not loaded yet falls back silently, which looks exactly like
  // the font picker doing nothing.
  await useCatalog.getState().ensureFont(spec.font)

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Could not get a canvas to draw text on')

  drawTextOnto(ctx, spec, width, height)

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  if (!blob) throw new Error('Could not encode the text image')
  return blob.arrayBuffer()
}

/**
 * The live picture of a text clip, for the preview.
 *
 * Cached per clip and redrawn only when the spec actually changes, so holding a
 * still frame costs nothing and typing costs one canvas draw. The baked PNG is
 * still written in the background for the export — this is the copy the editor
 * looks at, and it is always current, which the file on disk is not.
 */
const previews = new Map<string, { canvas: HTMLCanvasElement; signature: string }>()

export function textPreviewCanvas(
  clipId: string,
  spec: TextSpec,
  width: number,
  height: number,
  /**
   * Where the clip is, so an animation can be watched rather than imagined.
   *
   * Left out once the movement has finished, which is what keeps a held frame
   * free: the cache key stops changing and the canvas is never redrawn again.
   */
  clock?: { frame: number; fps: number }
): HTMLCanvasElement | null {
  if (width < 2 || height < 2) return null
  // The version counter names bytes on disk and says nothing about what should
  // be drawn, so it is deliberately left out of the signature.
  const { version: _version, ...visible } = spec

  const animation = textAnimationById(spec.animationId)
  const moving =
    animation && clock
      ? clock.frame < animationFrames(animation, clock.fps, longestRun(spec, animation))
      : false
  const signature = `${width}x${height}|${JSON.stringify(visible)}|${moving ? clock!.frame : 'settled'}`

  const existing = previews.get(clipId)
  if (existing && existing.signature === signature) return existing.canvas

  const canvas = existing?.canvas ?? document.createElement('canvas')
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width
    canvas.height = height
  }
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.clearRect(0, 0, width, height)
  /*
   * A canvas keeps its identity when it is redrawn, so anything caching by
   * object — the GPU grade pass in particular — cannot tell that the words
   * changed. This stamp is what moves when the picture does.
   */
  canvas.dataset.forgeRev = signature

  /*
   * A font still loading would draw in the fallback face and then be cached as
   * though it were right. Asking for it here — the call is synchronous once the
   * face is registered — and skipping the cache until it is ready means the
   * first frame may be a beat late but is never quietly wrong.
   */
  const ready = document.fonts.check(`16px "${spec.font}"`)
  drawTextOnto(ctx, spec, width, height, moving ? clock : undefined)
  if (!ready) {
    void useCatalog.getState().ensureFont(spec.font)
    previews.delete(clipId)
    return canvas
  }

  previews.set(clipId, { canvas, signature })
  return canvas
}

/**
 * The most pieces any one line of this text will be cut into.
 *
 * Used only to work out how long the movement lasts: the stagger is spread
 * across the pieces of a line, so the line with the most pieces is the one that
 * finishes last.
 */
function longestRun(spec: TextSpec, animation: TextAnimation): number {
  return spec.content
    .split('\n')
    .reduce((most, line) => Math.max(most, piecesOf(line, animation.scope).length), 1)
}

/** Drop a text clip's preview canvas — it was deleted. */
export function forgetTextPreview(clipId: string): void {
  previews.delete(clipId)
}

/** Draw the text and hand the finished file's path back. */
export async function bakeText(
  spec: TextSpec,
  clipId: string,
  width: number,
  height: number
): Promise<string> {
  return window.forge.writeTitleImage(clipId, await renderTextPng(spec, width, height))
}

/**
 * Bake an animated text clip as a numbered frame sequence.
 *
 * Only the frames that move are written. The export holds the last of them for
 * the rest of the clip with `tpad` — measured: five frames at 30fps held out to
 * 2.167s — so the cost is set by how long the movement lasts, not by how long
 * the caption is on screen.
 *
 * Returns the ffmpeg pattern, and how many frames it covers.
 */
export async function bakeTextSequence(
  spec: TextSpec,
  clipId: string,
  width: number,
  height: number,
  fps: number,
  maxFrames: number
): Promise<{ pattern: string; frames: number } | null> {
  const animation = textAnimationById(spec.animationId)
  if (!animation) return null

  await useCatalog.getState().ensureFont(spec.font)
  const frames = Math.min(
    Math.max(1, maxFrames),
    animationFrames(animation, fps, longestRun(spec, animation))
  )

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) return null

  let pattern = ''
  // Written one at a time on purpose: a hundred full-canvas PNGs held in memory
  // at once is a far worse problem than a hundred sequential writes.
  await window.forge.clearTitleFrames(clipId)
  for (let frame = 0; frame < frames; frame++) {
    ctx.clearRect(0, 0, width, height)
    drawTextOnto(ctx, spec, width, height, { frame, fps })
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
    if (!blob) throw new Error('Could not encode a text frame')
    pattern = await window.forge.writeTitleFrame(clipId, frame, await blob.arrayBuffer())
  }
  return { pattern, frames }
}

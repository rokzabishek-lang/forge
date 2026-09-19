import { clippingCount, paperFrames, type PaperSpec } from '@shared/render/paper'
import { canvasMeasure, drawPaperOnto } from '@shared/render/paperPaint'
import { useCatalog } from './catalog'

/**
 * Newspaper clippings, drawn in the renderer.
 *
 * Same arrangement as `textCanvas.ts`, for the same reason: the fonts are
 * loaded here, as FontFace objects built from bytes, and nowhere else. A
 * clipping asks for Playfair Display, Cinzel, Alfa Slab One, Abril Fatface,
 * Georgia and Courier New — all of which ship in `assets/fonts` — and drawing
 * it anywhere the catalogue is not would silently fall back to one face and
 * throw away most of what makes a run of pages read as different papers.
 */

/** Every face a look can reach for, so the run never falls back mid-bake. */
const FACES = [
  'Playfair Display',
  'Georgia',
  'Cinzel',
  'Alfa Slab One',
  'Abril Fatface',
  'Courier New'
]

/**
 * Load the whole set, not the one the current page needs.
 *
 * The face changes from clipping to clipping, so loading lazily would bake the
 * first pages in a fallback and the later ones correctly — a run that drifts
 * into focus, which reads as a bug in the effect rather than a loading order.
 */
async function ensureFaces(): Promise<void> {
  const catalog = useCatalog.getState()
  await Promise.all(FACES.map((f) => catalog.ensureFont(f).catch(() => undefined)))
}

const previews = new Map<string, { signature: string; canvas: HTMLCanvasElement }>()

/**
 * The live picture of a paper clip.
 *
 * Cached per clip and redrawn only when the signature changes. The signature
 * carries the frame, because unlike a caption this NEVER settles — the whole
 * effect is the cut from page to page — so a paper clip redraws once per frame
 * while the playhead is over it and not at all when it is not.
 */
export function paperPreviewCanvas(
  clipId: string,
  spec: PaperSpec,
  width: number,
  height: number,
  clock: { frame: number; fps: number }
): HTMLCanvasElement | null {
  if (width < 2 || height < 2) return null

  const total = paperFrames(spec)
  // Past the end of the run the last page holds, so the signature stops
  // changing and a long clip costs one draw rather than one per frame.
  const frame = Math.max(0, Math.min(total - 1, clock.frame))
  const signature = `${width}x${height}|${JSON.stringify(spec)}|${frame}`

  const existing = previews.get(clipId)
  if (existing && existing.signature === signature) return existing.canvas

  const canvas = existing?.canvas ?? document.createElement('canvas')
  if (canvas.width !== width) canvas.width = width
  if (canvas.height !== height) canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.clearRect(0, 0, width, height)
  drawPaperOnto(ctx, spec, width, height, { frame }, canvasMeasure(ctx))

  previews.set(clipId, { signature, canvas })
  // Fonts arrive asynchronously; the next draw picks them up. Kicked off after
  // the first draw so a clipping appears immediately in a fallback face rather
  // than not at all.
  void ensureFaces()
  return canvas
}

export function forgetPaperPreview(clipId: string): void {
  previews.delete(clipId)
}

/**
 * Bake the run as a numbered frame sequence.
 *
 * The same rails animated text uses: numbered PNGs with alpha, held by `tpad`
 * for the rest of the clip. Alpha is what makes this composite over footage
 * with no green screen — which is the workaround the web version needs and
 * this does not.
 */
export async function bakePaperSequence(
  spec: PaperSpec,
  clipId: string,
  width: number,
  height: number,
  maxFrames: number
): Promise<{ pattern: string; frames: number } | null> {
  await ensureFaces()

  const frames = Math.min(Math.max(1, maxFrames), paperFrames(spec))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  const measure = canvasMeasure(ctx)

  let pattern = ''
  // One at a time: twenty full-canvas PNGs held in memory at once is a worse
  // problem than twenty sequential writes.
  await window.forge.clearTitleFrames(clipId)
  for (let frame = 0; frame < frames; frame++) {
    ctx.clearRect(0, 0, width, height)
    drawPaperOnto(ctx, spec, width, height, { frame }, measure)
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
    if (!blob) throw new Error('Could not encode a clipping')
    pattern = await window.forge.writeTitleFrame(clipId, frame, await blob.arrayBuffer())
  }
  return { pattern, frames }
}

/** A sensible clip length for a run: exactly as long as the ripple lasts. */
export function paperDuration(spec: PaperSpec, fps: number): number {
  // A beat of the last page held after the ripple, so it does not vanish on
  // the frame the final word lands.
  return paperFrames(spec) + Math.round(fps * 0.4) * (clippingCount(spec) > 1 ? 1 : 0)
}

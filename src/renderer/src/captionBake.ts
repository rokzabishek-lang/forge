import type { Project } from '@shared/timeline'
import type { CaptionLayer } from '@shared/graphics/spec'
import { buildGraphicsSpec } from '@shared/graphics/fromTimeline'
import { concatList, planCaptionBake } from '@shared/captions/bake'
import { animationBounds, textAnimationById } from '@shared/render/textAnimation'
import { layoutText } from '@shared/render/textLayout'
import { drawTextOnto } from '@shared/render/textPaint'
import { useCatalog } from './catalog'

/**
 * Bake styled captions for the export.
 *
 * Captions that ASS cannot burn in used to be rendered by an offscreen Chromium
 * window, screenshotted once per frame, and composited in a second encode over a
 * throwaway copy of the whole video. Measured at 1080x1920, that cost roughly
 * five times what the render itself did — most of it waiting on a double
 * requestAnimationFrame and a `capturePage()` for every one of the frames.
 *
 * The captions are drawn on a canvas now, so none of that is necessary. They are
 * painted here, in the window where the fonts already live, as a handful of
 * distinct pictures — and ffmpeg replays them through the concat demuxer as one
 * more overlay in the ordinary single pass.
 *
 * Only the BAND the captions occupy is drawn. It is measured rather than
 * guessed: the settled line is painted once at full size and its ink is found,
 * then grown by exactly how far this animation throws a word and how much the
 * highlight enlarges it.
 */

export interface BakedCaptions {
  /** Path to the concat list ffmpeg reads. */
  listPath: string
  /** Where the band sits in the frame, and how tall it is. */
  y: number
  height: number
  /** For reporting: how much was drawn against how much was avoided. */
  pictures: number
  frames: number
}

/** Rows of a canvas that have any ink in them. */
function inkRows(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number
): { top: number; bottom: number } | null {
  const data = ctx.getImageData(0, 0, width, height).data
  let top = -1
  let bottom = -1
  for (let y = 0; y < height; y++) {
    let row = y * width * 4
    for (let x = 0; x < width; x++, row += 4) {
      if (data[row + 3] > 4) {
        if (top < 0) top = y
        bottom = y
        break
      }
    }
  }
  return top < 0 ? null : { top, bottom }
}

/**
 * The strip of the frame captions can touch.
 *
 * Measured from the settled line, because only a real paint knows how many rows
 * the text wrapped into, how far a glow spreads and how deep an extrusion goes.
 * The allowance added on top is not a guess either — `animationBounds` reports
 * the furthest this particular curve throws a piece, overshoot included.
 */
function measureBand(
  layers: CaptionLayer[],
  width: number,
  height: number
): { y: number; height: number } | null {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) return null

  let top = height
  let bottom = 0
  let found = false

  for (const layer of layers) {
    ctx.clearRect(0, 0, width, height)
    // Settled, with a word lit: the highlight is the tallest the line ever gets
    // at rest, and the animation allowance below covers the rest.
    drawTextOnto(ctx, { ...layer.spec, highlight: layer.highlight ? { word: 0, ...layer.highlight } : undefined }, width, height)
    const ink = inkRows(ctx, width, height)
    if (!ink) continue
    found = true

    const fontPx = layoutText(layer.spec, width, height).fontPx
    const animation = textAnimationById(layer.spec.animationId)
    const bounds = animation ? animationBounds(animation) : { dx: 0, dy: 0, scale: 1 }
    // Vertical travel, plus half the growth of an oversized arrival spreading
    // about each piece's own centre.
    const room = Math.ceil(fontPx * (bounds.dy + (bounds.scale - 1) * 0.6))

    top = Math.min(top, ink.top - room)
    bottom = Math.max(bottom, ink.bottom + room)
  }

  if (!found) return null

  // Snap outward to even numbers: an odd offset or height is invalid for the
  // subsampled chroma planes the encoder works in.
  const y = Math.max(0, Math.floor(Math.max(0, top) / 2) * 2)
  const end = Math.min(height, Math.ceil(Math.min(height, bottom + 1) / 2) * 2)
  const banded = Math.max(2, end - y)
  return { y, height: banded }
}

export async function bakeCaptions(
  project: Project,
  canvas: { width: number; height: number }
): Promise<BakedCaptions | null> {
  const spec = buildGraphicsSpec(project, canvas)
  if (!spec) return null

  const layers = spec.layers.filter((l): l is CaptionLayer => l.kind === 'caption')
  if (layers.length === 0) return null

  // A face that is not loaded yet would bake in the fallback and look exactly
  // like the font picker doing nothing — but permanently, in the export.
  const families = new Set(layers.map((l) => l.spec.font))
  for (const family of families) await useCatalog.getState().ensureFont(family)

  const fps = project.settings.fps
  const band = measureBand(layers, canvas.width, canvas.height)
  if (!band) return null

  const plan = planCaptionBake(layers, fps, spec.durationFrames)
  if (!plan) return null

  await window.forge.clearCaptionFrames()

  /*
   * Several pictures encode at once.
   *
   * Drawing one costs a fifth of a millisecond; turning it into a PNG costs
   * sixteen, and that work happens off the main thread — so awaiting each one in
   * turn leaves the encoder idle while the next is drawn and the drawing idle
   * while the last encodes. Measured on 60 pictures of an animated chrome
   * caption: 1000ms in a straight loop, 502ms two at a time, 264ms four at a
   * time, 250ms eight. Four takes nearly all of it for four canvases of memory.
   */
  const DEPTH = 4
  const pool = Array.from({ length: DEPTH }, () => {
    const c = document.createElement('canvas')
    c.width = canvas.width
    c.height = band.height
    return c
  })

  const pending: (Promise<string> | undefined)[] = new Array(DEPTH).fill(undefined)
  const files: string[] = new Array(plan.pictures.length)

  for (const [index, picture] of plan.pictures.entries()) {
    const slot = index % DEPTH
    // Reclaim the canvas only once whatever was drawn on it has been encoded.
    const inflight = pending[slot]
    if (inflight) files[index - DEPTH] = await inflight

    const strip = pool[slot]
    const ctx = strip.getContext('2d')
    if (!ctx) return null
    ctx.clearRect(0, 0, canvas.width, band.height)

    if (picture.layer >= 0) {
      const layer = layers[picture.layer]
      /*
       * Painted at FRAME coordinates, into a band-sized canvas.
       *
       * The spec places the words against the whole frame, so shifting the
       * context up by the band's offset and drawing full-size puts them exactly
       * where they belong and clips away everything the band does not cover. Any
       * other arrangement would mean a second placement rule that could disagree
       * with the preview's.
       */
      ctx.save()
      ctx.translate(0, -band.y)
      drawTextOnto(
        ctx,
        {
          ...layer.spec,
          highlight:
            layer.highlight && picture.word >= 0
              ? { word: picture.word, ...layer.highlight }
              : undefined
        },
        canvas.width,
        canvas.height,
        layer.spec.animationId ? { frame: picture.since, fps } : undefined
      )
      ctx.restore()
    }

    pending[slot] = (async () => {
      const blob = await new Promise<Blob | null>((resolve) => strip.toBlob(resolve, 'image/png'))
      if (!blob) throw new Error('Could not encode a caption frame')
      return window.forge.writeCaptionFrame(index, await blob.arrayBuffer())
    })()
  }

  // The last few pictures are still encoding when the loop ends.
  await Promise.all(
    pending.map(async (inflight, slot) => {
      if (!inflight) return
      // Which picture this slot last held: the highest index with this remainder.
      let last = -1
      for (let i = slot; i < plan.pictures.length; i += DEPTH) last = i
      files[last] = await inflight
    })
  )

  const listPath = await window.forge.writeCaptionList(
    concatList(plan, fps, (picture) => files[picture])
  )

  return {
    listPath,
    y: band.y,
    height: band.height,
    pictures: plan.pictures.length,
    frames: plan.totalFrames
  }
}

import { join } from 'node:path'
import { rm, mkdir, readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { app } from 'electron'
import { buildGraphicsSpec, needsFrameServer } from '@shared/graphics/fromTimeline'
import type { GraphicsFont, GraphicsSpec } from '@shared/graphics/spec'
import { fontFamilies, type FontMeta } from '@shared/assets/catalog'
import { loadCatalog, resolveAssetFile } from '../assets/scan'
import { FrameServer } from './frameServer'
import { compositeGraphics } from './compositor'
import type { ExecutionHandle } from '../queue'
import { startRender, type RenderOptions } from '../render/renderJob'

export { needsFrameServer }

/**
 * The faces a spec asks for, as bytes.
 *
 * The graphics window has no preload and no catalogue, so it cannot fetch a
 * font itself. Resolving them here — once, before the window opens — is also the
 * only point in the pipeline that knows both which families the captions use and
 * where the catalogue keeps them.
 *
 * A missing family is skipped rather than fatal: the page falls back to a system
 * face, which is wrong but legible. Losing the whole export over a font would
 * not be.
 */
async function fontsFor(spec: GraphicsSpec): Promise<GraphicsFont[]> {
  const families = new Set<string>()
  for (const layer of spec.layers) {
    if (layer.kind === 'caption') families.add(layer.spec.font)
    else if (layer.kind === 'text') families.add(layer.fontFamily)
  }
  if (families.size === 0) return []

  const catalog = await loadCatalog().catch(() => null)
  if (!catalog) return []

  const fonts: GraphicsFont[] = []
  for (const entry of fontFamilies(catalog)) {
    const family = (entry.meta as FontMeta).family
    if (!families.has(family)) continue
    try {
      const bytes = await readFile(resolveAssetFile(entry.file))
      const type = entry.file.toLowerCase().endsWith('.otf') ? 'font/otf' : 'font/ttf'
      fonts.push({ family, dataUrl: `data:${type};base64,${bytes.toString('base64')}` })
    } catch {
      // Skipped, not fatal — see above.
    }
  }
  return fonts
}

/**
 * Two-pass export: base picture, then graphics composited over it.
 *
 * The passes stay separate on purpose. The base render is the well-tested tier-1
 * path and must keep working untouched; if the frame server fails, the failure
 * is isolated to the second pass and the first pass's output is still a valid
 * video. That is the tier-1-as-fallback property from docs/PLAN.md §3b, made
 * literal.
 */
export function startTier2Render(
  options: RenderOptions,
  onProgress: (progress: number, speed: string | null) => void
): ExecutionHandle {
  const canvas = options.canvas ?? {
    width: options.project.settings.width,
    height: options.project.settings.height
  }

  let cancelled = false
  let cancelCurrent: (() => void) | null = null
  const server = new FrameServer()

  const promise = (async () => {
    const scratch = join(app.getPath('userData'), 'tmp')
    await mkdir(scratch, { recursive: true })
    const basePath = join(scratch, `base-${randomUUID()}.mp4`)

    const cleanup = async (): Promise<void> => {
      await server.close().catch(() => undefined)
      await rm(basePath, { force: true }).catch(() => undefined)
    }

    try {
      /* ---- pass 1: the picture, on the ordinary render path ---- */
      const base = startRender({ ...options, outputPath: basePath }, (p) =>
        // The base render is roughly half the work; report it as such rather
        // than showing 100% and then appearing to stall.
        onProgress(p * 0.45, null)
      )
      cancelCurrent = base.cancel
      await base.promise
      if (cancelled) throw new Error('Cancelled')

      /* ---- pass 2: graphics over it ---- */
      const built = buildGraphicsSpec(options.project, canvas)
      const spec = built ? { ...built, fonts: await fontsFor(built) } : null
      if (!spec) {
        // Nothing for tier 2 to draw after all — the base render is the answer.
        const { rename } = await import('node:fs/promises')
        await rename(basePath, options.outputPath)
        onProgress(1, null)
        return
      }

      await server.open(spec)
      if (cancelled) throw new Error('Cancelled')

      const composite = compositeGraphics({
        videoPath: basePath,
        outputPath: options.outputPath,
        width: canvas.width,
        height: canvas.height,
        fps: spec.fps,
        durationFrames: spec.durationFrames,
        produceFrame: (frame) => server.renderFrame(frame),
        onProgress: (p) => onProgress(0.45 + p * 0.55, null),
        crf: options.crf,
        preset: options.preset
      })
      cancelCurrent = composite.cancel
      await composite.promise
    } finally {
      await cleanup()
    }
  })()

  return {
    promise,
    cancel: () => {
      cancelled = true
      cancelCurrent?.()
      void server.close().catch(() => undefined)
    }
  }
}

export interface GraphicsSelfTest {
  ok: boolean
  /** Fraction of pixels with any transparency. 0 means alpha was lost. */
  transparentFraction: number
  /** Fraction of pixels that are fully opaque — the drawn graphic. */
  opaqueFraction: number
  width: number
  height: number
  bytes: number
  message: string
}

/**
 * Render one known frame offscreen and measure its alpha.
 *
 * The frame server's one unverifiable assumption is that `capturePage()` on a
 * transparent offscreen window returns BGRA with real alpha. If it does not,
 * every tier-2 composite is an opaque box over the video. This answers that in
 * one call rather than by rendering a whole export and looking at it.
 */
export async function runGraphicsSelfTest(): Promise<GraphicsSelfTest> {
  const width = 320
  const height = 240
  const server = new FrameServer()

  try {
    await server.open({
      width,
      height,
      fps: 30,
      durationFrames: 1,
      layers: [
        {
          id: 'probe',
          kind: 'text',
          text: 'FORGE',
          startFrame: 0,
          endFrame: 2,
          fontFamily: 'sans-serif',
          fontSize: 64,
          color: '#ffffff',
          anchorX: 0.5,
          anchorY: 0.5,
          align: 'center',
          transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }
        }
      ]
    })

    const buffer = await server.renderFrame(0)
    const expected = width * height * 4

    if (buffer.length !== expected) {
      return {
        ok: false,
        transparentFraction: 0,
        opaqueFraction: 0,
        width,
        height,
        bytes: buffer.length,
        message: `Captured ${buffer.length} bytes, expected ${expected} for ${width}x${height} BGRA`
      }
    }

    let transparent = 0
    let opaque = 0
    for (let i = 3; i < buffer.length; i += 4) {
      const alpha = buffer[i]
      if (alpha === 0) transparent++
      else if (alpha === 255) opaque++
    }

    const pixels = width * height
    const transparentFraction = transparent / pixels
    const opaqueFraction = opaque / pixels

    // Text on an otherwise empty frame: most of it must be transparent, and
    // some of it must be drawn. Either extreme means the capture is wrong.
    const ok = transparentFraction > 0.5 && opaqueFraction > 0.001

    return {
      ok,
      transparentFraction,
      opaqueFraction,
      width,
      height,
      bytes: buffer.length,
      message: ok
        ? 'Offscreen capture returns real alpha — tier 2 compositing will work'
        : transparentFraction <= 0.5
          ? 'Capture came back opaque: graphics would render as a solid box over the video'
          : 'Capture is transparent but nothing was drawn: the graphics page rendered nothing'
    }
  } catch (err) {
    return {
      ok: false,
      transparentFraction: 0,
      opaqueFraction: 0,
      width,
      height,
      bytes: 0,
      message: err instanceof Error ? err.message : String(err)
    }
  } finally {
    await server.close().catch(() => undefined)
  }
}

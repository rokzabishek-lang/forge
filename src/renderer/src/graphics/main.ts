import {
  layersAt,
  transformAt,
  type CaptionLayer,
  type GraphicsSpec,
  type GraphicsLayer,
  type TextLayer,
  type ImageLayer
} from '@shared/graphics/spec'
import { drawTextOnto } from '@shared/render/textPaint'

/**
 * The graphics layer page.
 *
 * Driven entirely from the main process: `setSpec` once, then `renderFrame(n)`
 * per frame. It never animates itself — no requestAnimationFrame, no timers, no
 * transitions. Every frame is drawn from scratch as a pure function of the frame
 * number, which is what makes export byte-identical to preview.
 */

let spec: GraphicsSpec | null = null
const stage = document.getElementById('stage') as HTMLDivElement
const nodes = new Map<string, HTMLElement>()

/*
 * Captions are painted, not laid out in the DOM.
 *
 * One canvas over the stage, drawn by `drawTextOnto` — the same function that
 * paints text clips and bakes their frames. Gradients, glows, extrusions and
 * per-word highlights come along for free, which is the whole reason captions
 * come through here at all; the previous approach built words out of `<p>`
 * elements and could express none of them.
 */
let captionCanvas: HTMLCanvasElement | null = null
let captionCtx: CanvasRenderingContext2D | null = null

function setSpec(next: GraphicsSpec): void {
  spec = next
  stage.style.width = `${next.width}px`
  stage.style.height = `${next.height}px`
  document.body.style.width = `${next.width}px`
  document.body.style.height = `${next.height}px`
  stage.replaceChildren()
  nodes.clear()

  captionCanvas = document.createElement('canvas')
  captionCanvas.width = next.width
  captionCanvas.height = next.height
  captionCanvas.style.position = 'absolute'
  captionCanvas.style.left = '0'
  captionCanvas.style.top = '0'
  stage.appendChild(captionCanvas)
  captionCtx = captionCanvas.getContext('2d')
}

/**
 * Which word of a caption line is being spoken at a frame.
 *
 * The spoken word holds until the next begins rather than going dark in the gap
 * between words — a highlight that blinks off mid-sentence reads as broken.
 */
function activeWord(layer: CaptionLayer, frame: number): number {
  let active = -1
  for (let i = 0; i < layer.wordFrames.length; i++) {
    if (frame >= layer.wordFrames[i]) active = i
  }
  return active
}

function drawCaptions(frame: number, visible: GraphicsLayer[]): void {
  const ctx = captionCtx
  if (!ctx || !spec) return
  ctx.clearRect(0, 0, spec.width, spec.height)

  for (const layer of visible) {
    if (layer.kind !== 'caption') continue
    const word = activeWord(layer, frame)
    drawTextOnto(
      ctx,
      {
        ...layer.spec,
        highlight:
          layer.highlight && word >= 0
            ? { word, color: layer.highlight.color, scale: layer.highlight.scale }
            : undefined
      },
      spec.width,
      spec.height,
      // Frames from the line's own first frame, so an animation plays as the
      // line arrives rather than once at the start of the video.
      { frame: frame - layer.startFrame, fps: spec.fps }
    )
  }
}

function createNode(layer: GraphicsLayer): HTMLElement {
  if (layer.kind === 'text') {
    const element = document.createElement('p')
    element.className = 'layer text-layer'
    const text = layer as TextLayer
    element.textContent = text.uppercase ? text.text.toUpperCase() : text.text
    element.style.fontFamily = `"${text.fontFamily}", sans-serif`
    element.style.fontSize = `${text.fontSize}px`
    element.style.color = text.color
    element.style.textAlign = text.align
    if (text.maxWidth) element.style.maxWidth = `${text.maxWidth}px`
    if (text.strokeWidth && text.strokeColor) {
      // paint-order keeps the stroke behind the fill; without it a thick stroke
      // eats into the glyph and thin weights become unreadable.
      element.style.webkitTextStrokeWidth = `${text.strokeWidth}px`
      element.style.webkitTextStrokeColor = text.strokeColor
      element.style.paintOrder = 'stroke fill'
    }
    return element
  }

  const image = layer as ImageLayer
  const element = document.createElement('img')
  element.className = 'layer'
  element.src = image.src
  element.style.width = `${image.width}px`
  element.style.height = `${image.height}px`
  return element
}

function draw(frame: number): void {
  if (!spec) return
  const visible = layersAt(spec, frame)
  const seen = new Set<string>()

  drawCaptions(frame, visible)

  for (const layer of visible) {
    if (layer.kind === 'caption') continue
    seen.add(layer.id)
    let node = nodes.get(layer.id)
    if (!node) {
      node = createNode(layer)
      nodes.set(layer.id, node)
      stage.appendChild(node)
    }

    const t = transformAt(layer.transform, frame)
    const originX = layer.anchorX * spec.width
    const originY = layer.anchorY * spec.height

    node.style.left = `${originX}px`
    node.style.top = `${originY}px`
    node.style.opacity = String(t.opacity)
    // translate(-50%,-50%) centres the element on its anchor before the layer's
    // own offsets apply, so anchorX/Y mean the same thing at any size.
    node.style.transform =
      `translate(-50%, -50%) translate(${t.x}px, ${t.y}px) ` +
      `rotate(${t.rotation}deg) scale(${t.scale})`
  }

  for (const [id, node] of nodes) {
    if (!seen.has(id)) {
      node.remove()
      nodes.delete(id)
    }
  }
}

/**
 * Resolve once the frame is actually painted.
 *
 * A double rAF is the reliable signal that style and layout have been committed
 * — capturing earlier yields the previous frame, which shows up as a one-frame
 * offset that is very hard to spot and very obvious once animated.
 */
function renderFrame(frame: number): Promise<number> {
  draw(frame)
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(frame)))
  })
}

/**
 * Register the faces the spec carries, then wait for them.
 *
 * This window has no preload and no store, so it cannot ask the app for a font
 * the way the editor does. The bytes arrive inside the spec as a data URL —
 * which also means no fetch and no protocol handler to satisfy. A face that
 * fails to load falls back rather than failing the render: a caption in the
 * wrong face is recoverable, a black export is not.
 */
async function waitForFonts(): Promise<void> {
  for (const font of spec?.fonts ?? []) {
    try {
      const face = new FontFace(font.family, `url(${font.dataUrl})`)
      await face.load()
      document.fonts.add(face)
    } catch (err) {
      console.warn('Graphics font failed to load', font.family, err)
    }
  }
  try {
    await document.fonts.ready
  } catch {
    // Font loading is best-effort; a fallback face is better than no render.
  }
}

declare global {
  interface Window {
    forgeGraphics: {
      setSpec: (spec: GraphicsSpec) => void
      renderFrame: (frame: number) => Promise<number>
      waitForFonts: () => Promise<void>
      ready: boolean
    }
  }
}

window.forgeGraphics = { setSpec, renderFrame, waitForFonts, ready: true }

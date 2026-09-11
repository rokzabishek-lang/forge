import {
  layersAt,
  transformAt,
  type GraphicsSpec,
  type GraphicsLayer,
  type TextLayer,
  type ImageLayer
} from '@shared/graphics/spec'

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

function setSpec(next: GraphicsSpec): void {
  spec = next
  stage.style.width = `${next.width}px`
  stage.style.height = `${next.height}px`
  document.body.style.width = `${next.width}px`
  document.body.style.height = `${next.height}px`
  stage.replaceChildren()
  nodes.clear()
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

  for (const layer of visible) {
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

async function waitForFonts(): Promise<void> {
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

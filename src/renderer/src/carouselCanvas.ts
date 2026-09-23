import { mediaUrl } from '@shared/mediaUrl'
import {
  carouselCameraZ,
  carouselCards,
  carouselSettings,
  carouselTilt,
  type CarouselClipSpec
} from '@shared/render/carousel'
import { beginBake, endBake, isSuperseded } from '@shared/bakeGuard'

/**
 * The card ring, drawn with three.js.
 *
 * `carousel.ts` decides where every card goes and imports no three.js at all;
 * this turns that into meshes and pixels. Same division as `paper.ts` and
 * `paperPaint.ts`, and the same payoff — the geometry is testable without a
 * GPU, and this file contains nothing that needs asserting beyond "it drew".
 *
 * Everything lands on the rails paper already proved: render to a canvas, bake
 * numbered PNGs with alpha, hold the last with `tpad`. Nothing in the export
 * knows three.js exists.
 */

export type { CarouselClipSpec }

/**
 * three.js is loaded the first time a ring is drawn, and never otherwise.
 *
 * 129 KB gzipped is modest but not nothing, and the overwhelming majority of
 * projects will never contain a card ring. A static import would put it in the
 * main bundle for all of them.
 */
type Three = typeof import('three')
let threePromise: Promise<Three> | null = null
function loadThree(): Promise<Three> {
  if (!threePromise) threePromise = import('three')
  return threePromise
}

/**
 * ONE renderer, reused for every ring and every frame.
 *
 * A browser allows a small number of live WebGL contexts — around sixteen —
 * and silently drops the oldest when you pass it. A renderer per clip, or per
 * frame of a bake, exhausts that in seconds and the symptom is earlier rings
 * going black for no visible reason. So: one context, resized as needed.
 */
let shared: { renderer: import('three').WebGLRenderer; canvas: HTMLCanvasElement } | null = null

async function renderer(
  width: number,
  height: number
): Promise<{ three: Three; renderer: import('three').WebGLRenderer; canvas: HTMLCanvasElement }> {
  const three = await loadThree()
  if (!shared) {
    const canvas = document.createElement('canvas')
    const r = new three.WebGLRenderer({ canvas, alpha: true, antialias: true })
    r.setClearColor(0x000000, 0)
    shared = { renderer: r, canvas }
  }
  if (shared.canvas.width !== width || shared.canvas.height !== height) {
    shared.renderer.setSize(width, height, false)
  }
  return { three, renderer: shared.renderer, canvas: shared.canvas }
}

/**
 * Photographs as textures, downscaled first.
 *
 * A 4000x3000 photograph as an RGBA texture is ~48 MB on the GPU, and twenty
 * of them is nearly a gigabyte — which is how a card ring takes a laptop down.
 * A card occupies a few hundred pixels on screen, so anything past `MAX_EDGE`
 * is memory spent on detail that cannot be seen.
 */
const MAX_EDGE = 640
const textures = new Map<string, HTMLCanvasElement>()

async function textureFor(path: string): Promise<HTMLCanvasElement | null> {
  const existing = textures.get(path)
  if (existing) return existing

  const image = new Image()
  image.crossOrigin = 'anonymous'
  const loaded = await new Promise<boolean>((resolve) => {
    image.onload = () => resolve(true)
    image.onerror = () => resolve(false)
    image.src = mediaUrl(path)
  })
  if (!loaded || image.naturalWidth === 0) return null

  const scale = Math.min(1, MAX_EDGE / Math.max(image.naturalWidth, image.naturalHeight))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
  textures.set(path, canvas)
  return canvas
}

/** Build the scene once and hand back a function that draws it at a time. */
async function scene(
  three: Three,
  gl: import('three').WebGLRenderer,
  spec: CarouselClipSpec,
  paths: string[],
  width: number,
  height: number
): Promise<((seconds: number) => void) | null> {
  const settings = carouselSettings(spec)
  const images = await Promise.all(paths.map((p) => textureFor(p)))
  const usable = images.filter((i): i is HTMLCanvasElement => i !== null)
  if (usable.length === 0) return null

  const root = new three.Scene()
  const group = new three.Group()
  root.add(group)

  const camera = new three.PerspectiveCamera(45, width / height, 0.1, 200)
  camera.position.set(0, 0, carouselCameraZ(settings, 45, width / height))
  camera.lookAt(0, 0, 0)

  const meshes: import('three').Mesh[] = []
  for (let i = 0; i < settings.cards; i++) {
    // Fewer photographs than cards is normal and must not leave holes — the
    // ring repeats them, the way a carousel of six shots on twelve cards does.
    const source = usable[i % usable.length]
    const texture = new three.CanvasTexture(source)
    texture.colorSpace = three.SRGBColorSpace
    const mesh = new three.Mesh(
      new three.PlaneGeometry(1, 1),
      new three.MeshBasicMaterial({
        map: texture,
        side: three.DoubleSide,
        transparent: true,
        depthWrite: false
      })
    )
    group.add(mesh)
    meshes.push(mesh)
  }

  const tilt = carouselTilt(settings)
  group.rotation.set(tilt.x, tilt.y, tilt.z)

  return (seconds: number): void => {
    const cards = carouselCards(settings, seconds)
    cards.forEach((card, drawOrder) => {
      const mesh = meshes[card.index]
      if (!mesh) return
      mesh.position.set(card.position.x, card.position.y, card.position.z)
      mesh.rotation.set(card.rotation.x, card.rotation.y, card.rotation.z)
      mesh.scale.set(card.width, card.height, 1)
      /*
       * Faded by `facing` rather than culled, and ordered by the geometry's
       * own sort rather than by three.js's.
       *
       * `depthWrite` is off because the cards are transparent, so painter's
       * order is what decides which is in front — and the sort in
       * `carouselCards` is the one that has been reasoned about and tested.
       * Letting three.js sort them would put a second, different opinion in
       * the pipeline.
       */
      mesh.renderOrder = drawOrder
      const material = mesh.material as import('three').MeshBasicMaterial
      material.opacity = 0.25 + card.facing * 0.75
    })
    // The whole point, and it was missing: positioning meshes draws nothing.
    gl.render(root, camera)
  }
}

const previews = new Map<
  string,
  { signature: string; canvas: HTMLCanvasElement; draw: ((s: number) => void) | null }
>()

/**
 * The live picture of a ring, copied onto a 2D canvas.
 *
 * Copied rather than handed over, because there is only one WebGL context and
 * the preview compositor may want several rings on screen at once. A 2D copy
 * per clip costs a blit; a context per clip costs the context limit.
 *
 * Returns null until three.js and the photographs have loaded, and asks for a
 * repaint when they have — the ring appears a frame later rather than never.
 */
export function carouselPreviewCanvas(
  clipId: string,
  spec: CarouselClipSpec,
  paths: string[],
  width: number,
  height: number,
  clock: { frame: number; fps: number },
  onReady?: () => void
): HTMLCanvasElement | null {
  if (width < 2 || height < 2) return null
  const seconds = clock.fps > 0 ? clock.frame / clock.fps : 0
  const signature = `${width}x${height}|${JSON.stringify(spec)}|${paths.join('|')}`

  const existing = previews.get(clipId)
  if (!existing || existing.signature !== signature) {
    const canvas = existing?.canvas ?? document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const entry = { signature, canvas, draw: null as ((s: number) => void) | null }
    previews.set(clipId, entry)
    void (async () => {
      const { three, renderer: gl } = await renderer(width, height)
      const draw = await scene(three, gl, spec, paths, width, height)
      if (previews.get(clipId) !== entry) return
      entry.draw = draw
      onReady?.()
    })()
    return existing?.draw ? canvas : null
  }

  if (!existing.draw) return null
  void paint(existing.canvas, existing.draw, seconds, width, height)
  return existing.canvas
}

/** How many ring frames have been painted — each one's stamp. */
let paints = 0

/** Draw one frame and copy it onto the clip's own 2D canvas. */
async function paint(
  target: HTMLCanvasElement,
  draw: (s: number) => void,
  seconds: number,
  width: number,
  height: number
): Promise<void> {
  const { canvas: gl } = await renderer(width, height)
  draw(seconds)
  const ctx = target.getContext('2d')
  if (!ctx) return
  ctx.clearRect(0, 0, width, height)
  ctx.drawImage(gl, 0, 0, width, height)
  // Every paint is a new picture — a new angle, or a ring whose settings just
  // changed — so each says so, and a look over it never freezes on one frame
  // (grade.ts canvasContentKey).
  target.dataset.forgeRev = String(++paints)
}

export function forgetCarouselPreview(clipId: string): void {
  previews.delete(clipId)
}

/**
 * Bake the ring as a numbered frame sequence.
 *
 * Guarded exactly as the paper bake is, and for the reason that bug taught:
 * two bakes of one clip overlapping means the older one writes into the
 * directory the newer one just cleared.
 */
export async function bakeCarouselSequence(
  spec: CarouselClipSpec,
  clipId: string,
  paths: string[],
  width: number,
  height: number,
  frames: number,
  fps: number
): Promise<{ pattern: string; frames: number } | null> {
  const { three, renderer: r, canvas: gl } = await renderer(width, height)
  const draw = await scene(three, r, spec, paths, width, height)
  if (!draw) return null

  const out = document.createElement('canvas')
  out.width = width
  out.height = height
  const ctx = out.getContext('2d')
  if (!ctx) return null

  let pattern = ''
  const token = beginBake(clipId)
  try {
    await window.forge.clearTitleFrames(clipId)
    if (isSuperseded(clipId, token)) return null
    for (let frame = 0; frame < Math.max(1, frames); frame++) {
      draw(fps > 0 ? frame / fps : 0)
      ctx.clearRect(0, 0, width, height)
      ctx.drawImage(gl, 0, 0, width, height)
      const blob = await new Promise<Blob | null>((resolve) => out.toBlob(resolve, 'image/png'))
      if (!blob) throw new Error('Could not encode a card')
      const buffer = await blob.arrayBuffer()
      if (isSuperseded(clipId, token)) return null
      pattern = await window.forge.writeTitleFrame(clipId, frame, buffer)
    }
    return { pattern, frames: Math.max(1, frames) }
  } finally {
    endBake(clipId)
  }
}

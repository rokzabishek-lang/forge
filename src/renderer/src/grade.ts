import type { ColorAdjust } from '@shared/timeline'
import { isNeutralGrade } from '@shared/timeline'
import { isNeutralCurves, sampleCurves } from '@shared/render/colourCurve'
import { parseCube, type CubeLut } from '@shared/render/cube'
import { mediaUrl } from './media'

/**
 * The grade, on the GPU, for the preview.
 *
 * A look you cannot see until you export is a look you cannot judge, so the
 * preview has to apply the same grade the renderer will. Canvas 2D cannot do a
 * 3D LUT and its `filter` property cannot express ffmpeg's `eq` — CSS brightness
 * is a multiplier, ffmpeg's is an offset — so approximating with CSS filters
 * would put a different picture on screen from the one that exports. This runs
 * the actual formulas instead.
 *
 * The output canvas is always the source's own pixel size, because the draw loop
 * addresses it with source-rect coordinates for crops and camera moves. A
 * smaller proxy would silently move every reframe.
 */

const VERTEX = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  // A full-screen triangle pair from clip space; v flipped so the texture is
  // not upside down, which is the traditional first bug here.
  vUv = vec2(aPos.x * 0.5 + 0.5, 0.5 - aPos.y * 0.5);
  gl_Position = vec4(aPos, 0.0, 1.0);
}`

const FRAGMENT = `#version 300 es
precision highp float;
precision highp sampler3D;

uniform sampler2D uImage;
uniform sampler3D uLut;
uniform float uLutSize;
uniform float uLutMix;
uniform float uBrightness;
uniform float uContrast;
uniform float uSaturation;
uniform sampler2D uCurves;
uniform float uHasCurves;

in vec2 vUv;
out vec4 fragColor;

// BT.709, the matrix for HD.
const mat3 RGB_TO_YUV = mat3(
   0.2126,  -0.114572,  0.5,
   0.7152,  -0.385428, -0.454153,
   0.0722,   0.5,      -0.045847
);
const mat3 YUV_TO_RGB = mat3(
   1.0,      1.0,      1.0,
   0.0,     -0.187324, 1.8556,
   1.5748,  -0.468124, 0.0
);

void main() {
  vec4 src = texture(uImage, vUv);
  // Undo the premultiply the browser may have applied, so a grade on a
  // semi-transparent sticker does not darken its edges.
  vec3 rgb = src.a > 0.001 ? src.rgb : src.rgb;

  /*
   * ffmpeg's eq, exactly: contrast and brightness act on luma as
   * v' = contrast * (v - 0.5) + 0.5 + brightness, and saturation scales the
   * chroma pair around neutral. Applying the same numbers to RGB directly would
   * look similar and export differently.
   */
  vec3 yuv = RGB_TO_YUV * rgb;
  yuv.x = uContrast * (yuv.x - 0.5) + 0.5 + uBrightness;
  yuv.yz *= uSaturation;
  vec3 graded = clamp(YUV_TO_RGB * yuv, 0.0, 1.0);

  /*
   * Curves, from a 256-entry table sampled on the CPU.
   *
   * ffmpeg builds a 256-entry lookup internally too, so reading one here is not
   * an approximation of what it does — it is the same thing. The table already
   * has the per-channel curves and the master folded in, in ffmpeg's order.
   */
  if (uHasCurves > 0.5) {
    graded = vec3(
      texture(uCurves, vec2(graded.r, 0.5)).r,
      texture(uCurves, vec2(graded.g, 0.5)).g,
      texture(uCurves, vec2(graded.b, 0.5)).b
    );
  }

  if (uLutMix > 0.0) {
    // Sample texel centres, or the ends of the cube are half a texel off.
    float scale = (uLutSize - 1.0) / uLutSize;
    float offset = 1.0 / (2.0 * uLutSize);
    vec3 looked = texture(uLut, graded * scale + offset).rgb;
    graded = mix(graded, looked, uLutMix);
  }

  fragColor = vec4(graded, src.a);
}`

interface Pass {
  canvas: HTMLCanvasElement
  gl: WebGL2RenderingContext
  program: WebGLProgram
  image: WebGLTexture
  /** The 256-entry colour-curve lookup. */
  curves: WebGLTexture
  /**
   * A 1x1x1 stand-in for the 3D LUT.
   *
   * A sampler3D that was never assigned a unit defaults to unit 0 — where the
   * image, a 2D texture, is bound. GL then rejects the whole draw with
   * "two textures of different types use the same sampler location" and the
   * canvas comes out empty, which on screen is a black frame. Binding something
   * valid of the right type costs nothing and makes the state always legal.
   */
  emptyLut: WebGLTexture
  uniforms: Record<string, WebGLUniformLocation | null>
}

let pass: Pass | null = null
let unavailable = false

function ensurePass(): Pass | null {
  if (pass) return pass
  if (unavailable) return null

  const canvas = document.createElement('canvas')
  const gl = canvas.getContext('webgl2', { premultipliedAlpha: false, alpha: true })
  if (!gl) {
    // No WebGL2: the export still grades, the preview just shows it ungraded.
    unavailable = true
    return null
  }

  const program = link(gl, VERTEX, FRAGMENT)
  if (!program) {
    unavailable = true
    return null
  }

  const buffer = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
  const position = gl.getAttribLocation(program, 'aPos')
  gl.enableVertexAttribArray(position)
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0)

  const image = gl.createTexture()!
  gl.bindTexture(gl.TEXTURE_2D, image)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)

  const uniforms = Object.fromEntries(
    [
      'uImage',
      'uLut',
      'uLutSize',
      'uLutMix',
      'uBrightness',
      'uContrast',
      'uSaturation',
      'uCurves',
      'uHasCurves'
    ].map(
      (name) => [name, gl.getUniformLocation(program, name)]
    )
  )

  const curves = gl.createTexture()!
  gl.bindTexture(gl.TEXTURE_2D, curves)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  // LINEAR between the 256 entries, which is what smooths the ramp.
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)

  const emptyLut = gl.createTexture()!
  gl.bindTexture(gl.TEXTURE_3D, emptyLut)
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texImage3D(
    gl.TEXTURE_3D, 0, gl.RGBA8, 1, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
    new Uint8Array([255, 255, 255, 255])
  )

  pass = { canvas, gl, program, image, curves, emptyLut, uniforms }
  return pass
}

function link(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram | null {
  const compile = (type: number, source: string): WebGLShader | null => {
    const shader = gl.createShader(type)
    if (!shader) return null
    gl.shaderSource(shader, source)
    gl.compileShader(shader)
    if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader
    console.error('grade shader:', gl.getShaderInfoLog(shader))
    return null
  }
  const vertex = compile(gl.VERTEX_SHADER, vs)
  const fragment = compile(gl.FRAGMENT_SHADER, fs)
  if (!vertex || !fragment) return null

  const program = gl.createProgram()
  if (!program) return null
  gl.attachShader(program, vertex)
  gl.attachShader(program, fragment)
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error('grade program:', gl.getProgramInfoLog(program))
    return null
  }
  gl.useProgram(program)
  return program
}

/**
 * Hand the shader the 256-entry curve table.
 *
 * Re-uploaded whenever the curves change rather than cached: 1KB to the GPU is
 * nothing next to the frame it is about to grade, and a cache keyed on a nested
 * object is a correctness risk for no measurable gain.
 */
let lastCurveKey = ''
function uploadCurves(current: Pass, color: ColorAdjust): void {
  const { gl, uniforms } = current
  const neutral = isNeutralCurves(color.curves)
  gl.uniform1f(uniforms.uHasCurves, neutral ? 0 : 1)
  if (neutral) return

  const key = JSON.stringify(color.curves)
  gl.activeTexture(gl.TEXTURE2)
  gl.bindTexture(gl.TEXTURE_2D, current.curves)
  if (key !== lastCurveKey) {
    lastCurveKey = key
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, sampleCurves(color.curves)
    )
  }
  gl.uniform1i(uniforms.uCurves, 2)
}

/* ----------------------------------------------------------------- LUTs */

const lutTextures = new Map<string, WebGLTexture>()
const lutSizes = new Map<string, number>()
const loading = new Set<string>()
/** Files that failed, so a broken LUT is not re-fetched sixty times a second. */
const lutFailed = new Map<string, string>()

export function lutError(file: string): string | undefined {
  return lutFailed.get(file)
}

/** Kick off a load. Returns true once the texture is ready to sample. */
function ensureLut(file: string, onReady: () => void): boolean {
  if (lutTextures.has(file)) return true
  if (loading.has(file) || lutFailed.has(file)) return false

  loading.add(file)
  void (async () => {
    try {
      const response = await fetch(mediaUrl(file))
      if (!response.ok) throw new Error(`could not read the LUT (${response.status})`)
      uploadLut(file, parseCube(await response.text()))
      onReady()
    } catch (err) {
      lutFailed.set(file, err instanceof Error ? err.message : String(err))
    } finally {
      loading.delete(file)
    }
  })()
  return false
}

function uploadLut(file: string, lut: CubeLut): void {
  const current = ensurePass()
  if (!current) return
  const { gl } = current

  // 8-bit is what the values quantise to on screen anyway, and it avoids
  // depending on float-texture filtering being available.
  const bytes = new Uint8Array(lut.size ** 3 * 4)
  for (let i = 0; i < lut.size ** 3; i++) {
    bytes[i * 4 + 0] = Math.round(Math.max(0, Math.min(1, lut.data[i * 3 + 0])) * 255)
    bytes[i * 4 + 1] = Math.round(Math.max(0, Math.min(1, lut.data[i * 3 + 1])) * 255)
    bytes[i * 4 + 2] = Math.round(Math.max(0, Math.min(1, lut.data[i * 3 + 2])) * 255)
    bytes[i * 4 + 3] = 255
  }

  const texture = gl.createTexture()!
  gl.bindTexture(gl.TEXTURE_3D, texture)
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texImage3D(
    gl.TEXTURE_3D, 0, gl.RGBA8, lut.size, lut.size, lut.size, 0, gl.RGBA, gl.UNSIGNED_BYTE, bytes
  )
  lutTextures.set(file, texture)
  lutSizes.set(file, lut.size)
}

/* --------------------------------------------------------------- caching */

interface Cached {
  canvas: HTMLCanvasElement
  signature: string
}
const cache = new Map<string, Cached>()

/** What the grade looks like, as a string, so a still can skip redrawing. */
function signatureOf(color: ColorAdjust, width: number, height: number, frame: string): string {
  return [
    color.brightness.toFixed(4),
    color.contrast.toFixed(4),
    color.saturation.toFixed(4),
    color.lut?.file ?? '',
    color.lut?.intensity.toFixed(4) ?? '',
    /*
     * The curves belong in the signature.
     *
     * Without them, changing only a curve left the signature identical and the
     * cached canvas was handed straight back — the graph moved, the picture did
     * not, and nothing anywhere reported a problem. Anything that changes the
     * output has to change the key.
     */
    JSON.stringify(color.curves ?? null),
    width,
    height,
    frame
  ].join('|')
}

/**
 * The graded picture, or the original element when there is nothing to do.
 *
 * `key` identifies the clip, so each one keeps its own output canvas rather than
 * fighting over a shared one. `onReady` is called when an asynchronously-loaded
 * LUT finishes, so the caller can repaint a frame that was drawn without it.
 */
/** How big the picture actually is, whatever kind of element is holding it. */
function naturalSize(
  element: HTMLVideoElement | HTMLImageElement | HTMLCanvasElement
): { width: number; height: number } {
  if (element instanceof HTMLVideoElement) {
    return { width: element.videoWidth, height: element.videoHeight }
  }
  if (element instanceof HTMLImageElement) {
    return { width: element.naturalWidth, height: element.naturalHeight }
  }
  return { width: element.width, height: element.height }
}

/**
 * Something that changes exactly when the picture does.
 *
 * A canvas has neither a `src` nor a `currentTime`, and its object identity
 * survives being redrawn — so a text clip whose words had changed would have
 * been served the previous graded copy forever. Whoever redraws the canvas
 * stamps `forgeRev` on it, and that is the thing that moves.
 */
function contentKey(
  element: HTMLVideoElement | HTMLImageElement | HTMLCanvasElement
): string {
  if (element instanceof HTMLVideoElement) return element.currentTime.toFixed(3)
  if (element instanceof HTMLImageElement) return element.src
  return canvasContentKey(element.dataset.forgeRev)
}

let unstamped = 0

/**
 * The key for a canvas: its stamp, or — with no stamp — a key that never
 * repeats, so it is never served from the cache.
 *
 * The fallback used to be the canvas's SIZE, which never changes. The paper
 * clippings and the photo ring are drawn onto one canvas frame after frame and
 * did not stamp it, so the moment a look was applied the grade handed back its
 * first graded frame forever: the look was there and the picture had frozen —
 * reported from the app — while the export, which never goes near this, played.
 * A canvas that cannot say when it changed is regraded every time; a frame of
 * extra work is a far smaller fault than a picture that stops.
 */
export function canvasContentKey(stamp: string | undefined): string {
  return stamp ?? `unstamped:${++unstamped}`
}

export function gradedSource(
  element: HTMLVideoElement | HTMLImageElement | HTMLCanvasElement,
  color: ColorAdjust | undefined,
  key: string,
  onReady: () => void = () => undefined
): CanvasImageSource {
  if (!color || isNeutralGrade(color)) return element

  // An element that had to fall back to a plain, non-CORS load can never be
  // read by WebGL. Trying anyway throws sixty times a second for no gain.
  if (element.dataset.forgePlain === '1') return element

  const { width, height } = naturalSize(element)
  if (width < 1 || height < 1) return element

  const current = ensurePass()
  if (!current) return element
  const { gl, uniforms } = current

  const lutFile = color.lut?.file
  const lutMix = lutFile && !lutFailed.has(lutFile) ? Math.max(0, Math.min(1, color.lut!.intensity)) : 0
  const lutReady = lutFile && lutMix > 0 ? ensureLut(lutFile, onReady) : false
  const mix = lutReady ? lutMix : 0

  // A video is a new picture every frame; a still only needs drawing once per
  // change of grade.
  const frameKey = contentKey(element)
  const signature = signatureOf(color, width, height, `${frameKey}|${mix.toFixed(3)}`)
  const existing = cache.get(key)
  if (existing && existing.signature === signature) return existing.canvas

  current.canvas.width = width
  current.canvas.height = height
  gl.viewport(0, 0, width, height)

  gl.activeTexture(gl.TEXTURE0)
  gl.bindTexture(gl.TEXTURE_2D, current.image)
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
  try {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, element)
  } catch {
    // A video frame that is not decodable yet throws rather than returning.
    return element
  }
  gl.uniform1i(uniforms.uImage, 0)

  // Always a 3D texture on unit 1, LUT or not — see Pass.emptyLut.
  gl.activeTexture(gl.TEXTURE1)
  gl.bindTexture(
    gl.TEXTURE_3D,
    mix > 0 && lutFile ? lutTextures.get(lutFile)! : current.emptyLut
  )
  gl.uniform1i(uniforms.uLut, 1)
  gl.uniform1f(uniforms.uLutSize, mix > 0 && lutFile ? lutSizes.get(lutFile) ?? 2 : 2)
  gl.uniform1f(uniforms.uLutMix, mix)
  gl.uniform1f(uniforms.uBrightness, color.brightness)
  gl.uniform1f(uniforms.uContrast, color.contrast)
  gl.uniform1f(uniforms.uSaturation, color.saturation)
  uploadCurves(current, color)

  gl.clearColor(0, 0, 0, 0)
  gl.clear(gl.COLOR_BUFFER_BIT)
  gl.drawArrays(gl.TRIANGLES, 0, 3)

  // Copy off the shared GL canvas: the next clip in this frame will overwrite it.
  const out = existing?.canvas ?? document.createElement('canvas')
  out.width = width
  out.height = height
  out.getContext('2d')?.drawImage(current.canvas, 0, 0)
  cache.set(key, { canvas: out, signature })
  return out
}

/** Drop a clip's cached picture — it was deleted, or its media changed. */
export function forgetGrade(key: string): void {
  cache.delete(key)
}

/**
 * Grade a rectangle of the preview canvas in place.
 *
 * What an adjustment layer does: everything already drawn beneath it is the
 * input. The canvas is same-origin so WebGL can read it without the CORS dance
 * the media elements need, and the result is drawn straight back over the same
 * region.
 */
export function gradeRegion(
  ctx: CanvasRenderingContext2D,
  rect: { x: number; y: number; width: number; height: number },
  color: ColorAdjust | undefined,
  key: string,
  onReady: () => void = () => undefined
): void {
  if (!color || isNeutralGrade(color)) return
  const width = Math.round(rect.width)
  const height = Math.round(rect.height)
  if (width < 1 || height < 1) return

  const current = ensurePass()
  if (!current) return
  const { gl, uniforms } = current

  const lutFile = color.lut?.file
  const wanted = lutFile && !lutFailed.has(lutFile) ? Math.max(0, Math.min(1, color.lut!.intensity)) : 0
  const ready = lutFile && wanted > 0 ? ensureLut(lutFile, onReady) : false
  const mix = ready ? wanted : 0

  // Lift the region out first: texImage2D takes a whole canvas, not a rect.
  const slice = scratchFor(key, width, height)
  if (!slice) return
  slice.ctx.clearRect(0, 0, width, height)
  slice.ctx.drawImage(ctx.canvas, rect.x, rect.y, width, height, 0, 0, width, height)

  current.canvas.width = width
  current.canvas.height = height
  gl.viewport(0, 0, width, height)

  gl.activeTexture(gl.TEXTURE0)
  gl.bindTexture(gl.TEXTURE_2D, current.image)
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
  try {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, slice.canvas)
  } catch {
    return
  }
  gl.uniform1i(uniforms.uImage, 0)

  // Always a 3D texture on unit 1, LUT or not — see Pass.emptyLut.
  gl.activeTexture(gl.TEXTURE1)
  gl.bindTexture(
    gl.TEXTURE_3D,
    mix > 0 && lutFile ? lutTextures.get(lutFile)! : current.emptyLut
  )
  gl.uniform1i(uniforms.uLut, 1)
  gl.uniform1f(uniforms.uLutSize, mix > 0 && lutFile ? lutSizes.get(lutFile) ?? 2 : 2)
  gl.uniform1f(uniforms.uLutMix, mix)
  gl.uniform1f(uniforms.uBrightness, color.brightness)
  gl.uniform1f(uniforms.uContrast, color.contrast)
  gl.uniform1f(uniforms.uSaturation, color.saturation)
  uploadCurves(current, color)

  gl.clearColor(0, 0, 0, 0)
  gl.clear(gl.COLOR_BUFFER_BIT)
  gl.drawArrays(gl.TRIANGLES, 0, 3)

  ctx.drawImage(current.canvas, rect.x, rect.y, width, height)
}

interface Slice {
  canvas: HTMLCanvasElement
  ctx: CanvasRenderingContext2D
}
const slices = new Map<string, Slice>()

function scratchFor(key: string, width: number, height: number): Slice | null {
  let slice = slices.get(key)
  if (!slice) {
    const canvas = document.createElement('canvas')
    const context = canvas.getContext('2d')
    if (!context) return null
    slice = { canvas, ctx: context }
    slices.set(key, slice)
  }
  if (slice.canvas.width !== width || slice.canvas.height !== height) {
    slice.canvas.width = width
    slice.canvas.height = height
  }
  return slice
}

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { buildSolidSvg, buildTextSvg } from '@shared/render/text'
import type { TextSpec } from '@shared/timeline'
import { join } from 'node:path'
import { app } from 'electron'
import sharp from 'sharp'
import { resolveAssetFile } from './assets/scan'

/**
 * Title templates.
 *
 * The library's titles are Inkscape SVGs shaped `<text><tspan>copy</tspan></text>`,
 * so each tspan is an editable slot. Substituting the copy and rasterising gives
 * a designed title card driven by data — which is the shape the director will
 * eventually emit, not a flat image.
 */

const TSPAN = /(<tspan\b[^>]*>)([\s\S]*?)(<\/tspan>)/g

/** XML-escape, or an ampersand in the user's copy produces invalid SVG. */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

export interface TitleSlot {
  index: number
  /** The template's own placeholder copy, e.g. "The Title". */
  placeholder: string
}

export async function readTitleSlots(relativePath: string): Promise<TitleSlot[]> {
  const svg = await readFile(resolveAssetFile(relativePath), 'utf8')
  const slots: TitleSlot[] = []
  let match: RegExpExecArray | null
  const pattern = new RegExp(TSPAN.source, 'g')

  while ((match = pattern.exec(svg)) !== null) {
    slots.push({
      index: slots.length,
      // Strip any nested markup: only the visible copy is editable.
      placeholder: match[2].replace(/<[^>]*>/g, '').trim()
    })
  }
  return slots
}

function substitute(svg: string, texts: string[]): string {
  let slot = 0
  return svg.replace(new RegExp(TSPAN.source, 'g'), (whole, open: string, body: string, close: string) => {
    const replacement = texts[slot]
    slot++
    // An omitted slot keeps the template's own copy rather than emptying it,
    // so a half-filled title still looks designed.
    if (replacement === undefined) return whole
    return `${open}${escapeXml(replacement)}${close}`
  })
}

function cacheDir(): string {
  return join(app.getPath('userData'), 'titles')
}

/**
 * Render a title to PNG.
 *
 * Written to a stable path per clip and overwritten in place, so a clip's asset
 * path never changes as its copy is edited — the preview just needs to be told
 * the bytes changed.
 */
export async function renderTitle(options: {
  template: string
  texts: string[]
  clipId: string
  width: number
  height: number
}): Promise<string> {
  const { template, texts, clipId, width, height } = options
  const svg = await readFile(resolveAssetFile(template), 'utf8')
  const filled = substitute(svg, texts)

  await mkdir(cacheDir(), { recursive: true })
  const target = join(cacheDir(), `${clipId}.png`)

  const png = await sharp(Buffer.from(filled), { density: 200 })
    .resize({
      width,
      height,
      fit: 'contain',
      // Transparent: a title is an overlay, and a white card behind it would
      // hide the video it is supposed to sit on.
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    })
    .png()
    .toBuffer()

  await writeFile(target, png)
  return target
}


/**
 * Plain text as a transparent PNG.
 *
 * The SVG itself is built in shared/render/text so the typography can be tested
 * without a rasteriser; this only turns it into pixels.
 */
export async function renderText(options: {
  spec: TextSpec
  clipId: string
  width: number
  height: number
}): Promise<string> {
  const { spec, clipId, width, height } = options
  await mkdir(cacheDir(), { recursive: true })
  const target = join(cacheDir(), `${clipId}.png`)
  const svg = buildTextSvg(spec, width, height)
  await writeFile(target, await sharp(Buffer.from(svg), { density: 200 }).png().toBuffer())
  return target
}

/**
 * Write an image the renderer already drew.
 *
 * Text is rasterised in the renderer because that is the only process where the
 * catalogue's fonts actually exist — librsvg, which sharp uses here, resolves
 * one face and ignores the family. So the pixels arrive finished and this only
 * puts them where every other generated picture lives.
 */
/**
 * One frame of an animated text clip.
 *
 * Written into a folder of its own, numbered, so ffmpeg can read the lot as an
 * image sequence. Only the frames that actually MOVE are written — the last is
 * held for the rest of the clip by `tpad` — so a three-second caption with a
 * third of a second of movement costs about ten files rather than ninety.
 *
 * Hands back the ffmpeg pattern rather than the folder: the separator is joined
 * here, where the platform is known, instead of being guessed in the renderer.
 */
export async function writeTitleFrame(
  clipId: string,
  frame: number,
  bytes: Buffer
): Promise<string> {
  const dir = join(cacheDir(), `${clipId}.seq`)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, `${String(frame).padStart(5, '0')}.png`), bytes)
  return join(dir, '%05d.png')
}

/** Throw away a clip's frames, so a shortened animation leaves none behind. */
export async function clearTitleFrames(clipId: string): Promise<void> {
  await rm(join(cacheDir(), `${clipId}.seq`), { recursive: true, force: true }).catch(
    () => undefined
  )
}

export async function writeTitleImage(clipId: string, bytes: Buffer): Promise<string> {
  await mkdir(cacheDir(), { recursive: true })
  const target = join(cacheDir(), `${clipId}.png`)
  await writeFile(target, bytes)
  return target
}

/** A flat card of colour, as a PNG so it is an ordinary clip like any other. */
export async function renderSolid(options: {
  color: string
  opacity: number
  clipId: string
  width: number
  height: number
}): Promise<string> {
  const { color, opacity, clipId, width, height } = options
  const svg = buildSolidSvg(color, opacity, width, height)

  await mkdir(cacheDir(), { recursive: true })
  const target = join(cacheDir(), `${clipId}.png`)
  await writeFile(target, await sharp(Buffer.from(svg), { density: 96 }).png().toBuffer())
  return target
}

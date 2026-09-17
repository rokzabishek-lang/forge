import type { CaptionLayer } from '../graphics/spec'
import { animationFrames, piecesOf, textAnimationById } from '../render/textAnimation'

/**
 * Planning a caption bake.
 *
 * Styled captions cannot be burned in by libass, so they have to be drawn. The
 * question this answers is how to draw as LITTLE as possible.
 *
 * Two observations do nearly all the work:
 *
 *  - A caption is mostly STILL. Between one word lighting up and the next, every
 *    frame is the same picture. Drawing them all is drawing one picture eighty
 *    times, so the run is baked once and held.
 *
 *  - A caption occupies a BAND, not a frame. Everything above it never changes,
 *    and compositing it is the single biggest cost in the render — measured at
 *    1080x1920, a full-frame overlay costs 3.4s per ten seconds of video against
 *    0.86s for a band, and a full-frame PNG costs 13.8ms to encode against 3.8ms.
 *
 * The result is a list of distinct pictures and a run-length timeline over them,
 * which the renderer draws and ffmpeg replays through the concat demuxer as one
 * more overlay in the ordinary single-pass graph. No second encode, and no
 * offscreen browser being screenshotted once per frame.
 */

/** One distinct picture. `layer` of -1 is the blank — no caption on screen. */
export interface CaptionPicture {
  layer: number
  /** Which word is lit, or -1. */
  word: number
  /**
   * Frames since the line appeared, for the animation.
   *
   * Clamped to the point the movement finishes: every frame after that is the
   * same picture, and collapsing them is most of the saving on a static style.
   */
  since: number
}

export interface CaptionBakePlan {
  /** Distinct pictures to draw, in first-appearance order. */
  pictures: CaptionPicture[]
  /** Run-length over the whole timeline: which picture, for how many frames. */
  runs: { picture: number; frames: number }[]
  /** Frames the bake covers. */
  totalFrames: number
}

/** Which word of a line is lit at a timeline frame. */
export function activeWordOf(layer: CaptionLayer, frame: number): number {
  let active = -1
  for (let i = 0; i < layer.wordFrames.length; i++) {
    if (frame >= layer.wordFrames[i]) active = i
  }
  return active
}

/**
 * How many frames of a line actually move.
 *
 * After this the animation has settled and only the highlight changes, so
 * `since` can be pinned and the pictures collapse.
 */
function movingFrames(layer: CaptionLayer, fps: number): number {
  const animation = textAnimationById(layer.spec.animationId)
  if (!animation) return 0
  const pieces = layer.spec.content
    .split('\n')
    .reduce((most, line) => Math.max(most, piecesOf(line, animation.scope).length), 1)
  return animationFrames(animation, fps, pieces)
}

/**
 * Work out what has to be drawn for a timeline of caption lines.
 *
 * Pure, so the saving it claims can be asserted rather than hoped for.
 */
export function planCaptionBake(
  layers: CaptionLayer[],
  fps: number,
  totalFrames: number
): CaptionBakePlan | null {
  if (layers.length === 0 || totalFrames <= 0) return null

  const moving = layers.map((layer) => movingFrames(layer, fps))

  const pictures: CaptionPicture[] = []
  const index = new Map<string, number>()
  const runs: { picture: number; frames: number }[] = []

  const pictureFor = (layer: number, word: number, since: number): number => {
    const key = `${layer}:${word}:${since}`
    const existing = index.get(key)
    if (existing !== undefined) return existing
    const id = pictures.length
    pictures.push({ layer, word, since })
    index.set(key, id)
    return id
  }

  /** The blank, reused for every gap between lines. */
  const blank = pictureFor(-1, -1, 0)

  for (let frame = 0; frame < totalFrames; frame++) {
    // The last line to have started wins, so lines that abut do not flicker.
    let chosen = -1
    for (let i = 0; i < layers.length; i++) {
      const layer = layers[i]
      if (frame >= layer.startFrame && frame < layer.endFrame) chosen = i
    }

    let picture = blank
    if (chosen >= 0) {
      const layer = layers[chosen]
      const since = Math.min(frame - layer.startFrame, moving[chosen])
      picture = pictureFor(chosen, activeWordOf(layer, frame), since)
    }

    const last = runs[runs.length - 1]
    if (last && last.picture === picture) last.frames += 1
    else runs.push({ picture, frames: 1 })
  }

  return { pictures, runs, totalFrames }
}

/**
 * The concat demuxer list for a bake.
 *
 * `duration` after each entry is how long that picture holds, which is what
 * turns eighty identical frames into one file. The final entry is repeated with
 * no duration because the demuxer ignores the last one it is given — a known
 * quirk, and without the repeat the closing run is dropped.
 */
/**
 * A path the concat demuxer will read back as the path it was given.
 *
 * Two things bite here, and both of them bite only on Windows — which is
 * exactly why they are worth writing down rather than discovering on someone
 * else's laptop.
 *
 * Backslash is an ESCAPE character to the demuxer, inside quotes as much as
 * out. `file 'C:\Users\spyker\00001.png'` therefore does not name that file: it
 * names one with a tab in it, because `\U` and the rest are consumed on the way
 * through. ffmpeg accepts forward slashes on Windows everywhere, so the path is
 * simply written with them.
 *
 * A single quote inside the path would close the quoting early. The demuxer's
 * own convention for one is to end the quote, emit an escaped quote, and start
 * again — the same `'\''` shell users know.
 */
export function concatPath(path: string): string {
  const forward = path.replace(/\\/g, '/')
  return `'${forward.split("'").join("'\\''")}'`
}

export function concatList(
  plan: CaptionBakePlan,
  fps: number,
  fileFor: (picture: number) => string
): string {
  const lines: string[] = []
  for (const run of plan.runs) {
    lines.push(`file ${concatPath(fileFor(run.picture))}`)
    lines.push(`duration ${(run.frames / fps).toFixed(6)}`)
  }
  const last = plan.runs[plan.runs.length - 1]
  if (last) lines.push(`file ${concatPath(fileFor(last.picture))}`)
  return `${lines.join('\n')}\n`
}

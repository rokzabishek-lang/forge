import { execFile } from 'node:child_process'
import { FFMPEG_PATH } from '../ffmpeg/paths'
import { keyProbeAlpha, keyProbeArgs, keyScaleFromProbe } from '@shared/render/chromaKey'

/**
 * How THIS ffmpeg measures a chroma key's distance — see keyScaleFromProbe.
 *
 * The two bundled builds disagree by √2, and which one is running is a fact
 * about the machine, so it is measured on it: one 16×16 patch, keyed, its alpha
 * read back. Cached for the process. A probe that fails answers 1 — the model's
 * own scale — and is not cached, so the next export asks again rather than
 * living with a guess (the lesson of the encoder probe).
 */
let cached: Promise<number> | null = null

export function keyDistanceScale(): Promise<number> {
  if (cached) return cached
  const probe = new Promise<number | null>((resolve) => {
    execFile(
      FFMPEG_PATH,
      keyProbeArgs(),
      // windowsHide: a console child in a packaged app opens a window without it.
      { windowsHide: true, timeout: 15_000, encoding: 'buffer', maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        // The middle of the patch, away from any edge the 3x3 average might see.
        const alpha = err || !stdout ? null : keyProbeAlpha(stdout as unknown as Buffer)
        resolve(alpha === null ? null : keyScaleFromProbe(alpha))
      }
    )
  })
  /*
   * Forgotten in a `then`, never inside the callback: an execFile that answers
   * before `new Promise` has returned would clear the cache before it was set,
   * and the failure would be cached after all.
   */
  const answer: Promise<number> = probe.then((scale) => {
    if (scale !== null) return scale
    if (cached === answer) cached = null
    return 1
  })
  cached = answer
  return answer
}

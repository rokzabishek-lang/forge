/**
 * One peaks read per file, however many clips want it.
 *
 * The trimmer asks for peaks when you select a clip — one file at a time, and
 * a Map was enough. The timeline asks for every clip at once, and a project
 * built from a dozen files would otherwise open a dozen ffmpeg processes in the
 * same tick, several of them for the SAME file, because nothing had resolved
 * yet for the cache to hold. The main process caches too, but only after the
 * first read returns.
 *
 * So: cache the result, share the promise while it is in flight, and let a few
 * run at a time rather than all of them.
 */

export interface Peaks {
  /** Interleaved min/max pairs, -1..1, one pair per bucket. */
  values: number[]
  buckets: number
  durationMs: number
}

const done = new Map<string, Peaks>()
const inFlight = new Map<string, Promise<Peaks>>()

/**
 * Decoding is cheap per file and expensive all at once.
 *
 * Three is enough to keep the visible clips filling in quickly without handing
 * the machine twenty simultaneous decodes while someone is trying to scrub.
 */
const MAX_PARALLEL = 3
let running = 0
const queue: (() => void)[] = []

function slot(): Promise<void> {
  if (running < MAX_PARALLEL) {
    running++
    return Promise.resolve()
  }
  return new Promise<void>((resolve) => queue.push(resolve))
}

function release(): void {
  const next = queue.shift()
  if (next) next()
  else running--
}

/** What is already known, with no request and no waiting. */
export function cachedPeaks(path: string, buckets: number): Peaks | undefined {
  return done.get(`${path}::${buckets}`)
}

export function loadPeaks(path: string, buckets: number): Promise<Peaks> {
  const key = `${path}::${buckets}`
  const ready = done.get(key)
  if (ready) return Promise.resolve(ready)
  const pending = inFlight.get(key)
  if (pending) return pending

  const promise = slot()
    .then(() => window.forge.peaks(path, buckets))
    .then((peaks) => {
      done.set(key, peaks)
      return peaks
    })
    .finally(() => {
      inFlight.delete(key)
      release()
    })

  inFlight.set(key, promise)
  return promise
}

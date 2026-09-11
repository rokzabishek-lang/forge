import { spawn } from 'node:child_process'
import { FFMPEG_PATH } from './ffmpeg/paths'

export interface Peaks {
  /** Interleaved min/max pairs, -1..1, one pair per bucket. */
  values: number[]
  buckets: number
  durationMs: number
}

/**
 * Peaks are computed here rather than in the renderer.
 *
 * decodeAudioData loads the entire file as float PCM — a 40-minute podcast is
 * hundreds of megabytes in the browser heap. Decoding to low-rate mono s16 and
 * reducing to buckets keeps it to a few MB of streaming work, and reuses the
 * ffmpeg the app already ships.
 */
const cache = new Map<string, Peaks>()
const MAX_CACHE = 24

/** Low enough to stay cheap, high enough that transients still register. */
const ANALYSIS_RATE = 8000

export function peaksFor(path: string, buckets = 600): Promise<Peaks> {
  const key = `${path}::${buckets}`
  const cached = cache.get(key)
  if (cached) return Promise.resolve(cached)

  return new Promise((resolve, reject) => {
    const child = spawn(
      FFMPEG_PATH,
      [
        '-hide_banner', '-nostdin', '-loglevel', 'error',
        '-i', path,
        '-vn',
        '-ac', '1',
        '-ar', String(ANALYSIS_RATE),
        '-f', 's16le',
        'pipe:1'
      ],
      { windowsHide: true }
    )

    const chunks: Buffer[] = []
    let bytes = 0
    child.stdout.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
      bytes += chunk.length
    })

    const errors: string[] = []
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      errors.push(chunk)
      if (errors.length > 10) errors.shift()
    })

    child.on('error', (err) => reject(new Error(`Could not read audio: ${err.message}`)))

    child.on('close', (code) => {
      if (code !== 0) {
        const message = errors.join('').trim()
        // Media with no audio stream makes ffmpeg fail rather than emit nothing.
        // That is not an error condition here — a silent video simply has no
        // waveform, and the UI should say so rather than show a failure.
        if (/does not contain any stream|Output file .* does not contain/i.test(message)) {
          const empty: Peaks = { values: [], buckets: 0, durationMs: 0 }
          cache.set(key, empty)
          resolve(empty)
          return
        }
        reject(new Error(message || `ffmpeg exited with code ${code}`))
        return
      }

      const pcm = Buffer.concat(chunks, bytes)
      const samples = Math.floor(pcm.length / 2)
      if (samples === 0) {
        // A file with no audio stream is not an error — it just has no waveform.
        const empty: Peaks = { values: [], buckets: 0, durationMs: 0 }
        cache.set(key, empty)
        resolve(empty)
        return
      }

      const perBucket = Math.max(1, Math.floor(samples / buckets))
      const values: number[] = []

      for (let b = 0; b < buckets; b++) {
        const start = b * perBucket
        if (start >= samples) break
        const end = Math.min(samples, start + perBucket)

        let min = 1
        let max = -1
        for (let i = start; i < end; i++) {
          // Peak, not average: averaging flattens a waveform into a grey blob.
          const value = pcm.readInt16LE(i * 2) / 32768
          if (value < min) min = value
          if (value > max) max = value
        }
        values.push(min, max)
      }

      const peaks: Peaks = {
        values,
        buckets: values.length / 2,
        durationMs: Math.round((samples / ANALYSIS_RATE) * 1000)
      }

      if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value as string)
      cache.set(key, peaks)
      resolve(peaks)
    })
  })
}

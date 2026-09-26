#!/usr/bin/env node
/**
 * `node scripts/measure-sfx.mjs [folder…]` — every sound's length and where its
 * PEAK is, measured with the bundled ffmpeg (docs/PLAN.md §6.2).
 *
 * A riser's loudest moment is not its last frame, and a braam's hit is half a
 * second in: the Director lines each file's measured peak up with the event
 * frame, so the peak has to be a number, not a guess. This decodes each file
 * through the render's own front of chain — `aformat` to stereo floats, then
 * 48 kHz — and finds the loudest 10 ms window (RMS over both channels). The
 * table in `src/shared/director/soundRoles.ts` is filled from this, and
 * `tests/integration/soundRoles.int.test.ts` runs the same measurement so a
 * replaced file cannot keep a stale peak.
 *
 * Through the render's chain, not `-ac 1`: the upmix plays a mono file at
 * 0.707 in each channel (measured: a −20 dBFS mono tone reads −23.0 on the
 * stereo bus), so a mono downmix reads every mono file — all the library's
 * .wav sounds — 3 dB hotter than the render ever plays it, and a level set
 * from that lands 3 dB low. Found by the C3 review.
 */
import { execFile } from 'node:child_process'
import { readdir, stat } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const FFMPEG = require('@ffmpeg-installer/ffmpeg').path
const run = promisify(execFile)
const RATE = 48000
const WINDOW = Math.round(RATE * 0.01)

/** Seconds, peak seconds and the peak's level on the render's stereo bus, for one file. */
export async function measureSound(file) {
  const { stdout } = await run(
    FFMPEG,
    ['-hide_banner', '-loglevel', 'error', '-i', file, '-af', `aformat=sample_fmts=fltp:channel_layouts=stereo,aresample=${RATE}`, '-f', 'f32le', 'pipe:1'],
    { encoding: 'buffer', maxBuffer: 512 * 1024 * 1024 }
  )
  // Interleaved L R L R …: a frame is two floats.
  const samples = new Float32Array(stdout.buffer, stdout.byteOffset, Math.floor(stdout.length / 4))
  const frames = Math.floor(samples.length / 2)
  let best = -1
  let at = 0
  for (let start = 0; start + WINDOW <= frames; start += WINDOW / 2) {
    let sum = 0
    for (let i = start * 2; i < (start + WINDOW) * 2; i++) sum += samples[i] * samples[i]
    const rms = Math.sqrt(sum / (WINDOW * 2))
    if (rms > best) {
      best = rms
      at = start + WINDOW / 2
    }
  }
  return {
    seconds: frames / RATE,
    peakSeconds: at / RATE,
    peakDb: best > 0 ? 20 * Math.log10(best) : -Infinity
  }
}

const AUDIO = new Set(['.wav', '.mp3', '.m4a', '.aac', '.flac', '.ogg'])

async function main() {
  const folders = process.argv.slice(2)
  if (folders.length === 0) {
    console.error('usage: node scripts/measure-sfx.mjs <folder> [folder…]')
    process.exit(2)
  }
  for (const folder of folders) {
    const files = (await readdir(folder)).filter((f) => AUDIO.has(extname(f).toLowerCase())).sort()
    for (const f of files) {
      const file = join(folder, f)
      if (!(await stat(file)).isFile()) continue
      const m = await measureSound(file)
      console.log(`${basename(file).padEnd(40)} ${m.seconds.toFixed(3).padStart(7)} s  peak ${m.peakSeconds.toFixed(3)} s  ${m.peakDb.toFixed(1)} dB`)
    }
  }
}

if (process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]))) main()

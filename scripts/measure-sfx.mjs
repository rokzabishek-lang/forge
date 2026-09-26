#!/usr/bin/env node
/**
 * `node scripts/measure-sfx.mjs [folder…]` — every sound's length and where its
 * PEAK is, measured with the bundled ffmpeg (docs/PLAN.md §6.2).
 *
 * A riser's loudest moment is not its last frame, and a braam's hit is half a
 * second in: the Director lines each file's measured peak up with the event
 * frame, so the peak has to be a number, not a guess. This decodes each file
 * to mono 48 kHz floats and finds the loudest 10 ms window (RMS). The table in
 * `src/shared/director/soundRoles.ts` is filled from this, and
 * `tests/integration/soundRoles.int.test.ts` runs the same measurement so a
 * replaced file cannot keep a stale peak.
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

/** Seconds, peak seconds and the peak's level, for one file. */
export async function measureSound(file) {
  const { stdout } = await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', file, '-f', 'f32le', '-ac', '1', '-ar', String(RATE), 'pipe:1'], {
    encoding: 'buffer',
    maxBuffer: 512 * 1024 * 1024
  })
  const samples = new Float32Array(stdout.buffer, stdout.byteOffset, Math.floor(stdout.length / 4))
  let best = -1
  let at = 0
  for (let start = 0; start + WINDOW <= samples.length; start += WINDOW / 2) {
    let sum = 0
    for (let i = start; i < start + WINDOW; i++) sum += samples[i] * samples[i]
    const rms = Math.sqrt(sum / WINDOW)
    if (rms > best) {
      best = rms
      at = start + WINDOW / 2
    }
  }
  return {
    seconds: samples.length / RATE,
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

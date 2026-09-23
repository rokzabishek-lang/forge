/**
 * Where render checks put what they rendered.
 *
 * Integration tests here used to render into `mkdtemp(tmpdir())` and delete it
 * on the way out, so when one failed the only evidence left was the assertion
 * message — and "expected 34 to be greater than 120" tells you a pixel was the
 * wrong colour without letting you look at the frame. These write into
 * `tests/output/<check>/` and leave it there.
 *
 * The folder is gitignored and cleared at the start of each run, so it always
 * holds the LAST run and never grows without bound. Open it after a failure;
 * open it after a pass to see what the fix actually looks like.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg'

export const FFMPEG: string = ffmpegInstaller.path
export const run = promisify(execFile)

/**
 * This binary's chroma-key distance scale, measured the way the app measures
 * it (render/chromaKey.ts keyScaleFromProbe): 1 on macOS, √2 on the 2018
 * Windows build. Every render that keys has to pass it, as the app does.
 */
let keyScaleOnce: Promise<number> | null = null
export function keyScale(): Promise<number> {
  keyScaleOnce ??= (async () => {
    const { keyProbeAlpha, keyProbeArgs, keyScaleFromProbe } = await import('@shared/render/chromaKey')
    const { stdout } = await run(FFMPEG, keyProbeArgs(), { encoding: 'buffer', maxBuffer: 1 << 20 })
    const alpha = keyProbeAlpha(stdout as unknown as Buffer)
    if (alpha === null) throw new Error('the chroma-key probe returned no picture')
    return keyScaleFromProbe(alpha)
  })()
  return keyScaleOnce
}

/** `tests/output`, next to the tests rather than in a system temp folder. */
export const OUTPUT_ROOT = resolve(__dirname, '..', 'output')

/**
 * A clean folder for one check's artefacts.
 *
 * Cleared rather than appended to: a stale frame from a previous run that
 * happens to look right is worse than no frame at all.
 */
export async function outputDir(name: string): Promise<string> {
  const dir = join(OUTPUT_ROOT, name)
  await mkdir(dir, { recursive: true })
  /*
   * Emptied, not removed and remade.
   *
   * Removing the folder itself fails whenever something is holding it open —
   * on Windows, an Explorer window showing it or a terminal sitting in it,
   * which is exactly what someone does to look at these files. Its CONTENTS
   * can still be cleared. Found when a render check failed with EPERM on
   * `rmdir` because a shell had been left in the folder.
   */
  for (const entry of await readdir(dir)) {
    await rm(join(dir, entry), { recursive: true, force: true })
  }
  return dir
}

/** A solid-colour clip, the cheapest thing that is unmistakably itself. */
export async function makeColour(
  file: string,
  colour: string,
  size: { width: number; height: number },
  seconds: number,
  fps = 30
): Promise<string> {
  await run(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
    '-i', `color=c=${colour}:size=${size.width}x${size.height}:rate=${fps}:duration=${seconds}`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file
  ])
  return file
}

/**
 * A colour with a tone in it — a video file that also has sound.
 *
 * Needed wherever a check is about DIALOGUE, which the render defines as the
 * audio of a clip on a video track. An audio-only file declared as video gets
 * as far as the filtergraph and dies there with "Stream specifier ':v' matches
 * no streams", which reads like a bug in the plan rather than like a fixture
 * that was never a video.
 */
export async function makeClipWithTone(
  file: string,
  colour: string,
  hz: number,
  size: { width: number; height: number },
  seconds: number,
  fps = 30
): Promise<string> {
  await run(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=${colour}:size=${size.width}x${size.height}:rate=${fps}:duration=${seconds}`,
    '-f', 'lavfi', '-i', `sine=frequency=${hz}:duration=${seconds}:sample_rate=48000`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k',
    '-shortest', file
  ])
  return file
}

/** A tone, for anything that has to be heard rather than seen. */
export async function makeTone(
  file: string,
  hz: number,
  seconds: number,
  volume = 1
): Promise<string> {
  await run(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
    '-i', `sine=frequency=${hz}:duration=${seconds}:sample_rate=48000`,
    '-af', `volume=${volume}`, '-c:a', 'aac', '-b:a', '192k', file
  ])
  return file
}

/** One pixel of one frame, as RGB. */
export async function pixelAt(
  file: string,
  seconds: number,
  x: number,
  y: number,
  size: { width: number; height: number }
): Promise<[number, number, number]> {
  const { stdout } = await run(
    FFMPEG,
    ['-hide_banner', '-loglevel', 'error', '-ss', String(seconds), '-i', file,
     '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
    { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }
  )
  const buf = stdout as unknown as Buffer
  const i = (y * size.width + x) * 3
  return [buf[i], buf[i + 1], buf[i + 2]]
}

/**
 * Save a frame as a PNG beside the render, so a failure can be looked at.
 *
 * Called on the way past rather than only on failure: the passing frames are
 * what tell you the fix does what it says, and they cost a few milliseconds.
 */
export async function saveFrame(
  file: string,
  seconds: number,
  to: string
): Promise<void> {
  await run(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-ss', String(seconds), '-i', file, '-frames:v', '1', to
  ])
}

/**
 * Mean volume of a slice of a file's audio, in dB.
 *
 * `volumedetect` over a trimmed span, which is how you ask ffmpeg "how loud is
 * it HERE" — the same measurement docs/EFFECTS.md's fade and crossfade tables
 * were taken with, so numbers here are comparable to the ones written down
 * there.
 */
export async function meanVolumeDb(
  file: string,
  fromSeconds: number,
  seconds: number
): Promise<number> {
  const { stderr } = await run(FFMPEG, [
    '-hide_banner', '-nostats',
    '-ss', String(fromSeconds), '-t', String(seconds), '-i', file,
    '-af', 'volumedetect', '-f', 'null', '-'
  ])
  const found = /mean_volume:\s*(-?\d+(?:\.\d+)?) dB/.exec(stderr)
  if (!found) throw new Error(`no mean_volume in ffmpeg output for ${file}`)
  return Number(found[1])
}

/** A note beside the artefacts saying what they were meant to show. */
export async function writeNote(dir: string, lines: string[]): Promise<void> {
  await writeFile(join(dir, 'README.txt'), `${lines.join('\n')}\n`, 'utf8')
}

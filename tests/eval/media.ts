import { existsSync, writeFileSync } from 'node:fs'
import { copyFile, mkdir } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg'
import type { Fixture, MediaEntry, MusicSpec } from './fixtures'

/**
 * The fixtures' pictures, clips and music — made, not committed.
 *
 * The spine call is TEXT today: the model reads each slot's label, note and
 * speech, never its pixels (images are plumbed and not sent). So a colour card
 * named `05_first_look.jpg` with the note "first look, she's crying" is, to
 * the spine, exactly a photograph of that — and it renders to a frame whose
 * colour says which slot it is, which is what a render check needs. When a
 * real photo of the same NAME is in `FORGE_EVAL_MEDIA`, it is used instead,
 * and that is what the VLM half of C0 needs (docs/PLAN.md §3.1).
 */

const run = promisify(execFile)
export const FFMPEG: string = ffmpegInstaller.path

/** A still of one colour at the size the manifest gives. */
async function makeStill(entry: MediaEntry, out: string): Promise<void> {
  const [w, h] = entry.size
  await run(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=${entry.colour.replace('#', '0x')}:s=${w}x${h}`,
    '-frames:v', '1', out
  ])
}

/**
 * A clip: the manifest's colour with a moving test pattern in a corner so it
 * reads as footage, and a quiet tone when it speaks, so it carries sound.
 */
async function makeClip(entry: MediaEntry, out: string): Promise<void> {
  const [w, h] = entry.size
  const seconds = entry.seconds ?? 4
  const colour = entry.colour.replace('#', '0x')
  await run(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=${colour}:s=${w}x${h}:r=30:d=${seconds}`,
    '-f', 'lavfi', '-i', `testsrc2=s=${Math.round(w / 4)}x${Math.round(h / 8)}:r=30:d=${seconds}`,
    '-f', 'lavfi', '-i', `sine=frequency=220:duration=${seconds}:sample_rate=48000`,
    '-filter_complex', '[0:v][1:v]overlay=16:16,format=yuv420p[v];[2:a]volume=0.2[a]',
    '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac', '-shortest', out
  ])
}

/**
 * A music bed with a shape the beat analysis can find: hats and a soft kick on
 * each bar, a build that rises and rolls, then a drop with a kick on every
 * beat and a bass under it. Mono 44.1 kHz WAV, written directly — the same
 * approach `beats.int.test.ts` takes, so nothing but arithmetic decides where
 * the beats are.
 */
export function writeMusic(path: string, spec: MusicSpec): void {
  const sr = 44100
  const beat = 60 / spec.bpm
  const total = Math.floor(sr * spec.seconds)
  const data = Buffer.alloc(44 + total * 2)
  data.write('RIFF', 0)
  data.writeUInt32LE(36 + total * 2, 4)
  data.write('WAVEfmt ', 8)
  data.writeUInt32LE(16, 16)
  data.writeUInt16LE(1, 20)
  data.writeUInt16LE(1, 22)
  data.writeUInt32LE(sr, 24)
  data.writeUInt32LE(sr * 2, 28)
  data.writeUInt16LE(2, 32)
  data.writeUInt16LE(16, 34)
  data.write('data', 36)
  data.writeUInt32LE(total * 2, 40)

  // A deterministic noise source, so the file is byte-identical every run.
  let seed = 12345
  const noise = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x3fffffff - 1
  }

  for (let i = 0; i < total; i++) {
    const t = i / sr
    const index = Math.floor(t / beat)
    const phase = t - index * beat
    const inDrop = t >= spec.dropAt
    const inBuild = t >= spec.buildFrom && t < spec.dropAt
    let v = 0

    // Kick: every bar before the drop, every beat after it.
    if ((inDrop || index % 4 === 0) && phase < 0.12) {
      const env = Math.exp(-phase * 30)
      const f = 50 + 90 * Math.exp(-phase * 40)
      v += Math.sin(2 * Math.PI * f * phase) * env * (inDrop ? 0.9 : 0.55)
    }
    // Hat on the off-beat.
    const off = phase - beat / 2
    if (off >= 0 && off < 0.03) v += noise() * (1 - off / 0.03) * (inDrop ? 0.12 : 0.07)
    // The build: a snare roll that doubles in rate, over rising filtered noise.
    if (inBuild) {
      const k = (t - spec.buildFrom) / (spec.dropAt - spec.buildFrom)
      const step = beat / (k < 0.5 ? 2 : 4)
      const p = t % step
      if (p < 0.04) v += noise() * (1 - p / 0.04) * (0.1 + 0.3 * k)
      v += noise() * 0.06 * k * k
    }
    // Bass under the drop.
    if (inDrop) v += Math.sin(2 * Math.PI * 55 * t) * 0.25

    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32767), 44 + i * 2)
  }
  writeFileSync(path, data)
}

export interface Made {
  /** Absolute path of each media entry by name, in manifest order. */
  media: Map<string, string>
  music: string
  /** Names that came from FORGE_EVAL_MEDIA rather than being made. */
  real: string[]
}

/**
 * Everything one fixture needs on disk, under `dir`.
 *
 * Made once and reused: a colour card does not change between runs, and the
 * eval should spend its time on the model, not on ffmpeg.
 */
export async function makeFixtureMedia(fixture: Fixture, dir: string, realDir = process.env.FORGE_EVAL_MEDIA): Promise<Made> {
  await mkdir(dir, { recursive: true })
  const media = new Map<string, string>()
  const real: string[] = []
  // Separate folders, so a made card cached from an earlier run can never be
  // mistaken for a real photo supplied since, or the other way round.
  await mkdir(join(dir, 'made'), { recursive: true })
  await mkdir(join(dir, 'real'), { recursive: true })
  for (const entry of fixture.media) {
    const supplied = realDir ? join(realDir, fixture.id, entry.name) : null
    if (supplied && existsSync(supplied)) {
      const out = join(dir, 'real', entry.name)
      await copyFile(supplied, out)
      real.push(entry.name)
      media.set(entry.name, out)
      continue
    }
    const out = join(dir, 'made', entry.name)
    if (!existsSync(out)) await (entry.kind === 'image' ? makeStill(entry, out) : makeClip(entry, out))
    media.set(entry.name, out)
  }
  const music = join(dir, 'music.wav')
  if (!existsSync(music)) writeMusic(music, fixture.music)
  return { media, music, real }
}

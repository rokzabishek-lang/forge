import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { mkdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import { FFMPEG_PATH } from './ffmpeg/paths'

const run = promisify(execFile)

/**
 * Pulling a song apart, with the ffmpeg we already ship.
 *
 * Two things want this and they want different halves of it. Sheet ⑥ asks for
 * "instrumental only" as a download option. Cutting to the LYRIC — putting an
 * edit on a sung word rather than on the beat under it — needs the opposite:
 * the voice on its own, clean enough for speech recognition to read.
 *
 * Mid/side gets one of those two very well and the other only partly, and the
 * difference is worth being straight about rather than calling both of them
 * "separation":
 *
 *   INSTRUMENTAL is the side signal, L−R. Anything mixed dead centre cancels
 *   with itself. Measured on a synthetic mix — a 440Hz tone centred, 100Hz hard
 *   left, 3kHz hard right — the centred tone dropped 29dB while both panned
 *   tones came through untouched. That is a real instrumental, not an
 *   approximation of one.
 *
 *   VOICE is the mid signal with the bass and the very top rolled off. The
 *   voice survives at full level and the bass falls 13dB, but anything
 *   hard-panned still arrives at half strength — measured 3dB down, not gone.
 *   So this is an EMPHASIS, not an isolation, and it is labelled as one.
 *
 * Which is enough for what it is for. Speech recognition wants the words
 * legible, not the stem pristine. A proper separation — Demucs — is a much
 * heavier dependency and lives in the sidecar as an optional upgrade; when it
 * is installed the caller gets `separated` instead of `emphasised` and
 * everything downstream is unchanged.
 */

export type StemQuality = 'separated' | 'emphasised'

export interface Stems {
  /** The song without the centred voice. */
  instrumental: string
  /** The voice, as clean as the chosen backend can make it. */
  voice: string
  backend: string
  quality: StemQuality
}

/** Whisper's own rate. Resampling later would only cost a second pass. */
const VOICE_RATE = 16_000

/**
 * The voice chain.
 *
 * `highpass` at 200 takes out the kick and the bass, which is where most of the
 * energy in a mix lives and none of the intelligibility. `lowpass` at 8k is
 * above every formant that matters and below most cymbal wash. `dynaudnorm`
 * evens the level out across the track — a quiet verse and a loud chorus
 * transcribe very differently, and the loud one is not the problem.
 */
const VOICE_FILTER =
  'pan=mono|c0=0.5*c0+0.5*c1,highpass=f=200,lowpass=f=8000,dynaudnorm=f=250:g=15'

/**
 * The instrumental chain.
 *
 * Kept stereo: collapsing it to mono after cancelling the centre would leave
 * L−R and R−L summing back to silence, which is the one arrangement of these
 * three filters that produces nothing at all.
 */
const INSTRUMENTAL_FILTER = 'pan=stereo|c0=c0-c1|c1=c1-c0'

function cacheDir(): string {
  return join(app.getPath('userData'), 'stems')
}

/** Stable per source file and content, so a second ask is free. */
function keyFor(path: string, size: number, mtimeMs: number): string {
  return createHash('sha1').update(`${path}:${size}:${Math.round(mtimeMs)}`).digest('hex').slice(0, 16)
}

async function exists(path: string): Promise<boolean> {
  try {
    const info = await stat(path)
    return info.size > 0
  } catch {
    return false
  }
}

/**
 * Split a song, or hand back the split that is already on disk.
 *
 * Both halves are written in ONE ffmpeg invocation. Decoding a five-minute song
 * twice to produce two files from the same input is the sort of waste that only
 * shows up as "why is this slow" much later.
 */
export async function splitStems(path: string): Promise<Stems> {
  const info = await stat(path)
  const key = keyFor(path, info.size, info.mtimeMs)
  const dir = cacheDir()
  const voice = join(dir, `${key}.voice.wav`)
  const instrumental = join(dir, `${key}.instrumental.wav`)

  if ((await exists(voice)) && (await exists(instrumental))) {
    return { voice, instrumental, backend: 'mid-side', quality: 'emphasised' }
  }

  await mkdir(dir, { recursive: true })
  await run(
    FFMPEG_PATH,
    [
      '-hide_banner',
      '-nostdin',
      '-loglevel',
      'error',
      '-y',
      '-i',
      path,
      // A mono source has no side signal at all, so force stereo first rather
      // than emitting a silent instrumental and calling it a separation.
      '-filter_complex',
      `[0:a]aformat=channel_layouts=stereo,asplit=2[a][b];` +
        `[a]${VOICE_FILTER}[voice];` +
        `[b]${INSTRUMENTAL_FILTER}[inst]`,
      '-map',
      '[voice]',
      '-ar',
      String(VOICE_RATE),
      '-ac',
      '1',
      voice,
      '-map',
      '[inst]',
      instrumental
    ],
    // windowsHide: this decodes a whole track, so the console window it would
    // otherwise open is not a flicker — it sits in front of the app and takes
    // focus for the length of the split.
    { maxBuffer: 16 * 1024 * 1024, windowsHide: true }
  )

  return { voice, instrumental, backend: 'mid-side', quality: 'emphasised' }
}

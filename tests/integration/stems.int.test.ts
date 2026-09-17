import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg'

/*
 * Pulling a song apart with mid/side, measured.
 *
 * src/main/stems.ts cannot be imported here — it reaches for electron's
 * `app.getPath` — so this exercises the same two filter chains directly. What
 * is under test is the claim those chains make, which is the part that could be
 * wrong: that the instrumental genuinely loses the centred voice, and that the
 * voice chain genuinely keeps it.
 *
 * The fixture is three tones in known places: a 440Hz "voice" dead centre, a
 * 100Hz "bass" hard left, a 3kHz "hat" hard right. Real music is messier, but a
 * chain that cannot pass this cannot pass anything.
 */

const run = promisify(execFile)
const FFMPEG = ffmpegInstaller.path

const VOICE_FILTER =
  'pan=mono|c0=0.5*c0+0.5*c1,highpass=f=200,lowpass=f=8000,dynaudnorm=f=250:g=15'
const INSTRUMENTAL_FILTER = 'pan=stereo|c0=c0-c1|c1=c1-c0'

let dir = ''
let mix = ''

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'forge-stems-'))
  mix = join(dir, 'mix.wav')
  await run(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3:sample_rate=44100',
    '-f', 'lavfi', '-i', 'sine=frequency=100:duration=3:sample_rate=44100',
    '-f', 'lavfi', '-i', 'sine=frequency=3000:duration=3:sample_rate=44100',
    '-filter_complex',
    '[0:a][1:a][2:a]amerge=inputs=3,pan=stereo|c0=0.5*c0+0.7*c1|c1=0.5*c0+0.7*c2[a]',
    '-map', '[a]', mix
  ])
}, 120_000)

afterAll(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => undefined)
})

/** Mean level in dB of one narrow band of a file. */
async function band(path: string, hz: number, width: number): Promise<number> {
  const { stderr } = await run(
    FFMPEG,
    ['-hide_banner', '-i', path,
     '-af', `bandpass=f=${hz}:width_type=h:w=${width},volumedetect`,
     '-f', 'null', '-'],
    { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }
  ).catch((err: { stderr?: string }) => ({ stderr: err.stderr ?? '' }))
  const match = /mean_volume:\s*(-?[\d.]+) dB/.exec(stderr ?? '')
  if (!match) throw new Error(`No level for ${hz}Hz in ${path}`)
  return Number(match[1])
}

async function make(name: string, filter: string, extra: string[] = []): Promise<string> {
  const out = join(dir, name)
  await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', mix, '-af', filter, ...extra, out])
  return out
}

describe('mid/side stems', () => {
  it('the instrumental loses the centred voice and keeps everything panned', async () => {
    const instrumental = await make('inst.wav', INSTRUMENTAL_FILTER)

    const before = await band(mix, 440, 40)
    const after = await band(instrumental, 440, 40)
    // The claim in stems.ts is 29dB. Anything past 20 is a real cancellation
    // rather than a level change dressed up as one.
    expect(before - after).toBeGreaterThan(20)

    // And the panned parts survive — a filter that simply made everything
    // quieter would pass the test above.
    expect(await band(instrumental, 100, 25)).toBeGreaterThan(before - 6)
    expect(await band(instrumental, 3000, 300)).toBeGreaterThan(before - 6)
  }, 180_000)

  it('the voice chain keeps the voice and drops the bass', async () => {
    const voice = await make('voice.wav', VOICE_FILTER, ['-ar', '16000', '-ac', '1'])

    const mixVoice = await band(mix, 440, 40)
    expect(await band(voice, 440, 40)).toBeGreaterThan(mixVoice - 2)
    // Bass is where most of a mix's energy is and none of its intelligibility.
    expect(await band(voice, 100, 25)).toBeLessThan(mixVoice - 8)
  }, 180_000)

  it('is an emphasis and not an isolation, which is why it says so', async () => {
    /*
     * The honest half of the measurement. Mid keeps hard-panned content at half
     * strength, so a 3kHz tone panned fully right still arrives about 3dB down
     * rather than gone. Calling this "the vocals" would be a lie, and the
     * quality flag exists to keep the caller from believing one.
     */
    const voice = await make('voice2.wav', VOICE_FILTER, ['-ar', '16000', '-ac', '1'])
    const drop = (await band(mix, 3000, 300)) - (await band(voice, 3000, 300))
    expect(drop).toBeGreaterThan(0)
    expect(drop).toBeLessThan(12)
  }, 180_000)

  it('comes out at the rate speech recognition wants', async () => {
    const voice = await make('voice3.wav', VOICE_FILTER, ['-ar', '16000', '-ac', '1'])
    /*
     * Read off ffmpeg's own banner rather than shelling out to ffprobe.
     *
     * The obvious `ffmpegInstaller.path.replace(/ffmpeg$/, 'ffprobe')` is a
     * Mac-shaped assumption: on Windows the binary is `ffmpeg.exe`, the regex
     * matches nothing, and the test quietly runs ffmpeg with ffprobe's
     * arguments. It would still have passed, through a fallback, which is the
     * worst way for a platform bug to hide.
     */
    const { stderr } = await run(FFMPEG, ['-hide_banner', '-i', voice, '-f', 'null', '-'], {
      encoding: 'utf8'
    }).catch((err: { stderr?: string }) => ({ stderr: err.stderr ?? '' }))
    expect(stderr).toMatch(/16000 Hz/)
    expect(stderr).toMatch(/\bmono\b/)
  }, 180_000)

  it('a mono source still yields two usable files rather than silence', async () => {
    /*
     * L−R on a mono track is zero, so a mono song would come back as a silent
     * "instrumental" unless the chain forces stereo first. stems.ts does; this
     * is the case that proves it was needed.
     */
    const mono = join(dir, 'mono.wav')
    await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', mix, '-ac', '1', mono])

    const naive = join(dir, 'naive.wav')
    await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', mono,
      '-af', `aformat=channel_layouts=stereo,${INSTRUMENTAL_FILTER}`, naive])
    // Forced to stereo, both channels are identical, so the side signal really
    // is silence — the honest answer for a mono source, and not a crash.
    const level = await band(naive, 440, 40)
    expect(level).toBeLessThan(-60)

    // The voice half still works on a mono source, which is what matters.
    const voice = join(dir, 'monovoice.wav')
    await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', mono,
      '-af', `aformat=channel_layouts=stereo,${VOICE_FILTER}`, '-ar', '16000', '-ac', '1', voice])
    expect(await band(voice, 440, 40)).toBeGreaterThan(-40)
  }, 180_000)
})

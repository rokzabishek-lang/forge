import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { existsSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg'
import { SidecarClient } from '../../src/main/sidecar/client'

const SIDECAR_DIR = resolve(__dirname, '../../sidecar')
const VENV_PYTHON = join(SIDECAR_DIR, '.venv/bin/python')
const FFMPEG = ffmpegInstaller.path

const ready = existsSync(VENV_PYTHON)
const maybe = ready ? describe : describe.skip

let dir = ''
let click = ''
let offsetBars = ''
let dropTrack = ''
let client: SidecarClient

/**
 * A bar pattern with a loud kick on a known beat of every bar.
 *
 * `kickOn` is the grid index the kick falls on, so the downbeat phase can be
 * made deliberately non-zero — which is the case a naive `beats[::4]` gets
 * wrong, and the whole reason phase estimation exists.
 */
function writeBarPattern(path: string, bpm: number, seconds: number, kickOn: number): void {
  const sr = 44100
  const beat = 60 / bpm
  const total = Math.floor(sr * seconds)
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

  for (let i = 0; i < total; i++) {
    const t = i / sr
    const index = Math.floor(t / beat)
    const phase = t % beat
    let value = 0
    if (phase < 0.05) {
      const envelope = 1 - phase / 0.05
      value =
        index % 4 === kickOn
          ? Math.sin(2 * Math.PI * 55 * t) * envelope * 0.95
          : Math.sin(2 * Math.PI * 2200 * t) * envelope * 0.22
    }
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, value)) * 32767), 44 + i * 2)
  }
  writeFileSync(path, data)
}

/**
 * A track with a deliberate structure: loud intro, quiet break, rising
 * build-up, then a heavy drop at a known time.
 */
function writeDropTrack(path: string, bpm: number, dropAtSeconds: number, seconds: number): void {
  const sr = 44100
  const beat = 60 / bpm
  const bar = beat * 4
  const total = Math.floor(sr * seconds)
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

  const breakAt = dropAtSeconds - bar * 4
  const buildAt = dropAtSeconds - bar * 2

  for (let i = 0; i < total; i++) {
    const t = i / sr
    const index = Math.floor(t / beat)
    const phase = t % beat
    let gain = 0.55
    let bass = 0.5
    if (t >= breakAt && t < buildAt) {
      gain = 0.12
      bass = 0
    } else if (t >= buildAt && t < dropAtSeconds) {
      gain = 0.15 + ((t - buildAt) / (dropAtSeconds - buildAt)) * 0.5
      bass = 0
    } else if (t >= dropAtSeconds) {
      gain = 0.95
      bass = 1
    }

    let value = 0
    if (phase < 0.06) {
      const envelope = 1 - phase / 0.06
      if (index % 4 === 0 && bass > 0) {
        value += Math.sin(2 * Math.PI * 50 * t) * envelope * bass * 0.95
      }
      value += Math.sin(2 * Math.PI * 2000 * t) * envelope * gain * 0.3
    }
    // A riser sweeping upward through the build-up.
    if (t >= buildAt && t < dropAtSeconds) {
      const progress = (t - buildAt) / (dropAtSeconds - buildAt)
      value += Math.sin(2 * Math.PI * (400 + 2600 * progress) * t) * 0.28 * progress
    }
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, value)) * 32767), 44 + i * 2)
  }
  writeFileSync(path, data)
}

/** A click track at an exactly known tempo, so the result is checkable. */
function writeClickTrack(path: string, bpm: number, seconds: number): void {
  const sr = 44100
  const interval = 60 / bpm
  const total = Math.floor(sr * seconds)
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

  for (let i = 0; i < total; i++) {
    const t = i / sr
    const phase = t % interval
    let value = 0
    if (phase < 0.02) {
      const envelope = 1 - phase / 0.02
      value = Math.sin(2 * Math.PI * 1800 * t) * envelope * 0.9
    }
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, value)) * 32767), 44 + i * 2)
  }
  writeFileSync(path, data)
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'forge-beats-'))
  click = join(dir, 'click120.wav')
  writeClickTrack(click, 120, 8)
  offsetBars = join(dir, 'offset.wav')
  // Kick on grid beat 2 of each bar: the downbeat is deliberately not at index 0.
  writeBarPattern(offsetBars, 120, 12, 2)
  dropTrack = join(dir, 'drop.wav')
  writeDropTrack(dropTrack, 120, 16, 24)
  client = new SidecarClient({ cwd: SIDECAR_DIR, python: VENV_PYTHON, maxRestarts: 0 })
}, 120_000)

afterAll(async () => {
  client?.stop()
  await rm(dir, { recursive: true, force: true }).catch(() => undefined)
})

interface BeatResult {
  bpm: number
  beats: number[]
  downbeats: number[]
  onsets: number[]
  durationMs: number
  windowStartMs: number
  backend: string
  downbeatsInferred: boolean
  downbeatPhase: number
  energy: number[]
  tiers: number[]
  drops: { ms: number; score: number }[]
  buildups: { startMs: number; endMs: number; towardsMs: number }[]
  sections: number[]
}

maybe('audio.beats', () => {
  it('advertises the capability', async () => {
    const hello = await client.start()
    expect(hello.capabilities).toContain('audio.beats')
  }, 120_000)

  it('finds the tempo of a known click track', async () => {
    await client.start()
    const result = await client.request<BeatResult>('audio.beats', {
      path: click,
      ffmpeg: FFMPEG
    })
    // librosa's tempo estimate is within a few percent, not exact.
    expect(result.bpm).toBeGreaterThan(112)
    expect(result.bpm).toBeLessThan(128)
    expect(result.backend).toBe('librosa')
  }, 240_000)

  /*
   * A reel is built from the part of the song the user kept.
   *
   * Analysing the whole file spread a thirty-second selection of photos across
   * four minutes of audio the render would never reach — the bug this window
   * exists to close.
   */
  it('analyses only the requested window', async () => {
    await client.start()
    const whole = await client.request<BeatResult>('audio.beats', {
      path: click,
      ffmpeg: FFMPEG
    })
    const window = await client.request<BeatResult>('audio.beats', {
      path: click,
      ffmpeg: FFMPEG,
      startMs: 4000,
      endMs: 8000
    })

    expect(window.durationMs).toBeLessThan(whole.durationMs)
    expect(Math.abs(window.durationMs - 4000)).toBeLessThan(400)
    // Times are relative to the window, not the file — the caller owns where
    // the window sits on the timeline.
    expect(window.windowStartMs).toBe(4000)
    expect(Math.max(...window.beats)).toBeLessThanOrEqual(window.durationMs + 50)
  }, 240_000)

  it('places beats at the real interval, within visual-sync tolerance', async () => {
    await client.start()
    const result = await client.request<BeatResult>('audio.beats', {
      path: click,
      ffmpeg: FFMPEG
    })

    expect(result.beats.length).toBeGreaterThan(10)
    const gaps = result.beats.slice(1).map((b, i) => b - result.beats[i])
    const median = [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)]
    // 120 BPM is a beat every 500ms; 30ms is well inside what reads as on-beat.
    expect(Math.abs(median - 500)).toBeLessThan(30)
  }, 240_000)

  it('returns beats in order and inside the media', async () => {
    await client.start()
    const result = await client.request<BeatResult>('audio.beats', {
      path: click,
      ffmpeg: FFMPEG
    })
    for (let i = 1; i < result.beats.length; i++) {
      expect(result.beats[i]).toBeGreaterThan(result.beats[i - 1])
    }
    expect(Math.max(...result.beats)).toBeLessThanOrEqual(result.durationMs + 50)
  }, 240_000)

  it('flags downbeats as inferred, since librosa does not track metre', async () => {
    await client.start()
    const result = await client.request<BeatResult>('audio.beats', {
      path: click,
      ffmpeg: FFMPEG
    })
    // Being honest about this matters: a caller must not treat guessed
    // downbeats as if they were detected.
    expect(result.downbeatsInferred).toBe(true)
    expect(result.downbeats.length).toBeLessThan(result.beats.length)
  }, 240_000)

  it('finds the downbeat phase when it is not at grid index 0', async () => {
    await client.start()
    const result = await client.request<BeatResult>('audio.beats', {
      path: offsetBars,
      ffmpeg: FFMPEG
    })

    // Kicks land at 1000, 3000, 5000ms. A naive beats[::4] would put every
    // downbeat on a tick instead, and every structural cut with it.
    expect(result.downbeats.length).toBeGreaterThan(3)
    for (const downbeat of result.downbeats.slice(0, 4)) {
      const nearestKick = Math.round((downbeat - 1000) / 2000) * 2000 + 1000
      expect(Math.abs(downbeat - nearestKick)).toBeLessThan(60)
    }
  }, 240_000)

  it('spaces downbeats one bar apart', async () => {
    await client.start()
    const result = await client.request<BeatResult>('audio.beats', {
      path: offsetBars,
      ffmpeg: FFMPEG
    })
    const gaps = result.downbeats.slice(1).map((d, i) => d - result.downbeats[i])
    const median = [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)]
    // A bar at 120 BPM is 2000ms.
    expect(Math.abs(median - 2000)).toBeLessThan(80)
  }, 240_000)

  it('finds a drop where the music actually drops', async () => {
    await client.start()
    const result = await client.request<BeatResult>('audio.beats', {
      path: dropTrack,
      ffmpeg: FFMPEG
    })

    expect(result.drops.length).toBeGreaterThan(0)
    const nearest = result.drops.reduce((best, d) =>
      Math.abs(d.ms - 16_000) < Math.abs(best.ms - 16_000) ? d : best
    )
    // Landing on the wrong bar is worse than not finding it at all.
    expect(Math.abs(nearest.ms - 16_000)).toBeLessThan(600)
  }, 300_000)

  it('finds the build-up leading into the drop', async () => {
    await client.start()
    const result = await client.request<BeatResult>('audio.beats', {
      path: dropTrack,
      ffmpeg: FFMPEG
    })
    expect(result.buildups.length).toBeGreaterThan(0)
    // A riser has to END on the drop to work, so that edge is the one that matters.
    expect(Math.abs(result.buildups[0].endMs - 16_000)).toBeLessThan(600)
    expect(result.buildups[0].startMs).toBeLessThan(result.buildups[0].endMs)
  }, 300_000)

  it('finds no drop in music that has no structure', async () => {
    await client.start()
    const result = await client.request<BeatResult>('audio.beats', {
      path: offsetBars,
      ffmpeg: FFMPEG
    })
    // A uniform bar pattern has nothing to find; inventing one would place
    // transitions and SFX at meaningless moments.
    expect(result.drops).toEqual([])
  }, 300_000)

  it('returns an energy tier per beat', async () => {
    await client.start()
    const result = await client.request<BeatResult>('audio.beats', {
      path: dropTrack,
      ffmpeg: FFMPEG
    })
    expect(result.tiers).toHaveLength(result.beats.length)
    expect(Math.max(...result.tiers)).toBeGreaterThan(Math.min(...result.tiers))
  }, 300_000)

  it('reports a missing file as an error rather than hanging', async () => {
    await client.start()
    await expect(
      client.request('audio.beats', { path: '/no/such.wav', ffmpeg: FFMPEG })
    ).rejects.toThrow()
  }, 120_000)
})

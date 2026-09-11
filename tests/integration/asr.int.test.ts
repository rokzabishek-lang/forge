import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { SidecarClient } from '../../src/main/sidecar/client'
import { SIDECAR_METHODS, RPC_ERRORS } from '@shared/sidecar/protocol'
import { segmentIntoSentences, type Word } from '@shared/transcript'

const SIDECAR_DIR = resolve(__dirname, '../../sidecar')
const VENV_PYTHON = join(SIDECAR_DIR, '.venv/bin/python')
const MODELS_DIR = process.env.FORGE_MODELS_DIR ?? join(tmpdir(), 'forge-models')
const FIXTURE = join(process.env.TMPDIR ?? tmpdir(), 'asr-check/jfk.flac')

// ASR needs the venv, a downloaded model, and the audio fixture. Skip rather
// than fail when any is absent, so the suite still runs on a clean checkout.
const ready = existsSync(VENV_PYTHON) && existsSync(FIXTURE)
const maybe = ready ? describe : describe.skip

let client: SidecarClient

beforeAll(() => {
  client = new SidecarClient({
    cwd: SIDECAR_DIR,
    python: VENV_PYTHON,
    modelsDir: MODELS_DIR,
    maxRestarts: 0
  })
})

afterAll(() => client?.stop())

interface TranscribeResult {
  language: string
  durationMs: number
  model: string
  words: Word[]
}

maybe('asr.transcribe', () => {
  it('advertises the capability once faster-whisper is installed', async () => {
    const hello = await client.start()
    expect(hello.capabilities).toContain(SIDECAR_METHODS.transcribe)
    expect(hello.degraded[SIDECAR_METHODS.transcribe]).toBeUndefined()
  }, 120_000)

  it('transcribes speech with word-level timestamps', async () => {
    await client.start()
    const progress: (number | null)[] = []

    const result = await client.request<TranscribeResult>(
      SIDECAR_METHODS.transcribe,
      { path: FIXTURE, model: 'tiny', language: 'en' },
      { onProgress: (p) => progress.push(p) }
    )

    expect(result.language).toBe('en')
    expect(result.model).toContain('faster-whisper')
    expect(result.words.length).toBeGreaterThan(15)

    const text = result.words.map((w) => w.text).join(' ').toLowerCase()
    expect(text).toContain('ask not what your country')

    // Indices must be dense and ordered — the director references them.
    expect(result.words.map((w) => w.index)).toEqual(result.words.map((_, i) => i))

    // Timings must be sane and non-overlapping.
    for (const word of result.words) {
      expect(word.endMs).toBeGreaterThan(word.startMs)
      expect(word.startMs).toBeGreaterThanOrEqual(0)
      expect(word.endMs).toBeLessThanOrEqual(result.durationMs + 2000)
    }
    for (let i = 1; i < result.words.length; i++) {
      expect(result.words[i].startMs).toBeGreaterThanOrEqual(result.words[i - 1].startMs)
    }

    expect(progress.length).toBeGreaterThan(0)
    expect(progress.at(-1)).toBe(1)
  }, 300_000)

  it('segments the real transcript into referenceable boundaries', async () => {
    await client.start()
    const result = await client.request<TranscribeResult>(
      SIDECAR_METHODS.transcribe,
      { path: FIXTURE, model: 'tiny', language: 'en' }
    )
    const segments = segmentIntoSentences(result.words)

    expect(segments.length).toBeGreaterThan(0)
    // Every segment boundary must land on a real word edge, never mid-word.
    const starts = new Set(result.words.map((w) => w.startMs))
    const ends = new Set(result.words.map((w) => w.endMs))
    for (const segment of segments) {
      expect(starts.has(segment.startMs)).toBe(true)
      expect(ends.has(segment.endMs)).toBe(true)
    }
  }, 300_000)

  it('reports a missing file as an error rather than hanging', async () => {
    await client.start()
    await expect(
      client.request(SIDECAR_METHODS.transcribe, { path: '/no/such/file.wav' })
    ).rejects.toMatchObject({ code: RPC_ERRORS.internalError })
  }, 120_000)
})

import { createHash } from 'node:crypto'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import {
  DEFAULT_HOSTED,
  chooseProvider,
  clampSpeed,
  hostedReady,
  speechKey,
  redactKey,
  speechUrl,
  type HostedConfig,
  type ProviderChoice,
  type ProviderStatus,
  type SpeakRequest,
  type SpeakResult,
  type VoiceOption
} from '@shared/voice/provider'
import { getSidecar } from './sidecar/service'
import { getSettings } from './store'

/**
 * The two voice providers, behind one door.
 *
 * The contract and the decisions are in shared/voice/provider.ts, where they
 * are pure and tested. This is the part that actually talks to things: the
 * sidecar for Kokoro, the network for a hosted endpoint, the disk for the cache
 * they share.
 *
 * Both return the same thing — a wav on disk — so everything upstream imports
 * an ordinary asset and never learns which one answered.
 */

const HOSTED_TIMEOUT_MS = 120_000

function cacheDir(): string {
  return join(app.getPath('userData'), 'voice')
}

function hostedConfig(): HostedConfig {
  const settings = getSettings()
  return { ...DEFAULT_HOSTED, ...(settings.voiceHosted ?? {}) }
}

async function exists(path: string): Promise<number | null> {
  try {
    const info = await stat(path)
    return info.size > 0 ? info.size : null
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ status */

/**
 * What each provider can currently do.
 *
 * The local one is only ready when the sidecar says the capability registered —
 * it degrades rather than failing when kokoro-onnx or the model files are
 * missing, and the reason it gives is the one worth showing the user.
 */
export async function voiceStatus(): Promise<ProviderStatus[]> {
  let localReady = false
  let localReason: string | null = 'The sidecar is not running'
  try {
    // `start` returns the handshake it already has when the sidecar is up, so
    // this is a read rather than a launch on the common path.
    const hello = await getSidecar().start()
    localReady = hello.capabilities.includes('voice.speak')
    localReason = localReady ? null : hello.degraded['voice.speak'] ?? 'Not installed'
  } catch (err) {
    localReason = err instanceof Error ? err.message : String(err)
  }

  const hosted = hostedConfig()
  return [
    {
      id: 'kokoro',
      label: 'Kokoro (on this machine)',
      kind: 'local',
      ready: localReady,
      reason: localReason
    },
    {
      id: 'hosted',
      label: 'Hosted API',
      kind: 'hosted',
      ready: hostedReady(hosted),
      // Deliberately not "invalid key": nothing has been tried yet, and saying
      // a key is wrong before using it is how a typo turns into a bug report.
      reason: hostedReady(hosted) ? null : 'Add the endpoint and your key in settings'
    }
  ]
}

/** The voices on offer, for whichever provider is going to run. */
export async function voiceOptions(choice: ProviderChoice): Promise<VoiceOption[]> {
  const picked = chooseProvider(choice, await voiceStatus())
  if ('error' in picked) return []
  if (picked.id === 'hosted') {
    /*
     * A hosted endpoint's voice list is not part of the shape we rely on —
     * OpenAI has no endpoint for it and the compatible servers disagree. The
     * configured name is the honest answer: it is the one that will be used.
     */
    const hosted = hostedConfig()
    return [{ id: hosted.voice, label: hosted.voice, language: 'unknown' }]
  }
  const result = await getSidecar().request<{ voices: VoiceOption[] }>('voice.voices', {})
  return result.voices
}

/* ------------------------------------------------------------------ speak */

export async function speak(request: SpeakRequest): Promise<SpeakResult> {
  const text = request.text.trim()
  if (!text) throw new Error('There is nothing to say')

  const choice: ProviderChoice = request.provider ?? getSettings().voiceProvider ?? 'auto'
  const picked = chooseProvider(choice, await voiceStatus())
  if ('error' in picked) throw new Error(picked.error)

  const speed = clampSpeed(request.speed)
  const hosted = hostedConfig()
  const voice = request.voice ?? (picked.id === 'hosted' ? hosted.voice : 'af_heart')

  const key = createHash('sha1')
    .update(speechKey(picked.id, voice, speed, text))
    .digest('hex')
    .slice(0, 16)
  const directory = cacheDir()
  const out = join(directory, `${key}.wav`)

  // Narration gets rebuilt constantly while the wording is being fiddled with,
  // and every rebuild is seconds of synthesis or somebody's credits.
  if (await exists(out)) {
    return { path: out, durationMs: await durationOf(out), provider: picked.id, voice, cached: true }
  }

  await mkdir(directory, { recursive: true })

  if (picked.id === 'kokoro') {
    const result = await getSidecar().request<{ path: string; durationMs: number }>(
      'voice.speak',
      { text, voice, speed, out },
      { timeoutMs: 300_000 }
    )
    return { path: result.path, durationMs: result.durationMs, provider: 'kokoro', voice, cached: false }
  }

  await speakHosted(text, voice, speed, hosted, out)
  return { path: out, durationMs: await durationOf(out), provider: 'hosted', voice, cached: false }
}

/**
 * A hosted endpoint shaped like OpenAI's /v1/audio/speech.
 *
 * Singled out because it is not only OpenAI's: Kokoro-FastAPI and most
 * self-hosted servers speak it too, so the same request reaches a cloud voice
 * or a model running on the next machine along.
 */
async function speakHosted(
  text: string,
  voice: string,
  speed: number,
  config: HostedConfig,
  out: string
): Promise<void> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), HOSTED_TIMEOUT_MS)

  try {
    const response = await fetch(speechUrl(config.baseUrl), {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`
      },
      body: JSON.stringify({
        model: config.model || 'tts-1',
        voice,
        input: text,
        speed,
        // wav rather than mp3: it imports without a decode and joins without a
        // re-encode, and narration is usually a handful of sentences.
        response_format: 'wav'
      })
    })

    if (!response.ok) {
      /*
       * The body often explains the problem — a bad model name, a quota — and
       * it is worth showing. It is also the one place a key could be echoed
       * back, so it is truncated and scanned before it reaches the user.
       */
      const detail = await response.text().catch(() => '')
      throw new Error(
        `The voice endpoint returned ${response.status}. ${redactKey(detail, config.apiKey)}`.trim()
      )
    }

    const audio = Buffer.from(await response.arrayBuffer())
    if (audio.byteLength === 0) throw new Error('The voice endpoint returned no audio')
    await writeFile(out, audio)
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('The voice endpoint did not answer in time')
    }
    throw new Error(redactKey(err instanceof Error ? err.message : String(err), config.apiKey))
  } finally {
    clearTimeout(timer)
  }
}

/**
 * How long a wav is, read from its own header.
 *
 * Cheaper than spawning ffprobe for a file this process just wrote, and it is
 * the only format either provider produces.
 */
async function durationOf(path: string): Promise<number> {
  const { open } = await import('node:fs/promises')
  const handle = await open(path, 'r')
  try {
    const header = Buffer.alloc(44)
    await handle.read(header, 0, 44, 0)
    if (header.toString('ascii', 0, 4) !== 'RIFF') return 0
    const byteRate = header.readUInt32LE(28)
    const size = (await handle.stat()).size - 44
    return byteRate > 0 ? Math.round((size / byteRate) * 1000) : 0
  } catch {
    return 0
  } finally {
    await handle.close()
  }
}

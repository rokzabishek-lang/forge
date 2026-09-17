/**
 * Speech, from whichever engine the user has.
 *
 * Sheet ⑦ wants a narration video: a topic in, a spoken track out. The voice is
 * the part of that with a real choice behind it — a model on this machine, or
 * somebody's API — and the choice is not ours to make. A wedding photographer
 * on a plane wants the local one; someone who wants a specific hosted voice
 * wants theirs; and either should be able to change their mind without the rest
 * of the app noticing.
 *
 * So speech is a PROVIDER, and everything above it speaks to the contract in
 * this file rather than to an engine. Two ship:
 *
 *   kokoro    Kokoro-82M through ONNX Runtime, in the sidecar. No network, no
 *             key, no per-use cost — which is what "fully local" has always
 *             meant here. It reuses the runtime the depth model already brought,
 *             so it costs a model file rather than a stack.
 *
 *   hosted    Any endpoint shaped like OpenAI's /v1/audio/speech, with the base
 *             URL, model and key supplied by the user. That shape is worth
 *             singling out because it is not only OpenAI's: Kokoro-FastAPI
 *             serves the SAME model over it. So "ours or theirs" is not even a
 *             fork in the road — the same voice can arrive either way, and the
 *             setting is about where the compute happens.
 *
 * This module is the contract and the arithmetic around it. It has no network,
 * no filesystem and no ONNX in it, so the part that decides what happens is
 * testable without any of them being installed.
 */

export type ProviderId = 'kokoro' | 'hosted'

/** What the user picked. `auto` means "whichever is actually usable". */
export type ProviderChoice = ProviderId | 'auto'

export interface VoiceOption {
  id: string
  label: string
  /** BCP-47ish, as the engine reports it. */
  language: string
}

export interface HostedConfig {
  /** Base URL, without the path. Empty means not configured. */
  baseUrl: string
  model: string
  voice: string
  /**
   * The user's key for the user's own account.
   *
   * Held in the app's settings file like any other preference and sent only to
   * the endpoint the user named. It is never logged, never included in an error
   * message, and never leaves the main process.
   */
  apiKey: string
}

export const DEFAULT_HOSTED: HostedConfig = {
  baseUrl: '',
  model: 'tts-1',
  voice: 'alloy',
  apiKey: ''
}

export interface SpeakRequest {
  text: string
  /** Engine-specific voice id. Falls back to the provider's own default. */
  voice?: string
  /** 0.5 to 2. 1 is the engine's natural pace. */
  speed?: number
  /** Overrides the configured choice for one call. */
  provider?: ProviderChoice
}

export interface SpeakResult {
  /** A wav on disk, ready to import as an ordinary asset. */
  path: string
  durationMs: number
  provider: ProviderId
  voice: string
  /** True when the same text and voice had already been spoken. */
  cached: boolean
}

/** What a provider says about itself, for the picker and for `auto`. */
export interface ProviderStatus {
  id: ProviderId
  label: string
  kind: 'local' | 'hosted'
  ready: boolean
  /** Why not, when `ready` is false. Shown to the user, so no jargon. */
  reason: string | null
}

export const MIN_SPEED = 0.5
export const MAX_SPEED = 2

export function clampSpeed(speed: number | undefined): number {
  if (typeof speed !== 'number' || !Number.isFinite(speed)) return 1
  return Math.min(MAX_SPEED, Math.max(MIN_SPEED, speed))
}

/**
 * Is a hosted endpoint configured enough to try?
 *
 * A base URL and a key. The model and voice both have defaults that work on
 * every implementation of this shape, so demanding them would be inventing a
 * requirement the endpoint does not have.
 */
export function hostedReady(config: HostedConfig | undefined): boolean {
  if (!config) return false
  return config.baseUrl.trim().length > 0 && config.apiKey.trim().length > 0
}

/**
 * The endpoint to POST to.
 *
 * Trailing slashes are the entire reason this is a function. Users paste
 * `https://api.example.com/v1`, `https://api.example.com/v1/`, and
 * occasionally the full `.../v1/audio/speech` — and two of those three produce
 * a URL with a double slash or a doubled path, which fails with something
 * unhelpful about a 404.
 */
export function speechUrl(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '')
  if (base.endsWith('/audio/speech')) return base
  return `${base}/audio/speech`
}

/**
 * Which provider actually runs, given what the user asked for and what works.
 *
 * `auto` prefers the local one. Not because it is better — it is a small model
 * and a hosted voice may well beat it — but because it is the one that costs
 * nothing per use and works on a train, and a default that quietly starts
 * spending someone's credits is a bad default however good it sounds.
 *
 * An explicit choice is honoured even when the other is available: a user who
 * picked hosted gets hosted or gets an error, not a silent substitution in a
 * different voice. The only thing `auto` is allowed to do is fall back.
 */
export function chooseProvider(
  choice: ProviderChoice,
  available: ProviderStatus[]
): { id: ProviderId } | { error: string } {
  const byId = (id: ProviderId): ProviderStatus | undefined =>
    available.find((p) => p.id === id)

  if (choice !== 'auto') {
    const picked = byId(choice)
    if (!picked) return { error: `There is no ${choice} voice provider` }
    if (!picked.ready) return { error: picked.reason ?? `${picked.label} is not ready` }
    return { id: picked.id }
  }

  const local = byId('kokoro')
  if (local?.ready) return { id: 'kokoro' }
  const hosted = byId('hosted')
  if (hosted?.ready) return { id: 'hosted' }

  /*
   * Both unavailable. Report BOTH reasons rather than the first: "Kokoro is not
   * installed" on its own sends someone off to install it when they had meant
   * to use their API all along and simply had not pasted the key in yet.
   */
  const reasons = [local, hosted]
    .filter((p): p is ProviderStatus => Boolean(p))
    .map((p) => `${p.label}: ${p.reason ?? 'not ready'}`)
  return {
    error: reasons.length > 0 ? `No voice available. ${reasons.join('. ')}` : 'No voice available'
  }
}

/**
 * Strip the user's key out of anything on its way to a screen or a log.
 *
 * A surprising number of APIs quote the request back in their 4xx bodies, and
 * the body is worth showing — it is where "that model does not exist" and "you
 * are out of quota" live. So the body is shown and the key is taken out of it,
 * rather than the whole thing being swallowed to be safe.
 *
 * Pure, and here rather than beside the fetch, so it can be tested without a
 * network or an electron process.
 */
export function redactKey(message: string, apiKey: string): string {
  const short = message.length > 400 ? `${message.slice(0, 400)}…` : message
  const key = apiKey.trim()
  // A very short "key" is either empty or a placeholder, and splitting on it
  // would shred unrelated text.
  if (key.length < 8) return short
  return short.split(key).join('***')
}

/**
 * A stable key for a piece of speech.
 *
 * Synthesis is seconds of work and narration gets rebuilt constantly while the
 * wording is being fiddled with, so the same sentence in the same voice should
 * be spoken once. Everything that changes the audio is in the key and nothing
 * else is — notably not the provider CHOICE, only the provider that actually
 * ran, so switching from `auto` to `kokoro` does not invalidate a cache that
 * was already Kokoro's.
 */
export function speechKey(
  provider: ProviderId,
  voice: string,
  speed: number,
  text: string
): string {
  // NUL, written as an escape rather than embedded: a raw control byte in a
  // source file is invisible to review and survives no reformat. It is the
  // separator because text is user input and can contain every printable one.
  return [provider, voice, clampSpeed(speed).toFixed(2), text.trim()].join('\u0000')
}

/**
 * Split narration into pieces an engine will actually read well.
 *
 * Every TTS model degrades on long input — Kokoro's context is short enough
 * that a paragraph comes back with the end clipped or the prosody drifting, and
 * hosted endpoints tend to have a hard character limit that returns an error
 * rather than a shorter take. Splitting on sentences keeps each request inside
 * both, and sentence boundaries are where a voice would draw breath anyway, so
 * the joins land where the ear expects a pause.
 */
export function splitForSpeech(text: string, limit = 400): string[] {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (!clean) return []
  if (clean.length <= limit) return [clean]

  // Keep the punctuation: it is what the engine reads the intonation from.
  const sentences = clean.match(/[^.!?…]+[.!?…]*\s*/g) ?? [clean]
  const out: string[] = []
  let current = ''

  for (const raw of sentences) {
    const sentence = raw.trim()
    if (!sentence) continue
    if (sentence.length > limit) {
      // A sentence longer than the limit on its own: break it at commas, then
      // at spaces. Better a slightly odd pause than a truncated one.
      if (current) {
        out.push(current)
        current = ''
      }
      out.push(...breakLong(sentence, limit))
      continue
    }
    if (current && current.length + sentence.length + 1 > limit) {
      out.push(current)
      current = sentence
    } else {
      current = current ? `${current} ${sentence}` : sentence
    }
  }
  if (current) out.push(current)
  return out
}

function breakLong(sentence: string, limit: number): string[] {
  const parts: string[] = []
  let rest = sentence
  while (rest.length > limit) {
    const window = rest.slice(0, limit)
    const at = Math.max(window.lastIndexOf(', '), window.lastIndexOf('; '))
    const cut = at > limit * 0.4 ? at + 1 : window.lastIndexOf(' ')
    const take = cut > 0 ? cut : limit
    parts.push(rest.slice(0, take).trim())
    rest = rest.slice(take).trim()
  }
  if (rest) parts.push(rest)
  return parts
}

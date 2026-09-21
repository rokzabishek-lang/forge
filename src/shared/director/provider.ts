/**
 * A language model, from whichever engine the user has.
 *
 * Same shape as speech (`src/shared/voice/provider.ts`), for the same reason:
 * the choice between a model on this machine and somebody's API is not ours to
 * make, and either side should be swappable without the rest of the app
 * noticing. Two ship:
 *
 *   ollama    Whatever Ollama is serving on this machine — Gemma 4, Qwen 3.5,
 *             anything with a chat template. No key, no per-use cost, which is
 *             what "fully local" has always meant here. Ollama is an external
 *             install rather than a bundled binary: the user already has it,
 *             it runs on both platforms, and its `format` field constrains the
 *             output to our schema at the decoder — the primitive the whole
 *             plan architecture rests on (docs/LLM.md, docs/DIRECTOR.md §4).
 *
 *   gemini    Google's API, with the user's own key. The hosted tier sees the
 *             frames themselves where the local tier gets text.
 *
 * This module is the contract and the arithmetic around it — no network, no
 * filesystem — so the decisions are testable without either engine installed.
 * The part that talks to things is `src/main/director.ts`.
 */

import { redactKey } from '../voice/provider'

export { redactKey }

export type LlmProviderId = 'ollama' | 'gemini'

/** What the user picked. `auto` means "whichever is actually usable". */
export type LlmProviderChoice = LlmProviderId | 'auto'

export interface OllamaConfig {
  /** Base URL of the Ollama server, without the `/api` path. */
  baseUrl: string
  /** A model tag Ollama has pulled, e.g. `gemma4:e2b`. Empty means not chosen. */
  model: string
}

export interface GeminiConfig {
  /**
   * The user's key for the user's own account.
   *
   * Held in the app's settings file, sent only to Google's endpoint, never
   * logged, never in an error message, and never returned to the renderer —
   * `publicConfig` is what crosses the bridge.
   */
  apiKey: string
  model: string
}

export interface DirectorConfig {
  provider: LlmProviderChoice
  ollama: OllamaConfig
  gemini: GeminiConfig
}

export const DEFAULT_OLLAMA: OllamaConfig = { baseUrl: 'http://127.0.0.1:11434', model: '' }

/*
 * The model name is a guess until a live call has confirmed it, and the
 * settings UI lets the user type over it. A wrong name fails loudly with the
 * endpoint's own "model not found", which is a better failure than a wrong
 * default that quietly works worse.
 */
export const DEFAULT_GEMINI: GeminiConfig = { apiKey: '', model: 'gemini-2.5-flash' }

export const DEFAULT_DIRECTOR: DirectorConfig = {
  provider: 'auto',
  ollama: DEFAULT_OLLAMA,
  gemini: DEFAULT_GEMINI
}

/** The config as the renderer may see it: the key replaced by whether there is one. */
export interface PublicDirectorConfig {
  provider: LlmProviderChoice
  ollama: OllamaConfig
  gemini: { model: string; hasKey: boolean }
}

export function publicConfig(config: DirectorConfig): PublicDirectorConfig {
  return {
    provider: config.provider,
    ollama: { ...config.ollama },
    gemini: { model: config.gemini.model, hasKey: config.gemini.apiKey.trim().length > 0 }
  }
}

/** What a provider says about itself, for the picker and for `auto`. */
export interface LlmStatus {
  id: LlmProviderId
  label: string
  kind: 'local' | 'hosted'
  ready: boolean
  /** Why not, when `ready` is false. Shown to the user, so no jargon. */
  reason: string | null
  /** The models the local server has pulled, when it answered. */
  models?: string[]
}

/** One structured completion: a system prompt, a user prompt, and the shape the answer must take. */
export interface CompletionRequest {
  system: string
  user: string
  /** A flat JSON schema (see conforms.ts). Sent to the decoder as its grammar. */
  schema: object
  /** Absolute paths of images to show the model, when it can see. */
  images?: string[]
  maxTokens?: number
  /** Overrides the configured choice for one call. */
  provider?: LlmProviderChoice
}

export interface CompletionResult {
  /** The raw text the model produced — parse it with `parseModelJson`. */
  text: string
  provider: LlmProviderId
  model: string
  promptTokens: number | null
  outputTokens: number | null
  durationMs: number
  /**
   * The decoder stopped at its token cap rather than at the end of the
   * answer. The text is almost certainly an unfinished object, and the user
   * should hear "ran out of room", not "does not parse".
   */
  truncated: boolean
}

/**
 * Is a chosen model among the ones a server has pulled?
 *
 * Ollama names every model with a tag and fills in `:latest` when none is
 * given, so a user who typed `gemma4` and a server that lists `gemma4:latest`
 * are talking about the same thing — and an exact comparison would tell them
 * to pull a model they already have.
 */
export function hasModel(models: string[], chosen: string): boolean {
  const want = chosen.trim()
  if (!want) return false
  const tagged = want.includes(':') ? want : `${want}:latest`
  return models.some((m) => m === want || m === tagged)
}

/** How long a plan may take. Prefill on a CPU-only laptop is seconds, not minutes; three minutes is generous. */
export const COMPLETION_TIMEOUT_MS = 180_000
/** How long to wait for the local server to say it exists. */
export const STATUS_TIMEOUT_MS = 1_500
/** Longest answer a spine plan can need, with headroom. */
export const DEFAULT_MAX_TOKENS = 450

export function geminiReady(config: GeminiConfig | undefined): boolean {
  return Boolean(config && config.apiKey.trim().length > 0)
}

/**
 * The Ollama base with its path normalised.
 *
 * Users paste `http://localhost:11434`, `http://localhost:11434/`, and
 * sometimes the full `/api/chat` — as with the voice endpoint, two of those
 * three produce a doubled path and an unhelpful 404.
 */
function ollamaBase(baseUrl: string): string {
  const trimmed = (baseUrl.trim() || DEFAULT_OLLAMA.baseUrl).replace(/\/+$/, '')
  return trimmed.replace(/\/api(\/(chat|tags|generate))?$/, '')
}

export function ollamaChatUrl(baseUrl: string): string {
  return `${ollamaBase(baseUrl)}/api/chat`
}

export function ollamaTagsUrl(baseUrl: string): string {
  return `${ollamaBase(baseUrl)}/api/tags`
}

/**
 * Which provider actually runs, given what the user asked for and what works.
 *
 * `auto` prefers the local one — not because it is better but because it is
 * the one that costs nothing per use, and a default that quietly starts
 * spending someone's credits is a bad default however good it sounds. An
 * explicit choice is honoured or fails; the only thing `auto` may do is fall
 * back. Same rule as speech, same reasoning.
 */
export function chooseProvider(
  choice: LlmProviderChoice,
  available: LlmStatus[]
): { id: LlmProviderId } | { error: string } {
  const byId = (id: LlmProviderId): LlmStatus | undefined => available.find((p) => p.id === id)

  if (choice !== 'auto') {
    const picked = byId(choice)
    if (!picked) return { error: `There is no ${choice} model provider` }
    if (!picked.ready) return { error: picked.reason ?? `${picked.label} is not ready` }
    return { id: picked.id }
  }

  const local = byId('ollama')
  if (local?.ready) return { id: 'ollama' }
  const hosted = byId('gemini')
  if (hosted?.ready) return { id: 'gemini' }

  // Both unavailable: report both reasons, so someone who meant to use their
  // key is not sent off to install Ollama.
  const reasons = [local, hosted]
    .filter((p): p is LlmStatus => Boolean(p))
    .map((p) => `${p.label}: ${p.reason ?? 'not ready'}`)
  return {
    error: reasons.length > 0 ? `No model available. ${reasons.join('. ')}` : 'No model available'
  }
}

/**
 * The model to preselect from what a server has pulled.
 *
 * Never an embedding model — `nomic-embed-text` cannot chat, and "the first
 * one in the list" picked it on the very machine this was written on. The
 * order is the order these were measured or designed for, newest first.
 */
const PREFERRED = [/^gemma4\b/, /^qwen3\.5\b/, /^gemma3n\b/, /^gemma3\b/, /^qwen3\b/, /^llama3\.2\b/]
const NOT_A_CHAT_MODEL = /embed|rerank|whisper|clip/i

export function suggestModel(models: string[]): string | null {
  const chat = models.filter((m) => !NOT_A_CHAT_MODEL.test(m))
  for (const pattern of PREFERRED) {
    const hit = chat.find((m) => pattern.test(m))
    if (hit) return hit
  }
  return chat[0] ?? null
}

/**
 * The JSON object in a model's answer.
 *
 * With `format` set, Ollama returns bare JSON. Hosted models, and any local one
 * a user points at without grammar support, wrap it in a code fence or lead
 * with a sentence — so this takes the fence off and cuts from the first `{`
 * to the last `}` rather than trusting the answer to start with a brace. It
 * must never depend on the provider behaving, because the provider is the
 * user's choice.
 */
export function parseModelJson(text: string): { value: unknown } | { error: string } {
  let body = text.trim()
  const fence = body.match(/^```[a-z]*\s*([\s\S]*?)\s*```/i)
  if (fence) body = fence[1].trim()

  const first = body.indexOf('{')
  if (first === -1) return { error: 'The model returned no JSON object' }
  const last = body.lastIndexOf('}')
  /*
   * An opening brace with no closing one is not "no object" — it is the
   * common failure, an answer cut off at the token cap, and the message
   * should say so rather than send someone looking for a model that refused.
   */
  const cutOff = last < first
  const candidate = cutOff ? body.slice(first) : body.slice(first, last + 1)

  try {
    return { value: JSON.parse(candidate) as unknown }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    const hint = cutOff ? ' — the answer has no closing brace, so it was probably cut off' : ''
    return { error: `The model returned JSON that does not parse${hint}: ${detail}` }
  }
}

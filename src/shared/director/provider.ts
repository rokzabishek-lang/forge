/**
 * A language model, from whichever engine the user has.
 *
 * Same shape as speech (`src/shared/voice/provider.ts`), for the same reason:
 * the choice between a model on this machine and somebody's API is not ours to
 * make, and either side should be swappable without the rest of the app
 * noticing. Two ship, and they are two API SHAPES rather than two vendors:
 *
 *   ollama    Ollama's own API. Singled out because its `format` field takes
 *             a JSON schema and constrains decoding to it at the server —
 *             the primitive the whole plan architecture rests on
 *             (docs/LLM.md, docs/DIRECTOR.md §4) — and because its
 *             OpenAI-compatible endpoint does NOT honour a schema.
 *
 *   openai    Anything shaped like OpenAI's /v1/chat/completions, with the
 *             base URL, model and (optional) key supplied by the user. That
 *             shape is worth singling out because it is not only OpenAI's:
 *             LM Studio serves it on this machine at :1234, llama.cpp's
 *             `llama-server` serves it, and Gemini serves it behind a
 *             compatibility URL. So "local or hosted" is not a fork in the
 *             code — the same request reaches a model in LM Studio or a
 *             frontier model with a key, and the setting is about where the
 *             compute happens. Whether an endpoint is local is read off its
 *             address (`isLoopback`), because `auto` prefers the one that
 *             costs nothing per use.
 *
 * This module is the contract and the arithmetic around it — no network, no
 * filesystem — so the decisions are testable without either engine installed.
 * The part that talks to things is `src/main/director.ts`.
 */

import { redactKey } from '../voice/provider'

export { redactKey }

export type LlmProviderId = 'ollama' | 'openai'

/** What the user picked. `auto` means "whichever is actually usable". */
export type LlmProviderChoice = LlmProviderId | 'auto'

export interface OllamaConfig {
  /** Base URL of the Ollama server, without the `/api` path. */
  baseUrl: string
  /** A model tag Ollama has pulled, e.g. `gemma4:e2b`. Empty means not chosen. */
  model: string
}

export interface OpenAiConfig {
  /** Base URL including the version path, e.g. `http://127.0.0.1:1234/v1`. */
  baseUrl: string
  /** A model id the server lists, e.g. `google/gemma-4-e2b`. Empty means not chosen. */
  model: string
  /**
   * The user's key for the user's own account, when the endpoint wants one.
   *
   * A local server needs none. Held in the app's settings file, sent only to
   * the endpoint named here, never logged, never in an error message, and
   * never returned to the renderer — `publicConfig` is what crosses the
   * bridge.
   */
  apiKey: string
}

export interface DirectorConfig {
  provider: LlmProviderChoice
  ollama: OllamaConfig
  openai: OpenAiConfig
}

export const DEFAULT_OLLAMA: OllamaConfig = { baseUrl: 'http://127.0.0.1:11434', model: '' }

/** LM Studio's default server address, which is where a local OpenAI shape most often lives. */
export const DEFAULT_OPENAI: OpenAiConfig = { baseUrl: 'http://127.0.0.1:1234/v1', model: '', apiKey: '' }

export const DEFAULT_DIRECTOR: DirectorConfig = {
  provider: 'auto',
  ollama: DEFAULT_OLLAMA,
  openai: DEFAULT_OPENAI
}

/** The config as the renderer may see it: the key replaced by whether there is one. */
export interface PublicDirectorConfig {
  provider: LlmProviderChoice
  ollama: OllamaConfig
  openai: { baseUrl: string; model: string; hasKey: boolean }
}

export function publicConfig(config: DirectorConfig): PublicDirectorConfig {
  return {
    provider: config.provider,
    ollama: { ...config.ollama },
    openai: {
      baseUrl: config.openai.baseUrl,
      model: config.openai.model,
      hasKey: config.openai.apiKey.trim().length > 0
    }
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
  /** The models the server offers, when it answered. */
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
  /**
   * Whether a thinking model may think before it answers.
   *
   * Off by default: a trace costs seconds on CPU and the schema has its own
   * `reasoning` field. But Ollama has an open bug where `think: false` makes
   * it drop `format` for Gemma 4 and Qwen 3.5, so the caller may turn this on
   * for a second try when the first answer came back as prose.
   */
  think?: boolean
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

/** How long a plan may take. Prefill on a CPU-only laptop is seconds, not minutes; three minutes is generous. */
export const COMPLETION_TIMEOUT_MS = 180_000
/** How long to wait for a server to say it exists. */
export const STATUS_TIMEOUT_MS = 1_500
/**
 * Longest answer a plan can need when the caller gives no better number.
 *
 * Twelve segments at ~90 tokens each plus the wrapper. A flat 450 — the first
 * figure here — could not hold the schema's own `maxItems`, so long plans
 * were cut off at segment five and fell to the baseline every time.
 */
export const DEFAULT_MAX_TOKENS = 1_350

/* ------------------------------------------------------------------ urls */

/** Does this address point at this machine? */
export function isLoopback(baseUrl: string): boolean {
  try {
    const host = new URL(withScheme(baseUrl)).hostname.replace(/^\[|\]$/g, '')
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0'
  } catch {
    return false
  }
}

function withScheme(url: string): string {
  const trimmed = url.trim()
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
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
  return withScheme(trimmed).replace(/\/api(\/(chat|tags|generate|show|version))?$/, '')
}

export function ollamaChatUrl(baseUrl: string): string {
  return `${ollamaBase(baseUrl)}/api/chat`
}

export function ollamaTagsUrl(baseUrl: string): string {
  return `${ollamaBase(baseUrl)}/api/tags`
}

/**
 * An OpenAI-shaped base with its path normalised.
 *
 * The convention for these servers is that the base INCLUDES the version
 * path — LM Studio shows `http://localhost:1234/v1`, Gemini's compatibility
 * URL ends in `/v1beta/openai` — so the path is kept and only the endpoint
 * name is appended. A bare host with no path gets `/v1`, since that is what
 * every local server means by it; a pasted full endpoint has the endpoint
 * taken back off.
 */
function openaiBase(baseUrl: string): string {
  const trimmed = withScheme(baseUrl.trim() || DEFAULT_OPENAI.baseUrl).replace(/\/+$/, '')
  const stripped = trimmed.replace(/\/(chat\/completions|models)$/, '')
  try {
    const url = new URL(stripped)
    if (url.pathname === '' || url.pathname === '/') return `${stripped}/v1`
  } catch {
    // Not a URL at all; the caller will get a fetch error naming it.
  }
  return stripped
}

export function openaiChatUrl(baseUrl: string): string {
  return `${openaiBase(baseUrl)}/chat/completions`
}

export function openaiModelsUrl(baseUrl: string): string {
  return `${openaiBase(baseUrl)}/models`
}

/**
 * Is an OpenAI-shaped endpoint configured enough to try?
 *
 * An address, and a key unless the address is this machine — LM Studio and
 * llama-server want none, and demanding one would be inventing a requirement
 * the server does not have. Whether it is actually RUNNING is main's question.
 */
export function openaiConfigured(config: OpenAiConfig | undefined): boolean {
  if (!config) return false
  if (config.baseUrl.trim().length === 0) return false
  return isLoopback(config.baseUrl) || config.apiKey.trim().length > 0
}

/* --------------------------------------------------------------- choosing */

/**
 * Which provider actually runs, given what the user asked for and what works.
 *
 * `auto` prefers the local one — not because it is better but because it is
 * the one that costs nothing per use, and a default that quietly starts
 * spending someone's credits is a bad default however good it sounds. Among
 * the two shapes, Ollama first (its schema support is the most direct), then
 * an OpenAI-shaped endpoint — local before hosted. An explicit choice is
 * honoured or fails; the only thing `auto` may do is fall back. Same rule as
 * speech, same reasoning.
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

  const ollama = byId('ollama')
  const openai = byId('openai')
  const local = [ollama, openai].filter((p): p is LlmStatus => Boolean(p && p.ready && p.kind === 'local'))
  if (local.length > 0) return { id: local[0].id }
  if (openai?.ready) return { id: 'openai' }

  // Nothing works: report every reason, so someone who meant to use their
  // key is not sent off to install Ollama.
  const reasons = [ollama, openai]
    .filter((p): p is LlmStatus => Boolean(p))
    .map((p) => `${p.label}: ${p.reason ?? 'not ready'}`)
  return {
    error: reasons.length > 0 ? `No model available. ${reasons.join('. ')}` : 'No model available'
  }
}

/**
 * The model to preselect from what a server offers.
 *
 * Never an embedding model — `nomic-embed-text` cannot chat, and "the first
 * one in the list" picked it on the very machine this was written on. The
 * order is the order these were measured or designed for, newest first.
 * Matches anywhere in the id, because LM Studio names models `google/gemma-4-e2b`.
 */
const PREFERRED = [/gemma-?4\b/i, /qwen-?3\.5\b/i, /gemma-?3n\b/i, /gemma-?3\b/i, /qwen-?3\b/i, /llama-?3\.2\b/i]
const NOT_A_CHAT_MODEL = /embed|rerank|whisper|clip|text-embedding/i

export function suggestModel(models: string[]): string | null {
  const chat = models.filter((m) => !NOT_A_CHAT_MODEL.test(m))
  for (const pattern of PREFERRED) {
    const hit = chat.find((m) => pattern.test(m))
    if (hit) return hit
  }
  return chat[0] ?? null
}

/**
 * Is a chosen model among the ones a server offers?
 *
 * Ollama names every model with a tag and fills in `:latest` when none is
 * given, so a user who typed `gemma4` and a server that lists `gemma4:latest`
 * are talking about the same thing — and an exact comparison would tell them
 * to pull a model they already have. Other servers use exact ids.
 */
export function hasModel(models: string[], chosen: string): boolean {
  const want = chosen.trim()
  if (!want) return false
  const tagged = want.includes(':') ? want : `${want}:latest`
  return models.some((m) => m === want || m === tagged)
}

/* ---------------------------------------------------------------- parsing */

/**
 * The JSON object in a model's answer.
 *
 * With a schema enforced, a server returns bare JSON. Models that think out
 * loud put the thought in `<think>` tags first; hosted models wrap the answer
 * in a code fence or lead with a sentence; and a local server a user points
 * at may do any of these. So the thought is removed, the fence taken off, and
 * the text cut from the first `{` to the last `}` rather than trusted to
 * start with a brace. It must never depend on the provider behaving, because
 * the provider is the user's choice.
 */
export function parseModelJson(text: string): { value: unknown } | { error: string } {
  let body = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
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

import sharp from 'sharp'
import {
  COMPLETION_TIMEOUT_MS,
  DEFAULT_DIRECTOR,
  DEFAULT_MAX_TOKENS,
  STATUS_TIMEOUT_MS,
  chooseProvider,
  geminiReady,
  hasModel,
  ollamaChatUrl,
  ollamaTagsUrl,
  publicConfig,
  suggestModel,
  type CompletionRequest,
  type CompletionResult,
  type DirectorConfig,
  type GeminiConfig,
  type LlmProviderChoice,
  type LlmStatus,
  type OllamaConfig,
  type PublicDirectorConfig
} from '@shared/director/provider'
import { getSettings, setSettings } from './store'

/**
 * The model providers, behind one door.
 *
 * The contract and the decisions are in shared/director/provider.ts, where
 * they are pure and tested. This is the part that talks to things: the Ollama
 * server on this machine over HTTP, and — next — Google's API with the user's
 * key. Both return the same thing, the model's text, and everything upstream
 * parses and validates it without learning which one answered.
 *
 * Nothing here knows what a plan IS. It sends a system prompt, a user prompt
 * and a schema, and hands the text back.
 */

/** Longest edge for a picture shown to the model. A card-sized photo, not a 12-megapixel one. */
const IMAGE_EDGE = 640

/* ----------------------------------------------------------------- config */

export function directorConfig(): DirectorConfig {
  const saved = getSettings().director
  return {
    provider: saved?.provider ?? DEFAULT_DIRECTOR.provider,
    ollama: { ...DEFAULT_DIRECTOR.ollama, ...(saved?.ollama ?? {}) },
    gemini: { ...DEFAULT_DIRECTOR.gemini, ...(saved?.gemini ?? {}) }
  }
}

/** The config as the renderer may see it — the key replaced by whether there is one. */
export function directorSettings(): PublicDirectorConfig {
  return publicConfig(directorConfig())
}

/**
 * Change part of the config.
 *
 * A patch carries only what changed, so the settings panel can save the model
 * without resending the key it never had. `gemini.apiKey: ''` is how the key
 * is cleared — a field that is absent keeps what is there.
 */
export function setDirectorSettings(patch: {
  provider?: LlmProviderChoice
  ollama?: Partial<OllamaConfig>
  gemini?: Partial<GeminiConfig>
}): PublicDirectorConfig {
  const current = directorConfig()
  const next: DirectorConfig = {
    provider: patch.provider ?? current.provider,
    ollama: { ...current.ollama, ...(patch.ollama ?? {}) },
    gemini: { ...current.gemini, ...(patch.gemini ?? {}) }
  }
  return publicConfig(setSettings({ director: next }).director ?? next)
}

/* ------------------------------------------------------------------ fetch */

/**
 * A fetch that gives up.
 *
 * Every call here is either to a local server that may not be running — where
 * the default is to hang on a connection that will never open — or to a model
 * that may take minutes. Both need a bound, and the message when it is hit
 * should say what was being waited for.
 */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  onTimeout: string
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw new Error(onTimeout)
    throw err
  } finally {
    clearTimeout(timer)
  }
}

/* ----------------------------------------------------------------- status */

/** What the local server has pulled. Throws when it is not there. */
export async function ollamaModels(config: OllamaConfig = directorConfig().ollama): Promise<string[]> {
  const response = await fetchWithTimeout(
    ollamaTagsUrl(config.baseUrl),
    {},
    STATUS_TIMEOUT_MS,
    'Ollama did not answer'
  )
  if (!response.ok) throw new Error(`Ollama returned ${response.status} when asked for its models`)
  const data = (await response.json()) as { models?: { name?: unknown }[] }
  return (data.models ?? [])
    .map((m) => m.name)
    .filter((name): name is string => typeof name === 'string')
}

/**
 * What each provider can currently do, and why not when it cannot.
 *
 * The local one is asked, not assumed: the server may be down, may have no
 * models, or may not have the one that was chosen — and each of those has a
 * different fix, so each gets its own sentence. The list of models rides
 * along for the picker.
 */
export async function directorStatus(): Promise<LlmStatus[]> {
  const config = directorConfig()

  let models: string[] | null = null
  let reason: string | null = null
  try {
    models = await ollamaModels(config.ollama)
  } catch {
    reason = 'Ollama is not running. Start it, or install it from ollama.com'
  }

  let ready = false
  if (models) {
    const chosen = config.ollama.model.trim()
    if (models.length === 0) {
      reason = 'Ollama has no models yet — pull one, for example `ollama pull gemma4:e2b`'
    } else if (!chosen) {
      const suggestion = suggestModel(models)
      reason = suggestion
        ? `Choose a model in the Director settings — ${suggestion} is on this machine`
        : 'Choose a model in the Director settings'
    } else if (!hasModel(models, chosen)) {
      reason = `${chosen} is not pulled — run \`ollama pull ${chosen}\``
    } else {
      ready = true
    }
  }

  return [
    {
      id: 'ollama',
      label: 'Ollama (on this machine)',
      kind: 'local',
      ready,
      reason: ready ? null : reason,
      ...(models ? { models } : {})
    },
    {
      id: 'gemini',
      label: 'Gemini API',
      kind: 'hosted',
      // Not wired yet, and status must say so rather than let `auto` pick a
      // provider that would then throw. Its REST shape is verified with a live
      // call before it ships, not assumed from a doc.
      ready: false,
      reason: geminiReady(config.gemini)
        ? 'Gemini directing is the next step — local models work today'
        : 'Add your Gemini key in the Director settings'
    }
  ]
}

/* --------------------------------------------------------------- complete */

export async function complete(request: CompletionRequest): Promise<CompletionResult> {
  const config = directorConfig()
  const choice: LlmProviderChoice = request.provider ?? config.provider
  const picked = chooseProvider(choice, await directorStatus())
  if ('error' in picked) throw new Error(picked.error)
  if (picked.id === 'gemini') throw new Error('Gemini directing is not wired yet')
  return completeOllama(request, config.ollama)
}

/**
 * Pictures for the model, as base64 JPEG.
 *
 * Downscaled first: a phone photograph is 12 megapixels and the model sees it
 * at a few hundred pixels a side, so the rest is upload and tokens spent on
 * detail nobody reads. `rotate()` with no argument honours the EXIF
 * orientation — a portrait shot would otherwise arrive on its side. A picture
 * that will not open costs the model that picture, not the plan.
 */
export async function encodeImages(paths: string[]): Promise<string[]> {
  const out: string[] = []
  for (const path of paths) {
    try {
      const buffer = await sharp(path)
        .rotate()
        .resize({ width: IMAGE_EDGE, height: IMAGE_EDGE, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 80 })
        .toBuffer()
      out.push(buffer.toString('base64'))
    } catch {
      // Skipped on purpose; see above.
    }
  }
  return out
}

/**
 * One structured completion from Ollama.
 *
 * `format` is the schema itself — the server constrains decoding to it, which
 * is the whole reason a plan can be trusted to have a shape (docs/DIRECTOR.md
 * §4). `think: false` because a reasoning trace costs seconds on CPU and the
 * schema already has a `reasoning` field where thinking belongs. Sampling is
 * pinned (temperature 0, one candidate, fixed seed) for repeatability on the
 * same machine — knowing that it does not survive a change of machine or
 * quantisation, which is why the plan is saved in the project rather than
 * re-derived (§10.3).
 */
async function completeOllama(request: CompletionRequest, config: OllamaConfig): Promise<CompletionResult> {
  const images = request.images && request.images.length > 0 ? await encodeImages(request.images) : []
  const body = {
    model: config.model,
    stream: false,
    format: request.schema,
    think: false,
    // Kept loaded between passes; a cold load is most of the first call.
    keep_alive: '10m',
    options: {
      temperature: 0,
      seed: 7,
      top_k: 1,
      num_ctx: 8192,
      num_predict: request.maxTokens ?? DEFAULT_MAX_TOKENS
    },
    messages: [
      { role: 'system', content: request.system },
      { role: 'user', content: request.user, ...(images.length > 0 ? { images } : {}) }
    ]
  }

  const started = Date.now()
  const response = await fetchWithTimeout(
    ollamaChatUrl(config.baseUrl),
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    COMPLETION_TIMEOUT_MS,
    'The model did not answer in time'
  )

  if (!response.ok) {
    /*
     * Ollama's error bodies are `{"error": "..."}` and the sentence inside is
     * the useful part — "model 'x' not found" is exactly what the user needs
     * to read. Shown whole; there is no key to redact on the local path.
     */
    const detail = await response.text().catch(() => '')
    let message = detail.slice(0, 400)
    try {
      const parsed = JSON.parse(detail) as { error?: unknown }
      if (typeof parsed.error === 'string') message = parsed.error
    } catch {
      // Not JSON; the raw text will do.
    }
    throw new Error(`Ollama returned ${response.status}. ${message}`.trim())
  }

  const data = (await response.json()) as {
    message?: { content?: unknown }
    prompt_eval_count?: unknown
    eval_count?: unknown
    done_reason?: unknown
  }
  const text = typeof data.message?.content === 'string' ? data.message.content : ''
  if (!text.trim()) throw new Error('The model returned an empty answer')

  const count = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? value : null

  return {
    text,
    provider: 'ollama',
    model: config.model,
    promptTokens: count(data.prompt_eval_count),
    outputTokens: count(data.eval_count),
    durationMs: Date.now() - started,
    truncated: data.done_reason === 'length'
  }
}

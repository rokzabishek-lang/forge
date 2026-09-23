import sharp from 'sharp'
import {
  COMPLETION_TIMEOUT_MS,
  DEFAULT_DIRECTOR,
  STATUS_TIMEOUT_MS,
  chooseProvider,
  hasModel,
  isLoopback,
  ollamaAnswer,
  ollamaChatUrl,
  ollamaRequestBody,
  ollamaTagsUrl,
  openaiAnswer,
  openaiChatUrl,
  openaiConfigured,
  openaiModelsUrl,
  openaiRequestBody,
  publicConfig,
  redactKey,
  suggestModel,
  type CompletionRequest,
  type CompletionResult,
  type DirectorConfig,
  type LlmProviderChoice,
  type LlmStatus,
  type OllamaConfig,
  type OpenAiConfig,
  type PublicDirectorConfig
} from '@shared/director/provider'
import { getSettings, setSettings } from './store'

/**
 * The model providers, behind one door.
 *
 * The contract and the decisions are in shared/director/provider.ts, where
 * they are pure and tested. This is the part that actually talks to things:
 * Ollama's API, and any OpenAI-shaped server — LM Studio on this machine, or
 * a hosted API with the user's key. Both return the same thing, the model's
 * text, and everything upstream parses and validates it without learning
 * which one answered.
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
    openai: { ...DEFAULT_DIRECTOR.openai, ...(saved?.openai ?? {}) }
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
 * without resending the key it never had. `openai.apiKey: ''` is how the key
 * is cleared — a field that is absent keeps what is there.
 */
export function setDirectorSettings(patch: {
  provider?: LlmProviderChoice
  ollama?: Partial<OllamaConfig>
  openai?: Partial<OpenAiConfig>
}): PublicDirectorConfig {
  const current = directorConfig()
  const next: DirectorConfig = {
    provider: patch.provider ?? current.provider,
    ollama: { ...current.ollama, ...(patch.ollama ?? {}) },
    openai: { ...current.openai, ...(patch.openai ?? {}) }
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

function authHeaders(apiKey: string): Record<string, string> {
  return apiKey.trim() ? { authorization: `Bearer ${apiKey.trim()}` } : {}
}

/** A host name for a message — never the whole URL, which may carry a path with a key in it. */
function hostOf(baseUrl: string): string {
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(baseUrl.trim()) ? baseUrl.trim() : `http://${baseUrl.trim()}`).host
  } catch {
    return 'that address'
  }
}

/* ----------------------------------------------------------------- status */

/** What the Ollama server has pulled. Throws when it is not there. */
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

/** What an OpenAI-shaped server offers. Throws when it is not there. */
export async function openaiModels(config: OpenAiConfig = directorConfig().openai): Promise<string[]> {
  const response = await fetchWithTimeout(
    openaiModelsUrl(config.baseUrl),
    { headers: authHeaders(config.apiKey) },
    STATUS_TIMEOUT_MS,
    'The server did not answer'
  )
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(
      `The server returned ${response.status} when asked for its models. ${redactKey(detail, config.apiKey)}`.trim()
    )
  }
  const data = (await response.json()) as { data?: { id?: unknown }[] }
  return (data.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === 'string')
}

/**
 * What each provider can currently do, and why not when it cannot.
 *
 * Each server is asked, not assumed: it may be down, may have no models, or
 * may not have the one that was chosen — and each of those has a different
 * fix, so each gets its own sentence. The list of models rides along for the
 * picker.
 */
export async function directorStatus(): Promise<LlmStatus[]> {
  const config = directorConfig()
  const [ollama, openai] = await Promise.all([ollamaStatus(config.ollama), openaiStatus(config.openai)])
  return [ollama, openai]
}

async function ollamaStatus(config: OllamaConfig): Promise<LlmStatus> {
  let models: string[] | null = null
  let reason: string | null = null
  try {
    models = await ollamaModels(config)
  } catch {
    reason = 'Ollama is not running. Start it, or install it from ollama.com'
  }

  let ready = false
  if (models) {
    const chosen = config.model.trim()
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

  return {
    id: 'ollama',
    label: 'Ollama (on this machine)',
    kind: 'local',
    ready,
    reason: ready ? null : reason,
    ...(models ? { models } : {})
  }
}

async function openaiStatus(config: OpenAiConfig): Promise<LlmStatus> {
  const local = isLoopback(config.baseUrl)
  const label = local ? 'Local server (LM Studio, llama.cpp)' : 'Hosted API'
  const kind = local ? 'local' : 'hosted'

  if (!openaiConfigured(config)) {
    return {
      id: 'openai',
      label,
      kind,
      ready: false,
      // Deliberately not "invalid key": nothing has been tried yet.
      reason: local
        ? 'Add the server address in the Director settings — LM Studio uses http://127.0.0.1:1234/v1'
        : 'Add the endpoint and your key in the Director settings'
    }
  }

  let models: string[] | null = null
  let reason: string | null = null
  try {
    models = await openaiModels(config)
  } catch (err) {
    reason = local
      ? `No server answering at ${hostOf(config.baseUrl)} — in LM Studio, start the server from the Developer tab`
      : redactKey(err instanceof Error ? err.message : String(err), config.apiKey)
  }

  let ready = false
  if (models) {
    const chosen = config.model.trim()
    if (models.length === 0) {
      reason = local ? 'The server has no model — load one in LM Studio' : 'The endpoint lists no models'
    } else if (!chosen) {
      const suggestion = suggestModel(models)
      reason = suggestion
        ? `Choose a model in the Director settings — ${suggestion} is available`
        : 'Choose a model in the Director settings'
    } else if (!hasModel(models, chosen)) {
      reason = `${chosen} is not on the server${local ? ' — load it in LM Studio' : ''}`
    } else {
      ready = true
    }
  }

  return { id: 'openai', label, kind, ready, reason: ready ? null : reason, ...(models ? { models } : {}) }
}

/* --------------------------------------------------------------- complete */

export async function complete(request: CompletionRequest): Promise<CompletionResult> {
  const config = directorConfig()
  const choice: LlmProviderChoice = request.provider ?? config.provider
  const picked = chooseProvider(choice, await directorStatus())
  if ('error' in picked) throw new Error(picked.error)
  const images = request.images && request.images.length > 0 ? await encodeImages(request.images) : []
  return picked.id === 'ollama'
    ? completeOllama(request, images, config.ollama)
    : completeOpenAi(request, images, config.openai)
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
 * One structured completion from Ollama. The body — the schema as `format`,
 * thinking off unless asked, pinned sampling — is `ollamaRequestBody`, in
 * shared/director/provider.ts, so the eval sends exactly the same thing.
 */
async function completeOllama(
  request: CompletionRequest,
  images: string[],
  config: OllamaConfig
): Promise<CompletionResult> {
  const body = ollamaRequestBody(request, images, config.model)

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
     * to read. Shown whole; there is no key on this path.
     */
    const detail = await response.text().catch(() => '')
    throw new Error(`Ollama returned ${response.status}. ${errorSentence(detail)}`.trim())
  }

  const answer = ollamaAnswer(await response.json())
  return { ...answer, provider: 'ollama', model: config.model, durationMs: Date.now() - started }
}

/**
 * One structured completion from an OpenAI-shaped server. The body —
 * `json_schema` strict, images as data URLs — is `openaiRequestBody` in
 * shared/director/provider.ts. The key, when there is one, goes only to this
 * endpoint and is stripped from anything that comes back as an error.
 */
async function completeOpenAi(
  request: CompletionRequest,
  images: string[],
  config: OpenAiConfig
): Promise<CompletionResult> {
  const body = openaiRequestBody(request, images, config.model)

  const started = Date.now()
  try {
    const response = await fetchWithTimeout(
      openaiChatUrl(config.baseUrl),
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders(config.apiKey) },
        body: JSON.stringify(body)
      },
      COMPLETION_TIMEOUT_MS,
      'The model did not answer in time'
    )

    if (!response.ok) {
      /*
       * The body often explains the problem — a bad model name, a quota —
       * and it is worth showing. It is also the one place a key could be
       * echoed back, so it is truncated and scanned before it reaches the
       * user.
       */
      const detail = await response.text().catch(() => '')
      throw new Error(
        `The server returned ${response.status}. ${redactKey(errorSentence(detail), config.apiKey)}`.trim()
      )
    }

    const answer = openaiAnswer(await response.json())
    return { ...answer, provider: 'openai', model: config.model, durationMs: Date.now() - started }
  } catch (err) {
    throw new Error(redactKey(err instanceof Error ? err.message : String(err), config.apiKey))
  }
}

/**
 * The sentence inside an API error body.
 *
 * Ollama says `{"error": "…"}`; the OpenAI shape says `{"error": {"message":
 * "…"}}`. Either way the sentence is what the user needs and the envelope is
 * not. Anything else is shown as it came, clipped.
 */
function errorSentence(detail: string): string {
  try {
    const parsed = JSON.parse(detail) as { error?: unknown }
    if (typeof parsed.error === 'string') return parsed.error
    if (typeof parsed.error === 'object' && parsed.error !== null) {
      const message = (parsed.error as { message?: unknown }).message
      if (typeof message === 'string') return message
    }
  } catch {
    // Not JSON; the raw text will do.
  }
  return detail.slice(0, 400)
}

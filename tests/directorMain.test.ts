import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { COMPLETION_TIMEOUT_MS, DEFAULT_DIRECTOR, type DirectorConfig } from '@shared/director/provider'
import { setSettings } from '../src/main/store'
import {
  complete,
  directorSettings,
  directorStatus,
  encodeImages,
  ollamaModels,
  openaiModels,
  setDirectorSettings
} from '../src/main/director'

/**
 * The two clients, against a fetch that plays both servers.
 *
 * What is being checked is the REQUEST — that the schema goes out as the
 * grammar, that thinking is off unless asked, that sampling is pinned, that a
 * key goes only where it should — and what each server answer turns into for
 * the user. Nothing here talks to a real server; that is the evening's job,
 * in a terminal.
 */

const schema = {
  type: 'object',
  properties: { reasoning: { type: 'string' } },
  required: ['reasoning'],
  additionalProperties: false
}
const request = { system: 'You direct ads.', user: 'Brief: serum.', schema }

interface Served {
  /** Ollama's /api/tags: a list, or how it fails. */
  tags?: { name: string }[] | 'down' | 'error'
  /** The OpenAI shape's /v1/models: a list, or how it fails. */
  models?: { id: string }[] | 'down' | 'error'
  chat?: (body: Record<string, unknown>, init: RequestInit) => Response | Promise<Response>
}

/** Every request the fake servers saw, so a test can look at the body and headers. */
let seen: { url: string; body: Record<string, unknown> | null; headers: Record<string, string> }[] = []

function serve(what: Served): void {
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])
    )
    seen.push({ url, body, headers })
    if (url.endsWith('/api/tags')) {
      if (what.tags === 'down' || what.tags === undefined) throw new TypeError('fetch failed')
      if (what.tags === 'error') return new Response('nope', { status: 500 })
      return Response.json({ models: what.tags })
    }
    if (url.endsWith('/models')) {
      if (what.models === 'down' || what.models === undefined) throw new TypeError('fetch failed')
      if (what.models === 'error') return new Response('{"error":{"message":"bad key sk-secret-123"}}', { status: 401 })
      return Response.json({ object: 'list', data: what.models })
    }
    if ((url.endsWith('/api/chat') || url.endsWith('/chat/completions')) && what.chat) {
      return what.chat(body ?? {}, init ?? {})
    }
    throw new Error(`unexpected ${url}`)
  })
}

const ollamaAnswer = (content: string, extra: Record<string, unknown> = {}): Response =>
  Response.json({
    message: { role: 'assistant', content },
    prompt_eval_count: 812,
    eval_count: 96,
    done_reason: 'stop',
    ...extra
  })

const openaiAnswer = (content: string, finish = 'stop'): Response =>
  Response.json({
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finish }],
    usage: { prompt_tokens: 640, completion_tokens: 88 }
  })

const configured = (over: Partial<DirectorConfig> = {}): void => {
  setSettings({
    director: {
      ...DEFAULT_DIRECTOR,
      ollama: { ...DEFAULT_DIRECTOR.ollama, model: 'gemma4:e2b' },
      openai: { ...DEFAULT_DIRECTOR.openai, model: 'google/gemma-4-e2b' },
      ...over
    }
  })
}

beforeEach(() => {
  seen = []
  configured()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('directorStatus — Ollama', () => {
  it('says the server is not running', async () => {
    serve({ tags: 'down', models: 'down' })
    const [ollama] = await directorStatus()
    expect(ollama.ready).toBe(false)
    expect(ollama.reason).toContain('not running')
    expect(ollama.models).toBeUndefined()
  })

  it('asks for a model to be chosen and names the one worth choosing', async () => {
    configured({ ollama: { ...DEFAULT_DIRECTOR.ollama } })
    serve({ tags: [{ name: 'nomic-embed-text:latest' }, { name: 'qwen3.5:4b' }], models: 'down' })
    const [ollama] = await directorStatus()
    expect(ollama.ready).toBe(false)
    expect(ollama.reason).toContain('Choose a model')
    expect(ollama.reason).toContain('qwen3.5:4b')
    expect(ollama.models).toEqual(['nomic-embed-text:latest', 'qwen3.5:4b'])
  })

  it('treats an untagged name as :latest, which is what Ollama does', async () => {
    configured({ ollama: { ...DEFAULT_DIRECTOR.ollama, model: 'gemma4' } })
    serve({ tags: [{ name: 'gemma4:latest' }], models: 'down' })
    const [ollama] = await directorStatus()
    expect(ollama.ready).toBe(true)
    expect(ollama.reason).toBeNull()
  })

  it('tells the user what to pull when the chosen model is missing', async () => {
    serve({ tags: [{ name: 'qwen3.5:4b' }], models: 'down' })
    const [ollama] = await directorStatus()
    expect(ollama.ready).toBe(false)
    expect(ollama.reason).toContain('ollama pull gemma4:e2b')
  })

  it('says there is nothing pulled when the list is empty', async () => {
    serve({ tags: [], models: 'down' })
    const [ollama] = await directorStatus()
    expect(ollama.reason).toContain('no models')
  })

  it('lists models, and reports a server that answers badly', async () => {
    serve({ tags: [{ name: 'a:1' }, { name: 'b:2' }] })
    expect(await ollamaModels()).toEqual(['a:1', 'b:2'])
    serve({ tags: 'error' })
    await expect(ollamaModels()).rejects.toThrow('500')
  })
})

describe('directorStatus — OpenAI shape', () => {
  it('is local by its address, and says how to start LM Studio when nothing answers', async () => {
    serve({ tags: 'down', models: 'down' })
    const [, openai] = await directorStatus()
    expect(openai.kind).toBe('local')
    expect(openai.label).toContain('LM Studio')
    expect(openai.ready).toBe(false)
    expect(openai.reason).toContain('LM Studio')
    expect(openai.reason).toContain('127.0.0.1:1234')
  })

  it('is ready when the server lists the chosen model', async () => {
    serve({ tags: 'down', models: [{ id: 'google/gemma-4-e2b' }, { id: 'text-embedding-nomic-embed-text-v1.5' }] })
    const [, openai] = await directorStatus()
    expect(openai.ready).toBe(true)
    expect(openai.models).toEqual(['google/gemma-4-e2b', 'text-embedding-nomic-embed-text-v1.5'])
  })

  it('suggests a model when none is chosen, and says when the chosen one is not loaded', async () => {
    configured({ openai: { ...DEFAULT_DIRECTOR.openai } })
    serve({ tags: 'down', models: [{ id: 'text-embedding-nomic-embed-text-v1.5' }, { id: 'qwen/qwen3.5-4b' }] })
    let [, openai] = await directorStatus()
    expect(openai.reason).toContain('qwen/qwen3.5-4b')

    configured({ openai: { ...DEFAULT_DIRECTOR.openai, model: 'google/gemma-4-e2b' } })
    serve({ tags: 'down', models: [{ id: 'qwen/qwen3.5-4b' }] })
    ;[, openai] = await directorStatus()
    expect(openai.ready).toBe(false)
    expect(openai.reason).toContain('not on the server')
  })

  it('is hosted by its address, wants a key, and never shows the key back', async () => {
    configured({ openai: { baseUrl: 'https://api.example.com/v1', model: 'm', apiKey: '' } })
    serve({ tags: 'down', models: [{ id: 'm' }] })
    let [, openai] = await directorStatus()
    expect(openai.kind).toBe('hosted')
    expect(openai.ready).toBe(false)
    expect(openai.reason).toContain('key')

    configured({ openai: { baseUrl: 'https://api.example.com/v1', model: 'm', apiKey: 'sk-secret-123' } })
    serve({ tags: 'down', models: 'error' })
    ;[, openai] = await directorStatus()
    expect(openai.ready).toBe(false)
    expect(openai.reason).toContain('401')
    expect(openai.reason).not.toContain('sk-secret-123')
  })

  it('sends the key only when there is one', async () => {
    serve({ models: [{ id: 'x' }] })
    await openaiModels()
    expect(seen[0].headers.authorization).toBeUndefined()

    seen = []
    configured({ openai: { baseUrl: 'https://api.example.com/v1', model: 'x', apiKey: 'sk-k' } })
    serve({ models: [{ id: 'x' }] })
    await openaiModels()
    expect(seen[0].headers.authorization).toBe('Bearer sk-k')
  })
})

describe('complete — Ollama', () => {
  it('sends the schema as the grammar, with thinking off and sampling pinned', async () => {
    serve({ tags: [{ name: 'gemma4:e2b' }], models: 'down', chat: () => ollamaAnswer('{"reasoning":"ok"}') })
    const result = await complete({ ...request, maxTokens: 321 })

    const chat = seen.find((s) => s.url.endsWith('/api/chat'))!
    expect(chat.url).toBe('http://127.0.0.1:11434/api/chat')
    expect(chat.body).toMatchObject({
      model: 'gemma4:e2b',
      stream: false,
      think: false,
      format: schema,
      options: { temperature: 0, top_k: 1, num_predict: 321 }
    })
    const messages = chat.body!.messages as { role: string; content: string; images?: unknown }[]
    expect(messages.map((m) => m.role)).toEqual(['system', 'user'])
    expect(messages[0].content).toBe(request.system)
    expect(messages[1].content).toBe(request.user)
    // No pictures asked for, no `images` key — an empty list is not the same
    // as absent to every server.
    expect('images' in messages[1]).toBe(false)

    expect(result.text).toBe('{"reasoning":"ok"}')
    expect(result.provider).toBe('ollama')
    expect(result.model).toBe('gemma4:e2b')
    expect(result.promptTokens).toBe(812)
    expect(result.outputTokens).toBe(96)
    expect(result.truncated).toBe(false)
  })

  it('turns thinking on when the caller asks — the retry path for the format bug', async () => {
    serve({ tags: [{ name: 'gemma4:e2b' }], chat: () => ollamaAnswer('{}') })
    await complete({ ...request, think: true })
    expect(seen.find((s) => s.url.endsWith('/api/chat'))!.body).toMatchObject({ think: true })
  })

  it('reports an answer that hit the token cap as truncated', async () => {
    serve({ tags: [{ name: 'gemma4:e2b' }], chat: () => ollamaAnswer('{"reasoning":"ok', { done_reason: 'length' }) })
    expect((await complete(request)).truncated).toBe(true)
  })

  it('shows the sentence inside an Ollama error body, with the status', async () => {
    serve({
      tags: [{ name: 'gemma4:e2b' }],
      chat: () => new Response(JSON.stringify({ error: "model 'gemma4:e2b' not found" }), { status: 404 })
    })
    await expect(complete(request)).rejects.toThrow("Ollama returned 404. model 'gemma4:e2b' not found")
  })

  it('refuses an empty answer rather than handing back nothing to parse', async () => {
    serve({ tags: [{ name: 'gemma4:e2b' }], chat: () => ollamaAnswer('   ') })
    await expect(complete(request)).rejects.toThrow('empty answer')
  })

  it('fails with every provider reason when nothing can run', async () => {
    serve({ tags: 'down', models: 'down' })
    await expect(complete(request)).rejects.toThrow(/not running.*LM Studio|LM Studio.*not running/s)
  })

  it('gives up on a model that never answers, and says so', async () => {
    vi.useFakeTimers()
    serve({ tags: [{ name: 'gemma4:e2b' }] })
    const status = vi.mocked(fetch)
    // The fake fetch has to honour the signal for the timeout to mean anything.
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/chat')) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('aborted')
            err.name = 'AbortError'
            reject(err)
          })
        })
      }
      return status(url, init)
    })

    const pending = complete(request)
    const failure = expect(pending).rejects.toThrow('did not answer in time')
    await vi.advanceTimersByTimeAsync(COMPLETION_TIMEOUT_MS + 1)
    await failure
  })
})

describe('complete — OpenAI shape', () => {
  const lmStudio = (): void => configured({ ollama: { ...DEFAULT_DIRECTOR.ollama } })

  it('sends the schema as a strict json_schema response format', async () => {
    lmStudio()
    serve({ tags: 'down', models: [{ id: 'google/gemma-4-e2b' }], chat: () => openaiAnswer('{"reasoning":"ok"}') })
    const result = await complete({ ...request, maxTokens: 222 })

    const chat = seen.find((s) => s.url.endsWith('/chat/completions'))!
    expect(chat.url).toBe('http://127.0.0.1:1234/v1/chat/completions')
    expect(chat.body).toMatchObject({
      model: 'google/gemma-4-e2b',
      stream: false,
      temperature: 0,
      max_tokens: 222,
      response_format: { type: 'json_schema', json_schema: { strict: true, schema } }
    })
    const messages = chat.body!.messages as { role: string; content: unknown }[]
    expect(messages.map((m) => m.role)).toEqual(['system', 'user'])
    expect(messages[1].content).toBe(request.user)
    expect(chat.headers.authorization).toBeUndefined()

    expect(result.provider).toBe('openai')
    expect(result.model).toBe('google/gemma-4-e2b')
    expect(result.promptTokens).toBe(640)
    expect(result.outputTokens).toBe(88)
    expect(result.truncated).toBe(false)
  })

  it('reports finish_reason length as truncated', async () => {
    lmStudio()
    serve({ tags: 'down', models: [{ id: 'google/gemma-4-e2b' }], chat: () => openaiAnswer('{"reasoning":"o', 'length') })
    expect((await complete(request)).truncated).toBe(true)
  })

  it('strips the key from an error body that echoes it', async () => {
    configured({
      ollama: { ...DEFAULT_DIRECTOR.ollama },
      openai: { baseUrl: 'https://api.example.com/v1', model: 'm', apiKey: 'sk-secret-123-long' }
    })
    serve({
      tags: 'down',
      models: [{ id: 'm' }],
      chat: () =>
        new Response(JSON.stringify({ error: { message: 'Incorrect API key provided: sk-secret-123-long' } }), {
          status: 401
        })
    })
    let message = ''
    await complete(request).catch((err: Error) => {
      message = err.message
    })
    expect(message).toContain('401')
    expect(message).toContain('Incorrect API key')
    expect(message).not.toContain('sk-secret-123-long')
    const chat = seen.find((s) => s.url.endsWith('/chat/completions'))!
    expect(chat.headers.authorization).toBe('Bearer sk-secret-123-long')
  })

  it('is what auto picks when Ollama is down and LM Studio is up', async () => {
    serve({ tags: 'down', models: [{ id: 'google/gemma-4-e2b' }], chat: () => openaiAnswer('{}') })
    expect((await complete(request)).provider).toBe('openai')
  })

  it('is not picked by auto over a ready Ollama', async () => {
    serve({ tags: [{ name: 'gemma4:e2b' }], models: [{ id: 'google/gemma-4-e2b' }], chat: () => ollamaAnswer('{}') })
    expect((await complete(request)).provider).toBe('ollama')
  })
})

describe('encodeImages', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'forge-director-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('downscales to a card-sized JPEG and skips a picture that will not open', async () => {
    const big = join(dir, 'big.png')
    await sharp({ create: { width: 1600, height: 900, channels: 3, background: '#a33' } }).png().toFile(big)
    await writeFile(join(dir, 'broken.png'), 'not a picture')

    const images = await encodeImages([big, join(dir, 'broken.png'), join(dir, 'missing.png')])
    expect(images).toHaveLength(1)

    const bytes = Buffer.from(images[0], 'base64')
    // JPEG magic, and no larger than the cap on its long edge.
    expect(bytes[0]).toBe(0xff)
    expect(bytes[1]).toBe(0xd8)
    const meta = await sharp(bytes).metadata()
    expect(meta.width).toBe(640)
    expect(meta.height).toBe(360)
  })

  it('never enlarges a small picture', async () => {
    const small = join(dir, 'small.png')
    await sharp({ create: { width: 120, height: 80, channels: 3, background: '#3a3' } }).png().toFile(small)
    const [image] = await encodeImages([small])
    const meta = await sharp(Buffer.from(image, 'base64')).metadata()
    expect(meta.width).toBe(120)
  })

  it('rides on the user message for Ollama, and as data URLs for the OpenAI shape', async () => {
    const pic = join(dir, 'pic.png')
    await sharp({ create: { width: 64, height: 64, channels: 3, background: '#33a' } }).png().toFile(pic)

    serve({ tags: [{ name: 'gemma4:e2b' }], chat: () => ollamaAnswer('{}') })
    await complete({ ...request, images: [pic] })
    const ollamaUser = (seen.find((s) => s.url.endsWith('/api/chat'))!.body!.messages as { images?: string[] }[])[1]
    expect(ollamaUser.images).toHaveLength(1)
    expect(ollamaUser.images![0]).toMatch(/^[A-Za-z0-9+/]+=*$/)

    seen = []
    configured({ ollama: { ...DEFAULT_DIRECTOR.ollama } })
    serve({ tags: 'down', models: [{ id: 'google/gemma-4-e2b' }], chat: () => openaiAnswer('{}') })
    await complete({ ...request, images: [pic] })
    const parts = (seen.find((s) => s.url.endsWith('/chat/completions'))!.body!.messages as { content: unknown }[])[1]
      .content as { type: string; text?: string; image_url?: { url: string } }[]
    expect(parts[0]).toEqual({ type: 'text', text: request.user })
    expect(parts[1].type).toBe('image_url')
    expect(parts[1].image_url!.url).toMatch(/^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/)
  })
})

describe('settings', () => {
  it('never hands the key back, and keeps it when a patch does not mention it', () => {
    setDirectorSettings({ openai: { apiKey: 'sk-very-secret' } })
    setDirectorSettings({ openai: { model: 'gpt-x' } })
    const shown = directorSettings()
    expect(shown.openai).toMatchObject({ model: 'gpt-x', hasKey: true })
    expect(JSON.stringify(shown)).not.toContain('secret')

    setDirectorSettings({ openai: { apiKey: '' } })
    expect(directorSettings().openai.hasKey).toBe(false)
  })

  it('sanitises a bad provider back to auto and a non-string model to the default', () => {
    setSettings({ director: { provider: 'bogus', ollama: { baseUrl: 'http://x:1', model: 42 } } as never })
    const shown = directorSettings()
    expect(shown.provider).toBe('auto')
    expect(shown.ollama).toEqual({ baseUrl: 'http://x:1', model: '' })
    expect(shown.openai.baseUrl).toBe(DEFAULT_DIRECTOR.openai.baseUrl)
  })
})

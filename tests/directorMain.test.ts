import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { COMPLETION_TIMEOUT_MS, DEFAULT_DIRECTOR } from '@shared/director/provider'
import { setSettings } from '../src/main/store'
import {
  complete,
  directorSettings,
  directorStatus,
  encodeImages,
  ollamaModels,
  setDirectorSettings
} from '../src/main/director'

/**
 * The Ollama client, against a fetch that plays the server.
 *
 * What is being checked is the REQUEST — that the schema goes out as `format`,
 * that thinking is off, that sampling is pinned — and what each server answer
 * turns into for the user. Nothing here talks to a real Ollama; that is the
 * evening's job, in a terminal.
 */

const schema = { type: 'object', properties: { reasoning: { type: 'string' } }, required: ['reasoning'], additionalProperties: false }
const request = { system: 'You direct ads.', user: 'Brief: serum.', schema }

interface Served {
  tags?: { name: string }[] | 'down' | 'error'
  chat?: (body: Record<string, unknown>) => Response | Promise<Response>
}

/** Every request the fake server saw, so a test can look at the body. */
let seen: { url: string; body: Record<string, unknown> | null }[] = []

function serve(what: Served): void {
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null
    seen.push({ url, body })
    if (url.endsWith('/api/tags')) {
      if (what.tags === 'down') throw new TypeError('fetch failed')
      if (what.tags === 'error') return new Response('nope', { status: 500 })
      return Response.json({ models: what.tags ?? [] })
    }
    if (url.endsWith('/api/chat') && what.chat) return what.chat(body ?? {})
    throw new Error(`unexpected ${url}`)
  })
}

const answer = (content: string, extra: Record<string, unknown> = {}): Response =>
  Response.json({ message: { role: 'assistant', content }, prompt_eval_count: 812, eval_count: 96, done_reason: 'stop', ...extra })

beforeEach(() => {
  seen = []
  setSettings({ director: { ...DEFAULT_DIRECTOR, ollama: { ...DEFAULT_DIRECTOR.ollama, model: 'gemma4:e2b' } } })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('directorStatus', () => {
  it('says the server is not running, and does not blame the key', async () => {
    serve({ tags: 'down' })
    const [ollama, gemini] = await directorStatus()
    expect(ollama.ready).toBe(false)
    expect(ollama.reason).toContain('not running')
    expect(ollama.models).toBeUndefined()
    expect(gemini.ready).toBe(false)
    expect(gemini.reason).toContain('key')
  })

  it('asks for a model to be chosen and names the one worth choosing', async () => {
    setSettings({ director: { ...DEFAULT_DIRECTOR } })
    serve({ tags: [{ name: 'nomic-embed-text:latest' }, { name: 'qwen3.5:4b' }] })
    const [ollama] = await directorStatus()
    expect(ollama.ready).toBe(false)
    expect(ollama.reason).toContain('Choose a model')
    expect(ollama.reason).toContain('qwen3.5:4b')
    expect(ollama.models).toEqual(['nomic-embed-text:latest', 'qwen3.5:4b'])
  })

  it('treats an untagged name as :latest, which is what Ollama does', async () => {
    setSettings({ director: { ...DEFAULT_DIRECTOR, ollama: { ...DEFAULT_DIRECTOR.ollama, model: 'gemma4' } } })
    serve({ tags: [{ name: 'gemma4:latest' }] })
    const [ollama] = await directorStatus()
    expect(ollama.ready).toBe(true)
    expect(ollama.reason).toBeNull()
  })

  it('tells the user what to pull when the chosen model is missing', async () => {
    serve({ tags: [{ name: 'qwen3.5:4b' }] })
    const [ollama] = await directorStatus()
    expect(ollama.ready).toBe(false)
    expect(ollama.reason).toContain('ollama pull gemma4:e2b')
  })

  it('says there is nothing pulled when the list is empty', async () => {
    serve({ tags: [] })
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

describe('complete', () => {
  it('sends the schema as the grammar, with thinking off and sampling pinned', async () => {
    serve({ tags: [{ name: 'gemma4:e2b' }], chat: () => answer('{"reasoning":"ok"}') })
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

  it('reports an answer that hit the token cap as truncated', async () => {
    serve({ tags: [{ name: 'gemma4:e2b' }], chat: () => answer('{"reasoning":"ok', { done_reason: 'length' }) })
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
    serve({ tags: [{ name: 'gemma4:e2b' }], chat: () => answer('   ') })
    await expect(complete(request)).rejects.toThrow('empty answer')
  })

  it('fails with the provider reason when nothing can run', async () => {
    serve({ tags: 'down' })
    await expect(complete(request)).rejects.toThrow('not running')
  })

  it('honours an explicit provider that is not ready, rather than substituting', async () => {
    serve({ tags: [{ name: 'gemma4:e2b' }], chat: () => answer('{}') })
    await expect(complete({ ...request, provider: 'gemini' })).rejects.toThrow(/Gemini|key/)
    expect(seen.some((s) => s.url.endsWith('/api/chat'))).toBe(false)
  })

  it('gives up on a model that never answers, and says so', async () => {
    vi.useFakeTimers()
    serve({
      tags: [{ name: 'gemma4:e2b' }],
      chat: () => new Promise(() => undefined) // never resolves; only the abort ends it
    })
    // The fake fetch has to honour the signal for the timeout to mean anything.
    const hanging = vi.mocked(fetch)
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
      return hanging(url, init)
    })

    const pending = complete(request)
    const failure = expect(pending).rejects.toThrow('did not answer in time')
    await vi.advanceTimersByTimeAsync(COMPLETION_TIMEOUT_MS + 1)
    await failure
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

  it('goes on the user message when asked for', async () => {
    const pic = join(dir, 'pic.png')
    await sharp({ create: { width: 64, height: 64, channels: 3, background: '#33a' } }).png().toFile(pic)
    serve({ tags: [{ name: 'gemma4:e2b' }], chat: () => answer('{}') })
    await complete({ ...request, images: [pic] })
    const chat = seen.find((s) => s.url.endsWith('/api/chat'))!
    const user = (chat.body!.messages as { images?: string[] }[])[1]
    expect(user.images).toHaveLength(1)
    expect(user.images![0]).toMatch(/^[A-Za-z0-9+/]+=*$/)
  })
})

describe('settings', () => {
  it('never hands the key back, and keeps it when a patch does not mention it', () => {
    setDirectorSettings({ gemini: { apiKey: 'AIza-very-secret' } })
    setDirectorSettings({ gemini: { model: 'gemini-x' } })
    const shown = directorSettings()
    expect(shown.gemini).toEqual({ model: 'gemini-x', hasKey: true })
    expect(JSON.stringify(shown)).not.toContain('secret')

    setDirectorSettings({ gemini: { apiKey: '' } })
    expect(directorSettings().gemini.hasKey).toBe(false)
  })

  it('sanitises a bad provider back to auto and a non-string model to the default', () => {
    setSettings({ director: { provider: 'bogus', ollama: { baseUrl: 'http://x:1', model: 42 } } as never })
    const shown = directorSettings()
    expect(shown.provider).toBe('auto')
    expect(shown.ollama).toEqual({ baseUrl: 'http://x:1', model: '' })
  })
})

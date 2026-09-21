import { describe, it, expect } from 'vitest'
import {
  DEFAULT_DIRECTOR,
  DEFAULT_OLLAMA,
  DEFAULT_OPENAI,
  chooseProvider,
  hasModel,
  isLoopback,
  ollamaChatUrl,
  ollamaTagsUrl,
  openaiChatUrl,
  openaiConfigured,
  openaiModelsUrl,
  parseModelJson,
  publicConfig,
  suggestModel,
  type LlmStatus
} from '@shared/director/provider'

const status = (
  id: 'ollama' | 'openai',
  over: Partial<LlmStatus> = {}
): LlmStatus => ({
  id,
  label: id === 'ollama' ? 'Ollama' : 'Local server',
  kind: 'local',
  ready: true,
  reason: null,
  ...over
})

const missing = (id: 'ollama' | 'openai', reason: string, kind: 'local' | 'hosted' = 'local'): LlmStatus =>
  status(id, { ready: false, reason, kind })

describe('chooseProvider', () => {
  it('prefers a local provider, which costs nothing per use', () => {
    expect(chooseProvider('auto', [status('ollama'), status('openai', { kind: 'hosted' })])).toEqual({
      id: 'ollama'
    })
    // LM Studio alone, Ollama down: the local OpenAI shape is still local.
    expect(chooseProvider('auto', [missing('ollama', 'not running'), status('openai')])).toEqual({
      id: 'openai'
    })
  })

  it('falls back to a hosted endpoint when nothing local is running', () => {
    expect(
      chooseProvider('auto', [missing('ollama', 'not running'), status('openai', { kind: 'hosted' })])
    ).toEqual({ id: 'openai' })
  })

  it('honours an explicit choice rather than substituting the other', () => {
    // Someone who picked their hosted model and got a 2B local one instead has
    // had their ad written by something they did not choose, without being told.
    expect(chooseProvider('openai', [status('ollama'), missing('openai', 'no key yet', 'hosted')])).toEqual({
      error: 'no key yet'
    })
  })

  it('reports BOTH reasons when neither works', () => {
    const got = chooseProvider('auto', [missing('ollama', 'not running'), missing('openai', 'no key yet')])
    const message = (got as { error: string }).error
    expect(message).toContain('not running')
    expect(message).toContain('no key yet')
  })

  it('says so when a provider does not exist at all', () => {
    expect(chooseProvider('ollama', [status('openai')])).toEqual({
      error: 'There is no ollama model provider'
    })
  })
})

describe('ollama urls', () => {
  it('normalises the shapes users actually paste', () => {
    for (const pasted of [
      'http://localhost:11434',
      'http://localhost:11434/',
      'http://localhost:11434//',
      'http://localhost:11434/api',
      'http://localhost:11434/api/',
      'http://localhost:11434/api/chat',
      'http://localhost:11434/api/generate',
      'localhost:11434'
    ]) {
      expect(ollamaChatUrl(pasted)).toBe('http://localhost:11434/api/chat')
      expect(ollamaTagsUrl(pasted)).toBe('http://localhost:11434/api/tags')
    }
  })

  it('falls back to the default server when the field is empty', () => {
    expect(ollamaChatUrl('')).toBe(`${DEFAULT_OLLAMA.baseUrl}/api/chat`)
    expect(ollamaChatUrl('   ')).toBe(`${DEFAULT_OLLAMA.baseUrl}/api/chat`)
  })
})

describe('openai-shaped urls', () => {
  it('keeps the version path the user pasted and appends only the endpoint', () => {
    for (const pasted of [
      'http://localhost:1234/v1',
      'http://localhost:1234/v1/',
      'http://localhost:1234/v1/chat/completions',
      'http://localhost:1234/v1/models'
    ]) {
      expect(openaiChatUrl(pasted)).toBe('http://localhost:1234/v1/chat/completions')
      expect(openaiModelsUrl(pasted)).toBe('http://localhost:1234/v1/models')
    }
    // Gemini's compatibility URL does not end in /v1, and must not be given one.
    expect(openaiChatUrl('https://generativelanguage.googleapis.com/v1beta/openai/')).toBe(
      'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'
    )
  })

  it('gives a bare host the /v1 every local server means by it', () => {
    expect(openaiChatUrl('http://localhost:1234')).toBe('http://localhost:1234/v1/chat/completions')
    expect(openaiChatUrl('localhost:1234/')).toBe('http://localhost:1234/v1/chat/completions')
    expect(openaiChatUrl('')).toBe(`${DEFAULT_OPENAI.baseUrl}/chat/completions`)
  })
})

describe('isLoopback', () => {
  it('knows this machine by every name it goes by', () => {
    for (const local of [
      'http://localhost:1234/v1',
      'http://127.0.0.1:1234',
      'http://[::1]:1234/v1',
      'localhost:1234',
      'http://0.0.0.0:8080'
    ]) {
      expect(isLoopback(local)).toBe(true)
    }
    expect(isLoopback('https://api.openai.com/v1')).toBe(false)
    expect(isLoopback('http://192.168.1.20:1234/v1')).toBe(false)
    expect(isLoopback('')).toBe(false)
    expect(isLoopback('not a url at all ://')).toBe(false)
  })
})

describe('openaiConfigured', () => {
  it('needs no key on this machine, and a key anywhere else', () => {
    expect(openaiConfigured(DEFAULT_OPENAI)).toBe(true)
    expect(openaiConfigured({ ...DEFAULT_OPENAI, baseUrl: '' })).toBe(false)
    expect(openaiConfigured({ baseUrl: 'https://api.openai.com/v1', model: '', apiKey: '' })).toBe(false)
    expect(openaiConfigured({ baseUrl: 'https://api.openai.com/v1', model: '', apiKey: 'sk-x' })).toBe(true)
    expect(openaiConfigured(undefined)).toBe(false)
  })
})

describe('parseModelJson', () => {
  const object = { reasoning: 'x', segments: [] }
  const json = JSON.stringify(object)

  it('takes bare JSON, which is what a constrained decoder returns', () => {
    expect(parseModelJson(json)).toEqual({ value: object })
    expect(parseModelJson(`  ${json}\n`)).toEqual({ value: object })
  })

  it('takes a fenced block, with or without a language tag', () => {
    expect(parseModelJson('```json\n' + json + '\n```')).toEqual({ value: object })
    expect(parseModelJson('```\n' + json + '\n```')).toEqual({ value: object })
  })

  it('takes prose around the object, which hosted models add', () => {
    expect(parseModelJson(`Here is the plan:\n${json}\nLet me know if you want changes.`)).toEqual({
      value: object
    })
  })

  it('removes a thinking block first, braces and all', () => {
    // A thought that mentions an object would otherwise be where the first
    // brace is found.
    const thought = '<think>\nThe brief wants { hook first }. Let me plan.\n</think>\n'
    expect(parseModelJson(thought + json)).toEqual({ value: object })
  })

  it('says when there is no object, and when the object does not parse', () => {
    expect(parseModelJson('I cannot help with that.')).toEqual({
      error: expect.stringContaining('no JSON object')
    })
    // Cut off at the token cap is the COMMON failure, and "no JSON object"
    // sends someone looking for a refusal that never happened.
    const truncated = parseModelJson('{"reasoning": "x", "segments": [') as { error: string }
    expect(truncated.error).toContain('does not parse')
    expect(truncated.error).toContain('cut off')
    // A well-formed object is not "cut off" — the hint is for the truncated case only.
    const broken = parseModelJson('{"reasoning": "x", "segments": [}') as { error: string }
    expect(broken.error).toContain('does not parse')
    expect(broken.error).not.toContain('cut off')
  })
})

describe('suggestModel', () => {
  it('never picks an embedding model, whatever comes first', () => {
    // The exact list on the machine this was written on.
    const pulled = [
      'nomic-embed-text:latest',
      'llama3:latest',
      'qwen3:1.7b',
      'qwen-director:latest',
      'llama3.2:latest',
      'qwen3.5:9b',
      'qwen3.5:4b'
    ]
    expect(suggestModel(pulled)).toBe('qwen3.5:9b')
    expect(suggestModel(['nomic-embed-text:latest', 'text-embedding-nomic-embed-text-v1.5'])).toBeNull()
    expect(suggestModel([])).toBeNull()
  })

  it('prefers Gemma 4 when it is there, under either naming', () => {
    expect(suggestModel(['qwen3.5:4b', 'gemma4:e2b'])).toBe('gemma4:e2b')
    // LM Studio's ids.
    expect(suggestModel(['qwen/qwen3.5-4b', 'google/gemma-4-e2b'])).toBe('google/gemma-4-e2b')
  })

  it('falls back to the first chat model when nothing is recognised', () => {
    expect(suggestModel(['mistral:7b', 'phi4:latest'])).toBe('mistral:7b')
  })
})

describe('hasModel', () => {
  it('matches an untagged name against :latest, and a tagged one exactly', () => {
    const pulled = ['gemma4:latest', 'qwen3.5:4b']
    expect(hasModel(pulled, 'gemma4')).toBe(true)
    expect(hasModel(pulled, 'gemma4:latest')).toBe(true)
    expect(hasModel(pulled, 'qwen3.5:4b')).toBe(true)
    // A different tag is a different model — do not wave it through.
    expect(hasModel(pulled, 'qwen3.5')).toBe(false)
    expect(hasModel(pulled, 'gemma4:e2b')).toBe(false)
    expect(hasModel(pulled, '')).toBe(false)
    // LM Studio ids are exact.
    expect(hasModel(['google/gemma-4-e2b'], 'google/gemma-4-e2b')).toBe(true)
  })
})

describe('config', () => {
  it('never lets the key cross to the renderer', () => {
    const shown = publicConfig({
      ...DEFAULT_DIRECTOR,
      openai: { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-very-secret-key', model: 'm' }
    })
    expect(JSON.stringify(shown)).not.toContain('secret')
    expect(shown.openai).toEqual({ baseUrl: 'https://api.example.com/v1', model: 'm', hasKey: true })
    expect(publicConfig(DEFAULT_DIRECTOR).openai.hasKey).toBe(false)
  })
})

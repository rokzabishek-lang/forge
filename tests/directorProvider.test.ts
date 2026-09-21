import { describe, it, expect } from 'vitest'
import {
  DEFAULT_DIRECTOR,
  DEFAULT_OLLAMA,
  chooseProvider,
  geminiReady,
  hasModel,
  ollamaChatUrl,
  ollamaTagsUrl,
  parseModelJson,
  publicConfig,
  suggestModel,
  type LlmStatus
} from '@shared/director/provider'

const ready = (id: 'ollama' | 'gemini'): LlmStatus => ({
  id,
  label: id === 'ollama' ? 'Ollama' : 'Gemini',
  kind: id === 'ollama' ? 'local' : 'hosted',
  ready: true,
  reason: null
})

const missing = (id: 'ollama' | 'gemini', reason: string): LlmStatus => ({
  ...ready(id),
  ready: false,
  reason
})

describe('chooseProvider', () => {
  it('prefers the local one, which costs nothing per use', () => {
    expect(chooseProvider('auto', [ready('ollama'), ready('gemini')])).toEqual({ id: 'ollama' })
  })

  it('falls back to the hosted one when nothing local is running', () => {
    expect(chooseProvider('auto', [missing('ollama', 'not running'), ready('gemini')])).toEqual({
      id: 'gemini'
    })
  })

  it('honours an explicit choice rather than substituting the other', () => {
    // Someone who picked Gemini and got a 2B local model instead has had their
    // ad written by something they did not choose, without being told.
    expect(chooseProvider('gemini', [ready('ollama'), missing('gemini', 'no key yet')])).toEqual({
      error: 'no key yet'
    })
  })

  it('reports BOTH reasons when neither works', () => {
    const got = chooseProvider('auto', [missing('ollama', 'not running'), missing('gemini', 'no key yet')])
    const message = (got as { error: string }).error
    expect(message).toContain('not running')
    expect(message).toContain('no key yet')
  })

  it('says so when a provider does not exist at all', () => {
    expect(chooseProvider('ollama', [ready('gemini')])).toEqual({
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
      'http://localhost:11434/api/generate'
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
    expect(suggestModel(['nomic-embed-text:latest'])).toBeNull()
    expect(suggestModel([])).toBeNull()
  })

  it('prefers Gemma 4 when it has been pulled', () => {
    expect(suggestModel(['qwen3.5:4b', 'gemma4:e2b'])).toBe('gemma4:e2b')
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
  })
})

describe('config', () => {
  it('needs a key to be ready, and nothing else', () => {
    expect(geminiReady(DEFAULT_DIRECTOR.gemini)).toBe(false)
    expect(geminiReady({ apiKey: '  ', model: 'x' })).toBe(false)
    expect(geminiReady({ apiKey: 'k', model: '' })).toBe(true)
  })

  it('never lets the key cross to the renderer', () => {
    const shown = publicConfig({
      ...DEFAULT_DIRECTOR,
      gemini: { apiKey: 'sk-very-secret-key', model: 'm' }
    })
    expect(JSON.stringify(shown)).not.toContain('secret')
    expect(shown.gemini).toEqual({ model: 'm', hasKey: true })
    expect(publicConfig(DEFAULT_DIRECTOR).gemini.hasKey).toBe(false)
  })
})

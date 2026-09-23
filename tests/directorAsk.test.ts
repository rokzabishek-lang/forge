import { describe, expect, it } from 'vitest'
import { THINKING_EXTRA_TOKENS, askStructured } from '@shared/director/ask'
import type { CompletionRequest, CompletionResult } from '@shared/director/provider'

/**
 * The one retry (shared/director/ask.ts): thinking off first; prose back and
 * not cut off → once more with thinking on and more room. Both the spine and
 * the look pass ask through it, so the Ollama `think: false` bug cannot be
 * handled in one and forgotten in the other.
 */

const result = (text: string, truncated = false): CompletionResult => ({
  text, provider: 'ollama', model: 'm', promptTokens: 1, outputTokens: 1, durationMs: 1, truncated
})

function fake(answers: CompletionResult[]): { complete: (r: CompletionRequest) => Promise<CompletionResult>; asked: CompletionRequest[] } {
  const asked: CompletionRequest[] = []
  return {
    asked,
    complete: async (r) => {
      asked.push(r)
      return answers[asked.length - 1]
    }
  }
}

const request: CompletionRequest = { system: 's', user: 'u', schema: {}, maxTokens: 500 }

describe('askStructured', () => {
  it('asks once, thinking off, when the answer is JSON', async () => {
    const f = fake([result('{"a":1}')])
    const out = await askStructured(f.complete, request)
    expect(f.asked).toHaveLength(1)
    expect(f.asked[0].think).toBe(false)
    expect(out.parsed).toEqual({ value: { a: 1 } })
    expect(out.notes).toEqual([])
  })

  it('asks again with thinking on and more room when prose came back', async () => {
    const f = fake([result('Sure! Here is a plan.'), result('{"a":2}')])
    let retried = 0
    const out = await askStructured(f.complete, request, () => retried++)
    expect(f.asked.map((r) => r.think)).toEqual([false, true])
    expect(f.asked[1].maxTokens).toBe(500 + THINKING_EXTRA_TOKENS)
    expect(retried).toBe(1)
    expect(out.parsed).toEqual({ value: { a: 2 } })
    expect(out.notes[0]).toMatch(/asked again with thinking on/)
  })

  it('does not ask again when the answer was only cut off — more thinking would not fit either', async () => {
    const f = fake([result('{"a": [1, 2', true)])
    const out = await askStructured(f.complete, request)
    expect(f.asked).toHaveLength(1)
    expect('error' in out.parsed).toBe(true)
  })
})

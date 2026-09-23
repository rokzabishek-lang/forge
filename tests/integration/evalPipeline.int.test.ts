import { beforeAll, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { TRANSITIONS } from '@shared/transitions/registry'
import { maxTokensFor } from '@shared/director/prompt'
import type { Fixture } from '../eval/fixtures'
import { loadFixtures } from '../eval/fixtures'
import { makeFixtureMedia } from '../eval/media'
import {
  prepareFixture,
  requestFor,
  scoreFixture,
  type EvalRequest,
  type EvalResponse,
  type Prepared
} from '../eval/pipeline'
import { outputDir, pixelAt, saveFrame, writeNote } from './output'

/**
 * The Director eval's pipeline, end to end, without a model (docs/PLAN.md §3).
 *
 * The eval is how every later change to the Director is judged, so its own
 * accounting has to be right: a brief must become the request the app would
 * send, and an answer must be scored and RENDERED the way `direct()` applies it.
 * This drives one committed brief through prepare → a canned answer → score,
 * and reads the rendered frames: each shot shows the photo the plan put there.
 * No sidecar (CI has a bare interpreter), so the menu is the even grid — the
 * same fallback the app takes without the beat analysis.
 */

let dir = ''
let fixture: Fixture
let prepared: Prepared
let request: EvalRequest

const answer = (content: string, finish = 'stop'): EvalResponse => ({
  id: request.id,
  status: 200,
  ms: 10,
  data: { choices: [{ message: { content }, finish_reason: finish }], usage: { prompt_tokens: 800, completion_tokens: 300 } }
})

/** A plan using the first four slots on the first four cuts, hard cuts, a headline each. */
function plan(): object {
  const ends = prepared.menu.cuts.filter((c) => c.reason !== 'start').slice(0, 4)
  return {
    reasoning: 'four shots, straight cuts',
    pace: 'punchy',
    segments: prepared.menu.slots.slice(0, 4).map((slot, i) => ({
      slot: slot.id,
      role: ['hook', 'problem', 'product', 'cta'][i],
      ends_at: ends[i].id,
      enter: 'cut',
      headline: ['Run faster', 'Less weight', 'Stride X2', 'Get yours'][i],
      punch_word: '',
      why: 'test'
    }))
  }
}

beforeAll(async () => {
  dir = await outputDir('evalPipeline')
  fixture = (await loadFixtures()).find((f) => f.id === 'product-sneaker')!
  const made = await makeFixtureMedia(fixture, join(dir, 'media'), undefined)
  prepared = await prepareFixture(fixture, made, { analyseBeats: null, transitions: TRANSITIONS })
  request = requestFor(prepared, { provider: 'openai', model: 'fake-model', think: false })
}, 300_000)

describe('the eval pipeline', () => {
  it('builds the request the app would send', () => {
    const body = request.body as {
      model: string
      max_tokens: number
      response_format: { type: string; json_schema: { strict: boolean; schema: { properties: Record<string, unknown> } } }
      messages: { role: string; content: string }[]
    }
    expect(request.path).toBe('/v1/chat/completions')
    expect(body.model).toBe('fake-model')
    expect(body.max_tokens).toBe(maxTokensFor(prepared.menu))
    expect(body.response_format.json_schema.strict).toBe(true)
    expect(Object.keys(body.response_format.json_schema.schema.properties)[0]).toBe('reasoning')
    expect(body.messages[1].content).toContain('product: Stride X2 running shoe')
    // The user's order, the user's notes — what the model reads about each picture.
    expect(body.messages[1].content).toMatch(/slot_01 {2}image {2}"IMG 0911" {2}— shoe side profile/)
    expect(prepared.beats).toBe('grid')
  })

  it('scores a good answer as used, and renders each photo in its own span', async () => {
    const result = await scoreFixture(fixture, prepared, request, answer(JSON.stringify(plan())), {
      model: 'fake-model',
      render: { dir: join(dir, 'renders'), extraTransitions: [] }
    })
    expect(result.verdict).toBe('used')
    expect(result.promptTokens).toBe(800)
    expect(result.headlines.map((h) => h.text)).toEqual(['Run faster', 'Less weight', 'Stride X2', 'Get yours'])
    expect(result.renders.model).not.toBeNull()
    expect(existsSync(result.renders.model!)).toBe(true)
    expect(existsSync(result.renders.baseline!)).toBe(true)

    const fps = prepared.menu.fps
    const ends = prepared.menu.cuts.filter((c) => c.reason !== 'start').slice(0, 4)
    const starts = [0, ...ends.slice(0, 3).map((c) => c.frame)]
    const lines: string[] = ['# evalPipeline', '', 'The model render, sampled at the middle of each shot (540×960 centre):', '']
    for (let i = 0; i < 4; i++) {
      const mid = (starts[i] + ends[i].frame) / 2 / fps
      const want = fixture.media[i].colour
      const [r, g, b] = await pixelAt(result.renders.model!, mid, 270, 480, { width: 540, height: 960 })
      await saveFrame(result.renders.model!, mid, join(dir, `shot${i + 1}.png`))
      lines.push(`- shot ${i + 1} at ${mid.toFixed(2)} s: rgb(${r}, ${g}, ${b}), want ${want}`)
      const hex = [1, 3, 5].map((k) => parseInt(want.slice(k, k + 2), 16))
      expect(Math.abs(r - hex[0]), `shot ${i + 1} red`).toBeLessThan(14)
      expect(Math.abs(g - hex[1]), `shot ${i + 1} green`).toBeLessThan(14)
      expect(Math.abs(b - hex[2]), `shot ${i + 1} blue`).toBeLessThan(14)
    }
    await writeNote(dir, lines)
  })

  it('an answer the validator had to repair is counted as repaired, with the repair named', async () => {
    const long = plan() as { segments: { headline: string }[] }
    long.segments[0].headline = 'A headline far too long to read on a two second shot'
    const result = await scoreFixture(fixture, prepared, request, answer(JSON.stringify(long)), { model: 'fake-model', render: null })
    expect(result.verdict).toBe('repaired')
    expect(result.problems.join(' ')).toMatch(/too long to read/)
    // Counted against its span BEFORE the repair took it off.
    expect(result.headlines[0]).toMatchObject({ fits: false })
  })

  it('builds Ollama’s request with the schema as its format, and thinking as asked', () => {
    const ollama = requestFor(prepared, { provider: 'ollama', model: 'gemma4:e2b', think: true })
    const body = ollama.body as { think: boolean; format: unknown; model: string }
    expect(ollama.path).toBe('/api/chat')
    expect(body.think).toBe(true)
    expect(body.model).toBe('gemma4:e2b')
    expect(body.format).toEqual((request.body as { response_format: { json_schema: { schema: unknown } } }).response_format.json_schema.schema)
  })

  it('a prose answer is rejected, and only the standard cut is rendered', async () => {
    const result = await scoreFixture(fixture, prepared, request, answer('Here is a great ad for your shoes!'), {
      model: 'fake-model',
      render: { dir: join(dir, 'renders-prose'), extraTransitions: [] }
    })
    expect(result.verdict).toBe('rejected')
    expect(result.why).toMatch(/no JSON object/)
    expect(result.renders.model).toBeNull()
    expect(existsSync(result.renders.baseline!)).toBe(true)
  })

  it('an answer cut off at the token cap is rejected as running out of room', async () => {
    const result = await scoreFixture(fixture, prepared, request, answer(JSON.stringify(plan()), 'length'), {
      model: 'fake-model',
      render: null
    })
    expect(result.truncated).toBe(true)
    expect(result.verdict).toBe('rejected')
    expect(result.why).toMatch(/ran out of room/)
  })

  it('a refusal from the server is an error, with the server’s status', async () => {
    const refused: EvalResponse = { id: request.id, status: 400, ms: 5, data: { error: { message: 'Failed to load model' } } }
    const result = await scoreFixture(fixture, prepared, request, refused, { model: 'fake-model', render: null })
    expect(result.verdict).toBe('error')
    expect(result.why).toBe('the server returned 400')
    expect(result.applied).toEqual(result.baseline)
  })
})

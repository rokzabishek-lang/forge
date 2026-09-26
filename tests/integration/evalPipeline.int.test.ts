import { beforeAll, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { TRANSITIONS } from '@shared/transitions/registry'
import { maxTokensFor2 } from '@shared/director/prompt2'
import type { Menu2 } from '@shared/director/schema2'
import { lookById, type Rgb } from '@shared/render/looks'
import { ENERGY } from '@shared/director/recipes'
import type { Fixture } from '../eval/fixtures'
import { loadFixtures } from '../eval/fixtures'
import { makeFixtureMedia } from '../eval/media'
import {
  applied,
  cardsOf,
  menuOf,
  prepareFixture,
  renderEval,
  requestFor,
  scoreFixture,
  settleAnswer,
  type EvalRequest,
  type EvalResponse,
  type Prepared
} from '../eval/pipeline'
import { FFMPEG, outputDir, pixelAt, run, saveFrame, writeNote } from './output'
import { mkdir } from 'node:fs/promises'

/**
 * The Director eval's pipeline, end to end, without a model (docs/PLAN.md §3),
 * on `spine@2`.
 *
 * The eval is how every later change to the Director is judged, so its own
 * accounting has to be right: a brief must become the request the app would
 * send, and an answer must be settled and RENDERED the way `direct()` applies
 * it. This drives one committed brief through prepare → a canned answer →
 * score, and reads the rendered frames: each shot shows the photo the plan put
 * there, for the span the rhythm engine gave it; the black is black. No sidecar (CI has a bare
 * interpreter), so the grid is the song's tempo from the recipe — the same
 * fallback the app takes without the beat analysis.
 */

let dir = ''
let fixture: Fixture
let prepared: Prepared
let request: EvalRequest
let menu: Menu2

const answer = (content: string, finish = 'stop'): EvalResponse => ({
  id: request.id,
  status: 200,
  ms: 10,
  data: { choices: [{ message: { content }, finish_reason: finish }], usage: { prompt_tokens: 800, completion_tokens: 300 } }
})

/** An Energy plan over the first four pictures, the second the hero, a headline each — every choice from Energy's own lists. */
function plan(): { reasoning: string; recipe: string; hero: string; style: string; animation: string; shots: Record<string, string>[] } {
  const slots = menu.slots.slice(0, 4)
  return {
    reasoning: 'four shots, fast',
    recipe: 'energy',
    hero: slots[1].id,
    style: 'poster-3d',
    animation: 'pop',
    shots: slots.map((slot, i) => ({
      slot: slot.id,
      role: ['hook', 'problem', 'product', 'cta'][i],
      weight: i === 1 ? 'hold' : 'normal',
      // Varied: the same move on two stills in a row is a repair (coherence.ts), not a good answer.
      move: ['in', 'inLeft', 'inRight', 'in'][i],
      speed: 'normal',
      headline: ['Run faster', 'Less weight', 'Stride X2', 'Get yours'][i],
      punch_word: '',
      why: 'test'
    }))
  }
}

/** A colour through a look at a strength: what the export's LUT blend should produce. */
function graded(hex: string, lookId: string, intensity: number): number[] {
  const rgb = [1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16) / 255) as Rgb
  const looked = lookById(lookId)!.apply(rgb)
  return rgb.map((v, i) => Math.round(255 * (v + (looked[i] - v) * intensity)))
}

beforeAll(async () => {
  dir = await outputDir('evalPipeline')
  fixture = (await loadFixtures()).find((f) => f.id === 'product-sneaker')!
  const made = await makeFixtureMedia(fixture, join(dir, 'media'), undefined)
  prepared = await prepareFixture(fixture, made, { analyseBeats: null, transitions: TRANSITIONS })
  request = requestFor(prepared, { provider: 'openai', model: 'fake-model', think: false })
  menu = menuOf(prepared).menu
}, 300_000)

describe('the eval pipeline', () => {
  it('builds the spine@2 request the app would send', () => {
    const body = request.body as {
      model: string
      max_tokens: number
      response_format: { type: string; json_schema: { strict: boolean; schema: { properties: Record<string, unknown> } } }
      messages: { role: string; content: string }[]
    }
    expect(request.path).toBe('/v1/chat/completions')
    expect(request.id).toBe('product-sneaker.spine2')
    expect(body.model).toBe('fake-model')
    expect(body.max_tokens).toBe(maxTokensFor2(menu))
    expect(body.response_format.json_schema.strict).toBe(true)
    const properties = Object.keys(body.response_format.json_schema.schema.properties)
    expect(properties[0]).toBe('reasoning')
    expect(properties).toContain('recipe')
    expect(body.messages[1].content).toContain('product: Stride X2 running shoe')
    // The user's order, the user's notes — what the model reads about each picture.
    expect(body.messages[1].content).toMatch(/slot_01 {2}image {2}"IMG 0911" {2}— shoe side profile/)
    // The music as a sentence; no cut table to time.
    expect(body.messages[1].content).toMatch(/MUSIC: 15\.0 s at \d+ BPM/)
    expect(body.messages[1].content).not.toContain('cut_')
    expect(prepared.beats).toBe('grid')
    // The menu survives the prepared file: rebuilt from it, the same.
    expect(menuOf(JSON.parse(JSON.stringify(prepared)) as Prepared).menu.holds).toEqual(menu.holds)
  })

  it('scores a good answer as used, and renders each photo in the span the engine gave it', async () => {
    const result = await scoreFixture(fixture, prepared, request, answer(JSON.stringify(plan())), {
      model: 'fake-model',
      render: { dir: join(dir, 'renders'), extraTransitions: [] }
    })
    // Four shots do not fill 15 s of Energy, so the engine notes the ad ends early — a note about the
    // music, not a repair of the model's plan: the plan is still "used".
    expect(result.problems.join(' ')).toMatch(/the ad ends at/)
    expect(result.verdict).toBe('used')
    expect(result.recipe).toBe('energy')
    expect(result.promptTokens).toBe(800)
    expect(result.headlines.map((h) => h.text)).toEqual(['Run faster', 'Less weight', 'Stride X2', 'Get yours'])
    expect(existsSync(result.renders.model!)).toBe(true)
    expect(existsSync(result.renders.baseline!)).toBe(true)

    const fps = menu.fps
    const intensity = 0.6 + 0.3 * ENERGY.intensity
    const lines: string[] = [
      '# evalPipeline',
      '',
      `The model render (Energy, teal-orange at ${intensity.toFixed(3)}), each shot three frames before its end (540×960 centre).`,
      'Sampled late: a transition blends over the FIRST frames of the incoming shot (anchorTransition), so a short',
      'shot\'s middle can still be mid-blend. The expected colour is the photo through the look; on colours this',
      'saturated the look moves a channel by 4–10, inside the tolerance, so this checks the PICTURE — the grade\'s',
      'strength is spine2Render\'s check, with a LUT that maps everything to black.',
      ''
    ]
    const colourOf = new Map(menu.slots.map((s, i) => [s.id, fixture.media[i].colour]))
    // Measure everything and write it down first, so a failure can be read from the note.
    const samples: { i: number; got: number[]; want: number[]; plain: number[] }[] = []
    for (const [i, shot] of result.timing.entries()) {
      const mid = (shot.endFrame - 3) / fps
      const want = graded(colourOf.get(shot.slot)!, 'teal-orange', intensity)
      const plain = graded(colourOf.get(shot.slot)!, 'teal-orange', 0)
      const got = await pixelAt(result.renders.model!, mid, 270, 480, { width: 540, height: 960 })
      await saveFrame(result.renders.model!, mid, join(dir, `shot${i + 1}.png`))
      samples.push({ i, got, want, plain })
      lines.push(`- shot ${i + 1} ${shot.slot}${shot.hero ? ' (hero)' : ''} at ${mid.toFixed(2)} s: rgb(${got.join(', ')}), want rgb(${want.join(', ')}) — ungraded rgb(${plain.join(', ')})`)
    }
    const afterBody = (result.timing.at(-1)!.endFrame + 2) / fps
    const black = await pixelAt(result.renders.model!, afterBody, 270, 480, { width: 540, height: 960 })
    lines.push('', `- just after the last shot, ${afterBody.toFixed(2)} s: rgb(${black.join(', ')}) — the black`)
    await writeNote(dir, lines)

    for (const { i, got, want } of samples) {
      for (let k = 0; k < 3; k++) expect(Math.abs(got[k] - want[k]), `shot ${i + 1} channel ${k}`).toBeLessThan(16)
    }
    // The hero holds longest; the black after the last shot is black.
    const heroSpan = result.timing.filter((s) => s.hero).map((s) => s.endFrame - s.startFrame)[0]
    for (const s of result.timing.filter((x) => !x.hero)) expect(heroSpan).toBeGreaterThan(s.endFrame - s.startFrame)
    expect(Math.max(...black)).toBeLessThan(24)
    // Two renders on the Windows runner's 2018 build: the same room every render check here gets (CI #98 timed out at the default).
  }, 300_000)

  it('renders a headline card the harness drew, at the export’s size, and leaves out one it did not', async () => {
    const s = settleAnswer(prepared, request, answer(JSON.stringify(plan())))
    const project = applied(prepared, s.landed.composed, s.menu, 'fake-model', null)
    const canvas = { width: 540, height: 960 }
    // What the harness would be asked to draw: every headline card, at the size the export bakes stills.
    const cards = cardsOf(project, canvas, 'cards/model')
    expect(cards.length).toBeGreaterThanOrEqual(2)
    expect(cards.map((c) => [c.width, c.height])).toEqual(cards.map(() => [540, 960]))
    expect(cards[0].file).toBe(`cards/model/${cards[0].id}.png`)
    expect(cards[0].spec.content).toBe('Run faster')

    // Only the first card "drawn": a magenta still, a colour no photo, look or black in this ad produces.
    const drawn = join(dir, 'cards', 'model')
    await mkdir(drawn, { recursive: true })
    await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=0xff00ff:s=${canvas.width}x${canvas.height},format=rgba`, '-frames:v', '1', join(drawn, `${cards[0].id}.png`)])
    const withCards = join(dir, 'renders-cards', 'with.mp4')
    const without = join(dir, 'renders-cards', 'without.mp4')
    await renderEval(project, withCards, { extraTransitions: [], cards: drawn })
    await renderEval(project, without, { extraTransitions: [] })

    const clipOf = (id: string): { start: number; duration: number } => project.clips.find((c) => c.id === id)!
    const mid = (id: string): number => (clipOf(id).start + clipOf(id).duration / 2) / menu.fps
    const first = await pixelAt(withCards, mid(cards[0].id), 270, 480, canvas)
    const firstPlain = await pixelAt(without, mid(cards[0].id), 270, 480, canvas)
    const second = await pixelAt(withCards, mid(cards[1].id), 270, 480, canvas)
    const secondPlain = await pixelAt(without, mid(cards[1].id), 270, 480, canvas)
    await writeNote(dir, [
      '',
      `Drawn cards: the first card (${cards[0].id}, "${cards[0].spec.content}") given a magenta PNG, the second not.`,
      `- during the first card: rgb(${first.join(', ')}) with the card, rgb(${firstPlain.join(', ')}) without`,
      `- during the second card: rgb(${second.join(', ')}) with the cards folder, rgb(${secondPlain.join(', ')}) without — the same, it was not drawn`
    ])
    // The drawn card is in the film: the frame is far from the same frame without it (the fixture's own pink
    // through the look is already red and blue, so only the DIFFERENCE says the card is there); the undrawn
    // one is left out, as before, so those frames match.
    expect(Math.abs(first[0] - firstPlain[0]) + Math.abs(first[1] - firstPlain[1]) + Math.abs(first[2] - firstPlain[2])).toBeGreaterThan(120)
    for (let k = 0; k < 3; k++) expect(Math.abs(second[k] - secondPlain[k]), `channel ${k} during the undrawn card`).toBeLessThan(4)
  }, 300_000)

  it('a style from another recipe is repaired, not rejected, and the repair is named', async () => {
    const other = plan()
    other.style = 'soft-fade'
    const result = await scoreFixture(fixture, prepared, request, answer(JSON.stringify(other)), { model: 'fake-model', render: null })
    expect(result.verdict).toBe('repaired')
    expect(result.applied.style).toBe('poster-3d')
    expect(result.problems.join(' ')).toMatch(/style/)
  })

  it('a headline too long for its shot is counted against the shot before it is dropped', async () => {
    const long = plan()
    long.shots[0].headline = 'A headline far too long to read on a shot this short at this tempo'
    const result = await scoreFixture(fixture, prepared, request, answer(JSON.stringify(long)), { model: 'fake-model', render: null })
    expect(result.verdict).toBe('repaired')
    expect(result.problems.join(' ')).toMatch(/too long to read/)
    expect(result.headlines[0]).toMatchObject({ fits: false })
    expect(result.applied.shots[0].headline).toBe('')
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
    // The standard cut is the tone's recipe: an energetic brief is an Energy ad.
    expect(result.recipe).toBe('energy')
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

import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { evalPath } from './eval/relay'
import { fixtureProblems, loadFixtures, transcriptFor, type Fixture } from './eval/fixtures'
import { headlinesOf } from './eval/pipeline'
import { buildReport, meetsBar, summarise } from '../scripts/eval-report.mjs'
import { modelIsA } from '../scripts/eval-rate.mjs'
import type { Menu } from '@shared/director/menu'

/**
 * The Director eval's own machinery (docs/PLAN.md §3). The eval is only as
 * good as its accounting: a relay that can be talked into writing outside its
 * folder, a fixture that cannot be checked out on Windows, a headline counted
 * against the wrong span or a report that calls a bar met when it was not are
 * each a way to measure the wrong thing and believe it.
 */

describe('the relay writes only inside tests/output/eval', () => {
  const root = '/srv/eval'

  it('accepts a relative path inside the folder', () => {
    expect(evalPath('run/responses/a.json', root)).toBe(join(root, 'run', 'responses', 'a.json'))
  })

  it('refuses everything that is not inside it', () => {
    for (const bad of ['', null, undefined, '/etc/passwd', '../x.json', 'run/../../x.json', '.', 'a\0b']) {
      expect(evalPath(bad, root), String(bad)).toBeNull()
    }
  })
})

describe('the ten briefs', () => {
  it('load, each with no problem, six English, two Telugu, two Hindi', async () => {
    const fixtures = await loadFixtures()
    expect(fixtures).toHaveLength(10)
    const languages = fixtures.map((f) => f.brief.language)
    expect(languages.filter((l) => l === 'English')).toHaveLength(6)
    expect(languages.filter((l) => l === 'Telugu')).toHaveLength(2)
    expect(languages.filter((l) => l === 'Hindi')).toHaveLength(2)
    for (const f of fixtures) expect(fixtureProblems(f, `${f.id}.json`), f.id).toEqual([])
  })

  const sound = (): Fixture => ({
    id: 'x',
    kind: 'product',
    brief: { product: 'P', benefit: '', audience: '', tone: 'calm', cta: '', seconds: 15, language: 'English' },
    music: { bpm: 100, seconds: 20, buildFrom: 5, dropAt: 8 },
    hero: 'a.jpg',
    media: [{ name: 'a.jpg', kind: 'image', colour: '#112233', size: [100, 100], note: '', truth: { people: 'none', shot: 'wide', product_visible: 'no', what: '' } }]
  })

  it('a fixture a Windows checkout would refuse is caught', () => {
    for (const name of ['Bride 5:30pm.jpg', 'CON.jpg', 'trailing.', 'what?.jpg']) {
      const f = sound()
      f.media[0].name = name
      f.hero = name
      expect(fixtureProblems(f).join(' '), name).toMatch(/legal Windows file name/)
    }
  })

  it('every other rule is caught too', () => {
    const cases: [string, (f: Fixture) => void, RegExp][] = [
      ['id', (f) => (f.id = 'y'), /does not match/],
      ['tone', (f) => (f.brief.tone = 'angry' as Fixture['brief']['tone']), /tone/],
      ['drop before build', (f) => (f.music.dropAt = 4), /build must come before/],
      ['music too short', (f) => (f.music.seconds = 10), /shorter than the ad/],
      ['hero missing', (f) => (f.hero = 'b.jpg'), /hero/],
      ['colour', (f) => (f.media[0].colour = 'red'), /colour/],
      ['clip without seconds', (f) => (f.media[0].kind = 'video'), /needs seconds/]
    ]
    expect(fixtureProblems(sound(), 'x.json')).toEqual([])
    for (const [label, change, expected] of cases) {
      const f = sound()
      change(f)
      expect(fixtureProblems(f, 'x.json').join(' '), label).toMatch(expected)
    }
  })

  it('a clip’s speech becomes a transcript that fits inside the clip', () => {
    const t = transcriptFor('a1', 'one two three four', 4, 'en')
    expect(t.words.map((w) => w.text)).toEqual(['one', 'two', 'three', 'four'])
    expect(t.words[0].startMs).toBeGreaterThanOrEqual(0)
    expect(t.words.at(-1)!.endMs).toBeLessThanOrEqual(4000)
    expect(t.segments.length).toBeGreaterThan(0)
  })
})

describe('headlines are counted against the span their segment really has', () => {
  const menu = {
    fps: 30,
    seconds: 6,
    slots: [],
    families: [],
    cuts: [
      { id: 'cut_00', ms: 0, frame: 0, reason: 'start', energy: 1 },
      { id: 'cut_01', ms: 1000, frame: 30, reason: 'grid', energy: 1 },
      { id: 'cut_02', ms: 4000, frame: 120, reason: 'grid', energy: 1 },
      { id: 'cut_end', ms: 6000, frame: 180, reason: 'end', energy: 1 }
    ]
  } as unknown as Menu

  it('walks the spans in order, from the start', () => {
    const raw = {
      segments: [
        { role: 'hook', ends_at: 'cut_01', headline: 'A headline that is far too long for one second' },
        { role: 'product', ends_at: 'cut_02', headline: 'Fits in three seconds' },
        { role: 'cta', ends_at: 'cut_end', headline: '' }
      ]
    }
    const records = headlinesOf(raw, menu)
    expect(records.map((r) => [r.role, r.seconds, r.fits])).toEqual([
      ['hook', 1, false],
      ['product', 3, true]
    ])
    // 1 s is under the 1.2 s floor, so it is given the floor's 19 characters, not 16.
    expect(records[0].capacity).toBe(19)
  })

  it('an end that is not after its start gives no span, and does not move the start', () => {
    const raw = {
      segments: [
        { role: 'hook', ends_at: 'cut_02', headline: 'first' },
        { role: 'proof', ends_at: 'cut_01', headline: 'backwards' },
        { role: 'cta', ends_at: 'cut_end', headline: 'last' }
      ]
    }
    const records = headlinesOf(raw, menu)
    expect(records.map((r) => r.seconds)).toEqual([4, 0, 2])
  })

  it('a plan without segments has no headlines', () => {
    expect(headlinesOf({ reasoning: 'x' }, menu)).toEqual([])
    expect(headlinesOf(null, menu)).toEqual([])
  })
})

describe('the report', () => {
  const result = (verdict: string, headlines = [{ fits: true }]): object => ({ fixtureId: verdict, verdict, ms: 1000, promptTokens: 800, outputTokens: 400, headlines })
  const run = (verdicts: string[], ratings?: Record<string, object>): object => ({
    run: 'r',
    model: 'm',
    provider: 'openai',
    think: false,
    transport: 'relay',
    results: verdicts.map((v, i) => ({ ...(result(v) as object), fixtureId: `b${i}` })),
    ...(ratings ? { ratings } : {})
  })

  it('counts a repaired plan as landed, and a rejected or failed one as not', () => {
    const s = summarise(run(['used', 'repaired', 'rejected', 'error']))
    expect([s.used, s.repaired, s.rejected, s.error, s.landed]).toEqual([1, 1, 1, 1, 2])
  })

  it('calls the bar only once every brief is rated, and only at eight of ten with copy ≥ 3', () => {
    const verdicts = [...Array(8).fill('used'), 'rejected', 'rejected']
    const rated = (copy: number): Record<string, object> =>
      Object.fromEntries(verdicts.map((_, i) => [`b${i}`, { copy }]))
    expect(meetsBar(summarise(run(verdicts)))).toBeNull()
    expect(meetsBar(summarise(run(verdicts, rated(3))))).toBe(true)
    expect(meetsBar(summarise(run(verdicts, rated(2.9))))).toBe(false)
    expect(meetsBar(summarise(run([...Array(7).fill('used'), 'rejected', 'rejected', 'rejected'], rated(4))))).toBe(false)
  })

  it('tallies the "looks automatic" reasons for the model’s ads only', () => {
    const s = summarise(
      run(['used', 'used'], {
        b0: { automatic: [{ which: 'model', reason: 'hero', line: '' }, { which: 'baseline', reason: 'rhythm', line: '' }] },
        b1: { automatic: [{ which: 'model', reason: 'hero', line: '' }] }
      })
    )
    expect(s.reasons).toEqual({ hero: 2 })
  })

  it('writes every run, and escapes a pipe in model text', () => {
    const r = run(['used']) as { results: { reasoning?: string }[] }
    r.results[0].reasoning = 'a | b'
    const md = buildReport([r], 'Findings here.')
    expect(md).toContain('Findings here.')
    expect(md).toContain('a \\| b')
    expect(md).toContain('## r')
  })
})

describe('the blind rating order', () => {
  it('is fixed per brief, and both orders occur across the ten', async () => {
    const ids = (await loadFixtures()).map((f) => f.id)
    const orders = ids.map(modelIsA)
    expect(ids.map(modelIsA)).toEqual(orders)
    expect(orders).toContain(true)
    expect(orders).toContain(false)
  })
})

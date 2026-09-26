import { describe, expect, it } from 'vitest'
import { join, resolve } from 'node:path'
import { evalPath } from './eval/relay'
import { fixtureProblems, loadFixtures, transcriptFor, type Fixture } from './eval/fixtures'
import { headlinesOf } from './eval/pipeline'
import { buildReport, meetsBar, summarise } from '../scripts/eval-report.mjs'
import { modelIsA } from '../scripts/eval-rate.mjs'
import type { Composed } from '@shared/director/compose'

/**
 * The Director eval's own machinery (docs/PLAN.md §3). The eval is only as
 * good as its accounting: a relay that can be talked into writing outside its
 * folder, a fixture that cannot be checked out on Windows, a headline counted
 * against the wrong span or a report that calls a bar met when it was not are
 * each a way to measure the wrong thing and believe it.
 */

describe('the relay writes only inside tests/output/eval', () => {
  // Absolute on THIS platform: '/srv/eval' is drive-relative on Windows, where the relay's
  // `resolve` puts the drive letter on it and a plain `join` of it never could (CI #89).
  const root = resolve('/srv/eval')

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

describe('headlines are counted against the time the engine gave their shot', () => {
  // The engine's timing: slot_01 one second, slot_02 three, slot_03 two. slot_04 was left out.
  const composed = {
    layout: {
      shots: [
        { slotId: 'slot_01', startFrame: 0, endFrame: 30, clipFrames: 30, hero: false },
        { slotId: 'slot_02', startFrame: 30, endFrame: 120, clipFrames: 90, hero: true },
        { slotId: 'slot_03', startFrame: 120, endFrame: 180, clipFrames: 60, hero: false }
      ]
    }
  } as unknown as Composed

  it('each headline against its own shot, in the model’s order', () => {
    const raw = {
      shots: [
        { slot: 'slot_01', role: 'hook', headline: 'A headline that is far too long for one second' },
        { slot: 'slot_02', role: 'product', headline: 'Fits in three seconds' },
        { slot: 'slot_03', role: 'cta', headline: '' }
      ]
    }
    const records = headlinesOf(raw, composed, 30)
    expect(records.map((r) => [r.segment, r.role, r.seconds, r.fits])).toEqual([
      [0, 'hook', 1, false],
      [1, 'product', 3, true]
    ])
    // 1 s is under the card's 1.2 s floor, so it is given the floor's 19 characters, not 16.
    expect(records[0].capacity).toBe(19)
  })

  it('counts what a reader sees: a Telugu line is its graphemes, not its code points', () => {
    const line = 'పెళ్లి కూతురు సిద్ధం'
    const [r] = headlinesOf({ shots: [{ slot: 'slot_03', role: 'cta', headline: line }] }, composed, 30)
    expect(r.chars).toBeLessThan(Array.from(line).length)
  })

  it('a headline on a shot the engine left out, or one not in the menu, has nothing to be timed against', () => {
    const raw = { shots: [{ slot: 'slot_04', role: 'story', headline: 'left out' }, { slot: 'slot_99', role: 'story', headline: 'unknown' }] }
    expect(headlinesOf(raw, composed, 30)).toEqual([])
  })

  it('a plan without shots has no headlines', () => {
    expect(headlinesOf({ reasoning: 'x' }, composed, 30)).toEqual([])
    expect(headlinesOf(null, composed, 30)).toEqual([])
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

describe('the real run’s measurements', () => {
  it('carry every field the gate reads — the backdrop share included — and drop a photo the sidecar could not open', async () => {
    const { measureOf } = await import('./eval/local')
    const m = measureOf({ path: '/p.png', sharpness: 900, luma: 0.94, lumaStd: 0.13, darkClip: 0, brightClip: 0.71, backdropClip: 0.7, dhash: '0c0c', width: 2000, height: 2000 })
    expect(m).toMatchObject({ brightClip: 0.71, backdropClip: 0.7, dhash: '0c0c', width: 2000 })
    // Without the backdrop share, the gate would read the whole 71 % as blown.
    expect(measureOf({ path: '/p.png', sharpness: 1, luma: 0.5, lumaStd: 0.1, darkClip: 0, brightClip: 0.1, width: 1, height: 1 })?.backdropClip).toBeUndefined()
    expect(measureOf({ path: '/p.png', error: 'No such image' })).toBeNull()
    expect(measureOf({ path: '/p.png', sharpness: 1, luma: 0.5 })).toBeNull()
  })
})

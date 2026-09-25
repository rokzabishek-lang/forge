import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { TRANSITIONS, transitionsFromMasks, type TransitionDef } from '@shared/transitions/registry'
import type { MusicAnalysis } from '@shared/automation/cutPlan'
import { SidecarClient } from '../../src/main/sidecar/client'
import { loadFixtures } from './fixtures'
import { FFMPEG, makeFixtureMedia } from './media'
import {
  askNode,
  prepareFixture,
  readJson,
  requestFor,
  scoreFixture,
  writeJson,
  type AnalyseBeats,
  type EvalConfig,
  type EvalRequest,
  type EvalResponse,
  type Prepared,
  type RunRecord
} from './pipeline'
import { EVAL_ROOT } from './relay'
import { recipeById, type RecipeId } from '@shared/director/recipes'

/**
 * `npm run eval` — the Director measured on a real model (docs/PLAN.md §3).
 *
 * Skipped unless FORGE_EVAL names a provider, so `npm test` never waits on a
 * model. The environment:
 *
 *   FORGE_EVAL          openai | ollama        (the API shape; LM Studio is openai)
 *   FORGE_EVAL_MODEL    e.g. google/gemma-4-e2b, gemma4:e2b
 *   FORGE_EVAL_THINK    on | off               (Ollama only; default off)
 *   FORGE_EVAL_SERVER   default http://127.0.0.1:1234 (openai) or :11434 (ollama)
 *   FORGE_EVAL_RUN      the run's name; default a timestamp
 *   FORGE_EVAL_STEP     prepare | score | all  (default all)
 *   FORGE_EVAL_ONLY     comma-separated fixture ids
 *   FORGE_EVAL_MEDIA    a folder of real photos, <fixture-id>/<name>
 *   FORGE_EVAL_RENDER   off to skip the renders
 *   FORGE_EVAL_RECIPE   a recipe id to pin, as the panel's Recipe picker does (default: the model chooses)
 *
 * `all` asks from node. Where node cannot reach the model — the development
 * sandbox — run `prepare`, then `window.__forgeEvalRelay('<run>')` in the
 * harness page (it posts each prepared body through the harness server), then
 * `score`. Both routes send the same bytes: the bodies are built by the app's
 * own `openaiRequestBody` / `ollamaRequestBody`.
 */

const PROVIDER = process.env.FORGE_EVAL as EvalConfig['provider'] | undefined
const STEP = (process.env.FORGE_EVAL_STEP ?? 'all') as 'prepare' | 'score' | 'all'
const REPO = resolve(__dirname, '..', '..')
const SIDECAR_DIR = join(REPO, 'sidecar')
const VENV_PYTHON = join(SIDECAR_DIR, '.venv', 'bin', 'python')

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
}

/** The library's wipes, when the library is on this machine. */
async function libraryTransitions(): Promise<{ transitions: TransitionDef[]; resolveAsset?: (rel: string) => string }> {
  const root = process.env.FORGE_ASSETS_DIR ?? join(REPO, 'assets')
  if (!existsSync(join(root, 'transitions'))) return { transitions: [] }
  process.env.FORGE_ASSETS_DIR = root
  const { scanAssets, resolveAssetFile } = await import('../../src/main/assets/scan')
  const { entriesOfKind } = await import('@shared/assets/catalog')
  const catalog = await scanAssets(root)
  const masks = entriesOfKind(catalog, 'transition').map((e) => ({ id: e.id, name: e.name, file: e.file }))
  return { transitions: transitionsFromMasks(masks), resolveAsset: resolveAssetFile }
}

/** Beats through the sidecar, as the app gets them — or null when the sidecar cannot. */
async function sidecarBeats(): Promise<{ analyse: AnalyseBeats | null; stop: () => void; note: string | null }> {
  const python = existsSync(VENV_PYTHON) ? VENV_PYTHON : process.env.FORGE_PYTHON
  if (!python) return { analyse: null, stop: () => undefined, note: 'no Python for the sidecar' }
  const client = new SidecarClient({ cwd: SIDECAR_DIR, python, maxRestarts: 0 })
  try {
    const hello = await client.start()
    if (!hello.capabilities.includes('audio.beats') || hello.degraded['audio.beats']) {
      client.stop()
      return { analyse: null, stop: () => undefined, note: hello.degraded['audio.beats'] ?? 'audio.beats is not available' }
    }
  } catch (err) {
    client.stop()
    return { analyse: null, stop: () => undefined, note: err instanceof Error ? err.message : String(err) }
  }
  const analyse: AnalyseBeats = (path, window) =>
    client.request<MusicAnalysis>('audio.beats', { path, ffmpeg: FFMPEG, ...window }, { timeoutMs: 300_000 })
  return { analyse, stop: () => client.stop(), note: null }
}

describe.skipIf(!PROVIDER)('the Director on a real model', () => {
  it(
    'prepares, asks and scores every brief',
    async () => {
      const config: EvalConfig = {
        provider: PROVIDER!,
        model: process.env.FORGE_EVAL_MODEL ?? '',
        think: process.env.FORGE_EVAL_THINK === 'on'
      }
      expect(config.model, 'FORGE_EVAL_MODEL names the model').not.toBe('')
      const server =
        process.env.FORGE_EVAL_SERVER ?? (config.provider === 'openai' ? 'http://127.0.0.1:1234' : 'http://127.0.0.1:11434')
      const runId = process.env.FORGE_EVAL_RUN ?? `${stamp()}-${config.provider}-${config.model.replace(/[^a-z0-9.-]+/gi, '_')}-${config.think ? 'think' : 'nothink'}`
      const runDir = join(EVAL_ROOT, runId)
      const only = new Set((process.env.FORGE_EVAL_ONLY ?? '').split(',').map((s) => s.trim()).filter(Boolean))
      const fixtures = (await loadFixtures()).filter((f) => only.size === 0 || only.has(f.id))
      const library = await libraryTransitions()
      const transitions = [...TRANSITIONS, ...library.transitions]
      const pinned = (process.env.FORGE_EVAL_RECIPE ?? '') || null
      expect(pinned === null || recipeById(pinned) !== null, `FORGE_EVAL_RECIPE ${pinned} is not a recipe`).toBe(true)

      /* prepare */
      if (STEP === 'prepare' || STEP === 'all') {
        const beats = await sidecarBeats()
        try {
          const requests: EvalRequest[] = []
          for (const fixture of fixtures) {
            const made = await makeFixtureMedia(fixture, join(EVAL_ROOT, 'media', fixture.id))
            const prepared = await prepareFixture(fixture, made, { analyseBeats: beats.analyse, transitions, pinned: pinned as RecipeId | null })
            if (beats.note && !prepared.beatsNote) prepared.beatsNote = beats.note
            await writeJson(join(runDir, 'prepared', `${fixture.id}.json`), prepared)
            requests.push(requestFor(prepared, config))
          }
          await writeJson(join(runDir, 'requests.json'), requests)
          await writeJson(join(runDir, 'config.json'), { ...config, server, runId })
        } finally {
          beats.stop()
        }
      }

      /* ask, from node */
      if (STEP === 'all') {
        const requests = (await readJson<EvalRequest[]>(join(runDir, 'requests.json'))) ?? []
        for (const request of requests) {
          const file = join(runDir, 'responses', `${request.id}.json`)
          if (existsSync(file)) continue
          await writeJson(file, await askNode(request, server))
        }
      }

      /* score */
      if (STEP === 'score' || STEP === 'all') {
        const requests = (await readJson<EvalRequest[]>(join(runDir, 'requests.json'))) ?? []
        const results = []
        const byId = new Map(fixtures.map((f) => [f.id, f]))
        let real = false
        for (const request of requests) {
          const fixture = byId.get(request.fixtureId)
          if (!fixture) continue
          const prepared = await readJson<Prepared>(join(runDir, 'prepared', `${fixture.id}.json`))
          if (!prepared) throw new Error(`${fixture.id} was never prepared in ${runId}`)
          real ||= prepared.realMedia.length > 0
          const response = await readJson<EvalResponse>(join(runDir, 'responses', `${request.id}.json`))
          const result = await scoreFixture(fixture, prepared, request, response, {
            model: config.model,
            render:
              process.env.FORGE_EVAL_RENDER === 'off'
                ? null
                : { dir: join(runDir, 'renders'), extraTransitions: library.transitions, resolveAsset: library.resolveAsset }
          })
          results.push({
            ...result,
            renders: {
              model: result.renders.model && relative(REPO, result.renders.model),
              baseline: result.renders.baseline && relative(REPO, result.renders.baseline)
            }
          })
        }
        const record: RunRecord = {
          run: runId,
          stamp: new Date().toISOString(),
          provider: config.provider,
          model: config.model,
          think: config.think,
          server,
          transport: STEP === 'all' ? 'node' : 'relay',
          catalogue: { builtIn: TRANSITIONS.length, library: library.transitions.length },
          media: real ? 'mixed' : 'synthetic',
          results
        }
        await writeJson(join(runDir, 'results.json'), record)
        await writeJson(join(REPO, 'eval', 'runs', `${runId}.json`), record)
        await writeFile(
          join(runDir, 'README.md'),
          [
            `# ${runId}`,
            '',
            `${config.provider} · ${config.model} · think ${config.think ? 'on' : 'off'} · ${record.transport}`,
            '',
            'renders/<brief>.model.mp4 is the model\'s ad; <brief>.baseline.mp4 the standard cut from the same menu.',
            'Each is a spine@2 ad, timed by the rhythm engine: the black, the end card\'s ground and the recipe\'s look',
            'are drawn. The headline cards are drawn by the renderer in the app, so they are not in these renders — the',
            'headlines are in results.json, and `npm run eval:rate` shows them.',
            ''
          ].join('\n')
        )
        const counts = results.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.verdict]: (acc[r.verdict] ?? 0) + 1 }), {})
        console.log(`${runId}: ${JSON.stringify(counts)}`)
        expect(results.length).toBe(requests.length)
      }
    },
    3_600_000
  )
})

/**
 * `FORGE_EVAL_LOOKS=<folder> npm run eval` — the look pass (docs/PLAN.md §4.1)
 * on every picture in a folder, one image a call, built with the app's own
 * `encodeImages`, `lookPrompt`, `lookSchema` and request body. STEP=prepare
 * writes the requests (ask them with the relay), STEP=score reads the answers
 * into results-looks.json. The VLM half of C0: time and tokens per picture,
 * and — with a person's ground truth beside it — whether the eyes see.
 */
const LOOKS = process.env.FORGE_EVAL_LOOKS
describe.skipIf(!PROVIDER || !LOOKS)('the look pass on a real model', () => {
  it(
    'prepares or scores one look per picture',
    async () => {
      const { readdir } = await import('node:fs/promises')
      const { encodeImages } = await import('../../src/main/director')
      const { lookPrompt, lookSchema, readLook, LOOK_MAX_TOKENS } = await import('@shared/director/look')
      const { openaiRequestBody, ollamaRequestBody, openaiAnswer, ollamaAnswer, parseModelJson } = await import('@shared/director/provider')
      const runId = process.env.FORGE_EVAL_RUN ?? `looks-${stamp()}`
      const runDir = join(EVAL_ROOT, runId)
      const openai = PROVIDER === 'openai'
      const model = process.env.FORGE_EVAL_MODEL ?? ''
      const files = (await readdir(LOOKS!)).filter((f) => /\.(jpe?g|png|webp)$/i.test(f)).sort()

      if (STEP === 'prepare' || STEP === 'all') {
        const { system, user } = lookPrompt({ product: process.env.FORGE_EVAL_PRODUCT ?? 'a wedding film', language: 'English' })
        const requests: EvalRequest[] = []
        for (const f of files) {
          const images = await encodeImages([join(LOOKS!, f)])
          const request = { system, user, schema: lookSchema(), maxTokens: LOOK_MAX_TOKENS, think: false }
          requests.push({
            id: `look.${f}`,
            fixtureId: f,
            provider: PROVIDER!,
            path: openai ? '/v1/chat/completions' : '/api/chat',
            body: openai ? openaiRequestBody(request, images, model) : ollamaRequestBody(request, images, model)
          })
        }
        await writeJson(join(runDir, 'requests.json'), requests)
      }
      if (STEP === 'score' || STEP === 'all') {
        const requests = (await readJson<EvalRequest[]>(join(runDir, 'requests.json'))) ?? []
        const results = []
        for (const r of requests) {
          const response = await readJson<EvalResponse>(join(runDir, 'responses', `${r.id}.json`))
          let look = null
          let why: string | null = null
          let tokens: [number | null, number | null] = [null, null]
          try {
            if (!response || response.status !== 200) throw new Error(response?.error ?? `status ${response?.status}`)
            const answer = openai ? openaiAnswer(response.data) : ollamaAnswer(response.data)
            tokens = [answer.promptTokens, answer.outputTokens]
            const parsed = parseModelJson(answer.text)
            look = 'error' in parsed ? null : readLook(parsed.value)
            if (!look) why = 'error' in parsed ? parsed.error : 'not a look'
          } catch (err) {
            why = err instanceof Error ? err.message : String(err)
          }
          results.push({ picture: r.fixtureId, ms: response?.ms ?? 0, promptTokens: tokens[0], outputTokens: tokens[1], look, why })
        }
        await writeJson(join(runDir, 'results-looks.json'), { run: runId, model, results })
        console.log(JSON.stringify(results, null, 1))
      }
    },
    3_600_000
  )
})

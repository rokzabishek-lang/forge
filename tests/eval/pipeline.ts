import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, join } from 'node:path'
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg'
import { emptyProject, type Clip, type MediaAsset, type Project, type TextSpec } from '@shared/timeline'
import type { MusicAnalysis } from '@shared/automation/cutPlan'
import type { Slot } from '@shared/director/menu'
import { maxTokensFor2, spine2Prompt } from '@shared/director/prompt2'
import { SPINE2_PASS, spine2Schema, type Menu2, type SpinePlan2 } from '@shared/director/schema2'
import type { Brief } from '@shared/director/schema'
import { headlineCapacity } from '@shared/director/validate'
import { applyRecipe } from '@shared/director/apply2'
import { COPY_RULE, LOOK_RULE } from '@shared/director/apply'
import { graphemes, type Composed } from '@shared/director/compose'
import { gate } from '@shared/director/gate'
import { recipeById, type Recipe, type RecipeId } from '@shared/director/recipes'
import type { Grid } from '@shared/director/rhythm'
import { bakeForExport, exportBakeSizes } from '@shared/render/exportBake'
import { cubeFor, lookById } from '@shared/render/looks'
import {
  ollamaAnswer,
  ollamaRequestBody,
  openaiAnswer,
  openaiRequestBody,
  parseModelJson,
  type ModelAnswer
} from '@shared/director/provider'
import { adSeconds, briefFor, buildSlots, expectedRecipe, gridsFor, menu2For, musicFor, settle2, type Settled2 } from '@shared/director/run'
import { buildRenderPlan } from '@shared/render/plan'
import type { TransitionDef } from '@shared/transitions/registry'
import { probeMany } from '../../src/main/ffmpeg/probe'
import { toAsset } from '../../src/main/assets'
import { transcriptFor, type Fixture } from './fixtures'
import type { Made } from './media'

/**
 * The Director eval, in three steps (docs/PLAN.md §3.2).
 *
 *   prepare  a fixture becomes a project, a menu, a prompt and the exact HTTP
 *            body the app would send — built by the app's own functions
 *            (shared/director/run.ts, prompt.ts, provider.ts)
 *   ask      the body goes to the model: from node on the user's machine, or
 *            through the harness relay where the shell cannot reach localhost
 *   score    the raw answer is read, parsed and settled as `direct()`
 *            settles it (shared/director/run.ts `settle2`: validated and
 *            timed by the rhythm engine, the standard cut when it cannot be
 *            used), and the model's ad and the standard cut are both applied
 *            and rendered for rating
 *
 * Every step writes its output to a file, so a run can be resumed, re-scored
 * without asking again, and read afterwards.
 */

const run = promisify(execFile)
const FFMPEG: string = ffmpegInstaller.path

export type EvalProvider = 'openai' | 'ollama'

export interface EvalConfig {
  provider: EvalProvider
  model: string
  think: boolean
}

export interface Prepared {
  fixtureId: string
  /** The plan format the request asks for. */
  pass: typeof SPINE2_PASS
  brief: Brief
  project: Project
  videoTrackId: string
  musicClipId: string | null
  /** The installed transitions the menu's families came from. */
  catalogue: { id: string; family: string }[]
  /** Where the cut menu came from: the sidecar's beat analysis, or the even grid without it. */
  beats: 'analysed' | 'grid'
  beatsNote: string | null
  realMedia: string[]
  /**
   * What the menu is rebuilt from when scoring. A recipe carries its pacing as
   * a function, which JSON drops, so the menu itself is not saved — the app's
   * own `menu2For` rebuilds it from these, the same every time (menuOf).
   */
  analysis: MusicAnalysis | null
  gated: { slots: Slot[]; heroCandidates: string[] }
  /** What the gate left out and why — as `direct()` notes it. */
  gateNotes: string[]
  /** A recipe pinned for the run (FORGE_EVAL_RECIPE), or null: the model chooses. */
  pinned: RecipeId | null
}

/** The run's menu and grids, rebuilt from a prepared brief by the app's own functions. */
export function menuOf(prepared: Prepared): { menu: Menu2; grids: (recipe: Recipe) => Grid } {
  const grids = gridsFor(prepared.project, musicFor(prepared.project), prepared.analysis, prepared.brief.seconds)
  const pinned = prepared.pinned ? recipeById(prepared.pinned) : null
  return { menu: menu2For(prepared.project, prepared.gated, grids, prepared.brief, { pinned }), grids }
}

export interface EvalRequest {
  id: string
  fixtureId: string
  provider: EvalProvider
  /** Path on the model server. */
  path: string
  body: object
}

export interface EvalResponse {
  id: string
  status: number
  ms: number
  data?: unknown
  error?: string
}

export interface HeadlineRecord {
  /** The shot's index in the model's plan. */
  segment: number
  role: string
  text: string
  chars: number
  seconds: number
  capacity: number
  fits: boolean
}

export type Verdict = 'used' | 'repaired' | 'rejected' | 'error'

export interface BriefResult {
  fixtureId: string
  kind: Fixture['kind']
  language: string
  tone: string
  seconds: number
  slots: number
  /** The legal cuts: every beat of the tone's recipe's grid. */
  cuts: number
  beats: Prepared['beats']
  pass: typeof SPINE2_PASS
  /** The recipe that directed the ad that landed, and the picture it was built around. */
  recipe: RecipeId
  hero: string
  status: number
  ms: number
  promptTokens: number | null
  outputTokens: number | null
  truncated: boolean
  parsed: boolean
  verdict: Verdict
  /** Why it was rejected, or what went wrong reaching the model. */
  why: string | null
  /** The validator's repairs, as sentences. */
  problems: string[]
  reasoning: string | null
  /** Every headline the model wrote, before repairs, against the time the engine gave its shot. */
  headlines: HeadlineRecord[]
  /** The plan that was applied — the model's, or the standard cut's — as the engine laid it out. */
  applied: SpinePlan2
  /** The standard cut from the same menu: what the model's ad is rated against. */
  baseline: SpinePlan2
  /** Where each shot of the ad that landed starts and ends, in frames. */
  timing: { slot: string; startFrame: number; endFrame: number; hero: boolean }[]
  renders: { model: string | null; baseline: string | null }
  raw: string | null
}

/* ---------------------------------------------------------------- prepare */

/** A catalogue of transitions: the built-ins, plus the library's wipes when there is one. */
export function catalogueOf(transitions: TransitionDef[]): { id: string; family: string }[] {
  return transitions.map((t) => ({ id: t.id, family: t.family }))
}

/** The beat analysis for the music, or null — with the reason, which the run records. */
export type AnalyseBeats = (path: string, window: { startMs: number; endMs: number }) => Promise<MusicAnalysis>

export async function prepareFixture(
  fixture: Fixture,
  made: Made,
  options: { analyseBeats: AnalyseBeats | null; transitions: TransitionDef[]; pinned?: RecipeId | null }
): Promise<Prepared> {
  const fps = 30
  const base = emptyProject(fixture.id)
  const project: Project = {
    ...base,
    id: `eval-${fixture.id}`,
    // An ad for a phone: the shape every brief here is for.
    settings: { ...base.settings, width: 1080, height: 1920, fps }
  }

  const paths = fixture.media.map((m) => made.media.get(m.name)!)
  const { ok, failed } = await probeMany([...paths, made.music])
  if (failed.length > 0) throw new Error(`${fixture.id}: could not probe ${failed.map((f) => f.path).join(', ')}`)
  const byPath = new Map(ok.map((info) => [info.path, info]))

  // Stable ids, so a run's plans and renders are comparable across runs.
  const assets: MediaAsset[] = fixture.media.map((m, i) => ({
    ...toAsset(byPath.get(paths[i])!, fps),
    id: `a${String(i + 1).padStart(2, '0')}`,
    name: m.name
  }))
  const musicAsset: MediaAsset = { ...toAsset(byPath.get(made.music)!, fps), id: 'music', name: 'music.wav' }

  const musicClip: Clip = {
    id: 'music-clip',
    assetId: musicAsset.id,
    trackId: 'a1',
    start: 0,
    duration: musicAsset.durationFrames,
    inPoint: 0,
    volume: 1,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    color: { brightness: 0, contrast: 1, saturation: 1 }
  }

  const transcripts: Project['transcripts'] = {}
  fixture.media.forEach((m, i) => {
    if (m.kind === 'video' && m.speech) {
      transcripts[assets[i].id] = transcriptFor(assets[i].id, m.speech, m.seconds ?? 4, 'en')
    }
  })

  const withMedia: Project = { ...project, assets: [...assets, musicAsset], clips: [musicClip], transcripts }
  const notes = Object.fromEntries(fixture.media.map((m, i) => [assets[i].id, m.note]))

  /* From here, exactly what `direct()` does before it asks. */
  const slots = buildSlots(withMedia, notes)
  const music = musicFor(withMedia)
  const pinnedRecipe = options.pinned ? recipeById(options.pinned) : null
  const seconds = adSeconds({ seconds: fixture.brief.seconds }, music, expectedRecipe({ ...fixture.brief, benefit: fixture.brief.benefit ?? '', audience: fixture.brief.audience ?? '', cta: fixture.brief.cta ?? '' }, pinnedRecipe))

  let analysis: MusicAnalysis | null = null
  let beatsNote: string | null = null
  if (music && options.analyseBeats) {
    try {
      analysis = await options.analyseBeats(music.asset.path, { startMs: music.startMs, endMs: music.endMs })
    } catch (err) {
      beatsNote = `beat analysis failed: ${err instanceof Error ? err.message : String(err)}`
    }
  } else if (!options.analyseBeats) {
    beatsNote = 'no beat analysis available — the even grid'
  }

  const catalogue = catalogueOf(options.transitions)
  const brief = briefFor({ ...fixture.brief, seconds: fixture.brief.seconds }, seconds)
  // The gate as `direct()` runs it when the eyes saw nothing: no looks, no measures.
  const gated = gate(slots, {}, {}, { wantsPeople: false })

  return {
    fixtureId: fixture.id,
    pass: SPINE2_PASS,
    brief,
    project: withMedia,
    videoTrackId: 'v1',
    musicClipId: music?.clip.id ?? null,
    catalogue,
    beats: analysis ? 'analysed' : 'grid',
    beatsNote,
    realMedia: made.real,
    analysis,
    gated: { slots: gated.slots, heroCandidates: gated.heroCandidates },
    gateNotes: [...gated.leftOut.map((l) => `${l.slot} left out — ${l.why}`), ...gated.loosened],
    pinned: options.pinned ?? null
  }
}

/** The exact request the app would send for this menu. */
export function requestFor(prepared: Prepared, config: EvalConfig): EvalRequest {
  const { menu } = menuOf(prepared)
  const { system, user } = spine2Prompt(prepared.brief, menu)
  const request = {
    system,
    user,
    schema: spine2Schema(menu),
    maxTokens: maxTokensFor2(menu),
    think: config.think
  }
  const openai = config.provider === 'openai'
  return {
    id: `${prepared.fixtureId}.spine2`,
    fixtureId: prepared.fixtureId,
    provider: config.provider,
    path: openai ? '/v1/chat/completions' : '/api/chat',
    body: openai ? openaiRequestBody(request, [], config.model) : ollamaRequestBody(request, [], config.model)
  }
}

/* -------------------------------------------------------------------- ask */

/** One request, from node. The transport on a machine that can reach the model. */
export async function askNode(request: EvalRequest, server: string, timeoutMs = 300_000): Promise<EvalResponse> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const started = Date.now()
  try {
    const response = await fetch(`${server.replace(/\/+$/, '')}${request.path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request.body),
      signal: controller.signal
    })
    const text = await response.text()
    let data: unknown
    try {
      data = JSON.parse(text)
    } catch {
      return { id: request.id, status: response.status, ms: Date.now() - started, error: text.slice(0, 400) }
    }
    return { id: request.id, status: response.status, ms: Date.now() - started, data }
  } catch (err) {
    return { id: request.id, status: 0, ms: Date.now() - started, error: err instanceof Error ? err.message : String(err) }
  } finally {
    clearTimeout(timer)
  }
}

/* ------------------------------------------------------------------ score */

/**
 * The model's headlines against the time the engine gave each shot.
 *
 * Measured on the RAW plan, before anything drops the long ones, because
 * "wrote a headline too long for its shot" is a finding about the model and
 * the settled plan hides it. A card never outlasts its shot, so the shot's
 * span is the most time a headline can have — the same bound compose.ts
 * checks, counted in graphemes as it counts them. A headline on a shot the
 * engine left out, or the validator removed, gets no record: nothing timed it.
 */
export function headlinesOf(raw: unknown, composed: Pick<Composed, 'layout'>, fps: number): HeadlineRecord[] {
  const shots = (raw as { shots?: unknown })?.shots
  if (!Array.isArray(shots)) return []
  const spans = new Map(composed.layout.shots.map((s) => [s.slotId, (s.endFrame - s.startFrame) / fps]))
  const out: HeadlineRecord[] = []
  shots.forEach((s, i) => {
    const shot = s as { slot?: unknown; role?: unknown; headline?: unknown }
    const text = typeof shot.headline === 'string' ? shot.headline.trim() : ''
    const seconds = typeof shot.slot === 'string' ? spans.get(shot.slot) : undefined
    if (!text || seconds === undefined) return
    const capacity = headlineCapacity(seconds)
    const chars = graphemes(text)
    out.push({ segment: i, role: typeof shot.role === 'string' ? shot.role : '', text, chars, seconds, capacity, fits: chars <= capacity })
  })
  return out
}

function answerOf(provider: EvalProvider, data: unknown): ModelAnswer {
  return provider === 'openai' ? openaiAnswer(data) : ollamaAnswer(data)
}

/** Clip ids an eval can predict. */
function counter(): (prefix: string) => string {
  let n = 0
  return (prefix) => `${prefix}-${++n}`
}

/**
 * The recipe's look as a file an eval render can read: the same generated
 * .cube the app writes on launch (main/looks.ts), written beside the renders.
 */
export async function lookFileFor(recipe: Recipe, dir: string): Promise<{ file: string; name: string } | null> {
  const look = recipe.look === 'none' ? undefined : lookById(recipe.look)
  if (!look) return null
  const file = join(dir, 'looks', `${look.id}.cube`)
  if (!existsSync(file)) {
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, cubeFor(look), 'utf8')
  }
  return { file, name: look.name }
}

/** Apply a settled ad the way `direct()` does. */
export function applied(prepared: Prepared, composed: Composed, menu: Menu2, model: string, lookFile: { file: string; name: string } | null): Project {
  return applyRecipe(prepared.project, composed, menu, {
    fps: menu.fps,
    videoTrackId: prepared.videoTrackId,
    brief: prepared.brief,
    model,
    catalogue: prepared.catalogue,
    ...(prepared.musicClipId ? { musicClipId: prepared.musicClipId } : {}),
    parallaxAssets: new Set(),
    lookFile,
    newId: counter()
  }).project
}

const RENDER_CANVAS = { width: 540, height: 960 }

/** One headline card for the harness to draw (`__forgeEvalCards`, evalRelay.ts): the spec, the size, and where the PNG goes, relative to the run. */
export interface CardRequest {
  id: string
  /** `cards/model/dir-card-1.png` — a run-relative path with forward slashes, which is what the relay's URL carries. */
  file: string
  spec: TextSpec
  width: number
  height: number
}

/**
 * The headline cards an applied ad carries, each at the size the export would
 * draw it (`exportBakeSizes`, the same call `renderEval` makes through
 * `bakeForExport`), so the drawn PNG is exactly the still the render expects.
 */
export function cardsOf(project: Project, canvas: { width: number; height: number }, dir: string): CardRequest[] {
  const { stills } = exportBakeSizes(project.settings, canvas)
  return project.clips
    .filter((c): c is Clip & { text: TextSpec } => c.generatedBy?.rule === COPY_RULE && c.text !== undefined)
    .map((c) => ({ id: c.id, file: `${dir}/${c.id}.png`, spec: c.text, width: stills.width, height: stills.height }))
}

/** A still of one colour, or the transparent square an adjustment layer carries — what the store draws, drawn with ffmpeg. */
async function drawSolid(file: string, color: string, opacity: number, width: number, height: number): Promise<string> {
  await mkdir(dirname(file), { recursive: true })
  const alpha = Math.max(0, Math.min(1, opacity)).toFixed(3)
  await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${color.replace('#', '0x')}@${alpha}:s=${width}x${height},format=rgba`, '-frames:v', '1', file])
  return file
}

/**
 * Render an applied project, small.
 *
 * Node has no canvas, so the headline cards — which the app draws in the
 * renderer — are left out and rated as text (the run's README says so). The
 * colour cards and the look layer's own picture are drawn here with ffmpeg,
 * as the store draws them in the app, so the black, the end card's ground and
 * the recipe's grade are all in the render.
 */
export async function renderEval(
  project: Project,
  out: string,
  options: {
    extraTransitions: TransitionDef[]
    resolveAsset?: (rel: string) => string
    /**
     * A folder of headline cards drawn by the app's own text renderer, one
     * `<clip id>.png` each (the harness's `__forgeEvalCards`, evalRelay.ts). A card
     * with its picture there is rendered; one without is left out, as before.
     */
    cards?: string
    canvas?: { width: number; height: number }
  }
): Promise<void> {
  const canvas = options.canvas ?? RENDER_CANVAS
  const drawnCard = (id: string): string | null => {
    const file = options.cards ? join(options.cards, `${id}.png`) : null
    return file && existsSync(file) ? file : null
  }
  const cards = new Set(project.clips.filter((c) => c.generatedBy?.rule === COPY_RULE && !drawnCard(c.id)).map((c) => c.id))
  const without: Project = { ...project, clips: project.clips.filter((c) => !cards.has(c.id)) }
  const drawn = join(dirname(out), 'drawn')
  const looks = new Set(without.clips.filter((c) => c.generatedBy?.rule === LOOK_RULE).map((c) => c.assetId))
  const blank = looks.size > 0 ? await drawSolid(join(drawn, 'adjustment.png'), '#000000', 0, 16, 16) : ''
  const withLook: Project = { ...without, assets: without.assets.map((a) => (looks.has(a.id) ? { ...a, path: blank, width: 16, height: 16 } : a)) }
  const unused = async (): Promise<never> => {
    throw new Error('not drawn in an eval render')
  }
  const baked = await bakeForExport(withLook, canvas, {
    solid: (spec, key, w, h) => drawSolid(join(drawn, `${key}.png`), spec.color, spec.opacity, w, h),
    // The card the harness drew for this clip (key is `<clip id>-export`, exportBake.ts); stills only.
    text: async (_spec, key) => drawnCard(key.replace(/-export$/, '')) ?? unused(),
    textSequence: async () => null,
    title: unused, paper: unused, carousel: unused
  }, (clip, err) => {
    throw new Error(`${clip.id} could not be drawn: ${String(err)}`)
  })
  const plan = buildRenderPlan({
    project: baked,
    outputPath: out,
    canvas,
    extraTransitions: options.extraTransitions,
    ...(options.resolveAsset ? { resolveAsset: options.resolveAsset } : {})
  })
  await mkdir(dirname(out), { recursive: true })
  await run(FFMPEG, plan.args, { maxBuffer: 64 * 1024 * 1024 })
}

/** A problem the model caused, as opposed to a note about the music (the engine's layout notes and dropped shots). */
const isRepair = (p: { path: string }): boolean => p.path !== '$.layout' && p.path !== '$.shots'

export interface SettledAnswer {
  menu: Menu2
  grids: (recipe: Recipe) => Grid
  answer: ModelAnswer | null
  raw: unknown
  parsed: boolean
  verdict: Verdict
  why: string | null
  /** The validator's repairs and the engine's notes, as sentences. */
  problems: string[]
  /** The model's plan, settled — null when it could not be used. */
  settled: Settled2 | null
  /** The standard cut from the same menu: what a rejected plan becomes, and what every plan is rated against. */
  standard: Settled2
  /** The ad that landed: the model's, or the standard cut. */
  landed: Settled2
}

/** The model's raw answer, read and settled exactly as `direct()` settles it, with the standard cut beside it. */
export function settleAnswer(prepared: Prepared, request: EvalRequest, response: EvalResponse | null): SettledAnswer {
  const { brief } = prepared
  const { menu, grids } = menuOf(prepared)
  const extras = { installed: new Set(prepared.catalogue.map((c) => c.family)) }
  let answer: ModelAnswer | null = null
  let why: string | null = null
  let verdict: Verdict = 'error'
  let raw: unknown = null
  let parsed = false
  let settled: Settled2 | null = null
  let problems: string[] = []
  const describe = (p: { path: string; message: string }): string => `${p.path.replace(/^\$\.?/, '')}: ${p.message}`

  if (!response) why = 'no answer was recorded'
  else if (response.error) why = response.error
  else if (response.status !== 200) why = `the server returned ${response.status}`
  else {
    try {
      answer = answerOf(request.provider, response.data)
    } catch (err) {
      why = err instanceof Error ? err.message : String(err)
    }
  }

  if (answer) {
    const json = parseModelJson(answer.text)
    if ('error' in json) {
      verdict = 'rejected'
      why = json.error
    } else {
      parsed = true
      raw = json.value
      settled = settle2({ value: json.value, truncated: answer.truncated }, menu, brief, grids, extras)
      problems = settled.problems.map(describe)
      if (settled.baseline) {
        verdict = 'rejected'
        why = settled.rejected
        settled = null
      } else {
        verdict = settled.problems.some(isRepair) ? 'repaired' : 'used'
      }
    }
  }

  const standard = settle2({ error: 'the standard cut' }, menu, brief, grids, extras)
  return { menu, grids, answer, raw, parsed, verdict, why, problems, settled, standard, landed: settled ?? standard }
}

export interface RenderOptions {
  dir: string
  extraTransitions: TransitionDef[]
  resolveAsset?: (rel: string) => string
  /** The render's size; the small 540×960 unless said otherwise. */
  canvas?: { width: number; height: number }
  /** Folders of drawn headline cards, one for each ad (renderEval's `cards`). */
  cards?: { model?: string; baseline?: string }
}

export async function scoreFixture(
  fixture: Pick<Fixture, 'id' | 'kind'>,
  prepared: Prepared,
  request: EvalRequest,
  response: EvalResponse | null,
  options: { model: string; render: RenderOptions | null }
): Promise<BriefResult> {
  const { brief } = prepared
  const { menu, grids, answer, raw, parsed, verdict, why, problems, settled, standard, landed } = settleAnswer(prepared, request, response)

  const renders: BriefResult['renders'] = { model: null, baseline: null }
  if (options.render) {
    const { dir, extraTransitions, resolveAsset, canvas, cards } = options.render
    const renderOptions = (drawn: string | undefined): Parameters<typeof renderEval>[2] => ({
      extraTransitions,
      ...(resolveAsset ? { resolveAsset } : {}),
      ...(canvas ? { canvas } : {}),
      ...(drawn ? { cards: drawn } : {})
    })
    renders.baseline = join(dir, `${fixture.id}.baseline.mp4`)
    const standardLook = await lookFileFor(standard.composed.recipe, dir)
    await renderEval(applied(prepared, standard.composed, menu, 'baseline', standardLook), renders.baseline, renderOptions(cards?.baseline))
    if (settled) {
      renders.model = join(dir, `${fixture.id}.model.mp4`)
      const look = await lookFileFor(settled.composed.recipe, dir)
      await renderEval(applied(prepared, settled.composed, menu, options.model, look), renders.model, renderOptions(cards?.model))
    }
  }

  return {
    fixtureId: fixture.id,
    kind: fixture.kind,
    language: brief.language,
    tone: brief.tone,
    seconds: brief.seconds,
    slots: menu.slots.length,
    cuts: grids(menu.fallback).beats.length,
    beats: prepared.beats,
    pass: SPINE2_PASS,
    recipe: landed.composed.recipe.id,
    hero: landed.composed.plan.hero,
    status: response?.status ?? 0,
    ms: response?.ms ?? 0,
    promptTokens: answer?.promptTokens ?? null,
    outputTokens: answer?.outputTokens ?? null,
    truncated: answer?.truncated ?? false,
    parsed,
    verdict,
    why,
    problems,
    reasoning: settled?.composed.plan.reasoning ?? (typeof (raw as { reasoning?: unknown })?.reasoning === 'string' ? (raw as { reasoning: string }).reasoning : null),
    // Timed as the plan would have been: the model's own layout when it landed, else the standard cut's.
    headlines: headlinesOf(raw, landed.composed, menu.fps),
    applied: landed.composed.plan,
    baseline: standard.composed.plan,
    timing: landed.composed.layout.shots.map((s) => ({ slot: s.slotId, startFrame: s.startFrame, endFrame: s.endFrame, hero: s.hero })),
    renders,
    raw: answer?.text ?? null
  }
}

/* ------------------------------------------------------------------ files */

export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
}

export async function readJson<T>(path: string): Promise<T | null> {
  if (!existsSync(path)) return null
  return JSON.parse(await readFile(path, 'utf8')) as T
}

/** A run's whole record, as committed under eval/runs/. */
export interface RunRecord {
  run: string
  stamp: string
  provider: EvalProvider
  model: string
  think: boolean
  server: string
  transport: 'node' | 'relay'
  catalogue: { builtIn: number; library: number }
  media: 'synthetic' | 'mixed'
  results: BriefResult[]
  /** Filled in by `npm run eval:rate`. */
  ratings?: Record<string, Rating>
}

export interface Rating {
  /** Copy, 1–5, blind. */
  copy?: number
  baselineCopy?: number
  /** Which render the rater preferred, blind. */
  preferred?: 'model' | 'baseline' | 'same'
  /** When the rater said an ad looks automatic: why, from the fixed list (docs/PLAN.md §0). */
  automatic?: { which: 'model' | 'baseline'; reason: AutomaticReason; line: string }[]
}

export const AUTOMATIC_REASONS = ['hero', 'hold', 'every-cut', 'rhythm', 'type', 'sound', 'copy', 'other'] as const
export type AutomaticReason = (typeof AUTOMATIC_REASONS)[number]

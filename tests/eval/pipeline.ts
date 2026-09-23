import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, join } from 'node:path'
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg'
import { emptyProject, type Clip, type MediaAsset, type Project } from '@shared/timeline'
import type { MusicAnalysis } from '@shared/automation/cutPlan'
import type { Menu } from '@shared/director/menu'
import { maxTokensFor, spinePrompt } from '@shared/director/prompt'
import { spineSchema, type Brief, type SpinePlan } from '@shared/director/schema'
import { headlineCapacity, validateSpine, type SegmentLayout } from '@shared/director/validate'
import { baselineSpine } from '@shared/director/baseline'
import { applySpine, COPY_RULE } from '@shared/director/apply'
import {
  ollamaAnswer,
  ollamaRequestBody,
  openaiAnswer,
  openaiRequestBody,
  parseModelJson,
  type ModelAnswer
} from '@shared/director/provider'
import { adSeconds, briefFor, buildSlots, menuFor, musicFor } from '@shared/director/run'
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
 *   score    the raw answer is read, parsed, validated and applied as
 *            `direct()` does — the standard cut when it is rejected — and the
 *            model's ad and the standard cut are both rendered for rating
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
  brief: Brief
  menu: Menu
  project: Project
  videoTrackId: string
  musicClipId: string | null
  /** The installed transitions the menu's families came from. */
  catalogue: { id: string; family: string }[]
  /** Where the cut menu came from: the sidecar's beat analysis, or the even grid without it. */
  beats: 'analysed' | 'grid'
  beatsNote: string | null
  realMedia: string[]
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
  cuts: number
  beats: Prepared['beats']
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
  /** Every headline the model wrote, before repairs, against the time its segment gives it. */
  headlines: HeadlineRecord[]
  /** The plan that was applied — the model's, or the standard cut's. */
  applied: SpinePlan
  /** The standard cut from the same menu: what the model's ad is rated against. */
  baseline: SpinePlan
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
  options: { analyseBeats: AnalyseBeats | null; transitions: TransitionDef[] }
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
  const seconds = adSeconds({ seconds: fixture.brief.seconds }, music)

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
  const menu = menuFor(withMedia, slots, music, analysis, catalogue, seconds)
  const brief = briefFor({ ...fixture.brief, seconds: fixture.brief.seconds }, seconds)

  return {
    fixtureId: fixture.id,
    brief,
    menu,
    project: withMedia,
    videoTrackId: 'v1',
    musicClipId: music?.clip.id ?? null,
    catalogue,
    beats: analysis ? 'analysed' : 'grid',
    beatsNote,
    realMedia: made.real
  }
}

/** The exact request the app would send for this menu. */
export function requestFor(prepared: Prepared, config: EvalConfig): EvalRequest {
  const { system, user } = spinePrompt(prepared.brief, prepared.menu)
  const request = {
    system,
    user,
    schema: spineSchema(prepared.menu),
    maxTokens: maxTokensFor(prepared.menu),
    think: config.think
  }
  const openai = config.provider === 'openai'
  return {
    id: `${prepared.fixtureId}.spine`,
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
 * The model's headlines against the time each segment actually gives them.
 *
 * Measured on the RAW plan, before the validator drops the long ones, because
 * "wrote a headline too long for its shot" is a finding about the model and
 * the repaired plan hides it. Spans are walked the way the validator walks
 * them; a segment whose end is unknown or not after its start gets no span.
 */
export function headlinesOf(raw: unknown, menu: Menu): HeadlineRecord[] {
  const segments = (raw as { segments?: unknown })?.segments
  if (!Array.isArray(segments)) return []
  const cuts = new Map(menu.cuts.map((c) => [c.id, c]))
  let previous = menu.cuts.find((c) => c.reason === 'start') ?? menu.cuts[0]
  const out: HeadlineRecord[] = []
  segments.forEach((s, i) => {
    const seg = s as { role?: unknown; ends_at?: unknown; headline?: unknown }
    const end = typeof seg.ends_at === 'string' ? cuts.get(seg.ends_at) : undefined
    const seconds = end && previous && end.frame > previous.frame ? (end.frame - previous.frame) / menu.fps : 0
    if (end && previous && end.frame > previous.frame) previous = end
    const text = typeof seg.headline === 'string' ? seg.headline.trim() : ''
    if (!text) return
    const capacity = headlineCapacity(seconds)
    const chars = Array.from(text).length
    out.push({ segment: i, role: typeof seg.role === 'string' ? seg.role : '', text, chars, seconds, capacity, fits: chars <= capacity })
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

/** Apply a validated plan the way `direct()` does. */
function applied(prepared: Prepared, plan: SpinePlan, layout: SegmentLayout[], model: string): Project {
  return applySpine(prepared.project, plan, layout, prepared.menu, {
    fps: prepared.menu.fps,
    videoTrackId: prepared.videoTrackId,
    brief: prepared.brief,
    model,
    catalogue: prepared.catalogue,
    ...(prepared.musicClipId ? { musicClipId: prepared.musicClipId } : {}),
    parallaxAssets: new Set(),
    newId: counter()
  }).project
}

/**
 * Render an applied project, small.
 *
 * Node has no canvas, so the headline cards — which the app draws in the
 * renderer — are left out and rated as text; the shots, the transitions, the
 * camera moves and the music are what is rendered (said in the run's README).
 */
export async function renderEval(
  project: Project,
  out: string,
  options: { extraTransitions: TransitionDef[]; resolveAsset?: (rel: string) => string }
): Promise<void> {
  const cards = new Set(project.clips.filter((c) => c.generatedBy?.rule === COPY_RULE).map((c) => c.id))
  const without: Project = { ...project, clips: project.clips.filter((c) => !cards.has(c.id)) }
  const plan = buildRenderPlan({
    project: without,
    outputPath: out,
    canvas: { width: 540, height: 960 },
    extraTransitions: options.extraTransitions,
    ...(options.resolveAsset ? { resolveAsset: options.resolveAsset } : {})
  })
  await mkdir(dirname(out), { recursive: true })
  await run(FFMPEG, plan.args, { maxBuffer: 64 * 1024 * 1024 })
}

export async function scoreFixture(
  fixture: Fixture,
  prepared: Prepared,
  request: EvalRequest,
  response: EvalResponse | null,
  options: {
    model: string
    render: { dir: string; extraTransitions: TransitionDef[]; resolveAsset?: (rel: string) => string } | null
  }
): Promise<BriefResult> {
  const { menu, brief } = prepared
  let answer: ModelAnswer | null = null
  let why: string | null = null
  let verdict: Verdict = 'error'
  let raw: unknown = null
  let parsed = false
  let plan: SpinePlan | null = null
  let layout: SegmentLayout[] = []
  let problems: string[] = []

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
      const checked = validateSpine(json.value, menu, { truncated: answer.truncated })
      problems = checked.problems.map((p) => `${p.path.replace(/^\$\.?/, '')}: ${p.message}`)
      if ('rejected' in checked) {
        verdict = 'rejected'
        why = checked.rejected
      } else {
        plan = checked.plan
        layout = checked.layout
        verdict = checked.problems.length > 0 ? 'repaired' : 'used'
      }
    }
  }

  // The standard cut, always: it is what a rejected plan becomes, and what every plan is rated against.
  const standard = validateSpine(baselineSpine(brief, menu), menu)
  if ('rejected' in standard) throw new Error(`${fixture.id}: the standard cut does not fit — ${standard.rejected}`)

  const renders: BriefResult['renders'] = { model: null, baseline: null }
  if (options.render) {
    const { dir, extraTransitions, resolveAsset } = options.render
    renders.baseline = join(dir, `${fixture.id}.baseline.mp4`)
    await renderEval(applied(prepared, standard.plan, standard.layout, 'baseline'), renders.baseline, { extraTransitions, resolveAsset })
    if (plan) {
      renders.model = join(dir, `${fixture.id}.model.mp4`)
      await renderEval(applied(prepared, plan, layout, options.model), renders.model, { extraTransitions, resolveAsset })
    }
  }

  return {
    fixtureId: fixture.id,
    kind: fixture.kind,
    language: brief.language,
    tone: brief.tone,
    seconds: brief.seconds,
    slots: menu.slots.length,
    cuts: menu.cuts.length,
    beats: prepared.beats,
    status: response?.status ?? 0,
    ms: response?.ms ?? 0,
    promptTokens: answer?.promptTokens ?? null,
    outputTokens: answer?.outputTokens ?? null,
    truncated: answer?.truncated ?? false,
    parsed,
    verdict,
    why,
    problems,
    reasoning: plan?.reasoning ?? (typeof (raw as { reasoning?: unknown })?.reasoning === 'string' ? (raw as { reasoning: string }).reasoning : null),
    headlines: headlinesOf(raw, menu),
    applied: plan ?? standard.plan,
    baseline: standard.plan,
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

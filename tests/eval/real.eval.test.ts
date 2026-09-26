import { describe, expect, it } from 'vitest'
import { existsSync, readdirSync } from 'node:fs'
import { readdir, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join, relative, resolve } from 'node:path'
import { TRANSITIONS } from '@shared/transitions/registry'
import type { MusicAnalysis } from '@shared/automation/cutPlan'
import { emptyProject, secondsToFrames, type Clip, type MediaAsset, type Project } from '@shared/timeline'
import { SPINE2_PASS } from '@shared/director/schema2'
import { gate, type Flag, type Measure } from '@shared/director/gate'
import { LOOK_MAX_TOKENS, lookLine, lookPrompt, lookSchema, readLook, type Look } from '@shared/director/look'
import { ollamaAnswer, ollamaRequestBody, openaiAnswer, openaiRequestBody, parseModelJson } from '@shared/director/provider'
import { spine2Prompt } from '@shared/director/prompt2'
import { adSeconds, briefFor, buildSlots, expectedRecipe, musicFor, type BriefDraft } from '@shared/director/run'
import { recipeById, type RecipeId } from '@shared/director/recipes'
import { probeMany } from '../../src/main/ffmpeg/probe'
import { toAsset } from '../../src/main/assets'
import type { Fixture } from './fixtures'
import { FFPROBE, REPO, beatsVia, capability, libraryTransitions, measureVia, startSidecar, type Measured } from './local'
import {
  applied,
  cardsOf,
  catalogueOf,
  lookFileFor,
  menuOf,
  readJson,
  requestFor,
  scoreFixture,
  settleAnswer,
  writeJson,
  type BriefResult,
  type EvalConfig,
  type EvalRequest,
  type EvalResponse,
  type Prepared
} from './pipeline'
import { EVAL_ROOT } from './relay'

/**
 * `FORGE_REAL=<folder> npm run eval:real` — one real ad, from the user's own
 * pictures and song, through the whole Director: the eyes, the gate, the
 * spine, the rhythm engine, the headline cards drawn by the app's own type
 * renderer, and a 1080×1920 render (docs/PLAN.md §3.1, "on real media").
 *
 * The folder holds the pictures (jpg, png, webp — in name order, which is the
 * user's order), one song, and `brief.json`, the panel's fields plus three:
 *
 *   { product, benefit?, audience?, tone?, cta?, seconds?, language?,
 *     recipe?: a recipe id to pin, or null — the model chooses,
 *     musicFrom?: where in the song the ad starts, in seconds,
 *     kind?: wedding | product | event | fashion | food }
 *
 * Four node steps, each writing files the next reads; between them the
 * harness page does the two things node cannot — reach the model, and draw
 * type (src/renderer/src/harness/evalRelay.ts):
 *
 *   STEP=looks   the project, the beats and the measurements (sidecar), one look request a picture
 *                → harness   window.__forgeEvalRelay('<run>')
 *   STEP=plan    the looks read back, the gate, the menu, the spine@2 request
 *                → harness   window.__forgeEvalRelay('<run>')   (only the new request is unanswered)
 *   STEP=score   the answer settled as direct() settles it; cards.json, every headline card's spec
 *                → harness   window.__forgeEvalCards('<run>')   (draws each to cards/…/<clip>.png)
 *   STEP=render  both ads rendered at 1080×1920 with the cards; README.md — what the eyes saw, what landed
 *
 * Same environment as the ten-brief eval: FORGE_EVAL, FORGE_EVAL_MODEL,
 * FORGE_EVAL_RUN, FORGE_EVAL_SERVER. Everything lands in tests/output/eval/<run>.
 */

const run = promisify(execFile)
const REAL = process.env.FORGE_REAL
const PROVIDER = process.env.FORGE_EVAL as EvalConfig['provider'] | undefined
const STEP = (process.env.FORGE_EVAL_STEP ?? 'looks') as 'looks' | 'plan' | 'score' | 'render'
const CANVAS = { width: 1080, height: 1920 }
/** The most song the music clip covers: the ad's length is `adSeconds`' decision, never this. */
const MAX_WINDOW_SECONDS = 60
const FPS = 30
const TRANSFORM = { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }
const NEUTRAL = { brightness: 0, contrast: 1, saturation: 1 }

interface RealBrief extends BriefDraft {
  recipe: RecipeId | null
  musicFrom: number
  kind: Fixture['kind']
}

const DEFAULT_BRIEF: RealBrief = {
  product: '', benefit: '', audience: '', tone: 'premium', cta: '', seconds: null, language: 'English',
  recipe: null, musicFrom: 0, kind: 'product'
}

/** What the `looks` step wrote down for the steps after it. */
interface Real {
  folder: string
  /** The pictures' file names, in the user's order — slot_01 is the first. */
  photos: string[]
  song: string
  draft: RealBrief
  project: Project
  analysis: MusicAnalysis | null
  beatsNote: string | null
  /** By asset id, the photos that measured. */
  measures: Record<string, Measure>
  measured: Measured[]
  measureNote: string | null
}

/** One picture as the eyes saw it, for the record. */
interface Seen {
  slot: string
  asset: string
  name: string
  look: Look | null
  reasoning: string | null
  why: string | null
  ms: number
}

interface Eyes {
  seen: Seen[]
  flags: Record<string, Flag[]>
  heroCandidates: string[]
  leftOut: { slot: string; why: string }[]
  loosened: string[]
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
}

/** A measurement the gate can use, or null when the sidecar reported an error or a number is missing. */
function measureOf(m: Measured): Measure | null {
  const { sharpness, luma, lumaStd, darkClip, brightClip, width, height } = m
  if (m.error) return null
  if ([sharpness, luma, lumaStd, darkClip, brightClip, width, height].some((v) => typeof v !== 'number')) return null
  return {
    sharpness: sharpness!, luma: luma!, lumaStd: lumaStd!, darkClip: darkClip!, brightClip: brightClip!,
    dhash: m.dhash ?? null, width: width!, height: height!
  }
}

async function durationOf(file: string): Promise<number> {
  const { stdout } = await run(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file])
  return Number(String(stdout).trim())
}

const pngsIn = (dir: string): number => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.png')).length : 0)

describe.skipIf(!PROVIDER || !REAL)('a real ad from the user’s own pictures and song', () => {
  it(
    `step ${STEP}`,
    async () => {
      const config: EvalConfig = { provider: PROVIDER!, model: process.env.FORGE_EVAL_MODEL ?? '', think: false }
      expect(config.model, 'FORGE_EVAL_MODEL names the model').not.toBe('')
      const openai = config.provider === 'openai'
      const server = process.env.FORGE_EVAL_SERVER ?? (openai ? 'http://127.0.0.1:1234' : 'http://127.0.0.1:11434')
      const runId = process.env.FORGE_EVAL_RUN ?? `real-${stamp()}`
      const runDir = join(EVAL_ROOT, runId)
      const rendersDir = join(runDir, 'renders')
      const cardDirs = { model: join(runDir, 'cards', 'model'), baseline: join(runDir, 'cards', 'baseline') }

      /* ------------------------------------------------------------ looks */
      if (STEP === 'looks') {
        const folder = resolve(REAL!)
        const names = (await readdir(folder)).sort()
        const photos = names.filter((f) => /\.(jpe?g|png|webp)$/i.test(f))
        const songs = names.filter((f) => /\.(mp3|wav|m4a|aac|flac|ogg)$/i.test(f))
        expect(photos.length, 'pictures in the folder').toBeGreaterThan(0)
        expect(songs, 'exactly one song in the folder').toHaveLength(1)
        const draft: RealBrief = { ...DEFAULT_BRIEF, ...((await readJson<Partial<RealBrief>>(join(folder, 'brief.json'))) ?? {}) }
        expect(draft.product, 'brief.json names the product').not.toBe('')

        // The project as the user would have it: the pictures in the pool, the song on the audio track from where they said.
        const paths = photos.map((f) => join(folder, f))
        const song = join(folder, songs[0])
        const { ok, failed } = await probeMany([...paths, song])
        expect(failed.map((f) => f.path), 'every file probes').toEqual([])
        const byPath = new Map(ok.map((info) => [info.path, info]))
        const assets: MediaAsset[] = photos.map((name, i) => ({ ...toAsset(byPath.get(paths[i])!, FPS), id: `a${String(i + 1).padStart(2, '0')}`, name }))
        const musicAsset: MediaAsset = { ...toAsset(byPath.get(song)!, FPS), id: 'music', name: songs[0] }
        expect(musicAsset.hasAudio, `${songs[0]} has sound`).toBe(true)
        const inPoint = Math.min(secondsToFrames(draft.musicFrom, FPS), Math.max(0, musicAsset.durationFrames - FPS))
        const window = Math.min(musicAsset.durationFrames - inPoint, secondsToFrames(MAX_WINDOW_SECONDS, FPS))
        const musicClip: Clip = {
          id: 'music-clip', assetId: 'music', trackId: 'a1', start: 0, duration: window, inPoint, volume: 1,
          transform: { ...TRANSFORM }, color: { ...NEUTRAL }
        }
        const base = emptyProject('real')
        const project: Project = {
          ...base,
          id: 'eval-real',
          settings: { ...base.settings, width: CANVAS.width, height: CANVAS.height, fps: FPS },
          assets: [...assets, musicAsset],
          clips: [musicClip]
        }

        /* The sidecar: the beats of the window, and the measurements — as the app gets both. */
        const started = await startSidecar()
        let analysis: MusicAnalysis | null = null
        let beatsNote: string | null = null
        const music = musicFor(project)!
        const beats = capability(started, 'audio.beats')
        if (beats.client) {
          try {
            analysis = await beatsVia(beats.client)(music.asset.path, { startMs: music.startMs, endMs: music.endMs })
          } catch (err) {
            beatsNote = `beat analysis failed: ${err instanceof Error ? err.message : String(err)}`
          }
        } else beatsNote = beats.note
        const measures: Record<string, Measure> = {}
        let measured: Measured[] = []
        let measureNote: string | null = null
        const measure = capability(started, 'vision.measure')
        if (measure.client) {
          try {
            measured = (await measureVia(measure.client)(paths)).measures
            for (const m of measured) {
              const i = paths.indexOf(m.path)
              const read = measureOf(m)
              if (i >= 0 && read) measures[assets[i].id] = read
            }
          } catch (err) {
            measureNote = `the pictures were not measured — ${err instanceof Error ? err.message : String(err)}`
          }
        } else measureNote = `the pictures were not measured — ${measure.note}`
        started.stop()

        /* One look request a picture, built with the app's own functions — the look pass exactly as seeSlots asks it. */
        const { encodeImages } = await import('../../src/main/director')
        const { system, user } = lookPrompt({ product: draft.product, language: draft.language })
        const requests: EvalRequest[] = []
        for (const [i, path] of paths.entries()) {
          const images = await encodeImages([path])
          expect(images, `${photos[i]} encodes for the model`).toHaveLength(1)
          const request = { system, user, schema: lookSchema(), maxTokens: LOOK_MAX_TOKENS, think: false }
          requests.push({
            id: `look.${assets[i].id}`,
            fixtureId: 'real',
            provider: config.provider,
            path: openai ? '/v1/chat/completions' : '/api/chat',
            body: openai ? openaiRequestBody(request, images, config.model) : ollamaRequestBody(request, images, config.model)
          })
        }
        const real: Real = { folder, photos, song: songs[0], draft, project, analysis, beatsNote, measures, measured, measureNote }
        await writeJson(join(runDir, 'real.json'), real)
        await writeJson(join(runDir, 'requests.json'), requests)
        await writeJson(join(runDir, 'config.json'), { ...config, server, runId })
        console.log(
          `${runId}: ${photos.length} pictures, "${songs[0]}" from ${draft.musicFrom} s (${(window / FPS).toFixed(1)} s window, ` +
            `${analysis ? `${analysis.bpm.toFixed(1)} BPM` : `no beats: ${beatsNote}`}); ${Object.keys(measures).length} measured` +
            `${measureNote ? ` (${measureNote})` : ''}. Now: window.__forgeEvalRelay('${runId}') in the harness, then STEP=plan.`
        )
      }

      /* ------------------------------------------------------------- plan */
      if (STEP === 'plan') {
        const real = await readJson<Real>(join(runDir, 'real.json'))
        if (!real) throw new Error(`${runId} has no real.json — run STEP=looks first`)
        const { project, draft, photos } = real
        const stills = project.assets.filter((a) => a.kind === 'image')

        /* The looks, read back as seeSlots reads them; a picture whose look could not be read simply has none. */
        const looks: Record<string, Look> = {}
        const seen: Seen[] = []
        for (const [i, asset] of stills.entries()) {
          const response = await readJson<EvalResponse>(join(runDir, 'responses', `look.${asset.id}.json`))
          let look: Look | null = null
          let reasoning: string | null = null
          let why: string | null = null
          try {
            if (!response || response.status !== 200) throw new Error(response?.error ?? `status ${response?.status ?? 'none'}`)
            const answer = openai ? openaiAnswer(response.data) : ollamaAnswer(response.data)
            const parsed = parseModelJson(answer.text)
            if ('error' in parsed) throw new Error(parsed.error)
            look = readLook(parsed.value)
            const r = (parsed.value as { reasoning?: unknown })?.reasoning
            reasoning = typeof r === 'string' ? r : null
            if (!look) why = 'the model’s description could not be read'
          } catch (err) {
            why = err instanceof Error ? err.message : String(err)
          }
          if (look) looks[asset.id] = look
          seen.push({ slot: `slot_${String(i + 1).padStart(2, '0')}`, asset: asset.id, name: photos[i], look, reasoning, why, ms: response?.ms ?? 0 })
        }

        /* From here, exactly what `direct()` does before it asks. */
        const slots = buildSlots(project)
        const gated = gate(slots, looks, real.measures, { wantsPeople: false })
        const music = musicFor(project)
        const pinned = draft.recipe ? recipeById(draft.recipe) : null
        expect(draft.recipe === null || pinned !== null, `brief.json recipe "${draft.recipe}" is not a recipe`).toBe(true)
        const seconds = adSeconds(draft, music, expectedRecipe(draft, pinned))
        const brief = briefFor(draft, seconds)
        const library = await libraryTransitions()
        const prepared: Prepared = {
          fixtureId: 'real',
          pass: SPINE2_PASS,
          brief,
          project,
          videoTrackId: 'v1',
          musicClipId: music?.clip.id ?? null,
          catalogue: catalogueOf([...TRANSITIONS, ...library.transitions]),
          beats: real.analysis ? 'analysed' : 'grid',
          beatsNote: real.beatsNote,
          realMedia: photos,
          analysis: real.analysis,
          gated: { slots: gated.slots, heroCandidates: gated.heroCandidates },
          gateNotes: [...gated.leftOut.map((l) => `${l.slot} left out — ${l.why}`), ...gated.loosened],
          pinned: draft.recipe
        }
        await writeJson(join(runDir, 'prepared', 'real.json'), prepared)
        const eyes: Eyes = {
          seen,
          flags: Object.fromEntries(gated.slots.map((s) => [s.id, s.flags])),
          heroCandidates: gated.heroCandidates,
          leftOut: gated.leftOut,
          loosened: gated.loosened
        }
        await writeJson(join(runDir, 'eyes.json'), eyes)

        const request = requestFor(prepared, config)
        const requests = (await readJson<EvalRequest[]>(join(runDir, 'requests.json'))) ?? []
        await writeJson(join(runDir, 'requests.json'), [...requests.filter((r) => r.id !== request.id), request])
        const { menu } = menuOf(prepared)
        await writeFile(join(runDir, 'prompt.txt'), spine2Prompt(brief, menu).user)
        for (const s of seen) console.log(`  ${s.slot} ${s.name}: ${s.look ? lookLine(s.look) : `no look — ${s.why}`}`)
        console.log(
          `${runId}: ${gated.slots.length} slots, heroes ${gated.heroCandidates.join(' ') || 'none'}; ${seconds} s at ${menu.bpm.toFixed(1)} BPM, ` +
            `holds ${menu.holds.min}–${menu.holds.max}${prepared.gateNotes.length ? `; ${prepared.gateNotes.join('; ')}` : ''}. ` +
            `Now: window.__forgeEvalRelay('${runId}') in the harness, then STEP=score.`
        )
      }

      /* ---------------------------------------------------- score, render */
      if (STEP === 'score' || STEP === 'render') {
        const real = await readJson<Real>(join(runDir, 'real.json'))
        const prepared = await readJson<Prepared>(join(runDir, 'prepared', 'real.json'))
        const eyes = await readJson<Eyes>(join(runDir, 'eyes.json'))
        if (!real || !prepared || !eyes) throw new Error(`${runId} was not planned — run STEP=looks and STEP=plan first`)
        const request = ((await readJson<EvalRequest[]>(join(runDir, 'requests.json'))) ?? []).find((r) => r.id === 'real.spine2')
        if (!request) throw new Error(`${runId} has no spine request — run STEP=plan first`)
        const response = await readJson<EvalResponse>(join(runDir, 'responses', 'real.spine2.json'))
        const settledAnswer = settleAnswer(prepared, request, response)
        const { menu, verdict, why, problems, settled, standard, landed } = settledAnswer
        const fps = menu.fps

        if (STEP === 'score') {
          /* Every headline card of both ads, for the harness to draw — the same ids `scoreFixture` will apply them under. */
          const modelLook = await lookFileFor(landed.composed.recipe, rendersDir)
          const standardLook = await lookFileFor(standard.composed.recipe, rendersDir)
          const cards = [
            ...(settled ? cardsOf(applied(prepared, settled.composed, menu, config.model, modelLook), CANVAS, 'cards/model') : []),
            ...cardsOf(applied(prepared, standard.composed, menu, 'baseline', standardLook), CANVAS, 'cards/baseline')
          ]
          await writeJson(join(runDir, 'cards.json'), cards)
          await writeJson(join(runDir, 'settled.json'), {
            verdict, why, problems,
            recipe: landed.composed.recipe.id,
            hero: landed.composed.plan.hero,
            plan: landed.composed.plan,
            timing: landed.composed.layout.shots,
            endFrame: landed.composed.layout.endFrame,
            raw: settledAnswer.answer?.text ?? null
          })
          console.log(
            `${runId}: ${verdict}${why ? ` — ${why}` : ''}; ${landed.composed.recipe.name}, hero ${landed.composed.plan.hero}, ` +
              `${landed.composed.layout.shots.length} shots to ${(landed.composed.layout.endFrame / fps).toFixed(1)} s; ` +
              `${cards.length} cards to draw. Now: window.__forgeEvalCards('${runId}') in the harness, then STEP=render.`
          )
          for (const p of problems) console.log(`  - ${p}`)
        }

        if (STEP === 'render') {
          const library = await libraryTransitions()
          const drawn = { model: pngsIn(cardDirs.model), baseline: pngsIn(cardDirs.baseline) }
          const result = await scoreFixture({ id: 'real', kind: real.draft.kind }, prepared, request, response, {
            model: config.model,
            render: {
              dir: rendersDir,
              extraTransitions: library.transitions,
              ...(library.resolveAsset ? { resolveAsset: library.resolveAsset } : {}),
              canvas: CANVAS,
              cards: cardDirs
            }
          })
          const record: BriefResult = {
            ...result,
            renders: {
              model: result.renders.model && relative(REPO, result.renders.model),
              baseline: result.renders.baseline && relative(REPO, result.renders.baseline)
            }
          }
          await writeJson(join(runDir, 'results.json'), { run: runId, stamp: new Date().toISOString(), ...config, server, media: 'real', drawn, result: record })
          await writeFile(join(runDir, 'README.md'), readme(runId, config, real, eyes, result, settledAnswer, drawn))

          /* The render is the ad the engine laid out: as long as it, to the frame, and it exists. */
          const files = [result.renders.baseline, result.renders.model].filter((f): f is string => f !== null)
          expect(files.length, 'the standard cut rendered').toBeGreaterThan(0)
          for (const file of files) {
            expect(existsSync(file), file).toBe(true)
            const seconds = await durationOf(file)
            const want = landed.composed.layout.endFrame / fps
            const isModel = file === result.renders.model
            const laid = (isModel ? landed : standard).composed.layout.endFrame / fps
            expect(Math.abs(seconds - laid), `${relative(REPO, file)} runs ${seconds.toFixed(2)} s, laid out to ${laid.toFixed(2)} s (the model's to ${want.toFixed(2)})`).toBeLessThan(0.25)
          }
          console.log(`${runId}: ${verdict}; rendered ${files.map((f) => relative(REPO, f)).join(', ')} with ${drawn.model} + ${drawn.baseline} cards drawn. README.md written.`)
        }
      }
    },
    3_600_000
  )
})

/** The run, written for a reader: what was asked, what the eyes saw, what the model directed, and where the films are. */
function readme(
  runId: string,
  config: EvalConfig,
  real: Real,
  eyes: Eyes,
  result: BriefResult,
  settled: ReturnType<typeof settleAnswer>,
  drawn: { model: number; baseline: number }
): string {
  const { brief } = { brief: result }
  const { draft, analysis } = real
  const fps = settled.menu.fps
  const landed = settled.landed.composed
  const music = musicFor(real.project)
  const sharpnesses = Object.values(real.measures).map((m) => m.sharpness).sort((a, b) => a - b)
  const median = sharpnesses.length ? sharpnesses[Math.floor(sharpnesses.length / 2)] : 0
  const t = (frame: number): string => (frame / fps).toFixed(2)
  const spanOf = new Map(landed.layout.shots.map((s) => [s.slotId, s]))
  const fitOf = new Map(result.headlines.map((h) => [h.segment, h]))

  const lines: string[] = [
    `# ${runId} — a real ad`,
    '',
    `${config.provider} · ${config.model} · relay · ${real.photos.length} pictures · "${real.song}"`,
    '',
    '## The brief',
    '',
    `- product: ${draft.product}`,
    `- benefit: ${draft.benefit || '(the product)'}`,
    `- audience: ${draft.audience || '(none)'}`,
    `- tone: ${draft.tone} · cta: ${draft.cta || 'Shop now'} · language: ${draft.language}`,
    `- length: ${brief.seconds} s${draft.seconds === null ? ' (the default)' : ''} · recipe: ${draft.recipe ?? 'the model chooses'}`,
    '',
    '## The song',
    '',
    `- from ${draft.musicFrom} s, a ${music ? (music.windowMs / 1000).toFixed(1) : '?'} s window`,
    analysis
      ? `- ${analysis.bpm.toFixed(1)} BPM; ${analysis.sections?.length ?? 0} sections, ${analysis.drops?.length ?? 0} drops`
      : `- no beat analysis — ${real.beatsNote ?? 'the even grid'}`,
    `- the menu: ${settled.menu.bpm.toFixed(1)} BPM, ${settled.menu.holds.min}–${settled.menu.holds.max} shots hold under the ${settled.menu.fallback.name}`,
    '',
    '## What the eyes saw',
    ''
  ]
  for (const s of eyes.seen) {
    const m = real.measures[s.asset]
    const flags = eyes.flags[s.slot] ?? []
    lines.push(`### ${s.slot} — ${s.name}`, '')
    lines.push(s.look ? `- look: ${lookLine(s.look)} (${s.ms} ms)` : `- no look — ${s.why}`)
    if (s.reasoning) lines.push(`- the model: "${s.reasoning}"`)
    if (m) {
      lines.push(
        `- measured: sharpness ${m.sharpness.toFixed(1)}${median ? ` (${(m.sharpness / median).toFixed(2)}× the set's median)` : ''}, ` +
          `luma ${m.luma.toFixed(2)}, clipped ${(m.brightClip * 100).toFixed(1)}% bright / ${(m.darkClip * 100).toFixed(1)}% dark, ${m.width}×${m.height}`
      )
    } else lines.push(`- not measured${real.measureNote ? ` — ${real.measureNote}` : ''}`)
    lines.push(`- flags: ${flags.length ? flags.join(', ') : 'none'}`, '')
  }
  lines.push(`Hero candidates, best first: ${eyes.heroCandidates.join(', ') || 'none'}.`)
  if (eyes.leftOut.length) lines.push(`Left out: ${eyes.leftOut.map((l) => `${l.slot} (${l.why})`).join('; ')}.`)
  if (eyes.loosened.length) lines.push(`Loosened: ${eyes.loosened.join('; ')}.`)
  lines.push('', '## What the model directed', '')
  lines.push(`- verdict: **${result.verdict}**${result.why ? ` — ${result.why}` : ''}`)
  lines.push(`- recipe: ${landed.recipe.name} · hero: ${landed.plan.hero} · style: ${landed.plan.style} · animation: ${landed.plan.animation}`)
  if (landed.plan.reasoning) lines.push(`- reasoning: "${landed.plan.reasoning}"`)
  lines.push('', '| # | slot | role | weight | move | speed | headline | fits | on screen |', '|---|---|---|---|---|---|---|---|---|')
  landed.plan.shots.forEach((shot, i) => {
    const span = spanOf.get(shot.slot)
    const fit = fitOf.get(i)
    lines.push(
      `| ${i + 1} | ${shot.slot}${shot.slot === landed.plan.hero ? ' ★' : ''} | ${shot.role} | ${shot.weight} | ${shot.move} | ${shot.speed} | ` +
        `${shot.headline ? `"${shot.headline.replace(/\|/g, '\\|')}"` : '—'}${shot.punch_word ? ` (punch: ${shot.punch_word})` : ''} | ` +
        `${fit ? (fit.fits ? 'yes' : `no — ${fit.chars} of ${fit.capacity}`) : '—'} | ${span ? `${t(span.startFrame)}–${t(span.endFrame)} s` : 'left out'} |`
    )
  })
  lines.push('')
  if (landed.layout.black) lines.push(`- black ${t(landed.layout.black.startFrame)}–${t(landed.layout.black.endFrame)} s`)
  if (landed.layout.endCard) lines.push(`- end card ${t(landed.layout.endCard.startFrame)}–${t(landed.layout.endCard.endFrame)} s`)
  lines.push(`- the ad ends at ${t(landed.layout.endFrame)} s`)
  if (result.problems.length) lines.push('', 'Notes and repairs:', '', ...result.problems.map((p) => `- ${p}`))
  lines.push('', '## The films', '')
  if (result.renders.model) lines.push(`- ${relative(REPO, result.renders.model)} — the model's ad, ${CANVAS.width}×${CANVAS.height}, ${drawn.model} cards drawn by the app's type renderer`)
  lines.push(`- ${relative(REPO, result.renders.baseline!)} — the standard cut from the same menu, ${drawn.baseline} cards drawn`)
  lines.push('')
  return lines.join('\n')
}

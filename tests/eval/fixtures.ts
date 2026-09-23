import { readdir, readFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import type { Tone } from '@shared/director/schema'
import { TONES } from '@shared/director/schema'
import { segmentIntoSentences, type Transcript, type Word } from '@shared/transcript'

/**
 * The Director eval's ten briefs (docs/PLAN.md §3.1).
 *
 * One JSON file per brief in `tests/fixtures/director/`: the brief as the
 * panel takes it, the music's shape, the user's pictures and clip in the
 * order they would place them — each with a name, a note and, for a clip, what
 * is said in it — and the ground truth a person wrote down about each picture,
 * which the VLM half of the eval is scored against.
 */

export const FIXTURE_DIR = resolve(__dirname, '..', 'fixtures', 'director')

export type People = 'none' | 'one' | 'two' | 'group'
export type Shot = 'wide' | 'medium' | 'close' | 'detail'

export interface Truth {
  people: People
  shot: Shot
  product_visible: 'yes' | 'no'
  what: string
}

export interface MediaEntry {
  name: string
  kind: 'image' | 'video'
  /** The colour of the synthetic stand-in, `#rrggbb`. */
  colour: string
  size: [number, number]
  /** What the user typed about it; often nothing. */
  note: string
  seconds?: number
  /** For a clip: what is said in it, which becomes its transcript. */
  speech?: string
  truth: Truth
}

export interface MusicSpec {
  bpm: number
  seconds: number
  buildFrom: number
  dropAt: number
}

export interface FixtureBrief {
  product: string
  benefit: string
  audience: string
  tone: Tone
  cta: string
  seconds: number
  language: string
}

export interface Fixture {
  id: string
  kind: 'wedding' | 'product' | 'event' | 'fashion' | 'food'
  brief: FixtureBrief
  music: MusicSpec
  /** The picture the user would make the hero. */
  hero: string
  media: MediaEntry[]
}

/** Windows forbids these in a file name; a fixture that used one could not be checked out there. */
const ILLEGAL = /[<>:"|?*\u0000-\u001f]/
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i

/** Everything wrong with a fixture, as sentences; empty when it is sound. */
export function fixtureProblems(fixture: Fixture, file = `${fixture.id}.json`): string[] {
  const problems: string[] = []
  if (basename(file, '.json') !== fixture.id) problems.push(`${file}: id "${fixture.id}" does not match the file name`)
  if (!TONES.includes(fixture.brief.tone)) problems.push(`${fixture.id}: tone "${fixture.brief.tone}" is not one of ${TONES.join(', ')}`)
  if (!(fixture.brief.seconds > 0)) problems.push(`${fixture.id}: seconds must be positive`)
  if (fixture.music.dropAt <= fixture.music.buildFrom || fixture.music.dropAt >= fixture.music.seconds) {
    problems.push(`${fixture.id}: the music's build must come before its drop, and the drop before its end`)
  }
  if (fixture.music.seconds < fixture.brief.seconds) problems.push(`${fixture.id}: the music is shorter than the ad`)
  if (!fixture.media.some((m) => m.name === fixture.hero)) problems.push(`${fixture.id}: hero "${fixture.hero}" is not in its media`)
  const names = new Set<string>()
  for (const m of fixture.media) {
    if (ILLEGAL.test(m.name) || RESERVED.test(m.name) || /[. ]$/.test(m.name)) {
      problems.push(`${fixture.id}: "${m.name}" is not a legal Windows file name`)
    }
    if (names.has(m.name)) problems.push(`${fixture.id}: "${m.name}" appears twice`)
    names.add(m.name)
    if (!/^#[0-9a-f]{6}$/i.test(m.colour)) problems.push(`${fixture.id}: "${m.name}" colour must be #rrggbb`)
    if (m.kind === 'video' && !(m.seconds && m.seconds > 0)) problems.push(`${fixture.id}: clip "${m.name}" needs seconds`)
  }
  return problems
}

export async function loadFixtures(dir = FIXTURE_DIR): Promise<Fixture[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort()
  const fixtures: Fixture[] = []
  for (const file of files) {
    const fixture = JSON.parse(await readFile(join(dir, file), 'utf8')) as Fixture
    const problems = fixtureProblems(fixture, file)
    if (problems.length > 0) throw new Error(problems.join('\n'))
    fixtures.push(fixture)
  }
  return fixtures
}

/**
 * A transcript for a clip's speech: the words spread evenly over the clip,
 * leaving a quarter-second of air at each end, segmented the way ASR output is.
 * The spine only reads the text (`Slot.speech`) and whether anyone speaks in
 * the span it is given (`hasSpeech`), so even spacing is enough.
 */
export function transcriptFor(assetId: string, speech: string, seconds: number, language: string): Transcript {
  const tokens = speech.trim().split(/\s+/).filter(Boolean)
  const startMs = 250
  const spanMs = Math.max(1, seconds * 1000 - 500)
  const each = spanMs / Math.max(1, tokens.length)
  const words: Word[] = tokens.map((text, index) => ({
    index,
    text,
    startMs: Math.round(startMs + index * each),
    endMs: Math.round(startMs + (index + 0.85) * each),
    confidence: 0.95
  }))
  return {
    assetId,
    language,
    model: 'fixture',
    durationMs: Math.round(seconds * 1000),
    words,
    segments: segmentIntoSentences(words)
  }
}

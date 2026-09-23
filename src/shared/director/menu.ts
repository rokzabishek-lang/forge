import type { Project } from '../timeline'
import { secondsToFrames } from '../timeline'
import {
  DEFAULT_TARGET_SHOT_SECONDS,
  chooseBeatsPerCut,
  planCuts,
  tierAt,
  type CutReason,
  type MusicAnalysis
} from '../automation/cutPlan'
import type { TransitionFamily } from '../transitions/registry'
import { transcriptText } from '../transcript'
import type { Transcript } from '../transcript'
import type { Look } from './look'
import type { Flag } from './gate'

/**
 * The menu: every legal choice the model may make, each with an opaque id.
 *
 * docs/DIRECTOR.md §1 — deterministic code generates the options, the model
 * picks by id, deterministic code turns the ids back into frames. The model
 * says "end on cut_07", never "end at 4.3 seconds", and the cut was located by
 * the beat analysis, so it cannot be a frame off.
 *
 * Three lists. SLOTS are the user's pictures and clips, in the user's order —
 * the model may skip one, never reorder them. CUTS are the moments a segment
 * may end on: the beat grid and the structural moments from `planCuts`, with a
 * `start` and an `end` added, truncated to the length asked for, and deduped
 * so no two are closer than the shortest segment allowed. FAMILIES are the
 * transition families that are actually installed, so the model is never
 * offered a glitch it cannot have.
 */

/** Shorter than this and a shot reads as a glitch, not a cut. */
export const MIN_SEGMENT_SECONDS = 0.4
export function minSegmentFrames(fps: number): number {
  return Math.max(1, secondsToFrames(MIN_SEGMENT_SECONDS, fps))
}

/** Past this a small model loses the thread; structural cuts are kept first. */
export const MAX_CANDIDATES = 24

/** How much of a clip's speech the model is shown. */
export const MAX_SPEECH_CHARS = 90

/** The end may snap this far back onto a beat, so the ad closes on one. */
const MAX_END_SNAP_MS = 2_500

export interface Slot {
  /** `slot_01` … in user order. Two digits so ids sort as text. */
  id: string
  assetId: string
  kind: 'image' | 'video'
  /** From the filename, made readable. */
  label: string
  /** What the user typed about it; empty if nothing. */
  note: string
  /** A video's first words, when it has a transcript; else empty. */
  speech: string
  /** A video's length; null for a still. */
  seconds: number | null
  /** The same, in project frames — what the validator caps a segment against. */
  frames: number | null
  /** What the VLM saw in it, when it was shown (look.ts). */
  look?: Look
  /** What the measurement found wrong with it (gate.ts): never the product shot. */
  flags?: Flag[]
}

export type CandidateReason = 'start' | 'end' | CutReason

export interface CutCandidate {
  /** `cut_00` is the start, `cut_end` the end, `cut_01` … between. */
  id: string
  /** Relative to the music window. */
  ms: number
  /** TIMELINE frame, offset already applied. */
  frame: number
  reason: CandidateReason
  /** 0 (quiet) to 3 (peak). */
  energy: number
  /** For `end` only: the structural moment it was snapped onto, if any. */
  landsOn?: CutReason
}

export interface FamilyChoice {
  id: TransitionFamily | 'cut'
  /** One line of intent, from docs/AUTOMATION.md §5. */
  intent: string
}

export interface Menu {
  slots: Slot[]
  cuts: CutCandidate[]
  families: FamilyChoice[]
  /** The length the ad was asked to be. */
  seconds: number
  fps: number
}

/* ------------------------------------------------------------------ slots */

/**
 * The user's pictures and clips, in the order they sit in the media pool.
 *
 * Anything the editor DREW is left out — text cards, clippings, the card
 * ring — by the one mark they all carry: `size: 0`. Not by whether a clip
 * still references them, because a baked card whose clip was cleared (or
 * deleted by hand) is an orphan with a real path, and the first version of
 * this offered those to the model as product shots named after last run's
 * headlines.
 */
export function buildSlots(project: Project, notes: Record<string, string> = {}): Slot[] {
  const fps = project.settings.fps
  return project.assets
    .filter((a) => (a.kind === 'image' || a.kind === 'video') && a.size > 0)
    .map((a, index) => ({
      id: `slot_${String(index + 1).padStart(2, '0')}`,
      assetId: a.id,
      kind: a.kind as 'image' | 'video',
      label: labelFor(a.name),
      note: (notes[a.id] ?? '').trim(),
      speech: a.kind === 'video' ? speechFor(project.transcripts[a.id]) : '',
      seconds: a.kind === 'video' ? Math.round((a.durationFrames / fps) * 10) / 10 : null,
      frames: a.kind === 'video' ? a.durationFrames : null
    }))
}

/** `IMG_4021-serum_bottle.jpg` → `IMG 4021 serum bottle`. */
export function labelFor(filename: string): string {
  return filename
    .replace(/\.[a-z0-9]{1,5}$/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function speechFor(transcript: Transcript | undefined): string {
  if (!transcript || transcript.words.length === 0) return ''
  const text = transcriptText(transcript).replace(/\s+/g, ' ').trim()
  if (text.length <= MAX_SPEECH_CHARS) return text
  const cut = text.lastIndexOf(' ', MAX_SPEECH_CHARS)
  return `${text.slice(0, cut > MAX_SPEECH_CHARS / 2 ? cut : MAX_SPEECH_CHARS).trim()}…`
}

/* ------------------------------------------------------------------- cuts */

export interface CutMenuOptions {
  fps: number
  /** The length asked for. The ad is never longer than this. */
  seconds: number
  /** Where the music clip starts on the timeline; candidates are offset by it. */
  offsetFrames?: number
  /**
   * How long the music window really is on the TIMELINE, in ms.
   *
   * Not `analysis.durationMs`: that is however much audio decoded, and it has
   * come back seconds short of the clip before (store.ts, buildReel). The
   * timeline is the authority on how long the music is.
   */
  windowMs?: number
}

interface Raw {
  ms: number
  reason: CandidateReason
  energy: number
  landsOn?: CutReason
}

/**
 * The moments a segment may end on.
 *
 * With music: `planCuts` with no transitions gives the grid and the
 * structural moments; the same planner the reel uses, so the director's
 * vocabulary is the reel's. Without music: an even grid at the standard shot
 * length. Then, in this order — truncate to the length asked for; let the
 * end snap back onto a beat within reach; thin to what a small model can
 * hold; and LAST, dedupe, so nothing that happens earlier can put two
 * candidates a frame apart.
 */
export function buildCutMenu(analysis: MusicAnalysis | null, options: CutMenuOptions): CutCandidate[] {
  const { fps } = options
  const offset = options.offsetFrames ?? 0
  const minFrames = minSegmentFrames(fps)
  const minMs = (minFrames / fps) * 1000

  const musical = analysis !== null && analysis.beats.length >= 2 && analysis.durationMs > 0
  const windowMs = options.windowMs ?? (musical ? analysis.durationMs : options.seconds * 1000)
  // At least room for a start and an end a shortest-segment apart.
  const spanMs = Math.max(minMs * 2, Math.min(options.seconds * 1000, windowMs))

  let raw: Raw[]
  let gridStepMs: number
  if (musical) {
    const cuts = planCuts(analysis, { fps, transitionRate: 0 })
    raw = cuts
      .filter((c) => c.ms > 0 && c.ms <= spanMs - minMs)
      .map((c) => ({ ms: c.ms, reason: c.reason, energy: c.energyTier }))
    const beatMs = analysis.bpm > 0 ? 60_000 / analysis.bpm : 500
    gridStepMs = chooseBeatsPerCut(analysis.bpm) * beatMs
  } else {
    const step = DEFAULT_TARGET_SHOT_SECONDS * 1000
    raw = []
    for (let ms = step; ms <= spanMs - minMs; ms += step) {
      raw.push({ ms: Math.round(ms), reason: 'grid', energy: 1 })
    }
    gridStepMs = step
  }

  /*
   * The end. Exactly the length asked for — unless a cut lies within one
   * grid step below it, in which case the ad ends THERE, on the beat, and
   * that cut carries its energy and its reason onto the end so the model can
   * still see it was a drop. Never later than asked: the ad may be shorter
   * than the brief, never longer.
   */
  let end: Raw = { ms: spanMs, reason: 'end', energy: musical ? tierAt(analysis, spanMs) : 1 }
  const reach = Math.min(gridStepMs, MAX_END_SNAP_MS)
  const within = raw.filter((c) => spanMs - c.ms <= reach)
  if (within.length > 0) {
    const last = within[within.length - 1]
    end = {
      ms: last.ms,
      reason: 'end',
      energy: last.energy,
      ...(last.reason !== 'grid' ? { landsOn: last.reason as CutReason } : {})
    }
    raw = raw.filter((c) => c.ms < last.ms)
  }

  const start: Raw = { ms: 0, reason: 'start', energy: musical ? tierAt(analysis, 0) : 1 }

  /* Thin: structural moments first, then the grid spread evenly. */
  const room = MAX_CANDIDATES - 2
  if (raw.length > room) {
    const structural = raw.filter((c) => c.reason !== 'grid')
    const grid = raw.filter((c) => c.reason === 'grid')
    const budget = room - structural.length
    const picked =
      budget <= 0
        ? []
        : budget >= grid.length
          ? grid
          : Array.from({ length: budget }, (_, i) => grid[Math.floor((i * grid.length) / budget)])
    raw = [...structural, ...picked].sort((a, b) => a.ms - b.ms)
  }

  /*
   * Dedupe, last. Two candidates closer than the shortest segment allowed
   * would make every plan using them a reject — for a defect in the menu,
   * not in the plan. Start and end are never dropped; a structural cut
   * outranks a grid cut; a cut colliding with the end folds into it.
   */
  const rank = (r: CandidateReason): number => (r === 'start' ? 0 : r === 'end' ? 2 : 1)
  const all = [start, ...raw, end]
    .map((c) => ({ ...c, frame: secondsToFrames(c.ms / 1000, fps) }))
    .sort((a, b) => a.frame - b.frame || rank(a.reason) - rank(b.reason))

  const kept: (Raw & { frame: number })[] = []
  for (const c of all) {
    const prev = kept[kept.length - 1]
    if (!prev || c.frame - prev.frame >= minFrames) {
      kept.push(c)
      continue
    }
    if (c.reason === 'end') {
      // Degenerate window: keep both, and let validation refuse the plans.
      if (prev.reason === 'start') {
        kept.push(c)
        continue
      }
      kept.pop()
      kept.push({
        ...c,
        energy: Math.max(c.energy, prev.energy),
        ...(c.landsOn ? {} : prev.reason !== 'grid' ? { landsOn: prev.reason as CutReason } : {})
      })
      continue
    }
    if (prev.reason === 'start' || prev.reason === 'end') continue
    if (c.reason !== 'grid' && prev.reason === 'grid') kept[kept.length - 1] = c
    // Otherwise the earlier one stays and this one goes.
  }

  return kept.map((c, index) => ({
    id: c.reason === 'start' ? 'cut_00' : c.reason === 'end' ? 'cut_end' : `cut_${String(index).padStart(2, '0')}`,
    ms: c.ms,
    frame: offset + c.frame,
    reason: c.reason,
    energy: c.energy,
    ...(c.landsOn ? { landsOn: c.landsOn } : {})
  }))
}

/** The candidate a plan's first segment starts on. */
export function startCut(cuts: CutCandidate[]): CutCandidate {
  return cuts.find((c) => c.reason === 'start') ?? cuts[0]
}

/* --------------------------------------------------------------- families */

/** One line each, from docs/AUTOMATION.md §5 — what the family is FOR. */
export const FAMILY_INTENT: Record<TransitionFamily, string> = {
  dissolve: 'soft, time passing',
  slide: 'direction — the next item along',
  zoom: 'a punch of energy',
  whip: 'fast and aggressive',
  glitch: 'digital, edgy',
  light: 'a warm flash',
  wipe: 'a shape reveals the next shot',
  film: 'analogue, a projector flicker',
  smooth: 'liquid, a ripple'
}

const FAMILY_ORDER: TransitionFamily[] = [
  'dissolve',
  'slide',
  'zoom',
  'whip',
  'glitch',
  'light',
  'wipe',
  'film',
  'smooth'
]

/**
 * `cut`, plus every family with at least one installed member.
 *
 * Only what exists: a family with no members would be a choice the apply
 * step has to repair to a cut, and offering it teaches the model nothing.
 */
export function familyMenu(catalogue: { id: string; family: string }[]): FamilyChoice[] {
  const present = new Set(catalogue.map((t) => t.family))
  return [
    { id: 'cut', intent: 'a hard cut — most segments should arrive this way' },
    ...FAMILY_ORDER.filter((f) => present.has(f)).map((f) => ({ id: f, intent: FAMILY_INTENT[f] }))
  ]
}

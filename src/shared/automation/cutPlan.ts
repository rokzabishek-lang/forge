import { secondsToFrames } from '../timeline'

/**
 * Plan where cuts land against a piece of music.
 *
 * The governing findings, from researching actual editing practice:
 *  - Never cut on every beat. At 128 BPM that is 128 cuts a minute, which every
 *    source describes as frantic.
 *  - Cut density should be tempo-INVARIANT. Pick the beat multiple that lands a
 *    shot near the target length, so 174 BPM drum-and-bass does not strobe.
 *  - Roughly 90% of cuts in professional short-form are hard cuts. Cycling
 *    through a transition library is the most recognisable tell of an
 *    auto-generated edit.
 * See docs/AUTOMATION.md §5.
 */

export interface MusicAnalysis {
  bpm: number
  /** Beat times in ms. */
  beats: number[]
  downbeats: number[]
  /** Per-beat energy tier, 0 (quiet) to 3 (peak). */
  tiers: number[]
  drops: { ms: number; score: number }[]
  buildups: { startMs: number; endMs: number; towardsMs: number }[]
  sections: number[]
  durationMs: number
}

export type CutReason = 'grid' | 'section' | 'drop' | 'buildup-end' | 'lyric'

/** 1 = soft, 2 = directional, 3 = aggressive. Null means a hard cut. */
export type TransitionTier = 1 | 2 | 3

export interface PlannedCut {
  ms: number
  frame: number
  reason: CutReason
  energyTier: number
  transitionTier: TransitionTier | null
  /**
   * What the cut landed on, when that is a thing worth naming.
   *
   * Only lyrics use it so far: "on the beat" is all there is to say about a
   * grid cut, but "on ‘break’" is the difference between an edit the user can
   * audit and one they have to take on trust.
   */
  label?: string
}

export interface CutPlanOptions {
  fps: number
  /** Shot length to aim for. ~2.2s sits inside the short-form norm. */
  targetShotSeconds?: number
  /** 0 disables transitions entirely; 1 puts one on every cut. */
  transitionRate?: number
  /**
   * Which cuts may carry a transition.
   *
   * `structural` (the default) reserves them for drops and section changes,
   * which is right for footage. `all` lets ordinary grid cuts have one too —
   * necessary for stills, where nothing else carries continuity across a cut.
   */
  transitionsOn?: 'structural' | 'all'
  /** Beats between cuts, overriding the tempo-derived choice. */
  beatsPerCut?: number
  /**
   * Moments in the VOCAL worth cutting on, from automation/lyrics.ts.
   *
   * A third source beside the grid and the structure, and the one that does not
   * come from the metre: a sung word lands where the singer put it, which is
   * usually a little off the beat, and that displacement is the performance
   * rather than an error to be corrected. They are inserted before the grid is
   * filled in, so a grid cut never lands a few frames from a lyric cut and
   * turns one moment into two.
   */
  lyrics?: { ms: number; punch: number; text: string }[]
  /**
   * How hard a lyric has to land to earn a cut of its own.
   *
   * Every word would be far too many — this is a filter on the punch value, not
   * on the words.
   */
  lyricPunch?: number
}

export const BEAT_MULTIPLES = [1, 2, 4, 8, 16] as const
export const DEFAULT_TARGET_SHOT_SECONDS = 2.2
/** Matches the ~90% hard-cut finding. */
export const DEFAULT_TRANSITION_RATE = 0.1

/**
 * Beats per cut, chosen so shot length lands near the target at any tempo.
 *
 * This is what keeps cut density roughly constant across tempos — a fixed beat
 * multiple gives wildly different pacing at 75 BPM versus 174.
 */
export function chooseBeatsPerCut(
  bpm: number,
  targetSeconds = DEFAULT_TARGET_SHOT_SECONDS
): number {
  if (!Number.isFinite(bpm) || bpm <= 0) return 4
  const beatSeconds = 60 / bpm
  let best: number = BEAT_MULTIPLES[0]
  let bestError = Infinity
  for (const multiple of BEAT_MULTIPLES) {
    const error = Math.abs(multiple * beatSeconds - targetSeconds)
    if (error < bestError) {
      bestError = error
      best = multiple
    }
  }
  return best
}

/** Energy tier at a moment, from the per-beat tiers. */
export function tierAt(analysis: MusicAnalysis, ms: number): number {
  if (analysis.tiers.length === 0 || analysis.beats.length === 0) return 1
  let index = 0
  for (let i = 0; i < analysis.beats.length; i++) {
    if (analysis.beats[i] > ms) break
    index = i
  }
  return analysis.tiers[Math.min(index, analysis.tiers.length - 1)] ?? 1
}

function nearest(values: number[], ms: number): number | null {
  if (values.length === 0) return null
  let best = values[0]
  for (const value of values) {
    if (Math.abs(value - ms) < Math.abs(best - ms)) best = value
  }
  return best
}

/**
 * Transition intensity for a moment.
 *
 * Aggressive treatments are reserved for drops. Quiet sections get soft ones or
 * nothing — matching intensity to energy is the whole of the craft advice here.
 */
export function transitionTierFor(reason: CutReason, energyTier: number): TransitionTier {
  if (reason === 'drop' || energyTier >= 3) return 3
  if (energyTier >= 2 || reason === 'buildup-end') return 2
  return 1
}

export function planCuts(analysis: MusicAnalysis, options: CutPlanOptions): PlannedCut[] {
  const { fps } = options
  const target = options.targetShotSeconds ?? DEFAULT_TARGET_SHOT_SECONDS
  const transitionRate = options.transitionRate ?? DEFAULT_TRANSITION_RATE

  if (analysis.beats.length < 2) return []

  const baseBeats = options.beatsPerCut ?? chooseBeatsPerCut(analysis.bpm, target)
  const grid = analysis.downbeats.length >= 2 ? analysis.downbeats : analysis.beats
  const beatsPerGridStep = analysis.downbeats.length >= 2 ? 4 : 1

  /* Structural moments always get a cut: a section change outranks the grid. */
  const structural = new Map<number, CutReason>()
  for (const drop of analysis.drops) structural.set(drop.ms, 'drop')
  for (const section of analysis.sections) {
    if (!structural.has(section)) structural.set(section, 'section')
  }
  for (const buildup of analysis.buildups) {
    if (!structural.has(buildup.endMs)) structural.set(buildup.endMs, 'buildup-end')
  }

  const cuts: PlannedCut[] = []
  const seen = new Set<number>()

  const push = (ms: number, reason: CutReason, label?: string): void => {
    const rounded = Math.round(ms)
    if (rounded < 0 || rounded > analysis.durationMs) return
    // Two cuts a few frames apart read as a glitch, not an edit.
    if (cuts.some((c) => Math.abs(c.ms - rounded) < 120)) return
    if (seen.has(rounded)) return
    seen.add(rounded)
    cuts.push({
      ms: rounded,
      frame: secondsToFrames(rounded / 1000, fps),
      reason,
      energyTier: tierAt(analysis, rounded),
      transitionTier: null,
      ...(label ? { label } : {})
    })
  }

  for (const [ms, reason] of structural) {
    // Snap structural moments onto the grid so they stay musical.
    const snapped = nearest(grid, ms)
    push(snapped !== null && Math.abs(snapped - ms) < 200 ? snapped : ms, reason)
  }

  /*
   * The vocal, before the grid rather than after it.
   *
   * Order is the whole of it. `push` refuses anything within 120ms of a cut
   * that is already there, so whichever source goes first wins the moment — and
   * a lyric that lost to a grid cut two frames away would have been silently
   * replaced by the mechanical version of itself, which is the exact thing
   * cutting to the lyric is for. Structural moments still outrank it: a drop is
   * a bigger event than a word.
   */
  const lyricFloor = options.lyricPunch ?? 0.7
  for (const lyric of options.lyrics ?? []) {
    if (lyric.punch >= lyricFloor) push(lyric.ms, 'lyric', lyric.text)
  }

  /* Then fill the gaps on the grid, pacing by energy. */
  let index = 0
  while (index < grid.length) {
    const ms = grid[index]
    push(ms, 'grid')

    const tier = tierAt(analysis, ms)
    // Denser through peaks, sparser when quiet — every source endorses varying
    // pace with energy rather than holding one rate throughout.
    const scale = tier >= 3 ? 0.5 : tier <= 0 ? 2 : 1
    const beats = Math.max(1, Math.round(baseBeats * scale))
    index += Math.max(1, Math.round(beats / beatsPerGridStep))
  }

  cuts.sort((a, b) => a.ms - b.ms)

  /* Transitions are rare and earned — unless the caller says otherwise. */
  /*
   * A lyric cut is never eligible for a transition, even when the caller asked
   * for transitions on everything.
   *
   * The reason to put an edit on a plosive is the hardness of it — the closure
   * releasing, which is the one thing in a vocal that has a transient in it.
   * Dissolving through that moment spends it. Hard cut or nothing.
   */
  const eligible =
    (options.transitionsOn ?? 'structural') === 'all'
      ? cuts.filter((c) => c.reason !== 'lyric')
      : cuts.filter((c) => c.reason !== 'grid' && c.reason !== 'lyric')
  // A floor of one keeps a short piece from getting none at all — but never
  // when the caller has explicitly asked for zero.
  const budget =
    transitionRate <= 0
      ? 0
      : Math.max(eligible.length > 0 ? 1 : 0, Math.round(cuts.length * transitionRate))

  // Structural cuts first — a drop outranks a section change.
  const ranked = eligible
    .filter((c) => c.reason !== 'grid' && c.reason !== 'lyric')
    .sort((a, b) => {
      const weight = (cut: PlannedCut): number =>
        cut.reason === 'drop' ? 3 : cut.reason === 'buildup-end' ? 2 : 1
      return weight(b) - weight(a) || b.energyTier - a.energyTier
    })

  const selected = new Set<PlannedCut>(ranked.slice(0, budget))

  /*
   * Spread whatever budget is left EVENLY rather than by rank.
   *
   * Ranking alone piles every transition into the loudest passage and leaves
   * the quiet one with none — which is backwards for stills, where a quiet
   * stretch of hard cuts is exactly what looks unfinished.
   */
  const remaining = budget - selected.size
  if (remaining > 0) {
    const rest = eligible.filter((c) => !selected.has(c))
    if (rest.length > 0) {
      const step = rest.length / remaining
      for (let i = 0; i < remaining && i < rest.length; i++) {
        selected.add(rest[Math.min(rest.length - 1, Math.floor(i * step))])
      }
    }
  }

  for (const cut of selected) {
    cut.transitionTier = transitionTierFor(cut.reason, cut.energyTier)
  }

  return cuts
}

/**
 * Transition families that suit each intensity tier.
 *
 * Tier is chosen from the music; the family is chosen from the tier; the
 * specific transition is chosen by index. Three small deterministic steps beat
 * one lookup table, and it means the 400-odd mask transitions slot in without
 * anything here knowing they exist.
 */
export const TIER_FAMILIES: Record<TransitionTier, string[]> = {
  1: ['dissolve', 'smooth', 'film', 'light'],
  2: ['slide', 'wipe', 'whip'],
  3: ['zoom', 'glitch', 'whip']
}

/**
 * Pick a transition for a cut from whatever the catalogue holds.
 *
 * Walks tier-appropriate families and varies by index, so consecutive
 * transitions differ even when the tier does not. Falls back down the tiers
 * before giving up, because an install with no glitch masks should still get
 * *something* on a drop.
 */
export function pickTransition(
  tier: TransitionTier,
  index: number,
  available: { id: string; family: string }[]
): string | null {
  if (available.length === 0) return null

  for (let t = tier; t >= 1; t--) {
    const families = TIER_FAMILIES[t as TransitionTier]
    const pool = available.filter((x) => families.includes(x.family))
    if (pool.length > 0) {
      // Stride across families first so two adjacent cuts rarely share one.
      const family = families[index % families.length]
      const inFamily = pool.filter((x) => x.family === family)
      const chosen = inFamily.length > 0 ? inFamily : pool
      return chosen[Math.abs(index * 7) % chosen.length].id
    }
  }
  return available[Math.abs(index) % available.length].id
}

/** Shot lengths a plan produces, for sanity-checking pacing. */
export function shotLengths(cuts: PlannedCut[], durationMs: number): number[] {
  if (cuts.length === 0) return []
  const lengths: number[] = []
  for (let i = 0; i < cuts.length; i++) {
    const end = i + 1 < cuts.length ? cuts[i + 1].ms : durationMs
    lengths.push(end - cuts[i].ms)
  }
  return lengths
}

export function cutsPerMinute(cuts: PlannedCut[], durationMs: number): number {
  if (durationMs <= 0) return 0
  return (cuts.length / durationMs) * 60_000
}

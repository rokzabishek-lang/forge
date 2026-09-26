import { secondsToFrames } from '../timeline'
import type { MusicAnalysis } from '../automation/cutPlan'
import { MIN_SEGMENT_SECONDS } from './menu'
import type { MomentKind, Place, Recipe, SoundEvent, TreatmentKind } from './recipes'
import type { TransitionFamily } from '../transitions/registry'

/**
 * The rhythm engine — the recipe, realised on the music (docs/PLAN.md §5.3).
 *
 * The model says which shots, which is the hero and how much each matters;
 * this decides every frame. Pure and deterministic: the same intentions on
 * the same beats give the same ad, and every rule is a test.
 *
 * The legal cuts are EVERY BEAT of the song, not the model's thinned menu:
 * measured in C0 (docs/EVAL.md), that menu offered 7–11 cuts for 6–8 photos,
 * and with the model no longer choosing cuts there is no reason to thin it.
 *
 * In order: reserve the ending (the end card and the black before it, beat
 * aligned back from the end); set each shot's target in beats from the
 * recipe's curve and holds, with the hero longest by a GLOBAL rule and never
 * under its floor in seconds; fit the body to the window — dropping shots the
 * music cannot hold, and ending early when it has too few; snap every boundary
 * to a beat, a structural one within half a beat winning; re-check the hero
 * after snapping; then place the moments, the treatment, the transitions, the
 * sounds and the cards on what is left.
 */

/** A shot as the plan intends it — what the engine needs to know, and nothing else. */
export interface ShotIntent {
  slotId: string
  kind: 'image' | 'video'
  /** A clip's footage in project frames; null for a still. */
  footageFrames: number | null
  weight: 'quick' | 'normal' | 'hold'
  /** The eyes saw a face or a couple, close or medium — it holds longer. */
  face: boolean
  hero: boolean
  headline: string
  /** For choosing which shot to drop when the music cannot hold them all. */
  sharpness?: number
  luma?: number
  /** A clip the rhythm engine may treat (grid, strips) needs a still or a bar of footage; a framing needs a subject. */
  hasSubject?: boolean
}

/** The beats the ad is cut on, on the timeline. */
export interface Grid {
  fps: number
  /** One beat, in frames (fractional). */
  beatFrames: number
  /** Every legal cut, ascending, including the start and the end. */
  beats: number[]
  /** Beats that are a drop, a section change or the end of a build, with the energy at each (0–3). */
  structural: Map<number, { reason: 'drop' | 'section' | 'buildup-end'; energy: number }>
  /** Energy at a beat, 0–3. */
  energyAt: (frame: number) => number
  start: number
  end: number
}

export interface ShotLayout {
  slotId: string
  startFrame: number
  endFrame: number
  /** The clip's own length: the span, or less when footage runs out. */
  clipFrames: number
  hero: boolean
}

export interface MomentEvent {
  kind: 'moment'
  moment: MomentKind
  /** The cut the moment is centred on. */
  frame: number
  from: string
  to: string
  place: Place
}

export interface TreatmentEvent {
  kind: 'treatment'
  treatment: TreatmentKind
  shot: number
  slotId: string
}

export interface SoundEventOut {
  event: SoundEvent
  /** The frame the sound's PEAK lands on (C3 lines each file's measured peak up with it). */
  frame: number
  /** For silence: where the music comes back. */
  untilFrame?: number
}

export interface Layout {
  shots: ShotLayout[]
  dropped: { slotId: string; why: string }[]
  black: { startFrame: number; endFrame: number } | null
  endCard: { startFrame: number; endFrame: number } | null
  /** A family transition entering the shot at this index. */
  transitions: { shot: number; family: TransitionFamily }[]
  moments: MomentEvent[]
  treatments: TreatmentEvent[]
  sounds: SoundEventOut[]
  /** A headline card over part of a shot. */
  cards: { shot: number; startFrame: number; endFrame: number }[]
  notes: string[]
  /** Where the ad really ends. Never later than asked. */
  endFrame: number
}

/** The hero is longest by at least this factor, against every other shot. */
export const HERO_LEAD = 1.3
/** How far past the recipe's own pacing a shot may be stretched to fill a long song, unless the recipe says otherwise. */
export const MAX_STRETCH = 1.5
/** Headline reading speed, and the shortest a card may be (as automation/caption.ts). */
export const CARD_CPS = 16
export const MIN_CARD_SECONDS = 1.5
/** A shot shorter than this is a glitch, not a cut. */
export const MIN_SHOT_SECONDS = MIN_SEGMENT_SECONDS

const WEIGHT: Record<ShotIntent['weight'], number> = { quick: 0.6, normal: 1, hold: 1.5 }

/* ------------------------------------------------------------------ grid */

/**
 * The legal cuts for an ad: every beat of the song inside the window, or an
 * even grid at the recipe's tempo when there is no song.
 *
 * The ad ends on the last beat at or before the length asked for — never
 * later. Structural moments snap to their nearest beat.
 */
export function rhythmGrid(
  analysis: MusicAnalysis | null,
  options: { fps: number; seconds: number; offsetFrames?: number; windowMs?: number; tempo: number }
): Grid {
  const { fps } = options
  const offset = options.offsetFrames ?? 0
  const musical = analysis !== null && analysis.beats.length >= 2 && analysis.bpm > 0
  const windowMs = Math.min(options.seconds * 1000, options.windowMs ?? (musical ? analysis.durationMs : options.seconds * 1000))
  const bpm = musical ? analysis.bpm : options.tempo
  const beatMs = 60_000 / bpm
  const beatFrames = (beatMs / 1000) * fps

  const beatMsList = musical
    ? analysis.beats.filter((ms) => ms > 0 && ms <= windowMs)
    : Array.from({ length: Math.floor(windowMs / beatMs) }, (_, i) => (i + 1) * beatMs)
  const toFrame = (ms: number): number => offset + secondsToFrames(ms / 1000, fps)
  const beats = [...new Set([offset, ...beatMsList.map(toFrame)])].sort((a, b) => a - b)
  const end = beats[beats.length - 1]

  const nearestBeat = (ms: number): number => {
    const f = toFrame(ms)
    let best = beats[0]
    for (const b of beats) if (Math.abs(b - f) < Math.abs(best - f)) best = b
    return best
  }
  const structural: Grid['structural'] = new Map()
  const tier = (ms: number): number => {
    if (!musical || analysis.tiers.length === 0) return 1
    const i = analysis.beats.findIndex((b) => b >= ms)
    return analysis.tiers[Math.max(0, i === -1 ? analysis.tiers.length - 1 : i)] ?? 1
  }
  if (musical) {
    for (const s of analysis.sections) if (s > 0 && s < windowMs) structural.set(nearestBeat(s), { reason: 'section', energy: tier(s) })
    for (const b of analysis.buildups) if (b.endMs > 0 && b.endMs < windowMs) structural.set(nearestBeat(b.endMs), { reason: 'buildup-end', energy: tier(b.endMs) })
    // Drops last: a beat that is both a section and a drop is a drop.
    for (const d of analysis.drops) if (d.ms > 0 && d.ms < windowMs) structural.set(nearestBeat(d.ms), { reason: 'drop', energy: Math.max(2, tier(d.ms)) })
  }
  const energyAt = (frame: number): number => (musical ? tier(((frame - offset) / fps) * 1000) : 1)
  return { fps, beatFrames, beats, structural, energyAt, start: offset, end }
}

/* ---------------------------------------------------------------- layout */

export interface LayoutOptions {
  /** Transition families actually installed; the recipe's list is filtered by it. */
  installed?: ReadonlySet<string>
}

export function layout(recipe: Recipe, grid: Grid, intents: ShotIntent[], options: LayoutOptions = {}): Layout {
  const notes: string[] = []
  const { fps, beatFrames } = grid
  const beatSeconds = beatFrames / fps
  const empty: Layout = { shots: [], dropped: [], black: null, endCard: null, transitions: [], moments: [], treatments: [], sounds: [], cards: [], notes, endFrame: grid.start }
  if (intents.length === 0 || grid.beats.length < 2) return empty

  /*
   * Everything below is in BEAT INDICES: a boundary is a beat, a length is a
   * whole number of beats. Working in frames let boundaries fall between
   * beats — at 160 BPM a beat is 11.25 frames, less than the shortest shot,
   * so the shortest shot there is TWO beats, which a frame-based fit missed.
   */
  const last = grid.beats.length - 1
  /*
   * The shortest each shot may be, in beats. A still: the recipe's floor — the
   * fast recipes leave a picture out rather than squeeze shots onto every beat.
   * A clip: the same, but never longer than its footage (a floor longer than
   * the clip would show black after it); never under the global minimum.
   */
  const globalMin = Math.max(1, Math.ceil(MIN_SHOT_SECONDS / beatSeconds - 1e-9))
  const minBeats = Math.max(globalMin, Math.ceil(recipe.shortestSeconds / beatSeconds - 1e-9))
  const minsFor = (list: ShotIntent[]): number[] =>
    list.map((s) =>
      s.footageFrames === null ? minBeats : Math.max(globalMin, Math.min(minBeats, Math.floor(s.footageFrames / fps / beatSeconds + 1e-9)))
    )
  const beatsFor = (seconds: number): number => Math.ceil(seconds / beatSeconds - 1e-9)

  /*
   * 0. A clip too short to fill even the shortest shot at this tempo is not a
   * shot: kept, it ended before its shot and left black on the track until the
   * next one (found by review). It is left out, as a picture the music cannot
   * hold is, and says why.
   */
  const shortest = globalMin * beatFrames
  const dropped: Layout['dropped'] = intents
    .filter((s) => s.footageFrames !== null && s.footageFrames < shortest - 1e-9)
    .map((s) => ({ slotId: s.slotId, why: `${((s.footageFrames ?? 0) / fps).toFixed(1)}s of footage is shorter than the shortest shot at this tempo (${(shortest / fps).toFixed(1)}s)` }))
  const playable = intents.filter((s) => !dropped.some((d) => d.slotId === s.slotId))
  if (playable.length === 0) return { ...empty, dropped }

  /* 1. The ending, counted back from the last beat: the end card, then the black. */
  let cardBeats = beatsFor(Math.max(MIN_CARD_SECONDS, recipe.ending.endCardSeconds))
  let blackBeats = Math.max(0, Math.round(recipe.ending.blackBeats))
  const minBody = Math.max(minBeats * Math.min(playable.length, 2), beatsFor(playable.length >= 2 ? 3 : 1.5))
  if (last - cardBeats - blackBeats < minBody && blackBeats > 0) {
    blackBeats = 0
    notes.push('the song is too short for the recipe\u2019s black before the end card — cut straight to it')
  }
  if (last - cardBeats - blackBeats < minBody) cardBeats = beatsFor(MIN_CARD_SECONDS)
  if (last - cardBeats - blackBeats < minBody) {
    cardBeats = 0
    notes.push('the song is too short for an end card — the last shot carries the call to action')
  }
  let bodyIdx = last - cardBeats - blackBeats
  let endIdx = last

  /* 2–3. Targets fitted to the window; drop what the music cannot hold; end early when it has too few. */
  let shots = playable.slice()
  let lengths: number[] = []
  for (;;) {
    const fitted = fit(recipe, shots, bodyIdx, beatSeconds, minsFor(shots), fps)
    if (!fitted) {
      const victim = dropCandidate(shots)
      if (victim === null) {
        // Only the hook and the hero are left and they still do not fit: the hero's floor yields.
        lengths = heroYields(shots, bodyIdx, minsFor(shots))
        notes.push('the song is too short for the recipe\u2019s hold on the hero — it holds as long as the music allows')
        break
      }
      dropped.push({ slotId: shots[victim].slotId, why: 'the music is too short to hold every shot' })
      shots = shots.filter((_, i) => i !== victim)
      continue
    }
    lengths = fitted.lengths
    if (fitted.short) {
      const body = Math.max(sum(minsFor(shots)), Math.round(lengths.reduce((a, b) => a + b, 0)))
      bodyIdx = Math.min(bodyIdx, body)
      endIdx = bodyIdx + blackBeats + cardBeats
      lengths = scaleTo(lengths, bodyIdx)
      notes.push(`the song is longer than these shots need — the ad ends at ${((grid.beats[endIdx] - grid.start) / fps).toFixed(1)}s`)
    }
    break
  }

  return finish(recipe, grid, shots, lengths, { body: bodyIdx, card: bodyIdx + blackBeats, end: endIdx }, minsFor(shots), dropped, notes, options)
}

/** The next beat at or after a frame. */
function snapUp(grid: Grid, frame: number): number {
  return grid.beats.find((b) => b >= frame) ?? grid.end
}

function scaleTo(lengths: number[], total: number): number[] {
  const sum = lengths.reduce((a, b) => a + b, 0)
  return sum > 0 ? lengths.map((l) => (l * total) / sum) : lengths
}

/**
 * Each shot's length in beats.
 *
 * The designed ad first: every other shot at the recipe's curve, the hero at
 * its own target — at least its floor, at least HERO_LEAD times the longest
 * other shot. Then the whole design scaled by ONE factor to fill the window,
 * so the hero keeps its lead over every shot, early or late, by construction.
 * When scaling down would take the hero under its floor, the hero stays at
 * the floor and only the others shrink.
 *
 * A clip is never longer than its footage — measured in C0, a clip given the
 * long last shot left up to 3 s of black. So a clip that would overrun is
 * FIXED at its footage and the rest re-solved around it, until nothing
 * overruns. `short` when filling would stretch the design past the recipe's
 * stretch limit (MAX_STRETCH unless it sets one) —
 * the ad then ends early; null when the shots cannot fit at their shortest,
 * and one must go.
 */
export function fit(
  recipe: Recipe,
  shots: ShotIntent[],
  W: number,
  beatSeconds: number,
  minBeats: number | readonly number[],
  fps: number
): { lengths: number[]; short: boolean } | null {
  const n = shots.length
  const mins = perShot(minBeats, n)
  const heroAt = Math.max(0, shots.findIndex((s) => s.hero))
  const p = (i: number): number => (n > 1 ? i / (n - 1) : 0)
  // The recipe paces in seconds; the fit works in this song's beats.
  const beatsAt = (x: number): number => recipe.pacing(x) / beatSeconds
  // The design, unclamped: the shortest-shot minimum is applied AFTER scaling, below.
  const raw = shots.map((s, i) => beatsAt(p(i)) * WEIGHT[s.weight] * (s.face ? recipe.hold.faces : 1))
  // The floor in WHOLE beats, rounded up: a floor of 6 s is 11 beats at 107 BPM, never 10.3 —
  // lengths are whole beats, and a fractional floor rounded the hero to 5.9 s.
  const floor = Math.max(mins[Math.max(0, shots.findIndex((s) => s.hero))], Math.ceil(recipe.hold.heroMinSeconds / beatSeconds - 1e-9))
  const heroTarget = Math.max(floor, beatsAt(p(heroAt)) * recipe.hold.hero)
  const maxOf = footageBeats(shots, beatSeconds, mins, fps)

  /*
   * Solve, then hold any shot that broke a bound AT the bound and solve the
   * rest again: a clip over its footage is held at its footage, a shot under
   * the shortest is held at the shortest. Holding a shot at the minimum
   * rather than failing is the difference between compressing an ad by 4 %
   * and dropping a photo from it — a shot designed at exactly one beat could
   * otherwise not shrink at all.
   */
  const fixed = new Map<number, number>()
  for (let pass = 0; pass <= 2 * n; pass++) {
    const solved = solveFree(raw, heroAt, fixed, W, floor, Math.min(heroTarget, maxOf[heroAt]), mins, recipe.maxStretch ?? MAX_STRETCH)
    if (!solved) return null
    const over = solved.lengths.findIndex((l, i) => !fixed.has(i) && l > maxOf[i] + 1e-9)
    if (over !== -1) {
      fixed.set(over, maxOf[over])
      continue
    }
    const under = solved.lengths.findIndex((l, i) => !fixed.has(i) && i !== heroAt && l < mins[i] - 1e-9)
    if (under !== -1) {
      fixed.set(under, mins[under])
      continue
    }
    return solved
  }
  return null
}

/** Each shot's longest length in whole beats: its footage for a clip, unlimited for a still. */
function footageBeats(shots: ShotIntent[], beatSeconds: number, mins: readonly number[], fps: number): number[] {
  return shots.map((s, i) =>
    s.footageFrames === null ? Infinity : Math.max(mins[i], Math.floor(s.footageFrames / fps / beatSeconds + 1e-9))
  )
}

/** The scale-by-one-factor solve, over the shots not already fixed at their footage. */
function solveFree(
  raw: number[],
  heroAt: number,
  fixed: Map<number, number>,
  W: number,
  floor: number,
  heroTarget: number,
  mins: readonly number[],
  stretch: number
): { lengths: number[]; short: boolean } | null {
  const free = raw.map((_, i) => i).filter((i) => i !== heroAt && !fixed.has(i))
  const fixedSum = [...fixed.values()].reduce((a, b) => a + b, 0)
  const fixedOthers = [...fixed.entries()].filter(([i]) => i !== heroAt).map(([, l]) => l)
  const Mfixed = fixedOthers.length > 0 ? Math.max(...fixedOthers) : 0
  const R = free.reduce((a, i) => a + raw[i], 0)
  const M = free.length > 0 ? Math.max(...free.map((i) => raw[i])) : 0
  const Wr = W - fixedSum
  const assemble = (s: number, hero: number | null): number[] =>
    raw.map((r, i) => (fixed.has(i) ? fixed.get(i)! : i === heroAt ? (hero ?? r) : r * s))

  if (raw.length === 1) {
    if (fixed.has(0)) return { lengths: [fixed.get(0)!], short: fixed.get(0)! < W }
    if (W < mins[0]) return null
    return W > heroTarget * stretch ? { lengths: [heroTarget * stretch], short: true } : { lengths: [W], short: false }
  }

  if (fixed.has(heroAt)) {
    // The hero is a clip held to its footage: the others fill around it, never past its lead.
    const H = fixed.get(heroAt)!
    // What is held already takes more than the window — the hero's footage and every other
    // shot at its shortest: a shot must go. Without this the plan came back longer than the
    // window and snapping squeezed the last shot under its minimum.
    if (Wr < -1e-9) return null
    if (R === 0) return { lengths: assemble(0, null), short: Wr > 1e-9 }
    const sLead = M > 0 ? H / (HERO_LEAD * M) : Infinity
    let s = Wr / R
    let short = false
    if (s > Math.min(stretch, sLead)) {
      s = Math.min(stretch, sLead)
      short = true
    }
      if (s <= 0) return null
    return { lengths: assemble(s, null), short }
  }

  const hero0 = Math.max(heroTarget, HERO_LEAD * M, HERO_LEAD * Mfixed)
  if (R === 0) {
    // Every other shot is held at a bound: the hero takes what is left — never less than its floor.
    if (Wr < Math.max(mins[heroAt], floor, HERO_LEAD * Mfixed)) return null
    return Wr > hero0 * stretch ? { lengths: assemble(0, hero0 * stretch), short: true } : { lengths: assemble(0, Wr), short: false }
  }
  const f = Wr / (R + hero0)
  if (f > stretch) return { lengths: assemble(stretch, hero0 * stretch), short: true }
  let s = f
  let hero = hero0 * f
  // The floor is hard here: when the window cannot give the hero its floor, a shot goes (the
  // caller drops one) — the floor yields only when just the hook and the hero are left (heroYields).
  const heroMin = Math.max(floor, HERO_LEAD * Mfixed)
  if (Wr < heroMin) return null
  if (hero < heroMin) {
    hero = heroMin
    s = (Wr - hero) / R
  }
  if (s <= 0 || hero < mins[heroAt]) return null
  return { lengths: assemble(s, hero), short: false }
}

/** When only the hook and the hero are left and still do not fit: the hook takes its minimum, the hero the rest. */
function heroYields(shots: ShotIntent[], W: number, mins: readonly number[]): number[] {
  const heroAt = Math.max(0, shots.findIndex((s) => s.hero))
  const others = sum(mins.filter((_, i) => i !== heroAt))
  return shots.map((_, i) => (i === heroAt ? Math.max(mins[i], W - others) : mins[i]))
}

/**
 * Which shot goes when the music cannot hold them all: never the hero, never
 * the hook (the first shot); a shot without a headline before one with; the
 * softest first, then the worst exposed, then the latest. Null when only the
 * hook and the hero are left.
 */
function dropCandidate(shots: ShotIntent[]): number | null {
  const candidates = shots.map((s, i) => ({ s, i })).filter(({ s, i }) => i > 0 && !s.hero)
  if (candidates.length === 0) return null
  candidates.sort((a, b) => {
    const ha = a.s.headline ? 1 : 0
    const hb = b.s.headline ? 1 : 0
    if (ha !== hb) return ha - hb
    const sa = a.s.sharpness ?? Infinity
    const sb = b.s.sharpness ?? Infinity
    if (sa !== sb) return sa - sb
    const ea = Math.abs((a.s.luma ?? 0.5) - 0.5)
    const eb = Math.abs((b.s.luma ?? 0.5) - 0.5)
    if (ea !== eb) return eb - ea
    return b.i - a.i
  })
  return candidates[0].i
}

/** A shot minimum given as one number for every shot, or one each. */
function perShot(minBeats: number | readonly number[], n: number): number[] {
  return typeof minBeats === 'number' ? Array.from({ length: n }, () => minBeats) : [...minBeats]
}

function sum(xs: readonly number[]): number {
  return xs.reduce((a, b) => a + b, 0)
}

/* ------------------------------------------------------------------ snap */

/**
 * The boundaries, as beat indices. Each: the nearest beat to its target at
 * least its shot's minimum after the previous one and leaving room for the rest; a
 * structural beat (drop, section, end of a build) within ONE beat of that
 * wins — on a grid of every beat, "within half a beat" is only the beat
 * itself; ties go to the earlier. The last boundary is the body's end.
 */
export function snapIndices(grid: Grid, lengths: number[], bodyIdx: number, minBeats: number | readonly number[], maxBeats: number[]): number[] {
  const mins = perShot(minBeats, lengths.length)
  const out: number[] = []
  let previous = 0
  let target = 0
  for (let k = 0; k < lengths.length; k++) {
    target += lengths[k]
    if (k === lengths.length - 1) {
      out.push(bodyIdx)
      break
    }
    const room = sum(mins.slice(k + 1))
    const lo = previous + mins[k]
    // Never past a clip's footage: rounding up to the next beat would leave black after it.
    const hi = Math.max(lo, Math.min(bodyIdx - room, previous + maxBeats[k]))
    const clamp = (i: number): number => Math.max(lo, Math.min(hi, i))
    const nearest = clamp(Math.round(target))
    const near = [nearest - 1, nearest, nearest + 1].filter((i) => i >= lo && i <= hi)
    const structural = near.filter((i) => grid.structural.has(grid.beats[i]))
    const pick = structural.length > 0 ? structural.reduce((a, b) => (Math.abs(b - target) < Math.abs(a - target) ? b : a)) : nearest
    out.push(pick)
    previous = pick
  }
  return out
}

/* ---------------------------------------------------------------- finish */

function finish(
  recipe: Recipe,
  grid: Grid,
  shots: ShotIntent[],
  lengths: number[],
  idx: { body: number; card: number; end: number },
  minBeats: readonly number[],
  dropped: Layout['dropped'],
  notes: string[],
  options: LayoutOptions
): Layout {
  const { fps, beatFrames } = grid
  const heroAt = Math.max(0, shots.findIndex((s) => s.hero))
  const beatAt = (i: number): number => grid.beats[Math.max(0, Math.min(grid.beats.length - 1, i))]
  const bodyEnd = beatAt(idx.body)

  const maxBeats = footageBeats(shots, beatFrames / fps, minBeats, fps)
  const endIdx = snapIndices(grid, lengths, idx.body, minBeats, maxBeats)
  const startIdx = [0, ...endIdx.slice(0, -1)]

  /* The hero, re-checked after snapping, against EVERY other shot — in whole beats. */
  const span = (i: number): number => beatAt(endIdx[i]) - beatAt(startIdx[i])
  const beatsOf = (i: number): number => endIdx[i] - startIdx[i]
  const heroFloor = secondsToFrames(recipe.hold.heroMinSeconds, fps)
  for (let guard = 0; guard < 4 * shots.length && shots.length > 1; guard++) {
    const longest = Math.max(...endIdx.map((_, i) => (i === heroAt ? 0 : span(i))))
    const need = Math.max(Math.min(heroFloor, bodyEnd - grid.start), Math.ceil(HERO_LEAD * longest))
    if (span(heroAt) >= need) break
    if (beatsOf(heroAt) >= maxBeats[heroAt]) {
      notes.push(`${shots[heroAt].slotId} holds ${(span(heroAt) / fps).toFixed(1)}s — all the footage there is`)
      break
    }
    // The longest shot that still has a beat to spare gives as many as it can; the loop
    // asks the next one for the rest. Asking only the single longest shot gave up whenever
    // it was already at its minimum, a few frames short of the hero's floor. Between shots
    // of the same length, the one nearest the hero gives: fewer cuts move, and the hook —
    // the first shot, often the longest on a curve that accelerates — keeps its length.
    const giver = endIdx
      .map((_, i) => i)
      .filter((i) => i !== heroAt && beatsOf(i) > minBeats[i])
      .sort((a, b) => span(b) - span(a) || Math.abs(a - heroAt) - Math.abs(b - heroAt))[0]
    if (giver === undefined) {
      notes.push(`${shots[heroAt].slotId} holds ${(span(heroAt) / fps).toFixed(1)}s — the other shots cannot give it more`)
      break
    }
    const want = Math.ceil((need - span(heroAt)) / beatFrames - 1e-9)
    const k = Math.max(1, Math.min(want, beatsOf(giver) - minBeats[giver], maxBeats[heroAt] - beatsOf(heroAt)))
    // Move every boundary between the hero and the giver k beats towards the giver.
    if (giver < heroAt) for (let i = giver; i < heroAt; i++) endIdx[i] -= k
    else for (let i = heroAt; i < giver; i++) endIdx[i] += k
    for (let i = 0; i < endIdx.length; i++) startIdx[i] = i === 0 ? 0 : endIdx[i - 1]
  }
  /*
   * A clip is never longer than its footage. The fit held each clip to it, but
   * snapping rounds, and the last shot takes what is left; so a clip still
   * over its footage is trimmed to it here and everything after it moves
   * earlier with it — the ad ends a beat or two sooner rather than showing black.
   */
  let shift = 0
  for (let i = 0; i < endIdx.length; i++) {
    endIdx[i] -= shift
    const over = endIdx[i] - (i === 0 ? 0 : endIdx[i - 1]) - maxBeats[i]
    if (over > 0) {
      endIdx[i] -= over
      shift += over
    }
  }
  for (let i = 0; i < endIdx.length; i++) startIdx[i] = i === 0 ? 0 : endIdx[i - 1]
  if (shift > 0) notes.push(`the ad ends ${((shift * beatFrames) / fps).toFixed(1)}s early, so no clip runs out of footage`)
  const cardStart = beatAt(idx.card - shift)
  const endFrame = beatAt(idx.end - shift)
  const starts = startIdx.map(beatAt)
  const ends = endIdx.map(beatAt)

  const shotLayout: ShotLayout[] = shots.map((s, i) => {
    const frames = ends[i] - starts[i]
    const clipFrames = s.footageFrames !== null ? Math.min(frames, s.footageFrames) : frames
    if (clipFrames < frames) notes.push(`${s.slotId} is ${(clipFrames / fps).toFixed(1)}s of footage — its shot was ${(frames / fps).toFixed(1)}s`)
    return { slotId: s.slotId, startFrame: starts[i], endFrame: ends[i], clipFrames, hero: i === heroAt }
  })

  const lastShotEnd = ends[ends.length - 1]
  const black = cardStart > lastShotEnd ? { startFrame: lastShotEnd, endFrame: cardStart } : null
  const endCard = endFrame > cardStart ? { startFrame: cardStart, endFrame } : null

  const boundaries = shotLayout.slice(1).map((s, k) => ({ shot: k + 1, frame: s.startFrame }))
  const bar = beatFrames * 4

  /* 5. Moments, at the recipe's places, in its order. */
  const moments: MomentEvent[] = []
  const taken = new Set<number>()
  const farFromMoments = (frame: number): boolean => moments.every((m) => Math.abs(m.frame - frame) >= bar)
  const at = (place: Place): { shot: number; frame: number } | null => {
    const open = boundaries.filter((b) => b.shot >= 2 && !taken.has(b.shot) && farFromMoments(b.frame))
    if (place === 'hero-reveal') return open.find((b) => b.shot === heroAt) ?? null
    if (place === 'drop') {
      const drops = open.filter((b) => grid.structural.get(b.frame)?.reason === 'drop')
      return drops.sort((a, b) => grid.energyAt(b.frame) - grid.energyAt(a.frame))[0] ?? null
    }
    if (place === 'section') return open.find((b) => grid.structural.has(b.frame)) ?? null
    // climax: the loudest boundary left.
    return open.slice().sort((a, b) => grid.energyAt(b.frame) - grid.energyAt(a.frame))[0] ?? null
  }
  for (const place of recipe.moments.at) {
    if (moments.length >= recipe.moments.budget) break
    const spot = at(place)
    if (!spot) continue
    const kind = recipe.moments.kinds[moments.length % recipe.moments.kinds.length]
    taken.add(spot.shot)
    moments.push({ kind: 'moment', moment: kind, frame: spot.frame, from: shots[spot.shot - 1].slotId, to: shots[spot.shot].slotId, place })
  }

  /* 6. The treatment: fits its slot, never the hook, the hero, the last shot or a moment's shot. */
  const treatments: TreatmentEvent[] = []
  for (const place of recipe.treatments.at) {
    if (treatments.length >= recipe.treatments.budget) break
    for (const kind of recipe.treatments.kinds) {
      const fits = (i: number): boolean => {
        const s = shots[i]
        if (i === 0 || i === heroAt || i === shots.length - 1 || taken.has(i)) return false
        if (kind === 'clipping') return s.headline.trim().length > 0
        if (kind === 'framing') return s.kind === 'image' && s.hasSubject === true
        return s.kind === 'image' || (s.footageFrames ?? 0) >= bar
      }
      const wanted = boundaries.filter((b) => fits(b.shot))
      const pick =
        place === 'drop'
          ? wanted.find((b) => grid.structural.get(b.frame)?.reason === 'drop')
          : place === 'section'
            ? wanted.find((b) => grid.structural.has(b.frame))
            : wanted.slice().sort((a, b) => grid.energyAt(b.frame) - grid.energyAt(a.frame))[0]
      if (pick) {
        treatments.push({ kind: 'treatment', treatment: kind, shot: pick.shot, slotId: shots[pick.shot].slotId })
        taken.add(pick.shot)
        break
      }
    }
  }

  /* 7. Transitions: a share of the boundaries for stills, structural ones only for footage; never where a moment is. */
  const families = recipe.transitions.families.filter((f) => !options.installed || options.installed.has(f))
  const transitions: Layout['transitions'] = []
  if (families.length > 0) {
    const footage = shots.some((s) => s.kind === 'video')
    const free = boundaries.filter((b) => !taken.has(b.shot))
    const chosen = footage
      ? free.filter((b) => grid.structural.has(b.frame))
      : spread(free, Math.round(boundaries.length * recipe.transitions.stillsShare), (b) => grid.structural.has(b.frame))
    chosen.forEach((b, k) => transitions.push({ shot: b.shot, family: families[k % families.length] }))
  }

  /* 8. Sounds, down-selected like the moments. */
  const sounds: SoundEventOut[] = []
  const heroFrame = shotLayout[heroAt].startFrame
  let hits = 0
  for (const rule of recipe.sound.rules) {
    if ((rule.event === 'riser' || rule.event === 'swell' || rule.event === 'sub') && rule.on === 'hero-reveal' && heroAt > 0) {
      sounds.push({ event: rule.event, frame: heroFrame })
    } else if ((rule.event === 'hit' || rule.event === 'sub') && rule.on === 'drop') {
      const drops = boundaries
        .filter((b) => grid.structural.get(b.frame)?.reason === 'drop')
        .sort((a, b) => grid.energyAt(b.frame) - grid.energyAt(a.frame) || a.frame - b.frame)
      for (const d of drops) {
        if (hits >= recipe.sound.maxHits) break
        if (sounds.some((s) => (s.event === 'hit' || s.event === 'sub') && Math.abs(s.frame - d.frame) < bar)) continue
        sounds.push({ event: rule.event, frame: d.frame })
        hits++
      }
    } else if (rule.event === 'whoosh' && rule.on === 'whip') {
      for (const t of transitions) {
        if (t.family !== 'whip') continue
        const frame = shotLayout[t.shot].startFrame
        if (sounds.some((s) => s.event === 'whoosh' && Math.abs(s.frame - frame) < bar)) continue
        sounds.push({ event: 'whoosh', frame })
      }
    } else if (rule.on === 'before-black' && black) {
      if (rule.event === 'silence') sounds.push({ event: 'silence', frame: black.startFrame, untilFrame: black.endFrame })
      else sounds.push({ event: rule.event, frame: black.startFrame })
    }
  }

  /* 9. Cards: from the shot's start, for as long as the words take, never past the shot; at most maxCards. */
  let cards = shots
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => s.headline.trim().length > 0)
    .map(({ s, i }) => {
      const chars = Array.from(s.headline).length
      const want = snapUp(grid, shotLayout[i].startFrame + secondsToFrames(Math.max(MIN_CARD_SECONDS, chars / CARD_CPS), fps))
      return { shot: i, startFrame: shotLayout[i].startFrame, endFrame: Math.min(shotLayout[i].endFrame, want) }
    })
  if (cards.length > recipe.type.maxCards) {
    const keep = cards
      .slice()
      .sort((a, b) => grid.energyAt(b.startFrame) - grid.energyAt(a.startFrame) || a.shot - b.shot)
      .slice(0, recipe.type.maxCards)
      .map((c) => c.shot)
    for (const c of cards) if (!keep.includes(c.shot)) notes.push(`${shots[c.shot].slotId}'s headline dropped — the recipe keeps ${recipe.type.maxCards} cards`)
    cards = cards.filter((c) => keep.includes(c.shot))
  }

  return { shots: shotLayout, dropped, black, endCard, transitions, moments, treatments, sounds, cards, notes, endFrame }
}

/**
 * `count` items spread evenly through a list, structural ones first. The
 * reel's lesson (AUTOMATION.md §5b): ranked selection clusters every
 * transition in the loudest passage; spreading does not.
 */
function spread<T>(items: T[], count: number, preferred: (t: T) => boolean): T[] {
  if (count <= 0 || items.length === 0) return []
  const first = items.filter(preferred).slice(0, count)
  const rest = items.filter((t) => !first.includes(t))
  const need = count - first.length
  const picked = need <= 0 ? [] : Array.from({ length: Math.min(need, rest.length) }, (_, i) => rest[Math.floor((i * rest.length) / Math.min(need, rest.length))])
  const chosen = new Set([...first, ...picked])
  return items.filter((t) => chosen.has(t))
}

import type { Clip, MediaAsset, Motion, MotionMove, Project, TextSpec, Track } from '../timeline'
import {
  DEFAULT_TEXT,
  addTrack,
  anchorTransition,
  clipEnd,
  stackedSlot,
  trackLimitReached
} from '../timeline'
import { chooseMove } from '../automation/reel'
import { wordsInRange } from '../transcript'
import type { DecisionRecord } from '../project'
import type { Problem } from './conforms'
import { SPINE_PASS, type Brief, type Pace, type Role, type SpinePlan } from './schema'
import type { Menu, Slot } from './menu'
import type { SegmentLayout } from './validate'
import { fitHeadline } from './baseline'

/**
 * Turn a validated plan into ordinary clips, in one project update.
 *
 * Everything the director makes is a normal clip the user can drag, trim or
 * delete, labelled with why it is there (docs/AUTOMATION.md §1) — a shot per
 * segment on the video track, a text card per headline on the lane above,
 * transitions on the clips that enter with one. Nothing is hidden and nothing
 * is held in a private shape.
 *
 * The plan arrives already validated and LAID OUT: `SegmentLayout` says which
 * frames each segment occupies, whether a video was capped, the energy of the
 * cut it starts on. This file does not work any of that out again — two places
 * computing the same frame is two places to disagree.
 *
 * The store calls `applySpine` once and does one `update()` with the result,
 * which is what makes the whole plan one undo.
 */

export const SPINE_RULE = 'director.spine'
export const COPY_RULE = 'director.copy'
/** The black before the end card and the end card itself (apply2.ts). */
export const ENDING_RULE = 'director.ending'
/** The recipe's one grade, an adjustment layer over the shots (apply2.ts). */
export const LOOK_RULE = 'director.look'
/** A blurred copy of a shot under it, for a picture whose shape is far from the frame's (apply2.ts). */
export const BACKDROP_RULE = 'director.backdrop'
/** A sound the rhythm engine fired, as a clip on the Director's own lane (sound.ts); `clearDirector` takes the file it brought too. */
export const SOUND_RULE = 'director.sound'
export const DIRECTOR_RULES: readonly string[] = [SPINE_RULE, COPY_RULE, ENDING_RULE, LOOK_RULE, BACKDROP_RULE, SOUND_RULE]

/**
 * The accent on the punch word.
 *
 * Both fields, always: `TextSpec.highlight` changes a word's paint only when
 * a colour or a scale is given (render/textPaint.ts), so a highlight with
 * neither is the same paint as the rest — invisible. The caption styles set
 * the precedent for the values.
 */
export const PUNCH_COLOR = '#FFD400'
export const PUNCH_SCALE = 1.15

/** How long the music takes to go, when the ad ends before the song does. */
export const MUSIC_FADE_SECONDS = 0.6

/** Camera-move strength by pace. The reel's default sits in the middle. */
const MOTION_BY_PACE: Record<Pace, number> = { punchy: 0.18, steady: 0.14, calm: 0.1 }
const SHAKE_HZ = 11

export interface ApplyContext {
  fps: number
  /** The track the shots go on — footage, so the bottom of the picture. */
  videoTrackId: string
  brief: Brief
  /** What produced the plan, for the clip reasons. */
  model: string
  /** Installed transitions, for picking a family member. */
  catalogue: { id: string; family: string }[]
  /** The music clip, when there is one — trimmed to the ad and ducked under speech. */
  musicClipId?: string
  /** Assets with a usable depth bake: parallax instead of a flat move. */
  parallaxAssets?: ReadonlySet<string>
  /** Id maker for new clips and assets; injectable so tests are deterministic. */
  newId?: (prefix: string) => string
}

export interface Applied {
  project: Project
  problems: Problem[]
  /** The shots, in segment order. */
  clipIds: string[]
  /** The text cards, whose PNGs the store bakes afterwards. */
  cardClipIds: string[]
}

const defaultId = (prefix: string): string =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`

/* ------------------------------------------------------------------ clear */

/**
 * Remove everything a previous run made, and undo what it changed.
 *
 * Three things, because each was missed once. The director's clips go by
 * rule, as every automation's do. The text cards' ASSETS go with them when
 * nothing else uses them — `clearGenerated` alone left a baked PNG entry in
 * the media pool per headline per run, and the next run's slot list offered
 * them as product shots. And the music clip, which the director SHORTENED
 * rather than made, gets its length and fade back from `directorTrim`: a
 * user's clip with no record of its original length can only ever get
 * shorter, run after run.
 */
export function clearDirector(project: Project): Project {
  const removed = project.clips.filter(
    (c) => c.generatedBy !== undefined && DIRECTOR_RULES.includes(c.generatedBy.rule)
  )
  const emptyDirectorTrack = (clips: Clip[]) => (t: Track): boolean => t.director === true && !clips.some((c) => c.trackId === t.id)
  if (removed.length === 0 && !project.clips.some((c) => c.directorTrim) && !project.tracks.some(emptyDirectorTrack(project.clips))) return project

  const gone = new Set(removed.map((c) => c.id))
  const survivors = project.clips.filter((c) => !gone.has(c.id))
  const stillUsed = new Set(survivors.map((c) => c.assetId))
  // Only what the director DREW — cards, colour cards, the look layer — or BROUGHT from the sound
  // library (the asset says so); never footage or a sound the user imported, even when a shot or a
  // sound was its only reference.
  const brought = new Set(project.assets.filter((a) => a.broughtBy === SOUND_RULE).map((a) => a.id))
  const cardAssets = new Set(
    removed.filter((c) => c.text || c.solid || c.adjustment || brought.has(c.assetId)).map((c) => c.assetId)
  )

  // The track the Director added under the ad goes with the ad; one the user has since put a clip on stays —
  // and, as removeTrack keeps it, a project is never left without a video track.
  const tracks = project.tracks.filter((t) => !emptyDirectorTrack(survivors)(t))
  return {
    ...project,
    tracks: tracks.some((t) => t.kind === 'video') ? tracks : project.tracks,
    clips: survivors.map((c) => (c.directorTrim ? restoreTrim(c) : c)),
    assets: project.assets.filter((a) => !(cardAssets.has(a.id) && !stillUsed.has(a.id)))
  }
}

function restoreTrim(clip: Clip): Clip {
  const { directorTrim, fadeOut: _fade, keyframes, ...rest } = clip
  if (!directorTrim) return clip
  // The silence the Director drew on the music goes with the ad; an envelope of the user's own was never written over.
  let kept = keyframes
  if (directorTrim.silenced && keyframes) {
    const { volume: _silence, ...others } = keyframes
    kept = Object.keys(others).length > 0 ? others : undefined
  }
  return {
    ...rest,
    ...(kept ? { keyframes: kept } : {}),
    duration: directorTrim.duration,
    ...(directorTrim.fadeOut !== undefined ? { fadeOut: directorTrim.fadeOut } : {})
  }
}

/** Clips that are NOT the director's on a track over a span — the ad cannot be built over them. */
export function occupiedBy(project: Project, trackId: string, startFrame: number, endFrame: number): Clip[] {
  return project.clips.filter(
    (c) =>
      c.trackId === trackId &&
      !(c.generatedBy && DIRECTOR_RULES.includes(c.generatedBy.rule)) &&
      c.start < endFrame &&
      clipEnd(c) > startFrame
  )
}

/* ------------------------------------------------------------------ apply */

export function applySpine(
  project: Project,
  plan: SpinePlan,
  layout: SegmentLayout[],
  menu: Menu,
  ctx: ApplyContext
): Applied {
  const problems: Problem[] = []
  const newId = ctx.newId ?? defaultId
  const { fps } = ctx
  let next = clearDirector(project)
  const { width, height } = next.settings

  const slotById = new Map(menu.slots.map((s) => [s.id, s]))
  const assetById = new Map(next.assets.map((a) => [a.id, a]))

  /* Shots. */
  const shots: { clip: Clip; slot: Slot; asset: MediaAsset; index: number }[] = []
  let previousMove: MotionMove | null = null
  let anySpeech = false

  plan.segments.forEach((segment, i) => {
    const lay = layout[i]
    const slot = slotById.get(segment.slot)
    const asset = slot ? assetById.get(slot.assetId) : undefined
    if (!slot || !asset || !lay) {
      problems.push({ path: `$.segments[${i}].slot`, message: `${segment.slot} is no longer in the project — shot skipped` })
      return
    }

    const amount = MOTION_BY_PACE[plan.pace]
    let motion: Motion | undefined
    if (slot.kind === 'image') {
      const hasDepth = ctx.parallaxAssets?.has(asset.id) ?? false
      if (lay.startReason === 'drop') {
        // The reel's rule: let the music hit, hold the subject if there is one.
        motion = {
          kind: 'shake',
          amount: amount * (hasDepth ? 1.1 : 0.6),
          hz: SHAKE_HZ,
          ...(hasDepth ? { anchor: 'subject' as const } : {})
        }
      } else {
        const move = chooseMove(i, lay.energy, previousMove, hasDepth)
        previousMove = move
        motion = {
          kind: hasDepth ? 'parallax' : 'kenburns',
          direction: move,
          amount: amount * (lay.energy >= 3 ? 1.45 : lay.energy <= 1 ? 0.8 : 1)
        }
      }
    }

    /*
     * A clip keeps its own sound only when someone is talking in it — decided
     * from the transcript, not by the model. B-roll under music is muted;
     * a demo with a voice is heard, and the music ducks under it.
     */
    const speaks = slot.kind === 'video' && hasSpeech(next, asset, lay.clipFrames, fps)
    if (speaks) anySpeech = true

    const clip: Clip = {
      id: newId('dir'),
      assetId: asset.id,
      trackId: ctx.videoTrackId,
      start: lay.startFrame,
      duration: lay.clipFrames,
      inPoint: 0,
      volume: slot.kind === 'video' && !speaks ? 0 : 1,
      transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
      color: { brightness: 0, contrast: 1, saturation: 1 },
      generatedBy: { rule: SPINE_RULE, reason: `${segment.role} · ${segment.why || slot.label}` },
      ...(motion ? { motion } : {})
    }
    shots.push({ clip, slot, asset, index: i })
  })

  next = { ...next, clips: [...next.clips, ...shots.map((s) => s.clip)] }

  /*
   * Transitions, after every shot is placed so each has the one before it to
   * blend from. Anchored, never rippled: every boundary sits on a beat, and
   * `addTransition` would drag them all off it (timeline.ts explains).
   *
   * `anchorTransition` lengthens the OUTGOING clip to make the overlap and
   * checks nothing about its source — for a still that is fine, for a video
   * already at the end of its footage the extra frames have no picture and
   * the dissolve blends in from black. So the overlap is held to the footage
   * that is left, and skipped when there is none. And it is only applied when
   * the two shots actually touch: a capped video leaves a gap, and a
   * transition across a gap blends from the wrong thing.
   */
  shots.forEach((shot, k) => {
    if (k === 0) return
    const segment = plan.segments[shot.index]
    if (segment.enter === 'cut') return
    const prev = shots[k - 1]
    const at = `$.segments[${shot.index}].enter`

    if (clipEnd(prev.clip) !== shot.clip.start) {
      problems.push({
        path: at,
        message: `${shot.slot.id} enters with a cut — the shot before it ends ${((shot.clip.start - clipEnd(prev.clip)) / fps).toFixed(1)}s early`
      })
      return
    }

    let frames = Math.round(fps * (layout[shot.index].energy >= 2 ? 0.22 : 0.32))
    if (prev.slot.kind === 'video' && !prev.asset.frames) {
      const headroom = prev.asset.durationFrames - prev.clip.inPoint - prev.clip.duration
      if (headroom < 1) {
        problems.push({
          path: at,
          message: `${shot.slot.id} enters with a cut — ${prev.slot.id} has no footage left to blend from`
        })
        return
      }
      frames = Math.min(frames, headroom)
    }

    const member = memberFor(segment.enter, shot.index, ctx.catalogue)
    if (!member) {
      problems.push({ path: at, message: `no "${segment.enter}" transition is installed — entered with a cut` })
      return
    }
    next = anchorTransition(next, shot.clip.id, member, frames)
  })

  /* Cards. */
  const cardClipIds: string[] = []
  const placeCard = (content: string, role: Role, start: number, duration: number, punch: number, at: string): void => {
    let slot = stackedSlot(next, ctx.videoTrackId, start, duration)
    if (!slot) {
      if (trackLimitReached(next)) {
        problems.push({ path: at, message: `no free layer for the "${clip20(content)}" card — dropped` })
        return
      }
      next = addTrack(next, 'video', 'top')
      slot = stackedSlot(next, ctx.videoTrackId, start, duration)
      if (!slot) {
        problems.push({ path: at, message: `no free layer for the "${clip20(content)}" card — dropped` })
        return
      }
    }
    const clipId = newId('dir-card')
    const assetId = `${clipId}-asset`
    const spec: TextSpec = {
      ...DEFAULT_TEXT,
      content,
      position: role === 'hook' || role === 'cta' ? 'center' : 'lower',
      size: sizeFor(role, content),
      ...(punch >= 0 ? { highlight: { word: punch, color: PUNCH_COLOR, scale: PUNCH_SCALE } } : {}),
      version: 1
    }
    // Exactly what `addTextClip` writes: the PNG lands later, in the background,
    // and the preview draws the type live; `size: 0` marks it as drawn, not imported.
    const asset: MediaAsset = {
      id: assetId,
      path: '',
      name: content,
      kind: 'image',
      durationFrames: Math.max(duration, Math.round(fps * 10)),
      width,
      height,
      fps: null,
      hasVideo: true,
      hasAudio: false,
      size: 0
    }
    const card: Clip = {
      id: clipId,
      assetId,
      trackId: slot.trackId,
      start: slot.start,
      duration,
      inPoint: 0,
      volume: 1,
      transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
      color: { brightness: 0, contrast: 1, saturation: 1 },
      text: spec,
      generatedBy: { rule: COPY_RULE, reason: `${role} headline` }
    }
    next = { ...next, assets: [...next.assets, asset], clips: [...next.clips, card] }
    cardClipIds.push(clipId)
  }

  shots.forEach((shot) => {
    const segment = plan.segments[shot.index]
    const lay = layout[shot.index]
    if (!segment.headline) return
    placeCard(
      segment.headline,
      segment.role,
      lay.startFrame,
      lay.endFrame - lay.startFrame,
      lay.punch,
      `$.segments[${shot.index}].headline`
    )
  })

  /* The call to action, when the plan forgot one and the brief has one. */
  const lastShot = shots[shots.length - 1]
  if (lastShot && !plan.segments.some((s) => s.role === 'cta') && ctx.brief.cta.trim()) {
    const lay = layout[lastShot.index]
    const span = lay.endFrame - lay.startFrame
    const duration = Math.max(1, Math.round(span * 0.4))
    const start = lay.endFrame - duration
    const content = fitHeadline(ctx.brief.cta, duration / fps)
    if (content) placeCard(content, 'cta', start, duration, 0, '$.cta')
  }

  /* The music: as long as the ad, and heard under speech. */
  if (ctx.musicClipId && lastShot) {
    const adEnd = layout[lastShot.index].endFrame
    next = {
      ...next,
      clips: next.clips.map((c) => (c.id === ctx.musicClipId ? trimMusic(c, adEnd, fps) : c)),
      tracks: anySpeech
        ? next.tracks.map((t) =>
            t.id === next.clips.find((c) => c.id === ctx.musicClipId)?.trackId ? { ...t, duck: true } : t
          )
        : next.tracks
    }
  }

  return { project: next, problems, clipIds: shots.map((s) => s.clip.id), cardClipIds }
}

/**
 * Shorten the music to the ad, remembering what it was.
 *
 * `??` on the stamp, not `=`: a clip that already carries a trim keeps its
 * ORIGINAL length in the record, so the second trim is measured from what
 * the user placed, not from what the last run left. In `applySpine` the clip
 * has always just been restored by `clearDirector`, so this is defence for any
 * other caller — exported and tested on its own for exactly that reason.
 * Never lengthened — the source may have no more.
 */
export function trimMusic(music: Clip, adEnd: number, fps: number): Clip {
  if (adEnd >= clipEnd(music) || adEnd <= music.start) return music
  const duration = adEnd - music.start
  return {
    ...music,
    directorTrim: {
      duration: music.directorTrim?.duration ?? music.duration,
      ...((music.directorTrim ? music.directorTrim.fadeOut : music.fadeOut) !== undefined
        ? { fadeOut: music.directorTrim ? music.directorTrim.fadeOut : music.fadeOut }
        : {})
    },
    duration,
    fadeOut: Math.max(0, Math.min(Math.round(fps * MUSIC_FADE_SECONDS), duration - 1))
  }
}

/** Does someone speak in the first `frames` of this clip — from the transcript, never the model. */
export function hasSpeech(project: Project, asset: MediaAsset, frames: number, fps: number): boolean {
  const transcript = project.transcripts[asset.id]
  if (!transcript) return false
  return wordsInRange(transcript, 0, (frames / fps) * 1000).length > 0
}

/**
 * A member of a family, varying by index so two adjacent cuts rarely share
 * one. Same stride as the reel's `pickTransition`.
 */
export function memberFor(family: string, index: number, catalogue: { id: string; family: string }[]): string | null {
  const members = catalogue.filter((t) => t.family === family)
  if (members.length === 0) return null
  return members[Math.abs(index * 7) % members.length].id
}

/**
 * Type size from the role's ceiling and the line's length.
 *
 * At size 0.12 on a phone frame a row holds about eight characters, so a
 * legal forty-character hook would wrap to five rows — a wall, not a title.
 * The ladder keeps a card to two rows or so.
 */
export function sizeFor(role: Role, content: string): number {
  const ceiling = role === 'hook' || role === 'cta' ? 0.12 : 0.08
  const length = Array.from(content).length
  if (length <= 10) return ceiling
  if (length <= 20) return Math.min(ceiling, 0.085)
  if (length <= 30) return Math.min(ceiling, 0.07)
  return Math.min(ceiling, 0.06)
}

const clip20 = (text: string): string => (text.length > 20 ? `${text.slice(0, 20)}…` : text)

/* --------------------------------------------------------------- decision */

/**
 * The record that goes in the project file.
 *
 * Saved rather than re-derived: inference is only reproducible on the same
 * machine with the same build, so "reopening shows the same edit" has to be a
 * property of the file (docs/DIRECTOR.md §10.3). The plan is stored whole,
 * with the pass id so a later change to its shape is visible.
 */
export function decisionFor(
  plan: SpinePlan,
  model: { id: string; runtime: string },
  options: { id?: string; now?: Date } = {}
): DecisionRecord {
  return {
    id: options.id ?? defaultId('decision'),
    pass: SPINE_PASS,
    ops: [plan],
    model: { id: model.id, runtime: model.runtime },
    createdAt: (options.now ?? new Date()).toISOString()
  }
}

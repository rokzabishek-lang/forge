import type { Clip, MediaAsset, Motion, MotionMove, Project, TextSpec } from '../timeline'
import { DEFAULT_TEXT, addTrack, anchorTransition, clipEnd, stackedSlot, trackLimitReached } from '../timeline'
import type { DecisionRecord } from '../project'
import type { Problem } from './conforms'
import {
  COPY_RULE,
  ENDING_RULE,
  LOOK_RULE,
  PUNCH_COLOR,
  PUNCH_SCALE,
  SPINE_RULE,
  clearDirector,
  hasSpeech,
  memberFor,
  trimMusic
} from './apply'
import { punchIndex } from './validate'
import type { Brief } from './schema'
import type { Role2 } from './recipes'
import { SLOW_SPEED, type Composed } from './compose'
import { SPINE2_PASS, type Menu2 } from './schema2'

/**
 * A composed `spine@2` ad, as ordinary clips, in one project update (docs/PLAN.md §5.6).
 *
 * The shots with their moves and speeds, the transitions the rhythm engine
 * chose, the black and the end card, the headline cards in the ad's one style
 * and animation, the recipe's grade as an adjustment layer over the shots
 * (below the cards, so the type is not graded), and the music trimmed to the
 * ad. Every clip carries why it is there and a rule `clearDirector` removes.
 *
 * Cards, colour cards and the look layer are self-drawn: they land here with
 * an empty path and `size: 0`, and the store draws their pictures afterwards
 * without an undo step — exactly as `spine@1`'s cards always have.
 *
 * The moments, the treatment and the sounds the engine placed are recorded in
 * the decision for C3 and C4 to realise; this does not draw them.
 */

export interface ApplyContext2 {
  fps: number
  videoTrackId: string
  brief: Brief
  model: string
  catalogue: { id: string; family: string }[]
  musicClipId?: string
  parallaxAssets?: ReadonlySet<string>
  /** The recipe look's LUT, when the look library has it. */
  lookFile?: { file: string; name: string } | null
  newId?: (prefix: string) => string
}

export interface Applied2 {
  project: Project
  problems: Problem[]
  clipIds: string[]
  /** Text cards whose PNGs the store draws afterwards. */
  cardClipIds: string[]
  /** Colour cards and the look layer, likewise. */
  solidClipIds: string[]
}

const defaultId = (prefix: string): string => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`

const TRANSFORM = { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }
const NEUTRAL = { brightness: 0, contrast: 1, saturation: 1 }

/** A camera move's strength from the recipe's intensity — the reel's range, 0.08 to 0.2. */
export function moveAmount(intensity: number): number {
  return 0.08 + 0.12 * Math.max(0, Math.min(1, intensity))
}

/** Type size from the role and the line's length: the same ladder `spine@1` uses. */
export function sizeFor2(role: Role2 | 'end', content: string): number {
  const ceiling = role === 'hook' || role === 'cta' || role === 'end' ? 0.12 : 0.08
  const longest = Math.max(...content.split('\n').map((l) => Array.from(l).length))
  if (longest <= 10) return ceiling
  if (longest <= 20) return Math.min(ceiling, 0.085)
  if (longest <= 30) return Math.min(ceiling, 0.07)
  return Math.min(ceiling, 0.06)
}

/** What the end card says, by the recipe's kind of ending. */
export function endCardText(kind: 'names-date' | 'product-cta' | 'title-cta', brief: Brief): string {
  const product = brief.product.trim()
  const cta = brief.cta.trim()
  if (kind === 'names-date') return cta ? `${product}\n${cta}` : product
  return cta ? `${product}\n${cta}` : product
}

/** An empty drawn asset — the store fills its path once the picture is drawn. */
function drawnAsset(id: string, name: string, duration: number, width: number, height: number, fps: number): MediaAsset {
  return { id, path: '', name, kind: 'image', durationFrames: Math.max(duration, Math.round(fps * 10)), width, height, fps: null, hasVideo: true, hasAudio: false, size: 0 }
}

export function applyRecipe(project: Project, composed: Composed, menu: Menu2, ctx: ApplyContext2): Applied2 {
  const problems: Problem[] = []
  const newId = ctx.newId ?? defaultId
  const { fps } = ctx
  const { plan, recipe, layout } = composed
  let next = clearDirector(project)
  const { width, height } = next.settings
  const slotById = new Map(menu.slots.map((s) => [s.id, s]))
  const assetById = new Map(next.assets.map((a) => [a.id, a]))
  const amount = moveAmount(recipe.intensity)

  /* The shots. */
  const shots: { clip: Clip; slotId: string; video: boolean; index: number }[] = []
  let anySpeech = false
  layout.shots.forEach((laid, i) => {
    const shot = plan.shots[i]
    const slot = slotById.get(laid.slotId)
    const asset = slot ? assetById.get(slot.assetId) : undefined
    if (!slot || !asset) {
      problems.push({ path: `$.shots[${i}]`, message: `${laid.slotId} is no longer in the project — shot skipped` })
      return
    }
    let motion: Motion | undefined
    if (slot.kind === 'image') {
      const depth = ctx.parallaxAssets?.has(asset.id) ?? false
      if (laid.hero) {
        const kind = recipe.moves.heroMove
        if (kind === 'parallax' && depth) motion = { kind: 'parallax', direction: 'in', amount: amount * 1.2 }
        else if (kind !== 'hold') motion = { kind: 'kenburns', direction: 'in', amount: amount * 1.3 }
      } else if (shot.move !== 'hold') {
        motion = { kind: depth ? 'parallax' : 'kenburns', direction: shot.move as MotionMove, amount }
      }
    }
    const frames = laid.endFrame - laid.startFrame
    const slow = slot.kind === 'video' && shot.speed === 'slow'
    const speaks = slot.kind === 'video' && hasSpeech(next, asset, laid.clipFrames, fps)
    if (speaks) anySpeech = true
    if (slot.kind === 'video' && shot.speed === 'ramp') {
      problems.push({ path: `$.shots[${i}].speed`, message: `${slot.id}: speed ramps are not drawn yet — played at normal speed` })
    }
    const clip: Clip = {
      id: newId('dir'),
      assetId: asset.id,
      trackId: ctx.videoTrackId,
      start: laid.startFrame,
      duration: laid.clipFrames,
      inPoint: 0,
      volume: slot.kind === 'video' && !speaks ? 0 : 1,
      transform: { ...TRANSFORM },
      color: { ...NEUTRAL },
      generatedBy: { rule: SPINE_RULE, reason: `${recipe.name} · ${shot.role}${laid.hero ? ' · hero' : ''} · ${shot.why || slot.label}` },
      ...(motion ? { motion } : {}),
      ...(slow ? { speed: SLOW_SPEED } : {})
    }
    if (laid.clipFrames < frames) problems.push({ path: `$.shots[${i}]`, message: `${slot.id} ends ${((frames - laid.clipFrames) / fps).toFixed(1)}s before its shot` })
    shots.push({ clip, slotId: slot.id, video: slot.kind === 'video', index: i })
  })
  next = { ...next, clips: [...next.clips, ...shots.map((s) => s.clip)] }

  /* Transitions, anchored on the boundary the engine chose; never across a gap, never from a clip with no footage left. */
  for (const t of layout.transitions) {
    const shot = shots.find((s) => s.index === t.shot)
    const prev = shots.find((s) => s.index === t.shot - 1)
    if (!shot || !prev) continue
    const at = `$.shots[${t.shot}]`
    if (clipEnd(prev.clip) !== shot.clip.start) {
      problems.push({ path: at, message: `${shot.slotId} enters with a cut — the shot before it ends early` })
      continue
    }
    let frames = Math.round(fps * 0.3)
    if (prev.video) {
      const asset = assetById.get(prev.clip.assetId)!
      const headroom = asset.durationFrames - prev.clip.inPoint - Math.round(prev.clip.duration * (prev.clip.speed ?? 1))
      if (headroom < 1) {
        problems.push({ path: at, message: `${shot.slotId} enters with a cut — ${prev.slotId} has no footage left to blend from` })
        continue
      }
      frames = Math.min(frames, headroom)
    }
    const member = memberFor(t.family, t.shot, ctx.catalogue)
    if (!member) {
      problems.push({ path: at, message: `no "${t.family}" transition is installed — entered with a cut` })
      continue
    }
    next = anchorTransition(next, shot.clip.id, member, frames)
  }

  /* The black and the end card, on the shots' track. */
  const solidClipIds: string[] = []
  const placeSolid = (start: number, duration: number, reason: string): void => {
    const id = newId('dir-black')
    const assetId = `${id}-asset`
    next = {
      ...next,
      assets: [...next.assets, drawnAsset(assetId, 'Black', duration, width, height, fps)],
      clips: [
        ...next.clips,
        { id, assetId, trackId: ctx.videoTrackId, start, duration, inPoint: 0, volume: 1, transform: { ...TRANSFORM }, color: { ...NEUTRAL }, solid: { color: '#000000', opacity: 1, version: 1 }, generatedBy: { rule: ENDING_RULE, reason } }
      ]
    }
    solidClipIds.push(id)
  }
  if (layout.black) placeSolid(layout.black.startFrame, layout.black.endFrame - layout.black.startFrame, 'the black before the end card')
  if (layout.endCard) placeSolid(layout.endCard.startFrame, layout.endCard.endFrame - layout.endCard.startFrame, 'under the end card')

  /* The look: one adjustment layer over the shots, on the lane above them — placed before the cards, so the type sits over it, ungraded. */
  const bodyEnd = layout.shots.length > 0 ? layout.shots[layout.shots.length - 1].endFrame : 0
  if (recipe.look !== 'none' && ctx.lookFile && bodyEnd > 0) {
    const start = layout.shots[0].startFrame
    const lane = laneFor(start, bodyEnd - start)
    if (lane) {
      const id = newId('dir-look')
      const assetId = `${id}-asset`
      next = {
        ...next,
        assets: [...next.assets, { ...drawnAsset(assetId, 'Adjustment', bodyEnd - start, 16, 16, fps), name: 'Adjustment' }],
        clips: [
          ...next.clips,
          {
            id, assetId, trackId: lane.trackId, start: lane.start, duration: bodyEnd - start, inPoint: 0, volume: 1,
            transform: { ...TRANSFORM },
            color: { ...NEUTRAL, lut: { file: ctx.lookFile.file, name: ctx.lookFile.name, intensity: 0.6 + 0.3 * recipe.intensity } },
            adjustment: true,
            generatedBy: { rule: LOOK_RULE, reason: `${recipe.name}: one grade over the ad` }
          }
        ]
      }
      solidClipIds.push(id)
    } else problems.push({ path: '$.look', message: 'no free layer for the look — not graded' })
  } else if (recipe.look !== 'none' && !ctx.lookFile) {
    problems.push({ path: '$.look', message: `the "${recipe.look}" look is not installed — not graded` })
  }

  /* The cards: headlines over their shots, and the end card over its black. */
  const cardClipIds: string[] = []
  function laneFor(start: number, duration: number): { trackId: string; start: number } | null {
    let slot = stackedSlot(next, ctx.videoTrackId, start, duration)
    if (!slot && !trackLimitReached(next)) {
      next = addTrack(next, 'video', 'top')
      slot = stackedSlot(next, ctx.videoTrackId, start, duration)
    }
    return slot
  }
  const placeCard = (content: string, role: Role2 | 'end', start: number, duration: number, punch: number, why: string): void => {
    const lane = laneFor(start, duration)
    if (!lane) {
      problems.push({ path: '$.cards', message: `no free layer for the "${content.slice(0, 20)}" card — dropped` })
      return
    }
    const id = newId('dir-card')
    const assetId = `${id}-asset`
    const spec: TextSpec = {
      ...DEFAULT_TEXT,
      content,
      position: role === 'hook' || role === 'cta' || role === 'end' ? 'center' : 'lower',
      size: sizeFor2(role, content),
      styleId: plan.style,
      animationId: plan.animation,
      ...(punch >= 0 ? { highlight: { word: punch, color: PUNCH_COLOR, scale: PUNCH_SCALE } } : {}),
      version: 1
    }
    next = {
      ...next,
      assets: [...next.assets, drawnAsset(assetId, content, duration, width, height, fps)],
      clips: [
        ...next.clips,
        { id, assetId, trackId: lane.trackId, start: lane.start, duration, inPoint: 0, volume: 1, transform: { ...TRANSFORM }, color: { ...NEUTRAL }, text: spec, generatedBy: { rule: COPY_RULE, reason: why } }
      ]
    }
    cardClipIds.push(id)
  }
  for (const card of layout.cards) {
    const shot = plan.shots[card.shot]
    if (!shot?.headline) continue
    placeCard(shot.headline, shot.role, card.startFrame, card.endFrame - card.startFrame, shot.punch_word ? punchIndex(shot.headline, shot.punch_word) : -1, `${shot.role} headline`)
  }
  if (layout.endCard) {
    placeCard(endCardText(recipe.type.endCard, ctx.brief), 'end', layout.endCard.startFrame, layout.endCard.endFrame - layout.endCard.startFrame, -1, 'the end card')
  }

  /* The music: as long as the ad, and ducked under speech. */
  if (ctx.musicClipId && layout.shots.length > 0) {
    next = {
      ...next,
      clips: next.clips.map((c) => (c.id === ctx.musicClipId ? trimMusic(c, layout.endFrame, fps) : c)),
      tracks: anySpeech
        ? next.tracks.map((t) => (t.id === next.clips.find((c) => c.id === ctx.musicClipId)?.trackId ? { ...t, duck: true } : t))
        : next.tracks
    }
  }

  return { project: next, problems, clipIds: shots.map((s) => s.clip.id), cardClipIds, solidClipIds }
}

/** The decision, saved whole: the plan, the recipe, and what the engine placed for C3 and C4. */
export function decisionFor2(
  composed: Composed,
  model: { id: string; runtime: string },
  options: { id?: string; now?: Date } = {}
): DecisionRecord {
  const { layout } = composed
  return {
    id: options.id ?? defaultId('decision'),
    pass: SPINE2_PASS,
    ops: [
      {
        plan: composed.plan,
        recipe: composed.recipe.id,
        layout: { shots: layout.shots, black: layout.black, endCard: layout.endCard, endFrame: layout.endFrame },
        events: { moments: layout.moments, treatments: layout.treatments, sounds: layout.sounds }
      }
    ],
    model: { id: model.id, runtime: model.runtime },
    createdAt: (options.now ?? new Date()).toISOString()
  }
}

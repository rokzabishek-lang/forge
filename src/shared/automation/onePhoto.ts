import type { Clip, CropRect, Motion, MotionMove, Project } from '../timeline'
import { findFreeSlot, secondsToFrames } from '../timeline'
import type { MusicAnalysis, TransitionTier } from './cutPlan'
import { planCuts } from './cutPlan'
import { chooseMove, DEFAULT_MOTION_AMOUNT, DEFAULT_REEL_TRANSITION_RATE } from './reel'
import { barSecondsFor, splitCaption } from './caption'
import { chooseFramings, framingLadder, type Framing, type Source } from './framing'

/**
 * A reel from one photograph.
 *
 * The hard part is that a single still has nothing to cut to. Everything the
 * viewer reads as an edit has to be manufactured, from three sources:
 *
 *  1. Framing — the photograph is treated as several shots. See framing.ts.
 *  2. Camera — a move inside each shot, arriving on the beat.
 *  3. Text — with one picture, the words carry the rhythm. Cards land on bars,
 *     and the tempo decides how many words fit on one. See caption.ts.
 *
 * The music owns every timing decision, exactly as in the multi-photo reel. What
 * is new here is that the *framing* is a timing decision too: with nothing else
 * changing, a cut is only a cut if the frame changed enough to read as one.
 */

export const ONE_PHOTO_RULE = 'onephoto.reel'
export const ONE_PHOTO_CAPTION_RULE = 'onephoto.caption'

export interface OnePhotoShot {
  startFrame: number
  durationFrames: number
  /** Null for a full-frame shot, which is the only kind depth planes can take. */
  crop: CropRect | null
  motion: Motion | null
  transitionTier: TransitionTier | null
  framing: Framing['label']
  reason: string
}

export interface OnePhotoCard {
  text: string
  startFrame: number
  durationFrames: number
  reason: string
}

export interface OnePhotoPlan {
  shots: OnePhotoShot[]
  cards: OnePhotoCard[]
  ladder: Framing[]
}

export interface OnePhotoOptions {
  analysis: MusicAnalysis
  fps: number
  /** The photograph, in its own pixels. */
  source: Source
  /** Canvas aspect, width over height. */
  aspectRatio: number
  outputHeight: number
  /** Where the person is, from the matte. Null means every crop is a guess. */
  subject?: CropRect | null
  caption?: string
  /** Whether this photo has a usable depth bake. */
  hasDepth?: boolean
  motionAmount?: number
  transitionRate?: number
  targetShotSeconds?: number
}

/** Punctuation on the biggest moments, matching the multi-photo reel. */
const SHAKE_HZ = 11

export function planOnePhotoReel(options: OnePhotoOptions): OnePhotoPlan {
  const {
    analysis,
    fps,
    source,
    aspectRatio,
    outputHeight,
    subject = null,
    caption = '',
    hasDepth = false,
    motionAmount = DEFAULT_MOTION_AMOUNT,
    transitionRate = DEFAULT_REEL_TRANSITION_RATE,
    targetShotSeconds
  } = options

  const ladder = framingLadder(source, aspectRatio, subject, { outputHeight })
  const cuts = planCuts(analysis, {
    fps,
    transitionRate,
    transitionsOn: 'all',
    ...(targetShotSeconds ? { targetShotSeconds } : {})
  })

  const framings = chooseFramings(ladder, cuts.length)
  const shots: OnePhotoShot[] = []
  let previousMove: MotionMove | null = null

  for (let i = 0; i < cuts.length; i++) {
    const cut = cuts[i]
    // Between the cuts' own frames, so the shots tile exactly. A length taken
    // from the millisecond gap rounds independently of the positions and can
    // come out a frame too long, which pushes the next shot off its beat.
    const endFrame =
      i + 1 < cuts.length
        ? cuts[i + 1].frame
        : secondsToFrames(analysis.durationMs / 1000, fps)
    const durationFrames = endFrame - cut.frame
    if (durationFrames < 2) continue

    const framing = framings[shots.length] ?? ladder[0]
    /*
     * Depth planes are composited at the bake's own resolution, which is not the
     * photograph's, so a crop in source pixels would land in the wrong place.
     * Parallax therefore belongs to the full-frame shots; the framed ones take
     * an ordinary move inside their crop, which is what a punch-in wants anyway.
     */
    const fullFrame = framing.label === 'wide'
    const depthShot = hasDepth && fullFrame

    let motion: Motion | null = null
    if (motionAmount > 0) {
      if (cut.reason === 'drop') {
        // Let the music hit. With depth the subject holds and the scene takes
        // the blow, which reads as force rather than a camera wobble.
        motion = {
          kind: 'shake',
          amount: motionAmount * (depthShot ? 1.1 : 0.6),
          hz: SHAKE_HZ,
          ...(depthShot ? { anchor: 'subject' as const } : {})
        }
      } else {
        const move = chooseMove(shots.length, cut.energyTier, previousMove, depthShot)
        previousMove = move
        const scale = cut.energyTier >= 3 ? 1.45 : cut.energyTier <= 1 ? 0.8 : 1
        motion = {
          kind: depthShot ? 'parallax' : 'kenburns',
          direction: move,
          // A tight crop has fewer pixels to travel through before the move
          // runs out of picture, so it moves less.
          amount: motionAmount * scale * (framing.scale > 2 ? 0.7 : 1)
        }
      }
    }

    shots.push({
      startFrame: cut.frame,
      durationFrames,
      crop: depthShot ? null : framing.rect,
      motion,
      transitionTier: cut.transitionTier,
      framing: framing.label,
      reason: `${framingWord(framing)} · ${cutWord(cut.reason)}${depthShot ? ' · depth' : ''}`
    })
  }

  return { shots, cards: planCards(caption, analysis, fps), ladder }
}

/**
 * Lay the caption out on bars.
 *
 * Bars, not beats: a card that changes every beat flickers past unread at any
 * tempo worth cutting to.
 */
export function planCards(
  caption: string,
  analysis: MusicAnalysis,
  fps: number
): OnePhotoCard[] {
  const text = caption.trim()
  if (!text) return []

  const barSeconds = barSecondsFor(analysis.bpm)
  const cards = splitCaption(text, { barSeconds })
  if (cards.length === 0) return []

  const bars = barGrid(analysis, barSeconds)
  const out: OnePhotoCard[] = []
  let bar = 0

  for (const card of cards) {
    const startMs = bars[Math.min(bar, bars.length - 1)]
    const endBar = bar + card.bars
    const endMs = endBar < bars.length ? bars[endBar] : startMs + card.bars * barSeconds * 1000
    if (startMs >= analysis.durationMs) break

    const startFrame = secondsToFrames(startMs / 1000, fps)
    const durationFrames = Math.max(
      1,
      secondsToFrames(Math.min(endMs, analysis.durationMs) / 1000, fps) - startFrame
    )
    out.push({
      text: card.text,
      startFrame,
      durationFrames,
      reason: card.bars === 1 ? 'on the bar' : `${card.bars} bars`
    })
    bar = endBar
  }
  return out
}

/**
 * Bar starts in ms.
 *
 * Downbeats when the analysis found them, every fourth beat when it only found
 * beats, and an even grid from the tempo when it found neither — a caption
 * should still land sensibly on a track the analyser struggled with.
 */
function barGrid(analysis: MusicAnalysis, barSeconds: number): number[] {
  if (analysis.downbeats.length >= 2) return analysis.downbeats
  if (analysis.beats.length >= 4) return analysis.beats.filter((_, i) => i % 4 === 0)

  const step = barSeconds * 1000
  const count = Math.max(1, Math.ceil(analysis.durationMs / step))
  return Array.from({ length: count }, (_, i) => i * step)
}

function framingWord(framing: Framing): string {
  switch (framing.label) {
    case 'wide':
      return 'wide'
    case 'aside':
      return 'looking away'
    case 'medium':
      return 'medium'
    case 'close':
      return 'close'
    default:
      return 'detail'
  }
}

function cutWord(reason: string): string {
  switch (reason) {
    case 'drop':
      return 'on the drop'
    case 'section':
      return 'section change'
    case 'buildup-end':
      return 'end of the build'
    default:
      return 'on the beat'
  }
}

/**
 * The picture clips.
 *
 * Ordinary, visible, deletable clips labelled with why they fired — the same
 * baseline-plus-diff contract every other automation follows.
 */
export function onePhotoClips(
  project: Project,
  shots: OnePhotoShot[],
  trackId: string,
  assetId: string
): Clip[] {
  let placed: Project = { ...project, clips: [...project.clips] }

  return shots.map((shot, index) => {
    const start = findFreeSlot(placed, trackId, shot.startFrame, shot.durationFrames)
    const clip: Clip = {
      id: `onephoto-${index}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      assetId,
      trackId,
      start,
      duration: shot.durationFrames,
      inPoint: 0,
      volume: 1,
      // `cover` rather than `contain`: the crop already matches the canvas, and
      // a full-frame shot of a landscape photo would otherwise letterbox.
      transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, fit: 'cover' },
      color: { brightness: 0, contrast: 1, saturation: 1 },
      generatedBy: { rule: ONE_PHOTO_RULE, reason: shot.reason },
      ...(shot.crop ? { crop: shot.crop } : {}),
      ...(shot.motion ? { motion: shot.motion } : {})
    }
    placed = { ...placed, clips: [...placed.clips, clip] }
    return clip
  })
}

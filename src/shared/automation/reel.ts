import type { Clip, MediaAsset, Motion, MotionMove, Project } from '../timeline'
import { findFreeSlot, secondsToFrames } from '../timeline'
import type { MusicAnalysis, PlannedCut, TransitionTier } from './cutPlan'
import { planCuts, type CutPlanOptions } from './cutPlan'

/**
 * Build a beat-synced reel from stills.
 *
 * The music owns all the timing: photos have no rhythm of their own, so every
 * cut point comes from the analysis. What the music does NOT own is the camera —
 * that is chosen here, from a repertoire wide enough that the reel does not
 * settle into a pattern. See docs/AUTOMATION.md §5.
 */

export const REEL_RULE = 'reel.beatsync'

export interface ReelShot {
  assetId: string
  startFrame: number
  durationFrames: number
  motion: Motion | null
  transitionTier: TransitionTier | null
  reason: string
}

export interface ReelOptions extends CutPlanOptions {
  /** Camera-move strength; 0 disables motion. */
  motionAmount?: number
  /**
   * Asset ids with a usable depth bake.
   *
   * Parallax is decided per shot, not per reel: a photo that would not separate
   * gets the ordinary flat move and the reel is still coherent. Passing the set
   * in keeps the decision here, where it is pure and testable, rather than in
   * the store where it would not be.
   */
  parallaxAssets?: ReadonlySet<string>
}

export const DEFAULT_MOTION_AMOUNT = 0.14

/**
 * Stills need far more transitions than footage does.
 *
 * The ~90% hard-cut finding comes from editing *footage*, where the subject's
 * own movement carries the cut. Two unrelated photographs have no such
 * continuity, so the same rate leaves a reel looking like a contact sheet. A
 * majority of cuts get a treatment here, and the treatments stay short.
 */
export const DEFAULT_REEL_TRANSITION_RATE = 0.55

/** Punctuation on the biggest moments; a whole reel of it would be unwatchable. */
const SHAKE_HZ = 11

/**
 * Move pools by energy.
 *
 * Quiet passages get slow drifts, peaks get pushes. Matching the camera to the
 * music is the difference between a reel that breathes and one that is merely
 * on time.
 */
const CALM: MotionMove[] = ['panRight', 'out', 'panLeft', 'outLeft', 'panUp', 'outRight']
const MID: MotionMove[] = ['in', 'panRight', 'inLeft', 'panDown', 'inRight', 'panLeft']
const PEAK: MotionMove[] = ['in', 'inRight', 'inUp', 'inLeft', 'inDown', 'out']

/**
 * Moves for a shot that has depth planes.
 *
 * A centred push is the WORST move to show parallax with. Its displacement is
 * radial, so the planes separate by a few percent spread evenly around the
 * frame and the result reads as a slightly odd zoom — which is exactly what the
 * first parallax build looked like.
 *
 * A lateral move is unmistakable: the foreground slides across the background.
 * At the capped amount a pan moves the near plane about 10% of frame width and
 * the back plane about 3%, so roughly 7% of open, obvious separation. So a
 * depth shot pans, and only drifts diagonally for variety — it never sits on a
 * dead-centre push.
 */
const PARALLAX: MotionMove[] = [
  'panRight',
  'panLeft',
  'panDown',
  'inLeft',
  'panUp',
  'inRight'
]

/** A move followed by its mirror reads as a bounce, so those pairs are skipped. */
const OPPOSITE: Partial<Record<MotionMove, MotionMove>> = {
  in: 'out',
  out: 'in',
  inLeft: 'inRight',
  inRight: 'inLeft',
  inUp: 'inDown',
  inDown: 'inUp',
  outLeft: 'outRight',
  outRight: 'outLeft',
  panLeft: 'panRight',
  panRight: 'panLeft',
  panUp: 'panDown',
  panDown: 'panUp'
}

/**
 * Choose the move for a shot.
 *
 * Deterministic in the shot index, so rebuilding a reel does not reshuffle every
 * move the user has already watched. The stride is coprime with the pool size,
 * which walks the whole pool without ever picking neighbours in order.
 */
export function chooseMove(
  index: number,
  energyTier: number,
  previous: MotionMove | null,
  hasDepth = false
): MotionMove {
  const pool = hasDepth ? PARALLAX : energyTier >= 3 ? PEAK : energyTier <= 1 ? CALM : MID
  const stride = 5
  for (let attempt = 0; attempt < pool.length; attempt++) {
    const move = pool[(index * stride + attempt) % pool.length]
    if (move === previous) continue
    if (previous && OPPOSITE[previous] === move) continue
    return move
  }
  return pool[index % pool.length]
}

/**
 * Assign images to the shots a cut plan defines.
 *
 * Images cycle when there are fewer than shots, which is the common case — a
 * dozen photos over a 30-second track. Cycling beats stretching each one,
 * because a still held for eight seconds is dead air however it moves.
 */
export function planReel(
  images: MediaAsset[],
  analysis: MusicAnalysis,
  options: ReelOptions
): ReelShot[] {
  if (images.length === 0) return []

  const cuts = planCuts(analysis, {
    ...options,
    transitionRate: options.transitionRate ?? DEFAULT_REEL_TRANSITION_RATE,
    transitionsOn: options.transitionsOn ?? 'all'
  })
  if (cuts.length === 0) return []

  const fps = options.fps
  const amount = options.motionAmount ?? DEFAULT_MOTION_AMOUNT
  const shots: ReelShot[] = []
  let previous: MotionMove | null = null

  for (let i = 0; i < cuts.length; i++) {
    const cut: PlannedCut = cuts[i]
    /*
     * Length from the next cut's FRAME, not from the millisecond gap.
     *
     * The two disagree by a frame whenever the rounding goes different ways,
     * and a shot one frame too long overlaps the next one — which `findFreeSlot`
     * then resolves by nudging that shot a frame later, off the beat it was
     * planned for. Measuring between the frames the cuts actually landed on
     * makes the shots tile exactly, with no gap and nothing to resolve.
     */
    const endFrame =
      i + 1 < cuts.length
        ? cuts[i + 1].frame
        : secondsToFrames(analysis.durationMs / 1000, fps)
    const durationFrames = endFrame - cut.frame
    if (durationFrames < 2) continue

    const assetId = images[shots.length % images.length].id
    const hasDepth = options.parallaxAssets?.has(assetId) ?? false

    let motion: Motion | null = null
    if (amount > 0) {
      if (cut.reason === 'drop') {
        /*
         * The one place a held shot beats a moving one: let the music hit.
         *
         * With depth planes the subject is held and the scene takes the hit,
         * which reads as force applied to the world rather than a camera
         * wobble. Unlike parallax this cannot expose the baked fill — a subject
         * that does not move keeps covering exactly the same pixels.
         */
        motion = {
          kind: 'shake',
          amount: amount * (hasDepth ? 1.1 : 0.6),
          hz: SHAKE_HZ,
          ...(hasDepth ? { anchor: 'subject' as const } : {})
        }
      } else {
        const move = chooseMove(shots.length, cut.energyTier, previous, hasDepth)
        previous = move
        // Peaks want more travel than a verse does.
        const scale = cut.energyTier >= 3 ? 1.45 : cut.energyTier <= 1 ? 0.8 : 1
        motion = {
          kind: hasDepth ? 'parallax' : 'kenburns',
          direction: move,
          // No reduction for depth: planeAmount already caps the spread at what
          // the baked fill band can cover, and scaling down on top of that was
          // what made the first parallax build look like an uneven Ken Burns.
          amount: amount * scale
        }
      }
    }

    shots.push({
      assetId,
      startFrame: cut.frame,
      durationFrames,
      motion,
      transitionTier: cut.transitionTier,
      reason:
        (cut.reason === 'drop'
          ? 'on the drop'
          : cut.reason === 'section'
            ? 'section change'
            : cut.reason === 'buildup-end'
              ? 'end of the build'
              : cut.reason === 'lyric'
                ? // Naming the word is the whole value of cutting to it: the
                  // timeline can then be read back against the song.
                  `on “${cut.label ?? 'the word'}”`
                : 'on the beat') + (motion?.kind === 'parallax' ? ' · depth' : '')
    })
  }

  return shots
}

export function reelClips(project: Project, shots: ReelShot[], trackId: string): Clip[] {
  let placed: Project = { ...project, clips: [...project.clips] }

  return shots.map((shot, index) => {
    const start = findFreeSlot(placed, trackId, shot.startFrame, shot.durationFrames)
    const clip: Clip = {
      id: `reel-${index}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      assetId: shot.assetId,
      trackId,
      start,
      duration: shot.durationFrames,
      inPoint: 0,
      volume: 1,
      transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
      color: { brightness: 0, contrast: 1, saturation: 1 },
      generatedBy: { rule: REEL_RULE, reason: shot.reason },
      ...(shot.motion ? { motion: shot.motion } : {})
    }
    // Later shots must see earlier ones, or they all collapse onto one slot.
    placed = { ...placed, clips: [...placed.clips, clip] }
    return clip
  })
}

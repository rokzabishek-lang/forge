/**
 * A camera move set by hand (FIX.md B3) — the rules the Inspector's Camera
 * panel and the zoom keyframes share.
 *
 * The moves themselves are render/motion.ts; the automations have always set
 * them. This is what it takes to let a person set one: which clips can take a
 * move, what range each number may have, and the one conflict that matters —
 * a camera move and zoom keyframes both scale the picture, so a clip with both
 * would compound them in the export (the plan takes the move and ignores the
 * keys, and the preview does the same). Choosing one takes the other off, and
 * the caller is told so it can say so.
 */

import type { Clip, MediaAsset, Motion, Project } from '../timeline'
import {
  DEFAULT_SHAKE_DECAY,
  DEFAULT_SHAKE_HZ,
  MAX_PARALLAX_AMOUNT,
  clampAmount
} from '../render/motion'

/**
 * Photographs only.
 *
 * A move is a `zoompan`, which holds each input frame for the length of the
 * move: right for a still, and for footage it would multiply the frames. A
 * moving picture has zoom keyframes, which scale per frame. The app draws text,
 * clippings and cards itself, and an adjustment layer has no picture.
 */
export function canMoveCamera(
  clip: Pick<Clip, 'adjustment' | 'text' | 'title' | 'paper' | 'carousel' | 'solid'>,
  asset: Pick<MediaAsset, 'kind'> | undefined
): boolean {
  if (clip.adjustment || clip.text || clip.title || clip.paper || clip.carousel || clip.solid) return false
  return asset?.kind === 'image'
}

/** Whether this photo has depth planes to run a move on — parallax, or a shake that holds the subject. */
export function depthFor(project: Pick<Project, 'parallax'>, assetId: string): { planes: boolean; subject: boolean } {
  const bake = project.parallax?.[assetId]
  const planes = Boolean(bake && bake.separated && bake.layers.length >= 2)
  return { planes, subject: planes && Boolean(bake?.subject) }
}

/** The shake's rate and settle, and how far any move may go, kept in range. */
export const SHAKE_HZ_RANGE = { min: 1, max: 30 } as const
export const SHAKE_DECAY_RANGE = { min: 0, max: 1 } as const

const within = (v: number | undefined, lo: number, hi: number, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : fallback

/**
 * A move brought into range — the same bounds the renderer applies, so what the
 * panel shows is what exports. Parallax cannot go past the depth bake's fill
 * band (motion.ts MAX_PARALLAX_AMOUNT) without opening a hole behind the subject.
 */
export function saneMotion(motion: Motion): Motion {
  if (motion.kind === 'shake') {
    return {
      ...motion,
      amount: clampAmount(motion.amount),
      hz: within(motion.hz, SHAKE_HZ_RANGE.min, SHAKE_HZ_RANGE.max, DEFAULT_SHAKE_HZ),
      decay: within(motion.decay, SHAKE_DECAY_RANGE.min, SHAKE_DECAY_RANGE.max, DEFAULT_SHAKE_DECAY)
    }
  }
  const amount = clampAmount(motion.amount)
  return { ...motion, amount: motion.kind === 'parallax' ? Math.min(amount, MAX_PARALLAX_AMOUNT) : amount }
}

/**
 * Set this clip's move, or take it off.
 *
 * A move chosen here is this clip's own: it drops the window a split gave it
 * (timeline.ts MotionWindow), because the move it was a window onto is being
 * replaced. Zoom keyframes go, and `droppedZoom` says whether there were any.
 */
export function withMotion<C extends Clip>(clip: C, motion: Motion | undefined): { clip: C; droppedZoom: boolean } {
  if (!motion) {
    const { motion: _gone, ...rest } = clip
    return { clip: rest as C, droppedZoom: false }
  }
  const { window: _shared, ...own } = saneMotion(motion)
  const zoom = clip.keyframes?.zoom ?? []
  const droppedZoom = zoom.length > 0
  let keyframes = clip.keyframes
  if (droppedZoom) {
    const { zoom: _off, ...others } = clip.keyframes!
    keyframes = Object.keys(others).length > 0 ? others : undefined
  }
  return { clip: { ...clip, motion: own as Motion, keyframes }, droppedZoom }
}

/**
 * Zoom keys are being written: a camera move on the clip has to go.
 * `droppedMotion` says whether there was one.
 */
export function withoutMotionForZoom<C extends Clip>(clip: C): { clip: C; droppedMotion: boolean } {
  if (!clip.motion) return { clip, droppedMotion: false }
  const { motion: _gone, ...rest } = clip
  return { clip: rest as C, droppedMotion: true }
}

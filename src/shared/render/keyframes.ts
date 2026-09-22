/**
 * Keyframes: a value that changes over a clip.
 *
 * Same mechanism as the motion path — `if(lt(t,..),..,..)` segments compiled
 * into an ffmpeg expression — generalised from a position to any scalar, with
 * easing on each key.
 *
 * Which properties are offered is decided by what the renderer can actually
 * animate, verified against the binary rather than assumed:
 *
 *  - `zoom`    → zoompan's `z`, which evaluates per output frame.
 *  - `rotation`→ `rotate=a='…'`, which takes an expression of `t`.
 *  - `opacity` → `geq` on the alpha plane, which exposes `T`.
 *
 * `scale` is deliberately NOT in that list. ffmpeg's scale filter re-evaluates
 * its expressions with `eval=frame` but does not follow them — measured: asked
 * for 192px→495px, got a constant 138px. So animated size is expressed as a
 * zoom into the picture, which is what a punch-in on a beat wants anyway, and
 * the UI says "Zoom" rather than "Size" so it does not promise otherwise.
 *
 * Position stays with the motion path, which already animates and has presets.
 * Two mechanisms for one property would be two things to disagree.
 */

import { MAX_GAIN } from './audibility'

/**
 * `volume` is the only one of these that is not a picture.
 *
 * It rides here rather than in a scheme of its own because an envelope IS a
 * keyframe track — points in time with values and easing between them — and
 * `keyframeExpression` already compiles exactly that. A second mechanism for
 * the same shape would be two things to keep in step.
 */
export type KeyedProperty = 'zoom' | 'rotation' | 'opacity' | 'volume'

/** How the value LEAVES this key, which is the convention every NLE uses. */
export type Ease = 'linear' | 'hold' | 'smooth'

export interface Keyframe {
  /** Frames from the clip's own start. */
  frame: number
  value: number
  ease?: Ease
}

export type KeyframeTracks = Partial<Record<KeyedProperty, Keyframe[]>>

export const KEYED_PROPERTIES: KeyedProperty[] = ['zoom', 'rotation', 'opacity', 'volume']

/** Label, neutral value and range, so the UI does not hold a second copy. */
export const PROPERTY_INFO: Record<
  KeyedProperty,
  { label: string; neutral: number; min: number; max: number; step: number; suffix: string }
> = {
  zoom: { label: 'Zoom', neutral: 1, min: 1, max: 4, step: 0.01, suffix: '×' },
  rotation: { label: 'Rotate', neutral: 0, min: -180, max: 180, step: 1, suffix: '°' },
  opacity: { label: 'Opacity', neutral: 1, min: 0, max: 1, step: 0.01, suffix: '' },
  /*
   * To +6 dB, the same ceiling as the fader — see render/audibility.ts. The
   * curve editor, the keyframe lane and the curve panel all read their range
   * from here, so this one number is what lets an envelope lift a quiet clip.
   */
  volume: { label: 'Volume', neutral: 1, min: 0, max: MAX_GAIN, step: 0.01, suffix: '' }
}

/** Which of these describe sound rather than picture. */
export function isAudioProperty(property: KeyedProperty): boolean {
  return property === 'volume'
}

/** Sorted, de-duplicated, clamped into the clip. */
/**
 * Sorted, whole-frame, one key per frame — and NOT clamped to the clip.
 *
 * It used to pin every key into `[0, duration]`, which looks like tidiness and
 * was a distortion: trim a clip's tail and every key past the new end was
 * squashed onto its last frame, so the curve arrived at the value of a key that
 * should have been off the end — the fade that should have been half-way down
 * finishing the whole way down. The curve is a function of the clip's own time;
 * a key outside the visible stretch still shapes it inside, exactly as a
 * keyframe past a trimmed edge does in every other editor. And it means trimming
 * back OUT brings the keys back instead of having flattened them.
 *
 * `durationFrames` is kept in the signature because a dozen callers pass it;
 * nothing here needs it any more.
 */
export function normaliseKeys(keys: Keyframe[], _durationFrames: number): Keyframe[] {
  const sorted = [...keys]
    .map((k) => ({ ...k, frame: Math.round(k.frame) }))
    .sort((a, b) => a.frame - b.frame)

  const unique: Keyframe[] = []
  for (const key of sorted) {
    // A later key at the same frame wins: two values at one instant is not an
    // animation, it is a contradiction.
    if (unique.length > 0 && unique[unique.length - 1].frame === key.frame) unique.pop()
    unique.push(key)
  }
  return unique
}

function eased(progress: number, ease: Ease | undefined): number {
  const p = Math.max(0, Math.min(1, progress))
  if (ease === 'hold') return 0
  // Smoothstep: the usual ease-in-out, and the one a curve editor draws.
  if (ease === 'smooth') return p * p * (3 - 2 * p)
  return p
}

/**
 * The value at a frame.
 *
 * Held flat before the first key and after the last — a clip should not drift
 * somewhere nobody asked it to go.
 */
export function valueAt(
  keys: Keyframe[],
  frame: number,
  durationFrames: number,
  fallback: number
): number {
  const points = normaliseKeys(keys, durationFrames)
  if (points.length === 0) return fallback
  if (points.length === 1) return points[0].value
  if (frame <= points[0].frame) return points[0].value

  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]
    const b = points[i]
    /*
     * `>=`, not `>`.
     *
     * Landing exactly on a key takes that key's value, whatever easing brought
     * you there — a held segment steps at its successor rather than one frame
     * later. The compiled expression already behaves this way, because its
     * `lt(t,t1)` is false at t1; this is the half that has to match it.
     */
    if (frame >= b.frame) continue
    const span = b.frame - a.frame
    if (span <= 0) return b.value
    return a.value + (b.value - a.value) * eased((frame - a.frame) / span, a.ease)
  }
  return points[points.length - 1].value
}

export interface ExpressionOptions {
  durationFrames: number
  fps: number
  /** Where the clip sits on the timeline, since `t` is timeline seconds. */
  startSeconds: number
  fallback: number
  /** Map a keyframe value into whatever units the filter wants. */
  transform?: (value: number) => number
  /** Decimal places, so an angle and an alpha can each be written sensibly. */
  precision?: number
  /**
   * What "now" is called in the target filter.
   *
   * Most filters expose `t`, timeline seconds. zoompan does not — it counts
   * output frames in `on` — so it gets an expression that converts, and the
   * curve is written once rather than twice.
   */
  timeVar?: string
}

/**
 * Compile a track into an ffmpeg expression of `t`.
 *
 * Built from the last segment backwards so each `if` only has to decide "are we
 * before this point yet" — the same shape as the motion path, which is the one
 * animation mechanism in the renderer already known to work.
 */
export function keyframeExpression(keys: Keyframe[], options: ExpressionOptions): string {
  const { durationFrames, fps, startSeconds, fallback, precision = 4, timeVar = 't' } = options
  const map = options.transform ?? ((v: number): number => v)
  const fixed = (value: number): string => map(value).toFixed(precision)

  const points = normaliseKeys(keys, durationFrames)
  if (points.length === 0) return map(fallback).toFixed(precision)
  if (points.length === 1) return fixed(points[0].value)

  const time = (frame: number): number => startSeconds + frame / fps

  let expression = fixed(points[points.length - 1].value)
  for (let i = points.length - 1; i >= 1; i--) {
    const a = points[i - 1]
    const b = points[i]
    const t0 = time(a.frame)
    const t1 = time(b.frame)
    const span = t1 - t0
    const from = map(a.value)
    const to = map(b.value)

    let segment: string
    if (span <= 1e-6 || a.ease === 'hold') {
      // A held key keeps its value right up to the next one, then steps.
      segment = from.toFixed(precision)
    } else {
      const p = `min(1,max(0,(${timeVar}-${t0.toFixed(4)})/${span.toFixed(4)}))`
      const shaped = a.ease === 'smooth' ? `(${p})*(${p})*(3-2*(${p}))` : p
      segment = `${from.toFixed(precision)}+(${(to - from).toFixed(precision)})*(${shaped})`
    }
    expression = `if(lt(${timeVar},${t1.toFixed(4)}),${segment},${expression})`
  }
  // Before the first key the clip waits at its opening value.
  return `if(lt(${timeVar},${time(points[0].frame).toFixed(4)}),${fixed(points[0].value)},${expression})`
}

/** Does this clip animate this property? One key is a value, not an animation. */
export function hasKeys(tracks: KeyframeTracks | undefined, property: KeyedProperty): boolean {
  return (tracks?.[property]?.length ?? 0) >= 2
}

/** Any animated property at all — what decides whether a clip costs anything. */
export function anyKeys(tracks: KeyframeTracks | undefined): boolean {
  return KEYED_PROPERTIES.some((p) => hasKeys(tracks, p))
}

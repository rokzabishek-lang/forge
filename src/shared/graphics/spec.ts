/**
 * The graphics layer spec.
 *
 * A scene is a pure function of (spec, frame). Nothing here may read the wall
 * clock or unseeded randomness: the export renders frame 431 in isolation, and it
 * must match exactly what the preview showed at frame 431. The moment rendering
 * depends on real time, export and preview diverge and the bug is miserable to
 * find. See docs/PLAN.md §3.
 */

export type Easing = 'linear' | 'easeIn' | 'easeOut' | 'easeInOut' | 'backOut'

export interface Keyframe {
  frame: number
  value: number
  easing?: Easing
}

/** A property that varies over time. A bare number means constant. */
export type Animatable = number | Keyframe[]

export interface Transform2D {
  x: Animatable
  y: Animatable
  scale: Animatable
  rotation: Animatable
  opacity: Animatable
}

export interface TextLayer {
  id: string
  kind: 'text'
  text: string
  /** Inclusive start, exclusive end. Outside this the layer is not drawn. */
  startFrame: number
  endFrame: number
  fontFamily: string
  fontSize: number
  color: string
  strokeColor?: string
  strokeWidth?: number
  /** Fractions of the canvas, 0..1, measured to the layer's anchor point. */
  anchorX: number
  anchorY: number
  align: 'left' | 'center' | 'right'
  uppercase?: boolean
  maxWidth?: number
  transform: Transform2D
}

export interface ImageLayer {
  id: string
  kind: 'image'
  /** Resolvable URL — forge-media:// for local files. */
  src: string
  startFrame: number
  endFrame: number
  anchorX: number
  anchorY: number
  width: number
  height: number
  transform: Transform2D
}

export type GraphicsLayer = TextLayer | ImageLayer

export interface GraphicsSpec {
  width: number
  height: number
  fps: number
  durationFrames: number
  layers: GraphicsLayer[]
}

export const IDENTITY_TRANSFORM: Transform2D = {
  x: 0,
  y: 0,
  scale: 1,
  rotation: 0,
  opacity: 1
}

/* --------------------------------------------------------------- easing */

const EASINGS: Record<Easing, (t: number) => number> = {
  linear: (t) => t,
  easeIn: (t) => t * t,
  easeOut: (t) => 1 - (1 - t) * (1 - t),
  easeInOut: (t) => (t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t)),
  // Overshoots past 1 then settles — the "pop" that reads as motion design.
  backOut: (t) => {
    const c = 1.70158
    return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2)
  }
}

export function applyEasing(t: number, easing: Easing = 'linear'): number {
  const clamped = Math.min(1, Math.max(0, t))
  return (EASINGS[easing] ?? EASINGS.linear)(clamped)
}

/**
 * Value of an animatable property at a frame.
 *
 * Holds the first value before the first keyframe and the last after the last,
 * so a property is always defined — an undefined transform silently collapses a
 * layer to the origin.
 */
export function valueAt(property: Animatable, frame: number): number {
  if (typeof property === 'number') return property
  if (property.length === 0) return 0
  if (property.length === 1) return property[0].value

  const keys = property
  if (frame <= keys[0].frame) return keys[0].value
  if (frame >= keys[keys.length - 1].frame) return keys[keys.length - 1].value

  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i]
    const b = keys[i + 1]
    if (frame >= a.frame && frame <= b.frame) {
      const span = b.frame - a.frame
      if (span <= 0) return b.value
      // Easing belongs to the segment being entered, matching how motion tools
      // attach an ease to the incoming keyframe.
      const t = applyEasing((frame - a.frame) / span, b.easing ?? a.easing)
      return a.value + (b.value - a.value) * t
    }
  }
  return keys[keys.length - 1].value
}

export function transformAt(transform: Transform2D, frame: number): {
  x: number
  y: number
  scale: number
  rotation: number
  opacity: number
} {
  return {
    x: valueAt(transform.x, frame),
    y: valueAt(transform.y, frame),
    scale: valueAt(transform.scale, frame),
    rotation: valueAt(transform.rotation, frame),
    opacity: valueAt(transform.opacity, frame)
  }
}

export function layerVisibleAt(layer: GraphicsLayer, frame: number): boolean {
  return frame >= layer.startFrame && frame < layer.endFrame
}

export function layersAt(spec: GraphicsSpec, frame: number): GraphicsLayer[] {
  return spec.layers.filter((l) => layerVisibleAt(l, frame))
}

/** A pop-in: scale overshoot plus a fade, in frames relative to layer start. */
export function popIn(startFrame: number, frames = 6): Transform2D {
  return {
    x: 0,
    y: 0,
    scale: [
      { frame: startFrame, value: 0.6 },
      { frame: startFrame + frames, value: 1, easing: 'backOut' }
    ],
    rotation: 0,
    opacity: [
      { frame: startFrame, value: 0 },
      { frame: startFrame + Math.ceil(frames / 2), value: 1, easing: 'easeOut' }
    ]
  }
}

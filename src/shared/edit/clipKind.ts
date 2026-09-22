/**
 * What a clip IS, for the eye.
 *
 * Every clip on the timeline was the same grey box, so a reel of thirty was a
 * grey wall: the sticker, the caption, the sound effect and the shot all looked
 * alike, and the only way to find the one you wanted was to click through them.
 * Premiere and CapCut both colour by kind for exactly this reason — you find
 * the music by looking for the green, not by reading thirty labels.
 *
 * Derived from what the clip already carries rather than stored on it. A stored
 * kind is a second source of truth that goes stale the moment a clip is turned
 * into something else, and nothing would notice.
 *
 * The classes are Tailwind's, resolved at build time, so they are written out
 * in full rather than composed — `bg-${colour}-500` is invisible to the
 * compiler and comes out as no class at all.
 */

import type { Clip, MediaAsset, Track } from '../timeline'

export type ClipKind =
  | 'video'
  | 'image'
  | 'text'
  | 'sticker'
  | 'graphic'
  | 'music'
  | 'sfx'
  | 'voice'
  | 'adjustment'

export interface KindStyle {
  kind: ClipKind
  label: string
  /** Body and border, selected and not. */
  idle: string
  selected: string
  /** A solid swatch, for a legend or a badge. */
  dot: string
}

/*
 * Six families, not nine colours.
 *
 * Kinds that are edited the same way share a hue: everything drawn from a spec
 * is violet, everything that is a picture from a file is blue, and sound splits
 * by ROLE because that is the distinction that matters while mixing — music is
 * the bed you duck, an effect is a hit, a voice is the thing everything else
 * gets out of the way of.
 */
const STYLES: Record<ClipKind, KindStyle> = {
  video: {
    kind: 'video', label: 'Video',
    idle: 'border-sky-700/70 bg-sky-800/45 hover:bg-sky-800/65',
    selected: 'border-sky-300 bg-sky-600/45',
    dot: 'bg-sky-500'
  },
  image: {
    kind: 'image', label: 'Photo',
    idle: 'border-cyan-800/70 bg-cyan-900/45 hover:bg-cyan-900/65',
    selected: 'border-cyan-300 bg-cyan-600/40',
    dot: 'bg-cyan-500'
  },
  text: {
    kind: 'text', label: 'Text',
    idle: 'border-violet-700/70 bg-violet-800/45 hover:bg-violet-800/65',
    selected: 'border-violet-300 bg-violet-600/45',
    dot: 'bg-violet-500'
  },
  sticker: {
    kind: 'sticker', label: 'Sticker',
    idle: 'border-fuchsia-700/70 bg-fuchsia-800/45 hover:bg-fuchsia-800/65',
    selected: 'border-fuchsia-300 bg-fuchsia-600/45',
    dot: 'bg-fuchsia-500'
  },
  graphic: {
    kind: 'graphic', label: 'Graphic',
    idle: 'border-indigo-700/70 bg-indigo-800/45 hover:bg-indigo-800/65',
    selected: 'border-indigo-300 bg-indigo-600/45',
    dot: 'bg-indigo-500'
  },
  music: {
    kind: 'music', label: 'Music',
    idle: 'border-emerald-700/70 bg-emerald-800/45 hover:bg-emerald-800/65',
    selected: 'border-emerald-300 bg-emerald-600/45',
    dot: 'bg-emerald-500'
  },
  sfx: {
    kind: 'sfx', label: 'SFX',
    idle: 'border-amber-700/70 bg-amber-800/45 hover:bg-amber-800/65',
    selected: 'border-amber-300 bg-amber-600/45',
    dot: 'bg-amber-500'
  },
  voice: {
    kind: 'voice', label: 'Voice',
    idle: 'border-teal-700/70 bg-teal-800/45 hover:bg-teal-800/65',
    selected: 'border-teal-300 bg-teal-600/45',
    dot: 'bg-teal-500'
  },
  adjustment: {
    kind: 'adjustment', label: 'Adjustment',
    idle: 'border-rose-700/70 bg-rose-900/40 hover:bg-rose-900/60',
    selected: 'border-rose-300 bg-rose-600/40',
    dot: 'bg-rose-500'
  }
}

export const KIND_STYLES = STYLES

/** Every kind present on a timeline, in a stable order, for a legend. */
export function kindsPresent(kinds: ClipKind[]): KindStyle[] {
  const order = Object.keys(STYLES) as ClipKind[]
  const seen = new Set(kinds)
  return order.filter((k) => seen.has(k)).map((k) => STYLES[k])
}

/**
 * Sound effect or music?
 *
 * There is no flag for it, and inventing one would mean every existing project
 * guessed wrong. Length is the honest signal: an effect is a hit — a whoosh, a
 * pop, a riser — and a bed runs under the edit. Four seconds is the line, which
 * is long for an effect and short for a track. A track marked to duck is music
 * whatever its length, because that mark IS someone saying so.
 */
export const SFX_MAX_SECONDS = 4

export function clipKind(
  clip: Clip,
  asset: MediaAsset | undefined,
  track: Track | undefined,
  fps: number
): ClipKind {
  if (clip.adjustment) return 'adjustment'
  if (clip.text ?? clip.title) return 'text'
  if (clip.paper ?? clip.carousel ?? clip.solid) return 'graphic'

  if (track?.kind === 'audio') {
    if (track.duck) return 'music'
    const seconds = fps > 0 ? clip.duration / fps : 0
    return seconds <= SFX_MAX_SECONDS ? 'sfx' : 'music'
  }

  // A clip sticker carries its own cut-out matte; that is what makes it one.
  if (asset?.matte) return 'sticker'
  if (asset?.kind === 'image') return 'image'
  /*
   * A video clip on a video track whose sound is the point.
   *
   * Not guessed from the file: a talking head and a b-roll shot are the same
   * kind of file. It is the clip having a voice effect, or being the only
   * thing carrying dialogue, that makes it worth marking — and the first of
   * those is something the user said explicitly.
   */
  if (clip.voice) return 'voice'
  return 'video'
}

export function styleFor(kind: ClipKind): KindStyle {
  return STYLES[kind]
}

import type { TextSpec } from '../timeline'
import { TITLE_SAFE } from '../timeline'
import type { Word } from '../transcript'
import type { CaptionStyle } from './style'
import { CAPTION_MARGIN, REFERENCE_HEIGHT } from './ass'

/**
 * A caption line, as a text spec.
 *
 * The one place a caption's appearance is decided. The preview draws this, the
 * export draws this, and neither one knows anything about captions beyond what
 * comes back from here — which is the only arrangement under which they cannot
 * drift apart. They used to have a painter each, and the cost of that was not
 * subtle: the caption painter had no gradients, no glows and no animation,
 * because every look would have had to be built twice.
 *
 * A caption is an ordinary text spec plus one thing text clips never needed —
 * `highlight`, the word being spoken.
 */

/** 'bottom' is what a caption style calls the lower third. */
function positionOf(style: CaptionStyle): TextSpec['position'] {
  return style.position === 'bottom' ? 'lower' : style.position === 'top' ? 'top' : 'center'
}

/**
 * How far from the anchored position the caption sits, as a fraction of height.
 *
 * A caption style says "220 reference pixels from the bottom edge"; the layout
 * anchors to the title-safe inset. The difference between the two is the offset,
 * which means one number moves and the anchoring rules stay exactly as they are
 * for every other kind of text.
 */
export function captionOffsetY(style: CaptionStyle): number {
  const margin = style.marginV / REFERENCE_HEIGHT
  if (style.position === 'top') return margin - TITLE_SAFE
  if (style.position === 'center') return 0
  return TITLE_SAFE - margin
}

/**
 * Turn a caption style and the words on screen into something paintable.
 *
 * `activeIndex` is which of `words` is being spoken, or -1 for none. Sizes come
 * out as fractions so the same style renders identically into 1080x1920 and
 * 1920x1080 — a caption style is authored against a 1080-tall reference frame.
 */
export function captionSpec(
  style: CaptionStyle,
  words: Word[],
  activeIndex: number
): TextSpec {
  const size = style.fontSize / REFERENCE_HEIGHT

  return {
    content: words.map((w) => w.text).join(' '),
    font: style.fontFamily,
    size,
    color: style.primaryColor,
    align: 'center',
    position: positionOf(style),
    weight: style.bold ? 700 : 400,
    // Captions are read, not admired: tracking that works on a title makes a
    // fast subtitle harder to take in at a glance.
    tracking: 0,
    uppercase: style.uppercase,
    // A soft shadow rather than the style's hard offset — the craft guidance
    // this codebase follows throughout, and what lifts letters off a busy frame.
    shadow: style.shadowDepth > 0 ? 0.6 : 0,
    /*
     * Outline width is doubled on the way in.
     *
     * ASS measures an outline as the visible band OUTSIDE the glyph; canvas
     * centres a stroke on the glyph's own edge, so half of it is painted over
     * the letter. Doubling makes the two agree, which is what keeps a style
     * looking the same whichever renderer draws it.
     */
    stroke: style.outlineWidth > 0 ? (style.outlineWidth * 2) / style.fontSize : 0,
    strokeColor: style.outlineColor,
    styleId: style.textStyleId,
    /*
     * The preset's own `animated` flag, honoured rather than ignored.
     *
     * `animated: true` predates the animation library and used to mean "route
     * this to the frame server", which no longer exists. Every path that
     * actually moves type reads `animationId`, so the flag had quietly become
     * decoration — the Kinetic preset advertised per-word motion with a badge
     * and rendered perfectly still. It now means what it says by picking the
     * word-by-word pop, and an explicit choice still overrides it.
     */
    animationId: style.animationId ?? (style.animated ? 'pop' : undefined),
    highlight:
      activeIndex >= 0
        ? {
            word: activeIndex,
            color: style.highlightColor,
            scale: style.highlightScale
          }
        : undefined,
    margin: CAPTION_MARGIN,
    offsetX: 0,
    offsetY: captionOffsetY(style),
    version: 1
  }
}

/**
 * Which word of a group is being spoken at a moment in source time.
 *
 * The spoken word holds until the next one begins rather than going dark in the
 * gaps between words, which is both what ASS karaoke does and what reads
 * correctly: a highlight that blinks off between words looks broken.
 *
 * Returns -1 when this moment is outside the group entirely.
 */
export function activeWordAt(group: Word[], sourceMs: number): number {
  if (group.length === 0) return -1
  const first = group[0]
  const last = group[group.length - 1]
  if (sourceMs < first.startMs || sourceMs >= last.endMs) return -1

  let active = 0
  for (let i = 0; i < group.length; i++) {
    const end = group[i + 1]?.startMs ?? group[i].endMs
    if (sourceMs >= group[i].startMs && sourceMs < end) return i
    if (sourceMs >= group[i].startMs) active = i
  }
  return active
}

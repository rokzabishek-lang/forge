import type { Segment, Word } from '../transcript'
import type { CaptionStyle } from './style'

/**
 * Generate an ASS subtitle file with word-level highlighting.
 *
 * ffmpeg's libass renderer handles this natively, which means captions need no
 * frame server, no compositing step, and no new runtime — and it stays as the
 * deterministic fallback once the Chromium graphics layer exists for the effects
 * ASS genuinely cannot do (3D transforms, masks, kinetic typography).
 */

/** The reference height every style dimension is authored against. */
export const REFERENCE_HEIGHT = 1080

export interface AssOptions {
  width: number
  height: number
  style: CaptionStyle
  /** Shifts every cue, for a clip trimmed away from the source origin. */
  offsetMs?: number
  /** Drop cues outside this window (clip bounds in source time). */
  rangeMs?: { startMs: number; endMs: number }
}

/**
 * ASS colours are &HAABBGGRR — byte-reversed from hex, and alpha is INVERTED
 * (00 is fully opaque). Getting either wrong yields silently wrong colours
 * rather than an error.
 */
export function toAssColor(hex: string, alpha = 0): string {
  const clean = hex.replace('#', '').trim()
  const r = clean.slice(0, 2)
  const g = clean.slice(2, 4)
  const b = clean.slice(4, 6)
  const a = alpha.toString(16).padStart(2, '0')
  return `&H${a}${b}${g}${r}`.toUpperCase()
}

/** ASS timestamps are H:MM:SS.cc — centiseconds, and the hour is not padded. */
export function toAssTime(ms: number): string {
  const total = Math.max(0, Math.round(ms))
  const centis = Math.floor((total % 1000) / 10)
  const seconds = Math.floor(total / 1000) % 60
  const minutes = Math.floor(total / 60_000) % 60
  const hours = Math.floor(total / 3_600_000)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${hours}:${pad(minutes)}:${pad(seconds)}.${pad(centis)}`
}

/** Alignment values in the numpad layout libass uses. */
function alignment(position: CaptionStyle['position']): number {
  if (position === 'top') return 8
  if (position === 'center') return 5
  return 2
}

/** Braces delimit override tags, so literal ones must not reach the renderer. */
function escapeText(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}')
}

/** Split words into on-screen groups, never breaking across a segment. */
export function groupWords(segments: Segment[], words: Word[], perLine: number): Word[][] {
  const groups: Word[][] = []
  const size = Math.max(1, Math.floor(perLine))

  for (const segment of segments) {
    const inSegment = words.filter((w) => w.index >= segment.wordStart && w.index <= segment.wordEnd)
    for (let i = 0; i < inSegment.length; i += size) {
      const group = inSegment.slice(i, i + size)
      if (group.length > 0) groups.push(group)
    }
  }
  return groups
}

/**
 * How much of the frame's width a subtitle keeps clear, each side.
 *
 * Shared with the preview so the wrap point is the same in both. Six percent is
 * comfortably inside the action-safe area and clear of the interface a phone
 * paints over the bottom corners.
 */
export const CAPTION_MARGIN = 0.06

export function buildAss(segments: Segment[], words: Word[], options: AssOptions): string {
  const { width, height, style } = options
  const offset = options.offsetMs ?? 0

  // One scale factor drives every dimension, so a style holds its proportions
  // whether it renders into 1080x1920 or 1920x1080.
  const scale = height / REFERENCE_HEIGHT
  const fontSize = Math.round(style.fontSize * scale)
  const outline = Math.max(0, Math.round(style.outlineWidth * scale))
  const shadow = Math.max(0, Math.round(style.shadowDepth * scale))
  const marginV = Math.round(style.marginV * scale)
  const marginH = Math.round(width * CAPTION_MARGIN)

  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${Math.round(width)}`,
    `PlayResY: ${Math.round(height)}`,
    /*
     * 0, not 2.
     *
     * WrapStyle 2 tells libass NOT to wrap, so a long subtitle ran past the
     * margins it had just been given and off the edge of the frame. 0 is smart
     * wrapping: lines are broken inside the margins and balanced in length,
     * which is what a subtitle is supposed to do. The preview wraps to the same
     * margin, so the two agree.
     */
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    'YCbCr Matrix: TV.709',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour,' +
      ' Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline,' +
      ' Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    [
      'Style: Default',
      style.fontFamily,
      String(fontSize),
      toAssColor(style.primaryColor),
      toAssColor(style.highlightColor),
      toAssColor(style.outlineColor),
      toAssColor('#000000', 0x80),
      style.bold ? '-1' : '0',
      '0', '0', '0',
      '100', '100', '0', '0',
      '1',
      String(outline),
      String(shadow),
      String(alignment(style.position)),
      String(marginH),
      String(marginH),
      String(marginV),
      '1'
    ].join(','),
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'
  ]

  const highlight = toAssColor(style.highlightColor)
  const primary = toAssColor(style.primaryColor)
  const events: string[] = []

  for (const group of groupWords(segments, words, style.wordsPerLine)) {
    for (let i = 0; i < group.length; i++) {
      const active = group[i]

      // One event per word: the whole group stays on screen while the spoken
      // word is recoloured and scaled. A single event with karaoke tags cannot
      // change size per word, which is what makes the "pop" read.
      const startMs = active.startMs - offset
      // Hold the last word of a group until the next begins, so the line does
      // not flicker out between words.
      const endMs = (group[i + 1]?.startMs ?? active.endMs) - offset

      if (options.rangeMs) {
        const { startMs: lo, endMs: hi } = options.rangeMs
        if (active.endMs <= lo || active.startMs >= hi) continue
      }
      if (endMs <= 0 || endMs <= startMs) continue

      const text = group
        .map((word, index) => {
          const raw = style.uppercase ? word.text.toUpperCase() : word.text
          const safe = escapeText(raw)
          if (index !== i) return `{\\c${primary}\\fscx100\\fscy100}${safe}`
          const pop = Math.round(style.highlightScale * 100)
          return `{\\c${highlight}\\fscx${pop}\\fscy${pop}}${safe}`
        })
        .join(' ')

      events.push(
        `Dialogue: 0,${toAssTime(Math.max(0, startMs))},${toAssTime(endMs)},Default,,0,0,0,,${text}`
      )
    }
  }

  return `${[...header, ...events].join('\n')}\n`
}

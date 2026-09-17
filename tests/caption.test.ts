import { describe, it, expect } from 'vitest'
import {
  splitCaption,
  barSecondsFor,
  READING_CPS,
  MAX_CARD_CHARS,
  MIN_CARD_SECONDS
} from '@shared/automation/caption'

const SLOW = barSecondsFor(120) // 2s a bar
const FAST = barSecondsFor(160) // 1.5s a bar

describe('barSecondsFor', () => {
  it('is four beats of the tempo', () => {
    expect(barSecondsFor(120)).toBeCloseTo(2)
    expect(barSecondsFor(60)).toBeCloseTo(4)
  })

  it('falls back rather than dividing by a nonsense tempo', () => {
    expect(barSecondsFor(0)).toBe(2)
    expect(barSecondsFor(Number.NaN)).toBe(2)
  })
})

describe('splitCaption', () => {
  it('keeps a short caption as one card', () => {
    expect(splitCaption('One perfect day', { barSeconds: SLOW })).toEqual([
      { text: 'One perfect day', bars: 1 }
    ])
  })

  it('honours the line breaks the user typed', () => {
    // They meant them; splitting by reading rate would ignore their intent.
    const cards = splitCaption('she said yes\nand we cried', { barSeconds: SLOW })
    expect(cards.map((c) => c.text)).toEqual(['she said yes', 'and we cried'])
  })

  /*
   * The heart of it: the SAME caption splits differently against a different
   * tempo, because a faster bar is less reading time.
   */
  it('fits fewer characters per card at a faster tempo', () => {
    const caption = 'the morning light before anyone else was awake and the whole house was quiet'
    const slow = splitCaption(caption, { barSeconds: SLOW })
    const fast = splitCaption(caption, { barSeconds: FAST })
    expect(fast.length).toBeGreaterThan(slow.length)
  })

  it('never writes a card nobody could read in the time it is up', () => {
    const caption =
      'we drove all night through the rain to get there before the sun came up over the water'
    for (const barSeconds of [SLOW, FAST]) {
      for (const card of splitCaption(caption, { barSeconds })) {
        const held = Math.max(MIN_CARD_SECONDS, card.bars * barSeconds)
        expect(card.text.length).toBeLessThanOrEqual(Math.round(READING_CPS * held))
      }
    }
  })

  it('caps a card even when it is held for ages', () => {
    // Time is not the only limit — a vertical reel is narrow.
    const caption = 'a very long single line of words that would otherwise all fit on one card'
    for (const card of splitCaption(caption, { barSeconds: 8 })) {
      expect(card.text.length).toBeLessThanOrEqual(MAX_CARD_CHARS)
    }
  })

  it('breaks at clause punctuation before it breaks mid-thought', () => {
    const cards = splitCaption('we laughed, we cried, we danced until the lights came up', {
      barSeconds: SLOW
    })
    expect(cards[0].text).toBe('we laughed,')
    expect(cards[1].text).toBe('we cried,')
  })

  it('holds a long card for more bars rather than rushing it', () => {
    const cards = splitCaption('everything changed the moment she walked in', { barSeconds: 1 })
    expect(cards.some((c) => c.bars > 1)).toBe(true)
  })

  it('never exceeds the bar ceiling, because a stale title is worse', () => {
    const cards = splitCaption('a very long caption indeed', { barSeconds: 0.4, maxBars: 2 })
    for (const card of cards) expect(card.bars).toBeLessThanOrEqual(2)
  })

  it('drops blank lines instead of making empty cards', () => {
    expect(splitCaption('  \n\nhello\n   \n', { barSeconds: SLOW })).toEqual([
      { text: 'hello', bars: 1 }
    ])
  })

  it('gives nothing back for nothing', () => {
    expect(splitCaption('', { barSeconds: SLOW })).toEqual([])
    expect(splitCaption('   ', { barSeconds: SLOW })).toEqual([])
  })

  it('does not lose a word that is longer than a whole card', () => {
    const cards = splitCaption('supercalifragilisticexpialidocious', { barSeconds: 0.5 })
    expect(cards.map((c) => c.text).join(' ')).toContain('supercalifragilistic')
  })
})

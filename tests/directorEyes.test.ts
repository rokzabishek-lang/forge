import { describe, expect, it } from 'vitest'
import { emptyProject } from '@shared/timeline'
import { eyesOf, needsLook, needsMeasure, withVision, type AssetVision } from '@shared/director/eyes'
import { conforms } from '@shared/director/conforms'
import { LOOK_SYSTEM, lookLine, lookPrompt, lookSchema, readLook, type StoredLook } from '@shared/director/look'
import type { Measure } from '@shared/director/gate'
import type { Slot } from '@shared/director/menu'

/**
 * The eyes' cache and the look pass's contract (docs/PLAN.md §4.1). A look is a
 * model call per photo — seconds each on a CPU — so the cache is what makes a
 * second Direct cost nothing; and the cache must never serve one file's answer
 * for another.
 */

const measure: Measure = { sharpness: 400, luma: 0.5, lumaStd: 0.2, darkClip: 0, brightClip: 0, dhash: 'ab', width: 10, height: 10 }
const look: StoredLook = { people: 'one', shot: 'close', mood: 'joyful', product_visible: 'no', hero: 'strong', words: 'bride laughing', key: 'k1', model: 'm', at: 't' }

describe('when to look again', () => {
  const seen: AssetVision = { key: 'k1', measure, look }

  it('never twice for the same file', () => {
    expect(needsMeasure(seen, 'k1')).toBe(false)
    expect(needsLook(seen, 'k1')).toBe(false)
  })

  it('again when the file changed, or was never seen', () => {
    expect(needsMeasure(seen, 'k2')).toBe(true)
    expect(needsLook(seen, 'k2')).toBe(true)
    expect(needsMeasure(undefined, 'k1')).toBe(true)
    expect(needsLook({ key: 'k1', measure }, 'k1')).toBe(true)
  })

  it('not at all for a file that cannot be read', () => {
    expect(needsMeasure(undefined, null)).toBe(false)
    expect(needsLook(undefined, null)).toBe(false)
  })
})

describe('what is kept', () => {
  it('a new key replaces everything known about the old file — never a mix of two pictures', () => {
    let p = withVision(emptyProject(), 'a', 'k1', { measure, look })
    p = withVision(p, 'a', 'k2', { measure: { ...measure, sharpness: 9 } })
    expect(p.vision!.a).toEqual({ key: 'k2', measure: { ...measure, sharpness: 9 } })
  })

  it('the same key merges, so a look lands beside the measurement', () => {
    let p = withVision(emptyProject(), 'a', 'k1', { measure })
    p = withVision(p, 'a', 'k1', { look })
    expect(p.vision!.a).toEqual({ key: 'k1', measure, look })
  })

  it('the gate reads looks without their bookkeeping, for the slots on offer only', () => {
    const p = withVision(withVision(emptyProject(), 'a', 'k1', { measure, look }), 'b', 'k9', { measure })
    const slots = [{ id: 'slot_01', assetId: 'a' }] as Slot[]
    const eyes = eyesOf(p, slots)
    expect(eyes.looks).toEqual({ a: { people: 'one', shot: 'close', mood: 'joyful', product_visible: 'no', hero: 'strong', words: 'bride laughing' } })
    expect(Object.keys(eyes.measures)).toEqual(['a'])
  })
})

describe('the look pass', () => {
  it('asks for a flat object, reasoning first, closed lists', () => {
    const schema = lookSchema()
    expect(Object.keys(schema.properties)[0]).toBe('reasoning')
    // Words before the lists, so the count can agree with the description (EVAL.md, look probe 2).
    expect(Object.keys(schema.properties)[1]).toBe('words')
    expect(schema.required).toEqual(Object.keys(schema.properties))
    expect(conforms(schema, { reasoning: 'x', people: 'one', shot: 'close', mood: 'calm', product_visible: 'yes', hero: 'usable', words: 'a b' })).toEqual([])
    expect(conforms(schema, { reasoning: 'x', people: 'three', shot: 'close', mood: 'calm', product_visible: 'yes', hero: 'usable', words: '' }).length).toBeGreaterThan(0)
  })

  it('the system prompt is the same for every photo, so the prefix caches', () => {
    expect(lookPrompt({ product: 'A', language: 'English' }).system).toBe(LOOK_SYSTEM)
    expect(lookPrompt({ product: 'B', language: 'Telugu' }).system).toBe(LOOK_SYSTEM)
    expect(lookPrompt({ product: 'B', language: 'Telugu' }).user).toContain('in Telugu')
    // Named only for product_visible, never as "the ad is for" — see look.ts.
    expect(lookPrompt({ product: 'Aura serum', language: 'English' }).user).toBe(
      'Describe this picture. Write "words" in English, about what you see only.\nFor product_visible alone: the product is "Aura serum".'
    )
  })

  it('reads an answer, keeps twelve words, and refuses one off the lists', () => {
    const words = 'one two three four five six seven eight nine ten eleven twelve thirteen'
    expect(readLook({ people: 'group', shot: 'wide', mood: 'warm', product_visible: 'unsure', hero: 'weak', words })!.words.split(' ')).toHaveLength(12)
    expect(readLook({ people: 'crowd', shot: 'wide', mood: 'warm', product_visible: 'no', hero: 'weak', words: '' })).toBeNull()
    expect(readLook(null)).toBeNull()
  })

  it('reads as one line in the spine’s table', () => {
    expect(lookLine(look)).toBe('one, close, joyful, strong: "bride laughing"')
    expect(lookLine({ ...look, words: '' })).toBe('one, close, joyful, strong')
  })
})

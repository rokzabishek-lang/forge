import { describe, it, expect } from 'vitest'
import { flatViolations, unsupportedKeywords, type ObjectSchema } from '@shared/director/conforms'
import { MAX_WHY_CHARS, MAX_WHY_DECODE_CHARS, PACES, ROLES, spineSchema } from '@shared/director/schema'
import type { Menu } from '@shared/director/menu'

const menu: Pick<Menu, 'slots' | 'cuts' | 'families'> = {
  slots: [
    { id: 'slot_01', assetId: 'a', kind: 'image', label: 'a', note: '', speech: '', seconds: null, frames: null },
    { id: 'slot_02', assetId: 'b', kind: 'video', label: 'b', note: '', speech: '', seconds: 2, frames: 60 }
  ],
  cuts: [
    { id: 'cut_00', ms: 0, frame: 0, reason: 'start', energy: 1 },
    { id: 'cut_01', ms: 2000, frame: 60, reason: 'grid', energy: 1 },
    { id: 'cut_02', ms: 4000, frame: 120, reason: 'drop', energy: 3 },
    { id: 'cut_end', ms: 6000, frame: 180, reason: 'end', energy: 1 }
  ],
  families: [
    { id: 'cut', intent: 'hard cut' },
    { id: 'dissolve', intent: 'soft' },
    { id: 'zoom', intent: 'punch' }
  ]
}

const segment = (schema: ObjectSchema): ObjectSchema =>
  (schema.properties.segments as { items: ObjectSchema }).items

describe('spineSchema', () => {
  it('stays inside the flat subset, in both forms', () => {
    for (const constrained of [true, false]) {
      const schema = spineSchema(menu, { constrained })
      expect(unsupportedKeywords(schema)).toEqual([])
      expect(flatViolations(schema)).toEqual([])
    }
  })

  it('gives the decoder more room for a why than the panel keeps', () => {
    // A why cut off at 60 by the grammar was twice followed by the model closing
    // the whole plan after one segment (docs/EVAL.md, run 2). The validator clips to 60.
    const why = segment(spineSchema(menu)).properties.why as { maxLength?: number }
    expect(why.maxLength).toBe(MAX_WHY_DECODE_CHARS)
    expect(MAX_WHY_DECODE_CHARS).toBeGreaterThan(MAX_WHY_CHARS)
  })

  it('puts reasoning first, and declares every property in required order', () => {
    // The grammar decodes properties in declaration order, and a schema whose
    // first token is the verdict gives the model no room to think.
    const schema = spineSchema(menu)
    expect(Object.keys(schema.properties)[0]).toBe('reasoning')
    expect(Object.keys(schema.properties)).toEqual(schema.required)
    const item = segment(schema)
    expect(Object.keys(item.properties)).toEqual(item.required)
    expect(item.required[0]).toBe('slot')
  })

  it('puts the menu ids in as enums, so an invented id is impossible at the decoder', () => {
    const item = segment(spineSchema(menu))
    const enumOf = (key: string): readonly string[] | undefined =>
      (item.properties[key] as { enum?: readonly string[] }).enum
    expect(enumOf('slot')).toEqual(['slot_01', 'slot_02'])
    // A segment cannot END on the start.
    expect(enumOf('ends_at')).toEqual(['cut_01', 'cut_02', 'cut_end'])
    expect(enumOf('enter')).toEqual(['cut', 'dissolve', 'zoom'])
    expect(enumOf('role')).toEqual([...ROLES])
    expect((spineSchema(menu).properties.pace as { enum?: readonly string[] }).enum).toEqual([...PACES])
  })

  it('leaves the ids and lengths open in the shape used for checking, so they can be repaired', () => {
    const item = segment(spineSchema(menu, { constrained: false }))
    for (const key of ['slot', 'ends_at', 'enter']) {
      expect((item.properties[key] as { enum?: unknown }).enum).toBeUndefined()
    }
    expect((item.properties.headline as { maxLength?: number }).maxLength).toBeUndefined()
    // The static labels stay enums in both forms — those are not repairable.
    expect((item.properties.role as { enum?: readonly string[] }).enum).toEqual([...ROLES])
  })

  it('refuses to build a grammar with nothing to choose from', () => {
    expect(() => spineSchema({ ...menu, slots: [] })).toThrow(/picture/)
    expect(() => spineSchema({ ...menu, cuts: menu.cuts.slice(0, 1) })).toThrow(/cut/)
    // The checking form has no such requirement.
    expect(() => spineSchema({ ...menu, slots: [] }, { constrained: false })).not.toThrow()
  })
})

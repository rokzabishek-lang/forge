import { describe, it, expect } from 'vitest'
import {
  conforms,
  flatViolations,
  unsupportedKeywords,
  type FlatSchema
} from '@shared/director/conforms'

const segment: FlatSchema = {
  type: 'object',
  properties: {
    slot: { type: 'string' },
    role: { type: 'string', enum: ['hook', 'cta'] },
    headline: { type: 'string', maxLength: 10 },
    weight: { type: 'integer', minimum: 0, maximum: 3 }
  },
  required: ['slot', 'role', 'headline', 'weight'],
  additionalProperties: false
}

const plan: FlatSchema = {
  type: 'object',
  properties: {
    reasoning: { type: 'string', maxLength: 30 },
    segments: { type: 'array', items: segment, minItems: 1, maxItems: 2 },
    live: { type: 'boolean' }
  },
  required: ['reasoning', 'segments', 'live'],
  additionalProperties: false
}

const good = {
  reasoning: 'short',
  segments: [{ slot: 'slot_01', role: 'hook', headline: 'Hi', weight: 2 }],
  live: true
}

describe('conforms', () => {
  it('accepts a value with exactly the schema shape', () => {
    expect(conforms(plan, good)).toEqual([])
  })

  it('names the path of every problem, so a rejected plan says which field', () => {
    const problems = conforms(plan, {
      ...good,
      segments: [{ slot: 'slot_01', role: 'intro', headline: 'Hi', weight: 2 }]
    })
    expect(problems).toHaveLength(1)
    expect(problems[0].path).toBe('$.segments[0].role')
    expect(problems[0].message).toContain('"hook"')
  })

  it('reports a missing required field and an unknown one', () => {
    const problems = conforms(plan, { reasoning: 'x', segments: [], extra: 1 })
    const paths = problems.map((p) => p.path)
    expect(paths).toContain('$.live')
    expect(paths).toContain('$.extra')
    // An empty list is below minItems.
    expect(paths).toContain('$.segments')
  })

  it('counts string length in characters, not UTF-16 units', () => {
    // Ten code points, several of them outside the BMP.
    const ten = '😀😀😀😀😀😀😀😀😀😀'
    expect(ten.length).toBe(20)
    expect(conforms(segment, { slot: 's', role: 'cta', headline: ten, weight: 0 })).toEqual([])
    expect(
      conforms(segment, { slot: 's', role: 'cta', headline: `${ten}!`, weight: 0 }).map((p) => p.path)
    ).toEqual(['$.headline'])
  })

  it('distinguishes integers from numbers and holds the bounds', () => {
    const at = (weight: unknown): string[] =>
      conforms(segment, { slot: 's', role: 'cta', headline: '', weight }).map((p) => p.message)
    expect(at(1.5)).toEqual([expect.stringContaining('whole number')])
    expect(at(-1)).toEqual([expect.stringContaining('at least 0')])
    expect(at(4)).toEqual([expect.stringContaining('at most 3')])
    expect(at(Number.NaN)).toEqual([expect.stringContaining('expected a number')])
    expect(at(3)).toEqual([])
  })

  it('rejects the wrong container at the top, with one problem rather than a cascade', () => {
    expect(conforms(plan, [])).toEqual([{ path: '$', message: expect.stringContaining('expected an object') }])
    expect(conforms(plan, null)).toHaveLength(1)
  })

  it('enforces maxItems', () => {
    const three = { ...good, segments: [good.segments[0], good.segments[0], good.segments[0]] }
    expect(conforms(plan, three).map((p) => p.path)).toEqual(['$.segments'])
  })
})

describe('the flat-subset guards', () => {
  it('pass a schema inside the subset', () => {
    expect(unsupportedKeywords(plan)).toEqual([])
    expect(flatViolations(plan)).toEqual([])
  })

  it('find a keyword the checker does not understand, however deep', () => {
    const drifted = {
      ...plan,
      properties: {
        ...plan.properties,
        segments: {
          type: 'array',
          items: { ...segment, properties: { ...segment.properties, role: { oneOf: [{ type: 'string' }] } } }
        }
      }
    }
    expect(unsupportedKeywords(drifted)).toEqual(['schema.properties.segments.items.properties.role.oneOf'])
  })

  it('find an optional property and an open object', () => {
    const loose = {
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'string' } },
      required: ['a']
    }
    expect(flatViolations(loose)).toEqual([
      'schema allows additional properties',
      'schema.b is optional'
    ])
  })

  it('look inside arrays for both kinds of drift', () => {
    const inner = { type: 'object', properties: { x: { type: 'string' } }, required: [], additionalProperties: false }
    const outer = { type: 'array', items: inner }
    expect(flatViolations(outer)).toEqual(['schema[].x is optional'])
    expect(unsupportedKeywords({ type: 'array', items: { ...inner, $ref: '#' } })).toEqual(['schema.items.$ref'])
  })
})

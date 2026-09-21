/**
 * A checker for the flat subset of JSON Schema the director's plans use.
 *
 * Why not a real validator: the plan schema is forty lines and flat BY RULE
 * (docs/DIRECTOR.md §10.2 — no `oneOf`/`allOf`/`$ref`, because that is
 * exactly where grammar-constrained decoding over-constrains a small model
 * and silently narrows its options). The same object is handed to the model
 * as its `format`. A full validator would cost a dependency to check a dozen
 * keywords and, worse, would happily accept a schema that had drifted outside
 * the flat subset — which is the thing this file exists to refuse.
 *
 * Two jobs:
 *  - `conforms(schema, value)` — does a value have the schema's SHAPE. Every
 *    problem carries a path, so a rejected plan says which field.
 *  - `unsupportedKeywords` / `flatViolations` — is the schema itself inside
 *    the subset. A test holds both at zero for the shipped schema.
 *
 * Shape is only the first stage. A perfectly shaped plan can still name a cut
 * that does not exist; that is validate.ts's job (DIRECTOR.md §4).
 */

export interface Problem {
  /** Where, e.g. `$.segments[2].role`. */
  path: string
  /** Plain English, shown to the user when a plan is rejected. */
  message: string
}

export type FlatSchema = ObjectSchema | ArraySchema | StringSchema | NumberSchema | BooleanSchema

export interface ObjectSchema {
  type: 'object'
  properties: Record<string, FlatSchema>
  /** Every property, always. Optional fields confuse grammar-constrained decoding. */
  required: string[]
  additionalProperties: false
  description?: string
}

export interface ArraySchema {
  type: 'array'
  items: FlatSchema
  minItems?: number
  maxItems?: number
  description?: string
}

export interface StringSchema {
  type: 'string'
  enum?: readonly string[]
  minLength?: number
  maxLength?: number
  description?: string
}

export interface NumberSchema {
  type: 'integer' | 'number'
  minimum?: number
  maximum?: number
  description?: string
}

export interface BooleanSchema {
  type: 'boolean'
  description?: string
}

/** Everything this checker understands. Anything else in a schema is drift. */
export const SUPPORTED_KEYWORDS: ReadonlySet<string> = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'description',
  'items',
  'minItems',
  'maxItems',
  'enum',
  'minLength',
  'maxLength',
  'minimum',
  'maximum'
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Length in code points, not UTF-16 units.
 *
 * JSON Schema counts characters, and so does anyone typing a headline. A
 * Telugu word is several code points and a UTF-16 count would be wrong in the
 * other direction for anything outside the BMP.
 */
function chars(text: string): number {
  return Array.from(text).length
}

function list(values: readonly string[]): string {
  return values.map((v) => `"${v}"`).join(', ')
}

function describe(value: unknown): string {
  if (typeof value === 'string') return `"${value.length > 40 ? `${value.slice(0, 40)}…` : value}"`
  if (Array.isArray(value)) return `a list of ${value.length}`
  if (value === null) return 'null'
  return typeof value === 'object' ? 'an object' : String(value)
}

/** Does `value` have the shape `schema` describes. Empty means yes. */
export function conforms(schema: FlatSchema, value: unknown, path = '$'): Problem[] {
  const problems: Problem[] = []
  const bad = (message: string): void => {
    problems.push({ path, message })
  }

  switch (schema.type) {
    case 'string': {
      if (typeof value !== 'string') {
        bad(`is ${describe(value)}, expected text`)
        break
      }
      if (schema.enum && !schema.enum.includes(value)) {
        bad(`is "${value}", expected one of ${list(schema.enum)}`)
        break
      }
      const length = chars(value)
      if (schema.minLength !== undefined && length < schema.minLength) {
        bad(`is ${length} characters, needs at least ${schema.minLength}`)
      }
      if (schema.maxLength !== undefined && length > schema.maxLength) {
        bad(`is ${length} characters, at most ${schema.maxLength} allowed`)
      }
      break
    }
    case 'integer':
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        bad(`is ${describe(value)}, expected a number`)
        break
      }
      if (schema.type === 'integer' && !Number.isInteger(value)) {
        bad(`is ${value}, expected a whole number`)
        break
      }
      if (schema.minimum !== undefined && value < schema.minimum) {
        bad(`is ${value}, must be at least ${schema.minimum}`)
      }
      if (schema.maximum !== undefined && value > schema.maximum) {
        bad(`is ${value}, must be at most ${schema.maximum}`)
      }
      break
    }
    case 'boolean': {
      if (typeof value !== 'boolean') bad(`is ${describe(value)}, expected true or false`)
      break
    }
    case 'array': {
      if (!Array.isArray(value)) {
        bad(`is ${describe(value)}, expected a list`)
        break
      }
      if (schema.minItems !== undefined && value.length < schema.minItems) {
        bad(`has ${value.length} items, needs at least ${schema.minItems}`)
      }
      if (schema.maxItems !== undefined && value.length > schema.maxItems) {
        bad(`has ${value.length} items, at most ${schema.maxItems} allowed`)
      }
      value.forEach((item, index) => {
        problems.push(...conforms(schema.items, item, `${path}[${index}]`))
      })
      break
    }
    case 'object': {
      if (!isRecord(value)) {
        bad(`is ${describe(value)}, expected an object`)
        break
      }
      for (const key of schema.required) {
        if (!(key in value)) problems.push({ path: `${path}.${key}`, message: 'is missing' })
      }
      for (const key of Object.keys(value)) {
        if (!(key in schema.properties)) {
          problems.push({ path: `${path}.${key}`, message: 'is not a field the plan has' })
        }
      }
      for (const [key, sub] of Object.entries(schema.properties)) {
        if (key in value) problems.push(...conforms(sub, value[key], `${path}.${key}`))
      }
      break
    }
  }

  return problems
}

/**
 * Every keyword in a schema this checker does not know, with its path.
 *
 * Walks the schema as data rather than as a `FlatSchema`, because the point is
 * to catch what the type would have let through — a `oneOf` typed as `any`,
 * a `$ref` someone added because a real validator would have taken it.
 */
export function unsupportedKeywords(schema: unknown, path = 'schema'): string[] {
  if (!isRecord(schema)) return []
  const out: string[] = []
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED_KEYWORDS.has(key)) out.push(`${path}.${key}`)
  }
  if (isRecord(schema.properties)) {
    for (const [name, sub] of Object.entries(schema.properties)) {
      out.push(...unsupportedKeywords(sub, `${path}.properties.${name}`))
    }
  }
  if ('items' in schema) out.push(...unsupportedKeywords(schema.items, `${path}.items`))
  return out
}

/**
 * The two rules a flat schema has beyond its keywords.
 *
 * Every object closes with `additionalProperties: false` and requires every
 * property it declares. An optional field is a decision the model has to make
 * with no token to make it in — small models fill it inconsistently, and a
 * plan that sometimes has a `why` and sometimes does not is two plans.
 */
export function flatViolations(schema: unknown, path = 'schema'): string[] {
  if (!isRecord(schema)) return []
  const out: string[] = []
  if (schema.type === 'object') {
    if (schema.additionalProperties !== false) out.push(`${path} allows additional properties`)
    const properties = isRecord(schema.properties) ? Object.keys(schema.properties) : []
    const required = Array.isArray(schema.required) ? (schema.required as unknown[]) : []
    for (const name of properties) {
      if (!required.includes(name)) out.push(`${path}.${name} is optional`)
    }
    for (const name of properties) {
      out.push(...flatViolations((schema.properties as Record<string, unknown>)[name], `${path}.${name}`))
    }
  }
  if (schema.type === 'array' && 'items' in schema) out.push(...flatViolations(schema.items, `${path}[]`))
  return out
}

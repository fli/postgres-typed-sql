import { normalizePostgresTypeName } from './postgres-types.js'
import type { PostgresTypeFact } from './postgres-types.js'
import {
  decodePgScalar,
  encodePgScalar,
  formatDecimal,
  isDecimalAtom,
  isPgDecimal,
  jsonNumber,
} from './scalar-values.js'
import type {
  JsonDecoded,
  JsonReadonly,
  PgFiniteDecimal,
  PgJson,
  PgJsonCodec,
  PgJsonInput,
  PgJsonPlan,
} from './value-types.js'

type GenericValue =
  | null
  | boolean
  | string
  | PgFiniteDecimal
  | readonly GenericValue[]
  | { readonly [key: string]: GenericValue }

const codecs = new WeakMap<object, PgJsonPlan>()
const documents = new WeakSet<object>()
const genericPlan: PgJsonPlan = Object.freeze({ kind: 'generic' })

function fail(message: string): never {
  throw new TypeError(message)
}

function setProperty(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true })
}

function plainEntries(value: unknown): [string, unknown][] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return fail('Expected a plain JSON object')
  const prototype: unknown = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return fail('Expected a plain JSON object')
  if (Object.getOwnPropertySymbols(value).length) return fail('JSON objects cannot have symbol properties')
  return Object.entries(Object.getOwnPropertyDescriptors(value)).map(([key, descriptor]) => {
    if (!descriptor.enumerable || !('value' in descriptor))
      return fail('JSON properties must be enumerable data properties')
    return [key, descriptor.value]
  })
}

function documentLike(value: object): boolean {
  const kind = Object.getOwnPropertyDescriptor(value, 'kind')
  const source = Object.getOwnPropertyDescriptor(value, 'source')
  const codec = Object.getOwnPropertyDescriptor(value, 'codec')
  return (
    kind?.value === 'json' && typeof source?.value === 'string' && codec !== undefined && Object.hasOwn(value, 'value')
  )
}

function decimalLike(value: object): boolean {
  return (
    Object.getOwnPropertyDescriptor(value, 'kind')?.value === 'finite' &&
    typeof Object.getOwnPropertyDescriptor(value, 'negative')?.value === 'boolean' &&
    typeof Object.getOwnPropertyDescriptor(value, 'coefficient')?.value === 'bigint' &&
    typeof Object.getOwnPropertyDescriptor(value, 'exponent')?.value === 'bigint'
  )
}

function arrayValues(value: unknown): readonly unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    Object.getOwnPropertySymbols(value).length
  ) {
    return fail('Expected a plain JSON array')
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const keys = Object.keys(descriptors).filter((key) => key !== 'length')
  if (keys.length !== value.length) return fail('JSON arrays cannot have holes or extra properties')
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = descriptors[String(index)]
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor))
      return fail('JSON arrays require data elements')
    return descriptor.value
  })
}

function parseGeneric(source: string): GenericValue {
  type Frame =
    | { kind: 'array'; value: GenericValue[]; state: 'first' | 'value' | 'separator' }
    | {
        kind: 'object'
        value: Record<string, GenericValue>
        state: 'first' | 'key' | 'colon' | 'value' | 'separator'
        key: string
      }

  let index = 0
  const stack: Frame[] = []
  function whitespace(): void {
    while (index < source.length && /[\x20\t\r\n]/.test(source[index] ?? '')) index++
  }
  function string(): string {
    const start = index++
    while (index < source.length) {
      const character = source[index++]
      if (character === '"') {
        try {
          const result: unknown = JSON.parse(source.slice(start, index))
          if (typeof result === 'string') return result
        } catch {
          /* invalid string */
        }
        return fail('Invalid JSON string')
      }
      if (character === '\\') index++
    }
    return fail('Unterminated JSON string')
  }
  function value(): GenericValue {
    whitespace()
    const character = source[index]
    if (character === '"') return string()
    if (character === '[') {
      index++
      const result: GenericValue[] = []
      stack.push({ kind: 'array', value: result, state: 'first' })
      return result
    }
    if (character === '{') {
      index++
      const result: Record<string, GenericValue> = {}
      stack.push({ kind: 'object', value: result, state: 'first', key: '' })
      return result
    }
    for (const [literal, decoded] of [
      ['true', true],
      ['false', false],
      ['null', null],
    ] as const) {
      if (source.startsWith(literal, index)) {
        index += literal.length
        return decoded
      }
    }
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(source.slice(index))
    if (!match) return fail('Invalid JSON value')
    index += match[0].length
    return jsonNumber(match[0])
  }
  const result = value()
  for (;;) {
    const frame = stack[stack.length - 1]
    if (!frame) break
    whitespace()
    if (frame.kind === 'array') {
      if ((frame.state === 'first' || frame.state === 'separator') && source[index] === ']') {
        index++
        stack.pop()
        Object.freeze(frame.value)
      } else if (frame.state === 'separator') {
        if (source[index++] !== ',') return fail('Invalid JSON array')
        frame.state = 'value'
      } else {
        frame.state = 'separator'
        frame.value.push(value())
      }
    } else if ((frame.state === 'first' || frame.state === 'separator') && source[index] === '}') {
      index++
      stack.pop()
      Object.freeze(frame.value)
    } else if (frame.state === 'separator') {
      if (source[index++] !== ',') return fail('Invalid JSON object')
      frame.state = 'key'
    } else if (frame.state === 'first' || frame.state === 'key') {
      if (source[index] !== '"') return fail('Invalid JSON object key')
      frame.key = string()
      frame.state = 'colon'
    } else if (frame.state === 'colon') {
      if (source[index++] !== ':') return fail('Invalid JSON object')
      frame.state = 'value'
    } else {
      frame.state = 'separator'
      setProperty(frame.value, frame.key, value())
    }
  }
  whitespace()
  if (index !== source.length) return fail('Unexpected trailing JSON content')
  return result
}

function genericSource(value: unknown, ancestors = new Set<object>(), literalDocumentShapes = false): string {
  type Action = { kind: 'value'; value: unknown } | { kind: 'text'; text: string } | { kind: 'leave'; value: object }
  const actions: Action[] = [{ kind: 'value', value }]
  const output: string[] = []
  const entered = new Set<object>()
  try {
    for (;;) {
      const action = actions.pop()
      if (!action) break
      if (action.kind === 'text') {
        output.push(action.text)
        continue
      }
      if (action.kind === 'leave') {
        ancestors.delete(action.value)
        entered.delete(action.value)
        continue
      }
      const item = action.value
      if (item === null || typeof item === 'boolean' || typeof item === 'string') {
        output.push(JSON.stringify(item))
      } else if (isDecimalAtom(item)) {
        output.push(formatDecimal(item))
      } else if (isPgDecimal(item)) {
        return fail('Invalid JSON number')
      } else if (typeof item === 'bigint') {
        output.push(item.toString())
      } else if (typeof item === 'number') {
        if (!Number.isFinite(item) || (Number.isInteger(item) && !Number.isSafeInteger(item)))
          return fail('Invalid JSON number')
        output.push(Object.is(item, -0) ? '-0' : String(item))
      } else if (typeof item !== 'object') {
        return fail('Invalid JSON value')
      } else {
        if (decimalLike(item))
          return fail(
            'Unrecognized decimal record; reconstruct it with decimal or jsonNumber, or use its generated JSON codec'
          )
        if (isPgJson(item) || (!literalDocumentShapes && documentLike(item)))
          return fail('JSON documents cannot be nested in a JSON value')
        if (ancestors.has(item)) return fail('Cyclic JSON value')
        ancestors.add(item)
        entered.add(item)
        actions.push({ kind: 'leave', value: item })
        if (Array.isArray(item)) {
          const values = arrayValues(item)
          output.push('[')
          actions.push({ kind: 'text', text: ']' })
          for (let i = values.length - 1; i >= 0; i--) {
            actions.push({ kind: 'value', value: values[i] })
            if (i > 0) actions.push({ kind: 'text', text: ',' })
          }
        } else {
          const entries = plainEntries(item)
          output.push('{')
          actions.push({ kind: 'text', text: '}' })
          entries.reverse().forEach(([key, entry], index) => {
            actions.push({ kind: 'value', value: entry })
            actions.push({ kind: 'text', text: `${JSON.stringify(key)}:` })
            if (index < entries.length - 1) actions.push({ kind: 'text', text: ',' })
          })
        }
      }
    }
  } finally {
    for (const item of entered) ancestors.delete(item)
  }
  return output.join('')
}

function scalarName(type: PostgresTypeFact): string {
  if (type.pgTypeKind === 'domain' && type.pgBaseType) return scalarName(type.pgBaseType)
  if (type.pgTypeKind === 'enum' || type.pgTypeSchema !== 'pg_catalog') return '__text__'
  return normalizePostgresTypeName(type.pgTypeName)
}

const numberTypes = new Set(['smallint', 'integer', 'bigint', 'numeric', 'real', 'double precision'])
const specialNumberTypes = new Set(['numeric', 'real', 'double precision'])
const integerTypes = new Set(['smallint', 'integer', 'bigint', 'oid'])

function integerSource(value: PgFiniteDecimal): string {
  if (value.coefficient === 0n) return '0'
  if (value.exponent > 20n || value.exponent < -BigInt(value.coefficient.toString().length)) {
    return fail('PostgreSQL JSON integer is out of range or fractional')
  }
  let coefficient = value.coefficient
  if (value.exponent >= 0n) coefficient *= 10n ** value.exponent
  else {
    const divisor = 10n ** -value.exponent
    if (coefficient % divisor !== 0n) return fail('PostgreSQL JSON integer is fractional')
    coefficient /= divisor
  }
  return `${value.negative ? '-' : ''}${coefficient}`
}

function scalarSource(type: PostgresTypeFact, value: GenericValue): string {
  const name = scalarName(type)
  if (numberTypes.has(name)) {
    if (isDecimalAtom(value)) return integerTypes.has(name) ? integerSource(value) : formatDecimal(value)
    if (specialNumberTypes.has(name) && typeof value === 'string' && ['NaN', 'Infinity', '-Infinity'].includes(value))
      return value
    return fail('Expected a PostgreSQL JSON number')
  }
  if (name === 'boolean') {
    if (typeof value !== 'boolean') return fail('Expected a PostgreSQL JSON boolean')
    return value ? 't' : 'f'
  }
  if (typeof value !== 'string') return fail('Expected a PostgreSQL JSON string')
  return value
}

function freezeValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if (isPgDecimal(value)) return value
  if (Array.isArray(value)) return Object.freeze(value.map(freezeValue))
  const result: Record<string, unknown> = {}
  for (const [key, item] of plainEntries(value)) setProperty(result, key, freezeValue(item))
  return Object.freeze(result)
}

function decoded(plan: PgJsonPlan, value: GenericValue): unknown {
  if ('nullable' in plan && plan.nullable && value === null) return null
  switch (plan.kind) {
    case 'generic':
      return value
    case 'string':
      if (typeof value === 'string') return value
      return fail('Expected JSON string')
    case 'number':
      if (isDecimalAtom(value)) return value
      return fail('Expected JSON number')
    case 'null':
      if (value === null) return null
      return fail('Expected JSON null')
    case 'literal':
      if (value === plan.value) return value
      return fail('JSON literal does not match codec')
    case 'scalar':
      return freezeValue(decodePgScalar(plan.type, scalarSource(plan.type, value)))
    case 'array':
      if (!Array.isArray(value)) return fail('Expected JSON array')
      return Object.freeze(value.map((item) => decoded(plan.element, item)))
    case 'object': {
      if (value === null || typeof value !== 'object' || Array.isArray(value) || isDecimalAtom(value))
        return fail('Expected JSON object')
      const entries = new Map(plainEntries(value))
      const result: Record<string, unknown> = {}
      for (const field of plan.fields) {
        if (!entries.has(field.name)) return fail(`Missing JSON field ${field.name}`)
        setProperty(result, field.propertyName, decoded(field.plan, entries.get(field.name) as GenericValue))
        entries.delete(field.name)
      }
      for (const [key, item] of entries) {
        if (Object.hasOwn(result, key)) return fail(`JSON field collision at ${key}`)
        setProperty(result, key, item)
      }
      return Object.freeze(result)
    }
    case 'union':
      return choose(plan, (alternative) => decoded(alternative, value))
  }
}

function choose(plan: Extract<PgJsonPlan, { kind: 'union' }>, apply: (alternative: PgJsonPlan) => unknown): unknown {
  const matches: unknown[] = []
  for (const alternative of plan.alternatives) {
    try {
      matches.push(apply(alternative))
    } catch {
      /* branch does not match */
    }
  }
  const first = matches[0]
  if (matches.length > 1 && (first === null || first === 'null') && matches.every((value) => value === first))
    return first
  if (matches.length !== 1) return fail('JSON union must match exactly one alternative')
  return matches[0]
}

function encoded(plan: PgJsonPlan, value: unknown, ancestors = new Set<object>()): string {
  if ('nullable' in plan && plan.nullable && value === null) return 'null'
  switch (plan.kind) {
    case 'generic':
      return genericSource(value, ancestors, true)
    case 'string':
      if (typeof value === 'string') return JSON.stringify(value)
      return fail('Expected JSON string')
    case 'number':
      if (isDecimalAtom(value)) return formatDecimal(value)
      return fail('Expected JSON number')
    case 'null':
      if (value === null) return 'null'
      return fail('Expected JSON null')
    case 'literal':
      if (value === plan.value) return JSON.stringify(value)
      return fail('JSON literal does not match codec')
    case 'scalar': {
      const name = scalarName(plan.type)
      const text = encodePgScalar(plan.type, value)
      if (numberTypes.has(name)) {
        if (specialNumberTypes.has(name) && ['NaN', 'Infinity', '-Infinity'].includes(text)) return JSON.stringify(text)
        jsonNumber(text)
        return text
      }
      if (name === 'boolean') {
        if (text !== 'true' && text !== 'false') return fail('Invalid PostgreSQL boolean')
        return text
      }
      return JSON.stringify(name.startsWith('timestamp') ? text.replace(' ', 'T') : text)
    }
    case 'array': {
      if (typeof value !== 'object' || value === null || ancestors.has(value))
        return fail('Invalid or cyclic JSON array')
      ancestors.add(value)
      try {
        return `[${arrayValues(value)
          .map((item) => encoded(plan.element, item, ancestors))
          .join(',')}]`
      } finally {
        ancestors.delete(value)
      }
    }
    case 'object': {
      if (typeof value !== 'object' || value === null || ancestors.has(value))
        return fail('Invalid or cyclic JSON object')
      ancestors.add(value)
      try {
        const entries = new Map(plainEntries(value))
        const output = new Map<string, string>()
        for (const field of plan.fields) {
          if (!entries.has(field.propertyName)) return fail(`Missing JSON field ${field.propertyName}`)
          output.set(field.name, encoded(field.plan, entries.get(field.propertyName), ancestors))
          entries.delete(field.propertyName)
        }
        for (const [key, item] of entries) {
          if (output.has(key)) return fail(`JSON field collision at ${key}`)
          output.set(key, genericSource(item, ancestors, true))
        }
        return `{${Array.from(output, ([key, item]) => `${JSON.stringify(key)}:${item}`).join(',')}}`
      } finally {
        ancestors.delete(value)
      }
    }
    case 'union':
      return choose(plan, (alternative) => encoded(alternative, value, ancestors)) as string
  }
}

function domain(plan: PgJsonPlan): Set<string> {
  let result: Set<string>
  switch (plan.kind) {
    case 'generic':
      result = new Set(['null', 'boolean', 'string', 'number', 'array', 'object'])
      break
    case 'null':
      result = new Set(['null'])
      break
    case 'string':
    case 'number':
      result = new Set([plan.kind])
      break
    case 'literal':
      result = new Set([typeof plan.value])
      break
    case 'array':
      result = new Set(['array'])
      break
    case 'object':
      result = new Set(['object'])
      break
    case 'scalar': {
      const name = scalarName(plan.type)
      result = new Set(
        numberTypes.has(name)
          ? ['number', ...(specialNumberTypes.has(name) ? ['string'] : [])]
          : [name === 'boolean' ? 'boolean' : 'string']
      )
      break
    }
    case 'union':
      result = new Set(plan.alternatives.flatMap((alternative) => [...domain(alternative)]))
      break
  }
  if ('nullable' in plan && plan.nullable) result.add('null')
  return result
}

function disjoint(a: PgJsonPlan, b: PgJsonPlan): boolean {
  if (![...domain(a)].some((kind) => kind !== 'null' && domain(b).has(kind))) return true
  if (a.kind === 'literal' && b.kind === 'literal') return a.value !== b.value
  if (a.kind === 'object' && b.kind === 'object') {
    return a.fields.some(
      (left) =>
        left.plan.kind === 'literal' &&
        b.fields.some(
          (right) =>
            right.name === left.name &&
            right.propertyName === left.propertyName &&
            right.plan.kind === 'literal' &&
            left.plan.kind === 'literal' &&
            left.plan.value !== right.plan.value
        )
    )
  }
  return false
}

function checkedPlan(plan: PgJsonPlan): PgJsonPlan {
  switch (plan.kind) {
    case 'generic':
    case 'null':
      return Object.freeze({ kind: plan.kind })
    case 'string':
    case 'number':
      return Object.freeze({ kind: plan.kind, nullable: plan.nullable })
    case 'literal':
      if (typeof plan.value !== 'string' && typeof plan.value !== 'boolean') return fail('Invalid JSON literal plan')
      return Object.freeze({
        kind: 'literal',
        value: plan.value,
        ...(plan.nullable === undefined ? {} : { nullable: plan.nullable }),
      })
    case 'scalar':
      return Object.freeze({
        kind: 'scalar',
        type: freezeValue(structuredClone(plan.type)) as PostgresTypeFact,
        nullable: plan.nullable,
      })
    case 'array':
      return Object.freeze({ kind: 'array', element: checkedPlan(plan.element), nullable: plan.nullable })
    case 'object': {
      const names = new Set<string>()
      const properties = new Set<string>()
      const fields = plan.fields.map((field) => {
        if (
          typeof field.name !== 'string' ||
          typeof field.propertyName !== 'string' ||
          names.has(field.name) ||
          properties.has(field.propertyName)
        )
          return fail('JSON codec has duplicate field names')
        names.add(field.name)
        properties.add(field.propertyName)
        return Object.freeze({ name: field.name, propertyName: field.propertyName, plan: checkedPlan(field.plan) })
      })
      return Object.freeze({ kind: 'object', fields: Object.freeze(fields), nullable: plan.nullable })
    }
    case 'union': {
      const alternatives = plan.alternatives.map(checkedPlan)
      if (
        alternatives.length < 2 ||
        alternatives.some((a, index) => alternatives.slice(index + 1).some((b) => !disjoint(a, b)))
      )
        return fail('Ambiguous JSON union codec')
      return Object.freeze({ kind: 'union', alternatives: Object.freeze(alternatives) })
    }
  }
}

export function createJsonCodec(plan: PgJsonPlan): PgJsonCodec<unknown> {
  const codec = Object.freeze({ valueModel: 'postgres-lossless-v1' }) as PgJsonCodec<unknown>
  codecs.set(codec, checkedPlan(plan))
  return codec
}

export function isJsonPlanSupported(plan: PgJsonPlan): boolean {
  try {
    checkedPlan(plan)
    return true
  } catch {
    return false
  }
}

const genericCodec = createJsonCodec(genericPlan)

function codecPlan(codec: PgJsonCodec<unknown>): PgJsonPlan {
  if (typeof codec !== 'object' || codec === null) return fail('Invalid JSON codec')
  return codecs.get(codec) ?? fail('Unrecognized JSON codec')
}

export function parseJson(source: string): PgJson
export function parseJson<T>(source: string, codec: PgJsonCodec<T>): PgJson<T>
export function parseJson(source: string, codec: PgJsonCodec<unknown> = genericCodec): unknown {
  if (typeof source !== 'string') return fail('JSON source must be a string')
  const value = decoded(codecPlan(codec), parseGeneric(source))
  const document = Object.freeze({ kind: 'json', source, value, codec }) as PgJson<unknown>
  documents.add(document)
  return document
}

export function json<const T extends PgJsonInput>(value: T): PgJson<JsonDecoded<T>>
export function json<T>(value: NoInfer<JsonReadonly<T>>, codec: PgJsonCodec<T>): PgJson<T>
export function json(value: unknown, codec: PgJsonCodec<unknown> = genericCodec): unknown {
  return parseJson(encoded(codecPlan(codec), value), codec)
}

export function isPgJson(value: unknown): value is PgJson<unknown> {
  return typeof value === 'object' && value !== null && documents.has(value)
}

export function encodeJsonParameter(value: unknown): string {
  if (isPgJson(value)) return value.source
  if (typeof value === 'object' && value !== null && documentLike(value)) {
    return fail('Unrecognized JSON document')
  }
  return genericSource(value)
}

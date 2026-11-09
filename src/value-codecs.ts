import type { PostgresTypeFact } from './postgres-types.js'
import type { PgJsonCodec, PgJsonPlan } from './value-types.js'
import { parsePgArray, formatPgArray } from './array-values.js'
import { createJsonCodec, encodeJsonParameter, parseJson } from './json-values.js'
import { decodePgScalar, encodePgScalar } from './scalar-values.js'

const jsonCodecs = new WeakMap<PgJsonPlan, PgJsonCodec<unknown>>()

function jsonCodec(plan: PgJsonPlan): PgJsonCodec<unknown> {
  const cached = jsonCodecs.get(plan)
  if (cached) return cached
  const codec = createJsonCodec(plan)
  if (Object.isFrozen(plan)) jsonCodecs.set(plan, codec)
  return codec
}

export function decodePgValue(type: PostgresTypeFact, source: string, jsonPlan?: PgJsonPlan): unknown {
  if (type.pgTypeKind === 'domain' && type.pgBaseType) return decodePgValue(type.pgBaseType, source, jsonPlan)
  if (type.pgTypeKind === 'array' && type.pgArrayElementType) {
    const elementType = type.pgArrayElementType
    const array = parsePgArray(source, type.pgArrayDelimiter)
    return Object.freeze({
      dimensions: array.dimensions,
      values: Object.freeze(array.values.map((value) => (value === null ? null : decodePgValue(elementType, value)))),
    })
  }
  if (type.pgTypeSchema === 'pg_catalog' && (type.pgTypeName === 'json' || type.pgTypeName === 'jsonb')) {
    return jsonPlan ? parseJson(source, jsonCodec(jsonPlan)) : parseJson(source)
  }
  return decodePgScalar(type, source)
}

export function encodePgValue(type: PostgresTypeFact, value: unknown): string | null {
  const encoded = encodePgTextValue(type, value)
  if (encoded !== null) {
    if (encoded.includes('\0')) throw new TypeError('PostgreSQL text parameters cannot contain zero bytes.')
    if (/[\uD800-\uDFFF]/u.test(encoded)) {
      throw new TypeError('PostgreSQL text parameters must contain valid Unicode scalar values.')
    }
  }
  return encoded
}

function encodePgTextValue(type: PostgresTypeFact, value: unknown): string | null {
  if (value === null) return null
  if (value === undefined) throw new TypeError('PostgreSQL parameters cannot be undefined.')
  if (type.pgTypeKind === 'domain' && type.pgBaseType) return encodePgValue(type.pgBaseType, value)
  if (type.pgTypeKind === 'array' && type.pgArrayElementType) {
    const elementType = type.pgArrayElementType
    if (
      !Array.isArray(value) &&
      (typeof value !== 'object' || value === null || !('dimensions' in value) || !('values' in value))
    ) {
      throw new TypeError('PostgreSQL array parameters require an array or a dimension-carrying PgArray.')
    }
    return formatPgArray(
      value as readonly unknown[] | import('./value-types.js').PgArray<unknown>,
      (element) => {
        const encoded = encodePgValue(elementType, element)
        if (encoded === null) throw new TypeError('Array element encoding must preserve NULL separately.')
        return encoded
      },
      type.pgArrayDelimiter
    )
  }
  if (type.pgTypeSchema === 'pg_catalog' && (type.pgTypeName === 'json' || type.pgTypeName === 'jsonb')) {
    return encodeJsonParameter(value)
  }
  return encodePgScalar(type, value)
}

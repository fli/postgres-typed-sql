import assert from 'node:assert/strict'
import test from 'node:test'

import type { TypedSqlPostgresIrJsonShape } from '../src/analyzer-ir-model.js'
import { jsonPlanForShape, safeJsonCodecShape } from '../src/json-plan.js'
import { createJsonCodec, parseJson } from '../src/json-values.js'

const nonNull = { kind: 'nonNull', basis: 'test' } as const
const nullable = { kind: 'nullable', evidence: 'test' } as const
const text = {
  pgType: 'text',
  pgTypeSchema: 'pg_catalog',
  pgTypeName: 'text',
  pgTypeKind: 'base',
  pgTypeOid: 25,
} as const

test('SQL nullability is outside a JSON document but nested literal nullability is retained', () => {
  const shape: TypedSqlPostgresIrJsonShape = {
    kind: 'object',
    nullability: nullable,
    fields: [{ name: 'label', shape: { kind: 'stringLiteral', ...text, value: 'known', nullability: nullable } }],
  }
  const codec = createJsonCodec(jsonPlanForShape(shape, 'preserve'))
  assert.throws(() => parseJson('null', codec), /object/u)
  assert.deepEqual(parseJson('{"label":null}', codec).value, { label: null })
  assert.deepEqual(parseJson('{"label":"known"}', codec).value, { label: 'known' })
})

test('merging indistinguishable JSON alternatives retains every branch nullability', () => {
  const literal: TypedSqlPostgresIrJsonShape = { kind: 'stringLiteral', ...text, value: 'known', nullability: nonNull }
  const maybeText: TypedSqlPostgresIrJsonShape = { kind: 'scalar', ...text, nullability: nullable }
  const shape: TypedSqlPostgresIrJsonShape = {
    kind: 'union',
    nullability: nonNull,
    alternatives: [literal, maybeText].map((value) => ({
      kind: 'object',
      nullability: nonNull,
      fields: [{ name: 'value', shape: value }],
    })),
  }
  const safe = safeJsonCodecShape(shape, 'preserve')
  assert.equal(safe.kind, 'object')
  if (safe.kind !== 'object') throw new Error('Expected a merged object')
  assert.equal(safe.fields[0]?.shape.nullability.kind, 'nullable')
  const codec = createJsonCodec(jsonPlanForShape(safe, 'preserve'))
  assert.deepEqual(parseJson('{"value":null}', codec).value, { value: null })
  assert.deepEqual(parseJson('{"value":"other"}', codec).value, { value: 'other' })
})

test('otherwise distinct nullable union branches share a single JSON null interpretation', () => {
  const codec = createJsonCodec({
    kind: 'union',
    alternatives: [
      { kind: 'string', nullable: true },
      { kind: 'number', nullable: true },
    ],
  })
  assert.equal(parseJson('null', codec).value, null)
  assert.equal(parseJson('"value"', codec).value, 'value')
  assert.deepEqual(parseJson('9007199254740993', codec).value, {
    kind: 'finite',
    negative: false,
    coefficient: 9007199254740993n,
    exponent: 0n,
  })
})

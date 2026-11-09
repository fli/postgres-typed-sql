import assert from 'node:assert/strict'
import test from 'node:test'
import { types as driverTypes } from 'pg'

import {
  postgresJsonSupportsStringLiteralRefinement,
  postgresResultSupportsStringLiteralRefinement,
  resolveTypeScriptJsonScalarTypeForPostgresType,
  resolveTypeScriptParameterTypeForPostgresType,
  resolveTypeScriptResultTypeForPostgresType,
} from '../src/postgres-codecs.js'
import { postgresJsonValueMayBeStructured, type PostgresTypeFact } from '../src/postgres-types.js'
import { decodePgValue, encodePgValue } from '../src/value-codecs.js'
import { createJsonCodec } from '../src/json-values.js'
import { parseJson } from '../src/values.js'
import type {
  PgArray,
  PgArrayInput,
  PgDate,
  PgDateInput,
  PgDecimal,
  PgDecimalInput,
  PgInt8Input,
  PgInterval,
  PgIntervalInput,
  PgTimestampTz,
  PgTimestampTzInput,
} from '../src/values.js'

const pgCatalog = (pgType: string, pgTypeName: string, pgTypeOid = 0): PostgresTypeFact => ({
  pgType,
  pgTypeName,
  pgTypeOid,
  pgTypeSchema: 'pg_catalog',
  pgTypeKind: 'base',
})
const arrayFact = (element: PostgresTypeFact, pgTypeOid = 1007): PostgresTypeFact => ({
  pgType: `${element.pgType}[]`,
  pgTypeName: `_${element.pgTypeName}`,
  pgTypeSchema: element.pgTypeSchema,
  pgTypeKind: 'array',
  pgTypeOid,
  pgArrayElementType: element,
  pgArrayDelimiter: ',',
})
const domainOf = (name: string, base: PostgresTypeFact): PostgresTypeFact => ({
  pgType: `audit.${name}`,
  pgTypeName: name,
  pgTypeOid: 16400,
  pgTypeSchema: 'audit',
  pgTypeKind: 'domain',
  pgBaseType: base,
})
const enumFact: PostgresTypeFact = {
  pgType: 'audit.status',
  pgTypeName: 'status',
  pgTypeOid: 16401,
  pgTypeSchema: 'audit',
  pgTypeKind: 'enum',
  pgEnumLabels: ['queued', 'complete'],
}
const result = (type: PostgresTypeFact) => resolveTypeScriptResultTypeForPostgresType(type).type
const parameter = (type: PostgresTypeFact) => resolveTypeScriptParameterTypeForPostgresType(type).type
const jsonScalar = (type: PostgresTypeFact) => resolveTypeScriptJsonScalarTypeForPostgresType(type).type

test('fixed result types correspond to decoded values', () => {
  const cases: readonly [PostgresTypeFact, string, string, unknown][] = [
    [pgCatalog('boolean', 'bool', 16), 'boolean', 't', true],
    [pgCatalog('integer', 'int4', 23), 'number', '42', 42],
    [pgCatalog('bigint', 'int8', 20), 'bigint', '9007199254740993', 9007199254740993n],
    [
      pgCatalog('numeric', 'numeric', 1700),
      'PgDecimal',
      '12.3400',
      { kind: 'finite', negative: false, coefficient: 123400n, exponent: -4n },
    ],
    [pgCatalog('date', 'date', 1082), 'PgDate', '2026-07-15', { kind: 'finite', year: 2026, month: 7, day: 15 }],
    [
      pgCatalog('timestamp with time zone', 'timestamptz', 1184),
      'PgTimestampTz',
      '1970-01-01 00:00:00.000001+00',
      { kind: 'finite', unixMicroseconds: 1n },
    ],
    [pgCatalog('bytea', 'bytea', 17), 'Uint8Array', '\\x00ff', Uint8Array.of(0, 255)],
    [pgCatalog('text', 'text', 25), 'string', '2026-07-15', '2026-07-15'],
  ]
  for (const [type, expectedType, source, value] of cases) {
    assert.equal(result(type), expectedType, type.pgType)
    assert.deepEqual(decodePgValue(type, source), value, type.pgType)
  }
  const point = pgCatalog('point', 'point', 600)
  assert.equal(result(point), 'PgRawValue')
  assert.deepEqual(decodePgValue(point, '(1,2)'), {
    kind: 'raw',
    type: { schema: 'pg_catalog', name: 'point' },
    source: { format: 'text', value: '(1,2)' },
  })
})

test('domains and enum arrays retain their value representation and element nullability', () => {
  const bigId = domainOf('big_id', pgCatalog('bigint', 'int8', 20))
  assert.equal(result(bigId), 'bigint')
  assert.equal(decodePgValue(bigId, '9007199254740993'), 9007199254740993n)
  assert.equal(result(enumFact), '"queued" | "complete"')
  assert.equal(result(arrayFact(enumFact)), 'PgArray<"queued" | "complete" | null>')
  assert.deepEqual(decodePgValue(arrayFact(enumFact), '[0:1]={queued,NULL}'), {
    dimensions: [{ lowerBound: 0, length: 2 }],
    values: ['queued', null],
  })
  assert.throws(() => decodePgValue(enumFact, 'missing'), /enum/u)
})

test('parameter types expose convenient inputs and validate them at encoding', () => {
  const bigint = pgCatalog('bigint', 'int8', 20)
  const numeric = pgCatalog('numeric', 'numeric', 1700)
  const date = pgCatalog('date', 'date', 1082)
  const timestampTz = pgCatalog('timestamp with time zone', 'timestamptz', 1184)
  assert.equal(parameter(bigint), 'PgInt8Input')
  assert.equal(parameter(numeric), 'PgDecimalInput')
  assert.equal(parameter(date), 'PgDateInput')
  assert.equal(parameter(timestampTz), 'PgTimestampTzInput')
  assert.equal(parameter(arrayFact(bigint)), 'PgArrayInput<PgInt8Input | null>')
  assert.equal(parameter(pgCatalog('interval', 'interval', 1186)), 'PgIntervalInput')
  assert.equal(parameter(pgCatalog('point', 'point', 600)), 'string | PgRawValue')
  assert.equal(encodePgValue(bigint, '9007199254740993'), '9007199254740993')
  assert.throws(() => encodePgValue(bigint, Number.MAX_SAFE_INTEGER + 1), /Unsafe integer/u)
  assert.throws(() => encodePgValue(timestampTz, '2026-07-15 12:00:00'), /offset/u)
  assert.equal(encodePgValue(date, '2026-07-15'), '2026-07-15')
  const point = pgCatalog('point', 'point', 600)
  assert.equal(encodePgValue(point, decodePgValue(point, '(1,2)')), '(1,2)')
  assert.equal(encodePgValue(arrayFact(bigint), [1n, null, '2']), '{"1",NULL,"2"}')
})

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false

test('public input unions admit convenient values while retaining exact result records', () => {
  const exactTypes: [
    Equal<PgInt8Input, bigint | number | string>,
    Equal<PgDecimalInput, PgDecimal | bigint | number | string>,
    Equal<PgDateInput, PgDate | string>,
    Equal<PgIntervalInput, PgInterval | string>,
    Equal<PgTimestampTzInput, PgTimestampTz | string | Date>,
    Equal<PgArrayInput<bigint | null>, readonly (bigint | null)[] | PgArray<bigint | null>>,
  ] = [true, true, true, true, true, true]
  assert.ok(exactTypes.every(Boolean))
  const bigintInputs: readonly PgInt8Input[] = [1n, 1, '1']
  const numericInputs: readonly PgDecimalInput[] = [1n, 1.5, '1.500']
  const dateInputs: readonly PgDateInput[] = ['2026-07-15', { kind: 'finite', year: 2026, month: 7, day: 15 }]
  const instantInputs: readonly PgTimestampTzInput[] = ['2026-07-15T00:00:00Z', new Date(0)]
  const arrayInputs: readonly PgArrayInput<PgInt8Input | null>[] = [
    [1n, null],
    { dimensions: [{ lowerBound: 0, length: 1 }], values: ['1'] },
  ]
  assert.equal(
    bigintInputs.length + numericInputs.length + dateInputs.length + instantInputs.length + arrayInputs.length,
    12
  )
})

test('rich JSON scalar types and literal refinements follow PostgreSQL conversion evidence', () => {
  const text = pgCatalog('text', 'text', 25)
  const date = pgCatalog('date', 'date', 1082)
  const numeric = domainOf('amount', pgCatalog('numeric', 'numeric', 1700))
  assert.equal(jsonScalar(numeric), 'PgDecimal')
  assert.equal(jsonScalar(date), 'PgDate')
  assert.equal(jsonScalar(enumFact), '"queued" | "complete"')
  assert.equal(jsonScalar({ ...enumFact, pgCastsToJson: true }), 'PgJsonValue')
  assert.equal(jsonScalar(arrayFact(text)), 'PgJsonValue')
  assert.equal(postgresResultSupportsStringLiteralRefinement(domainOf('label', text)), true)
  assert.equal(postgresJsonSupportsStringLiteralRefinement(enumFact), true)
  assert.equal(postgresJsonSupportsStringLiteralRefinement({ ...enumFact, pgCastsToJson: true }), false)
  assert.equal(postgresJsonSupportsStringLiteralRefinement(date), false)
  assert.equal(
    postgresJsonSupportsStringLiteralRefinement({ ...pgCatalog('unknown', 'unknown', 705), pgTypeKind: 'pseudo' }),
    true
  )
  assert.equal(postgresJsonValueMayBeStructured(domainOf('payload', pgCatalog('jsonb', 'jsonb', 3802))), true)
  assert.equal(postgresJsonValueMayBeStructured(domainOf('label', text)), false)

  const source = '{"date":"2026-07-15","amount":9007199254740993}'
  const generic = parseJson(source)
  assert.deepEqual(generic.value, {
    date: '2026-07-15',
    amount: { kind: 'finite', negative: false, coefficient: 9007199254740993n, exponent: 0n },
  })
  const rich = parseJson(
    source,
    createJsonCodec({
      kind: 'object',
      fields: [
        { name: 'date', propertyName: 'date', plan: { kind: 'scalar', type: date } },
        { name: 'amount', propertyName: 'amount', plan: { kind: 'scalar', type: pgCatalog('bigint', 'int8', 20) } },
      ],
    })
  )
  assert.deepEqual(rich.value, { date: { kind: 'finite', year: 2026, month: 7, day: 15 }, amount: 9007199254740993n })
  assert.equal(rich.source, source)
})

test('decoding is independent of pg-types global parsers', () => {
  const oid = 20
  const original = driverTypes.getTypeParser(oid)
  try {
    driverTypes.setTypeParser(oid, () => 'global-parser-was-used')
    assert.equal(decodePgValue(pgCatalog('bigint', 'int8', oid), '9007199254740993'), 9007199254740993n)
  } finally {
    driverTypes.setTypeParser(oid, original)
  }
})

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { parsePgArray, formatPgArray } from '../src/array-values.js'
import {
  decimal,
  jsonNumber,
  formatDecimal,
  isDecimalAtom,
  decodePgScalar,
  encodePgScalar,
} from '../src/scalar-values.js'
import type { PostgresTypeFact } from '../src/postgres-types.js'

const fact = (name: string): PostgresTypeFact => ({
  pgType: name,
  pgTypeKind: 'base',
  pgTypeName: name,
  pgTypeOid: 1,
  pgTypeSchema: 'pg_catalog',
})

test('decimals preserve coefficient, scale, signed zero, and unbounded JSON exponents', () => {
  const value = decimal('-12.3400e+8')
  assert.deepEqual(value, { kind: 'finite', negative: true, coefficient: 123400n, exponent: 4n })
  assert.equal(formatDecimal(value), '-123400e4')
  assert.equal(formatDecimal(decimal('-0.00')), '-0e-2')
  const giant = jsonNumber('1e123456789012345678901234567890')
  assert.equal(formatDecimal(giant), '1e123456789012345678901234567890')
  assert.ok(Object.isFrozen(giant))
  assert.ok(isDecimalAtom(giant))
  assert.equal(isDecimalAtom({ ...giant }), false)
  assert.throws(() => jsonNumber('01'))
  assert.throws(() => decimal({ negative: false, coefficient: -1n, exponent: 0n }))
})

test('scalars validate integer inputs and preserve bytes and float special values', () => {
  assert.equal(decodePgScalar(fact('int8'), '-9223372036854775808'), -9223372036854775808n)
  assert.equal(encodePgScalar(fact('int8'), '9223372036854775807'), '9223372036854775807')
  assert.throws(() => encodePgScalar(fact('int8'), 9007199254740992))
  assert.throws(() => encodePgScalar(fact('int2'), 32768))
  assert.ok(Object.is(decodePgScalar(fact('float8'), '-0'), -0))
  assert.ok(Number.isNaN(decodePgScalar(fact('float8'), 'NaN')))
  assert.equal(decodePgScalar(fact('float8'), '-Infinity'), -Infinity)
  assert.throws(() => encodePgScalar(fact('float8'), '1e-400'), /out of range/u)
  assert.throws(() => encodePgScalar(fact('float8'), '1e400'), /out of range/u)
  assert.throws(() => encodePgScalar(fact('float4'), '1e-46'), /out of range/u)
  assert.throws(() => encodePgScalar(fact('float4'), 1e-46), /out of range/u)
  const bytes = new Uint8Array([0, 1, 127, 255])
  assert.deepEqual(decodePgScalar(fact('bytea'), encodePgScalar(fact('bytea'), bytes)), bytes)
  assert.throws(() => decodePgScalar(fact('bytea'), '\\xabc'))
})

test('temporal records retain BC dates, 24:00, timezone seconds, and microseconds', () => {
  assert.deepEqual(decodePgScalar(fact('date'), '0001-02-29 BC'), { kind: 'finite', year: 0, month: 2, day: 29 })
  assert.equal(encodePgScalar(fact('date'), { kind: 'finite', year: 0, month: 2, day: 29 }), '0001-02-29 BC')
  assert.deepEqual(decodePgScalar(fact('time'), '24:00:00'), {
    hour: 24,
    minute: 0,
    second: 0,
    millisecond: 0,
    microsecond: 0,
  })
  assert.throws(() => decodePgScalar(fact('time'), '24:00:00.000001'))
  assert.deepEqual(decodePgScalar(fact('timetz'), '12:34:56.123456-03:30:12'), {
    time: { hour: 12, minute: 34, second: 56, millisecond: 123, microsecond: 456 },
    utcOffsetSeconds: -12612,
  })
  for (const text of [
    '1970-01-01 00:00:00+00',
    '1969-12-31 23:59:59.999999+00',
    '0001-01-01 00:00:00+00 BC',
    '2024-02-29 23:59:59.123456+05:30',
  ]) {
    const value = decodePgScalar(fact('timestamptz'), text)
    assert.deepEqual(decodePgScalar(fact('timestamptz'), encodePgScalar(fact('timestamptz'), value)), value)
  }
  assert.throws(() => encodePgScalar(fact('timestamptz'), '2020-01-01 00:00:00'))
  assert.throws(() => decodePgScalar(fact('date'), '2023-02-29'))
  assert.deepEqual(decodePgScalar(fact('date'), '4714-11-24 BC'), { kind: 'finite', year: -4713, month: 11, day: 24 })
  assert.throws(() => decodePgScalar(fact('date'), '4714-11-23 BC'))
  assert.deepEqual(decodePgScalar(fact('timestamptz'), '4714-11-24 00:00:00+00 BC'), {
    kind: 'finite',
    unixMicroseconds: -210866803200000000n,
  })
})

test('intervals preserve independent signs and large exact microseconds', () => {
  const value = decodePgScalar(fact('interval'), '1 year -2 mons 3 days -04:05:06.123456')
  assert.deepEqual(value, { kind: 'finite', months: 10, days: 3, microseconds: -14706123456n })
  assert.equal(encodePgScalar(fact('interval'), value), '10 mons 3 days -14706123456 microseconds')
  assert.deepEqual(decodePgScalar(fact('interval'), '-2562047788:00:54.775808'), {
    kind: 'finite',
    months: 0,
    days: 0,
    microseconds: -9223372036854775808n,
  })
})

test('arrays preserve lower bounds, dimensions, nulls, quotes, and custom delimiters', () => {
  const source = '[0:1][-2:0]={{"NULL",NULL,"a,b"},{"a\\"b","a\\\\b",""}}'
  const parsed = parsePgArray(source)
  assert.deepEqual(parsed, {
    dimensions: [
      { lowerBound: 0, length: 2 },
      { lowerBound: -2, length: 3 },
    ],
    values: ['NULL', null, 'a,b', 'a"b', 'a\\b', ''],
  })
  assert.deepEqual(parsePgArray(formatPgArray(parsed, (value) => String(value))), parsed)
  assert.deepEqual(parsePgArray('{"(1,2)";"(3,4)"}', ';').values, ['(1,2)', '(3,4)'])
  assert.deepEqual(parsePgArray('{}'), { dimensions: [], values: [] })
  for (const value of ['\u00a0foo', '\u2003', 'foo\u2028', '\u00a0NULL']) {
    assert.deepEqual(parsePgArray(`{${value}}`).values, [value])
  }
  assert.throws(() => parsePgArray('{{1},{2,3}}'))
  assert.throws(() => formatPgArray({ dimensions: [{ lowerBound: 1, length: 2 }], values: [1] }, String))
  assert.equal(formatPgArray([[1, 2]], JSON.stringify), '{"[1,2]"}')
})

test('raw payloads keep type identity and reject unverified writes', () => {
  const value = decodePgScalar(fact('inet'), '192.0.2.1/24')
  assert.equal(encodePgScalar(fact('inet'), value), '192.0.2.1/24')
  assert.throws(() => encodePgScalar(fact('cidr'), value))
  const extension = { ...fact('vector'), pgTypeSchema: 'public' }
  assert.throws(() => encodePgScalar(extension, decodePgScalar(extension, '[1,2]')))
})

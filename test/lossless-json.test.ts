import assert from 'node:assert/strict'
import test from 'node:test'

import { createJsonCodec, encodeJsonParameter, isPgJson, json, parseJson } from '../src/json-values.js'
import { jsonNumber } from '../src/scalar-values.js'
import type { PostgresTypeFact } from '../src/postgres-types.js'
import type { PgJsonCodec, PgJsonPlan } from '../src/value-types.js'
import { encodePgValue } from '../src/value-codecs.js'

function type(name: string): PostgresTypeFact {
  return { pgType: name, pgTypeName: name, pgTypeSchema: 'pg_catalog', pgTypeKind: 'base', pgTypeOid: 0 }
}

test('JSON documents preserve source and exact generic numbers', () => {
  const source = ' {"n":1.2300e+2,"n":-0,"huge":1e999999999999999999999,"__proto__":{"constructor":3}} '
  const document = parseJson(source)
  assert.equal(encodeJsonParameter(document), source)
  const clone = { ...document }
  assert.equal(isPgJson(clone), false)
  assert.throws(() => encodeJsonParameter(clone))
  assert.throws(() => encodeJsonParameter({ nested: clone }))
  assert.equal(isPgJson(document), true)
  const view = document.value
  assert.deepEqual(view, {
    n: { kind: 'finite', negative: true, coefficient: 0n, exponent: 0n },
    huge: { kind: 'finite', negative: false, coefficient: 1n, exponent: 999999999999999999999n },
    ['__proto__']: { constructor: { kind: 'finite', negative: false, coefficient: 3n, exponent: 0n } },
  })
  assert.equal(Object.getPrototypeOf(view), Object.prototype)
  assert.equal(Object.getOwnPropertySymbols(view as object).length, 0)
  assert.equal(Object.isFrozen(view), true)
  assert.equal(Object.isFrozen((view as Record<string, unknown>).__proto__), true)
  assert.throws(() => parseJson('[1,]'))
  assert.throws(() => parseJson('{"a":1} trailing'))
  assert.throws(() => parseJson('01'))
})

test('JSON transport rejects source text that UTF-8 encoding would replace', () => {
  const invalidSource = parseJson('"' + '\ud800' + '"')
  assert.throws(() => encodePgValue(type('json'), invalidSource), /Unicode/u)
  assert.throws(() => encodePgValue(type('json'), parseJson('"\0"')), /zero bytes|JSON/u)
  assert.equal(encodePgValue(type('json'), json('\ud800')), '"\\ud800"')
})

test('JSON input snapshots, validates, and serializes supported inputs', () => {
  const input = { amount: jsonNumber('1.2300'), big: 9007199254740993n, fraction: 0.5, zero: -0, nested: [true] }
  const document = json(input)
  input.nested[0] = false
  assert.equal(
    encodeJsonParameter(document),
    '{"amount":12300e-4,"big":9007199254740993,"fraction":0.5,"zero":-0,"nested":[true]}'
  )
  assert.deepEqual(document.value.amount, { kind: 'finite', negative: false, coefficient: 12300n, exponent: -4n })
  assert.equal(document.value.nested[0], true)
  const copiedNumber = { ...jsonNumber('1.25') }
  assert.throws(() => json({ amount: copiedNumber }), /Unrecognized decimal/u)
  assert.throws(() => encodeJsonParameter({ amount: copiedNumber }), /Unrecognized decimal/u)
  const literalRecord = json({ ...copiedNumber, coefficient: jsonNumber('125'), exponent: jsonNumber('-2') })
  assert.match(literalRecord.source, /^\{"kind":"finite","negative":false,"coefficient":125e0,"exponent":-2e0\}$/u)
  assert.equal(json(null).source, 'null')
  const documentShapedData = { kind: 'json', source: 'ordinary data', codec: {}, value: 'ordinary data' }
  const literalDocument = json(documentShapedData)
  assert.equal(literalDocument.source, JSON.stringify(documentShapedData))
  assert.deepEqual(literalDocument.value, documentShapedData)
  assert.equal(encodeJsonParameter('null'), '"null"')
  for (const value of [Number.NaN, Infinity, 9007199254740992, undefined, () => 1, new Date(), [undefined], Array(1)]) {
    assert.throws(() => encodeJsonParameter(value))
  }
  const cycle: { self?: unknown } = {}
  cycle.self = cycle
  assert.throws(() => encodeJsonParameter(cycle))
  assert.throws(() =>
    encodeJsonParameter({
      get value() {
        return 1
      },
    })
  )
})

test('modeled JSON maps field names, exact scalar values, and unknown properties in both directions', () => {
  const plan: PgJsonPlan = {
    kind: 'object',
    fields: [
      { name: 'account_id', propertyName: 'accountId', plan: { kind: 'scalar', type: type('int8') } },
      { name: 'amount', propertyName: 'amount', plan: { kind: 'scalar', type: type('numeric') } },
      { name: 'created_at', propertyName: 'createdAt', plan: { kind: 'scalar', type: type('date') } },
    ],
  }
  const codec = createJsonCodec(plan)
  const source = '{"account_id":9007199254740993,"amount":1.2300,"created_at":"2024-01-02","extra":7}'
  const document = parseJson(source, codec)
  const value = document.value as Record<string, unknown>
  assert.equal(value.accountId, 9007199254740993n)
  assert.deepEqual(value.amount, { kind: 'finite', negative: false, coefficient: 12300n, exponent: -4n })
  assert.deepEqual(value.createdAt, { kind: 'finite', year: 2024, month: 1, day: 2 })
  assert.equal(Object.isFrozen(value.createdAt), true)
  assert.equal(Object.getOwnPropertySymbols(value.createdAt as object).length, 0)
  assert.equal(
    json({ ...value, accountId: 5n }, codec).source,
    '{"account_id":5,"amount":12300e-4,"created_at":"2024-01-02","extra":7e0}'
  )
  assert.throws(() => parseJson('{"account_id":1,"amount":2,"created_at":"2024-01-02","accountId":3}', codec))
  assert.throws(() => json({ ...value, account_id: 3 }, codec))
  assert.throws(() => parseJson('{"account_id":1}', codec))
})

test('JSON codecs reject ambiguous unions and select distinct tagged alternatives', () => {
  const tagged = (tag: string, valueType: string): PgJsonPlan => ({
    kind: 'object',
    fields: [
      { name: 'tag', propertyName: 'tag', plan: { kind: 'literal', value: tag } },
      { name: 'value', propertyName: 'value', plan: { kind: 'scalar', type: type(valueType) } },
    ],
  })
  const codec = createJsonCodec({ kind: 'union', alternatives: [tagged('count', 'int8'), tagged('date', 'date')] })
  assert.deepEqual(parseJson('{"tag":"count","value":9007199254740993}', codec).value, {
    tag: 'count',
    value: 9007199254740993n,
  })
  assert.throws(() => parseJson('{"tag":"other","value":1}', codec))
  assert.throws(() => createJsonCodec({ kind: 'union', alternatives: [{ kind: 'generic' }, tagged('date', 'date')] }))
  assert.throws(() =>
    createJsonCodec({
      kind: 'object',
      fields: [
        { name: 'a', propertyName: 'x', plan: { kind: 'generic' } },
        { name: 'b', propertyName: 'x', plan: { kind: 'generic' } },
      ],
    })
  )
  assert.throws(() => parseJson('1', { valueModel: 'postgres-lossless-v1' } as PgJsonCodec<unknown>))
})

test('modeled JSON handles scalar JSON spelling and nullable values', () => {
  assert.throws(() => parseJson('1e-400', createJsonCodec({ kind: 'scalar', type: type('float8') })), /out of range/u)
  assert.throws(() => parseJson('1e-46', createJsonCodec({ kind: 'scalar', type: type('float4') })), /out of range/u)
  const plan: PgJsonPlan = {
    kind: 'object',
    fields: [
      { name: 'b', propertyName: 'b', plan: { kind: 'scalar', type: type('bool') } },
      { name: 'i', propertyName: 'i', plan: { kind: 'scalar', type: type('int8') } },
      { name: 'f', propertyName: 'f', plan: { kind: 'scalar', type: type('float8') } },
      { name: 'n', propertyName: 'n', plan: { kind: 'scalar', type: type('numeric'), nullable: true } },
      { name: 'ts', propertyName: 'ts', plan: { kind: 'scalar', type: type('timestamptz') } },
    ],
  }
  const codec = createJsonCodec(plan)
  const source = '{"b":true,"i":1.2e1,"f":"Infinity","n":null,"ts":"2024-01-02T03:04:05+00:00"}'
  const value = parseJson(source, codec).value as Record<string, unknown>
  assert.equal(value.b, true)
  assert.equal(value.i, 12n)
  assert.equal(value.f, Infinity)
  assert.equal(value.n, null)
  const revised = json(value, codec)
  assert.deepEqual(revised.value, value)
  assert.throws(() => parseJson(source.replace('1.2e1', '1.2'), codec))
  assert.throws(() => parseJson(source.replace('1.2e1', '1e999999999999999999999'), codec))
})

test('primitive JSON plans validate the source shape and retain exact numbers', () => {
  const numberCodec = createJsonCodec({ kind: 'number' })
  const stringCodec = createJsonCodec({ kind: 'string', nullable: true })
  assert.deepEqual(parseJson('1.2300', numberCodec).value, jsonNumber('1.2300'))
  assert.equal(json(jsonNumber('1.2300'), numberCodec).source, '12300e-4')
  assert.throws(() => parseJson('"1.2300"', numberCodec))
  assert.equal(parseJson('"\\\\x00ff"', stringCodec).value, '\\x00ff')
  assert.equal(parseJson('null', stringCodec).value, null)
  assert.throws(() => parseJson('1', stringCodec))
})

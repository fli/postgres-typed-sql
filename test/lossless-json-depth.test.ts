import assert from 'node:assert/strict'
import test from 'node:test'

import { createJsonCodec, encodeJsonParameter, json, parseJson } from '../src/json-values.js'
import { decimal, jsonNumber } from '../src/scalar-values.js'
import type { PgJsonInput } from '../src/value-types.js'

const depth = 6000

function checkNested(value: unknown, kind: 'array' | 'object'): void {
  for (let i = 0; i < depth; i++) {
    assert.ok(value !== null && typeof value === 'object')
    assert.equal(Object.isFrozen(value), true)
    if (kind === 'array') {
      assert.ok(Array.isArray(value))
      assert.equal(value.length, 1)
      value = value[0]
    } else {
      assert.equal(Array.isArray(value), false)
      assert.equal(Object.getPrototypeOf(value), Object.prototype)
      assert.deepEqual(Object.keys(value), ['child'])
      value = Reflect.get(value, 'child')
    }
  }
  assert.deepEqual(value, jsonNumber('1'))
}

test('deep arrays and objects retain source and freeze each decoded node', () => {
  for (const kind of ['array', 'object'] as const) {
    const open = kind === 'array' ? '[' : '{"child":'
    const close = kind === 'array' ? ']' : '}'
    const source = ` \n${open.repeat(depth)}1${close.repeat(depth)}\t`
    const document = parseJson(source)
    assert.equal(document.source, source)
    assert.equal(encodeJsonParameter(document), source)
    checkNested(document.value, kind)
    assert.throws(() => parseJson(`${open.repeat(depth)}1,${close.repeat(depth)}`))
  }
})

test('deep native values serialize and are frozen without recursion', () => {
  for (const kind of ['array', 'object'] as const) {
    let value: PgJsonInput = 1
    for (let i = 0; i < depth; i++) value = kind === 'array' ? [value] : { child: value }
    const document = json(value)
    const open = kind === 'array' ? '[' : '{"child":'
    const close = kind === 'array' ? ']' : '}'
    assert.equal(document.source, `${open.repeat(depth)}1${close.repeat(depth)}`)
    checkNested(document.value, kind)
  }
})

test('serialization distinguishes shared references from cycles and preserves outer ancestors', () => {
  const shared = { value: 1 }
  assert.equal(json([shared, shared]).source, '[{"value":1},{"value":1}]')
  const cycle: { child?: unknown } = {}
  cycle.child = cycle
  assert.throws(() => encodeJsonParameter(cycle), /Cyclic JSON value/)
  const codec = createJsonCodec({ kind: 'object', fields: [] })
  assert.throws(() => json(cycle, codec), /Cyclic JSON value/)
})

test('deep parsing retains duplicate and special object keys', () => {
  const source = `${'['.repeat(depth)}{"__proto__":1,"__proto__":2}${']'.repeat(depth)}`
  let value: unknown = parseJson(source).value
  for (let i = 0; i < depth; i++) {
    assert.ok(Array.isArray(value))
    value = value[0]
  }
  assert.ok(value !== null && typeof value === 'object')
  assert.equal(Object.getPrototypeOf(value), Object.prototype)
  assert.equal(Object.hasOwn(value, '__proto__'), true)
  assert.deepEqual(Reflect.get(value, '__proto__'), jsonNumber('2'))
})

test('modeled objects preserve deeply nested unknown fields', () => {
  const codec = createJsonCodec({ kind: 'object', fields: [] })
  const nested = `${'['.repeat(depth)}1${']'.repeat(depth)}`
  const document = parseJson(`{"extra":${nested}}`, codec)
  assert.ok(document.value !== null && typeof document.value === 'object')
  checkNested(Reflect.get(document.value, 'extra'), 'array')
  assert.equal(json(document.value, codec).source, `{"extra":${'['.repeat(depth)}1e0${']'.repeat(depth)}}`)
})

test('non-finite PostgreSQL decimals cannot become JSON objects', () => {
  const codec = createJsonCodec({ kind: 'generic' })
  for (const value of [decimal('NaN'), decimal('Infinity'), decimal('-Infinity')]) {
    assert.throws(() => encodeJsonParameter(value), /Invalid JSON number/)
    assert.throws(() => json(value, codec), /Invalid JSON number/)
  }
  const numericCodec = createJsonCodec({
    kind: 'scalar',
    type: { pgType: 'numeric', pgTypeName: 'numeric', pgTypeSchema: 'pg_catalog', pgTypeKind: 'base', pgTypeOid: 0 },
  })
  const decoded = parseJson('"NaN"', numericCodec).value
  assert.throws(() => json(decoded, codec), /Invalid JSON number/)
  assert.equal(json({ kind: 'nan' }).source, '{"kind":"nan"}')
  assert.equal(json({ kind: 'infinity', negative: false }).source, '{"kind":"infinity","negative":false}')
})

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  checkConstraintTypeKey,
  intersectJsonShapes,
  joinJsonShapes,
  unionJsonShapes,
  type TypedSqlPostgresIrJsonShape,
} from '../src/analyzer-ir-model.js'

function stringLiteral(value: string, nullable = false): TypedSqlPostgresIrJsonShape {
  return { kind: 'stringLiteral', nullable, value }
}

function objectShape(
  fields: readonly (readonly [name: string, shape: TypedSqlPostgresIrJsonShape])[],
  nullable = false
): TypedSqlPostgresIrJsonShape {
  return {
    fields: fields.map(([name, shape]) => ({ name, shape })),
    kind: 'object',
    nullable,
  }
}

test('keys commutative literal refinements independently of branch order', () => {
  const left = {
    kind: 'union',
    members: [
      { kind: 'literalUnion', labels: ['ready', 'pending'] },
      { kind: 'literalUnion', labels: ['failed'] },
    ],
  } as const
  const right = {
    kind: 'union',
    members: [
      { kind: 'literalUnion', labels: ['failed'] },
      { kind: 'literalUnion', labels: ['pending', 'ready'] },
    ],
  } as const

  assert.equal(checkConstraintTypeKey(left), checkConstraintTypeKey(right))
})

test('joins JSON alternatives by value shape while keeping SQL nullability at the boundary', () => {
  const ordered = objectShape([
    ['state', stringLiteral('ready')],
    ['kind', stringLiteral('video')],
  ])
  const reordered = objectShape([
    ['kind', stringLiteral('video')],
    ['state', stringLiteral('ready')],
  ])

  const equivalent = joinJsonShapes([ordered, reordered], ordered)
  assert.equal(equivalent.kind, 'object')
  assert.deepEqual(equivalent.kind === 'object' ? equivalent.fields.map((field) => field.name) : [], ['state', 'kind'])

  const nullable = joinJsonShapes([ordered, null], ordered)
  assert.equal(nullable.kind, 'object')
  assert.equal(nullable.nullable, true)

  assert.deepEqual(joinJsonShapes([ordered, { kind: 'opaque', nullable: false }], ordered), {
    kind: 'opaque',
    nullable: false,
  })
})

test('normalizes set-operation alternative nullability instead of leaking it into nested members', () => {
  const left: TypedSqlPostgresIrJsonShape = {
    alternatives: [stringLiteral('left', true), stringLiteral('shared')],
    kind: 'union',
    nullable: true,
  }
  const right = stringLiteral('shared')

  const union = unionJsonShapes(left, right)
  assert.equal(union.kind, 'union')
  assert.equal(union.nullable, true)
  if (union.kind === 'union') {
    assert.deepEqual(
      union.alternatives.map((alternative) => alternative.nullable),
      [false, false]
    )
  }

  const intersection = intersectJsonShapes(left, right)
  assert.equal(intersection.nullable, false)
  if (intersection.kind === 'union') {
    assert.deepEqual(
      intersection.alternatives.map((alternative) => alternative.nullable),
      [false, false]
    )
  }

  assert.deepEqual(intersectJsonShapes({ kind: 'opaque', nullable: true }, right), right)
})

test('does not collapse unresolved scalar types that have distinct canonical names', () => {
  const scalar = (pgType: string): TypedSqlPostgresIrJsonShape => ({
    kind: 'scalar',
    nullable: false,
    pgType,
    pgTypeKind: 'unknown',
    pgTypeName: 'unknown',
    pgTypeOid: 0,
    pgTypeSchema: 'unknown',
  })

  const joined = unionJsonShapes(scalar('first_type'), scalar('second_type'))
  assert.equal(joined.kind, 'union')
  assert.equal(joined.kind === 'union' ? joined.alternatives.length : 0, 2)
})

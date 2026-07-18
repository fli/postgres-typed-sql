import assert from 'node:assert/strict'
import test from 'node:test'

import {
  checkConstraintTypeKey,
  intersectJsonShapes,
  joinJsonShapes,
  resultNullabilityAllowsNull,
  unionJsonShapes,
  type TypedSqlPostgresIrJsonShape,
} from '../src/analyzer-ir-model.js'

const textType = {
  pgType: 'text',
  pgTypeKind: 'base',
  pgTypeName: 'text',
  pgTypeOid: 25,
  pgTypeSchema: 'pg_catalog',
} as const

const nonNull = { basis: 'test', kind: 'nonNull' } as const
const nullable = { evidence: 'test', kind: 'nullable' } as const

function stringLiteral(
  value: string,
  allowsNull = false,
  type: Omit<
    Extract<TypedSqlPostgresIrJsonShape, { readonly kind: 'stringLiteral' }>,
    'kind' | 'nullability' | 'value'
  > = textType
): TypedSqlPostgresIrJsonShape {
  return { ...type, kind: 'stringLiteral', nullability: allowsNull ? nullable : nonNull, value }
}

function objectShape(
  fields: readonly (readonly [name: string, shape: TypedSqlPostgresIrJsonShape])[],
  allowsNull = false
): TypedSqlPostgresIrJsonShape {
  return {
    fields: fields.map(([name, shape]) => ({ name, shape })),
    kind: 'object',
    nullability: allowsNull ? nullable : nonNull,
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
  assert.equal(resultNullabilityAllowsNull(nullable.nullability), true)

  assert.deepEqual(joinJsonShapes([ordered, { kind: 'opaque', nullability: nonNull }], ordered), {
    kind: 'opaque',
    nullability: { basis: 'json_join', kind: 'nonNull' },
  })

  const differentBasis = objectShape([
    [
      'state',
      {
        ...stringLiteral('ready'),
        nullability: { basis: 'different_non_null_proof', kind: 'nonNull' },
      },
    ],
    ['kind', stringLiteral('video')],
  ])
  assert.equal(joinJsonShapes([ordered, differentBasis], ordered).kind, 'object')
})

test('normalizes set-operation alternative nullability instead of leaking it into nested members', () => {
  const left: TypedSqlPostgresIrJsonShape = {
    alternatives: [stringLiteral('left', true), stringLiteral('shared')],
    kind: 'union',
    nullability: nullable,
  }
  const right = stringLiteral('shared')

  const union = unionJsonShapes(left, right)
  assert.equal(union.kind, 'union')
  assert.equal(resultNullabilityAllowsNull(union.nullability), true)
  if (union.kind === 'union') {
    assert.deepEqual(
      union.alternatives.map((alternative) => alternative.nullability.kind),
      ['nonNull', 'nonNull']
    )
  }

  const intersection = intersectJsonShapes(left, right)
  assert.equal(resultNullabilityAllowsNull(intersection.nullability), false)
  if (intersection.kind === 'union') {
    assert.deepEqual(
      intersection.alternatives.map((alternative) => alternative.nullability.kind),
      ['nonNull', 'nonNull']
    )
  }

  assert.deepEqual(intersectJsonShapes({ kind: 'opaque', nullability: nullable }, right), {
    ...right,
    nullability: { basis: 'json_intersection', kind: 'nonNull' },
  })
})

test('does not collapse unresolved scalar types that have distinct canonical names', () => {
  const scalar = (pgType: string): TypedSqlPostgresIrJsonShape => ({
    kind: 'scalar',
    nullability: nonNull,
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

test('does not collapse equal JSON literals whose PostgreSQL types have different codec identities', () => {
  const left = stringLiteral('same')
  const right = stringLiteral('same', false, {
    pgType: 'audit.status',
    pgTypeKind: 'enum',
    pgTypeName: 'status',
    pgTypeOid: 84_001,
    pgTypeSchema: 'audit',
  })

  const joined = unionJsonShapes(left, right)
  assert.equal(joined.kind, 'union')
  assert.equal(joined.kind === 'union' ? joined.alternatives.length : 0, 2)
})

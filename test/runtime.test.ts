import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createTypedSqlStatement,
  executeTypedSqlOptional,
  typedSqlRowCount,
  type TypedSqlQueryConfig,
  type TypedSqlRawRow,
} from '../src/runtime.js'

type QueryConfigRow<T> = T extends TypedSqlQueryConfig<infer Row> ? Row : never
type IsExactly<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2 ? true : false

test('runtime binds named parameters in generated order', async () => {
  const statement = createTypedSqlStatement<{ readonly email: string }, { readonly email: string }>({
    cardinality: 'optional',
    command: 'select',
    name: 'findAccount',
    parameterNames: ['email'],
    text: 'select email from accounts where email = $1',
  })

  assert.deepEqual(statement.values({ email: 'reader@example.test' }), ['reader@example.test'])
  const rawQuery = statement.query({ email: 'reader@example.test' })
  const queryUsesRawRows: IsExactly<QueryConfigRow<typeof rawQuery>, TypedSqlRawRow> = true
  assert.equal(queryUsesRawRows, true)
  assert.deepEqual(rawQuery.values, ['reader@example.test'])
  const row = await executeTypedSqlOptional(
    {
      async query<Row>(config: TypedSqlQueryConfig<Row>) {
        assert.deepEqual(config.values, ['reader@example.test'])
        return {
          rowCount: 1,
          rows: [{ email: 'reader@example.test' }] as unknown as Row[],
        }
      },
    },
    statement,
    { email: 'reader@example.test' }
  )
  assert.deepEqual(row, { email: 'reader@example.test' })
})

test('runtime accepts only nonnegative safe integer row counts', () => {
  assert.equal(typedSqlRowCount(0), 0)
  assert.equal(typedSqlRowCount(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER)
  assert.equal(typedSqlRowCount(0n), 0)
  assert.equal(typedSqlRowCount(BigInt(Number.MAX_SAFE_INTEGER)), Number.MAX_SAFE_INTEGER)

  for (const invalid of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => typedSqlRowCount(invalid), /nonnegative safe integer/u)
  }
  assert.throws(() => typedSqlRowCount(-1n), /must be nonnegative/u)
  assert.throws(() => typedSqlRowCount(BigInt(Number.MAX_SAFE_INTEGER) + 1n), /exceeds Number\.MAX_SAFE_INTEGER/u)
  assert.throws(() => typedSqlRowCount(null), /expected the driver to expose an affected row count/u)
})

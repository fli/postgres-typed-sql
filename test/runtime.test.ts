import assert from 'node:assert/strict'
import test from 'node:test'

import { createTypedSqlStatement, executeTypedSqlOptional, type TypedSqlQueryConfig } from '../src/runtime.js'

test('runtime binds named parameters in generated order', async () => {
  const statement = createTypedSqlStatement<{ readonly email: string }, { readonly email: string }>({
    cardinality: 'optional',
    command: 'select',
    name: 'findAccount',
    parameterNames: ['email'],
    text: 'select email from accounts where email = $1',
  })

  assert.deepEqual(statement.values({ email: 'reader@example.test' }), ['reader@example.test'])
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

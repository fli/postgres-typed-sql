import assert from 'node:assert/strict'
import test from 'node:test'
import {
  nodePostgres,
  type NodePostgresTypedSqlClient,
  type NodePostgresTypedSqlQueryConfig,
  type NodePostgresTypedSqlQueryResult,
} from '../src/adapters/node-postgres.js'
import { createTypedSqlStatement, executeTypedSql, PgExecutionError } from '../src/runtime.js'
import type { PostgresTypeFact } from '../src/postgres-types.js'

const int8: PostgresTypeFact = {
  pgType: 'bigint',
  pgTypeName: 'int8',
  pgTypeKind: 'base',
  pgTypeOid: 20,
  pgTypeSchema: 'pg_catalog',
}
const statement = createTypedSqlStatement<{ id: bigint | number | string }, { value: bigint }, 'read', 'one'>({
  valueModel: 'postgres-lossless-v1',
  name: 'get',
  text: 'select $1::int8 as value',
  command: 'select',
  resultKind: 'one',
  rowBounds: { min: 1, max: 1, proof: 'constant' },
  parameterNames: ['id'],
  parameters: [
    {
      name: 'id',
      propertyName: 'id',
      nullable: false,
      type: int8,
      pgType: 'bigint',
      pgTypeName: 'int8',
      pgTypeSchema: 'pg_catalog',
    },
  ],
  columns: [
    {
      name: 'value',
      propertyName: 'value',
      nullable: false,
      type: int8,
      pgType: 'bigint',
      pgTypeName: 'int8',
      pgTypeSchema: 'pg_catalog',
      expressionSource: { kind: 'expression', tag: 'Param' },
    },
  ],
})

function result(
  rows: readonly unknown[],
  fields: NodePostgresTypedSqlQueryResult['fields'] = []
): NodePostgresTypedSqlQueryResult {
  return { rows, fields, rowCount: rows.length }
}
const field = { name: 'value', format: 'text' }

function clientWith(
  query: (
    config: NodePostgresTypedSqlQueryConfig,
    index: number
  ) => NodePostgresTypedSqlQueryResult | Promise<NodePostgresTypedSqlQueryResult>
) {
  const calls: NodePostgresTypedSqlQueryConfig[] = []
  const client: NodePostgresTypedSqlClient = {
    async query(config) {
      calls.push(config)
      return query(config, calls.length)
    },
  }
  return { client, calls }
}

function errorAt(phase: PgExecutionError['phase'], executionState: PgExecutionError['executionState']) {
  return (error: unknown) =>
    error instanceof PgExecutionError && error.phase === phase && error.executionState === executionState
}

test('uses query-local raw text parsing and releases a pool lease after exact decoding', async () => {
  const { client, calls } = clientWith(() => result([['9223372036854775807']], [field]))
  let released = 0
  const executor = nodePostgres({
    pool: {
      async connect() {
        return {
          ...client,
          release() {
            released++
          },
        }
      },
    },
  })
  assert.deepEqual(await executeTypedSql(executor, statement, { id: '9223372036854775807' }), {
    value: 9223372036854775807n,
  })
  assert.equal(released, 1)
  assert.equal(calls.length, 1)
  for (const call of calls) {
    assert.equal(call.rowMode, 'array')
    assert.equal(call.binary, false)
    assert.equal(call.types.getTypeParser(20, 'text')('9007199254740993'), '9007199254740993')
    assert.throws(() => call.types.getTypeParser(20, 'binary'))
  }
  assert.deepEqual(calls[0]?.values, ['9223372036854775807'])
})

test('rejects stale models and unsafe parameters before database I/O', async () => {
  const { client, calls } = clientWith(() => {
    throw new Error('unexpected query')
  })
  const executor = nodePostgres({ client })
  const stale = createTypedSqlStatement({ ...statement, valueModel: undefined })
  await assert.rejects(executeTypedSql(executor, stale, { id: 1n }), errorAt('contract', 'notExecuted'))
  await assert.rejects(
    executeTypedSql(executor, statement, { id: Number.MAX_SAFE_INTEGER + 1 }),
    errorAt('encode', 'notExecuted')
  )
  await assert.rejects(
    executeTypedSql(executor, statement, {
      id: {
        toPostgres() {
          throw new Error('must not run')
        },
      } as unknown as string,
    }),
    errorAt('encode', 'notExecuted')
  )
  assert.equal(calls.length, 0)
})

test('rejects binary fields, field names, and cardinality mismatches after execution without retry', async () => {
  for (const response of [
    result([['1']], [{ ...field, format: 'binary' }]),
    result([['1']], [{ ...field, name: 'other' }]),
    result([], []),
    result([], [field]),
  ]) {
    const { client, calls } = clientWith(() => response)
    await assert.rejects(
      executeTypedSql(nodePostgres({ client }), statement, { id: 1n }),
      errorAt('contract', 'mayHaveExecuted')
    )
    assert.equal(calls.length, 1)
  }
})

test('preserves a query error as cause and never retries it', async () => {
  const failure = new Error('query failed')
  const { client, calls } = clientWith(() => {
    throw failure
  })
  await assert.rejects(
    executeTypedSql(nodePostgres({ client }), statement, { id: 1n }),
    (error: unknown) =>
      errorAt('transport', 'mayHaveExecuted')(error) && error instanceof PgExecutionError && error.cause === failure
  )
  assert.equal(calls.length, 1)
})

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createTypedSqlExecutor,
  createTypedSqlStatement,
  executeTypedSql,
  type NodePostgresTypedSqlClient,
} from '../src/adapters/node-postgres.js'
import type { TypedSqlExecutionResult, TypedSqlResultKind, TypedSqlStatement } from '../src/runtime.js'

const row = { value: 7 }
const bounds = { min: 0, max: null, proof: 'test' } as const
const definition = { name: 'example', parameterNames: [], text: 'select 7 as value' } as const
const many = createTypedSqlStatement<Record<string, never>, typeof row, 'read', 'many'>({
  ...definition,
  resultKind: 'many',
  rowBounds: bounds,
})
const one = createTypedSqlStatement<Record<string, never>, typeof row, 'read', 'one'>({
  ...definition,
  resultKind: 'one',
  rowBounds: { min: 1, max: 1, proof: 'test' },
})
const optional = createTypedSqlStatement<Record<string, never>, typeof row, 'read', 'optional'>({
  ...definition,
  resultKind: 'optional',
  rowBounds: { min: 0, max: 1, proof: 'test' },
})
const command = createTypedSqlStatement<Record<string, never>, never, 'write', 'command'>({
  ...definition,
  resultKind: 'command',
  rowBounds: { min: 0, max: 0, proof: 'test' },
})
const noResult = createTypedSqlStatement<Record<string, never>, never, 'write', 'void'>({
  ...definition,
  resultKind: 'void',
  rowBounds: { min: 0, max: 0, proof: 'test' },
})

test('execution selects inferred results and uses the supplied client exactly once', async () => {
  let calls = 0
  const client: NodePostgresTypedSqlClient = {
    async query() {
      calls++
      return { rows: [row], rowCount: 1 }
    },
  }
  const manyResult: (typeof row)[] = await createTypedSqlExecutor(many)(client)
  const oneResult: typeof row = await createTypedSqlExecutor(one)(client, {})
  const optionalResult: typeof row | null = await createTypedSqlExecutor(optional)(client)
  assert.deepEqual([manyResult, oneResult, optionalResult], [[row], row, row])
  assert.equal(calls, 3)
  const empty: NodePostgresTypedSqlClient = {
    async query() {
      calls++
      return { rows: [], rowCount: 2 }
    },
  }
  const count: number = await createTypedSqlExecutor(command)(empty)
  const nothing: void = await createTypedSqlExecutor(noResult)(empty)
  assert.equal(count, 2)
  assert.equal(nothing, undefined)
  assert.equal(calls, 5)
  assert.equal(await createTypedSqlExecutor(optional)(empty), null)
})

test('execution enforces all proved row bounds and does not retry', async () => {
  let calls = 0
  const empty: NodePostgresTypedSqlClient = {
    async query() {
      calls++
      return { rows: [] }
    },
  }
  await assert.rejects(createTypedSqlExecutor(one)(empty), /rowBounds/u)
  const two: NodePostgresTypedSqlClient = {
    async query() {
      calls++
      return { rows: [row, row] }
    },
  }
  await assert.rejects(createTypedSqlExecutor(optional)(two), /rowBounds/u)
  const zero = createTypedSqlStatement<Record<string, never>, typeof row, 'read', 'many'>({
    ...definition,
    resultKind: 'many',
    rowBounds: { min: 0, max: 0, proof: 'empty' },
  })
  assert.deepEqual(await createTypedSqlExecutor(zero)(empty), [])
  await assert.rejects(createTypedSqlExecutor(zero)(two), /rowBounds/u)
  const bounded = createTypedSqlStatement<Record<string, never>, typeof row, 'read', 'many'>({
    ...definition,
    resultKind: 'many',
    rowBounds: { min: 2, max: 3, proof: 'bounded' },
  })
  await assert.rejects(createTypedSqlExecutor(bounded)(empty), /rowBounds/u)
  assert.deepEqual(await createTypedSqlExecutor(bounded)(two), [row, row])
  assert.equal(calls, 6)
})

test('command and void reject rows and only command requires a valid count', async () => {
  const client = (rows: readonly unknown[], rowCount?: number | null): NodePostgresTypedSqlClient => ({
    async query() {
      return { rows, rowCount }
    },
  })
  await assert.rejects(createTypedSqlExecutor(command)(client([row], 1)), /unexpected rows/u)
  await assert.rejects(createTypedSqlExecutor(noResult)(client([row], 1)), /unexpected rows/u)
  for (const count of [undefined, null, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(createTypedSqlExecutor(command)(client([], count)), /row count/u)
  }
  assert.equal(await createTypedSqlExecutor(command)(client([], 0)), 0)
  assert.equal(await createTypedSqlExecutor(noResult)(client([])), undefined)
})

test('stale and inconsistent metadata fail before executing SQL', async () => {
  let calls = 0
  const client: NodePostgresTypedSqlClient = {
    async query() {
      calls++
      return { rows: [] }
    },
  }
  for (const invalid of [
    { ...many, resultKind: undefined },
    { ...many, rowBounds: undefined },
    { ...many, resultKind: 'one' },
    { ...command, command: 'select' },
    { ...noResult, command: 'delete' },
    { ...command, columns: [{ name: 'unexpected' }] },
    { ...command, rowBounds: bounds },
    { ...many, rowBounds: { min: -1, max: null, proof: 'bad' } },
    { ...many, rowBounds: { min: 2, max: 1, proof: 'bad' } },
  ]) {
    // @ts-expect-error Stale JavaScript descriptors deliberately violate the current ABI.
    await assert.rejects(executeTypedSql(client, invalid, {}), /regenerate stale statements/u)
  }
  assert.equal(calls, 0)
})

test('descriptor result metadata is copied and frozen', () => {
  const mutableBounds = { min: 0, max: null, proof: 'test' }
  const statement = createTypedSqlStatement({ ...definition, resultKind: 'many', rowBounds: mutableBounds })
  mutableBounds.min = 2
  assert.equal(statement.rowBounds.min, 0)
  assert.equal(Object.isFrozen(statement), true)
  assert.equal(Object.isFrozen(statement.rowBounds), true)
})

test('required nullable parameters remain required and fail before querying when omitted', async () => {
  const statement = createTypedSqlStatement<{ value: string | null }, typeof row, 'read', 'many'>({
    ...definition,
    parameterNames: ['value'] satisfies 'value'[],
    resultKind: 'many',
    rowBounds: bounds,
  })
  const run = createTypedSqlExecutor(statement)
  let calls = 0
  const client: NodePostgresTypedSqlClient = {
    async query(config) {
      calls++
      assert.deepEqual(config.values, [null])
      return { rows: [] }
    },
  }
  await run(client, { value: null })
  assert.throws(() => {
    // @ts-expect-error Nullable does not permit omitting the parameter object.
    void run(client)
  }, /requires a parameter object/u)
  await assert.rejects(async () => {
    // @ts-expect-error Nullable does not permit omitting its required property.
    await run(client, {})
  }, /expected an own parameter property/u)
  await assert.rejects(async () => {
    // @ts-expect-error The shared executor cannot widen the inferred parameter contract.
    await executeTypedSql(client, statement, {})
  }, /expected an own parameter property/u)
  assert.equal(calls, 1)
})

function assertUnionType(value: TypedSqlExecutionResult<typeof row, TypedSqlResultKind>) {
  const honestUnion: typeof row | (typeof row)[] | number | null | void = value
  return honestUnion
}
void assertUnionType

test('binding captures the SQL text and parameter names used by the descriptor', () => {
  const source = {
    ...definition,
    text: 'select $1::text',
    parameterNames: ['value'] satisfies 'value'[],
    resultKind: 'many' as const,
    rowBounds: bounds,
  }
  const statement = createTypedSqlStatement<{ value: string }, typeof row>(source)
  source.text = 'delete from items'
  source.parameterNames.length = 0
  assert.equal(statement.text, 'select $1::text')
  assert.deepEqual(statement.query({ value: 'captured' }), { text: 'select $1::text', values: ['captured'] })
})

test('a widened statement descriptor preserves the complete inferred result union', async () => {
  const statement: TypedSqlStatement<Record<string, never>, typeof row> = many
  const client: NodePostgresTypedSqlClient = {
    async query() {
      return { rows: [row] }
    },
  }
  const result = await executeTypedSql(client, statement, {})
  type IsExactly<Left, Right> =
    (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2 ? true : false
  const completeUnion: IsExactly<typeof result, typeof row | (typeof row)[] | number | null | void> = true
  assert.equal(completeUnion, true)
  assert.deepEqual(result, [row])
})

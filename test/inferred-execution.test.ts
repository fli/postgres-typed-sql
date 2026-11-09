import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createPostgresExecutor,
  createTypedSqlExecutor,
  createTypedSqlStatement,
  executeTypedSql,
} from '../src/runtime.js'
import type { PostgresExecutionResponse } from '../src/runtime.js'
import type {
  TypedSqlExecutionResult,
  TypedSqlResultKind,
  TypedSqlStatement,
  TypedSqlParameterArgs,
} from '../src/runtime.js'

const row = { value: 7 }
const bounds = { min: 0, max: null, proof: 'test' } as const
const int4 = {
  pgType: 'integer',
  pgTypeName: 'int4',
  pgTypeSchema: 'pg_catalog',
  pgTypeKind: 'base',
  pgTypeOid: 23,
} as const
const textType = {
  pgType: 'text',
  pgTypeName: 'text',
  pgTypeSchema: 'pg_catalog',
  pgTypeKind: 'base',
  pgTypeOid: 25,
} as const
const valueColumn = {
  name: 'value',
  propertyName: 'value',
  nullable: false,
  type: int4,
  pgType: 'integer',
  pgTypeName: 'int4',
  pgTypeSchema: 'pg_catalog',
  expressionSource: { kind: 'expression', tag: 'Const' },
} as const
const definition = {
  valueModel: 'postgres-lossless-v1',
  columns: [valueColumn],
  name: 'example',
  parameterNames: [],
  text: 'select 7 as value',
} as const
const noOutput = { ...definition, columns: [] }
function executor(rows: PostgresExecutionResponse['rows'], rowCount?: number | null, columns = [int4]) {
  return createPostgresExecutor(async () => ({ rows, rowCount, columnTypes: columns }))
}
function hasError(pattern: RegExp) {
  return (error: unknown): boolean =>
    error instanceof Error && (pattern.test(error.message) || hasErrorCause(error.cause, pattern))
}
function hasErrorCause(error: unknown, pattern: RegExp): boolean {
  return error instanceof Error && (pattern.test(error.message) || hasErrorCause(error.cause, pattern))
}
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
  ...noOutput,
  resultKind: 'command',
  rowBounds: { min: 0, max: 0, proof: 'test' },
})
const noResult = createTypedSqlStatement<Record<string, never>, never, 'write', 'void'>({
  ...noOutput,
  resultKind: 'void',
  rowBounds: { min: 0, max: 0, proof: 'test' },
})

test('execution selects inferred results and uses the supplied executor exactly once', async () => {
  let calls = 0
  const client = createPostgresExecutor(async () => {
    calls++
    return { rows: [['7']], rowCount: 1, columnTypes: [int4] }
  })
  const manyResult: (typeof row)[] = await createTypedSqlExecutor(many)(client)
  const oneResult: typeof row = await createTypedSqlExecutor(one)(client, {})
  const optionalResult: typeof row | null = await createTypedSqlExecutor(optional)(client)
  assert.deepEqual([manyResult, oneResult, optionalResult], [[row], row, row])
  assert.equal(calls, 3)
  const empty = createPostgresExecutor(async (request) => {
    calls++
    return { rows: [], rowCount: 2, columnTypes: request.columns.map((column) => column.type) }
  })
  const count: number = await createTypedSqlExecutor(command)(empty)
  const nothing: void = await createTypedSqlExecutor(noResult)(empty)
  assert.equal(count, 2)
  assert.equal(nothing, undefined)
  assert.equal(calls, 5)
  assert.equal(await createTypedSqlExecutor(optional)(empty), null)
})

test('execution enforces all proved row bounds and does not retry', async () => {
  let calls = 0
  const empty = createPostgresExecutor(async () => {
    calls++
    return { rows: [], columnTypes: [int4], rowCount: 0 }
  })
  const two = createPostgresExecutor(async () => {
    calls++
    return { rows: [['7'], ['7']], columnTypes: [int4], rowCount: 2 }
  })
  await assert.rejects(createTypedSqlExecutor(one)(empty), /rowBounds/u)
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
  const client = (rows: PostgresExecutionResponse['rows'], rowCount?: number | null) => executor(rows, rowCount, [])
  await assert.rejects(createTypedSqlExecutor(command)(client([[]], 1)), /unexpected rows/u)
  await assert.rejects(createTypedSqlExecutor(noResult)(client([[]], 1)), /unexpected rows/u)
  for (const count of [undefined, null, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(createTypedSqlExecutor(command)(client([], count)), /row count/u)
  }
  assert.equal(await createTypedSqlExecutor(command)(client([], 0)), 0)
  assert.equal(await createTypedSqlExecutor(noResult)(client([])), undefined)
})

test('stale and inconsistent metadata fail before executing SQL', async () => {
  let calls = 0
  const client = createPostgresExecutor(async () => {
    calls++
    return { rows: [], columnTypes: [], rowCount: 0 }
  })
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
    { ...many, valueModel: undefined },
    { ...many, resultRowMapping: undefined },
    { ...many, columns: [{ ...valueColumn, type: undefined }] },
  ]) {
    // @ts-expect-error Stale JavaScript descriptors deliberately violate the current ABI.
    await assert.rejects(executeTypedSql(client, invalid, {}), hasError(/regenerate/u))
  }
  assert.equal(calls, 0)
})

test('execution rejects an unverified legacy client before calling it', async () => {
  let calls = 0
  const legacyClient = {
    async query() {
      calls++
      return { rows: [] }
    },
  }
  // @ts-expect-error Driver clients must be wrapped in a verified transport adapter.
  await assert.rejects(executeTypedSql(legacyClient, many, {}), hasError(/verified postgres-lossless-v1 executor/u))
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

test('DML without output columns rejects row results before querying', async () => {
  let calls = 0
  const client = createPostgresExecutor(async () => {
    calls++
    return { rows: [], columnTypes: [], rowCount: 3 }
  })
  for (const command of ['delete', 'insert', 'update', 'merge'] as const) {
    for (const [resultKind, rowBounds] of [
      ['many', { min: 0, max: 0, proof: 'empty' }],
      ['many', bounds],
      ['one', { min: 1, max: 1, proof: 'one' }],
      ['optional', { min: 0, max: 1, proof: 'optional' }],
    ] as const) {
      const invalidDefinition = { ...noOutput, command, resultKind, rowBounds }
      const invalid = { ...many, ...invalidDefinition, resultRowMapping: 'positional' as const }
      assert.throws(
        () => createTypedSqlStatement<Record<string, never>, typeof row>(invalidDefinition),
        /contradictory command\/result metadata/u
      )
      await assert.rejects(executeTypedSql(client, invalid, {}), hasError(/contradictory command\/result metadata/u))
    }
  }
  assert.equal(calls, 0)
})

test('output column validation preserves empty returning and zero-column results', async () => {
  const empty = createPostgresExecutor(async (request) => ({
    rows: [],
    rowCount: 0,
    columnTypes: request.columns.map((column) => column.type),
  }))
  for (const command of ['delete', 'insert', 'update', 'merge'] as const) {
    const affected = createTypedSqlStatement<Record<string, never>, never>({
      ...noOutput,
      command,
      resultKind: 'command',
      rowBounds: { min: 0, max: 0, proof: 'command' },
    })
    assert.equal(await createTypedSqlExecutor(affected)(empty), 0)
    const returning = createTypedSqlStatement<Record<string, never>, typeof row>({
      ...definition,
      command,
      resultKind: 'many',
      rowBounds: { min: 0, max: 0, proof: 'empty' },
    })
    assert.deepEqual(await createTypedSqlExecutor(returning)(empty), [])
  }
  const zeroColumns = createTypedSqlStatement<Record<string, never>, Record<string, never>>({
    ...noOutput,
    command: 'select',
    resultKind: 'many',
    rowBounds: bounds,
  })
  assert.deepEqual(await createTypedSqlExecutor(zeroColumns)(executor([[]], 1, [])), [{}])
  const call = createTypedSqlStatement<Record<string, never>, never>({
    ...noOutput,
    command: 'unknown',
    resultKind: 'void',
    rowBounds: { min: 0, max: 0, proof: 'call' },
  })
  assert.equal(await createTypedSqlExecutor(call)(empty), undefined)
})

test('required nullable parameters remain required and fail before querying when omitted', async () => {
  const statement = createTypedSqlStatement<{ value: string | null }, typeof row, 'read', 'many'>({
    ...definition,
    parameterNames: ['value'],
    parameters: [
      {
        name: 'value',
        propertyName: 'value',
        nullable: true,
        type: textType,
        pgType: 'text',
        pgTypeName: 'text',
        pgTypeSchema: 'pg_catalog',
      },
    ],
    resultKind: 'many',
    rowBounds: bounds,
  })
  const run = createTypedSqlExecutor(statement)
  let calls = 0
  const client = createPostgresExecutor(async (request) => {
    calls++
    assert.deepEqual(request.values, [null])
    return { rows: [], columnTypes: [int4], rowCount: 0 }
  })
  await run(client, { value: null })
  // @ts-expect-error Nullable does not permit omitting the parameter object.
  await assert.rejects(run(client), hasError(/expected an own parameter property/u))
  // @ts-expect-error Nullable does not permit omitting its required property.
  await assert.rejects(run(client, {}), hasError(/expected an own parameter property/u))
  // @ts-expect-error The shared executor cannot widen the inferred parameter contract.
  await assert.rejects(executeTypedSql(client, statement, {}), hasError(/expected an own parameter property/u))
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
  const client = executor([['7']], 1)
  const result = await executeTypedSql(client, statement, {})
  type IsExactly<Left, Right> =
    (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2 ? true : false
  const completeUnion: IsExactly<typeof result, typeof row | (typeof row)[] | number | null | void> = true
  assert.equal(completeUnion, true)
  assert.deepEqual(result, [row])
})

test('only the canonical generated empty parameter type permits omitted arguments', () => {
  const canonical: [] extends TypedSqlParameterArgs<Record<string, never>> ? true : false = true
  const broad: [] extends TypedSqlParameterArgs<object> ? true : false = false
  const untyped: [] extends TypedSqlParameterArgs<ReturnType<typeof JSON.parse>> ? true : false = false
  const optional: [] extends TypedSqlParameterArgs<{ id?: number }> ? true : false = false
  const union: [] extends TypedSqlParameterArgs<Record<string, never> | { id: number }> ? true : false = false
  const nullable: [] extends TypedSqlParameterArgs<{ id: number | null }> ? true : false = false
  assert.deepEqual([canonical, broad, untyped, optional, union, nullable], [true, false, false, false, false, false])
})

function assertParameterVariance(statement: TypedSqlStatement<{ id: number }, typeof row>) {
  // @ts-expect-error A non-null parameter statement cannot be widened to accept SQL NULL.
  const widened: TypedSqlStatement<{ id: number | null }, typeof row> = statement
  void widened
}
void assertParameterVariance

import assert from 'node:assert/strict'
import test from 'node:test'

import type { PgFiniteDecimal, PgJson } from '../src/value-types.js'

import {
  createPostgresExecutor,
  createTypedSqlStatement,
  executeTypedSql,
  typedSqlRowCount,
  type TypedSqlColumnMetadata,
} from '../src/runtime.js'

const textType = {
  pgType: 'text',
  pgTypeName: 'text',
  pgTypeSchema: 'pg_catalog',
  pgTypeKind: 'base',
  pgTypeOid: 25,
} as const
const int4 = {
  pgType: 'integer',
  pgTypeName: 'int4',
  pgTypeSchema: 'pg_catalog',
  pgTypeKind: 'base',
  pgTypeOid: 23,
} as const
const jsonb = {
  pgType: 'jsonb',
  pgTypeName: 'jsonb',
  pgTypeSchema: 'pg_catalog',
  pgTypeKind: 'base',
  pgTypeOid: 3802,
} as const

type IsExactly<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2 ? true : false
type AssertTrue<Value extends true> = Value
type ExpressionSourceIsRequired = AssertTrue<
  IsExactly<
    Pick<TypedSqlColumnMetadata, 'expressionSource'>,
    Required<Pick<TypedSqlColumnMetadata, 'expressionSource'>>
  >
>
type ObsoleteSourceIsAbsent = AssertTrue<IsExactly<Extract<keyof TypedSqlColumnMetadata, 'source'>, never>>

const publicMetadataTypeAssertions: [ExpressionSourceIsRequired, ObsoleteSourceIsAbsent] = [true, true]

test('runtime binds named parameters in generated order', async () => {
  const statement = createTypedSqlStatement<{ readonly email: string }, { readonly email: string }, 'read', 'optional'>(
    {
      valueModel: 'postgres-lossless-v1',
      parameters: [
        {
          name: 'email',
          propertyName: 'email',
          nullable: false,
          type: textType,
          pgType: 'text',
          pgTypeName: 'text',
          pgTypeSchema: 'pg_catalog',
        },
      ],
      rowBounds: { min: 0, max: 1, proof: 'test' },
      resultKind: 'optional',
      columns: [
        {
          type: textType,
          expressionSource: { kind: 'expression', tag: 'OpExpr' },
          name: 'email',
          nullable: false,
          pgType: 'text',
          pgTypeName: 'text',
          pgTypeSchema: 'pg_catalog',
          propertyName: 'email',
        },
      ],
      command: 'select',
      name: 'findAccount',
      parameterNames: ['email'],
      text: 'select email from accounts where email = $1',
    }
  )

  assert.deepEqual(statement.values({ email: 'reader@example.test' }), ['reader@example.test'])
  assert.deepEqual(publicMetadataTypeAssertions, [true, true])
  assert.equal(Object.hasOwn(statement.columns[0] ?? {}, 'source'), false)
  const rawQuery = statement.query({ email: 'reader@example.test' })
  const secondRawQuery = statement.query({ email: 'reader@example.test' })
  assert.notEqual(rawQuery.values, secondRawQuery.values)
  assert.equal(Object.hasOwn(statement, 'type'), false)
  assert.equal(Object.hasOwn(rawQuery, 'type'), false)
  assert.equal(Object.hasOwn(rawQuery, 'name'), false)
  assert.deepEqual(rawQuery.values, ['reader@example.test'])
  rawQuery.values.push('mutable-driver-value')
  assert.deepEqual(rawQuery.values, ['reader@example.test', 'mutable-driver-value'])

  // @ts-expect-error A direct query config cannot claim the generated result row type.
  void rawQuery.type
  const explicitPreparedName: string | undefined = rawQuery.name
  void explicitPreparedName
  // @ts-expect-error Driver query options belong to adapters, not the core query config.
  void rawQuery.rowMode

  const row = await executeTypedSql(
    createPostgresExecutor(async (request) => {
      assert.deepEqual(request.values, ['reader@example.test'])
      assert.equal(Object.hasOwn(request, 'name'), false)
      return { rowCount: 1, rows: [['reader@example.test']] }
    }),
    statement,
    { email: 'reader@example.test' }
  )
  const helperUsesDeclaredRow: IsExactly<typeof row, { readonly email: string } | null> = true
  assert.equal(helperUsesDeclaredRow, true)
  assert.deepEqual(row, { email: 'reader@example.test' })
})

test('runtime looks up public parameter properties independently of raw SQL metadata names', () => {
  const statement = createTypedSqlStatement<{ readonly platformSlug: string }, Record<string, never>, 'read', 'many'>({
    rowBounds: { min: 0, max: null, proof: 'test' },
    resultKind: 'many',
    name: 'findPlatform',
    parameterNames: ['platformSlug'],
    parameters: [
      {
        name: 'platform_slug',
        nullable: false,
        pgType: 'text',
        pgTypeName: 'text',
        pgTypeSchema: 'pg_catalog',
        propertyName: 'platformSlug',
      },
    ],
    text: 'select $1::text',
  })

  assert.deepEqual(statement.values({ platformSlug: 'web' }), ['web'])
  assert.deepEqual(
    statement.values({ platformSlug: null } as unknown as { readonly platformSlug: string }),
    [null],
    'the runtime binder does not duplicate the generated TypeScript null contract'
  )
  assert.throws(
    () => statement.values({ platform_slug: 'web' } as unknown as { readonly platformSlug: string }),
    /expected an own parameter property "platformSlug"/u
  )
})

test('runtime passes encoded parameters and returns affected row counts', async () => {
  const statement = createTypedSqlStatement<{ readonly id: number }, Record<string, never>, 'write', 'command'>({
    valueModel: 'postgres-lossless-v1',
    columns: [],
    parameters: [
      {
        name: 'id',
        propertyName: 'id',
        nullable: false,
        type: int4,
        pgType: 'integer',
        pgTypeName: 'int4',
        pgTypeSchema: 'pg_catalog',
      },
    ],
    rowBounds: { min: 0, max: 0, proof: 'test' },
    resultKind: 'command',
    command: 'delete',
    name: 'deleteAccount',
    parameterNames: ['id'],
    text: 'delete from accounts where id = $1',
  })
  const affected = await executeTypedSql(
    createPostgresExecutor(async (request) => {
      assert.equal(request.text, 'delete from accounts where id = $1')
      assert.deepEqual(request.values, ['42'])
      assert.deepEqual(request.columnNames, [])
      return { rowCount: 1, rows: [] }
    }),
    statement,
    { id: 42 }
  )
  assert.equal(affected, 1)
})

test('human statement names do not appear in transport requests', async () => {
  const make = (text: string) =>
    createTypedSqlStatement<Record<string, never>, Record<string, never>, 'read', 'many'>({
      valueModel: 'postgres-lossless-v1',
      columns: [],
      rowBounds: { min: 0, max: null, proof: 'test' },
      resultKind: 'many',
      name: 'findById',
      parameterNames: [],
      text,
    })
  const requests: string[] = []
  const executor = createPostgresExecutor(async (request) => {
    assert.equal(Object.hasOwn(request, 'name'), false)
    requests.push(request.text)
    return { rows: [], rowCount: 0 }
  })
  await executeTypedSql(executor, make('select 1'), {})
  await executeTypedSql(executor, make('select 2'), {})
  assert.deepEqual(requests, ['select 1', 'select 2'])
})

test('execution rejects legacy object-row descriptors before transport', async () => {
  const statement = createTypedSqlStatement<Record<string, never>, { readonly value: number }, 'read', 'many'>({
    valueModel: 'postgres-lossless-v1',
    rowBounds: { min: 0, max: null, proof: 'test' },
    resultKind: 'many',
    name: 'objectRows',
    parameterNames: [],
    text: 'select 1 as value',
  })
  let calls = 0
  const executor = createPostgresExecutor(async () => {
    calls++
    return { rows: [], rowCount: 0 }
  })
  await assert.rejects(
    executeTypedSql(executor, statement, {}),
    (error: unknown) =>
      error instanceof Error && error.cause instanceof Error && /incomplete metadata/u.test(error.cause.message)
  )
  assert.equal(calls, 0)
})

test('runtime maps duplicate SQL aliases by position', async () => {
  const column = {
    name: 'value',
    nullable: false,
    type: int4,
    pgType: 'integer',
    pgTypeName: 'int4',
    pgTypeSchema: 'pg_catalog',
    expressionSource: { kind: 'expression', tag: 'Const' },
  } as const
  const statement = createTypedSqlStatement<Record<string, never>, { first: number; second: number }, 'read', 'one'>({
    valueModel: 'postgres-lossless-v1',
    columns: [
      { ...column, propertyName: 'first' },
      { ...column, propertyName: 'second' },
    ],
    rowBounds: { min: 1, max: 1, proof: 'test' },
    resultKind: 'one',
    name: 'duplicates',
    parameterNames: [],
    text: 'select 1 as value, 2 as value',
  })
  const result = await executeTypedSql(
    createPostgresExecutor(async () => ({ rows: [['1', '2']], rowCount: 1 })),
    statement,
    {}
  )
  assert.deepEqual(result, { first: 1, second: 2 })
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

test('runtime reads only own parameter properties, including __proto__', () => {
  const statement = createTypedSqlStatement<{ readonly __proto__: string }, Record<string, never>, 'read', 'many'>({
    rowBounds: { min: 0, max: null, proof: 'test' },
    resultKind: 'many',
    name: 'prototypeParameter',
    parameterNames: ['__proto__'],
    text: 'select $1::text',
  })

  assert.deepEqual(statement.values({ ['__proto__']: 'preserved' }), ['preserved'])
  const unsafeLiteral: { readonly __proto__: string } = { __proto__: 'lost' }
  assert.throws(() => statement.values(unsafeLiteral), /expected an own parameter property "__proto__"/u)
  assert.throws(
    () => statement.values({} as { readonly __proto__: string }),
    /expected an own parameter property "__proto__"/u
  )
})

test('runtime preserves an exact __proto__ output property from array rows without changing the row prototype', async () => {
  const statement = createTypedSqlStatement<Record<string, never>, { readonly __proto__: string }, 'read', 'optional'>({
    rowBounds: { min: 0, max: 1, proof: 'test' },
    resultKind: 'optional',
    columns: [
      {
        type: textType,
        expressionSource: { kind: 'expression', tag: 'OpExpr' },
        name: '__proto__',
        nullable: false,
        pgType: 'text',
        pgTypeName: 'text',
        pgTypeSchema: 'pg_catalog',
        propertyName: '__proto__',
      },
    ],
    valueModel: 'postgres-lossless-v1',
    name: 'prototypeProperty',
    parameterNames: [],
    text: 'select value as "__proto__"',
  })

  const executed = await executeTypedSql(
    createPostgresExecutor(async () => ({ rows: [['executed']], rowCount: 1 })),
    statement,
    {}
  )
  assert.ok(executed)
  assert.equal(Object.hasOwn(executed, '__proto__'), true)
  assert.equal(executed.__proto__, 'executed')
})

test('runtime maps zero-column array rows to empty row objects', async () => {
  const statement = createTypedSqlStatement<Record<string, never>, Record<string, never>, 'read', 'many'>({
    rowBounds: { min: 0, max: null, proof: 'test' },
    resultKind: 'many',
    columns: [],
    command: 'select',
    valueModel: 'postgres-lossless-v1',
    name: 'emptyRows',
    parameterNames: [],
    text: 'select from generate_series(1, 2)',
  })

  assert.equal(statement.resultRowMapping, 'positional')
  assert.deepEqual(
    await executeTypedSql(
      createPostgresExecutor(async () => ({ rows: [[], []], rowCount: 2 })),
      statement,
      {}
    ),
    [{}, {}]
  )
})

test('runtime execution applies generated nested JSON mappings to positional rows', async () => {
  const statement = createTypedSqlStatement<
    Record<string, never>,
    {
      readonly accountRows: PgJson<
        readonly {
          readonly accountId: PgFiniteDecimal
          readonly displayName: string
        }[]
      >
    },
    'read',
    'many'
  >({
    valueModel: 'postgres-lossless-v1',
    rowBounds: { min: 0, max: null, proof: 'test' },
    resultKind: 'many',
    columns: [
      {
        expressionSource: { kind: 'expression', tag: 'SubLink' },
        type: jsonb,
        jsonPlan: {
          kind: 'array',
          element: {
            kind: 'object',
            fields: [
              { name: 'account_id', propertyName: 'accountId', plan: { kind: 'number' } },
              { name: 'display_name', propertyName: 'displayName', plan: { kind: 'string' } },
            ],
          },
        },
        name: 'account_rows',
        nullable: false,
        pgType: 'jsonb',
        pgTypeName: 'jsonb',
        pgTypeSchema: 'pg_catalog',
        propertyName: 'accountRows',
      },
    ],
    name: 'nestedRows',
    parameterNames: [],
    text: 'select account_rows',
  })

  const rows = await executeTypedSql(
    createPostgresExecutor(async () => ({
      rows: [['[{"account_id":1,"display_name":"Reader"}]']],
      rowCount: 1,
    })),
    statement,
    {}
  )

  assert.equal(rows[0]?.accountRows.kind, 'json')
  assert.equal(rows[0]?.accountRows.source, '[{"account_id":1,"display_name":"Reader"}]')
  assert.deepEqual(rows[0]?.accountRows.value, [
    {
      accountId: { kind: 'finite', coefficient: 1n, exponent: 0n, negative: false },
      displayName: 'Reader',
    },
  ])
})

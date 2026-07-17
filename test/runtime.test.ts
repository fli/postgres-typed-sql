import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createTypedSqlStatement,
  executeTypedSql,
  executeTypedSqlOptional,
  mapTypedSqlJsonValue,
  mapTypedSqlRow,
  typedSqlRowCount,
  type TypedSqlClient,
  type TypedSqlQueryConfig,
  type TypedSqlRawRow,
  type TypedSqlStatement,
} from '../src/runtime.js'

type IsExactly<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2 ? true : false

test('runtime binds named parameters in generated order', async () => {
  const statement = createTypedSqlStatement<{ readonly email: string }, { readonly email: string }>({
    cardinality: 'optional',
    columns: [
      {
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
  })

  assert.deepEqual(statement.values({ email: 'reader@example.test' }), ['reader@example.test'])
  const rawQuery = statement.query({ email: 'reader@example.test' })
  const secondRawQuery = statement.query({ email: 'reader@example.test' })
  assert.notEqual(rawQuery.values, secondRawQuery.values)
  assert.equal(Object.hasOwn(statement, 'type'), false)
  assert.equal(Object.hasOwn(rawQuery, 'type'), false)
  assert.deepEqual(rawQuery.values, ['reader@example.test'])
  rawQuery.values.push('mutable-driver-value')
  assert.deepEqual(rawQuery.values, ['reader@example.test', 'mutable-driver-value'])

  // @ts-expect-error A direct query config cannot claim the generated result row type.
  void rawQuery.type

  const directClient: TypedSqlClient = {
    async query() {
      return { rows: [] }
    },
  }
  const directResult = directClient.query(rawQuery)
  type DirectRow = Awaited<typeof directResult>['rows'][number]
  void directResult
  const directUsesUnknownValuedRows: IsExactly<DirectRow, TypedSqlRawRow> = true
  assert.equal(directUsesUnknownValuedRows, true)

  const row = await executeTypedSqlOptional(
    {
      async query<Row>(config: TypedSqlQueryConfig) {
        assert.deepEqual(config.values, ['reader@example.test'])
        assert.equal(config.rowMode, 'array')
        return {
          rowCount: 1,
          rows: [['reader@example.test']] as unknown as Row[],
        }
      },
    },
    statement,
    { email: 'reader@example.test' }
  )
  const helperUsesDeclaredRow: IsExactly<typeof row, { readonly email: string } | null> = true
  assert.equal(helperUsesDeclaredRow, true)
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

test('runtime reads only own parameter properties, including __proto__', () => {
  const statement = createTypedSqlStatement<{ readonly __proto__: string }, Record<string, never>>({
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
  const statement = createTypedSqlStatement<Record<string, never>, { readonly __proto__: string }>({
    columns: [
      {
        name: '__proto__',
        nullable: false,
        pgType: 'text',
        pgTypeName: 'text',
        pgTypeSchema: 'pg_catalog',
        propertyName: '__proto__',
      },
    ],
    name: 'prototypeProperty',
    parameterNames: [],
    text: 'select value as "__proto__"',
  })

  const mapped = mapTypedSqlRow(statement, ['preserved'])
  assert.equal(Object.getPrototypeOf(mapped), Object.prototype)
  assert.equal(Object.hasOwn(mapped, '__proto__'), true)
  assert.equal(mapped.__proto__, 'preserved')
  assert.deepEqual(Object.keys(mapped), ['__proto__'])

  const executed = await executeTypedSqlOptional(
    {
      async query<Row>(config: TypedSqlQueryConfig) {
        assert.equal(config.rowMode, 'array')
        return { rows: [['executed']] as unknown as Row[] }
      },
    },
    statement,
    {}
  )
  assert.ok(executed)
  assert.equal(Object.hasOwn(executed, '__proto__'), true)
  assert.equal(executed.__proto__, 'executed')
})

test('runtime maps zero-column array rows to empty row objects', async () => {
  const statement = createTypedSqlStatement<Record<string, never>, Record<string, never>>({
    cardinality: 'many',
    columns: [],
    command: 'select',
    name: 'emptyRows',
    parameterNames: [],
    text: 'select from generate_series(1, 2)',
  })

  assert.deepEqual(mapTypedSqlRow(statement, []), {})
  assert.equal(statement.resultRowMode, 'array')
  const legacyObjectRow = { preserved: true }
  assert.equal(mapTypedSqlRow(statement, legacyObjectRow), legacyObjectRow)
  assert.deepEqual(
    await executeTypedSql(
      {
        async query<Row>(config: TypedSqlQueryConfig) {
          assert.equal(config.rowMode, 'array')
          return { rows: [[], []] as unknown as Row[] }
        },
      },
      statement,
      {}
    ),
    [{}, {}]
  )
})

test('runtime preserves object rows when result-column metadata is omitted', async () => {
  const statement = createTypedSqlStatement<Record<string, never>, { readonly value: number }>({
    name: 'customObjectRows',
    parameterNames: [],
    text: 'select 1 as value',
  })

  assert.deepEqual(statement.columns, [])
  assert.equal(statement.resultRowMode, undefined)
  const rows = await executeTypedSql(
    {
      async query<Row>(config: TypedSqlQueryConfig) {
        assert.equal(config.rowMode, undefined)
        return { rows: [{ value: 1 }] as unknown as Row[] }
      },
    },
    statement,
    {}
  )
  assert.deepEqual(rows, [{ value: 1 }])
})

test('runtime public statement contract preserves legacy custom object-row mapping', async () => {
  interface CustomRow {
    readonly camelValue: number
  }

  const customStatement: TypedSqlStatement<Record<string, never>, CustomRow> = {
    access: 'read',
    cardinality: 'many',
    columns: [
      {
        name: 'camel_value',
        nullable: false,
        pgType: 'integer',
        pgTypeName: 'int4',
        pgTypeSchema: 'pg_catalog',
        propertyName: 'camelValue',
      },
    ],
    command: 'select',
    name: 'structurallyCompatibleCustomStatement',
    parameterNames: [],
    parameters: [],
    query: (): TypedSqlQueryConfig => ({ text: 'select 1 as camel_value', values: [] }),
    rowBounds: { max: null, min: 0, proof: 'custom' },
    text: 'select 1 as camel_value',
    values: () => [],
  }

  assert.equal(customStatement.resultRowMode, undefined)
  assert.deepEqual(
    await executeTypedSql(
      {
        async query<Row>(config: TypedSqlQueryConfig) {
          assert.equal(config.rowMode, undefined)
          return { rows: [{ camel_value: 1 }] as unknown as Row[] }
        },
      },
      customStatement,
      {}
    ),
    [{ camelValue: 1 }]
  )
})

test('runtime maps nested structured JSON while preserving opaque values and unknown fields', () => {
  const opaquePayload = {
    event_type: 'account.created',
    external_account_id: 'external-1',
  }
  const mapped = mapTypedSqlJsonValue(
    {
      fields: [
        {
          name: 'account_id',
          propertyName: 'accountId',
        },
        {
          mapping: {
            arrayElement: {
              fields: [
                {
                  name: 'post_id',
                  propertyName: 'postId',
                },
              ],
            },
          },
          name: 'recent_posts',
          propertyName: 'recentPosts',
        },
        {
          name: 'webhook_payload',
          propertyName: 'webhookPayload',
        },
      ],
    },
    {
      account_id: 'account-1',
      extra_field: true,
      recent_posts: [{ post_id: 'post-1' }, null],
      webhook_payload: opaquePayload,
    }
  )

  assert.deepEqual(mapped, {
    accountId: 'account-1',
    extra_field: true,
    recentPosts: [{ postId: 'post-1' }, null],
    webhookPayload: opaquePayload,
  })
  assert.equal((mapped as { readonly webhookPayload: unknown }).webhookPayload, opaquePayload)
})

test('runtime mapping treats an opaque union field as an identity-preserving traversal barrier', () => {
  const opaque = { inner_key: 1, innerKey: 2 }
  const mapped = mapTypedSqlJsonValue(
    { fields: [{ name: 'payload_data', propertyName: 'payloadData' }] },
    { payload_data: opaque }
  ) as { readonly payloadData: unknown }

  assert.equal(mapped.payloadData, opaque)
  assert.deepEqual(mapped.payloadData, { inner_key: 1, innerKey: 2 })
})

test('runtime execution applies generated nested JSON mappings to positional rows', async () => {
  const statement = createTypedSqlStatement<
    Record<string, never>,
    {
      readonly accountRows: readonly {
        readonly accountId: number
        readonly displayName: string
      }[]
    }
  >({
    columns: [
      {
        jsonMapping: {
          arrayElement: {
            fields: [
              {
                name: 'account_id',
                propertyName: 'accountId',
              },
              {
                name: 'display_name',
                propertyName: 'displayName',
              },
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
    {
      async query<Row>() {
        return {
          rows: [
            [
              [
                {
                  account_id: 1,
                  display_name: 'Reader',
                },
              ],
            ],
          ] as unknown as Row[],
        }
      },
    },
    statement,
    {}
  )

  assert.deepEqual(rows, [
    {
      accountRows: [
        {
          accountId: 1,
          displayName: 'Reader',
        },
      ],
    },
  ])
})

test('runtime maps prototype-sensitive nested JSON properties safely', () => {
  const source = JSON.parse('{"__proto__":{"constructor":"preserved"}}') as unknown
  const mapped = mapTypedSqlJsonValue(
    {
      fields: [
        {
          mapping: {
            fields: [
              {
                name: 'constructor',
                propertyName: 'constructorValue',
              },
            ],
          },
          name: '__proto__',
          propertyName: '__proto__',
        },
      ],
    },
    source
  ) as { readonly __proto__: { readonly constructorValue: string } }

  assert.equal(Object.getPrototypeOf(mapped), Object.prototype)
  assert.equal(Object.hasOwn(mapped, '__proto__'), true)
  assert.equal(mapped.__proto__.constructorValue, 'preserved')
})

test('runtime rejects nested JSON properties that collide after mapping', () => {
  assert.throws(
    () =>
      mapTypedSqlJsonValue(
        {
          fields: [
            {
              name: 'foo_bar',
              propertyName: 'fooBar',
            },
          ],
        },
        {
          foo_bar: 1,
          fooBar: 2,
        }
      ),
    /JSON fields collide at mapped property "fooBar"/u
  )
})

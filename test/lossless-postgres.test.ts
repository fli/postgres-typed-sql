import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import { Client, Pool } from 'pg'
import ts from 'typescript'

import { nodePostgres } from '../src/adapters/node-postgres.js'
import { createTypedSqlStatement, executeTypedSql, PgExecutionError, type TypedSqlStatement } from '../src/runtime.js'
import { parseJson, json, formatDecimal } from '../src/values.js'
import type { PgArray, PgDate, PgDecimal, PgJson, PgRawValue, PgTimestampTz } from '../src/values.js'
import { createMinimalFixture, generateFixture } from './generator-test-support.js'

const connectionString = process.env.POSTGRES_TYPED_SQL_TEST_URL
const options =
  '-c extra_float_digits=3 -c TimeZone=UTC -c DateStyle=ISO,YMD -c IntervalStyle=postgres -c bytea_output=hex'

interface RoundTripRow {
  readonly id: bigint
  readonly amount: PgDecimal
  readonly happenedAt: PgTimestampTz
  readonly payload: PgJson
  readonly items: PgArray<string | null>
  readonly profile: PgJson<{
    readonly accountId: bigint
    readonly birthday: PgDate
    readonly amount: PgDecimal
    readonly happenedAt: PgTimestampTz
    readonly status: 'active' | 'archived'
    readonly oid: number
  }>
  readonly missing: null
  readonly explicitNull: PgJson<null>
  readonly grid: PgArray<bigint | null>
  readonly location: PgRawValue
}

test(
  'generated statements round-trip exact values through real node-postgres',
  { skip: !connectionString },
  async () => {
    const client = new Client({ connectionString, options })
    await client.connect()
    const schema = `lossless_${randomUUID().replaceAll('-', '')}`
    const schemaSql = `create schema ${schema}; create type ${schema}.numeric as enum ('active', 'archived');`
    const sql = `select :id::bigint as id, :amount::numeric as amount,
    :happened_at::timestamptz as happened_at, :payload::json as payload,
    :items::text[] as items,
    jsonb_build_object('account_id', :id::bigint, 'birthday', :birthday::date,
      'amount', :amount::numeric, 'happened_at', :happened_at::timestamptz,
      'status', :status::${schema}.numeric, 'oid', 42::oid) as profile,
    null::json as missing, 'null'::json as explicit_null,
    '[0:1][-2:-1]={{1,NULL},{2,3}}'::bigint[] as grid, point(1,2) as location`
    const root = await createMinimalFixture(schemaSql, sql)
    try {
      await client.query(schemaSql)
      await generateFixture(root, {
        imports: { runtime: new URL('../src/runtime.js', import.meta.url).href, scalars: 'postgres-typed-sql/values' },
        naming: { resultColumns: 'camelCase', structuredJsonFields: 'camelCase' },
      })
      const source = await readFile(join(root, 'queries/query.typed-sql.ts'), 'utf8')
      assert.match(source, /readonly accountId: bigint/u)
      assert.match(source, /readonly birthday: PgDate/u)
      assert.doesNotMatch(source, /"pgTypeOid":(?!0\b)\d+/u)
      const moduleFile = join(root, 'round-trip.mjs')
      await writeFile(
        moduleFile,
        ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText
      )
      const generated = (await import(pathToFileURL(moduleFile).href)) as {
        readonly query: TypedSqlStatement<object, RoundTripRow, 'read', 'one'>
      }
      const prepared = {
        ...generated.query,
        query(params: object) {
          return { ...generated.query.query(params), name: `typed_sql_${schema}` }
        },
      }
      const payload = parseJson(' {"n":9007199254740993,"n":-0,"fraction":12.3400} ')
      const items = ['\u00a0NULL', '\u2003', 'foo\u2028', 'NULL', null]
      const params = {
        id: '9007199254740993',
        amount: '12345678901234567890.123400',
        happenedAt: '2026-11-09T10:20:30.123456+10:30',
        payload,
        items,
        birthday: '1990-06-15',
        status: 'active',
      }
      const row = await executeTypedSql(nodePostgres({ client }), prepared, params)
      assert.equal(row.id, 9007199254740993n)
      assert.equal(formatDecimal(row.amount), '12345678901234567890123400e-6')
      assert.equal(row.payload.source, payload.source)
      assert.deepEqual(row.items.values, items)
      assert.deepEqual(row.items.dimensions, [{ lowerBound: 1, length: items.length }])
      assert.equal(row.profile.value.accountId, row.id)
      assert.equal(formatDecimal(row.profile.value.amount), formatDecimal(row.amount))
      assert.deepEqual(row.profile.value.birthday, { kind: 'finite', year: 1990, month: 6, day: 15 })
      assert.deepEqual(row.profile.value.happenedAt, row.happenedAt)
      assert.equal(row.profile.value.status, 'active')
      assert.equal(row.profile.value.oid, 42)
      assert.equal(row.missing, null)
      assert.equal(row.explicitNull.value, null)
      assert.deepEqual(row.grid, {
        dimensions: [
          { lowerBound: 0, length: 2 },
          { lowerBound: -2, length: 2 },
        ],
        values: [1n, null, 2n, 3n],
      })
      assert.deepEqual(row.location, {
        kind: 'raw',
        type: { schema: 'pg_catalog', name: 'point' },
        source: { format: 'text', value: '(1,2)' },
      })
      const preparedNames = await client.query<{ readonly name: string }>(
        'select name from pg_prepared_statements where name = $1',
        [`typed_sql_${schema}`]
      )
      assert.equal(preparedNames.rowCount, 1)
      const revised = json({ ...row.profile.value, amount: row.amount }, row.profile.codec)
      const echoed = await executeTypedSql(nodePostgres({ client }), prepared, { ...params, payload: revised })
      assert.match(echoed.payload.source, /"account_id":9007199254740993/u)
      assert.match(echoed.payload.source, /"birthday":"1990-06-15"/u)
      assert.match(echoed.payload.source, /"oid":"42"/u)
      assert.ok(Object.isFrozen(row.profile.value))
      assert.equal(Object.getOwnPropertySymbols(row.profile.value).length, 0)
      const deepSource = '['.repeat(6000) + '9007199254740993' + ']'.repeat(6000)
      const deepRow = await executeTypedSql(nodePostgres({ client }), prepared, {
        ...params,
        payload: parseJson(deepSource),
      })
      assert.equal(deepRow.payload.source, deepSource)
    } finally {
      await client.query(`drop schema if exists ${schema} cascade`)
      await client.end()
      await rm(root, { recursive: true, force: true })
    }
  }
)

test(
  'node-postgres pool execution keeps transaction policy outside the adapter',
  { skip: !connectionString },
  async () => {
    const pool = new Pool({ connectionString, options, max: 1 })
    const statement = createTypedSqlStatement<Record<string, never>, Record<string, never>, 'read', 'one'>({
      valueModel: 'postgres-lossless-v1',
      access: 'read',
      resultKind: 'one',
      columns: [],
      parameters: [],
      command: 'select',
      name: 'zeroColumns',
      parameterNames: [],
      rowBounds: { min: 1, max: 1, proof: 'constant' },
      text: 'select',
    })
    try {
      const client = await pool.connect()
      try {
        await client.query('begin')
        await client.query('set local extra_float_digits = 0')
        await assert.rejects(
          executeTypedSql(nodePostgres({ client }), statement, {}),
          (error) => error instanceof PgExecutionError && error.executionState === 'notExecuted'
        )
        await client.query('rollback')
      } finally {
        client.release()
      }
      assert.deepEqual(await executeTypedSql(nodePostgres({ pool }), statement, {}), {})
      assert.equal(pool.idleCount, 1)
    } finally {
      await pool.end()
    }
  }
)

test(
  'real database errors retain SQLSTATE, original cause and execution uncertainty',
  { skip: !connectionString },
  async () => {
    const pool = new Pool({ connectionString, options, max: 1 })
    const statement = createTypedSqlStatement<Record<string, never>, { readonly value: number }, 'read', 'one'>({
      valueModel: 'postgres-lossless-v1',
      access: 'read',
      resultKind: 'one',
      parameters: [],
      command: 'select',
      name: 'divisionByZero',
      parameterNames: [],
      rowBounds: { min: 1, max: 1, proof: 'constant' },
      text: 'select 1/0 as value',
      columns: [
        {
          name: 'value',
          propertyName: 'value',
          nullable: false,
          expressionSource: { kind: 'expression', tag: 'OpExpr' },
          pgType: 'integer',
          pgTypeName: 'int4',
          pgTypeSchema: 'pg_catalog',
          type: { pgType: 'integer', pgTypeName: 'int4', pgTypeSchema: 'pg_catalog', pgTypeKind: 'base', pgTypeOid: 0 },
        },
      ],
    })
    try {
      await assert.rejects(
        executeTypedSql(nodePostgres({ pool }), statement, {}),
        (error) =>
          error instanceof PgExecutionError &&
          error.code === '22012' &&
          error.cause instanceof Error &&
          error.executionState === 'mayHaveExecuted' &&
          'code' in error.cause &&
          error.cause.code === '22012'
      )
    } finally {
      await pool.end()
    }
  }
)

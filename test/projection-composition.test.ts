import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, rm, symlink, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import ts from 'typescript'
import { Client } from 'pg'

import { resolveConfig } from '../src/config.js'
import { createAnalysisDatabase } from '../src/engine.js'
import { analyzeTypedSqlSource, generateTypedSql } from '../src/generator.js'
import type { PostgresExecutor } from '../src/runtime.js'
import type { PgJson, PgJsonCodec, PgJsonValue, PgTimestampTz } from '../src/values.js'
import { createMinimalFixture } from './generator-test-support.js'

const connectionString = process.env.POSTGRES_TYPED_SQL_TEST_URL
const packageRoot = fileURLToPath(new URL('../../', import.meta.url))

async function load<Module>(root: string, name: string): Promise<Module> {
  const source = await readFile(join(root, `queries/${name}.typed-sql.ts`), 'utf8')
  const path = join(root, `${name}.mjs`)
  await writeFile(path, ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText)
  return import(pathToFileURL(path).href)
}

function checkTypes(path: string): void {
  const options = {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    module: ts.ModuleKind.NodeNext,
    target: ts.ScriptTarget.ES2023,
    types: [],
  }
  const host = ts.createCompilerHost(options)
  const diagnostics = ts.getPreEmitDiagnostics(ts.createProgram([path], options, host))
  assert.equal(ts.formatDiagnosticsWithColorAndContext(diagnostics, host), '')
}

test('modifying projections compose with standalone JSON rows and generated fixture codecs', async (t) => {
  const schema = `composition_${randomUUID().replaceAll('-', '')}`
  const fields = `id, state, phase, payload, optional_payload, binding_token,
    jsonb_build_object('native_count', 7::int4, 'precise', 9007199254740993::int8) as typed_details,
    happened_at`
  const schemaSql = `create schema ${schema};
    create type ${schema}.state as enum ('open','closed');
    create table ${schema}.item(id bigint primary key, state ${schema}.state not null,
      phase text not null check (phase in ('quoted','settled')),
      payload jsonb not null, optional_payload jsonb, binding_token bytea not null, happened_at timestamptz not null, touches int not null);
    insert into ${schema}.item values(9007199254740993,'open','quoted','{"n":9007199254740993}',null,
      decode('00ff','hex'),'2026-11-15T01:02:03.123456Z',0);
    create function ${schema}.outcome(mode text) returns jsonb language plpgsql as $$
    declare projected record; value jsonb;
    begin
      if mode='sql-null' then return null; end if;
      if mode='json-null' then return 'null'; end if;
      select ${fields} into projected from ${schema}.item limit 1;
      value := to_jsonb(projected);
      if mode='bad' then value := jsonb_set(value,'{typed_details,native_count}','"wrong"'); end if;
      if mode='bad-check' then value := jsonb_set(value,'{phase}','"corrupted"'); end if;
      return jsonb_build_object('kind','ready','item',value);
    end $$;`
  const callSql = `select ${schema}.outcome(:mode::text) as result`
  const root = await createMinimalFixture(schemaSql, callSql)
  t.after(() => rm(root, { recursive: true, force: true }))
  const projectionSql = `with changed as (
    update ${schema}.item set touches=touches+1 where id=:id::bigint returning *
  ) select ${fields} from changed`
  const projectionPath = join(root, 'queries/projected.typed.sql')
  await writeFile(projectionPath, projectionSql)
  const options = {
    rootDir: root,
    schema: 'schema.sql',
    include: ['queries'],
    naming: { resultColumns: 'camelCase', structuredJsonFields: 'preserve' },
    jsonbFunctionContracts: [
      {
        schema,
        name: 'outcome',
        argumentTypes: ['text'],
        allowJsonNull: true,
        variants: { unavailable: {}, ready: { item: { projection: 'queries/projected.typed.sql' } } },
      },
    ],
  } as const
  const analysisDatabase = await createAnalysisDatabase({ schemaFiles: [join(root, 'schema.sql')] })
  try {
    await analyzeTypedSqlSource({
      sourcePath: join(root, 'queries/query.typed.sql'),
      content: callSql,
      config: resolveConfig(options),
      database: analysisDatabase,
    })
    assert.deepEqual((await analysisDatabase.query(`select touches from ${schema}.item`)).rows, [{ touches: 0 }])
  } finally {
    await analysisDatabase.close()
  }
  const generated = await generateTypedSql(options, { analysis: true })
  assert.ok(generated.analysis.inputs.some((input) => input.path === projectionPath))
  assert.equal(generated.analysis.statements.find((entry) => entry.export === 'projected')?.access, 'write')
  await mkdir(join(root, 'node_modules'))
  await symlink(packageRoot, join(root, 'node_modules/postgres-typed-sql'), 'dir')
  const consume = join(root, 'consume.mts')
  await writeFile(
    consume,
    `
import { json } from 'postgres-typed-sql/values'
import { query, type QueryRow } from './queries/query.typed-sql.js'
import { projected, type ProjectedRow } from './queries/projected.typed-sql.js'
declare const result: QueryRow['result']
declare function consume(row: ProjectedRow): void
if (result?.value?.kind === 'ready') {
  consume(result.value.item)
  const native: number = result.value.item.typedDetails.value.native_count
  const precise: bigint = result.value.item.typedDetails.value.precise
  json(result.value, query.jsonCodecs.result)
}
const fixture = json({ native_count: 7, precise: 9007199254740993n }, projected.jsonCodecs.typedDetails)
const native: number = fixture.value.native_count
// @ts-expect-error Generated int4 JSON values require native numbers.
json({ native_count: '7', precise: 1n }, projected.jsonCodecs.typedDetails)
// @ts-expect-error Non-JSON columns have no JSON codec.
projected.jsonCodecs.id
// @ts-expect-error Generic JSON numbers are decimals, not inferred int4 numbers.
const wrong: ProjectedRow['typedDetails'] = json({ native_count: 7, precise: 1n })
// @ts-expect-error A fixture codec describes JSON content, not SQL NULL.
json(null, projected.jsonCodecs.typedDetails)
`
  )
  checkTypes(consume)

  type Details = { readonly native_count: number; readonly precise: bigint }
  interface Projected {
    readonly id: bigint
    readonly state: 'open' | 'closed'
    readonly phase: 'quoted' | 'settled'
    readonly payload: PgJson
    readonly optionalPayload: PgJson | null
    readonly bindingToken: Uint8Array
    readonly typedDetails: PgJson<Details>
    readonly happenedAt: PgTimestampTz
  }
  type Outcome = { readonly kind: 'unavailable' } | { readonly kind: 'ready'; readonly item: Projected } | null
  const { query, default: run } = await load<{
    query: { jsonCodecs: { result: PgJsonCodec<Outcome> } }
    default: (db: PostgresExecutor, params: { mode: string }) => Promise<{ result: PgJson<Outcome> | null }>
  }>(root, 'query')
  const { projected, default: update } = await load<{
    projected: { jsonCodecs: { typedDetails: PgJsonCodec<Details>; payload: PgJsonCodec<PgJsonValue> } }
    default: (db: PostgresExecutor, params: { id: bigint }) => Promise<Projected | null>
  }>(root, 'projected')
  const values: typeof import('../src/values.js') = await import(new URL('../../dist/values.js', import.meta.url).href)
  const fixture = values.json({ native_count: 7, precise: 9007199254740993n }, projected.jsonCodecs.typedDetails)
  assert.equal(fixture.value.native_count, 7)
  assert.equal(fixture.value.precise, 9007199254740993n)
  assert.deepEqual(values.parseJson(fixture.source, fixture.codec).value, fixture.value)
  assert.throws(() => values.parseJson('{"native_count":2147483648,"precise":1}', fixture.codec))
  assert.throws(() => values.parseJson('{"native_count":1.5,"precise":1}', fixture.codec))

  await t.test(
    'real PostgreSQL composes documents and sends one query per generated read and write',
    { skip: !connectionString },
    async () => {
      const adapter: typeof import('../src/adapters/node-postgres.js') = await import(
        new URL('../../dist/adapters/node-postgres.js', import.meta.url).href
      )
      const client = new Client({
        connectionString,
        options:
          '-c extra_float_digits=3 -c TimeZone=UTC -c DateStyle=ISO,YMD -c IntervalStyle=postgres -c bytea_output=hex',
      })
      await client.connect()
      try {
        await client.query(schemaSql)
        let queries = 0
        const db = adapter.nodePostgres({
          client: {
            query(config) {
              queries++
              return client.query(config)
            },
          },
        })
        const result = await run(db, { mode: 'ready' })
        assert.equal(queries, 1)
        assert.ok(result.result?.value?.kind === 'ready')
        const item = result.result.value.item
        assert.equal(item.id, 9007199254740993n)
        assert.equal(item.typedDetails.value.native_count, 7)
        assert.equal(item.typedDetails.value.precise, 9007199254740993n)
        assert.deepEqual(item.payload.value, { n: values.jsonNumber('9007199254740993') })
        assert.equal(item.optionalPayload, null)
        assert.deepEqual(item.bindingToken, new Uint8Array([0, 255]))
        assert.deepEqual(item.happenedAt, { kind: 'finite', unixMicroseconds: 1794704523123456n })
        assert.deepEqual(values.json(result.result.value, query.jsonCodecs.result).value, result.result.value)
        assert.deepEqual(
          values.parseJson(item.typedDetails.source, item.typedDetails.codec).value,
          item.typedDetails.value
        )
        const row = await update(db, { id: item.id })
        assert.equal(queries, 2)
        assert.ok(row)
        assert.deepEqual(
          { ...row, payload: row.payload.value, typedDetails: row.typedDetails.value },
          { ...item, payload: item.payload.value, typedDetails: item.typedDetails.value }
        )
        assert.deepEqual(
          values.parseJson(row.typedDetails.source, row.typedDetails.codec).value,
          item.typedDetails.value
        )
        const originalSource = result.result.source
        item.bindingToken[0] = 1
        assert.notEqual(result.result.source, originalSource)
        assert.equal(result.result.source, values.json(result.result.value, result.result.codec).source)
        const changed = values.parseJson(result.result.source, result.result.codec).value
        assert.ok(changed?.kind === 'ready')
        assert.deepEqual(changed.item.bindingToken, new Uint8Array([1, 255]))
        item.bindingToken[0] = 0
        assert.equal(result.result.source, originalSource)
        assert.equal((await client.query(`select touches from ${schema}.item`)).rows[0]?.touches, 1)
        assert.equal((await run(db, { mode: 'sql-null' })).result, null)
        assert.equal((await run(db, { mode: 'json-null' })).result?.value, null)
        await assert.rejects(run(db, { mode: 'bad' }), { name: 'PgExecutionError', phase: 'decode' })
        await assert.rejects(run(db, { mode: 'bad-check' }), { name: 'PgExecutionError', phase: 'decode' })
      } finally {
        await client.query(`drop schema ${schema} cascade`)
        await client.end()
      }
    }
  )
})

import assert from 'node:assert/strict'
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import ts from 'typescript'
import { Client } from 'pg'

import { generateTypedSql } from '../src/generator.js'
import type { PgJsonParameter } from '../src/values.js'
import type { PostgresExecutor } from '../src/runtime.js'
import { createMinimalFixture, generateFixture } from './generator-test-support.js'

const connectionString = process.env.POSTGRES_TYPED_SQL_TEST_URL

test('direct nullable function inputs use caller permission and guarded INSERT uses proof', async (t) => {
  const schema = `nullable_${randomUUID().replaceAll('-', '')}`
  const schemaSql = `create schema ${schema};
    create table ${schema}.required(payload jsonb not null);
    create function ${schema}.input_kind(payload jsonb) returns text language plpgsql as $$begin
      if payload is null then return 'sql-null'; end if;
      if payload = 'null'::jsonb then return 'json-null'; end if;
      return 'value';
    end$$;`
  const direct = `select ${schema}.input_kind(:payload::jsonb) as value`
  const guarded = `insert into ${schema}.required select :payload::jsonb where :payload::jsonb is not null`
  const root = await createMinimalFixture(schemaSql, `-- @nullable payload\n${direct}`)
  t.after(() => rm(root, { recursive: true, force: true }))
  const queryPath = join(root, 'queries/query.typed.sql')
  await assert.rejects(generateFixture(root), /could not prove that every use accepts NULL/u)
  await writeFile(queryPath, `-- @bindNull payload\n${direct}`)
  await writeFile(join(root, 'queries/guarded.typed.sql'), `-- @nullable payload\n${guarded}`)
  await writeFile(join(root, 'queries/defaultInput.typed.sql'), direct)
  const config = { rootDir: root, schema: 'schema.sql', include: ['queries'] }
  const { analysis } = await generateTypedSql(config, { analysis: true })
  const param = (name: string) => analysis.statements.find((entry) => entry.export === name)?.parameters[0]
  assert.equal(param('query')?.nullBinding, 'callerNullable')
  assert.equal(param('query')?.nullAdmission, 'unknown')
  assert.equal(param('guarded')?.nullBinding, 'provedNullable')
  assert.equal(param('guarded')?.nullAdmission, 'accepts')
  assert.equal(param('defaultInput')?.nullBinding, 'nonNull')
  assert.ok(analysis.statements.every((entry) => !entry.sql.includes('materialized')))
  const generatedQuery = await readFile(join(root, 'queries/query.typed-sql.ts'), 'utf8')
  const generatedGuarded = await readFile(join(root, 'queries/guarded.typed-sql.ts'), 'utf8')
  const generatedDefault = await readFile(join(root, 'queries/defaultInput.typed-sql.ts'), 'utf8')
  for (const sql of [
    guarded.replace('is not null', 'is null'),
    `insert into ${schema}.required select :payload::jsonb`,
    `with input as materialized(select :payload::jsonb as payload)
      select ${schema}.input_kind(payload) from input`,
    `insert into ${schema}.required select jsonb_agg(:payload::jsonb) where :payload::jsonb is not null`,
    `with used as materialized(select ${schema}.input_kind(:payload::jsonb))
      insert into ${schema}.required select :payload::jsonb from used where :payload::jsonb is not null`,
  ]) {
    await writeFile(queryPath, `-- @nullable payload\n${sql}`)
    await assert.rejects(generateFixture(root), /@nullable payload cannot be satisfied/u, sql)
  }
  await mkdir(join(root, 'node_modules'))
  await symlink(fileURLToPath(new URL('../../', import.meta.url)), join(root, 'node_modules/postgres-typed-sql'), 'dir')
  async function load<Module>(name: string, source: string): Promise<Module> {
    const path = join(root, `${name}.mjs`)
    await writeFile(path, ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText)
    return import(pathToFileURL(path).href)
  }
  const { default: run } = await load<{
    default: (db: PostgresExecutor, params: { payload: PgJsonParameter | null }) => Promise<{ value: string | null }>
  }>('query', generatedQuery)
  const { default: insert } = await load<{
    default: (db: PostgresExecutor, params: { payload: PgJsonParameter | null }) => Promise<number>
  }>('guarded', generatedGuarded)
  const { default: nonNull } = await load<{ default: typeof run }>('default', generatedDefault)
  await t.test(
    'PostgreSQL distinguishes SQL NULL from a JSON null document in one query',
    { skip: !connectionString },
    async () => {
      const adapter: typeof import('../src/adapters/node-postgres.js') = await import(
        new URL('../../dist/adapters/node-postgres.js', import.meta.url).href
      )
      const values: typeof import('../src/values.js') = await import(
        new URL('../../dist/values.js', import.meta.url).href
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
        assert.deepEqual(await run(db, { payload: null }), { value: 'sql-null' })
        assert.equal(queries, 1)
        assert.deepEqual(await run(db, { payload: values.json(null) }), { value: 'json-null' })
        assert.equal(queries, 2)
        assert.equal(await insert(db, { payload: null }), 0)
        assert.equal(queries, 3)
        assert.equal(await insert(db, { payload: values.json(null) }), 1)
        assert.equal(queries, 4)
        await assert.rejects(nonNull(db, { payload: null }), {
          name: 'PgExecutionError',
          phase: 'encode',
          executionState: 'notExecuted',
        })
        assert.equal(queries, 4)
      } finally {
        await client.query(`drop schema ${schema} cascade`)
        await client.end()
      }
    }
  )
})

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import ts from 'typescript'
import { Client } from 'pg'

import { generateTypedSql } from '../src/generator.js'
import type { PgJson, PgJsonCodec } from '../src/values.js'
import type { PostgresExecutor } from '../src/runtime.js'
import { createMinimalFixture } from './generator-test-support.js'

const connectionString = process.env.POSTGRES_TYPED_SQL_TEST_URL

test('ordinary projection contracts validate scalar and SETOF JSONB overloads without tags', async (t) => {
  const schema = `objects_${randomUUID().replaceAll('-', '')}`
  const schemaSql = `create schema ${schema};
    create type ${schema}.state as enum ('open','closed');
    create function ${schema}.objects(mode text) returns setof jsonb language plpgsql as $$begin
      case mode
        when 'empty' then return;
        when 'sql-null' then return next null;
        when 'json-null' then return next 'null'::jsonb;
        when 'missing' then return next '{"id":1}';
        when 'bad-enum' then return next '{"id":1,"state":"wrong","label":null}';
        when 'bad-number' then return next '{"id":1.5,"state":"open","label":null}';
        when 'bad-root' then return next '[]'::jsonb;
        else
          return next '{"id":1,"state":"open","label":null}';
          return next '{"id":2,"state":"closed","label":"two"}';
      end case;
    end$$;
    create function ${schema}.objects(mode boolean) returns jsonb language sql as $$select '{"other":1}'::jsonb$$;
    create function ${schema}.scalar_object() returns jsonb language sql as $$select '{"id":3,"state":"open","label":null}'::jsonb$$;`
  const sql = `select result from lateral ${schema}.objects(:mode::text) as result`
  const root = await createMinimalFixture(schemaSql, sql)
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'projections'))
  const projection = 'projections/approval.typed.sql'
  await writeFile(join(root, projection), `select 1::int4 as id,'open'::${schema}.state as state,null::text as label`)
  await writeFile(join(root, 'queries/overload.typed.sql'), `select ${schema}.objects(true) as result`)
  await writeFile(join(root, 'queries/scalar.typed.sql'), `select ${schema}.scalar_object() as result`)
  await writeFile(
    join(root, 'queries/transformed.typed.sql'),
    `select result->'id' as result from ${schema}.objects('ready') as result`
  )
  await writeFile(
    join(root, 'queries/ordinal.typed.sql'),
    `select result, n from ${schema}.objects(:mode::text) with ordinality as row(result,n)`
  )
  await writeFile(
    join(root, 'queries/combined.typed.sql'),
    `select ${schema}.scalar_object() as result union all select '{"different":1}'::jsonb`
  )
  await generateTypedSql({
    rootDir: root,
    schema: 'schema.sql',
    include: ['queries'],
    jsonbFunctionContracts: [
      { schema, name: 'objects', argumentTypes: ['text'], returns: { projection }, allowJsonNull: true },
      {
        schema,
        name: 'scalar_object',
        argumentTypes: [],
        returns: { object: { id: 'int4', state: 'string', label: { nullable: 'string' } } },
      },
    ],
  })
  const source = await readFile(join(root, 'queries/query.typed-sql.ts'), 'utf8')
  assert.match(source, /readonly state: ["']open["'] \| ["']closed["']/u)
  assert.doesNotMatch(source, /readonly kind:/u)
  for (const name of ['overload', 'transformed', 'combined']) {
    const generated = await readFile(join(root, `queries/${name}.typed-sql.ts`), 'utf8')
    assert.match(generated, /readonly result: PgJson<PgJsonValue>/u, name)
    assert.doesNotMatch(generated, /readonly state:/u, name)
  }
  assert.match(
    await readFile(join(root, 'queries/ordinal.typed-sql.ts'), 'utf8'),
    /readonly state: ["']open["'] \| ["']closed["']/u
  )
  await mkdir(join(root, 'node_modules'))
  await symlink(fileURLToPath(new URL('../../', import.meta.url)), join(root, 'node_modules/postgres-typed-sql'), 'dir')
  const modulePath = join(root, 'query.mjs')
  await writeFile(
    modulePath,
    ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText
  )
  type Approval = { readonly id: number; readonly state: 'open' | 'closed'; readonly label: string | null }
  const { query, default: run } = (await import(pathToFileURL(modulePath).href)) as {
    query: { jsonCodecs: { result: PgJsonCodec<Approval | null> } }
    default: (db: PostgresExecutor, params: { mode: string }) => Promise<{ result: PgJson<Approval | null> | null }[]>
  }
  const values: typeof import('../src/values.js') = await import(new URL('../../dist/values.js', import.meta.url).href)
  const fixture = values.json({ id: 1, state: 'open', label: null }, query.jsonCodecs.result)
  assert.equal(fixture.value?.id, 1)
  for (const invalid of ['{}', '{"id":1,"state":"bad","label":null}', '{"id":1.5,"state":"open","label":null}'])
    assert.throws(() => values.parseJson(invalid, query.jsonCodecs.result), { name: 'TypeError' }, invalid)
  await t.test(
    'direct range results preserve empty, multiple, SQL-null and JSON-null rows',
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
        const rows = await run(db, { mode: 'ready' })
        assert.equal(queries, 1)
        assert.deepEqual(
          rows.map((row) => row.result?.value),
          [
            { id: 1, state: 'open', label: null },
            { id: 2, state: 'closed', label: 'two' },
          ]
        )
        assert.deepEqual(await run(db, { mode: 'empty' }), [])
        assert.deepEqual(await run(db, { mode: 'sql-null' }), [{ result: null }])
        const jsonNull = await run(db, { mode: 'json-null' })
        assert.ok(jsonNull[0]?.result)
        assert.equal(jsonNull[0].result.value, null)
        for (const mode of ['missing', 'bad-enum', 'bad-number', 'bad-root'])
          await assert.rejects(run(db, { mode }), { name: 'PgExecutionError', phase: 'decode' }, mode)
        assert.equal(queries, 8)
      } finally {
        await client.query(`drop schema ${schema} cascade`)
        await client.end()
      }
    }
  )
})

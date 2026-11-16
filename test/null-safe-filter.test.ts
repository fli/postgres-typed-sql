import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { Client } from 'pg'
import ts from 'typescript'

import type { PostgresExecutor } from '../src/runtime.js'

const connectionString = process.env.POSTGRES_TYPED_SQL_TEST_URL

test('public compiler proves strict nullable NULL-safe filters and generates a nullable API', async (t) => {
  const { openQueryProject }: typeof import('../src/query-project.js') = await import(
    new URL('../../dist/project.js', import.meta.url).href
  )
  const root = await mkdtemp(join(tmpdir(), 'typed-sql-null-safe-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const schema = `null_safe_${randomUUID().replaceAll('-', '')}`
  const schemaSql = `create schema ${schema};
    create table ${schema}.nullable_probe(id integer primary key, value text);
    create domain ${schema}.required_text as text not null;
    create function ${schema}.fail_on_null(value text) returns text language plpgsql as $$
      begin if value is null then raise exception 'null argument'; end if; return value; end $$;`
  await writeFile(join(root, 'schema.sql'), schemaSql)
  await writeFile(join(root, 'config.mjs'), "export default {schema: './schema.sql'}")
  const sourcePath = join(root, 'probe.typed.sql')
  const sql = `select id from ${schema}.nullable_probe where value is not distinct from :value::text order by id`
  const project = await openQueryProject(join(root, 'config.mjs'))
  t.after(() => project.close())
  const source = `-- @nullable value\n${sql}`
  const generated = await project.compile(sourcePath, source)
  const analysis = await project.analyze(sourcePath, source)
  assert.equal(analysis.parameters[0]?.nullBinding, 'provedNullable')
  assert.equal(analysis.parameters[0]?.nullAdmission, 'accepts')
  assert.equal(analysis.descriptor.parameters[0]?.nullable, true)
  assert.equal(analysis.descriptor.text, sql.replaceAll(':value', '$1'))
  assert.match(generated, /readonly value: string \| null/u)
  assert.equal(generated, await project.compile(sourcePath, `-- @bindNull value\n${sql}`))

  for (const predicate of [
    'value is distinct from :value::text',
    ':value::text is not distinct from value',
    '(value is not distinct from :value::text) and id > 0',
    '(value is not distinct from :value::text) or id = 1',
  ]) {
    await project.compile(sourcePath, `-- @nullable value\nselect id from ${schema}.nullable_probe where ${predicate}`)
  }
  for (const control of [
    `update ${schema}.nullable_probe set value = :value::text where id = 1 returning value`,
    `with changed as (update ${schema}.nullable_probe set value = :value::text where id = 1 returning value)
      select value from changed`,
    `with changed as (insert into ${schema}.nullable_probe values (1, :value::text) returning value)
      select value from changed`,
    'with input as (select :value::text as value) select value from input',
    `with input as (select :value::text as value, :other::integer as other) select id from ${schema}.nullable_probe cross join input where nullable_probe.value is not distinct from input.value`,
    `with input as (select :value::text as value, :other::text as other) select input.value, ${schema}.fail_on_null(input.other) from input`,
    `with input as (select :value::text as value) select id from ${schema}.nullable_probe cross join input where nullable_probe.value is not distinct from input.value`,
    `with input as (select :value::text as value), nested as (select value from input) select id from ${schema}.nullable_probe cross join nested where nullable_probe.value is not distinct from nested.value`,
  ]) {
    await project.compile(sourcePath, `-- @nullable value\n${control}`)
  }
  for (const predicate of [
    `value is not distinct from :value::${schema}.required_text`,
    `value is not distinct from ${schema}.fail_on_null(:value::text)`,
    `(value is not distinct from :value::text) and ${schema}.fail_on_null(:value::text) = 'present'`,
    `(value is not distinct from :value::text) or ${schema}.fail_on_null(:value::text) = 'present'`,
    `value is not distinct from coalesce(:value::text, ${schema}.fail_on_null(null))`,
  ]) {
    await assert.rejects(
      project.compile(sourcePath, `-- @nullable value\nselect id from ${schema}.nullable_probe where ${predicate}`),
      /@nullable value cannot be satisfied/u,
      predicate
    )
  }

  for (const sql of [
    `with input as (select :value::text as value) select id from ${schema}.nullable_probe left join input on true where nullable_probe.value is not distinct from input.value`,
    `with input as (select :value::text as value) select id from ${schema}.nullable_probe cross join input where nullable_probe.value is not distinct from input.value and ${schema}.fail_on_null(input.value) = 'present'`,
  ]) {
    await assert.rejects(project.compile(sourcePath, `-- @nullable value\n${sql}`), /@nullable value cannot be satisfied/u)
  }

  await mkdir(join(root, 'node_modules'))
  await symlink(fileURLToPath(new URL('../../', import.meta.url)), join(root, 'node_modules/postgres-typed-sql'), 'dir')
  await writeFile(join(root, 'package.json'), '{"type":"module"}')
  await writeFile(join(root, 'probe.ts'), generated)
  const consumer = join(root, 'consumer.ts')
  await writeFile(
    consumer,
    `import run, {type ProbeParams} from './probe.js'
     import type {PostgresExecutor} from 'postgres-typed-sql/runtime'
     const nil: ProbeParams = {value: null}
     const present: ProbeParams = {value: 'present'}
     declare const db: PostgresExecutor
     const rows: Promise<{readonly id: number}[]> = run(db, nil)
     run(db, present)
     // @ts-expect-error The parameter remains required.
     run(db, {})
     // @ts-expect-error The parameter remains text.
     run(db, {value: 42})
     // @ts-expect-error Undefined is not SQL NULL.
     run(db, {value: undefined})
     void rows`
  )
  const program = ts.createProgram([consumer], {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2022,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    types: [],
  })
  assert.deepEqual(
    ts
      .getPreEmitDiagnostics(program)
      .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')),
    []
  )

  await t.test(
    'generated executor returns NULL and non-NULL matches with one PostgreSQL query per call',
    { skip: !connectionString },
    async () => {
      const adapter: typeof import('../src/adapters/node-postgres.js') = await import(
        new URL('../../dist/adapters/node-postgres.js', import.meta.url).href
      )
      const modulePath = join(root, 'probe.mjs')
      await writeFile(
        modulePath,
        ts.transpileModule(generated, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText
      )
      const {
        default: run,
      }: {
        default: (db: PostgresExecutor, params: { value: string | null }) => Promise<{ id: number }[]>
      } = await import(pathToFileURL(modulePath).href)
      const client = new Client({ connectionString })
      await client.connect()
      try {
        await client.query('begin')
        await client.query(schemaSql)
        await client.query(`insert into ${schema}.nullable_probe values (1, null), (2, 'present')`)
        let queries = 0
        const db = adapter.nodePostgres({
          client: {
            query(config) {
              queries++
              return client.query(config)
            },
          },
        })
        assert.deepEqual(await run(db, { value: null }), [{ id: 1 }])
        assert.equal(queries, 1)
        assert.deepEqual(await run(db, { value: 'present' }), [{ id: 2 }])
        assert.equal(queries, 2)
        assert.deepEqual(await run(db, { value: 'absent' }), [])
        assert.equal(queries, 3)
      } finally {
        await client.query('rollback')
        await client.end()
      }
    }
  )
})

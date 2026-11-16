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

test('NULL admission composes through selected outputs and remains conservative for independent effects', async (t) => {
  const { openQueryProject }: typeof import('../src/query-project.js') = await import(
    new URL('../../dist/project.js', import.meta.url).href
  )
  const root = await mkdtemp(join(tmpdir(), 'typed-sql-composition-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const schema = `composition_${randomUUID().replaceAll('-', '')}`
  const schemaSql = `create schema ${schema};
    create table ${schema}.items(id integer primary key, value text, required text not null);
    create table ${schema}.checked(value text, guard boolean, constraint dependent_check check (guard or value is not null));
    create table ${schema}.modules(mode text not null, override text, constraint module_override_check check (mode <> 'custom' or override is not null));
    create function ${schema}.unsafe(value text) returns text language plpgsql as $$
      begin if value is null then raise exception 'null argument'; end if; return value; end $$;
    create function ${schema}.trigger_fn() returns trigger language plpgsql as $$
      begin return new; end $$;
    create table ${schema}.triggered(value text);
    create trigger value_trigger before insert on ${schema}.triggered
      for each row execute function ${schema}.trigger_fn();`
  await writeFile(join(root, 'schema.sql'), schemaSql)
  await writeFile(join(root, 'config.mjs'), "export default {schema: './schema.sql'}")
  const project = await openQueryProject(join(root, 'config.mjs'))
  t.after(() => project.close())
  const sourcePath = join(root, 'probe.typed.sql')
  const filters = [
    `with input as (select :value::text as value) select i.id from ${schema}.items i cross join input where i.value is not distinct from input.value order by i.id`,
    `with first as (select :value::text as value), second as (select value from first) select i.id from ${schema}.items i cross join second where i.value is not distinct from second.value order by i.id`,
    `with input as materialized (select :value::text as value) select i.id from ${schema}.items i cross join input where i.value is not distinct from input.value order by i.id`,
    `select i.id from ${schema}.items i cross join (select :value::text as value) input where i.value is not distinct from input.value order by i.id`,
  ]
  const nullableInsert = `insert into ${schema}.items(id, value, required) values (:id::integer, :value::text, 'required') returning id, value`
  const nullablePatch = `update ${schema}.items set value = case when :provided::boolean then :value::text else value end where id = :id::integer returning id, value`
  const requiredPatch = `update ${schema}.items set required = case when :provided::boolean then :value::text else required end where id = :id::integer returning id`

  for (const [index, sql] of filters.entries()) {
    await t.test(`selected output filter ${index + 1}`, async () => {
      const source = `-- @nullable value\n${sql}`
      const analysis = await project.analyze(sourcePath, source)
      assert.equal(analysis.parameters.find((parameter) => parameter.name === 'value')?.nullAdmission, 'accepts')
      const generated = await project.compile(sourcePath, source)
      assert.equal(generated, await project.compile(sourcePath, `-- @bindNull value\n${sql}`))
      assert.match(generated, /readonly value: string \| null/u)
    })
  }
  await t.test('independent unsafe callable remains unknown', async () => {
    const valid = `with input as (select :value::text as value)
      select i.id from ${schema}.items i cross join input
      where i.value is not distinct from input.value and ${schema}.unsafe(:value::text) = 'present'`
    const analysis = await project.analyze(sourcePath, `-- @bindNull value\n${valid}`)
    assert.equal(analysis.parameters.find((parameter) => parameter.name === 'value')?.nullAdmission, 'unknown')
    await assert.rejects(
      project.compile(sourcePath, `-- @nullable value\n${valid}`),
      /@nullable value cannot be satisfied/u
    )
  })
  await t.test('an opaque callable on another parameter does not taint the projected value', async () => {
    const sql = `with input as (select :value::text as value, ${schema}.unsafe(:other::text) as other)
      select i.id from ${schema}.items i cross join input
      where i.value is not distinct from input.value and input.other = 'present'`
    const analysis = await project.analyze(sourcePath, `-- @bindNull value\n-- @bindNull other\n${sql}`)
    assert.equal(analysis.parameters.find((parameter) => parameter.name === 'value')?.nullAdmission, 'accepts')
    assert.equal(analysis.parameters.find((parameter) => parameter.name === 'other')?.nullAdmission, 'unknown')
    await project.compile(sourcePath, `-- @nullable value\n-- @bindNull other\n${sql}`)
  })
  await t.test('selected sibling and nested callable preserve parameter independence', async () => {
    const sibling = `with input as (select :value::text value, :other::text other)
      select input.value, ${schema}.unsafe(input.other) from input`
    const analysis = await project.analyze(sourcePath, `-- @bindNull value\n-- @bindNull other\n${sibling}`)
    assert.equal(analysis.parameters.find((parameter) => parameter.name === 'value')?.nullAdmission, 'accepts')
    assert.equal(analysis.parameters.find((parameter) => parameter.name === 'other')?.nullAdmission, 'unknown')
    await project.compile(sourcePath, `-- @nullable value\n-- @bindNull other\n${sibling}`)
    const nested = `with first as (select :value::text value), second as (select value from first)
      select ${schema}.unsafe(value) from second`
    const nestedAnalysis = await project.analyze(sourcePath, `-- @bindNull value\n${nested}`)
    assert.equal(nestedAnalysis.parameters.find((parameter) => parameter.name === 'value')?.nullAdmission, 'unknown')
    await assert.rejects(
      project.compile(sourcePath, `-- @nullable value\n${nested}`),
      /@nullable value cannot be satisfied/u
    )
  })
  await t.test('module override CHECK depends on the companion mode', async () => {
    const sql = `insert into ${schema}.modules(mode, override) values (:mode::text, :override::text)`
    const analysis = await project.analyze(sourcePath, `-- @bindNull override\n${sql}`)
    assert.equal(analysis.parameters.find((parameter) => parameter.name === 'override')?.nullAdmission, 'unknown')
    await assert.rejects(
      project.compile(sourcePath, `-- @nullable override\n${sql}`),
      /@nullable override cannot be satisfied/u
    )
    await project.compile(sourcePath, `-- @bindNull override\n${sql}`)
  })
  await t.test('nullable insert and provided-flag patch', async () => {
    await project.compile(sourcePath, `-- @nullable value\n${nullableInsert}`)
    await project.compile(sourcePath, `-- @nullable value\n${nullablePatch}`)
    const analysis = await project.analyze(sourcePath, `-- @bindNull value\n${requiredPatch}`)
    assert.notEqual(analysis.parameters.find((parameter) => parameter.name === 'value')?.nullAdmission, 'accepts')
    await assert.rejects(
      project.compile(sourcePath, `-- @nullable value\n${requiredPatch}`),
      /@nullable value cannot be satisfied/u
    )
  })
  await t.test('dependent CHECK remains uncertain', async () => {
    const sql = `insert into ${schema}.checked(value, guard) values (:value::text, :guard::boolean)`
    const analysis = await project.analyze(sourcePath, `-- @bindNull value\n${sql}`)
    assert.notEqual(analysis.parameters.find((parameter) => parameter.name === 'value')?.nullAdmission, 'accepts')
    await assert.rejects(
      project.compile(sourcePath, `-- @nullable value\n${sql}`),
      /@nullable value cannot be satisfied/u
    )
  })
  await t.test('generated nullable parameters are required and typed', async () => {
    const generated = await project.compile(sourcePath, `-- @nullable value\n${filters[0]}`)
    await mkdir(join(root, 'node_modules'), { recursive: true })
    await symlink(
      fileURLToPath(new URL('../../', import.meta.url)),
      join(root, 'node_modules/postgres-typed-sql'),
      'dir'
    )
    await writeFile(join(root, 'package.json'), '{"type":"module"}')
    await writeFile(join(root, 'probe.ts'), generated)
    const consumer = join(root, 'consumer.ts')
    await writeFile(
      consumer,
      `import run from './probe.js'
      import type {PostgresExecutor} from 'postgres-typed-sql/runtime'
      declare const db: PostgresExecutor
      run(db, {value: null}); run(db, {value: 'present'})
      // @ts-expect-error value is required
      run(db, {})
      // @ts-expect-error undefined is not SQL NULL
      run(db, {value: undefined})
      // @ts-expect-error value is text
      run(db, {value: 42})`
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
  })
  await t.test(
    'generated calls preserve clear and omitted values with one query each',
    { skip: !connectionString },
    async () => {
      const adapter: typeof import('../src/adapters/node-postgres.js') = await import(
        new URL('../../dist/adapters/node-postgres.js', import.meta.url).href
      )
      async function load<Params, Result>(
        name: string,
        sql: string,
        directive = '-- @nullable value'
      ): Promise<(db: PostgresExecutor, params: Params) => Promise<Result>> {
        const generated = await project.compile(sourcePath, `${directive}\n${sql}`)
        const path = join(root, `${name}.mjs`)
        await writeFile(
          path,
          ts.transpileModule(generated, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText
        )
        const loaded: { default: (db: PostgresExecutor, params: Params) => Promise<Result> } = await import(
          pathToFileURL(path).href
        )
        return loaded.default
      }
      const filterSql = filters[0]
      assert.ok(filterSql)
      const filter = await load<{ value: string | null }, { id: number }[]>('filter', filterSql)
      const insert = await load<{ id: number; value: string | null }, unknown>('insert', nullableInsert)
      const patch = await load<{ id: number; value: string | null; provided: boolean }, unknown>('patch', nullablePatch)
      const moduleInsert = await load<{ mode: string; override: string | null }, unknown>(
        'module',
        `insert into ${schema}.modules(mode, override) values (:mode::text, :override::text)`,
        '-- @bindNull override'
      )
      const client = new Client({ connectionString })
      await client.connect()
      try {
        await client.query('begin')
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
        await insert(db, { id: 1, value: 'initial' })
        assert.equal(queries, 1)
        await patch(db, { id: 1, provided: false, value: null })
        assert.equal(queries, 2)
        assert.deepEqual(await filter(db, { value: 'initial' }), [{ id: 1 }])
        assert.equal(queries, 3)
        await patch(db, { id: 1, provided: true, value: null })
        assert.equal(queries, 4)
        assert.deepEqual(await filter(db, { value: null }), [{ id: 1 }])
        assert.equal(queries, 5)
        await moduleInsert(db, { mode: 'automatic', override: null })
        assert.equal(queries, 6)
        await client.query('savepoint invalid_module')
        await assert.rejects(moduleInsert(db, { mode: 'custom', override: null }), (error: unknown) => {
          assert.ok(error instanceof Error)
          assert.ok(error.cause instanceof Error)
          assert.match(error.cause.message, /module_override_check/u)
          return true
        })
        assert.equal(queries, 7)
        await client.query('rollback to savepoint invalid_module')
        await assert.rejects(
          client.query(
            `update ${schema}.items set required = case when $1::boolean then $2::text else required end where id = 1`,
            [true, null]
          ),
          /null value/u
        )
      } finally {
        await client.query('rollback')
        await client.end()
      }
    }
  )
})

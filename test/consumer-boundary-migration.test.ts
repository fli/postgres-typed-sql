import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { Client } from 'pg'
import ts from 'typescript'

import { generateTypedSql } from '../src/generator.js'
import type { PostgresExecutor } from '../src/runtime.js'
import type { PgInt8Input, PgJson } from '../src/values.js'
import { createMinimalFixture, generateFixture } from './generator-test-support.js'

const connectionString = process.env.POSTGRES_TYPED_SQL_TEST_URL
const packageRoot = fileURLToPath(new URL('../../', import.meta.url))

test('generated consumer boundary preserves nullable filters and integer projections', async (t) => {
  const schema = `boundary_${randomUUID().replaceAll('-', '')}`
  const schemaSql = `create schema ${schema};
    create table ${schema}.item(id bigint primary key, width int not null, body jsonb);
    create function ${schema}.input_kind(value int) returns text language plpgsql as $$begin
      if value is null then return 'null'; end if;
      return 'value';
    end$$;`
  const projection = `:id::bigint as id, :id::bigint::text as wire_id, :width::int as width,
    (select jsonb_build_object('id', x.id) from (values (1), (2)) x(id)
      where x.id = :filter::int limit 1) as result`
  const readSql = `-- @nullable filter\nselect ${projection}`
  const root = await createMinimalFixture(schemaSql, readSql)
  t.after(() => rm(root, { recursive: true, force: true }))
  const queryPath = join(root, 'queries/query.typed.sql')
  const writeSql = `-- @nullable filter
    insert into ${schema}.item(id, width) values (:id::bigint, :width::int)
    returning ${projection}`
  await writeFile(join(root, 'queries/insert.typed.sql'), writeSql)
  const { analysis } = await generateTypedSql(
    { rootDir: root, schema: 'schema.sql', include: ['queries'] },
    { analysis: true }
  )
  for (const name of ['query', 'insert']) {
    const filter = analysis.statements
      .find((entry) => entry.export === name)
      ?.parameters.find((param) => param.name === 'filter')
    assert.equal(filter?.nullBinding, 'provedNullable')
    assert.equal(filter?.nullAdmission, 'accepts')
  }

  await writeFile(queryPath, `-- @nullable value\nselect ${schema}.input_kind(:value::int)`)
  await assert.rejects(generateFixture(root), /could not prove that every use accepts NULL/u)
  await writeFile(queryPath, `-- @nullable width\ninsert into ${schema}.item(id, width) values (1, :width::int)`)
  await assert.rejects(generateFixture(root), /proves that one of its uses rejects NULL/u)
  await writeFile(queryPath, readSql)
  await generateFixture(root)

  await mkdir(join(root, 'node_modules'))
  await symlink(packageRoot, join(root, 'node_modules/postgres-typed-sql'), 'dir')
  const consume = join(root, 'consume.mts')
  await writeFile(
    consume,
    `
import { query, type QueryRow } from './queries/query.typed-sql.js'
import { insert, type InsertRow } from './queries/insert.typed-sql.js'
declare const read: QueryRow
declare const written: InsertRow
if (read.id !== null) { const id: bigint = read.id }
if (read.wire_id !== null) { const wireId: string = read.wire_id }
if (read.width !== null) { const width: number = read.width }
if (written.id !== null) { const writtenId: bigint = written.id }
query.query({ id: '9223372036854775807', width: 2147483647, filter: null })
insert.query({ id: '-9223372036854775808', width: -2147483648, filter: 1 })
`
  )
  const options = {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    module: ts.ModuleKind.NodeNext,
    target: ts.ScriptTarget.ES2023,
    types: [],
  }
  const host = ts.createCompilerHost(options)
  const diagnostics = ts.getPreEmitDiagnostics(ts.createProgram([consume], options, host))
  assert.equal(ts.formatDiagnosticsWithColorAndContext(diagnostics, host), '')

  type Params = { id: PgInt8Input; width: number; filter: number | null }
  type Row = { id: bigint; wire_id: string; width: number; result: PgJson | null }
  async function load<Result>(name: string): Promise<(db: PostgresExecutor, params: Params) => Promise<Result>> {
    const source = await readFile(join(root, `queries/${name}.typed-sql.ts`), 'utf8')
    const path = join(root, `${name}.mjs`)
    await writeFile(path, ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText)
    const module: { default: (db: PostgresExecutor, params: Params) => Promise<Result> } = await import(
      pathToFileURL(path).href
    )
    return module.default
  }
  const read = await load<Row>('query')
  const insert = await load<readonly Row[]>('insert')
  await t.test('real PostgreSQL executes one query per read and write', { skip: !connectionString }, async () => {
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
      const max = await read(db, { id: '9223372036854775807', width: 2147483647, filter: null })
      assert.equal(queries, 1)
      assert.deepEqual(max, {
        id: 9223372036854775807n,
        wire_id: '9223372036854775807',
        width: 2147483647,
        result: null,
      })
      const [min] = await insert(db, { id: '-9223372036854775808', width: -2147483648, filter: 1 })
      assert.equal(queries, 2)
      assert.ok(min)
      assert.equal(min.id, -9223372036854775808n)
      assert.equal(min.wire_id, '-9223372036854775808')
      assert.equal(min.width, -2147483648)
      assert.deepEqual(min.result?.value, { id: 1 })
      await assert.rejects(read(db, { id: '1', width: 2147483648, filter: null }), {
        name: 'PgExecutionError',
        phase: 'encode',
        executionState: 'notExecuted',
      })
      await assert.rejects(read(db, { id: Number.MAX_SAFE_INTEGER + 1, width: 1, filter: null }), {
        name: 'PgExecutionError',
        phase: 'encode',
        executionState: 'notExecuted',
      })
      assert.equal(queries, 2)
    } finally {
      await client.query(`drop schema ${schema} cascade`)
      await client.end()
    }
  })
})

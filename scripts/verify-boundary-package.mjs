import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Client } from 'pg'
import ts from 'typescript'

const [consumerDirectory, expectation] = process.argv.slice(2)
if (!consumerDirectory)
  throw new Error('Usage: node scripts/verify-boundary-package.mjs <installed-consumer-directory> [expect-rejection]')
const require = createRequire(join(resolve(consumerDirectory), 'package.json'))
const { generateTypedSql } = await import(pathToFileURL(require.resolve('postgres-typed-sql')).href)
const { nodePostgres } = await import(pathToFileURL(require.resolve('postgres-typed-sql/adapters/node-postgres')).href)
const packageRoot = resolve(require.resolve('postgres-typed-sql'), '../..')
const root = await mkdtemp(join(tmpdir(), 'typed-sql-package-boundary-'))
const schema = `boundary_${randomUUID().replaceAll('-', '')}`
const schemaSql = `create schema ${schema}; create table ${schema}.item(id bigint, width int not null);`
try {
  await mkdir(join(root, 'queries'))
  await mkdir(join(root, 'node_modules'))
  await symlink(packageRoot, join(root, 'node_modules/postgres-typed-sql'), 'dir')
  await writeFile(join(root, 'schema.sql'), schemaSql)
  const projection = `:id::bigint as id, :id::bigint::text as wire_id, :width::int as width,
    (select jsonb_build_object('id', x.id) from (values (1), (2)) x(id)
    where x.id = :filter::int limit 1) as result`
  await writeFile(join(root, 'queries/read.typed.sql'), `-- @nullable filter\nselect ${projection}`)
  await writeFile(
    join(root, 'queries/write.typed.sql'),
    `-- @nullable filter
    insert into ${schema}.item values (:id::bigint, :width::int) returning ${projection}`
  )
  const generate = () => generateTypedSql({ rootDir: root, schema: 'schema.sql', include: ['queries'] })
  if (expectation === 'expect-rejection') {
    await assert.rejects(generate(), /could not prove that every use accepts NULL/)
    process.stdout.write('Published baseline rejects safe scalar filter as unproven.\n')
  } else {
    assert.ok(
      process.env.POSTGRES_TYPED_SQL_TEST_URL,
      'Set POSTGRES_TYPED_SQL_TEST_URL for real PostgreSQL verification'
    )
    await generate()
    const run = {}
    for (const name of ['read', 'write']) {
      const source = await readFile(join(root, `queries/${name}.typed-sql.ts`), 'utf8')
      const file = join(root, `${name}.mjs`)
      await writeFile(
        file,
        ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText
      )
      run[name] = (await import(pathToFileURL(file).href)).default
    }
    const { findPgJsonUnknownFlows } = await import(pathToFileURL(require.resolve('postgres-typed-sql/migration')).href)
    const fixture = join(root, 'consumer.mts')
    await writeFile(
      fixture,
      `import type { ReadRow } from './queries/read.typed-sql.js'
      declare const row: ReadRow; declare function parse(value: unknown): void;
      parse(row.result); parse(row.result?.value);`
    )
    const program = ts.createProgram([fixture], {
      strict: true,
      skipLibCheck: true,
      module: ts.ModuleKind.NodeNext,
      target: ts.ScriptTarget.ES2023,
    })
    assert.deepEqual(ts.getPreEmitDiagnostics(program), [])
    assert.equal(findPgJsonUnknownFlows(ts, program).length, 1)
    const client = new Client({
      connectionString: process.env.POSTGRES_TYPED_SQL_TEST_URL,
      options:
        '-c extra_float_digits=3 -c TimeZone=UTC -c DateStyle=ISO,YMD -c IntervalStyle=postgres -c bytea_output=hex',
    })
    await client.connect()
    try {
      await client.query(schemaSql)
      let calls = 0
      const db = nodePostgres({
        client: {
          query(config) {
            calls++
            return client.query(config)
          },
        },
      })
      assert.deepEqual(await run.read(db, { id: '9223372036854775807', width: 2147483647, filter: null }), {
        id: 9223372036854775807n,
        wire_id: '9223372036854775807',
        width: 2147483647,
        result: null,
      })
      assert.equal(calls, 1)
      const [written] = await run.write(db, { id: '-9223372036854775808', width: -2147483648, filter: 1 })
      assert.equal(calls, 2)
      assert.equal(written.id, -9223372036854775808n)
      assert.equal(written.wire_id, '-9223372036854775808')
      assert.deepEqual(written.result.value, { id: 1 })
      await assert.rejects(run.read(db, { id: Number.MAX_SAFE_INTEGER + 1, width: 1, filter: null }), {
        phase: 'encode',
        executionState: 'notExecuted',
      })
      await assert.rejects(run.read(db, { id: '1', width: 2147483648, filter: null }), {
        phase: 'encode',
        executionState: 'notExecuted',
      })
      assert.equal(calls, 2)
      process.stdout.write(
        'Installed package generated strict nullable SQL; exact int8/int4 and migration diagnostic passed; read/write issued exactly two driver queries.\n'
      )
    } finally {
      await client.query(`drop schema ${schema} cascade`)
      await client.end()
    }
  }
} finally {
  await rm(root, { recursive: true, force: true })
}

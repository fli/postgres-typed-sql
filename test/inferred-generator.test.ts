import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import ts from 'typescript'

import type { NodePostgresTypedSqlClient } from '../src/adapters/node-postgres.js'
import type { TypedSqlResultKind, TypedSqlStatement } from '../src/runtime.js'

import { createMinimalFixture, generateTypedSql } from './generator-test-support.js'

interface GeneratedModule {
  readonly default: (client: NodePostgresTypedSqlClient, params?: object) => Promise<unknown>
  readonly query: TypedSqlStatement<object, unknown>
}

test('generated default callables derive every execution shape and honor the exact runtime facade', async () => {
  const root = await createMinimalFixture(
    `create table items (id integer primary key, label text);
     create procedure no_output() language sql as $$ select 1 $$;`,
    'select 1 as value'
  )
  const runtime = pathToFileURL(join(root, 'exact-runtime-facade.mjs')).href
  const actualRuntime = new URL('../src/adapters/node-postgres.js', import.meta.url).href
  await writeFile(join(root, 'exact-runtime-facade.mjs'), `export * from ${JSON.stringify(actualRuntime)}\n`)
  const cases: readonly {
    readonly sql: string
    readonly kind: TypedSqlResultKind
    readonly rows: readonly unknown[]
    readonly expected: unknown
    readonly count?: number
    readonly params?: object
  }[] = [
    { sql: 'select 1 as value', kind: 'one', rows: [[1]], expected: { value: 1 } },
    { sql: 'select from generate_series(1, 2)', kind: 'many', rows: [[], []], expected: [{}, {}] },
    { sql: 'select 1 as value where false', kind: 'many', rows: [], expected: [] },
    { sql: 'select label from items where id = :id', kind: 'optional', rows: [], expected: null, params: { id: 1 } },
    {
      sql: 'select label from items limit 3',
      kind: 'many',
      rows: [['a'], ['b']],
      expected: [{ label: 'a' }, { label: 'b' }],
    },
    { sql: 'insert into items values (1, null)', kind: 'command', rows: [], count: 1, expected: 1 },
    { sql: 'update items set label = null', kind: 'command', rows: [], count: 2, expected: 2 },
    { sql: 'delete from items', kind: 'command', rows: [], count: 0, expected: 0 },
    { sql: 'insert into items values (1, null) returning id', kind: 'many', rows: [[1]], expected: [{ id: 1 }] },
    {
      sql: 'update items set label = null where id = :id returning id',
      kind: 'optional',
      rows: [[1]],
      expected: { id: 1 },
      params: { id: 1 },
    },
    {
      sql: 'delete from items where id = :id returning id',
      kind: 'optional',
      rows: [],
      expected: null,
      params: { id: 1 },
    },
    { sql: 'call no_output()', kind: 'void', rows: [], expected: undefined },
  ]
  for (const [index, example] of cases.entries()) {
    await writeFile(join(root, 'queries/query.typed.sql'), example.sql)
    await generateTypedSql({
      rootDir: root,
      schema: 'schema.sql',
      include: ['queries'],
      imports: { runtime, scalars: 'postgres-typed-sql/scalars' },
    })
    const source = await readFile(join(root, 'queries/query.typed-sql.ts'), 'utf8')
    assert.ok(source.includes(`from '${runtime}'`))
    assert.match(source, /export default createTypedSqlExecutor\(query\)/u)
    const modulePath = join(root, `generated-${index}.mjs`)
    await writeFile(
      modulePath,
      ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText
    )
    const generated = (await import(pathToFileURL(modulePath).href)) as GeneratedModule
    assert.equal(generated.query.resultKind, example.kind, example.sql)
    let calls = 0
    const client: NodePostgresTypedSqlClient = {
      async query(config) {
        calls++
        assert.equal(config.text, generated.query.text)
        assert.equal(config.rowMode, 'array')
        return { rows: example.rows, rowCount: example.count ?? null }
      },
    }
    assert.deepEqual(await generated.default(client, example.params), example.expected, example.sql)
    assert.equal(calls, 1)
  }
})

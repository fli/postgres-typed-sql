import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { Client } from 'pg'
import ts from 'typescript'

import type { PostgresTypedSqlConfig } from '../src/config.js'
import { openQueryProject } from '../src/project.js'
import { generateTypedSql } from '../src/generator.js'
import type { PostgresExecutor } from '../src/runtime.js'
import type { PgFiniteDecimal, PgJson, PgJsonValue } from '../src/values.js'
import { createMinimalFixture, generateFixture } from './generator-test-support.js'

const connectionString = process.env.POSTGRES_TYPED_SQL_TEST_URL
const packageRoot = fileURLToPath(new URL('../../', import.meta.url))
const schema = `checkout_${randomUUID().replaceAll('-', '')}`
const shadow = `${schema}_shadow`
const contract = {
  schema,
  name: 'prepare',
  argumentTypes: ['text'],
  allowJsonNull: true,
  variants: {
    unavailable: {},
    ready: {
      sessionId: 'string',
      revision: 'int4',
      session: { object: { pricing_details: 'json' } },
      payment: { object: { started: 'boolean' } },
      buyer: { object: { taxQuote: { nullable: 'int4' }, buyer_note: { optional: { nullable: 'string' } } } },
      lineItems: { array: 'number' },
    },
  },
} satisfies NonNullable<PostgresTypedSqlConfig['jsonbFunctionContracts']>[number]
const config = {
  naming: { structuredJsonFields: 'camelCase' },
  jsonbFunctionContracts: [
    contract,
    {
      schema,
      name: 'prepare',
      argumentTypes: [{ schema, name: 'attempt' }],
      variants: { retry: { afterSeconds: 'int4' }, stop: {} },
    },
  ],
} satisfies Partial<PostgresTypedSqlConfig>

const schemaSql = `
  create schema ${schema};
  create schema ${shadow};
  create domain ${schema}.attempt as integer;

  create function ${schema}.prepare(mode text) returns jsonb language plpgsql as $$
  declare payload jsonb := '{
    "kind":"ready", "sessionId":"checkout-1", "revision":3,
    "session":{"pricing_details":{"total":9007199254740993}},
    "payment":{"started":false}, "buyer":{"taxQuote":null},
    "lineItems":[9007199254740993]
  }';
  begin
    case mode
      when 'ready' then return payload;
      when 'unavailable' then return '{"kind":"unavailable"}';
      when 'sql-null' then return null;
      when 'json-null' then return 'null';
      when 'present-null' then return jsonb_set(payload, '{buyer,buyer_note}', 'null');
      when 'present-note' then return jsonb_set(payload, '{buyer,buyer_note}', '"call back"');
      when 'bad-tag' then return jsonb_set(payload, '{kind}', '"invalid"');
      when 'missing-tag' then return payload - 'kind';
      when 'missing-revision' then return payload - 'revision';
      when 'fractional-revision' then return jsonb_set(payload, '{revision}', '1.5');
      when 'large-revision' then return jsonb_set(payload, '{revision}', '2147483648');
      when 'missing-tax-quote' then return payload #- '{buyer,taxQuote}';
      when 'bad-payment' then return jsonb_set(payload, '{payment,started}', '"false"');
      when 'renamed-note' then return jsonb_set(payload, '{buyer,buyerNote}', '123');
      when 'bad-note' then return jsonb_set(payload, '{buyer,buyer_note}', '123');
      else return '[]';
    end case;
  end;
  $$;

  create function ${schema}.prepare(mode ${schema}.attempt default 0)
  returns jsonb language plpgsql as $$ begin
    return '{"kind":"retry","afterSeconds":10}';
  end; $$;

  create function ${schema}.prepare(mode boolean)
  returns jsonb language plpgsql as $$ begin return '{"kind":"untyped","n":9007199254740993}'; end; $$;

  create function ${shadow}.prepare(mode text)
  returns jsonb language plpgsql as $$ begin return '{"kind":"shadow","n":9007199254740993}'; end; $$;
`

const query = `select ${schema}.prepare(:mode::text) as result`
const overloads = `select ${schema}.prepare() as retry,
  ${schema}.prepare(true) as raw, ${shadow}.prepare('ready'::text) as shadow,
  ${schema}.prepare('ready'::text)->'session' as projected`
const combined = `select ${schema}.prepare('ready'::text) as result union all select '{"kind":"other"}'::jsonb`

test('declared JSONB contracts narrow complete results and validate PostgreSQL payloads', async (t) => {
  const root = await createMinimalFixture(schemaSql, query)
  t.after(() => rm(root, { recursive: true, force: true }))
  const queryPath = join(root, 'queries/query.typed.sql')
  await writeFile(join(root, 'queries/overloads.typed.sql'), overloads)
  await writeFile(join(root, 'queries/combined.typed.sql'), combined)
  await generateFixture(root, config)

  const configPath = join(root, 'postgres-typed-sql.config.mjs')
  await writeFile(configPath, `export default ${JSON.stringify({ schema: 'schema.sql', ...config })}`)
  const project = await openQueryProject(configPath)
  try {
    assert.equal(
      await project.compile(queryPath, query),
      await readFile(join(root, 'queries/query.typed-sql.ts'), 'utf8')
    )
  } finally {
    await project.close()
  }

  await mkdir(join(root, 'node_modules'))
  await symlink(packageRoot, join(root, 'node_modules/postgres-typed-sql'), 'dir')
  const consume = join(root, 'consume.mts')
  await writeFile(
    consume,
    `
import type { PgFiniteDecimal, PgJson, PgJsonValue } from 'postgres-typed-sql/values'
import type { QueryRow } from './queries/query.typed-sql.js'
import type { OverloadsRow } from './queries/overloads.typed-sql.js'
import type { CombinedRow } from './queries/combined.typed-sql.js'
declare const row: QueryRow
declare function exact<T>(value: T): void
type Assert<T extends true> = T
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
if (row.result !== null) {
  const value = row.result.value
  switch (value?.kind) {
    case 'ready':
      exact<string>(value.sessionId)
      exact<number>(value.revision)
      exact<PgFiniteDecimal>(value.lineItems[0]!)
      exact<PgJsonValue>(value.session.pricingDetails)
      exact<boolean>(value.payment.started)
      exact<number | null>(value.buyer.taxQuote)
      type OptionalNote = Assert<Equal<typeof value.buyer.buyerNote, string | null | undefined>>
      break
    case 'unavailable':
      type UnavailableKeys = Assert<Equal<keyof typeof value, 'kind'>>
      break
    default:
      exact<null>(value)
  }
}
declare const overloads: OverloadsRow
if (overloads.retry?.value.kind === 'retry') exact<number>(overloads.retry.value.afterSeconds)
type GenericJson = PgJson<PgJsonValue> | null
type Raw = Assert<Equal<OverloadsRow['raw'], GenericJson>>
type Shadow = Assert<Equal<OverloadsRow['shadow'], GenericJson>>
type Projected = Assert<Equal<OverloadsRow['projected'], GenericJson>>
type Combined = Assert<Equal<CombinedRow['result'], GenericJson>>
`
  )
  const host = ts.createCompilerHost({})
  const program = ts.createProgram(
    [consume],
    {
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      module: ts.ModuleKind.NodeNext,
      target: ts.ScriptTarget.ES2023,
      types: [],
    },
    host
  )
  const diagnostics = ts.getPreEmitDiagnostics(program)
  assert.equal(ts.formatDiagnosticsWithColorAndContext(diagnostics, host), '')

  await t.test('execute through node-postgres', { skip: !connectionString }, async () => {
    interface Ready {
      readonly kind: 'ready'
      readonly sessionId: string
      readonly revision: number
      readonly session: { readonly pricingDetails: PgJsonValue }
      readonly payment: { readonly started: boolean }
      readonly buyer: { readonly taxQuote: number | null; readonly buyerNote?: string | null }
      readonly lineItems: readonly PgFiniteDecimal[]
    }
    const adapter: typeof import('../src/adapters/node-postgres.js') = await import(
      new URL('../../dist/adapters/node-postgres.js', import.meta.url).href
    )
    const values: typeof import('../src/values.js') = await import(
      new URL('../../dist/values.js', import.meta.url).href
    )
    const { default: prepare } = await importQuery<{
      default: (
        db: PostgresExecutor,
        params: { mode: string }
      ) => Promise<{ result: PgJson<Ready | { readonly kind: 'unavailable' } | null> | null }>
    }>(root, 'query')
    const { default: callOverloads } = await importQuery<{
      default: (db: PostgresExecutor) => Promise<{
        retry: PgJson<{ kind: 'retry'; afterSeconds: number }> | null
        raw: PgJson | null
        shadow: PgJson | null
        projected: PgJson | null
      }>
    }>(root, 'overloads')
    const client = new Client({
      connectionString,
      options:
        '-c extra_float_digits=3 -c TimeZone=UTC -c DateStyle=ISO,YMD -c IntervalStyle=postgres -c bytea_output=hex',
    })
    await client.connect()
    try {
      await client.query(schemaSql)
      const db = adapter.nodePostgres({ client })
      const run = (mode: string) => prepare(db, { mode })
      const { result: doc } = await run('ready')
      assert.ok(doc && doc.value?.kind === 'ready')
      assert.equal(doc.value.sessionId, 'checkout-1')
      assert.equal(doc.value.revision, 3)
      assert.deepEqual(doc.value.payment, { started: false })
      assert.deepEqual(doc.value.buyer, { taxQuote: null })
      assert.equal(Object.hasOwn(doc.value.buyer, 'buyerNote'), false)
      const exact = values.jsonNumber('9007199254740993')
      assert.deepEqual(doc.value.lineItems, [exact])
      assert.deepEqual(doc.value.session.pricingDetails, { total: exact })
      assert.deepEqual(values.json(doc.value, doc.codec).value, doc.value)

      assert.deepEqual((await run('unavailable')).result?.value, { kind: 'unavailable' })
      assert.equal((await run('sql-null')).result, null)
      assert.equal((await run('json-null')).result?.value, null)
      for (const [mode, note] of [
        ['present-null', null],
        ['present-note', 'call back'],
      ] as const) {
        const { result } = await run(mode)
        assert.ok(result && result.value?.kind === 'ready')
        assert.equal(Object.hasOwn(result.value.buyer, 'buyerNote'), true)
        assert.equal(result.value.buyer.buyerNote, note)
        assert.deepEqual(values.json(result.value, result.codec).value, result.value)
      }
      for (const mode of [
        'bad-tag',
        'missing-tag',
        'missing-revision',
        'fractional-revision',
        'large-revision',
        'missing-tax-quote',
        'bad-payment',
        'bad-note',
        'renamed-note',
        'wrong-root',
      ]) {
        await assert.rejects(
          run(mode),
          { name: 'PgExecutionError', phase: 'decode', executionState: 'mayHaveExecuted' },
          mode
        )
      }

      const row = await callOverloads(db)
      assert.deepEqual(row.retry?.value, { kind: 'retry', afterSeconds: 10 })
      assert.deepEqual(row.raw?.value, { kind: 'untyped', n: exact })
      assert.deepEqual(row.shadow?.value, { kind: 'shadow', n: exact })
      assert.deepEqual(row.projected?.value, { pricing_details: { total: exact } })
    } finally {
      try {
        await client.query(`drop schema if exists ${schema}, ${shadow} cascade`)
      } finally {
        await client.end()
      }
    }
  })
})

async function importQuery<Module>(root: string, name: string): Promise<Module> {
  const source = await readFile(join(root, `queries/${name}.typed-sql.ts`), 'utf8')
  const path = join(root, `${name}.mjs`)
  await writeFile(path, ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText)
  return import(pathToFileURL(path).href)
}

test('generation rejects missing, incompatible, and duplicate function signatures', async (t) => {
  const root = await createMinimalFixture(
    `create function public.invalid() returns integer language plpgsql as $$ begin return 1; end; $$;
    create function public.candidate() returns jsonb language plpgsql as $$ begin return '{"kind":"yes"}'; end; $$;`,
    'select 1'
  )
  t.after(() => rm(root, { recursive: true, force: true }))
  const candidate = { schema: 'public', name: 'candidate', argumentTypes: [], variants: { yes: {}, no: {} } }
  await assert.rejects(
    generateFixture(root, { jsonbFunctionContracts: [{ ...candidate, argumentTypes: ['text'] }] }),
    /overload not found: public\.candidate\(pg_catalog\.text\)/u
  )
  await assert.rejects(
    generateFixture(root, { jsonbFunctionContracts: [{ ...candidate, name: 'invalid' }] }),
    /requires a scalar function returning jsonb: public\.invalid\(\)/u
  )
  await assert.rejects(
    generateFixture(root, { jsonbFunctionContracts: [candidate, candidate] }),
    /Duplicate JSONB function contract: public\.candidate\(\)/u
  )
})

test('contract projections infer nested fields and track external SQL inputs', async (t) => {
  const projectionSchema = `create function public.projection_contract(bad boolean) returns jsonb language sql as $$
    select case when bad then '{"kind":"ready","item":{"item_id":"wrong"}}'::jsonb
      else '{"kind":"ready","item":{"item_id":7}}'::jsonb end $$;`
  const root = await createMinimalFixture(
    projectionSchema,
    'select public.projection_contract(:bad::boolean) as result'
  )
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'projections'))
  const projection = join(root, 'projections/item.typed.sql')
  await writeFile(projection, 'select 7::int4 as item_id; -- trailing comment')
  const projectedContract = {
    schema: 'public',
    name: 'projection_contract',
    argumentTypes: ['bool'],
    variants: { unavailable: {}, ready: { item: { projection: 'projections/item.typed.sql' } } },
  } as const
  const options = {
    rootDir: root,
    schema: 'schema.sql',
    include: ['queries'],
    naming: { structuredJsonFields: 'camelCase' },
    jsonbFunctionContracts: [projectedContract],
  } as const
  const result = await generateTypedSql(options, { analysis: true })
  assert.ok(result.analysis.inputs.some((input) => input.path === projection))
  const generated = await readFile(join(root, 'queries/query.typed-sql.ts'), 'utf8')
  assert.match(generated, /itemId/)
  assert.match(generated, /item_id/)
  await writeFile(
    join(root, 'postgres-typed-sql.config.mjs'),
    `export default ${JSON.stringify({ ...options, rootDir: '.' })}`
  )
  let changedModule = ''
  const project = await openQueryProject(join(root, 'postgres-typed-sql.config.mjs'))
  try {
    const snapshot = await project.analyzeProject()
    assert.ok(snapshot.inputs.some((input) => input.path === projection && input.role === 'projection'))
    const before = await project.compile(
      join(root, 'queries/query.typed.sql'),
      'select public.projection_contract(:bad::boolean) as result'
    )
    await writeFile(projection, 'select true as item_id -- trailing comment')
    await assert.rejects(
      project.compile(
        join(root, 'queries/query.typed.sql'),
        'select public.projection_contract(:bad::boolean) as result'
      )
    )
    await project.close()
    const reopened = await openQueryProject(join(root, 'postgres-typed-sql.config.mjs'))
    try {
      const after = await reopened.compile(
        join(root, 'queries/query.typed.sql'),
        'select public.projection_contract(:bad::boolean) as result'
      )
      assert.notEqual(after, before)
      assert.match(after, /itemId: boolean/)
      assert.match(after, /"pgTypeName":"bool"/)
      changedModule = after
    } finally {
      await reopened.close()
    }
  } finally {
    await project.close()
  }
  if (!connectionString) return
  await mkdir(join(root, 'node_modules'))
  await symlink(packageRoot, join(root, 'node_modules/postgres-typed-sql'), 'dir')
  const adapter: typeof import('../src/adapters/node-postgres.js') = await import(
    new URL('../../dist/adapters/node-postgres.js', import.meta.url).href
  )
  const { default: run } = await importQuery<{
    default: (
      db: PostgresExecutor,
      params: { bad: boolean }
    ) => Promise<{ result: PgJson<{ kind: string; item?: { itemId: number } }> | null }>
  }>(root, 'query')
  const client = new Client({
    connectionString,
    options:
      '-c extra_float_digits=3 -c TimeZone=UTC -c DateStyle=ISO,YMD -c IntervalStyle=postgres -c bytea_output=hex',
  })
  await client.connect()
  try {
    await client.query(projectionSchema)
    const db = adapter.nodePostgres({ client })
    assert.deepEqual((await run(db, { bad: false })).result?.value, { kind: 'ready', item: { itemId: 7 } })
    await assert.rejects(run(db, { bad: true }), { name: 'PgExecutionError', phase: 'decode' })
    const changedPath = join(root, 'changed.mjs')
    await writeFile(
      changedPath,
      ts.transpileModule(changedModule, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText
    )
    const changed = (await import(pathToFileURL(changedPath).href)) as { default: typeof run }
    await assert.rejects(changed.default(db, { bad: false }), { name: 'PgExecutionError', phase: 'decode' })
  } finally {
    await client.query('drop function if exists public.projection_contract(boolean)')
    await client.end()
  }
})

test('projection preserves a directly called function contract', async (t) => {
  const root = await createMinimalFixture(
    `
    create function public.outer_contract() returns jsonb language sql as $$ select '{"kind":"yes","item":{"nested":null}}'::jsonb $$;
    create function public.inner_contract() returns jsonb language sql as $$ select '{}'::jsonb $$;
  `,
    'select public.outer_contract() as result'
  )
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'projections'))
  await writeFile(join(root, 'projections/item.typed.sql'), 'select public.inner_contract() as nested')
  await generateFixture(root, {
    jsonbFunctionContracts: [
      {
        schema: 'public',
        name: 'outer_contract',
        argumentTypes: [],
        variants: { yes: { item: { projection: 'projections/item.typed.sql' } }, no: {} },
      },
      {
        schema: 'public',
        name: 'inner_contract',
        argumentTypes: [],
        variants: { found: { count: 'int4' }, missing: {} },
      },
    ],
  })
  const generated = await readFile(join(root, 'queries/query.typed-sql.ts'), 'utf8')
  assert.match(generated, /"found"/)
  assert.match(generated, /count: number/)
  assert.match(generated, /nested: .* \| null/)
  if (!connectionString) return
  await mkdir(join(root, 'node_modules'))
  await symlink(packageRoot, join(root, 'node_modules/postgres-typed-sql'), 'dir')
  const adapter: typeof import('../src/adapters/node-postgres.js') = await import(
    new URL('../../dist/adapters/node-postgres.js', import.meta.url).href
  )
  const { default: run } = await importQuery<{ default: (db: PostgresExecutor) => Promise<{ result: PgJson | null }> }>(
    root,
    'query'
  )
  const client = new Client({
    connectionString,
    options:
      '-c extra_float_digits=3 -c TimeZone=UTC -c DateStyle=ISO,YMD -c IntervalStyle=postgres -c bytea_output=hex',
  })
  await client.connect()
  try {
    await client.query(await readFile(join(root, 'schema.sql'), 'utf8'))
    assert.deepEqual((await run(adapter.nodePostgres({ client }))).result?.value, {
      kind: 'yes',
      item: { nested: null },
    })
  } finally {
    await client.query('drop function if exists public.outer_contract(), public.inner_contract()')
    await client.end()
  }
})

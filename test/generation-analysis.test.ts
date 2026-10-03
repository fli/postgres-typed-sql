import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, mkdir, rm, writeFile } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import ts from 'typescript'

import {
  definePostgresCodecProfile,
  generateTypedSql,
  generationAnalysisVersion,
  type PostgresTypedSqlConfig,
  type TypedSqlStatementAnalysis,
  type TypedSqlGenerationAnalysis,
} from '../src/index.js'
import { createTypedSqlStatement } from '../src/runtime.js'
import { createAnalysisDatabase } from '../src/engine.js'
import { createMinimalFixture } from './generator-test-support.js'
import { validatePolicyManifest, type PolicyManifest } from './policy-consumer-example.js'

const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const statementAt = (report: TypedSqlGenerationAnalysis, index: number) => {
  const entry = report.statements[index]
  assert.ok(entry)
  return entry
}
const configFor = (rootDir: string): PostgresTypedSqlConfig => ({
  rootDir,
  schema: 'schema.sql',
  include: ['queries'],
  imports: { runtime: 'postgres-typed-sql/runtime', scalars: 'postgres-typed-sql/scalars' },
})

async function emittedStatement(entry: TypedSqlStatementAnalysis): Promise<{ text: string; access: string }> {
  const javascript = ts.transpileModule(await readFile(entry.module, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 },
  }).outputText
  const exports: Record<string, { text: string; access: string }> = {}
  runInNewContext(javascript, {
    exports,
    require: (specifier: string) => {
      assert.equal(specifier, 'postgres-typed-sql/runtime')
      return { createTypedSqlStatement }
    },
  })
  const emitted = exports[entry.export]
  assert.ok(emitted)
  return emitted
}

test('complete public analysis binds consumed bytes and emitted identities, independently of write routing', async (t) => {
  const root = await createMinimalFixture(
    `create table widgets (id integer primary key);\r\n
     create procedure noop() language plpgsql as $$begin null; end$$;
     create function mutate_widget() returns integer language sql volatile
       as $$ insert into widgets(id) values (1) returning id $$;`,
    "-- @access write\nselect :id::integer as id, E'a\\n\"b\\\\c'::text as escaped;"
  )
  t.after(() => rm(root, { recursive: true, force: true }))
  const queries: Record<string, string> = {
    read: 'select id from widgets where id = :id;',
    insert: 'insert into widgets (id) values (:id) returning id;',
    update: 'update widgets set id = :new_id where id = :old_id;',
    deleteRows: 'delete from widgets where id = :id;',
    merge:
      'merge into widgets using (values (:id::integer)) as src(id) on widgets.id = src.id when matched then delete;',
    cte: 'with changed as (delete from widgets returning id) select id from changed;',
    lock: 'select id from widgets for update;',
    nestedLock: 'select * from (select id from widgets for share) locked;',
    volatile: 'select random();',
    mutatingFunction: 'select mutate_widget();',
    call: 'call noop();',
  }
  await Promise.all(
    Object.entries(queries).map(([name, sql]) => writeFile(join(root, 'queries', `${name}.typed.sql`), sql))
  )
  await mkdir(join(root, 'queries', 'nested'))
  await writeFile(join(root, 'queries/nested/read.typed.sql'), 'select 42 as id;')
  const result = await generateTypedSql(configFor(root), { analysis: true })
  const { analysis } = result
  assert.equal(analysis.version, generationAnalysisVersion)
  assert.equal(
    analysis.producer.version,
    JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')).version
  )
  assert.equal(analysis.postgresVersionNum, 180003)
  assert.equal(analysis.statements.length, result.statementCount)
  assert.equal(result.statementCount, 13)
  assert.deepEqual(analysis.include, [join(root, 'queries')])
  assert.deepEqual(
    analysis.statements.map((entry) => entry.module),
    result.generatedFiles
  )
  assert.equal(
    new Set(analysis.statements.map((entry) => `${entry.module}#${entry.export}`)).size,
    result.statementCount
  )
  assert.equal(analysis.inputs.length, result.statementCount + 1)
  for (const input of analysis.inputs) assert.equal(input.sha256, hash(await readFile(input.path)))
  const byExport = (name: string) => {
    const entry = analysis.statements.find((entry) => entry.export === name)
    assert.ok(entry)
    return entry
  }
  for (const entry of analysis.statements) {
    const emitted = await emittedStatement(entry)
    assert.equal(emitted.text, entry.sql)
    assert.equal(emitted.access, entry.access)
    assert.equal(entry.sqlSha256, hash(emitted.text))
    assert.ok(analysis.inputs.some((input) => input.path === entry.source && input.role === 'sql'))
    assert.equal('analyzerSchemaVersion' in entry, false)
    assert.equal('resultColumns' in entry, false)
  }
  assert.equal(byExport('query').access, 'write')
  assert.deepEqual(byExport('query').accessEvidence, { concerns: [] })
  assert.equal(byExport('read').access, 'read')
  for (const [name, command] of [
    ['insert', 'INSERT'],
    ['update', 'UPDATE'],
    ['deleteRows', 'DELETE'],
    ['merge', 'MERGE'],
  ] as const) {
    assert.deepEqual(byExport(name).accessEvidence, {
      concerns: [{ kind: 'definiteDml', command }],
    })
  }
  const reasons = (name: string) => {
    const evidence = byExport(name).accessEvidence
    assert.ok(evidence.concerns.length)
    return evidence.concerns.map((concern) => concern.kind)
  }
  assert.ok(reasons('cte').includes('dataModifyingCte'))
  assert.deepEqual(reasons('lock'), ['rowLock'])
  assert.deepEqual(reasons('nestedLock'), ['rowLock'])
  assert.deepEqual(reasons('volatile'), ['volatileExecution'])
  assert.deepEqual(reasons('mutatingFunction'), ['volatileExecution'])
  assert.deepEqual(reasons('call'), ['procedureCall'])
  assert.deepEqual((await generateTypedSql(configFor(root), { analysis: true })).analysis, analysis)
  const ordinary = await generateTypedSql(configFor(root))
  assert.equal(Object.hasOwn(ordinary, 'analysis'), false)
})

test('ordered schema provenance and an empty SQL inventory still produce a complete report', async (t) => {
  const root = await createMinimalFixture('create table widgets (id integer primary key);', 'select 1;')
  t.after(() => rm(root, { recursive: true, force: true }))
  await rm(join(root, 'queries/query.typed.sql'))
  await writeFile(join(root, 'second.sql'), 'alter table widgets add column name text;')
  const result = await generateTypedSql(
    { ...configFor(root), schema: ['schema.sql', 'second.sql'] },
    { analysis: true }
  )
  assert.equal(result.statementCount, 0)
  assert.deepEqual(result.analysis.statements, [])
  assert.deepEqual(
    result.analysis.inputs.map((input) => input.path),
    [join(root, 'schema.sql'), join(root, 'second.sql')]
  )
})

test('isolated policy consumer rejects misassociation, incompleteness, divergence, stale provenance and unknown semantics', async (t) => {
  const root = await createMinimalFixture(
    'create table widgets (id integer primary key);',
    'select id from widgets where id = :id;'
  )
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'queries/other.typed.sql'), 'delete from widgets where id = :id;')
  const configPath = join(root, 'config.mjs')
  await writeFile(configPath, '// captured before configuration load')
  const configurationInputs = [{ path: configPath, sha256: hash(await readFile(configPath)) }]
  const { analysis } = await generateTypedSql(configFor(root), { analysis: true })
  const parsed = await Promise.all(
    analysis.statements.map(async (entry) => ({
      module: entry.module,
      export: entry.export,
      ...(await emittedStatement(entry)),
    }))
  )
  const inventory = analysis.inputs.filter((entry) => entry.role === 'sql').map((entry) => entry.path)
  const manifest: PolicyManifest = { schemaVersion: 1, generation: analysis, configurationInputs }
  const validate = (value = manifest, statements = parsed, sources = inventory) =>
    validatePolicyManifest(value, sources, statements, [analysis.producer.version])
  await validate()
  const tamper = async (edit: (value: PolicyManifest) => void, pattern: RegExp) => {
    // Model untrusted JSON at the consumer boundary.
    const value: PolicyManifest = JSON.parse(JSON.stringify(manifest))
    edit(value)
    await assert.rejects(validate(value), pattern)
  }
  await tamper((v) => {
    Object.assign(v.generation, { version: 999 })
  }, /Incompatible/u)
  await tamper((v) => {
    Object.assign(v.generation.producer, { version: 'future-unreviewed' })
  }, /Incompatible/u)
  await tamper((v) => {
    Object.assign(v.generation, { postgresVersionNum: 190000 })
  }, /Incompatible/u)
  await tamper((v) => {
    Object.assign(v.generation, { statements: v.generation.statements.slice(0, -1) })
  }, /Incomplete/u)
  await tamper((v) => {
    Object.assign(v.generation, { statements: [v.generation.statements[0], v.generation.statements[0]] })
  }, /Stale generated/u)
  await tamper((v) => {
    Object.assign(statementAt(v.generation, 0), { export: 'query' })
  }, /Stale generated/u)
  await tamper((v) => {
    Object.assign(statementAt(v.generation, 0), { source: statementAt(v.generation, 1).source })
  }, /Invalid statement source/u)
  await tamper((v) => {
    Object.assign(statementAt(v.generation, 0).accessEvidence, { concerns: [{ kind: 'futureConcern' }] })
  }, /Invalid access/u)
  await assert.rejects(
    validate(
      manifest,
      parsed.map((entry) => ({ ...entry, text: `${entry.text} ` }))
    ),
    /Stale generated/u
  )
  await assert.rejects(
    validate(
      manifest,
      parsed.map((entry) => ({ ...entry, access: 'read' }))
    ),
    /Stale generated/u
  )
  await assert.rejects(
    validate(manifest, parsed, [...inventory, join(root, 'queries/new.typed.sql')]),
    /SQL inventory/u
  )
  await writeFile(configPath, '// changed configuration')
  await assert.rejects(validate(), /Stale input/u)
})

for (const change of ['sql', 'schema', 'inventory'] as const) {
  test(`rejects concurrent ${change} changes before outputs commit`, async (t) => {
    const root = await createMinimalFixture('create table widgets (id integer primary key);', 'select id from widgets;')
    t.after(() => rm(root, { recursive: true, force: true }))
    await generateTypedSql(configFor(root))
    const previous = await readFile(join(root, 'queries/query.typed-sql.ts'), 'utf8')
    const catalog = await readFile(join(root, 'postgres-typed-sql.types.ts'), 'utf8')
    let changed = false
    const codecProfile = definePostgresCodecProfile({
      name: 'concurrent-input-test',
      extends: 'conservative',
      resultType(_context, fallback) {
        if (!changed) {
          changed = true
          const path =
            change === 'schema' ? 'schema.sql' : change === 'sql' ? 'queries/query.typed.sql' : 'queries/new.typed.sql'
          writeFileSync(join(root, path), '-- changed during analysis\nselect 1;')
        }
        return fallback()
      },
    })
    await assert.rejects(
      generateTypedSql({ ...configFor(root), codecProfile }, { analysis: true }),
      change === 'inventory' ? /SQL inventory changed/u : /Analysis input changed/u
    )
    assert.equal(await readFile(join(root, 'queries/query.typed-sql.ts'), 'utf8'), previous)
    assert.equal(await readFile(join(root, 'postgres-typed-sql.types.ts'), 'utf8'), catalog)
  })
}

test('analysis rejects overwriting a consumed schema through an aliased output path', async (t) => {
  const root = await createMinimalFixture('create table widgets (id integer primary key);', 'select 1;')
  t.after(() => rm(root, { recursive: true, force: true }))
  const original = await readFile(join(root, 'schema.sql'), 'utf8')
  await assert.rejects(
    generateTypedSql({ ...configFor(root), typesOutput: 'queries/../schema.sql' }, { analysis: true }),
    /overlaps an analysis input/u
  )
  assert.equal(await readFile(join(root, 'schema.sql'), 'utf8'), original)
})

test('failed or unsupported statements never yield a partial report or replace existing outputs', async (t) => {
  const root = await createMinimalFixture('create table widgets (id integer primary key);', 'select id from widgets;')
  t.after(() => rm(root, { recursive: true, force: true }))
  await generateTypedSql(configFor(root), { analysis: true })
  const previous = await readFile(join(root, 'queries/query.typed-sql.ts'), 'utf8')
  for (const sql of [
    '-- @access read\nselect random();',
    'show timezone;',
    'select 1; select 2;',
    'select missing from widgets;',
  ]) {
    await writeFile(join(root, 'queries/query.typed.sql'), sql)
    await assert.rejects(generateTypedSql(configFor(root), { analysis: true }))
    assert.equal(await readFile(join(root, 'queries/query.typed-sql.ts'), 'utf8'), previous)
  }
})

test('option errors release the generation guard and later generation can return analysis', async (t) => {
  const root = await createMinimalFixture('create table widgets (id integer primary key);', 'select id from widgets;')
  t.after(() => rm(root, { recursive: true, force: true }))
  await assert.rejects(
    generateTypedSql(configFor(root), {
      get analysis(): boolean {
        throw new Error('option evaluation failed')
      },
    }),
    /option evaluation failed/u
  )
  const result = await generateTypedSql(configFor(root), { analysis: true })
  assert.equal(result.analysis.statements.length, 1)
})

test('empty access concerns do not certify effects hidden behind declared STABLE volatility', async (t) => {
  const root = await createMinimalFixture(
    `
    create table public.widgets (id integer primary key);
    create function public.mutate_widget() returns integer language plpgsql volatile
      as $$begin insert into public.widgets values (1); return 1; end$$;
    create function public.stable_wrapper() returns integer language plpgsql stable
      as $$begin return public.mutate_widget(); end$$;
  `,
    'select public.stable_wrapper();'
  )
  t.after(() => rm(root, { recursive: true, force: true }))
  const { analysis } = await generateTypedSql(configFor(root), { analysis: true })
  assert.equal(statementAt(analysis, 0).access, 'read')
  assert.deepEqual(statementAt(analysis, 0).accessEvidence, { concerns: [] })
  const database = await createAnalysisDatabase({ schemaFiles: [join(root, 'schema.sql')] })
  try {
    await database.query(statementAt(analysis, 0).sql)
    assert.equal((await database.query('select id from public.widgets')).rows.length, 1)
  } finally {
    await database.close()
  }
})

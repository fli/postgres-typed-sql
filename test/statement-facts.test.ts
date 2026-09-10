import assert from 'node:assert/strict'
import { readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { statementFactsSchemaVersion, statementFactsSha256, type StatementFactsManifest } from '../src/index.js'
import { buildStatementFacts, snapshotStatementFactsInputs } from '../src/statement-facts.js'
import { resolveConfig } from '../src/config.js'
import { createMinimalFixture, generateFixture } from './generator-test-support.js'

test('publishes versioned facts bound to SQL, schema, config, and generated export identities', async (t) => {
  const sql = 'select id from widgets limit 2;\n'
  const root = await createMinimalFixture('create table widgets (id bigint primary key);\n', sql)
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'generator.config.json'), '{}\n')
  await writeFile(join(root, 'queries/all-widgets.typed.sql'), 'select id from widgets;\n')
  await writeFile(
    join(root, 'queries/write-widget.typed.sql'),
    '-- @name insertWidget\ninsert into widgets(id) values (1);\n'
  )
  const result = await generateFixture(root, {
    statementFacts: { output: 'facts.json', configurationFiles: ['generator.config.json'] },
  })
  const facts = result.statementFacts
  assert.ok(facts)
  assert.equal(facts.schemaVersion, statementFactsSchemaVersion)
  assert.equal(facts.producer.name, 'postgres-typed-sql')
  assert.match(facts.producer.version, /^\d+\.\d+\.\d+/u)
  assert.deepEqual(facts.include, ['queries'])
  assert.deepEqual(JSON.parse(await readFile(join(root, 'facts.json'), 'utf8')), facts)
  for (const input of facts.inputs) {
    assert.equal(input.sha256, statementFactsSha256(await readFile(join(root, input.path))))
  }
  assert.equal(facts.inputs.find((input) => input.path === 'schema.sql')?.role, 'schema')
  assert.equal(facts.inputs.find((input) => input.path === 'generator.config.json')?.role, 'configuration')
  const limited = facts.statements.find((statement) => statement.export === 'query')
  assert.ok(limited)
  assert.equal(limited.rowBounds.max, 2)
  assert.equal(limited.access, 'read')
  assert.equal(limited.sqlSha256, statementFactsSha256(sql.trim()))
  assert.equal(limited.module, 'queries/query.typed-sql.ts')
  assert.equal(limited.source, 'queries/query.typed.sql')
  assert.equal(limited.resultColumns[0]?.expressionSource.kind, 'tableColumn')
  assert.equal(facts.statements.find((statement) => statement.export === 'allWidgets')?.rowBounds.max, null)
  assert.equal(facts.statements.find((statement) => statement.export === 'insertWidget')?.access, 'write')
})

test('facts output failures leave existing generated modules unchanged', async (t) => {
  const root = await createMinimalFixture('select 1;\n', 'select 1 as original;\n')
  t.after(() => rm(root, { recursive: true, force: true }))
  await generateFixture(root)
  const output = join(root, 'queries/query.typed-sql.ts')
  const before = await readFile(output, 'utf8')
  await writeFile(join(root, 'queries/query.typed.sql'), 'select 2 as updated;\n')
  await writeFile(join(root, 'blocker'), 'not a directory')
  await assert.rejects(
    generateFixture(root, {
      statementFacts: { output: 'blocker/facts.json', configurationFiles: ['schema.sql'] },
    })
  )
  assert.equal(await readFile(output, 'utf8'), before)
})

test('rejects overlapping outputs and changes to inputs during generation', async (t) => {
  const root = await createMinimalFixture('select 1;\n', 'select 1;\n')
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'config.json'), '{}\n')
  const config = resolveConfig({
    rootDir: root,
    schema: 'schema.sql',
    include: ['queries'],
    imports: { runtime: 'postgres-typed-sql/runtime', scalars: 'postgres-typed-sql/scalars' },
    statementFacts: { output: 'facts.json', configurationFiles: ['config.json'] },
  })
  const source = {
    sourcePath: join(root, 'queries/query.typed.sql'),
    outputPath: join(root, 'queries/query.typed-sql.ts'),
    sourceSha256: statementFactsSha256('select 1;\n'),
  }
  const before = await snapshotStatementFactsInputs(config, [])
  assert.ok(await buildStatementFacts(config, [], before))
  await writeFile(join(root, 'config.json'), '{"changed":true}\n')
  await assert.rejects(buildStatementFacts(config, [], before), /inputs changed during generation/u)
  await writeFile(source.sourcePath, 'select 2;\n')
  await assert.rejects(snapshotStatementFactsInputs(config, [source]), /SQL source changed during generation/u)
  await writeFile(source.sourcePath, 'select 1;\n')
  for (const output of ['../facts.json', 'queries/query.typed-sql.ts', 'config.json']) {
    await assert.rejects(
      snapshotStatementFactsInputs(
        { ...config, statementFacts: { output: join(root, output), configurationFiles: [join(root, 'config.json')] } },
        [source]
      )
    )
  }
})

test('omitting statementFacts preserves the normal generator result', async (t) => {
  const root = await createMinimalFixture('select 1;\n', 'select 1;\n')
  t.after(() => rm(root, { recursive: true, force: true }))
  const result = await generateFixture(root)
  const facts: StatementFactsManifest | undefined = result.statementFacts
  assert.equal(facts, undefined)
  assert.equal(result.statementCount, 1)
})

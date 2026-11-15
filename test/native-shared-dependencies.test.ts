import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const child = `
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateTypedSql } from ${JSON.stringify(new URL('../src/generator.js', import.meta.url).href)}
const { schema, sql } = JSON.parse(process.argv[1])
const rootDir = await mkdtemp(join(tmpdir(), 'typed-sql-shared-'))
try {
  await mkdir(join(rootDir, 'queries'))
  await writeFile(join(rootDir, 'schema.sql'), schema)
  await writeFile(join(rootDir, 'queries/query.typed.sql'), sql)
  const result = await generateTypedSql({ rootDir, schema: 'schema.sql', include: ['queries'] }, { analysis: true })
  const generated = await readFile(join(rootDir, 'queries/query.typed-sql.ts'), 'utf8')
  process.stdout.write(JSON.stringify({ parameters: result.analysis.statements[0].parameters, generated }))
} finally {
  await rm(rootDir, { recursive: true, force: true })
}
`

function generate(schema: string, sql: string): { parameters: unknown; generated: string } {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', child, JSON.stringify({ schema, sql })], {
    encoding: 'utf8',
    timeout: 15_000,
    killSignal: 'SIGKILL',
    maxBuffer: 10 * 1024 * 1024,
  })
  if (result.error && 'code' in result.error && result.error.code === 'ETIMEDOUT') {
    assert.fail('shared query compilation exceeded the 15 second child-process limit')
  }
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr)
  const output: unknown = JSON.parse(result.stdout)
  assert.ok(output && typeof output === 'object' && 'parameters' in output && 'generated' in output)
  assert.ok(typeof output.generated === 'string')
  return { parameters: output.parameters, generated: output.generated }
}

test('generates a deeply shared CTE chain within a bounded process', () => {
  const chain = ['c0 as (select 1::int as v)']
  for (let index = 1; index <= 28; index++) {
    chain.push(`c${index} as (select v + v as v from c${index - 1})`)
  }
  const output = generate(
    '',
    `-- @nullable input\nwith ${chain.join(', ')} select abs(v) as value from c28 where :input::int is null`
  )
  assert.ok(Array.isArray(output.parameters))
  assert.equal(output.parameters[0].nullBinding, 'provedNullable')
  assert.equal(output.parameters[0].nullAdmission, 'accepts')
  assert.match(output.generated, /readonly value: number/u)
  assert.match(output.generated, /export default/u)
})

test('generates shared nested projections with correlated JSON aggregates', () => {
  const schema = `
    create table sessions (id integer primary key, label text not null);
    create table items (id integer primary key, session_id integer not null, name text not null);
    create view item_view as select id, session_id, name, name || name as doubled from items;
  `
  const projections = ['base as (select id, label, id + id as display from sessions)']
  for (let index = 1; index <= 20; index++) {
    const previous = index === 1 ? 'base' : `projection${index - 1}`
    projections.push(`projection${index} as (select id, label, display from ${previous})`)
  }
  const sql = `-- @nullable input
    with ${projections.join(', ')}
    select p.id, p.display, p.display + p.display as repeated_display,
      details.items, details.item_count
    from projection20 p
    left join lateral (
      select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'name', i.name,
        'display', p.display, 'label', i.doubled)), '[]'::jsonb) as items,
        count(*) as item_count
      from item_view i where i.session_id = p.id
    ) details on true
    where :input::int is null or p.id = :input::int
  `
  const output = generate(schema, sql)
  assert.ok(Array.isArray(output.parameters))
  assert.equal(output.parameters[0].nullBinding, 'provedNullable')
  assert.equal(output.parameters[0].nullAdmission, 'accepts')
  assert.match(output.generated, /readonly repeated_display: number/u)
  assert.match(output.generated, /readonly item_count: /u)
  assert.match(output.generated, /readonly items: /u)
})

test('keeps parameter contexts separate across shadowed CTE scopes', () => {
  const output = generate(
    '',
    `-- @nullable safe
    -- @bindNull caller
    with shared as (select 1::int as value)
    select (select value from shared) as outer_value,
      (with shared as (select length(:caller::text) as value) select value from shared) as inner_value
    where :safe::int is null
  `
  )
  assert.ok(Array.isArray(output.parameters))
  assert.equal(output.parameters[1].nullBinding, 'provedNullable')
  assert.equal(output.parameters[1].nullAdmission, 'accepts')
  assert.equal(output.parameters[0].nullBinding, 'callerNullable')
  assert.equal(output.parameters[0].nullAdmission, 'unknown')
  assert.match(output.generated, /readonly outer_value: number/u)
  assert.match(output.generated, /readonly inner_value: number/u)
})

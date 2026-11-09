import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { log } from 'node:console'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const schema = `
create table probe(id integer primary key, a text, b text, c text, n integer,
  state text check(state in ('ready','queued','done')), flag boolean);
create unique index probe_lower on probe(lower(a)) where a is not null;
create table triggered(like probe including all);
create function rewrite_probe() returns trigger language plpgsql as $$
begin new.n := null; new.state := 'ready'; return new; end $$;
create trigger rewrite_probe before update on triggered for each row execute function rewrite_probe();
create table generated_probe(input integer, n integer generated always as (input) stored);
create function maybe_label(text) returns text language sql volatile strict
  as $$select case when random()>0.5 then $1 else null end$$;
create procedure noop() language plpgsql as $$begin null; end$$;
insert into probe values(1,'ready','ready','ready',4,'ready',null),
  (2,'queued','ready','queued',null,'queued',true),(3,null,null,null,-1,null,false);
insert into triggered select * from probe;
insert into generated_probe(input) values(4),(null);
`
const cases = {
  equality: "select a,b,c from probe where a=b and b=c and c='ready'",
  reverse: "select a,b,c from probe where c='ready' and b=c and a=b",
  exclusions: "select a,b,c from probe where a=b and b=c and a<>'done' and b<>'queued' and c='ready'",
  contradiction: "select a from probe where a='ready' and a='queued'",
  nullContradiction: 'select a from probe where a is null and a is not null',
  alternatives: "select a from probe where a='queued' or a='ready'",
  falseBranch: "select a from probe where false or a='ready'",
  unrelated: "select a from probe where a='ready' or b='queued'",
  nested:
    "select case when a=b then case when b='ready' then a else null end else null end as v from probe where a=b and b='ready'",
  unknown: "select case when a='ready' then a else null end as v from probe where (a='ready') is not false",
  notTrue: "select state from probe where (state='done') is not true",
  booleans: 'select true or flag as yes, false and flag as no, false or flag as maybe from probe',
  leftJoin: 'select p.a,q.b from probe p left join probe q on q.id=p.id and q.b is not null',
  fullJoin: 'select p.a,q.b from probe p full join probe q on q.id=p.id where p.a is not null or q.b is not null',
  cte: "with x as (select id,a,b from probe where a=b and a='ready') select x.a,y.b from x join probe y on y.id=x.id",
  aliases: "select x.a as left_a,y.a as right_a from probe x join probe y on x.id=y.id where x.a='ready'",
  correlated: "select a,(select q.b from probe q where q.id=p.id and q.b=p.a) as v from probe p where a='ready'",
  emptyAggregate:
    'select case when :value::text is null then null else :value end as v,count(*) as n from probe where :value is not null and false',
  having: 'select max(n) as v from probe having max(n) is not null',
  filtered: "select max(n) filter(where a='ready') as v,count(n) filter(where a='ready') as n from probe",
  distinctAggregate: 'select max(distinct n) as v from probe having max(n) is not null',
  orderedAggregate: "select array_agg(a order by id) as v from probe where a='ready'",
  grouping: 'select a,max(n) as v from probe where n is not null group by grouping sets((),(a))',
  partialIndex: "select id from probe where lower(a)='ready' and a is not null",
  collations: 'select a collate "C" as v from probe where (a collate "C")=\'ready\'',
  volatile: 'select maybe_label(a) as v from probe where maybe_label(a) is not null',
  rowLock: 'select id from probe for update',
  nestedLock: 'select * from (select id from probe for share) x',
  modifyingCte: 'with changed as (update probe set n=null returning id,n) select id,n from changed',
  call: 'call noop()',
  insertOld: "insert into probe(id,a) values(5,'done') returning old.a as old_a,new.a as new_a",
  updateImages:
    'update probe set n=null where n>0 returning old.n as old_n,new.n as new_n,(select old.n) as correlated_old,(select new.n) as correlated_new',
  deleteNew: 'delete from probe returning old.a as old_a,new.a as new_a',
  triggerRewrite:
    "update triggered set flag=true where n>0 and state='done' returning n,state,old.n as old_n,old.state as old_state",
  generatedRewrite: 'update generated_probe set input=null where n>0 returning n,old.n as old_n',
  caller: '-- @nullable value\nselect :value::integer as v',
  proved: 'select id from probe where id=:value',
  nullParam: 'select :value::integer is null as v',
}
const [firstArg, secondArg, workArg] = process.argv.slice(2)
async function inventory(root) {
  const result = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) result.push(...(await inventory(path)))
    else if (entry.isFile())
      result.push([
        path,
        createHash('sha256')
          .update(await readFile(path))
          .digest('hex'),
      ])
  }
  return result.sort(([left], [right]) => left.localeCompare(right))
}
if (firstArg === '--worker') {
  const producer = resolve(secondArg)
  const root = resolve(workArg)
  const { generateTypedSql } = await import(pathToFileURL(join(producer, 'dist/index.js')))
  const { createAnalysisDatabase } = await import(pathToFileURL(join(producer, 'dist/engine.js')))
  const { buildTypedSqlPostgresIrFromCompiledConfigs } = await import(
    pathToFileURL(join(producer, 'dist/analyzer-ir.js'))
  )
  const { compileNamedParameters, parseTypedSqlSource } = await import(
    pathToFileURL(join(producer, 'dist/sql-source.js'))
  )
  const config = {
    rootDir: root,
    schema: 'schema.sql',
    include: ['queries'],
    imports: { runtime: 'postgres-typed-sql/runtime', scalars: 'postgres-typed-sql/scalars' },
  }
  const generated = await generateTypedSql(config, { analysis: true })
  assert.equal(generated.statementCount, Object.keys(cases).length)
  const outputs = []
  for (const file of [...generated.generatedFiles, join(root, 'postgres-typed-sql.types.ts')].sort()) {
    outputs.push([file, await readFile(file, 'utf8')])
  }
  const db = await createAnalysisDatabase({ schemaFiles: [join(root, 'schema.sql')] })
  let ir
  let executed = 0
  try {
    const configs = Object.entries(cases).map(([name, source]) => {
      const compiled = compileNamedParameters(parseTypedSqlSource(source, name).sql, name)
      return { name, sourceFile: join(root, 'queries', `${name}.typed.sql`), ...compiled }
    })
    ir = await buildTypedSqlPostgresIrFromCompiledConfigs(db, configs)
    const byName = new Map(ir.queries.map((query) => [query.name, query]))
    assert.equal(byName.get('contradiction').rowBounds.max, 0)
    assert.equal(byName.get('nullContradiction').rowBounds.max, 0)
    assert.equal(byName.get('updateImages').resultColumns[0].nullability.kind, 'nonNull')
    assert.equal(byName.get('updateImages').resultColumns[1].nullability.kind, 'nullable')
    assert.equal(byName.get('generatedRewrite').resultColumns[0].nullability.kind, 'nullable')
    assert.deepEqual(byName.get('alternatives').resultColumns[0].checkConstraintType.labels, ['queued', 'ready'])
    for (const entry of configs.filter(
      (entry) => entry.parameterNames.length === 0 && entry.sql.startsWith('select')
    )) {
      const rows = (await db.query(entry.sql)).rows
      for (const column of byName.get(entry.name).resultColumns) {
        if (column.nullability.kind === 'nonNull') {
          assert.ok(
            rows.every((row) => row[column.name] !== null),
            `${entry.name}.${column.name}: false non-null proof`
          )
        }
      }
      executed += 1
    }
  } finally {
    await db.close()
  }
  const diagnostics = []
  await writeFile(join(root, 'queries/stale.typed-sql.ts'), 'previous stale output\n')
  const beforeFailure = await inventory(root)
  for (const [filename, sql] of [
    ['badColumn', 'select missing_column from probe'],
    ['badFunction', 'select no_such_function(a) from probe'],
  ]) {
    await writeFile(join(root, 'queries', `${filename}.typed.sql`), sql)
  }
  const failureInputs = await inventory(root)
  try {
    await generateTypedSql(config, { analysis: true })
    assert.fail('Invalid SQL unexpectedly generated')
  } catch (error) {
    assert.notEqual(error.message, 'Invalid SQL unexpectedly generated')
    diagnostics.push({
      name: error.name,
      message: error.message,
      errors: error.errors?.map((entry) => ({ name: entry.name, message: entry.message })),
    })
  } finally {
    const afterFailure = await inventory(root)
    for (const filename of ['badColumn', 'badFunction'])
      await rm(join(root, 'queries', `${filename}.typed.sql`), { force: true })
    assert.deepEqual(afterFailure, failureInputs, 'Failure changed inputs or outputs before cleanup')
  }
  for (const [path, contents] of outputs)
    assert.equal(await readFile(path, 'utf8'), contents, 'Failure changed a published output')
  assert.deepEqual(await inventory(root), beforeFailure, 'Failure changed the complete input/output inventory')
  log(JSON.stringify({ analysis: generated.analysis, outputs, ir, diagnostics, executed }))
} else {
  assert.ok(
    firstArg && secondArg && workArg,
    'Usage: node scripts/compare-generation.mjs BASELINE_PACKAGE CANDIDATE_PACKAGE WORK_DIRECTORY'
  )
  const root = join(resolve(workArg), 'fixture')
  await mkdir(join(root, 'queries'), { recursive: true })
  await writeFile(join(root, 'schema.sql'), schema)
  for (const [name, sql] of Object.entries(cases)) await writeFile(join(root, 'queries', `${name}.typed.sql`), sql)
  const snapshots = []
  for (const [side, producer] of [
    ['baseline', firstArg],
    ['candidate', secondArg],
  ]) {
    const child = spawnSync(process.execPath, [import.meta.filename, '--worker', resolve(producer), root], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      timeout: 120_000,
    })
    await writeFile(join(resolve(workArg), `${side}.stderr`), child.stderr)
    assert.equal(child.status, 0, `${side}: ${child.stderr}`)
    const value = JSON.parse(child.stdout)
    snapshots.push(value)
    await writeFile(join(resolve(workArg), `${side}.json`), JSON.stringify(value, null, 2))
  }
  assert.deepEqual(snapshots[1], snapshots[0], 'Full IR, generated outputs, provenance or diagnostics differ')
  const result = {
    statements: Object.keys(cases).length,
    executedSelects: snapshots[0].executed,
    invalidStatements: 2,
    errors: 0,
    irAndGenerationEqual: true,
    digest: createHash('sha256').update(JSON.stringify(snapshots[0])).digest('hex'),
  }
  await writeFile(join(resolve(workArg), 'summary.json'), JSON.stringify(result, null, 2))
  log(JSON.stringify(result))
}

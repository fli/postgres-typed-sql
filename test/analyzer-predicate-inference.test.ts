import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import test from 'node:test'

import { buildTypedSqlPostgresIrFromCompiledConfigs } from '../src/analyzer-ir.js'
import { createAnalysisDatabase } from '../src/engine.js'
import { createMinimalFixture, generateTypedSql } from './generator-test-support.js'

const schemaFile = resolve(import.meta.dirname, 'fixtures/schema.sql')
const schema = `create table public.predicate_probe (
  id integer primary key,
  score integer,
  other integer,
  label text,
  role text not null check (role in ('member', 'admin')),
  flag boolean
)`

async function analyze(cases: Readonly<Record<string, string>>) {
  const database = await createAnalysisDatabase({ schemaFiles: [schemaFile] })
  try {
    await database.query(schema)
    await database.query(
      `create function public.nonstrict_equal(integer, integer) returns boolean language sql immutable called on null input as 'select true'`
    )
    await database.query(
      `create operator public.=== (function=public.nonstrict_equal, leftarg=integer, rightarg=integer)`
    )
    await database.query(
      `create function public.equal_text(text, text) returns boolean language sql immutable strict as 'select true'`
    )
    await database.query(`create operator public.=== (function=public.equal_text, leftarg=text, rightarg=text)`)
    await database.query(
      `create function public.maybe_label(text) returns text language sql volatile strict as $$ select case when random() > 0.5 then $1 else null end $$`
    )
    const result = await buildTypedSqlPostgresIrFromCompiledConfigs(
      database,
      Object.entries(cases).map(([name, sql]) => ({ name, sql, parameterNames: [], sourceFile: `${name}.typed.sql` }))
    )
    return new Map(result.queries.map((query) => [query.name, query]))
  } finally {
    await database.close()
  }
}

test('strict predicates and CASE fallthrough narrow values without treating UNKNOWN as FALSE', async () => {
  const queries = await analyze({
    comparison: 'select score from predicate_probe where score > 0',
    strictChain: 'select label from predicate_probe where length(lower(label)) > 0',
    inList: 'select score from predicate_probe where score in (1, 2)',
    sharedOr: 'select score from predicate_probe where score > 0 or score < -1',
    splitOr: 'select score from predicate_probe where score > 0 or other > 0',
    emptyAll: 'select score from predicate_probe where score = all(array[]::integer[])',
    nonStrict: 'select score from predicate_probe where score operator(public.===) 0',
    elseGuard: 'select case when score is null then 0 else score end as value from predicate_probe',
    positiveCase: 'select case when score > 0 then score else 0 end as value from predicate_probe',
    unknownElse: 'select case when score > 0 then 0 else score end as value from predicate_probe',
    falseArm: 'select case when false then null::integer else id end as value from predicate_probe',
    nullArm: 'select case when null::boolean then null::integer else id end as value from predicate_probe',
    trueArm: 'select case when true then id else null::integer end as value from predicate_probe',
    booleanTrue: 'select flag from predicate_probe where flag is true',
    booleanNotTrue: 'select flag from predicate_probe where flag is not true',
    notNull: 'select score from predicate_probe where not (score is null)',
    repeatedImmutable:
      "select substring(label from '(x)') as value from predicate_probe where substring(label from '(x)') is not null",
    repeatedVolatile:
      'select public.maybe_label(label) as value from predicate_probe where public.maybe_label(label) is not null',
  })
  for (const name of [
    'comparison',
    'strictChain',
    'inList',
    'sharedOr',
    'elseGuard',
    'positiveCase',
    'falseArm',
    'nullArm',
    'trueArm',
    'booleanTrue',
    'notNull',
    'repeatedImmutable',
  ]) {
    assert.equal(queries.get(name)?.resultColumns[0]?.nullability.kind, 'nonNull', name)
  }
  for (const name of ['splitOr', 'emptyAll', 'nonStrict', 'unknownElse', 'booleanNotTrue', 'repeatedVolatile']) {
    assert.notEqual(queries.get(name)?.resultColumns[0]?.nullability.kind, 'nonNull', name)
  }
})

test('join facts respect preserved sides, full-join sides, and UPDATE row images', async () => {
  const queries = await analyze({
    inner: 'select p.score from predicate_probe p join predicate_probe q on p.score = q.id',
    innerExplicit: 'select p.score from predicate_probe p join predicate_probe q on p.score is not null',
    leftOn: 'select p.score from predicate_probe p left join predicate_probe q on p.score = q.id',
    nullableNested:
      'select q.score from predicate_probe p left join (predicate_probe q join predicate_probe r on q.score = r.id) on p.id = q.id',
    rowPresent: 'select q.role from predicate_probe p left join predicate_probe q on p.id = q.id where q.score > 0',
    otherNullableColumn:
      'select q.label from predicate_probe p left join predicate_probe q on p.id = q.id where q.id is not null',
    fullOtherSide:
      'select q.role from predicate_probe p full join predicate_probe q on p.id = q.id where p.id is not null',
    fullSameSide:
      'select p.role from predicate_probe p full join predicate_probe q on p.id = q.id where p.id is not null',
    updateChanged: 'update predicate_probe set score = null where score > 0 returning score',
    updateOld: 'update predicate_probe set score = null where score > 0 returning old.score',
  })
  for (const name of ['inner', 'innerExplicit', 'rowPresent', 'fullSameSide', 'updateOld']) {
    assert.equal(queries.get(name)?.resultColumns[0]?.nullability.kind, 'nonNull', name)
  }
  for (const name of ['leftOn', 'nullableNested', 'otherNullableColumn', 'fullOtherSide', 'updateChanged']) {
    assert.notEqual(queries.get(name)?.resultColumns[0]?.nullability.kind, 'nonNull', name)
  }
})

test('HAVING facts apply to the same supported aggregate and not different filters', async () => {
  const queries = await analyze({
    maxPresent: 'select max(score) from predicate_probe having max(score) is not null',
    differentArgument: 'select max(other) from predicate_probe having max(score) is not null',
    differentFilter: 'select max(score) filter (where false) from predicate_probe having max(score) is not null',
    differentDistinct: 'select array_agg(distinct score) from predicate_probe having array_agg(score) is not null',
  })
  assert.equal(queries.get('maxPresent')?.resultColumns[0]?.nullability.kind, 'nonNull')
  for (const name of ['differentArgument', 'differentFilter', 'differentDistinct']) {
    assert.notEqual(queries.get(name)?.resultColumns[0]?.nullability.kind, 'nonNull', name)
  }
})

test('finite text values propagate through predicates, CASE, COALESCE, and derived results', async () => {
  const queries = await analyze({
    narrowed: "select role from predicate_probe where role = 'admin'",
    freeText: "select label from predicate_probe where label = 'ready'",
    inList: "select label from predicate_probe where label in ('ready', 'waiting', null)",
    branches: "select case when flag then 'yes' else 'no' end as value from predicate_probe",
    coalesced: "select coalesce(role, 'guest') from predicate_probe",
    derived: "select q.role from (select role from predicate_probe where role = 'admin') q",
    falseArm: "select case when false then 'unused' else 'used' end as value",
    unconstrainedOr: "select label from predicate_probe where label = 'ready' or score > 0",
    customEquality: "select label from predicate_probe where label operator(public.===) 'ready'",
    paddedEquality: "select label from predicate_probe where label::char(8) = 'ready'::char(8)",
  })
  const expected = {
    narrowed: ['admin'],
    freeText: ['ready'],
    inList: ['ready', 'waiting'],
    branches: ['yes', 'no'],
    coalesced: ['member', 'admin'],
    derived: ['admin'],
    falseArm: ['used'],
  }
  for (const [name, labels] of Object.entries(expected)) {
    assert.deepEqual(queries.get(name)?.resultColumns[0]?.checkConstraintType, { kind: 'literalUnion', labels }, name)
  }
  assert.equal(queries.get('unconstrainedOr')?.resultColumns[0]?.checkConstraintType, undefined)
  assert.equal(queries.get('customEquality')?.resultColumns[0]?.checkConstraintType, undefined)
  assert.equal(queries.get('paddedEquality')?.resultColumns[0]?.checkConstraintType, undefined)
})

test('generated result and nested JSON types share predicate and literal proofs', async () => {
  const root = await createMinimalFixture(
    `${schema};`,
    `select
    score,
    case when score is null then 0 else score end as fallback,
    role,
    jsonb_build_object('score', score, 'role', role) as payload
    from predicate_probe where score > 0 and role = 'admin'`
  )
  await generateTypedSql({ rootDir: root, schema: 'schema.sql', include: ['queries'], codecProfile: 'node-postgres' })
  const output = await readFile(join(root, 'queries/query.typed-sql.ts'), 'utf8')
  assert.match(output, /readonly score: number\n/u)
  assert.match(output, /readonly fallback: number\n/u)
  assert.match(output, /readonly role: 'admin'\n/u)
  assert.doesNotMatch(output, /number \| null/u)
})

test('CASE narrowing agrees with PostgreSQL across all nullable boolean input combinations', async () => {
  const database = await createAnalysisDatabase({ schemaFiles: [schemaFile] })
  try {
    const cases = [
      'case when score is null or flag is unknown then 0 else score end',
      'case when score is null and flag is unknown then 0 else score end',
      'case when not (score is not null) then 0 else score end',
      'case when score > 0 and flag then score else 0 end',
      'case when score > 0 or flag then score else 0 end',
      'case when flag is not true then score else 0 end',
      'case when flag then 0 when score is null then 0 else score end',
      'case when score = all(array[]::integer[]) then score else 0 end',
    ].map((expression, index) => ({
      name: `truthCase${index}`,
      parameterNames: [],
      sourceFile: `truthCase${index}.typed.sql`,
      sql: `select ${expression} as value from (values (null::integer), (-1), (1)) s(score) cross join (values (null::boolean), (false), (true)) f(flag)`,
    }))
    const result = await buildTypedSqlPostgresIrFromCompiledConfigs(database, cases)
    let nonNullProofs = 0
    for (const [index, query] of result.queries.entries()) {
      const config = cases[index]
      assert.ok(config)
      const values = await database.query<{ value: number | null }>(config.sql)
      assert.equal(values.rows.length, 9)
      if (query.resultColumns[0]?.nullability.kind === 'nonNull') {
        nonNullProofs += 1
        assert.ok(
          values.rows.every((row) => row.value !== null),
          config.name
        )
      }
      if (values.rows.some((row) => row.value === null)) {
        assert.notEqual(query.resultColumns[0]?.nullability.kind, 'nonNull', config.name)
      }
    }
    assert.ok(nonNullProofs >= 4)
  } finally {
    await database.close()
  }
})

test('correlated RETURNING expressions use the DML owner row image', async () => {
  const database = await createAnalysisDatabase({ schemaFiles: [schemaFile] })
  try {
    await database.query(schema)
    const cases = [
      {
        name: 'insertOld',
        sql: `insert into predicate_probe(id, role) values (1, 'member') returning (select old.id) as id`,
      },
      { name: 'deleteNew', sql: 'delete from predicate_probe returning (select new.id) as id' },
      {
        name: 'updateImages',
        sql: `update predicate_probe set score = null where score > 0 returning
          (select old.id) as old_id, (select new.id) as new_id,
          (select old.score) as old_score, (select new.score) as new_score`,
      },
    ] as const
    const result = await buildTypedSqlPostgresIrFromCompiledConfigs(
      database,
      cases.map((entry) => ({ ...entry, parameterNames: [], sourceFile: `${entry.name}.typed.sql` }))
    )
    const queries = new Map(result.queries.map((query) => [query.name, query]))
    assert.equal(queries.get('insertOld')?.resultColumns[0]?.nullability.kind, 'nullable')
    assert.equal(queries.get('deleteNew')?.resultColumns[0]?.nullability.kind, 'nullable')
    assert.deepEqual(
      queries.get('updateImages')?.resultColumns.map((column) => column.nullability.kind),
      ['nonNull', 'nonNull', 'nonNull', 'nullable']
    )
    assert.deepEqual((await database.query(cases[0].sql)).rows, [{ id: null }])
    await database.query("insert into predicate_probe(id, role, score) values (2, 'member', 5)")
    assert.deepEqual((await database.query(cases[2].sql)).rows, [
      { old_id: 2, new_id: 2, old_score: 5, new_score: null },
    ])
    assert.deepEqual((await database.query(cases[1].sql)).rows, [{ id: null }, { id: null }])
  } finally {
    await database.close()
  }
})

test('UPDATE input facts do not survive trigger or generated-column rewrites', async () => {
  const database = await createAnalysisDatabase({ schemaFiles: [schemaFile] })
  try {
    for (const sql of [
      schema,
      `create function public.rewrite_predicate_row() returns trigger language plpgsql as $$
        begin new.score := null; new.role := 'member'; return new; end $$`,
      `create trigger rewrite_predicate_row before update on predicate_probe
        for each row execute function public.rewrite_predicate_row()`,
      `create table public.generated_predicate_probe(
        input integer,
        score integer generated always as (input) stored
      )`,
      'create table public.ordinary_predicate_probe(score integer, other integer, role text)',
      "insert into predicate_probe(id, score, role) values (1, 5, 'admin')",
      'insert into generated_predicate_probe(input) values (5)',
      "insert into ordinary_predicate_probe values (5, 0, 'admin')",
    ]) {
      await database.query(sql)
    }
    const cases = [
      {
        name: 'triggerRewrite',
        sql: `update predicate_probe set other = 1 where score > 0 and role = 'admin'
          returning score, role, old.score as old_score, old.role as old_role`,
      },
      {
        name: 'generatedRewrite',
        sql: `update generated_predicate_probe set input = null where score > 0
          returning score, old.score as old_score`,
      },
      {
        name: 'ordinaryUpdate',
        sql: `update ordinary_predicate_probe set other = 1 where score > 0 and role = 'admin'
          returning score, role`,
      },
    ] as const
    const result = await buildTypedSqlPostgresIrFromCompiledConfigs(
      database,
      cases.map((entry) => ({ ...entry, parameterNames: [], sourceFile: `${entry.name}.typed.sql` }))
    )
    const queries = new Map(result.queries.map((query) => [query.name, query]))
    assert.equal(queries.get('triggerRewrite')?.resultColumns[0]?.nullability.kind, 'nullable')
    assert.deepEqual(queries.get('triggerRewrite')?.resultColumns[1]?.checkConstraintType, {
      kind: 'literalUnion',
      labels: ['member', 'admin'],
    })
    assert.equal(queries.get('triggerRewrite')?.resultColumns[2]?.nullability.kind, 'nonNull')
    assert.deepEqual(queries.get('triggerRewrite')?.resultColumns[3]?.checkConstraintType, {
      kind: 'literalUnion',
      labels: ['admin'],
    })
    assert.equal(queries.get('generatedRewrite')?.resultColumns[0]?.nullability.kind, 'nullable')
    assert.equal(queries.get('generatedRewrite')?.resultColumns[1]?.nullability.kind, 'nonNull')
    assert.equal(queries.get('ordinaryUpdate')?.resultColumns[0]?.nullability.kind, 'nonNull')
    assert.deepEqual(queries.get('ordinaryUpdate')?.resultColumns[1]?.checkConstraintType, {
      kind: 'literalUnion',
      labels: ['admin'],
    })
    assert.deepEqual((await database.query(cases[0].sql)).rows, [
      { score: null, role: 'member', old_score: 5, old_role: 'admin' },
    ])
    assert.deepEqual((await database.query(cases[1].sql)).rows, [{ score: null, old_score: 5 }])
    assert.deepEqual((await database.query(cases[2].sql)).rows, [{ score: 5, role: 'admin' }])
  } finally {
    await database.close()
  }
})

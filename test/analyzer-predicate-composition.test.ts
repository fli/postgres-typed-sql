import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import test from 'node:test'

import { buildTypedSqlPostgresIrFromCompiledConfigs, type TypedSqlPostgresIr } from '../src/analyzer-ir.js'
import { createAnalysisDatabase } from '../src/engine.js'

function requireQuery(queries: ReadonlyMap<string, TypedSqlPostgresIr>, name: string): TypedSqlPostgresIr {
  const query = queries.get(name)
  assert.ok(query, name)
  return query
}

const schemaFile = resolve(import.meta.dirname, 'fixtures/schema.sql')

test('composes text alternatives, exclusions, equality chains, and repeated CASE conditions', async () => {
  const database = await createAnalysisDatabase({ schemaFiles: [schemaFile] })
  try {
    await database.query(`create table composition_probe(a text, b text, c text, flag boolean,
      state text check(state in ('ready', 'queued', 'done')))`)
    const cases = {
      alternatives: "select a from composition_probe where a='ready' or a='queued'",
      chain: "select a,b,c from composition_probe where a=b and b=c and c='ready'",
      reverseChain: "select a from composition_probe where c='ready' and b=c and a=b",
      excluded: "select state from composition_probe where state <> 'done'",
      notEqual: "select state from composition_probe where not (state = 'done')",
      contradictory: "select a from composition_probe where a='ready' and a='queued'",
      checkContradiction: "select state from composition_probe where state='missing'",
      excludedAll: "select state from composition_probe where state<>'ready' and state<>'queued' and state<>'done'",
      falseFilter: 'select a from composition_probe where false',
      nullFilter: 'select a from composition_probe where null::boolean',
      nullContradiction: 'select a from composition_probe where a is null and a is not null',
      impossibleAlternative: "select a from composition_probe where false or a='ready'",
      repeatedCase: "select case when a='ready' then 1 else null end from composition_probe where a='ready'",
      impliedCase: "select case when a='ready' then 1 else null end from composition_probe where a=b and b='ready'",
      unknownCase:
        "select case when a='ready' then 1 else null end from composition_probe where a='ready' or a is null",
      unrelatedOr: "select a from composition_probe where a='ready' or b='queued'",
      booleanConstants:
        'select true or flag as yes, false and flag as no, false or flag as maybe from composition_probe',
      negativeUnknown: "select state from composition_probe where (state='done') is not true",
    }
    const result = await buildTypedSqlPostgresIrFromCompiledConfigs(
      database,
      Object.entries(cases).map(([name, sql]) => ({ name, sql, parameterNames: [], sourceFile: `${name}.typed.sql` }))
    )
    const queries = new Map(result.queries.map((query) => [query.name, query]))
    for (const name of ['chain', 'reverseChain', 'impossibleAlternative']) {
      for (const column of requireQuery(queries, name).resultColumns)
        assert.deepEqual(column.checkConstraintType, { kind: 'literalUnion', labels: ['ready'] }, name)
    }
    assert.deepEqual(requireQuery(queries, 'alternatives').resultColumns[0]?.checkConstraintType, {
      kind: 'literalUnion',
      labels: ['ready', 'queued'],
    })
    for (const name of ['excluded', 'notEqual'])
      assert.deepEqual(
        requireQuery(queries, name).resultColumns[0]?.checkConstraintType,
        { kind: 'literalUnion', labels: ['ready', 'queued'] },
        name
      )
    for (const name of [
      'contradictory',
      'checkContradiction',
      'excludedAll',
      'falseFilter',
      'nullFilter',
      'nullContradiction',
    ])
      assert.equal(requireQuery(queries, name).rowBounds.max, 0, name)
    for (const name of ['repeatedCase', 'impliedCase'])
      assert.equal(requireQuery(queries, name).resultColumns[0]?.nullability.kind, 'nonNull', name)
    assert.notEqual(requireQuery(queries, 'unknownCase').resultColumns[0]?.nullability.kind, 'nonNull')
    assert.equal(requireQuery(queries, 'unrelatedOr').resultColumns[0]?.checkConstraintType, undefined)
    assert.deepEqual(
      requireQuery(queries, 'booleanConstants').resultColumns.map((column) => column.nullability.kind),
      ['nonNull', 'nonNull', 'nullable']
    )
    assert.deepEqual(requireQuery(queries, 'negativeUnknown').resultColumns[0]?.checkConstraintType, {
      kind: 'literalUnion',
      labels: ['ready', 'queued', 'done'],
    })
    await database.query(`insert into composition_probe values
      ('ready','ready','ready',null,'ready'), ('queued','ready','queued',true,'queued'), (null,null,null,false,null)`)
    for (const name of ['repeatedCase', 'impliedCase', 'booleanConstants']) {
      const rows = (await database.query<Record<string, unknown>>(cases[name as keyof typeof cases])).rows
      assert.ok(rows.length > 0)
      for (const column of requireQuery(queries, name).resultColumns) {
        if (column.nullability.kind === 'nonNull')
          assert.ok(
            rows.every((row) => row[column.name ?? ''] !== null),
            `${name}:${column.name}`
          )
      }
    }
  } finally {
    await database.close()
  }
})

test('validated inherited CHECKs prove result non-nullability without trusting UNKNOWN or unenforced checks', async () => {
  const database = await createAnalysisDatabase({ schemaFiles: [schemaFile] })
  try {
    for (const sql of [
      'create table check_result_probe(id integer primary key, checked integer check(checked is not null), positive integer check(positive > 0), disjunction integer, flag boolean, check(disjunction is not null or flag))',
      'create table check_result_child() inherits(check_result_probe)',
      'create table check_result_unvalidated(value integer)',
      'alter table check_result_unvalidated add check(value is not null) not valid',
      'create table check_result_unenforced(value integer check(value is not null) not enforced)',
      'create table check_result_parent(value integer check(value is not null) no inherit)',
      'create table check_result_descendant() inherits(check_result_parent)',
    ])
      await database.query(sql)
    const cases = {
      ordinary: 'select checked, positive, disjunction from check_result_probe',
      child: 'select checked from check_result_child',
      outer: 'select b.checked from check_result_probe a left join check_result_probe b on false',
      absentReturning: 'insert into check_result_probe(id,checked) values(1,1) returning old.checked',
      unvalidated: 'select value from check_result_unvalidated',
      unenforced: 'select value from check_result_unenforced',
      noInherit: 'select value from check_result_parent',
    }
    const result = await buildTypedSqlPostgresIrFromCompiledConfigs(
      database,
      Object.entries(cases).map(([name, sql]) => ({ name, sql, parameterNames: [], sourceFile: `${name}.typed.sql` }))
    )
    const queries = new Map(result.queries.map((query) => [query.name, query]))
    assert.deepEqual(
      requireQuery(queries, 'ordinary').resultColumns.map((column) => column.nullability.kind),
      ['nonNull', 'nullable', 'nullable']
    )
    assert.equal(requireQuery(queries, 'child').resultColumns[0]?.nullability.kind, 'nonNull')
    for (const name of ['outer', 'absentReturning', 'unvalidated', 'unenforced', 'noInherit'])
      assert.notEqual(requireQuery(queries, name).resultColumns[0]?.nullability.kind, 'nonNull', name)
    await database.query('insert into check_result_descendant values(null)')
    assert.deepEqual((await database.query(cases.noInherit)).rows, [{ value: null }])
    await database.query('insert into check_result_unenforced values(null)')
    assert.deepEqual((await database.query(cases.unenforced)).rows, [{ value: null }])
  } finally {
    await database.close()
  }
})

test('empty aggregate groups do not inherit WHERE facts into result CASE or grouping columns', async () => {
  const database = await createAnalysisDatabase({ schemaFiles: [schemaFile] })
  try {
    const cases = {
      global:
        "select case when $1::boolean then 'yes' else 'no' end as label, count(*) from accounts where $1::boolean",
      grouping:
        "select id, case when $1::boolean then 'yes' else 'no' end as label, count(*) from accounts where $1::boolean group by grouping sets ((id),())",
      inputProof:
        'select sum(value) from (values(null::integer),(1)) v(value) where value is not null having count(*)>0',
    }
    const result = await buildTypedSqlPostgresIrFromCompiledConfigs(
      database,
      Object.entries(cases).map(([name, sql]) => ({
        name,
        sql,
        parameterNames: name === 'inputProof' ? [] : ['flag'],
        sourceFile: `${name}.typed.sql`,
      }))
    )
    const queries = new Map(result.queries.map((query) => [query.name, query]))
    assert.deepEqual(requireQuery(queries, 'global').resultColumns[0]?.checkConstraintType, {
      kind: 'literalUnion',
      labels: ['yes', 'no'],
    })
    assert.deepEqual(requireQuery(queries, 'grouping').resultColumns[1]?.checkConstraintType, {
      kind: 'literalUnion',
      labels: ['yes', 'no'],
    })
    assert.notEqual(requireQuery(queries, 'grouping').resultColumns[0]?.nullability.kind, 'nonNull')
    assert.equal(requireQuery(queries, 'inputProof').resultColumns[0]?.nullability.kind, 'nonNull')
    assert.deepEqual((await database.query(cases.global, [false])).rows, [{ label: 'no', count: 0 }])
    assert.deepEqual((await database.query(cases.grouping, [false])).rows, [{ id: null, label: 'no', count: 0 }])
  } finally {
    await database.close()
  }
})

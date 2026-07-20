import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import test from 'node:test'

import {
  buildTypedSqlPostgresIrFromCompiledConfigs,
  type TypedSqlPostgresIr,
  type TypedSqlPostgresIrCompiledConfig,
  type TypedSqlPostgresIrJsonShape,
} from '../src/analyzer-ir.js'
import { createAnalysisDatabase } from '../src/engine.js'

const schemaFile = resolve(import.meta.dirname, 'fixtures/schema.sql')

function config(name: string, sql: string, parameterNames: readonly string[] = []): TypedSqlPostgresIrCompiledConfig {
  return { name, parameterNames, sourceFile: `queries/${name}.typed.sql`, sql }
}

function objectFields(query: TypedSqlPostgresIr): ReadonlyMap<string, TypedSqlPostgresIrJsonShape> {
  const shape = query.resultColumns[0]?.jsonShape
  assert.equal(shape?.kind, 'object')
  return new Map(shape.kind === 'object' ? shape.fields.map((field) => [field.name, field.shape]) : [])
}

test('proves range endpoints only from nonempty finite-bound predicates', async () => {
  const database = await createAnalysisDatabase({ schemaFiles: [schemaFile] })
  try {
    await database.query('create table public.range_nullability_probe (value int4range not null)')
    const result = await buildTypedSqlPostgresIrFromCompiledConfigs(database, [
      config(
        'nonemptyOnly',
        `select jsonb_build_object('lower', lower(value), 'upper', upper(value)) as payload
         from public.range_nullability_probe
         where not isempty(value)`
      ),
      config(
        'finiteLower',
        `select jsonb_build_object('lower', lower(value), 'upper', upper(value)) as payload
         from public.range_nullability_probe
         where not isempty(value) and not lower_inf(value)`
      ),
      config(
        'finiteUpper',
        `select jsonb_build_object('lower', lower(value), 'upper', upper(value)) as payload
         from public.range_nullability_probe
         where not isempty(value) and not upper_inf(value)`
      ),
      config(
        'finiteBoth',
        `select jsonb_build_object('lower', lower(value), 'upper', upper(value)) as payload
         from public.range_nullability_probe
         where not isempty(value) and not lower_inf(value) and not upper_inf(value)`
      ),
      config(
        'directEndpointTest',
        `select lower(value) as lower
         from public.range_nullability_probe
         where lower(value) is not null`
      ),
      config(
        'caseArm',
        `select case
           when not isempty(value) and not lower_inf(value) then lower(value)
           else 0
         end as lower
         from public.range_nullability_probe`
      ),
      config(
        'derivedFiniteRange',
        `with finite_range as (
           select value
           from public.range_nullability_probe
           where not isempty(value) and not lower_inf(value)
         )
         select lower(value) as lower
         from finite_range`
      ),
    ])
    const queries = new Map(result.queries.map((query) => [query.name, query]))
    const fields = (name: string) => {
      const query = queries.get(name)
      assert.ok(query)
      return objectFields(query)
    }

    assert.equal(fields('nonemptyOnly').get('lower')?.nullability.kind, 'nullable')
    assert.equal(fields('nonemptyOnly').get('upper')?.nullability.kind, 'nullable')
    assert.equal(fields('finiteLower').get('lower')?.nullability.kind, 'nonNull')
    assert.equal(fields('finiteLower').get('upper')?.nullability.kind, 'nullable')
    assert.equal(fields('finiteUpper').get('lower')?.nullability.kind, 'nullable')
    assert.equal(fields('finiteUpper').get('upper')?.nullability.kind, 'nonNull')
    assert.equal(fields('finiteBoth').get('lower')?.nullability.kind, 'nonNull')
    assert.equal(fields('finiteBoth').get('upper')?.nullability.kind, 'nonNull')
    assert.deepEqual(queries.get('directEndpointTest')?.resultColumns[0]?.nullability, {
      basis: 'where_function_is_not_null',
      kind: 'nonNull',
    })
    assert.equal(queries.get('caseArm')?.resultColumns[0]?.nullability.kind, 'nonNull')
    assert.equal(queries.get('derivedFiniteRange')?.resultColumns[0]?.nullability.kind, 'nonNull')
  } finally {
    await database.close()
  }
})

test('does not derive range facts from user-defined lookalike functions', async () => {
  const database = await createAnalysisDatabase({ schemaFiles: [schemaFile] })
  try {
    await database.query('create table public.range_identity_probe (value int4range not null)')
    await database.query(`create function public.isempty(int4range) returns boolean
      language sql immutable strict
      as $$ select false $$`)
    await database.query(`create function public.lower(int4range) returns integer
      language sql immutable strict
      as $$ select 1 $$`)
    const result = await buildTypedSqlPostgresIrFromCompiledConfigs(database, [
      config(
        'customPredicate',
        `select pg_catalog.lower(value) as lower
         from public.range_identity_probe
         where not public.isempty(value) and not pg_catalog.lower_inf(value)`
      ),
      config(
        'customEndpoint',
        `select public.lower(value) as lower
         from public.range_identity_probe
         where not pg_catalog.isempty(value) and not pg_catalog.lower_inf(value)`
      ),
    ])
    const queries = new Map(result.queries.map((query) => [query.name, query]))
    assert.equal(queries.get('customPredicate')?.resultColumns[0]?.nullability.kind, 'nullable')
    assert.equal(queries.get('customEndpoint')?.resultColumns[0]?.nullability.kind, 'unknown')
  } finally {
    await database.close()
  }
})

test('intersects range facts across OR branches and does not combine branch-local facts', async () => {
  const database = await createAnalysisDatabase({ schemaFiles: [schemaFile] })
  try {
    await database.query('create table public.range_branch_probe (value int4range not null)')
    const result = await buildTypedSqlPostgresIrFromCompiledConfigs(database, [
      config(
        'sharedFacts',
        `select lower(value) as lower
         from public.range_branch_probe
         where (not isempty(value) and not lower_inf(value) and $1)
            or (not isempty(value) and not lower_inf(value) and not $1)`,
        ['choose']
      ),
      config(
        'splitFacts',
        `select lower(value) as lower
         from public.range_branch_probe
         where (not isempty(value) and $1)
            or (not lower_inf(value) and not $1)`,
        ['choose']
      ),
    ])
    const queries = new Map(result.queries.map((query) => [query.name, query]))
    assert.equal(queries.get('sharedFacts')?.resultColumns[0]?.nullability.kind, 'nonNull')
    assert.equal(queries.get('splitFacts')?.resultColumns[0]?.nullability.kind, 'nullable')
  } finally {
    await database.close()
  }
})

test('does not inherit range facts across null-extending join boundaries', async () => {
  const database = await createAnalysisDatabase({ schemaFiles: [schemaFile] })
  try {
    await database.query(
      'create table public.range_outer_join_probe (id integer primary key, value int4range not null)'
    )
    const result = await buildTypedSqlPostgresIrFromCompiledConfigs(database, [
      config(
        'nullableOuterJoinRange',
        `select lower(source.value) as lower
         from (values (1), (2)) as requested(id)
         left join (
           select id, value
           from public.range_outer_join_probe
           where not isempty(value) and not lower_inf(value)
         ) as source on source.id = requested.id`
      ),
      config(
        'refinedAfterOuterJoin',
        `select lower(source.value) as lower
         from (values (1), (2)) as requested(id)
         left join (
           select id, value
           from public.range_outer_join_probe
           where not isempty(value) and not lower_inf(value)
         ) as source on source.id = requested.id
         where lower(source.value) is not null`
      ),
    ])
    const queries = new Map(result.queries.map((query) => [query.name, query]))
    assert.equal(queries.get('nullableOuterJoinRange')?.resultColumns[0]?.nullability.kind, 'nullable')
    assert.deepEqual(queries.get('refinedAfterOuterJoin')?.resultColumns[0]?.nullability, {
      basis: 'where_function_is_not_null',
      kind: 'nonNull',
    })
  } finally {
    await database.close()
  }
})

test('folds range facts according to every set-operation arm', async () => {
  const database = await createAnalysisDatabase({ schemaFiles: [schemaFile] })
  try {
    await database.query('create table public.range_set_operation_probe (id integer, value int4range not null)')
    const result = await buildTypedSqlPostgresIrFromCompiledConfigs(database, [
      config(
        'mixedUnionAll',
        `select lower(source.value) as lower
         from (
           select value
           from public.range_set_operation_probe
           where id = 1 and not isempty(value) and not lower_inf(value)
           union all
           select value
           from public.range_set_operation_probe
           where id = 2
         ) as source`
      ),
      config(
        'provenUnion',
        `select lower(source.value) as lower
         from (
           select value
           from public.range_set_operation_probe
           where id = 1 and not isempty(value) and not lower_inf(value)
           union
           select value
           from public.range_set_operation_probe
           where id = 2 and not isempty(value) and not lower_inf(value)
         ) as source`
      ),
      config(
        'provenIntersection',
        `select lower(source.value) as lower
         from (
           select value
           from public.range_set_operation_probe
           where id = 1 and not isempty(value) and not lower_inf(value)
           intersect
           select value
           from public.range_set_operation_probe
           where id = 2
         ) as source`
      ),
      config(
        'provenExcept',
        `select lower(source.value) as lower
         from (
           select value
           from public.range_set_operation_probe
           where id = 1 and not isempty(value) and not lower_inf(value)
           except
           select value
           from public.range_set_operation_probe
           where id = 2
         ) as source`
      ),
    ])
    const queries = new Map(result.queries.map((query) => [query.name, query]))
    assert.equal(queries.get('mixedUnionAll')?.resultColumns[0]?.nullability.kind, 'nullable')
    assert.equal(queries.get('provenUnion')?.resultColumns[0]?.nullability.kind, 'nonNull')
    assert.equal(queries.get('provenIntersection')?.resultColumns[0]?.nullability.kind, 'nonNull')
    assert.equal(queries.get('provenExcept')?.resultColumns[0]?.nullability.kind, 'nonNull')
  } finally {
    await database.close()
  }
})

test('keeps pre-update predicate facts separate from post-assignment RETURNING values', async () => {
  const database = await createAnalysisDatabase({ schemaFiles: [schemaFile] })
  try {
    await database.query(`create table public.range_update_probe (
      id integer primary key,
      value int4range not null,
      unchanged_value int4range not null
    )`)
    const result = await buildTypedSqlPostgresIrFromCompiledConfigs(database, [
      config(
        'changedRange',
        `update public.range_update_probe
         set value = 'empty'::int4range
         where not isempty(value) and not lower_inf(value)
         returning lower(value) as lower`
      ),
      config(
        'changedRangeOldImage',
        `update public.range_update_probe
         set value = 'empty'::int4range
         where not isempty(value) and not lower_inf(value)
         returning lower(OLD.value) as lower`
      ),
      config(
        'changedRangeNewImage',
        `update public.range_update_probe
         set value = 'empty'::int4range
         where not isempty(value) and not lower_inf(value)
         returning lower(NEW.value) as lower`
      ),
      config(
        'changedRangeWithDirectEndpointFact',
        `update public.range_update_probe
         set value = 'empty'::int4range
         where lower(value) is not null
         returning lower(value) as lower`
      ),
      config(
        'unchangedRange',
        `update public.range_update_probe
         set value = 'empty'::int4range
         where not isempty(unchanged_value) and not lower_inf(unchanged_value)
         returning lower(unchanged_value) as lower`
      ),
    ])
    const queries = new Map(result.queries.map((query) => [query.name, query]))
    assert.equal(queries.get('changedRange')?.resultColumns[0]?.nullability.kind, 'nullable')
    assert.equal(queries.get('changedRangeOldImage')?.resultColumns[0]?.nullability.kind, 'nonNull')
    assert.equal(queries.get('changedRangeNewImage')?.resultColumns[0]?.nullability.kind, 'nullable')
    assert.equal(queries.get('changedRangeWithDirectEndpointFact')?.resultColumns[0]?.nullability.kind, 'nullable')
    assert.equal(queries.get('unchangedRange')?.resultColumns[0]?.nullability.kind, 'nonNull')
  } finally {
    await database.close()
  }
})

test('models available and unavailable PostgreSQL RETURNING row images', async () => {
  const database = await createAnalysisDatabase({ schemaFiles: [schemaFile] })
  try {
    await database.query('create table public.range_returning_probe (id integer primary key, value int4range not null)')
    const result = await buildTypedSqlPostgresIrFromCompiledConfigs(database, [
      config(
        'deleteNewRange',
        `delete from public.range_returning_probe
         where not isempty(value) and not lower_inf(value)
         returning lower(NEW.value) as lower`
      ),
      config(
        'deleteOldRange',
        `delete from public.range_returning_probe
         where not isempty(value) and not lower_inf(value)
         returning lower(OLD.value) as lower`
      ),
      config('deleteNewColumn', 'delete from public.range_returning_probe returning NEW.id as id'),
      config('deleteDefaultColumn', 'delete from public.range_returning_probe returning id'),
      config(
        'insertOldColumn',
        `insert into public.range_returning_probe values (1, '[1,3)'::int4range)
         returning OLD.id as id`
      ),
      config(
        'insertDefaultColumn',
        `insert into public.range_returning_probe values (1, '[1,3)'::int4range)
         returning id`
      ),
    ])
    const queries = new Map(result.queries.map((query) => [query.name, query]))
    assert.equal(queries.get('deleteNewRange')?.resultColumns[0]?.nullability.kind, 'nullable')
    assert.equal(queries.get('deleteOldRange')?.resultColumns[0]?.nullability.kind, 'nonNull')
    assert.deepEqual(queries.get('deleteNewColumn')?.resultColumns[0]?.nullability, {
      evidence: 'returning_new_row_unavailable',
      kind: 'nullable',
    })
    assert.equal(queries.get('deleteDefaultColumn')?.resultColumns[0]?.nullability.kind, 'nonNull')
    assert.deepEqual(queries.get('insertOldColumn')?.resultColumns[0]?.nullability, {
      evidence: 'returning_old_row_unavailable',
      kind: 'nullable',
    })
    assert.equal(queries.get('insertDefaultColumn')?.resultColumns[0]?.nullability.kind, 'nonNull')

    await database.query("insert into public.range_returning_probe values (10, '[1,3)'::int4range)")
    const deleted = await database.query<{ readonly id: number | null; readonly lower: number | null }>(
      `delete from public.range_returning_probe
       where id = 10 and not isempty(value) and not lower_inf(value)
       returning NEW.id as id, lower(NEW.value) as lower`
    )
    assert.deepEqual(deleted.rows, [{ id: null, lower: null }])
    const inserted = await database.query<{ readonly id: number | null }>(
      `insert into public.range_returning_probe values (11, '[1,3)'::int4range)
       returning OLD.id as id`
    )
    assert.deepEqual(inserted.rows, [{ id: null }])
  } finally {
    await database.close()
  }
})

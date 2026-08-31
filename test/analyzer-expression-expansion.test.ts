import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import test from 'node:test'

import { buildTypedSqlPostgresIrFromCompiledConfigs } from '../src/analyzer-ir.js'
import { createAnalysisDatabase, type AnalysisDatabase } from '../src/engine.js'

const schemaFile = resolve(import.meta.dirname, 'fixtures/schema.sql')

async function withDatabase(run: (database: AnalysisDatabase) => Promise<void>): Promise<void> {
  const database = await createAnalysisDatabase({ schemaFiles: [schemaFile] })
  try {
    await database.query(`create table public.expanded_expression_inputs (
      id bigint not null, qty integer not null, amount numeric not null,
      ratio double precision not null, optional integer,
      status text not null check (status in ('a', 'b'))
    )`)
    await database.query(
      "insert into public.expanded_expression_inputs values (1,1,1.5,1.5,null,'a'), (2,2,2.5,2.5,4,'b')"
    )
    await run(database)
  } finally {
    await database.close()
  }
}

async function analyze(database: AnalysisDatabase, queries: Readonly<Record<string, string>>) {
  const result = await buildTypedSqlPostgresIrFromCompiledConfigs(
    database,
    Object.entries(queries).map(([name, sql]) => ({ name, sql, parameterNames: [], sourceFile: `${name}.sql` }))
  )
  return new Map(result.queries.map((query) => [query.name, query]))
}

test('mixed numeric arithmetic, numeric-family casts, and audited zero-argument calls return non-null values', async () => {
  await withDatabase(async (database) => {
    await database.query(
      "create function public.random() returns double precision language sql volatile as 'select null::double precision'"
    )
    const result = await analyze(database, {
      scalars: `select id + 1 as incremented, id - qty as difference, qty * id as product,
        id / qty as divided, id > qty as comparison,
        amount * 1.2 as numeric_product, amount % 2 as remainder, ratio + 1 as float_sum,
        ratio * 2::real as mixed_float, qty::numeric as numeric_cast,
        amount::double precision as float_cast, ratio::numeric as decimal_cast,
        amount::integer as integer_cast, optional::numeric as nullable_cast,
        now() as transaction_time, pg_catalog.random() as random_value,
        gen_random_uuid() as uuid_value, public.random() as custom_random
        from public.expanded_expression_inputs`,
    })
    const kinds = result.get('scalars')?.resultColumns.map((column) => column.nullability.kind)
    assert.deepEqual(kinds, [
      ...Array<string>(13).fill('nonNull'),
      'nullable',
      'nonNull',
      'nonNull',
      'nonNull',
      'unknown',
    ])
    assert.equal((await database.query<{ value: null }>('select public.random() as value')).rows[0]?.value, null)
  })
})

test('aggregate input presence includes ordered inputs and positive counts without conflating empty filters', async () => {
  await withDatabase(async (database) => {
    await database.query(
      "create function public.unknown_value() returns integer language sql volatile as 'select null::integer'"
    )
    const queries = {
      values: 'select max(v), sum(v), array_agg(v) from (values (1),(2)) source(v)',
      noFrom: 'select sum(1), max(2)',
      cte: 'with source as (select 1 as v) select max(v) from source',
      ordered: `select array_agg(optional order by id), sum(qty order by id), string_agg(status, null order by id)
        from public.expanded_expression_inputs group by qty`,
      counted: 'select max(optional), sum(optional) from public.expanded_expression_inputs having count(optional)>0',
      distinctCounted: 'select max(optional) from public.expanded_expression_inputs having count(distinct optional)>=1',
      reversedCount: 'select max(optional) from public.expanded_expression_inputs having 0<count(optional)',
      negatedCount: 'select max(optional) from public.expanded_expression_inputs having not(count(optional)=0)',
      filtered: `select sum(optional) filter (where qty>1) from public.expanded_expression_inputs
        having count(optional) filter (where qty>1)>0`,
      filteredCountStar: `select sum(optional) filter (where optional is not null) from public.expanded_expression_inputs
        having count(*) filter (where optional is not null)>0`,
      empty: 'select sum(qty) from public.expanded_expression_inputs where false having count(*)=0',
      limitedEmpty: 'select sum(v) from (select 1 as v limit 0) source',
      nullableInput:
        'select max(optional) from public.expanded_expression_inputs where optional is null having count(*)>0',
      mismatchedFilter: `select sum(optional) filter (where qty<0) from public.expanded_expression_inputs
        having count(optional) filter (where qty>1)>0`,
      disjunctive: 'select sum(qty) from public.expanded_expression_inputs where false having count(*)>0 or true',
      volatileInput:
        'select max(public.unknown_value()) from public.expanded_expression_inputs having count(public.unknown_value())>0',
    }
    const result = await analyze(database, queries)
    for (const name of [
      'values',
      'noFrom',
      'cte',
      'ordered',
      'counted',
      'distinctCounted',
      'reversedCount',
      'negatedCount',
      'filtered',
      'filteredCountStar',
    ]) {
      assert.ok(
        result.get(name)?.resultColumns.every((column) => column.nullability.kind === 'nonNull'),
        name
      )
    }
    for (const name of ['empty', 'limitedEmpty', 'nullableInput', 'mismatchedFilter', 'disjunctive', 'volatileInput']) {
      assert.equal(result.get(name)?.resultColumns[0]?.nullability.kind, 'unknown', name)
    }
    for (const name of ['empty', 'limitedEmpty', 'nullableInput', 'mismatchedFilter', 'disjunctive'] as const) {
      const row = (await database.query<Record<string, unknown>>(queries[name])).rows[0]
      assert.equal(Object.values(row ?? {})[0], null, name)
    }
    assert.deepEqual((await database.query(queries.filtered)).rows, [{ sum: 4 }])
  })
})

test('defaulted and frame-aware windows retain null guards for offsets, filters, and excluded rows', async () => {
  await withDatabase(async (database) => {
    const sql = `select
      percent_rank() over () as percentile, cume_dist() over () as cumulative,
      lag(qty,1,0) over (order by id) as previous_default,
      lead(qty,1,0) over (order by id) as next_default,
      lag(qty,0) over () as current_value,
      first_value(qty) over (order by id) as first,
      last_value(qty) over (order by id) as last,
      nth_value(qty,1) over (order by id) as first_nth,
      sum(qty) over () as total, array_agg(optional) over () as values,
      ntile(2) over () as bucket,
      lag(qty,null::integer,0) over () as null_offset,
      lag(optional,0) over () as nullable_current,
      lag(qty) over (order by id) as no_default,
      nth_value(qty,2) over (order by id) as possibly_missing_nth,
      sum(qty) filter (where false) over () as filtered,
      first_value(qty) over (order by id rows between 1 preceding and 1 preceding) as empty_first
      from public.expanded_expression_inputs order by id`
    const result = await analyze(database, { windows: sql })
    assert.deepEqual(
      result.get('windows')?.resultColumns.map((column) => column.nullability.kind),
      [...Array<string>(11).fill('nonNull'), 'nullable', 'nullable', ...Array<string>(4).fill('unknown')]
    )
    const first = (await database.query<Record<string, unknown>>(sql)).rows[0]
    for (const name of [
      'null_offset',
      'nullable_current',
      'no_default',
      'possibly_missing_nth',
      'filtered',
      'empty_first',
    ]) {
      assert.equal(first?.[name], null, name)
    }
    const excluded = `select first_value(qty) over (rows between unbounded preceding and unbounded following exclude current row)
      from public.expanded_expression_inputs where id=1`
    assert.equal((await analyze(database, { excluded })).get('excluded')?.resultColumns[0]?.nullability.kind, 'unknown')
    assert.deepEqual((await database.query(excluded)).rows, [{ first_value: null }])
  })
})

test('window values distinguish current-row CASE facts from facts shared by every partition row', async () => {
  await withDatabase(async (database) => {
    const queries = {
      currentCase: `select id,
        case when x is not null then first_value(x) over(order by id rows between unbounded preceding and unbounded following) else 0 end as first,
        case when x is not null then last_value(x) over(order by id rows between unbounded preceding and unbounded following) else 0 end as last,
        case when x is not null then nth_value(x,1) over(order by id) else 0 end as nth,
        case when x is not null then lag(x,1,0) over(order by id) else 0 end as previous,
        case when x is not null then lead(x,1,0) over(order by id) else 0 end as next,
        case when x is not null then lag(x,0) over(order by id) else 0 end as current,
        case when x is not null then sum(x) over(order by id rows between unbounded preceding and current row) else 0 end as total
        from (values(1,null::int),(2,1),(3,null::int)) v(id,x) order by id`,
      whereScoped: `select first_value(x) over(order by id), lag(x,1,0) over(order by id)
        from (values(1,null::int),(2,1)) v(id,x) where x is not null`,
      havingScoped: `select first_value(max(x)) over(order by id), lag(max(x),1,0) over(order by id)
        from (values(1,null::int),(2,1)) v(id,x) group by id having max(x) is not null`,
      correlated: `select case when source.x is not null then (
        select first_value(source.x) over(order by position) from (values(1),(2)) v(position) limit 1
        ) else 0 end as value from (values(null::int),(1)) source(x)`,
      groupingSets: `select case when id is not null then first_value(id) over(order by id nulls first) else 0 end as value
        from (values(1),(2)) v(id) group by grouping sets((id),())`,
    }
    const result = await analyze(database, queries)
    assert.deepEqual(
      result.get('currentCase')?.resultColumns.map((column) => column.nullability.kind),
      ['nonNull', ...Array<string>(5).fill('unknown'), 'nonNull', 'nonNull']
    )
    const currentRows = (await database.query(queries.currentCase)).rows
    assert.deepEqual(currentRows[1], {
      id: 2,
      first: null,
      last: null,
      nth: null,
      previous: null,
      next: null,
      current: 1,
      total: 1,
    })
    for (const name of ['whereScoped', 'havingScoped', 'correlated']) {
      assert.ok(
        result.get(name)?.resultColumns.every((column) => column.nullability.kind === 'nonNull'),
        name
      )
    }
    assert.equal(result.get('groupingSets')?.resultColumns[0]?.nullability.kind, 'unknown')
    assert.deepEqual((await database.query(queries.groupingSets)).rows, [
      { value: 0 },
      { value: null },
      { value: null },
    ])
    assert.deepEqual((await database.query(queries.correlated)).rows, [{ value: 0 }, { value: 1 }])
  })
})

test('distinctness audits equality while NULLIF preserves its parsed first argument when equality cannot match', async () => {
  await withDatabase(async (database) => {
    const result = await analyze(database, {
      ordinary: `select qty is distinct from optional, qty is not distinct from optional,
        nullif(qty,null::integer), nullif(1,2), nullif(status,'missing'), nullif(status,'a')
        from public.expanded_expression_inputs`,
    })
    assert.deepEqual(
      result.get('ordinary')?.resultColumns.map((column) => column.nullability.kind),
      ['nonNull', 'nonNull', 'nonNull', 'nonNull', 'nonNull', 'nullable']
    )
    await database.query("create type public.expression_guard_enum as enum ('a','b')")
    await database.query(`create function public.expression_guard_eq(public.expression_guard_enum, public.expression_guard_enum)
      returns boolean language sql immutable strict as 'select null::boolean'`)
    await database.query(`create operator public.= (
      leftarg=public.expression_guard_enum, rightarg=public.expression_guard_enum, function=public.expression_guard_eq
    )`)
    await database.query('set search_path = public, pg_catalog')
    const distinct = "select 'a'::expression_guard_enum is distinct from 'a'::expression_guard_enum as value"
    assert.equal((await analyze(database, { distinct })).get('distinct')?.resultColumns[0]?.nullability.kind, 'unknown')
    assert.deepEqual((await database.query(distinct)).rows, [{ value: null }])
    await database.query(`create or replace function public.expression_guard_eq(public.expression_guard_enum, public.expression_guard_enum)
      returns boolean language sql immutable called on null input as 'select true'`)
    const nullif = "select nullif('a'::expression_guard_enum,null::expression_guard_enum) as value"
    assert.equal((await analyze(database, { nullif })).get('nullif')?.resultColumns[0]?.nullability.kind, 'nonNull')
    assert.deepEqual((await database.query(nullif)).rows, [{ value: 'a' }])
  })
})

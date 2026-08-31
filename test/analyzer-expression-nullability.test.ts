import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import test from 'node:test'

import { buildTypedSqlPostgresIrFromCompiledConfigs } from '../src/analyzer-ir.js'
import { createAnalysisDatabase, type AnalysisDatabase } from '../src/engine.js'
import { targetExprFromAggregateArg, type PgAnalyzerResult } from '../src/postgres-analyzer-model.js'

const schemaFile = resolve(import.meta.dirname, 'fixtures/schema.sql')

async function withDatabase(run: (database: AnalysisDatabase) => Promise<void>): Promise<void> {
  const database = await createAnalysisDatabase({ schemaFiles: [schemaFile] })
  try {
    await database.query(`create table public.expression_inputs (
      required integer not null, optional integer, label text not null
    )`)
    await database.query("insert into public.expression_inputs values (1, null, ' ONE '), (2, 4, 'TWO')")
    await run(database)
  } finally {
    await database.close()
  }
}

async function columns(database: AnalysisDatabase, sql: string) {
  const result = await buildTypedSqlPostgresIrFromCompiledConfigs(database, [
    { name: 'expressionProbe', parameterNames: [], sourceFile: 'expressionProbe.sql', sql },
  ])
  const query = result.queries[0]
  assert.ok(query)
  return query.resultColumns
}

test('audited scalar implementations propagate non-null inputs without trusting strictness or function names', async () => {
  await withDatabase(async (database) => {
    await database.query(`create function public.lower(integer) returns text
      language sql immutable strict as 'select null::text'`)
    await database.query(`create function public.null_equality(integer, integer) returns boolean
      language sql immutable strict as 'select null::boolean'`)
    await database.query(`create operator public.## (
      leftarg = integer, rightarg = integer, function = public.null_equality
    )`)
    const sql = `select
      required + 1 as addition,
      required * 2 as multiplication,
      -required as negation,
      required = 1 as equality,
      required < 3 as comparison,
      length(label) as length,
      lower(label) as lowercase,
      upper(label) as uppercase,
      trim(label) as trimmed,
      label || '!' as concatenated,
      optional + 1 as nullable_addition,
      public.lower(required) as custom_lower,
      required operator(public.##) 1 as custom_equality,
      lower('empty'::int4range) as empty_range_lower
      from public.expression_inputs`
    const output = await columns(database, sql)
    assert.deepEqual(
      output.slice(0, 10).map((column) => column.nullability.kind),
      Array(10).fill('nonNull')
    )
    assert.equal(output[10]?.nullability.kind, 'nullable')
    assert.equal(output[11]?.nullability.kind, 'unknown')
    assert.equal(output[12]?.nullability.kind, 'unknown')
    assert.equal(output[13]?.nullability.kind, 'nullable')

    const rows = (await database.query<Record<string, unknown>>(sql)).rows
    assert.equal(rows[0]?.['nullable_addition'], null)
    assert.equal(rows[0]?.['custom_lower'], null)
    assert.equal(rows[0]?.['custom_equality'], null)
    assert.equal(rows[0]?.['empty_range_lower'], null)
  })
})

test('ranking windows and windowed count stay non-null even when the frame or filter is empty', async () => {
  await withDatabase(async (database) => {
    const sql = `select
      row_number() over () as position,
      rank() over (order by required) as rank,
      dense_rank() over (order by required) as dense_rank,
      count(*) filter (where false) over () as filtered_count,
      count(*) over (order by required rows between 1 preceding and 1 preceding) as preceding_count,
      sum(required) over (order by required rows between 1 preceding and 1 preceding) as preceding_sum,
      lag(required) over (order by required) as previous,
      first_value(required) over (order by required rows between 1 preceding and 1 preceding) as preceding_first
      from public.expression_inputs order by required`
    const output = await columns(database, sql)
    assert.deepEqual(
      output.slice(0, 5).map((column) => column.nullability.kind),
      Array(5).fill('nonNull')
    )
    assert.deepEqual(
      output.slice(5).map((column) => column.nullability.kind),
      Array(3).fill('unknown')
    )
    const first = (await database.query<Record<string, unknown>>(sql)).rows[0]
    assert.equal(first?.['filtered_count'], 0)
    assert.equal(first?.['preceding_count'], 0)
    assert.equal(first?.['preceding_sum'], null)
    assert.equal(first?.['previous'], null)
    assert.equal(first?.['preceding_first'], null)
  })
})

test('minmax follows PostgreSQL null-ignoring semantics and SQL value functions exclude current_schema', async () => {
  await withDatabase(async (database) => {
    const output = await columns(
      database,
      `select
      greatest(optional, 0) as greatest,
      least(optional, required) as least,
      greatest(optional, null::integer) as nullable_greatest,
      current_date as date,
      current_timestamp(3) as timestamp,
      localtimestamp as local_timestamp,
      current_user as user_name,
      current_catalog as database_name
      from public.expression_inputs`
    )
    assert.deepEqual(
      output.map((column) => column.nullability.kind),
      ['nonNull', 'nonNull', 'nullable', 'nonNull', 'nonNull', 'nonNull', 'nonNull', 'nonNull']
    )
    await database.query("set search_path = ''")
    assert.equal((await columns(database, 'select current_schema as schema'))[0]?.nullability.kind, 'unknown')
    assert.equal(
      (await database.query<{ schema: string | null }>('select current_schema as schema')).rows[0]?.schema,
      null
    )
  })
})

test('ordinary nonempty groups prove selected aggregate results while retaining empty-input guardrails', async () => {
  await withDatabase(async (database) => {
    await database.query(`create function public.null_sum_state(integer, integer) returns integer
      language sql immutable as 'select null::integer'`)
    await database.query(`create aggregate public.sum(integer) (
      sfunc = public.null_sum_state, stype = integer, initcond = '0'
    )`)
    const sql = `select required,
      min(required) as minimum,
      max(required) as maximum,
      pg_catalog.sum(required) as total,
      avg(required) as mean,
      bool_and(required > 0) as all_positive,
      array_agg(optional) as optional_values,
      jsonb_agg(optional) as optional_json_values,
      pg_catalog.sum(required) filter (where true) as unfiltered_total,
      max(optional) as nullable_maximum,
      pg_catalog.sum(required) filter (where false) as empty_total,
      array_agg(optional) filter (where false) as empty_array,
      public.sum(required) as user_aggregate
      from public.expression_inputs group by required order by required`
    const output = await columns(database, sql)
    assert.deepEqual(
      output.slice(0, 9).map((column) => column.nullability.kind),
      Array(9).fill('nonNull')
    )
    assert.deepEqual(
      output.slice(9).map((column) => column.nullability.kind),
      Array(4).fill('unknown')
    )
    const first = (await database.query<Record<string, unknown>>(sql)).rows[0]
    assert.deepEqual(first?.['optional_values'], [null])
    assert.equal(first?.['nullable_maximum'], null)
    assert.equal(first?.['empty_total'], null)
    assert.equal(first?.['empty_array'], null)
    assert.equal(first?.['user_aggregate'], null)

    for (const sql of [
      'select max(required) from public.expression_inputs where false',
      'select max(required) from public.expression_inputs where false group by rollup(required)',
      'select array_agg(optional) from public.expression_inputs where false',
    ]) {
      assert.equal((await columns(database, sql))[0]?.nullability.kind, 'unknown')
      assert.equal(Object.values((await database.query<Record<string, unknown>>(sql)).rows[0] ?? {})[0], null)
    }
  })
})

test('native expression metadata retains strictness, volatility, filters, having, and offset identities', async () => {
  await withDatabase(async (database) => {
    const sql = `select
      lower(label) as lowercase,
      label = 'ONE' as exact_equality,
      label = any(array['ONE', 'TWO']) as exact_any,
      greatest(required, 0) as greatest,
      current_timestamp as timestamp,
      row_number() over () as position,
      count(*) filter (where required > 0) as filtered_count,
      count(distinct optional) as distinct_count,
      random() as volatile_value
      from public.expression_inputs
      group by label, required
      having count(*) filter (where required > 0) > 0
      offset 2`
    const result = await database.query<{ analysis: string }>(
      'select pg_temp.postgres_typed_sql_analyze($1) as analysis',
      [sql]
    )
    const analysis = JSON.parse(result.rows[0]?.analysis ?? '') as PgAnalyzerResult
    assert.equal(analysis.schemaVersion, 12)
    const query = analysis.statements[0]?.queries[0]
    assert.ok(query)
    const expressions = query.targetList?.map((target) => target.expr) ?? []
    assert.equal(expressions[0]?.isStrict, true)
    assert.equal(expressions[0]?.isImmutable, true)
    assert.equal(expressions[0]?.nonNullInputProducesNonNull, true)
    assert.equal(expressions[1]?.textEqualityIsExact, true)
    assert.equal(expressions[2]?.isStrict, true)
    assert.equal(expressions[2]?.useOr, true)
    assert.equal(expressions[2]?.textEqualityIsExact, true)
    assert.equal(expressions[3]?.tag, 'MinMaxExpr')
    assert.equal(expressions[3]?.minMaxOp, 'GREATEST')
    assert.equal(expressions[4]?.sqlValueFunction, 'CURRENT_TIMESTAMP')
    assert.equal(expressions[5]?.tag, 'WindowFunc')
    assert.equal(expressions[5]?.winname, 'row_number')
    assert.equal(expressions[5]?.winagg, false)
    assert.equal(expressions[6]?.aggfilter?.tag, 'OpExpr')
    assert.equal(expressions[6]?.aggOrderCount, 0)
    assert.equal(expressions[6]?.aggDistinctCount, 0)
    assert.equal(expressions[6]?.agglevelsup, 0)
    assert.equal(expressions[6]?.aggstar, true)
    assert.equal(expressions[7]?.aggDistinctCount, 1)
    assert.equal(expressions[8]?.isImmutable, false)
    assert.equal(query.havingQual?.tag, 'OpExpr')
    const offset = query.limitOffset
    assert.ok(offset)
    const offsetValue = offset.tag === 'Const' ? offset : targetExprFromAggregateArg(offset.args?.[0])
    assert.equal(offsetValue?.constInteger, '2')
  })
})

test('range proofs load helper identities used only by inner join qualifications', async () => {
  await withDatabase(async (database) => {
    const sql = `select lower(source.span) as lower, upper(source.span) as upper
      from (values ('empty'::int4range), ('(,)'::int4range), ('[1,5)'::int4range)) source(span)
      inner join (values (1)) gate(value)
        on not isempty(source.span)
        and not lower_inf(source.span)
        and not upper_inf(source.span)`
    const output = await columns(database, sql)
    assert.deepEqual(
      output.map((column) => column.nullability.kind),
      ['nonNull', 'nonNull']
    )
    assert.deepEqual((await database.query(sql)).rows, [{ lower: 1, upper: 5 }])
  })
})

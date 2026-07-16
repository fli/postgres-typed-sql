import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import test from 'node:test'

import { createAnalysisDatabase, type AnalysisDatabase } from '../src/engine.js'

const schemaFile = resolve(import.meta.dirname, 'fixtures/schema.sql')

interface NativeAnalysis {
  readonly paramTypeOids: readonly number[]
  readonly paramTypeNullAdmissions: readonly ('accepts' | 'rejects' | 'unknown')[]
  readonly paramUsageNullAdmissions: readonly ('accepts' | 'rejects' | 'unknown')[]
  readonly postgresVersionNum: number
  readonly rawStatementCount: number
  readonly schemaVersion: number
  readonly statements: readonly NativeStatement[]
}

interface NativeStatement {
  readonly queries: readonly NativeQuery[]
  readonly rewrittenQueryCount: number
}

interface NativeQuery {
  readonly canSetTag: boolean
  readonly commandType: string
  readonly cteList: readonly NativeCte[]
  readonly dmlParameterTargets: readonly NativeDmlParameterTarget[]
  readonly hasLimitCount: boolean
  readonly hasRowMarks: boolean
  readonly limitWithTies: boolean
  readonly hasVolatileFunctions: boolean
  readonly rtable: readonly { readonly kind: string; readonly subquery?: NativeQuery }[]
  readonly targetList: readonly NativeTarget[]
}

interface NativeTarget {
  readonly attname?: string | null
  readonly expr: NativeExpr
  readonly relname?: string | null
  readonly rteKind?: string
  readonly varattno?: number
  readonly varlevelsup?: number
  readonly varno?: number
}

interface NativeCte {
  readonly name: string
  readonly query?: NativeQuery
}

interface NativeDmlParameterTarget {
  readonly directAssignment: boolean
  readonly paramId: number
  readonly source: string
  readonly targetAttname: string
  readonly targetAttnum: number
  readonly targetNullAdmission: 'accepts' | 'rejects' | 'unknown'
  readonly targetNullable: boolean
  readonly targetRelid: number
  readonly targetTypeName: string
  readonly targetTypeOid: number
}

interface NativeExpr {
  readonly args?: readonly NativeExpr[]
  readonly attname?: string | null
  readonly elements?: readonly NativeExpr[]
  readonly funcVariadic?: boolean
  readonly multidims?: boolean
  readonly relname?: string | null
  readonly rteKind?: string
  readonly subLinkType?: string
  readonly subquery?: NativeQuery
  readonly tag: string
  readonly varattno?: number
  readonly varlevelsup?: number
  readonly varno?: number
}

async function analyze(
  database: AnalysisDatabase,
  sql: string,
  paramTypeOids: readonly number[]
): Promise<NativeAnalysis> {
  const result = await database.query<{ analysis: string }>(
    'select pg_temp.postgres_typed_sql_analyze($1, $2::oid[]) as analysis',
    [sql, paramTypeOids]
  )
  const payload = result.rows[0]?.analysis
  assert.ok(typeof payload === 'string')
  return JSON.parse(payload) as NativeAnalysis
}

async function withDatabase(run: (database: AnalysisDatabase) => Promise<void>): Promise<void> {
  const database = await createAnalysisDatabase({ schemaFiles: [schemaFile] })
  try {
    await run(database)
  } finally {
    await database.close()
  }
}

async function installSortKeyOperatorClass(
  database: AnalysisDatabase,
  name:
    | 'array_element_key'
    | 'executor_compare_key'
    | 'executor_equal_key'
    | 'io_compare_key'
    | 'nested_compare_key'
    | 'precision_sort_key'
    | 'volatile_sort_key',
  options: { readonly volatileComparator: boolean; readonly volatileEquality: boolean }
): Promise<void> {
  await database.query(`create type public.${name} as (value integer)`)
  await database.query(`create table public.${name}_calls (called boolean default true)`)

  for (const [suffix, operator] of [
    ['lt', '<'],
    ['le', '<='],
    ['ge', '>='],
    ['gt', '>'],
  ] as const) {
    await database.query(`create function public.${name}_${suffix}(
      left_value public.${name}, right_value public.${name}
    ) returns boolean language sql immutable strict
    as $$ select (left_value).value ${operator} (right_value).value $$`)
  }

  await database.query(
    options.volatileEquality
      ? `create function public.${name}_eq(
          left_value public.${name}, right_value public.${name}
        ) returns boolean language plpgsql volatile strict as $$
        begin
          insert into public.${name}_calls default values;
          return (left_value).value = (right_value).value;
        end
        $$`
      : `create function public.${name}_eq(
          left_value public.${name}, right_value public.${name}
        ) returns boolean language sql immutable strict
        as $$ select (left_value).value = (right_value).value $$`
  )

  await database.query(
    options.volatileComparator
      ? `create function public.${name}_compare(
          left_value public.${name}, right_value public.${name}
        ) returns integer language plpgsql volatile strict as $$
        begin
          insert into public.${name}_calls default values;
          return case
            when (left_value).value < (right_value).value then -1
            when (left_value).value > (right_value).value then 1
            else 0
          end;
        end
        $$`
      : `create function public.${name}_compare(
          left_value public.${name}, right_value public.${name}
        ) returns integer language sql immutable strict as $$
        select case
          when (left_value).value < (right_value).value then -1
          when (left_value).value > (right_value).value then 1
          else 0
        end
        $$`
  )

  for (const [suffix, operator] of [
    ['lt', '<'],
    ['le', '<='],
    ['eq', '='],
    ['ge', '>='],
    ['gt', '>'],
  ] as const) {
    await database.query(`create operator public.${operator} (
      leftarg = public.${name},
      rightarg = public.${name},
      function = public.${name}_${suffix}
    )`)
  }

  await database.query(`create operator class public.${name}_ops
    default for type public.${name} using btree as
      operator 1 public.<,
      operator 2 public.<=,
      operator 3 public.=,
      operator 4 public.>=,
      operator 5 public.>,
      function 1 public.${name}_compare(public.${name}, public.${name})`)
}

test('native analyzer exposes the versioned PostgreSQL query envelope', async () => {
  await withDatabase(async (database) => {
    const analysis = await analyze(
      database,
      'select exists(select 1) as present from generate_series(1, 2) generated(n) cross join (values (1)) value(n) limit $1',
      [20]
    )

    assert.equal(analysis.schemaVersion, 6)
    assert.equal(analysis.postgresVersionNum, 180003)
    assert.equal(analysis.rawStatementCount, 1)
    assert.deepEqual(analysis.paramTypeOids, [20])
    assert.deepEqual(analysis.paramTypeNullAdmissions, ['accepts'])
    assert.deepEqual(analysis.paramUsageNullAdmissions, ['accepts'])
    assert.equal(analysis.statements.length, 1)
    assert.equal(analysis.statements[0]?.rewrittenQueryCount, 1)

    const query = analysis.statements[0]?.queries[0]
    assert.ok(query)
    assert.equal(query.canSetTag, true)
    assert.equal(query.commandType, 'SELECT')
    assert.equal(query.hasLimitCount, true)
    assert.equal(query.limitWithTies, false)
    assert.deepEqual(
      query.rtable.map((entry) => entry.kind),
      ['FUNCTION', 'SUBQUERY', 'JOIN']
    )
    assert.deepEqual(
      query.rtable[1]?.subquery?.rtable.map((entry) => entry.kind),
      ['VALUES']
    )
    assert.equal(query.targetList[0]?.expr.tag, 'SubLink')
    assert.equal(query.targetList[0]?.expr.subLinkType, 'EXISTS')
  })
})

test('native analyzer resolves correlated Var metadata through one and two ancestor query scopes', async () => {
  await withDatabase(async (database) => {
    await database.query('create table public.correlation_outer (value text)')
    await database.query('create table public.correlation_inner_one (value text not null)')
    await database.query('create table public.correlation_inner_two (value text not null)')

    const lateral = await analyze(
      database,
      `select nested.value
       from public.correlation_outer outer_row
       cross join lateral (
         select outer_row.value
         from public.correlation_inner_one inner_row
       ) nested`,
      []
    )
    const lateralQuery = lateral.statements[0]?.queries[0]
    const lateralSubquery = lateralQuery?.rtable.find((rte) => rte.kind === 'SUBQUERY')?.subquery
    const levelOneTarget = lateralSubquery?.targetList[0]
    assert.ok(levelOneTarget)
    assert.deepEqual(
      {
        attname: levelOneTarget.attname,
        relname: levelOneTarget.relname,
        rteKind: levelOneTarget.rteKind,
        varattno: levelOneTarget.varattno,
        varlevelsup: levelOneTarget.varlevelsup,
        varno: levelOneTarget.varno,
      },
      {
        attname: 'value',
        relname: 'correlation_outer',
        rteKind: 'RELATION',
        varattno: 1,
        varlevelsup: 1,
        varno: 1,
      }
    )
    assert.deepEqual(
      {
        attname: levelOneTarget.expr.attname,
        relname: levelOneTarget.expr.relname,
        rteKind: levelOneTarget.expr.rteKind,
        varattno: levelOneTarget.expr.varattno,
        varlevelsup: levelOneTarget.expr.varlevelsup,
        varno: levelOneTarget.expr.varno,
      },
      {
        attname: 'value',
        relname: 'correlation_outer',
        rteKind: 'RELATION',
        varattno: 1,
        varlevelsup: 1,
        varno: 1,
      }
    )

    const doublyNested = await analyze(
      database,
      `select (
         select (
           select outer_row.value
           from public.correlation_inner_two inner_two
           limit 1
         )
         from public.correlation_inner_one inner_one
         limit 1
       )
       from public.correlation_outer outer_row`,
      []
    )
    const firstSubquery = doublyNested.statements[0]?.queries[0]?.targetList[0]?.expr.subquery
    const secondSubquery = firstSubquery?.targetList[0]?.expr.subquery
    const levelTwoTarget = secondSubquery?.targetList[0]
    assert.ok(levelTwoTarget)
    assert.equal(levelTwoTarget.varlevelsup, 2)
    assert.equal(levelTwoTarget.relname, 'correlation_outer')
    assert.equal(levelTwoTarget.attname, 'value')
    assert.equal(levelTwoTarget.rteKind, 'RELATION')
    assert.equal(levelTwoTarget.expr.varlevelsup, 2)
    assert.equal(levelTwoTarget.expr.relname, 'correlation_outer')
    assert.equal(levelTwoTarget.expr.attname, 'value')
    assert.equal(levelTwoTarget.expr.rteKind, 'RELATION')
  })
})

test('native analyzer preserves explicit parameter OIDs while inferring zero slots', async () => {
  await withDatabase(async (database) => {
    const analysis = await analyze(database, 'select $1::text, $2 + 1', [25, 0])

    assert.deepEqual(analysis.paramTypeOids, [25, 23])
    assert.deepEqual(analysis.paramTypeNullAdmissions, ['accepts', 'accepts'])
    assert.deepEqual(analysis.paramUsageNullAdmissions, ['accepts', 'accepts'])
  })
})

test('native analyzer classifies NULL admission at PostgreSQL expression contexts', async () => {
  await withDatabase(async (database) => {
    await database.query('create table public.null_admission_sample (value integer)')
    await database.query('insert into public.null_admission_sample(value) values (1), (2)')
    await database.query(`create procedure public.reject_null(value integer)
      language plpgsql
      as $$
      begin
        if value is null then
          raise exception 'procedure rejected null';
        end if;
      end
      $$`)

    const rejectingFrameSql = `select
        sum(value) over (rows between $1 preceding and $2 following) as total
      from (values (1), (2)) input(value)`
    const rejectingFrame = await analyze(database, rejectingFrameSql, [])
    assert.deepEqual(rejectingFrame.paramUsageNullAdmissions, ['rejects', 'rejects'])
    await assert.rejects(database.query(rejectingFrameSql, [null, 0]), /frame starting offset must not be null/u)
    await assert.rejects(database.query(rejectingFrameSql, [0, null]), /frame ending offset must not be null/u)

    const acceptingFrameSql = `select
        sum(value) over (
          rows between coalesce($1, 0) preceding and coalesce($2, 0) following
        ) as total
      from (values (1), (2)) input(value)`
    const acceptingFrame = await analyze(database, acceptingFrameSql, [20, 20])
    assert.deepEqual(acceptingFrame.paramUsageNullAdmissions, ['unknown', 'unknown'])
    assert.equal((await database.query(acceptingFrameSql, [null, null])).rows.length, 2)

    const rejectingSampleSql = `select value
      from public.null_admission_sample tablesample system ($1) repeatable ($2)`
    const rejectingSample = await analyze(database, rejectingSampleSql, [])
    assert.deepEqual(rejectingSample.paramUsageNullAdmissions, ['rejects', 'rejects'])
    await assert.rejects(database.query(rejectingSampleSql, [null, 0]), /TABLESAMPLE parameter cannot be null/u)
    await assert.rejects(
      database.query(rejectingSampleSql, [100, null]),
      /TABLESAMPLE REPEATABLE parameter cannot be null/u
    )

    const acceptingSampleSql = `select value
      from public.null_admission_sample
      tablesample system (coalesce($1, 100)) repeatable (coalesce($2, 0))`
    const acceptingSample = await analyze(database, acceptingSampleSql, [700, 701])
    assert.deepEqual(acceptingSample.paramUsageNullAdmissions, ['unknown', 'unknown'])
    assert.equal((await database.query(acceptingSampleSql, [null, null])).rows.length, 2)

    const mixedUse = await analyze(
      database,
      `select $1::bigint,
         sum(value) over (rows between $1 preceding and current row)
       from (values (1), (2)) input(value)
       group by value`,
      []
    )
    assert.deepEqual(mixedUse.paramUsageNullAdmissions, ['rejects'])

    const utility = await analyze(database, 'call public.reject_null($1)', [])
    assert.deepEqual(utility.paramUsageNullAdmissions, ['unknown'])
    await assert.rejects(database.query('call public.reject_null($1)', [null]), /procedure rejected null/u)
  })
})

test('native analyzer requires CHECK expressions to be safe when proving NULL admission', async () => {
  await withDatabase(async (database) => {
    await database.query(`create function public.reject_null_arg(value integer)
      returns integer
      language plpgsql
      immutable
      as $$
      begin
        if value is null then
          raise exception 'reject_null_arg rejected null';
        end if;
        return value;
      end
      $$`)
    await database.query(`create function public.strict_pair(left_value integer, right_value integer)
      returns boolean
      language plpgsql
      immutable
      strict
      as $$
      begin
        return true;
      end
      $$`)
    await database.query(`create function public.reject_null_bool(value integer)
      returns boolean
      language plpgsql
      immutable
      as $$
      begin
        if value is null then
          raise exception 'reject_null_bool rejected null';
        end if;
        return true;
      end
      $$`)
    await database.query(`create table public.unsafe_check_probe (
      operation_value integer check (operation_value = public.reject_null_arg(operation_value)),
      function_value integer check (public.strict_pair(function_value, public.reject_null_arg(function_value))),
      scalar_array_value integer check (
        scalar_array_value = any (array[public.reject_null_arg(scalar_array_value)])
      ),
      boolean_value integer check (public.reject_null_bool(boolean_value) or boolean_value is null)
    )`)
    await database.query(`create domain public.unsafe_check_domain as integer
      check (value = public.reject_null_arg(value))`)
    await database.query('create table public.unsafe_domain_probe (value public.unsafe_check_domain)')

    const unsafeCases = [
      {
        error: /reject_null_arg rejected null/u,
        sql: `insert into public.unsafe_check_probe(
          operation_value, function_value, scalar_array_value, boolean_value
        ) select $1, 1, 1, 1`,
      },
      {
        error: /reject_null_arg rejected null/u,
        sql: `insert into public.unsafe_check_probe(
          operation_value, function_value, scalar_array_value, boolean_value
        ) select 1, $1, 1, 1`,
      },
      {
        error: /reject_null_arg rejected null/u,
        sql: `insert into public.unsafe_check_probe(
          operation_value, function_value, scalar_array_value, boolean_value
        ) select 1, 1, $1, 1`,
      },
      {
        error: /reject_null_bool rejected null/u,
        sql: `insert into public.unsafe_check_probe(
          operation_value, function_value, scalar_array_value, boolean_value
        ) select 1, 1, 1, $1`,
      },
      {
        error: /reject_null_arg rejected null/u,
        sql: 'insert into public.unsafe_domain_probe(value) select $1',
      },
    ] as const

    for (const unsafeCase of unsafeCases) {
      const analysis = await analyze(database, unsafeCase.sql, [])
      assert.equal(
        analysis.statements[0]?.queries[0]?.dmlParameterTargets[0]?.targetNullAdmission,
        'unknown',
        unsafeCase.sql
      )
      await assert.rejects(database.query(unsafeCase.sql, [null]), unsafeCase.error)
    }

    await database.query(`create table public.safe_check_probe (
      direct_value text check (direct_value = 'allowed'),
      scalar_array_value text check (scalar_array_value = any (array['one', 'two'])),
      boolean_value text check (boolean_value is null or boolean_value = 'allowed')
    )`)
    const safeSql = `insert into public.safe_check_probe(direct_value, scalar_array_value, boolean_value)
      select $1, $2, $3`
    const safeAnalysis = await analyze(database, safeSql, [])
    assert.ok(
      safeAnalysis.statements[0]?.queries[0]?.dmlParameterTargets.every(
        ({ targetNullAdmission }) => targetNullAdmission === 'accepts'
      )
    )
    await database.query(safeSql, [null, null, null])
  })
})

test('native analyzer reports row locks recursively through join predicates', async () => {
  await withDatabase(async (database) => {
    const analysis = await analyze(
      database,
      `select left_account.id
       from public.accounts left_account
       join public.accounts right_account on exists (
         select 1
         from public.accounts locked_account
         where locked_account.id = left_account.id
         for update
       )`,
      []
    )

    assert.equal(analysis.statements[0]?.queries[0]?.hasRowMarks, true)
  })
})

test('native analyzer treats volatile aggregate support functions as writes', async () => {
  await withDatabase(async (database) => {
    await database.query('create table public.aggregate_side_effects (value integer)')
    await database.query(`create function public.volatile_sum_transition(state integer, value integer)
      returns integer
      language plpgsql volatile
      as $$
      begin
        insert into public.aggregate_side_effects(value) values (value);
        return coalesce(state, 0) + value;
      end
      $$`)
    await database.query(`create aggregate public.volatile_sum(integer) (
      sfunc = public.volatile_sum_transition,
      stype = integer,
      initcond = '0'
    )`)

    const aggregateSql = 'select public.volatile_sum(value) from (values (1), (2), (3)) input(value)'
    const aggregate = await analyze(database, aggregateSql, [])
    assert.equal(aggregate.statements[0]?.queries[0]?.hasVolatileFunctions, true)
    assert.equal((await database.query(aggregateSql)).rows.length, 1)
    const aggregateSideEffects = await database.query<{ value: number }>(
      'select value from public.aggregate_side_effects order by value'
    )
    assert.deepEqual(aggregateSideEffects.rows, [{ value: 1 }, { value: 2 }, { value: 3 }])

    await database.query('truncate public.aggregate_side_effects')
    const windowSql = 'select public.volatile_sum(value) over () from (values (1), (2), (3)) input(value)'
    const window = await analyze(database, windowSql, [])
    assert.equal(window.statements[0]?.queries[0]?.hasVolatileFunctions, true)
    assert.equal((await database.query(windowSql)).rows.length, 3)
    const windowSideEffects = await database.query<{ value: number }>(
      'select value from public.aggregate_side_effects order by value'
    )
    assert.deepEqual(windowSideEffects.rows, [{ value: 1 }, { value: 2 }, { value: 3 }])

    await database.query('create table public.aggregate_support_calls (kind text)')
    await database.query(`create function public.immutable_sum_transition(state integer, value integer)
      returns integer language sql immutable
      as $$ select coalesce(state, 0) + coalesce(value, 0) $$`)
    await database.query(`create function public.volatile_moving_sum_transition(
      state integer, value integer
    ) returns integer language plpgsql volatile as $$
    begin
      insert into public.aggregate_support_calls(kind) values ('moving-transition');
      return coalesce(state, 0) + coalesce(value, 0);
    end
    $$`)
    await database.query(`create function public.volatile_moving_sum_inverse(
      state integer, value integer
    ) returns integer language plpgsql volatile as $$
    begin
      insert into public.aggregate_support_calls(kind) values ('moving-inverse');
      return coalesce(state, 0) - coalesce(value, 0);
    end
    $$`)
    await database.query(`create function public.volatile_moving_sum_final(state integer)
      returns integer language plpgsql volatile as $$
    begin
      insert into public.aggregate_support_calls(kind) values ('moving-final');
      return state;
    end
    $$`)
    await database.query(`create aggregate public.moving_capable_sum(integer) (
      sfunc = public.immutable_sum_transition,
      stype = integer,
      initcond = '0',
      msfunc = public.volatile_moving_sum_transition,
      minvfunc = public.volatile_moving_sum_inverse,
      mstype = integer,
      minitcond = '0',
      mfinalfunc = public.volatile_moving_sum_final
    )`)

    const ordinaryMovingSql = `select public.moving_capable_sum(value) as total
      from (values (1), (2), (3)) input(value)`
    const ordinaryMoving = await analyze(database, ordinaryMovingSql, [])
    assert.equal(ordinaryMoving.statements[0]?.queries[0]?.hasVolatileFunctions, false)
    assert.deepEqual((await database.query(ordinaryMovingSql)).rows, [{ total: 6 }])
    assert.deepEqual((await database.query('select kind from public.aggregate_support_calls')).rows, [])

    const windowMovingSql = `select public.moving_capable_sum(value) over (
        order by value rows between 1 preceding and current row
      ) as total
      from (values (1), (2), (3)) input(value)`
    const windowMoving = await analyze(database, windowMovingSql, [])
    assert.equal(windowMoving.statements[0]?.queries[0]?.hasVolatileFunctions, true)
    assert.deepEqual((await database.query(windowMovingSql)).rows, [{ total: 1 }, { total: 3 }, { total: 5 }])
    assert.ok((await database.query('select kind from public.aggregate_support_calls')).rows.length > 0)

    await database.query('truncate public.aggregate_support_calls')
    await database.query(`create function public.volatile_sum_combine(
      left_state integer, right_state integer
    ) returns integer language plpgsql volatile parallel safe as $$
    begin
      insert into public.aggregate_support_calls(kind) values ('combine');
      return coalesce(left_state, 0) + coalesce(right_state, 0);
    end
    $$`)
    await database.query(`create aggregate public.combine_capable_sum(integer) (
      sfunc = public.immutable_sum_transition,
      stype = integer,
      initcond = '0',
      combinefunc = public.volatile_sum_combine,
      parallel = safe
    )`)

    const ordinaryCombine = await analyze(
      database,
      'select public.combine_capable_sum(value) from (values (1), (2)) input(value)',
      []
    )
    assert.equal(ordinaryCombine.statements[0]?.queries[0]?.hasVolatileFunctions, true)

    const windowCombineSql = `select public.combine_capable_sum(value) over () as total
      from (values (1), (2)) input(value)`
    const windowCombine = await analyze(database, windowCombineSql, [])
    assert.equal(windowCombine.statements[0]?.queries[0]?.hasVolatileFunctions, false)
    assert.deepEqual((await database.query(windowCombineSql)).rows, [{ total: 3 }, { total: 3 }])
    assert.deepEqual((await database.query('select kind from public.aggregate_support_calls')).rows, [])
  })
})

test('native analyzer classifies only support functions reachable from sort execution', async () => {
  await withDatabase(async (database) => {
    await installSortKeyOperatorClass(database, 'volatile_sort_key', {
      volatileComparator: true,
      volatileEquality: false,
    })
    const volatileSortSql = `select value
      from (values
        (row(3)::public.volatile_sort_key),
        (row(1)::public.volatile_sort_key),
        (row(2)::public.volatile_sort_key)
      ) input(value)
      order by value`
    const volatileSort = await analyze(database, volatileSortSql, [])
    assert.equal(volatileSort.statements[0]?.queries[0]?.hasVolatileFunctions, true)
    await database.query(volatileSortSql)
    assert.deepEqual(
      (
        await database.query<{ called: boolean }>(`select exists(
        select 1 from public.volatile_sort_key_calls
      ) as called`)
      ).rows,
      [{ called: true }]
    )

    await installSortKeyOperatorClass(database, 'precision_sort_key', {
      volatileComparator: false,
      volatileEquality: true,
    })
    const precisionSortSql = `select value
      from (values
        (row(3)::public.precision_sort_key),
        (row(1)::public.precision_sort_key),
        (row(2)::public.precision_sort_key)
      ) input(value)
      order by value`
    const precisionSort = await analyze(database, precisionSortSql, [])
    assert.equal(precisionSort.statements[0]?.queries[0]?.hasVolatileFunctions, false)
    await database.query(precisionSortSql)
    assert.deepEqual(
      (
        await database.query<{ called: boolean }>(`select exists(
        select 1 from public.precision_sort_key_calls
      ) as called`)
      ).rows,
      [{ called: false }]
    )

    await database.query('create table public.builtin_sortsupport_calls (called boolean default true)')
    for (const [suffix, operator] of [
      ['lt', '<'],
      ['le', '<='],
      ['eq', '='],
      ['ge', '>='],
      ['gt', '>'],
    ] as const) {
      await database.query(`create function public.builtin_sortsupport_${suffix}(
        left_value integer, right_value integer
      ) returns boolean language sql immutable strict
      as $$ select left_value ${operator} right_value $$`)
    }
    await database.query(`create function public.unreachable_volatile_int_compare(
      left_value integer, right_value integer
    ) returns integer language plpgsql volatile strict as $$
    begin
      insert into public.builtin_sortsupport_calls default values;
      return case
        when left_value < right_value then -1
        when left_value > right_value then 1
        else 0
      end;
    end
    $$`)
    for (const [name, suffix] of [
      ['<~', 'lt'],
      ['<=~', 'le'],
      ['=~', 'eq'],
      ['>=~', 'ge'],
      ['>~', 'gt'],
    ] as const) {
      await database.query(`create operator public.${name} (
        leftarg = integer,
        rightarg = integer,
        function = public.builtin_sortsupport_${suffix}
      )`)
    }
    await database.query(`create operator class public.builtin_sortsupport_int_ops
      for type integer using btree as
        operator 1 public.<~,
        operator 2 public.<=~,
        operator 3 public.=~,
        operator 4 public.>=~,
        operator 5 public.>~,
        function 1 public.unreachable_volatile_int_compare(integer, integer),
        function 2 pg_catalog.btint4sortsupport(internal)`)

    const builtinSortSupportSql = `select value
      from (values (3), (1), (2)) input(value)
      order by value using operator(public.<~)`
    const builtinSortSupport = await analyze(database, builtinSortSupportSql, [])
    assert.equal(builtinSortSupport.statements[0]?.queries[0]?.hasVolatileFunctions, false)
    assert.deepEqual((await database.query<{ value: number }>(builtinSortSupportSql)).rows, [
      { value: 1 },
      { value: 2 },
      { value: 3 },
    ])
    assert.deepEqual(
      (
        await database.query<{ called: boolean }>(`select exists(
        select 1 from public.builtin_sortsupport_calls
      ) as called`)
      ).rows,
      [{ called: false }]
    )
  })
})

test('native analyzer follows grouped and excluded DML lineage and keeps inherited enforcement opaque', async () => {
  await withDatabase(async (database) => {
    await database.query('create table public.inherited_target (value integer)')
    await database.query('create table public.inherited_target_child () inherits (public.inherited_target)')
    await database.query('alter table public.inherited_target_child alter column value set not null')
    await database.query('insert into public.inherited_target_child(value) values (1)')
    await database.query('insert into public.inherited_target(value) values (1)')

    const inheritedSql = 'update public.inherited_target set value = $1'
    const inherited = await analyze(database, inheritedSql, [23])
    assert.deepEqual(
      inherited.statements[0]?.queries[0]?.dmlParameterTargets.map(({ directAssignment, targetNullAdmission }) => ({
        directAssignment,
        targetNullAdmission,
      })),
      [{ directAssignment: false, targetNullAdmission: 'unknown' }]
    )
    await assert.rejects(database.query(inheritedSql, [null]), /not-null constraint/u)

    const onlySql = 'update only public.inherited_target set value = $1'
    const only = await analyze(database, onlySql, [23])
    assert.deepEqual(
      only.statements[0]?.queries[0]?.dmlParameterTargets.map(({ directAssignment, targetNullAdmission }) => ({
        directAssignment,
        targetNullAdmission,
      })),
      [{ directAssignment: false, targetNullAdmission: 'accepts' }]
    )
    await database.query(onlySql, [null])

    await database.query('create table public.grouped_sink (value integer not null)')
    const groupedSql = `insert into public.grouped_sink(value)
      select $1::integer group by $1`
    const grouped = await analyze(database, groupedSql, [23])
    assert.deepEqual(
      grouped.statements[0]?.queries[0]?.dmlParameterTargets.map(({ paramId, targetAttname, targetNullAdmission }) => ({
        paramId,
        targetAttname,
        targetNullAdmission,
      })),
      [{ paramId: 1, targetAttname: 'value', targetNullAdmission: 'rejects' }]
    )
    await assert.rejects(database.query(groupedSql, [null]), /not-null constraint/u)

    await database.query(`create table public.excluded_target (
      key integer primary key,
      source_value integer,
      required_value integer not null
    )`)
    await database.query('insert into public.excluded_target(key, source_value, required_value) values (1, 1, 1)')
    const excludedSql = `insert into public.excluded_target(key, source_value, required_value)
      values (1, $1, 0)
      on conflict (key) do update
      set required_value = excluded.source_value`
    const excluded = await analyze(database, excludedSql, [23])
    assert.deepEqual(
      excluded.statements[0]?.queries[0]?.dmlParameterTargets.map(
        ({ paramId, source, targetAttname, targetNullAdmission }) => ({
          paramId,
          source,
          targetAttname,
          targetNullAdmission,
        })
      ),
      [
        {
          paramId: 1,
          source: 'INSERT',
          targetAttname: 'source_value',
          targetNullAdmission: 'accepts',
        },
        {
          paramId: 1,
          source: 'ON_CONFLICT_UPDATE',
          targetAttname: 'required_value',
          targetNullAdmission: 'unknown',
        },
      ]
    )
    await assert.rejects(database.query(excludedSql, [null]), /not-null constraint/u)

    await database.query(`create function public.excluded_source_value(
      value public.excluded_target
    ) returns integer language sql immutable strict
    as $$ select (value).source_value $$`)
    const excludedWholeRowSql = `insert into public.excluded_target(key, source_value, required_value)
      values (1, $1, 0)
      on conflict (key) do update
      set required_value = public.excluded_source_value(excluded)`
    const excludedWholeRow = await analyze(database, excludedWholeRowSql, [23])
    assert.ok(
      excludedWholeRow.statements[0]?.queries[0]?.dmlParameterTargets.some(
        ({ paramId, source, targetAttname, targetNullAdmission }) =>
          paramId === 1 &&
          source === 'ON_CONFLICT_UPDATE' &&
          targetAttname === 'required_value' &&
          targetNullAdmission === 'unknown'
      )
    )
    await assert.rejects(database.query(excludedWholeRowSql, [null]), /not-null constraint/u)

    await database.query('create table public.function_sink (value integer not null)')
    const functionSql = `insert into public.function_sink(value)
      select value from generate_series($1::integer, $1::integer) source(value)`
    const functionLineage = await analyze(database, functionSql, [23])
    assert.deepEqual(
      functionLineage.statements[0]?.queries[0]?.dmlParameterTargets.map(
        ({ paramId, targetAttname, targetNullAdmission }) => ({
          paramId,
          targetAttname,
          targetNullAdmission,
        })
      ),
      [{ paramId: 1, targetAttname: 'value', targetNullAdmission: 'unknown' }]
    )
    assert.deepEqual((await database.query(functionSql, [null])).rows, [])
  })
})

test('native analyzer closes JSON conversion over casts, arrays, constructors, and aggregates', async () => {
  await withDatabase(async (database) => {
    await database.query("create type public.json_mood as enum ('calm', 'busy')")
    await database.query('create table public.json_conversion_calls (value text)')
    await database.query(`create function public.json_mood_to_json(value public.json_mood)
      returns json language plpgsql volatile strict as $$
      begin
        insert into public.json_conversion_calls(value) values (value::text);
        return pg_catalog.to_json(value::text);
      end
      $$`)
    await database.query(`create cast (public.json_mood as json)
      with function public.json_mood_to_json(public.json_mood) as assignment`)

    for (const sql of [
      "select to_json('calm'::public.json_mood)",
      "select json_build_object('mood', 'calm'::public.json_mood)",
      "select json_agg(value) from (values ('calm'::public.json_mood)) input(value)",
      "select to_json(array['calm'::public.json_mood])",
      "select json_scalar('calm'::public.json_mood)",
    ]) {
      const analysis = await analyze(database, sql, [])
      assert.equal(analysis.statements[0]?.queries[0]?.hasVolatileFunctions, true, sql)
      await database.query(sql)
    }

    assert.deepEqual(
      (await database.query<{ count: string }>('select count(*)::text as count from public.json_conversion_calls'))
        .rows,
      [{ count: '5' }]
    )

    for (const sql of [
      'select to_json(1)',
      "select json_build_object('value', 1)",
      'select json_agg(value) from (values (1)) input(value)',
      'select json_scalar(1)',
    ]) {
      const analysis = await analyze(database, sql, [])
      assert.equal(analysis.statements[0]?.queries[0]?.hasVolatileFunctions, false, sql)
    }
  })
})

test('native analyzer closes SQL/XML conversion over reachable type output functions', async () => {
  await withDatabase(async (database) => {
    await database.query("create type public.xml_mood as enum ('calm', 'busy')")
    await database.query('create domain public.xml_mood_array as public.xml_mood[]')
    await database.query('alter function pg_catalog.enum_out(anyenum) volatile')

    for (const sql of [
      "select xmlelement(name mood, 'calm'::public.xml_mood)",
      "select xmlforest('calm'::public.xml_mood as mood)",
      "select xmlelement(name moods, array['calm'::public.xml_mood])",
      "select xmlelement(name moods, array['calm'::public.xml_mood]::public.xml_mood_array)",
    ]) {
      const analysis = await analyze(database, sql, [])
      assert.equal(analysis.statements[0]?.queries[0]?.hasVolatileFunctions, true, sql)
      assert.equal((await database.query(sql)).rows.length, 1)
    }

    for (const signature of [
      'boolout(boolean)',
      'date_out(date)',
      'timestamp_out(timestamp without time zone)',
      'timestamptz_out(timestamp with time zone)',
      'byteaout(bytea)',
      'array_out(anyarray)',
    ]) {
      await database.query(`alter function pg_catalog.${signature} volatile`)
    }

    const specialTypesSql = `select xmlelement(
      name values,
      true,
      date '2026-07-16',
      timestamp '2026-07-16 12:00:00',
      timestamptz '2026-07-16 12:00:00+09:30',
      decode('00ff', 'hex'),
      array[true]
    )`
    const specialTypes = await analyze(database, specialTypesSql, [])
    assert.equal(specialTypes.statements[0]?.queries[0]?.hasVolatileFunctions, false)
    assert.equal((await database.query(specialTypesSql)).rows.length, 1)
  })
})

test('native analyzer preserves explicit variadic function-call structure', async () => {
  await withDatabase(async (database) => {
    const literalSql = "select jsonb_build_object(variadic array['answer', '42']) as payload"
    const literalAnalysis = await analyze(database, literalSql, [])
    const literalCall = literalAnalysis.statements[0]?.queries[0]?.targetList[0]?.expr
    assert.equal(literalCall?.tag, 'FuncExpr')
    assert.equal(literalCall?.funcVariadic, true)
    assert.equal(literalCall?.args?.length, 1)
    assert.equal(literalCall?.args?.[0]?.tag, 'ArrayExpr')
    assert.equal(literalCall?.args?.[0]?.multidims, false)
    assert.equal(literalCall?.args?.[0]?.elements?.length, 2)
    assert.deepEqual((await database.query(literalSql)).rows, [{ payload: { answer: '42' } }])

    const dynamicAnalysis = await analyze(database, 'select jsonb_build_object(variadic $1)', [1009])
    const dynamicCall = dynamicAnalysis.statements[0]?.queries[0]?.targetList[0]?.expr
    assert.equal(dynamicCall?.funcVariadic, true)
    assert.equal(dynamicCall?.args?.length, 1)
    assert.equal(dynamicCall?.args?.[0]?.tag, 'Param')

    const flatCall = (await analyze(database, "select jsonb_build_object('answer', '42')", [])).statements[0]
      ?.queries[0]?.targetList[0]?.expr
    assert.equal(flatCall?.funcVariadic, false)
    assert.equal(flatCall?.args?.length, 2)
  })
})

test('native analyzer closes array comparison over concrete element support', async () => {
  await withDatabase(async (database) => {
    await installSortKeyOperatorClass(database, 'array_element_key', {
      volatileComparator: false,
      volatileEquality: true,
    })

    const arraySql = `select
      array[row(1)::public.array_element_key] =
      array[row(1)::public.array_element_key] as equal`
    const arrayAnalysis = await analyze(database, arraySql, [])
    assert.equal(arrayAnalysis.statements[0]?.queries[0]?.hasVolatileFunctions, true)
    assert.deepEqual((await database.query<{ equal: boolean }>(arraySql)).rows, [{ equal: true }])
    assert.deepEqual(
      (
        await database.query<{ called: boolean }>(`select exists(
          select 1 from public.array_element_key_calls
        ) as called`)
      ).rows,
      [{ called: true }]
    )

    const builtinArray = await analyze(database, 'select array[1] = array[1] as equal', [])
    assert.equal(builtinArray.statements[0]?.queries[0]?.hasVolatileFunctions, false)
  })
})

test('native analyzer closes minmax and row comparison over concrete container support', async () => {
  await withDatabase(async (database) => {
    await installSortKeyOperatorClass(database, 'nested_compare_key', {
      volatileComparator: true,
      volatileEquality: false,
    })

    for (const sql of [
      `select greatest(
        row(1)::public.nested_compare_key,
        row(2)::public.nested_compare_key
      ) as greatest_value`,
      `select
        (array[row(1)::public.nested_compare_key], 0) <
        (array[row(2)::public.nested_compare_key], 0) as ordered`,
    ]) {
      const analysis = await analyze(database, sql, [])
      assert.equal(analysis.statements[0]?.queries[0]?.hasVolatileFunctions, true, sql)

      await database.query(`truncate public.nested_compare_key_calls`)
      await database.query(sql)
      assert.deepEqual(
        (
          await database.query<{ called: boolean }>(`select exists(
            select 1 from public.nested_compare_key_calls
          ) as called`)
        ).rows,
        [{ called: true }],
        sql
      )
    }

    await database.query('truncate public.nested_compare_key_calls')
    const singleMinmaxSql = `select greatest(
      row(1)::public.nested_compare_key
    ) as greatest_value`
    const singleMinmax = await analyze(database, singleMinmaxSql, [])
    assert.equal(singleMinmax.statements[0]?.queries[0]?.hasVolatileFunctions, false)
    await database.query(singleMinmaxSql)
    assert.deepEqual((await database.query('select called from public.nested_compare_key_calls')).rows, [])

    await database.query(`create function public.volatile_nested_compare_key(
      value public.nested_compare_key
    ) returns public.nested_compare_key language plpgsql volatile strict as $$
    begin
      insert into public.nested_compare_key_calls default values;
      return value;
    end
    $$`)
    const volatileChildSql = `select greatest(
      public.volatile_nested_compare_key(row(1)::public.nested_compare_key)
    ) as greatest_value`
    const volatileChild = await analyze(database, volatileChildSql, [])
    assert.equal(volatileChild.statements[0]?.queries[0]?.hasVolatileFunctions, true)
    await database.query(volatileChildSql)
    assert.deepEqual((await database.query('select called from public.nested_compare_key_calls')).rows, [
      { called: true },
    ])
  })
})

test('native analyzer closes generic executor support over concrete container types', async () => {
  await withDatabase(async (database) => {
    await installSortKeyOperatorClass(database, 'executor_equal_key', {
      volatileComparator: false,
      volatileEquality: true,
    })
    await installSortKeyOperatorClass(database, 'executor_compare_key', {
      volatileComparator: true,
      volatileEquality: false,
    })

    const assertVolatileExecution = async (
      sql: string,
      params: readonly unknown[],
      callsTable: 'executor_compare_key_calls' | 'executor_equal_key_calls'
    ): Promise<void> => {
      const analysis = await analyze(database, sql, [])
      assert.equal(analysis.statements[0]?.queries[0]?.hasVolatileFunctions, true, sql)

      await database.query(`truncate public.${callsTable}`)
      await database.query(sql, params)
      assert.deepEqual(
        (
          await database.query<{ called: boolean }>(`select exists(
            select 1 from public.${callsTable}
          ) as called`)
        ).rows,
        [{ called: true }],
        sql
      )
    }

    for (const sql of [
      `select array[row($1)::public.executor_equal_key]
        @> array[row($2)::public.executor_equal_key] as present`,
      `select array_position(
        array[row($1)::public.executor_equal_key],
        row($2)::public.executor_equal_key
      ) as position`,
      `select array_remove(
        array[row($1)::public.executor_equal_key],
        row($2)::public.executor_equal_key
      ) as remaining`,
    ]) {
      await assertVolatileExecution(sql, [1, 1], 'executor_equal_key_calls')
    }

    const arrayLengthSql = `select array_length(
      array[row($1)::public.executor_equal_key], 1
    ) as length`
    const arrayLength = await analyze(database, arrayLengthSql, [])
    assert.equal(arrayLength.statements[0]?.queries[0]?.hasVolatileFunctions, false)
    await database.query('truncate public.executor_equal_key_calls')
    assert.deepEqual((await database.query(arrayLengthSql, [1])).rows, [{ length: 1 }])
    assert.deepEqual(
      (
        await database.query<{ called: boolean }>(`select exists(
          select 1 from public.executor_equal_key_calls
        ) as called`)
      ).rows,
      [{ called: false }]
    )

    await database.query(`create function public.executor_equal_key_hash(
      value public.executor_equal_key
    ) returns integer language plpgsql volatile strict as $$
    begin
      insert into public.executor_equal_key_calls default values;
      return hashint4((value).value);
    end
    $$`)
    await database.query(`create operator class public.executor_equal_key_hash_ops
      default for type public.executor_equal_key using hash as
        operator 1 public.=,
        function 1 public.executor_equal_key_hash(public.executor_equal_key)`)
    await assertVolatileExecution(
      'select pg_catalog.hash_array(array[row($1)::public.executor_equal_key]) as hash',
      [1],
      'executor_equal_key_calls'
    )

    for (const [sql, params] of [
      [
        `select array_sort(array[
          row($1)::public.executor_compare_key,
          row($2)::public.executor_compare_key
        ]) as sorted`,
        [2, 1],
      ],
      [
        `select width_bucket(
          row($1)::public.executor_compare_key,
          array[
            row($2)::public.executor_compare_key,
            row($3)::public.executor_compare_key
          ]
        ) as bucket`,
        [2, 1, 3],
      ],
    ] as const) {
      await assertVolatileExecution(sql, params, 'executor_compare_key_calls')
    }

    await database.query(`create type public.executor_compare_range as range (
      subtype = public.executor_compare_key
    )`)
    const rangeSql = `select public.executor_compare_range(
      row($1)::public.executor_compare_key,
      row($2)::public.executor_compare_key,
      '[]'
    ) @> row($3)::public.executor_compare_key as present`
    await assertVolatileExecution(rangeSql, [1, 3, 2], 'executor_compare_key_calls')

    await database.query(`create table public.executor_compare_ranges (
      value public.executor_compare_range
    )`)
    await database.query(`insert into public.executor_compare_ranges(value) values
      (public.executor_compare_range(
        row(1)::public.executor_compare_key,
        row(2)::public.executor_compare_key,
        '[]'
      )),
      (public.executor_compare_range(
        row(3)::public.executor_compare_key,
        row(4)::public.executor_compare_key,
        '[]'
      ))`)
    await assertVolatileExecution(
      'select range_agg(value) from public.executor_compare_ranges',
      [],
      'executor_compare_key_calls'
    )

    await database.query(`create table public.executor_int4_ranges (
      value int4range not null
    )`)
    await database.query(`insert into public.executor_int4_ranges(value)
      values (int4range(1, 2, '[]'))`)
    await database.query('alter function pg_catalog.int4range_canonical(int4range) volatile')

    for (const [sql, params] of [
      [`select $1::int4range as value`, ['[1,2]']],
      [`select int4range($1, $2, '[]') as value`, [1, 2]],
      [`select range_merge(value, value) as value from public.executor_int4_ranges`, []],
      [`select $1::text::int4range as value`, ['[1,2]']],
    ] as const) {
      const analysis = await analyze(database, sql, [])
      assert.equal(analysis.statements[0]?.queries[0]?.hasVolatileFunctions, true, sql)
      assert.deepEqual((await database.query(sql, params)).rows, [{ value: '[1,3)' }], sql)
    }

    const rangeLowerSql = 'select lower(value) from public.executor_int4_ranges'
    const rangeLower = await analyze(database, rangeLowerSql, [])
    assert.equal(rangeLower.statements[0]?.queries[0]?.hasVolatileFunctions, false)
    assert.deepEqual((await database.query(rangeLowerSql)).rows, [{ lower: 1 }])

    await database.query('alter function pg_catalog.int4range_canonical(int4range) immutable')
    const immutableCanonical = await analyze(database, `select int4range($1, $2, '[]') as value`, [])
    assert.equal(immutableCanonical.statements[0]?.queries[0]?.hasVolatileFunctions, false)
  })
})

test('native analyzer closes external parameter and CoerceViaIO container input dependencies', async () => {
  await withDatabase(async (database) => {
    await installSortKeyOperatorClass(database, 'io_compare_key', {
      volatileComparator: true,
      volatileEquality: false,
    })
    await database.query(`create type public.io_compare_range as range (
      subtype = public.io_compare_key
    )`)

    const rangeSql = 'select $1::public.io_compare_range as value'
    const rangeAnalysis = await analyze(database, rangeSql, [])
    assert.equal(rangeAnalysis.statements[0]?.queries[0]?.hasVolatileFunctions, true)
    await database.query('truncate public.io_compare_key_calls')
    await database.query(rangeSql, ['["(1)","(3)"]'])
    assert.deepEqual(
      (
        await database.query<{ called: boolean }>(`select exists(
          select 1 from public.io_compare_key_calls
        ) as called`)
      ).rows,
      [{ called: true }]
    )

    await database.query('create sequence public.io_domain_sequence')
    await database.query(`create domain public.volatile_io_text as text
      check (nextval('public.io_domain_sequence') > 0)`)
    await database.query(`create type public.volatile_io_envelope as (
      values public.volatile_io_text[]
    )`)

    const assertSequenceAdvanced = async (expected: string): Promise<void> => {
      assert.deepEqual(
        (
          await database.query<{ lastValue: string }>(`select
            last_value::text as "lastValue"
          from public.io_domain_sequence`)
        ).rows,
        [{ lastValue: expected }]
      )
    }

    const arrayParamSql = 'select $1::public.volatile_io_text[] as value'
    const arrayParam = await analyze(database, arrayParamSql, [])
    assert.equal(arrayParam.statements[0]?.queries[0]?.hasVolatileFunctions, true)
    await database.query(arrayParamSql, ['{array}'])
    await assertSequenceAdvanced('1')

    const compositeParamSql = 'select $1::public.volatile_io_envelope as value'
    const compositeParam = await analyze(database, compositeParamSql, [])
    assert.equal(compositeParam.statements[0]?.queries[0]?.hasVolatileFunctions, true)
    await database.query(compositeParamSql, ['("{composite}")'])
    await assertSequenceAdvanced('2')

    const coerceViaIoSql = 'select ($1::text)::public.volatile_io_text[] as value'
    const coerceViaIo = await analyze(database, coerceViaIoSql, [])
    assert.equal(coerceViaIo.statements[0]?.queries[0]?.hasVolatileFunctions, true)
    await database.query(coerceViaIoSql, ['{coerced}'])
    await assertSequenceAdvanced('3')

    await database.query(`create type public.stable_io_envelope as (
      values text[], span int4range
    )`)
    for (const sql of [
      'select $1::text[]',
      'select $1::int4range',
      'select $1::public.stable_io_envelope',
      'select ($1::text)::int4[]',
      'select array[$1::text]::text',
    ]) {
      const analysis = await analyze(database, sql, [])
      assert.equal(analysis.statements[0]?.queries[0]?.hasVolatileFunctions, false, sql)
    }
  })
})

test('native analyzer closes relation operators over volatile access-method support', async () => {
  await withDatabase(async (database) => {
    await database.query('create type public.hash_key as (value integer)')
    await database.query('create table public.hash_key_calls (called boolean default true)')
    await database.query(`create function public.hash_key_equal(
      left_value public.hash_key, right_value public.hash_key
    ) returns boolean language plpgsql immutable strict as $$
    begin
      return (left_value).value = (right_value).value;
    end
    $$`)
    await database.query(`create function public.hash_key_hash(value public.hash_key)
      returns integer language plpgsql volatile strict as $$
    begin
      insert into public.hash_key_calls default values;
      return hashint4((value).value);
      end
      $$`)
    await database.query(`create function public.hash_key_not_equal(
      left_value public.hash_key, right_value public.hash_key
    ) returns boolean language sql immutable strict
    as $$ select (left_value).value <> (right_value).value $$`)
    await database.query(`create operator public.= (
      leftarg = public.hash_key,
      rightarg = public.hash_key,
      function = public.hash_key_equal,
      hashes
    )`)
    await database.query(`create operator public.<> (
      leftarg = public.hash_key,
      rightarg = public.hash_key,
      function = public.hash_key_not_equal,
      negator = =
    )`)
    await database.query(`create operator class public.hash_key_ops
      default for type public.hash_key using hash as
        operator 1 public.=,
        function 1 public.hash_key_hash(public.hash_key)`)
    await database.query('create table public.hash_key_left (value public.hash_key)')
    await database.query('create table public.hash_key_right (value public.hash_key)')
    await database.query(`insert into public.hash_key_left(value)
      values (row(1)::public.hash_key), (row(2)::public.hash_key)`)
    await database.query(`insert into public.hash_key_right(value)
      values (row(2)::public.hash_key), (row(3)::public.hash_key)`)

    const constantSql = `select row(1)::public.hash_key
      operator(public.=) row(1)::public.hash_key as equal`
    const constant = await analyze(database, constantSql, [])
    assert.equal(constant.statements[0]?.queries[0]?.hasVolatileFunctions, false)

    const joinSql = `select left_value.value
      from public.hash_key_left left_value
      join public.hash_key_right right_value
        on left_value.value operator(public.=) right_value.value`
    const join = await analyze(database, joinSql, [])
    assert.equal(join.statements[0]?.queries[0]?.hasVolatileFunctions, true)

    const derivedJoinSql = `with left_values as (
        select value from public.hash_key_left
      ), right_values as (
        select value from public.hash_key_right
      )
      select left_value.value
      from left_values left_value
      join right_values right_value
        on left_value.value operator(public.=) right_value.value`
    const derivedJoin = await analyze(database, derivedJoinSql, [])
    assert.equal(derivedJoin.statements[0]?.queries[0]?.hasVolatileFunctions, true)

    await database.query(`create function public.stable_hash_key_identity(
      value public.hash_key
    ) returns public.hash_key language plpgsql stable strict as $$
    begin
      return value;
    end
    $$`)
    const linearScalarArraySql = `select public.stable_hash_key_identity(
      $1::public.hash_key
    ) operator(public.=) any(array[row(1)::public.hash_key]) as present`
    const linearScalarArray = await analyze(database, linearScalarArraySql, [])
    assert.equal(linearScalarArray.statements[0]?.queries[0]?.hasVolatileFunctions, false)

    const hashedScalarArraySql = `select public.stable_hash_key_identity(
      $1::public.hash_key
    ) operator(public.=) any(
      array[
        row(1)::public.hash_key, row(2)::public.hash_key,
        row(3)::public.hash_key, row(4)::public.hash_key,
        row(5)::public.hash_key, row(6)::public.hash_key,
        row(7)::public.hash_key, row(8)::public.hash_key,
        row(9)::public.hash_key
      ]
    ) as present`
    const hashedScalarArray = await analyze(database, hashedScalarArraySql, [])
    assert.equal(hashedScalarArray.statements[0]?.queries[0]?.hasVolatileFunctions, true)

    const hashedScalarArrayAllSql = `select public.stable_hash_key_identity(
      $1::public.hash_key
    ) operator(public.<>) all(
      array[
        row(1)::public.hash_key, row(2)::public.hash_key,
        row(3)::public.hash_key, row(4)::public.hash_key,
        row(5)::public.hash_key, row(6)::public.hash_key,
        row(7)::public.hash_key, row(8)::public.hash_key,
        row(9)::public.hash_key
      ]
    ) as absent`
    const hashedScalarArrayAll = await analyze(database, hashedScalarArrayAllSql, [])
    assert.equal(hashedScalarArrayAll.statements[0]?.queries[0]?.hasVolatileFunctions, true)

    const builtinScalarArray = await analyze(
      database,
      'select 1 = any(array[1, 2, 3, 4, 5, 6, 7, 8, 9]) as present',
      []
    )
    assert.equal(builtinScalarArray.statements[0]?.queries[0]?.hasVolatileFunctions, false)

    await database.query('set enable_nestloop = off')
    await database.query('set enable_mergejoin = off')
    assert.equal((await database.query(joinSql)).rows.length, 1)
    assert.equal((await database.query(derivedJoinSql)).rows.length, 1)
    await database.query('truncate public.hash_key_calls')
    assert.deepEqual((await database.query(linearScalarArraySql, ['(1)'])).rows, [{ present: true }])
    assert.deepEqual(
      (
        await database.query<{ called: boolean }>(`select exists(
          select 1 from public.hash_key_calls
        ) as called`)
      ).rows,
      [{ called: false }]
    )
    await database.query('truncate public.hash_key_calls')
    assert.deepEqual((await database.query(hashedScalarArraySql, ['(1)'])).rows, [{ present: true }])
    assert.deepEqual(
      (
        await database.query<{ called: boolean }>(`select exists(
        select 1 from public.hash_key_calls
      ) as called`)
      ).rows,
      [{ called: true }]
    )
    await database.query('truncate public.hash_key_calls')
    assert.deepEqual((await database.query(hashedScalarArrayAllSql, ['(10)'])).rows, [{ absent: true }])
    assert.deepEqual(
      (
        await database.query<{ called: boolean }>(`select exists(
        select 1 from public.hash_key_calls
      ) as called`)
      ).rows,
      [{ called: true }]
    )
  })
})

test('native analyzer skips unreachable scalar-array operator support for empty and null arrays', async () => {
  await withDatabase(async (database) => {
    await database.query('create type public.empty_saop_key as (value integer)')
    await database.query('create table public.empty_saop_calls (kind text)')
    await database.query(`create function public.empty_saop_equal(
      left_value public.empty_saop_key, right_value public.empty_saop_key
    ) returns boolean language plpgsql volatile strict as $$
    begin
      insert into public.empty_saop_calls(kind) values ('operator');
      return (left_value).value = (right_value).value;
    end
    $$`)
    await database.query(`create function public.empty_saop_not_equal(
      left_value public.empty_saop_key, right_value public.empty_saop_key
    ) returns boolean language plpgsql volatile strict as $$
    begin
      insert into public.empty_saop_calls(kind) values ('operator');
      return (left_value).value <> (right_value).value;
    end
    $$`)
    await database.query(`create operator public.= (
      leftarg = public.empty_saop_key,
      rightarg = public.empty_saop_key,
      function = public.empty_saop_equal
    )`)
    await database.query(`create operator public.<> (
      leftarg = public.empty_saop_key,
      rightarg = public.empty_saop_key,
      function = public.empty_saop_not_equal
    )`)

    for (const [sql, expected] of [
      [
        `select row(1)::public.empty_saop_key
          operator(public.=) any('{}'::public.empty_saop_key[]) as result`,
        false,
      ],
      [
        `select row(1)::public.empty_saop_key
          operator(public.<>) all('{}'::public.empty_saop_key[]) as result`,
        true,
      ],
      [
        `select row(1)::public.empty_saop_key
          operator(public.=) any(null::public.empty_saop_key[]) as result`,
        null,
      ],
    ] as const) {
      const analysis = await analyze(database, sql, [])
      assert.equal(analysis.statements[0]?.queries[0]?.hasVolatileFunctions, false, sql)
      assert.deepEqual((await database.query(sql)).rows, [{ result: expected }], sql)
      assert.deepEqual((await database.query('select kind from public.empty_saop_calls')).rows, [], sql)
    }

    await database.query(`create function public.volatile_empty_saop_key()
      returns public.empty_saop_key language plpgsql volatile as $$
    begin
      insert into public.empty_saop_calls(kind) values ('child');
      return row(1)::public.empty_saop_key;
    end
    $$`)
    const volatileChildSql = `select public.volatile_empty_saop_key()
      operator(public.=) any('{}'::public.empty_saop_key[]) as result`
    const volatileChild = await analyze(database, volatileChildSql, [])
    assert.equal(volatileChild.statements[0]?.queries[0]?.hasVolatileFunctions, true)
    assert.deepEqual((await database.query(volatileChildSql)).rows, [{ result: false }])
    assert.deepEqual((await database.query('select kind from public.empty_saop_calls')).rows, [{ kind: 'child' }])
  })
})

test('native analyzer ignores volatile support for unrelated types in a shared operator family', async () => {
  await withDatabase(async (database) => {
    await database.query('create type public.shared_family_left as (value integer)')
    await database.query('create type public.shared_family_right as (value integer)')
    await database.query('create table public.shared_family_right_calls (called boolean default true)')

    for (const name of ['left', 'right'] as const) {
      await database.query(`create function public.shared_family_${name}_equal(
        left_value public.shared_family_${name}, right_value public.shared_family_${name}
      ) returns boolean language sql immutable strict as $$
        select (left_value).value = (right_value).value
      $$`)
      await database.query(`create operator public.= (
        leftarg = public.shared_family_${name},
        rightarg = public.shared_family_${name},
        function = public.shared_family_${name}_equal
      )`)
    }

    await database.query(`create function public.shared_family_left_compare(
      left_value public.shared_family_left, right_value public.shared_family_left
    ) returns integer language sql immutable strict as $$
      select case
        when (left_value).value < (right_value).value then -1
        when (left_value).value > (right_value).value then 1
        else 0
      end
    $$`)
    await database.query(`create function public.shared_family_right_compare(
      left_value public.shared_family_right, right_value public.shared_family_right
    ) returns integer language plpgsql volatile strict as $$
    begin
      insert into public.shared_family_right_calls default values;
      return case
        when (left_value).value < (right_value).value then -1
        when (left_value).value > (right_value).value then 1
        else 0
      end;
    end
    $$`)
    await database.query('create operator family public.shared_key_ops using btree')
    await database.query(`alter operator family public.shared_key_ops using btree add
      operator 3 public.= (
        public.shared_family_left, public.shared_family_left
      ),
      function 1 public.shared_family_left_compare(
        public.shared_family_left, public.shared_family_left
      ),
      operator 3 public.= (
        public.shared_family_right, public.shared_family_right
      ),
      function 1 public.shared_family_right_compare(
        public.shared_family_right, public.shared_family_right
      )`)
    await database.query('create table public.shared_family_values (value public.shared_family_left)')
    await database.query(`insert into public.shared_family_values(value)
      values (row(1)::public.shared_family_left)`)

    const sql = `select value
      from public.shared_family_values
      where value operator(public.=) row(1)::public.shared_family_left`
    const analysis = await analyze(database, sql, [])
    assert.equal(analysis.statements[0]?.queries[0]?.hasVolatileFunctions, false)
    assert.equal((await database.query(sql)).rows.length, 1)
    assert.deepEqual(
      (
        await database.query<{ called: boolean }>(`select exists(
          select 1 from public.shared_family_right_calls
        ) as called`)
      ).rows,
      [{ called: false }]
    )
  })
})

test('native analyzer maps direct DML parameters to PostgreSQL target columns', async () => {
  await withDatabase(async (database) => {
    const insert = await analyze(
      database,
      'insert into public.accounts(email, display_name) values ($1, $2), ($3, $4)',
      []
    )
    assert.deepEqual(
      insert.statements[0]?.queries[0]?.dmlParameterTargets.map(
        ({ paramId, source, targetAttname, targetNullable }) => ({
          paramId,
          source,
          targetAttname,
          targetNullable,
        })
      ),
      [
        { paramId: 1, source: 'INSERT', targetAttname: 'email', targetNullable: false },
        { paramId: 3, source: 'INSERT', targetAttname: 'email', targetNullable: false },
        { paramId: 2, source: 'INSERT', targetAttname: 'display_name', targetNullable: true },
        { paramId: 4, source: 'INSERT', targetAttname: 'display_name', targetNullable: true },
      ]
    )
    assert.ok(
      insert.statements[0]?.queries[0]?.dmlParameterTargets.every(
        (target) => target.targetRelid > 0 && target.targetAttnum > 0 && target.targetTypeOid > 0
      )
    )

    const repeatedInsert = await analyze(
      database,
      'insert into public.accounts(email, display_name) values ($1, $2), ($1, $2)',
      []
    )
    assert.deepEqual(
      repeatedInsert.statements[0]?.queries[0]?.dmlParameterTargets.map(({ paramId, targetAttname }) => ({
        paramId,
        targetAttname,
      })),
      [
        { paramId: 1, targetAttname: 'email' },
        { paramId: 2, targetAttname: 'display_name' },
      ]
    )

    const cteInsert = await analyze(
      database,
      `with source(email) as (select $1::text)
       insert into public.accounts(email)
       select source.email from source`,
      []
    )
    assert.deepEqual(
      cteInsert.statements[0]?.queries[0]?.dmlParameterTargets.map(
        ({ paramId, source, targetAttname, targetNullable }) => ({
          paramId,
          source,
          targetAttname,
          targetNullable,
        })
      ),
      [{ paramId: 1, source: 'INSERT', targetAttname: 'email', targetNullable: false }]
    )

    const update = await analyze(
      database,
      'update public.accounts account set display_name = $1::text, email = $2 where account.id = $3',
      [23, 25, 20]
    )
    assert.deepEqual(
      update.statements[0]?.queries[0]?.dmlParameterTargets.map(
        ({ paramId, source, targetAttname, targetNullable, targetTypeName }) => ({
          paramId,
          source,
          targetAttname,
          targetNullable,
          targetTypeName,
        })
      ),
      [
        { paramId: 2, source: 'UPDATE', targetAttname: 'email', targetNullable: false, targetTypeName: 'text' },
        {
          paramId: 1,
          source: 'UPDATE',
          targetAttname: 'display_name',
          targetNullable: true,
          targetTypeName: 'text',
        },
      ]
    )

    const upsert = await analyze(
      database,
      `insert into public.accounts(email, display_name)
       values ($1, $2)
       on conflict (email) do update set display_name = $3`,
      []
    )
    assert.deepEqual(
      upsert.statements[0]?.queries[0]?.dmlParameterTargets.map(({ paramId, source, targetAttname }) => ({
        paramId,
        source,
        targetAttname,
      })),
      [
        { paramId: 1, source: 'INSERT', targetAttname: 'email' },
        { paramId: 2, source: 'INSERT', targetAttname: 'display_name' },
        { paramId: 3, source: 'ON_CONFLICT_UPDATE', targetAttname: 'display_name' },
      ]
    )

    const merge = await analyze(
      database,
      `merge into public.accounts account
       using (values ($1::text, $2::text)) source(email, display_name)
       on account.email = source.email
       when matched then update set display_name = $3
       when not matched then insert (email, display_name) values (source.email, $4)`,
      []
    )
    assert.deepEqual(
      merge.statements[0]?.queries[0]?.dmlParameterTargets.map(({ paramId, source, targetAttname }) => ({
        paramId,
        source,
        targetAttname,
      })),
      [
        { paramId: 3, source: 'MERGE_UPDATE', targetAttname: 'display_name' },
        { paramId: 1, source: 'MERGE_INSERT', targetAttname: 'email' },
        { paramId: 4, source: 'MERGE_INSERT', targetAttname: 'display_name' },
      ]
    )

    const modifyingCte = await analyze(
      database,
      `with inserted as (
         insert into public.accounts(email, display_name) values ($1, $2)
         returning id
       )
       select id from inserted`,
      []
    )
    assert.deepEqual(modifyingCte.statements[0]?.queries[0]?.dmlParameterTargets, [])
    assert.deepEqual(
      modifyingCte.statements[0]?.queries[0]?.cteList[0]?.query?.dmlParameterTargets.map(
        ({ paramId, source, targetAttname }) => ({ paramId, source, targetAttname })
      ),
      [
        { paramId: 1, source: 'INSERT', targetAttname: 'email' },
        { paramId: 2, source: 'INSERT', targetAttname: 'display_name' },
      ]
    )

    const setOperation = await analyze(
      database,
      `insert into public.accounts(email)
       select $1::text
       union all
       select coalesce($1, 'fallback')`,
      []
    )
    assert.deepEqual(
      setOperation.statements[0]?.queries[0]?.dmlParameterTargets.map(
        ({ directAssignment, paramId, targetNullAdmission }) => ({
          directAssignment,
          paramId,
          targetNullAdmission,
        })
      ),
      [
        { directAssignment: true, paramId: 1, targetNullAdmission: 'rejects' },
        { directAssignment: false, paramId: 1, targetNullAdmission: 'unknown' },
      ]
    )

    const opaqueSetOperationPath = await analyze(
      database,
      `insert into public.accounts(display_name)
       select $1::text
       union all
       select coalesce($1, 'fallback')`,
      []
    )
    assert.deepEqual(
      opaqueSetOperationPath.statements[0]?.queries[0]?.dmlParameterTargets.map(({ paramId, targetNullAdmission }) => ({
        paramId,
        targetNullAdmission,
      })),
      [
        { paramId: 1, targetNullAdmission: 'accepts' },
        { paramId: 1, targetNullAdmission: 'unknown' },
      ]
    )
    assert.deepEqual(
      opaqueSetOperationPath.statements[0]?.queries[0]?.dmlParameterTargets.map(
        ({ directAssignment }) => directAssignment
      ),
      [true, false]
    )

    const opaqueNotNullTarget = await analyze(
      database,
      `insert into public.accounts(email)
       values (coalesce($1::text, 'fallback@example.com'))`,
      []
    )
    assert.deepEqual(
      opaqueNotNullTarget.statements[0]?.queries[0]?.dmlParameterTargets.map(
        ({ directAssignment, targetNullAdmission }) => ({ directAssignment, targetNullAdmission })
      ),
      [{ directAssignment: false, targetNullAdmission: 'unknown' }]
    )

    const exceptFilter = await analyze(
      database,
      `insert into public.accounts(email)
       select 'fixed@example.com'::text
       except
       select $1::text`,
      []
    )
    assert.deepEqual(exceptFilter.statements[0]?.queries[0]?.dmlParameterTargets, [])

    const intersectFilter = await analyze(
      database,
      `insert into public.accounts(email)
       select $1::text
       intersect
       select 'fixed@example.com'::text`,
      []
    )
    assert.deepEqual(
      intersectFilter.statements[0]?.queries[0]?.dmlParameterTargets.map(
        ({ directAssignment, paramId, targetNullAdmission }) => ({
          directAssignment,
          paramId,
          targetNullAdmission,
        })
      ),
      [{ directAssignment: false, paramId: 1, targetNullAdmission: 'unknown' }]
    )

    const intersectRightLineageSql = `insert into public.accounts(email, display_name)
      select null::text, $1::text
      intersect
      select $1::text, $1::text`
    const intersectRightLineage = await analyze(database, intersectRightLineageSql, [])
    assert.deepEqual(
      intersectRightLineage.statements[0]?.queries[0]?.dmlParameterTargets
        .filter(({ targetAttname }) => targetAttname === 'email')
        .map(({ directAssignment, paramId, targetNullAdmission }) => ({
          directAssignment,
          paramId,
          targetNullAdmission,
        })),
      [{ directAssignment: false, paramId: 1, targetNullAdmission: 'unknown' }]
    )
    await assert.rejects(database.query(intersectRightLineageSql, [null]), /null value in column "email"/u)
    await database.query(intersectRightLineageSql, ['different@example.test'])

    const filteredProjection = await analyze(
      database,
      `insert into public.accounts(email)
       select $1::text where false`,
      []
    )
    assert.deepEqual(
      filteredProjection.statements[0]?.queries[0]?.dmlParameterTargets.map(
        ({ directAssignment, paramId, targetNullAdmission }) => ({
          directAssignment,
          paramId,
          targetNullAdmission,
        })
      ),
      [{ directAssignment: false, paramId: 1, targetNullAdmission: 'unknown' }]
    )

    const nullableFilteredProjection = await analyze(
      database,
      `insert into public.accounts(display_name)
       select $1::text where false`,
      []
    )
    assert.deepEqual(
      nullableFilteredProjection.statements[0]?.queries[0]?.dmlParameterTargets.map(
        ({ directAssignment, paramId, targetNullAdmission }) => ({
          directAssignment,
          paramId,
          targetNullAdmission,
        })
      ),
      [{ directAssignment: false, paramId: 1, targetNullAdmission: 'accepts' }]
    )

    const limitedSetOperation = await analyze(
      database,
      `insert into public.accounts(email)
       (select $1::text union all select 'fixed@example.com'::text)
       limit 0`,
      []
    )
    assert.deepEqual(
      limitedSetOperation.statements[0]?.queries[0]?.dmlParameterTargets.map(
        ({ directAssignment, paramId, targetNullAdmission }) => ({
          directAssignment,
          paramId,
          targetNullAdmission,
        })
      ),
      [{ directAssignment: false, paramId: 1, targetNullAdmission: 'unknown' }]
    )

    const allSetOperationBranches = await analyze(
      database,
      `insert into public.accounts(display_name)
       select $1::text
       union all
       select $2::text
       union
       select $3::text`,
      []
    )
    assert.deepEqual(
      allSetOperationBranches.statements[0]?.queries[0]?.dmlParameterTargets
        .map(({ paramId }) => paramId)
        .toSorted((left, right) => left - right),
      [1, 2, 3]
    )

    const longCteNames = Array.from({ length: 20 }, (_, index) => `lineage_${index}`)
    const longCteSql = longCteNames
      .map((name, index) =>
        index === 0
          ? `${name}(value) as (select $1::text)`
          : `${name}(value) as (select value from ${longCteNames[index - 1]})`
      )
      .join(',\n')
    const longLineage = await analyze(
      database,
      `with ${longCteSql}
       insert into public.accounts(display_name)
       select value from ${longCteNames.at(-1)}`,
      []
    )
    assert.deepEqual(
      longLineage.statements[0]?.queries[0]?.dmlParameterTargets.map(({ paramId }) => paramId),
      [1]
    )

    const recursiveLineage = await analyze(
      database,
      `with recursive source(value) as (
         select $1::text
         union all
         select value from source where false
       )
       insert into public.accounts(display_name)
       select value from source`,
      []
    )
    assert.deepEqual(
      recursiveLineage.statements[0]?.queries[0]?.dmlParameterTargets.map(({ paramId }) => paramId),
      [1]
    )

    const joinAliasLineage = await analyze(
      database,
      `insert into public.accounts(display_name)
       select joined.value
       from ((values ($1::text)) source(value) cross join (values (1)) marker(n)) joined`,
      []
    )
    assert.deepEqual(
      joinAliasLineage.statements[0]?.queries[0]?.dmlParameterTargets.map(({ paramId }) => paramId),
      [1]
    )

    await database.query(`create table public.outer_join_probe (
      value text check (value in ('allowed'))
    )`)
    const nullExtendedLineage = await analyze(
      database,
      `insert into public.outer_join_probe(value)
       select candidate.value
       from (values (1)) guaranteed(marker)
       left join (values ($1::text)) candidate(value) on false`,
      []
    )
    assert.deepEqual(
      nullExtendedLineage.statements[0]?.queries[0]?.dmlParameterTargets.map(
        ({ directAssignment, paramId, targetNullAdmission }) => ({ directAssignment, paramId, targetNullAdmission })
      ),
      [{ directAssignment: false, paramId: 1, targetNullAdmission: 'accepts' }]
    )

    const repeatedValues = Array.from({ length: 256 }, () => '($1::text)').join(', ')
    const manyDuplicates = await analyze(
      database,
      `insert into public.accounts(display_name) values ${repeatedValues}`,
      []
    )
    assert.equal(manyDuplicates.statements[0]?.queries[0]?.dmlParameterTargets.length, 1)

    const deeplyNestedParameters = Array.from({ length: 256 }, (_, index) => `$${index + 1}::integer`).join(' + ')
    const nestedUsage = await analyze(database, `select ${deeplyNestedParameters}`, [])
    assert.equal(nestedUsage.paramUsageNullAdmissions.length, 256)
    assert.ok(nestedUsage.paramUsageNullAdmissions.every((admission) => admission === 'accepts'))

    await database.query('create table public.view_values (value text)')
    await database.query(`create view public.non_null_view as
      select value from public.view_values where value is not null
      with local check option`)
    await database.query(`create table public.partitioned_values (bucket integer, value text)
      partition by list (bucket)`)
    await database.query(`create table public.partitioned_values_one
      partition of public.partitioned_values for values in (1)`)
    await database.query('alter table public.partitioned_values_one alter column value set not null')
    const checkedView = await analyze(database, 'insert into public.non_null_view(value) values ($1)', [])
    assert.deepEqual(
      checkedView.statements[0]?.queries[0]?.dmlParameterTargets.map(({ paramId, targetNullAdmission }) => ({
        paramId,
        targetNullAdmission,
      })),
      [{ paramId: 1, targetNullAdmission: 'unknown' }]
    )
    const partitionedTarget = await analyze(
      database,
      'insert into public.partitioned_values(bucket, value) values (1, $1)',
      []
    )
    assert.deepEqual(
      partitionedTarget.statements[0]?.queries[0]?.dmlParameterTargets.map(({ paramId, targetNullAdmission }) => ({
        paramId,
        targetNullAdmission,
      })),
      [{ paramId: 1, targetNullAdmission: 'unknown' }]
    )

    await database.query('create domain public.maybe_text as text')
    await database.query("create domain public.checked_text as text check (value <> '')")
    await database.query('create domain public.null_accepting_text as text check (value is null)')
    await database.query('create domain public.null_rejecting_text as text check (value is not null)')
    await database.query("create domain public.null_unknown_text as text check (concat(value, '') <> '')")
    await database.query('create domain public.non_null_text as text not null')
    await database.query('create domain public.nested_non_null_text as public.non_null_text')
    await database.query(`
      create table public.domain_probe (
        value text,
        maybe_value public.maybe_text,
        checked_value public.checked_text,
        accepting_value public.null_accepting_text,
        rejecting_value public.null_rejecting_text,
        unknown_value public.null_unknown_text,
        required_value public.non_null_text,
        nested_required_value public.nested_non_null_text
      )
    `)

    const domainTypedSource = await analyze(
      database,
      'insert into public.domain_probe(value) values ($1::public.non_null_text)',
      []
    )
    assert.deepEqual(domainTypedSource.paramTypeNullAdmissions, ['rejects'])
    assert.equal(domainTypedSource.statements[0]?.queries[0]?.dmlParameterTargets[0]?.targetNullAdmission, 'accepts')

    const rejectingReturningUse = await analyze(
      database,
      `insert into public.domain_probe(value)
       values ($1::text)
       returning ($1::text)::public.non_null_text`,
      []
    )
    assert.deepEqual(rejectingReturningUse.paramTypeNullAdmissions, ['accepts'])
    assert.deepEqual(rejectingReturningUse.paramUsageNullAdmissions, ['rejects'])

    const domainTargets = await analyze(
      database,
      `insert into public.domain_probe(maybe_value, checked_value, required_value, nested_required_value)
       values ($1, $2, $3, $4)`,
      []
    )
    assert.deepEqual(
      domainTargets.statements[0]?.queries[0]?.dmlParameterTargets.map(
        ({ paramId, targetAttname, targetNullable }) => ({ paramId, targetAttname, targetNullable })
      ),
      [
        { paramId: 1, targetAttname: 'maybe_value', targetNullable: true },
        { paramId: 2, targetAttname: 'checked_value', targetNullable: true },
        { paramId: 3, targetAttname: 'required_value', targetNullable: false },
        { paramId: 4, targetAttname: 'nested_required_value', targetNullable: false },
      ]
    )

    const domainCheckAdmissions = await analyze(
      database,
      `insert into public.domain_probe(accepting_value, rejecting_value, unknown_value)
       values ($1, $2, $3)`,
      []
    )
    assert.deepEqual(
      domainCheckAdmissions.statements[0]?.queries[0]?.dmlParameterTargets.map(
        ({ paramId, targetNullAdmission, targetNullable }) => ({
          paramId,
          targetNullAdmission,
          targetNullable,
        })
      ),
      [
        { paramId: 1, targetNullAdmission: 'accepts', targetNullable: true },
        { paramId: 2, targetNullAdmission: 'rejects', targetNullable: false },
        { paramId: 3, targetNullAdmission: 'unknown', targetNullable: false },
      ]
    )

    await database.query(`
      create table public.table_check_probe (
        accepting_value text check (accepting_value is null),
        rejecting_value text check (rejecting_value is not null),
        other_value text,
        unknown_value text check (unknown_value is null or other_value is not null)
      )
    `)
    const tableCheckAdmissions = await analyze(
      database,
      `insert into public.table_check_probe(accepting_value, rejecting_value, unknown_value)
       values ($1, $2, $3)`,
      []
    )
    assert.deepEqual(
      tableCheckAdmissions.statements[0]?.queries[0]?.dmlParameterTargets.map(({ paramId, targetNullAdmission }) => ({
        paramId,
        targetNullAdmission,
      })),
      [
        { paramId: 1, targetNullAdmission: 'accepts' },
        { paramId: 2, targetNullAdmission: 'rejects' },
        { paramId: 3, targetNullAdmission: 'accepts' },
      ]
    )

    await database.query(`create table public.foreign_key_parent (
      left_key integer,
      right_key integer,
      primary key (left_key, right_key)
    )`)
    await database.query(`create table public.match_full_child (
      left_key integer,
      right_key integer,
      payload text,
      foreign key (left_key, right_key)
        references public.foreign_key_parent (left_key, right_key) match full
    )`)
    await database.query(`create table public.match_simple_child (
      left_key integer,
      right_key integer,
      foreign key (left_key, right_key)
        references public.foreign_key_parent (left_key, right_key) match simple
    )`)

    const matchFullMixed = await analyze(
      database,
      'insert into public.match_full_child(left_key, right_key) values ($1, 2)',
      []
    )
    assert.equal(matchFullMixed.statements[0]?.queries[0]?.dmlParameterTargets[0]?.targetNullAdmission, 'rejects')
    await assert.rejects(
      database.query('insert into public.match_full_child(left_key, right_key) values ($1, 2)', [null]),
      /match_full_child_left_key_right_key_fkey/u
    )

    const matchFullAllNull = await analyze(
      database,
      'insert into public.match_full_child(left_key, right_key) values ($1, null)',
      []
    )
    assert.equal(matchFullAllNull.statements[0]?.queries[0]?.dmlParameterTargets[0]?.targetNullAdmission, 'accepts')
    await database.query('insert into public.match_full_child(left_key, right_key) values ($1, null)', [null])

    const matchFullSameParameter = await analyze(
      database,
      'insert into public.match_full_child(left_key, right_key) values ($1, $1)',
      []
    )
    assert.ok(
      matchFullSameParameter.statements[0]?.queries[0]?.dmlParameterTargets.every(
        ({ targetNullAdmission }) => targetNullAdmission === 'accepts'
      )
    )
    await database.query('insert into public.match_full_child(left_key, right_key) values ($1, $1)', [null])

    const matchFullUnknownPeer = await analyze(
      database,
      'insert into public.match_full_child(left_key, right_key) values ($1, $2)',
      []
    )
    assert.ok(
      matchFullUnknownPeer.statements[0]?.queries[0]?.dmlParameterTargets.every(
        ({ targetNullAdmission }) => targetNullAdmission === 'unknown'
      )
    )

    const matchSimpleMixed = await analyze(
      database,
      'insert into public.match_simple_child(left_key, right_key) values ($1, 2)',
      []
    )
    assert.equal(matchSimpleMixed.statements[0]?.queries[0]?.dmlParameterTargets[0]?.targetNullAdmission, 'accepts')
    await database.query('insert into public.match_simple_child(left_key, right_key) values ($1, 2)', [null])

    const matchFullUnrelatedColumn = await analyze(
      database,
      'insert into public.match_full_child(left_key, right_key, payload) values (null, null, $1)',
      []
    )
    assert.equal(
      matchFullUnrelatedColumn.statements[0]?.queries[0]?.dmlParameterTargets[0]?.targetNullAdmission,
      'accepts'
    )

    await database.query(`create table public.any_empty_probe (
      value integer check (value = any (array[array[]::integer[]]))
    )`)
    const emptyNestedArrayCheck = await analyze(database, 'insert into public.any_empty_probe(value) values ($1)', [])
    assert.equal(
      emptyNestedArrayCheck.statements[0]?.queries[0]?.dmlParameterTargets[0]?.targetNullAdmission,
      'rejects'
    )
    await assert.rejects(
      database.query('insert into public.any_empty_probe(value) values ($1)', [null]),
      /any_empty_probe_value_check/u
    )

    await database.query(`create table public.any_mismatched_array_probe (
      value integer check (
        value = any (array[array[]::integer[], array[value]])
      )
    )`)
    const mismatchedNestedArrayCheck = await analyze(
      database,
      'insert into public.any_mismatched_array_probe(value) values ($1)',
      []
    )
    assert.deepEqual(
      mismatchedNestedArrayCheck.statements[0]?.queries[0]?.dmlParameterTargets.map(
        ({ targetNullAdmission, targetNullable }) => ({ targetNullAdmission, targetNullable })
      ),
      [{ targetNullAdmission: 'unknown', targetNullable: false }]
    )
    await assert.rejects(
      database.query('insert into public.any_mismatched_array_probe(value) values ($1)', [null]),
      /multidimensional arrays must have array expressions with matching dimensions/u
    )

    await database.query(`create table public.any_compatible_array_probe (
      value integer check (
        value = any (array[array[value], array[value]])
      )
    )`)
    const compatibleNestedArrayCheck = await analyze(
      database,
      'insert into public.any_compatible_array_probe(value) values ($1)',
      []
    )
    assert.deepEqual(
      compatibleNestedArrayCheck.statements[0]?.queries[0]?.dmlParameterTargets.map(
        ({ targetNullAdmission, targetNullable }) => ({ targetNullAdmission, targetNullable })
      ),
      [{ targetNullAdmission: 'accepts', targetNullable: true }]
    )
    await database.query('insert into public.any_compatible_array_probe(value) values ($1)', [null])

    await database.query(`create table public.generated_probe (
      input text,
      derived text generated always as (input) stored not null
    )`)
    const generatedTarget = await analyze(database, 'insert into public.generated_probe(input) values ($1)', [])
    assert.equal(generatedTarget.statements[0]?.queries[0]?.dmlParameterTargets[0]?.targetNullAdmission, 'unknown')

    await database.query('create foreign data wrapper dummy no handler')
    await database.query('create server dummy_server foreign data wrapper dummy')
    await database.query('create foreign table public.foreign_probe(value text) server dummy_server')
    const foreignTarget = await analyze(database, 'insert into public.foreign_probe(value) values ($1)', [])
    assert.equal(foreignTarget.statements[0]?.queries[0]?.dmlParameterTargets[0]?.targetNullAdmission, 'unknown')

    const explicitNonNullDomainCoercion = await analyze(
      database,
      'insert into public.domain_probe(value) values (($1::text)::public.non_null_text)',
      []
    )
    assert.deepEqual(
      explicitNonNullDomainCoercion.statements[0]?.queries[0]?.dmlParameterTargets.map(
        ({ paramId, targetAttname, targetNullable }) => ({ paramId, targetAttname, targetNullable })
      ),
      [{ paramId: 1, targetAttname: 'value', targetNullable: false }]
    )

    const mixedDomainPaths = await analyze(
      database,
      `insert into public.domain_probe(value)
       values ($1), (($1::text)::public.non_null_text)`,
      []
    )
    assert.deepEqual(
      mixedDomainPaths.statements[0]?.queries[0]?.dmlParameterTargets.map(
        ({ paramId, targetAttname, targetNullable }) => ({ paramId, targetAttname, targetNullable })
      ),
      [
        { paramId: 1, targetAttname: 'value', targetNullable: true },
        { paramId: 1, targetAttname: 'value', targetNullable: false },
      ]
    )

    const cteDomainCoercion = await analyze(
      database,
      `with source(value) as (
         select ($1::text)::public.non_null_text
       )
       insert into public.domain_probe(value)
       select value from source`,
      []
    )
    assert.deepEqual(
      cteDomainCoercion.statements[0]?.queries[0]?.dmlParameterTargets.map(
        ({ paramId, targetAttname, targetNullable }) => ({ paramId, targetAttname, targetNullable })
      ),
      [{ paramId: 1, targetAttname: 'value', targetNullable: false }]
    )

    await database.query('create sequence public.domain_side_effect_sequence')
    await database.query(`create domain public.volatile_text as text
      check (nextval('public.domain_side_effect_sequence') > 0)`)
    const volatileDomain = await analyze(database, 'select $1::public.volatile_text', [])
    assert.equal(volatileDomain.statements[0]?.queries[0]?.hasVolatileFunctions, true)

    await database.query('create table public.trigger_probe (value text)')
    await database.query(`create function public.reject_null_trigger() returns trigger
      language plpgsql as $$
      begin
        if new.value is null then
          raise exception 'value must not be null';
        end if;
        return new;
      end
      $$`)
    await database.query(`create trigger reject_null before insert on public.trigger_probe
      for each row execute function public.reject_null_trigger()`)
    const triggerTarget = await analyze(database, 'insert into public.trigger_probe(value) values ($1)', [])
    assert.equal(triggerTarget.statements[0]?.queries[0]?.dmlParameterTargets[0]?.targetNullAdmission, 'unknown')

    await database.query(`create table public.trigger_checked_probe (
      value text check (value in ('allowed'))
    )`)
    await database.query(`create function public.force_allowed_trigger() returns trigger
      language plpgsql as $$
      begin
        new.value := 'allowed';
        return new;
      end
      $$`)
    await database.query(`create trigger force_allowed before insert on public.trigger_checked_probe
      for each row execute function public.force_allowed_trigger()`)
    const rewrittenTriggerSql = 'insert into public.trigger_checked_probe(value) values ($1)'
    const rewrittenTriggerTarget = await analyze(database, rewrittenTriggerSql, [])
    assert.deepEqual(
      rewrittenTriggerTarget.statements[0]?.queries[0]?.dmlParameterTargets.map(
        ({ directAssignment, paramId, targetNullAdmission }) => ({
          directAssignment,
          paramId,
          targetNullAdmission,
        })
      ),
      [{ directAssignment: false, paramId: 1, targetNullAdmission: 'unknown' }]
    )
    await database.query(rewrittenTriggerSql, ['outside'])
    assert.deepEqual((await database.query<{ value: string }>('select value from public.trigger_checked_probe')).rows, [
      { value: 'allowed' },
    ])

    await database.query('create table public.rls_probe (value text)')
    await database.query('alter table public.rls_probe enable row level security')
    await database.query(`create policy require_value on public.rls_probe
      for insert with check (value is not null)`)
    const rlsTarget = await analyze(database, 'insert into public.rls_probe(value) values ($1)', [])
    assert.equal(rlsTarget.statements[0]?.queries[0]?.dmlParameterTargets[0]?.targetNullAdmission, 'unknown')

    await database.query('create table public.conditional_rule_source (value text)')
    await database.query('create table public.conditional_rule_sink (value text not null)')
    await database.query(`create rule conditional_rule as
      on insert to public.conditional_rule_source
      where new.value is not null
      do also insert into public.conditional_rule_sink(value) values (new.value)`)
    const conditionalRule = await analyze(database, 'insert into public.conditional_rule_source(value) values ($1)', [])
    assert.deepEqual(
      conditionalRule.statements[0]?.queries
        .flatMap((query) => query.dmlParameterTargets)
        .map(({ directAssignment, targetNullAdmission, targetNullable }) => ({
          directAssignment,
          targetNullAdmission,
          targetNullable,
        }))
        .toSorted((left, right) => Number(left.targetNullable) - Number(right.targetNullable)),
      [
        { directAssignment: false, targetNullAdmission: 'unknown', targetNullable: false },
        { directAssignment: true, targetNullAdmission: 'accepts', targetNullable: true },
      ]
    )
  })
})

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
  readonly attname?: string | null
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

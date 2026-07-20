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
  readonly fromTree: NativeFromNode
  readonly hasModifyingCTE: boolean
  readonly hasLimitCount: boolean
  readonly hasRowMarks: boolean
  readonly limitWithTies: boolean
  readonly hasVolatileFunctions: boolean
  readonly returningList: readonly NativeTarget[]
  readonly rtable: readonly NativeRte[]
  readonly targetList: readonly NativeTarget[]
  readonly utilityKind: 'CALL' | 'EXECUTE' | 'EXPLAIN' | 'FETCH' | 'NONE' | 'OTHER' | 'SHOW'
  readonly utilityReturnsTuples: boolean
}

interface NativeFromNode {
  readonly fromlist?: readonly NativeFromNode[]
  readonly joinType?: string
  readonly left?: NativeFromNode
  readonly quals?: NativeExpr | null
  readonly right?: NativeFromNode
  readonly rtindex?: number
  readonly tag: string
  readonly truncated?: boolean
}

interface NativeRte {
  readonly cteLevelSup?: number
  readonly cteName?: string
  readonly cteSelfReference?: boolean
  readonly erefColumnNames?: readonly string[]
  readonly groupExprs?: readonly NativeExpr[]
  readonly joinAliasVars?: readonly (NativeExpr | null)[]
  readonly kind: string
  readonly lateral: boolean
  readonly relid?: number
  readonly subquery?: NativeQuery
  readonly valuesLists?: readonly (readonly NativeExpr[])[]
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
  readonly recursive?: boolean
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
  readonly coercionForm?: string
  readonly domainNullAdmission?: 'accepts' | 'rejects' | 'unknown'
  readonly elementExpr?: NativeExpr
  readonly elements?: readonly NativeExpr[]
  readonly funcVariadic?: boolean
  readonly inputFunctionOid?: number
  readonly multidims?: boolean
  readonly nonNullInputProducesNonNull?: boolean
  readonly nullInputProducesNull?: boolean
  readonly outputFunctionOid?: number
  readonly relname?: string | null
  readonly rteKind?: string
  readonly subLinkType?: string
  readonly subquery?: NativeQuery
  readonly tag: string
  readonly varattno?: number
  readonly varlevelsup?: number
  readonly varnullingrels?: readonly number[]
  readonly varno?: number
  readonly varreturningtype?: 'DEFAULT' | 'NEW' | 'OLD' | 'UNRECOGNIZED'
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

    assert.equal(analysis.schemaVersion, 9)
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
    assert.equal(query.fromTree.tag, 'FromExpr')
    assert.equal(query.fromTree.fromlist?.[0]?.tag, 'JoinExpr')
    assert.equal(query.fromTree.fromlist?.[0]?.joinType, 'INNER')
    assert.equal(query.targetList[0]?.expr.tag, 'SubLink')
    assert.equal(query.targetList[0]?.expr.subLinkType, 'EXISTS')
  })
})

test('native analyzer emits canonical PostgreSQL coercion nullability facts', async () => {
  await withDatabase(async (database) => {
    await database.query('create domain public.nullable_integer_domain as integer')
    await database.query('create domain public.required_integer_domain as integer not null')
    await database.query('create domain public.checked_required_integer_domain as integer check (value is not null)')
    await database.query("create domain public.unknown_integer_domain as integer check (concat(value::text, '') <> '')")
    await database.query('create domain public.nested_required_integer_domain as public.required_integer_domain')
    await database.query(`create table public.coercion_envelope_probe (
      nullable_integer integer,
      required_integer integer not null,
      nullable_integers integer[],
      required_integers integer[] not null
    )`)
    await database.query('create table public.coercion_parent_row (parent_value integer)')
    await database.query(
      'create table public.coercion_child_row (child_value text) inherits (public.coercion_parent_row)'
    )

    const analysis = await analyze(
      database,
      `select
         required_integer::oid,
         nullable_integer::oid,
         required_integer::bigint,
         nullable_integer::bigint,
         required_integer::numeric,
         nullable_integer::numeric,
         required_integer::text,
         nullable_integer::text,
         nullable_integer::public.nullable_integer_domain,
         nullable_integer::public.required_integer_domain,
         nullable_integer::public.checked_required_integer_domain,
         nullable_integer::public.unknown_integer_domain,
         nullable_integer::public.nested_required_integer_domain,
         required_integers::bigint[],
         nullable_integers::bigint[]
       from public.coercion_envelope_probe`,
      []
    )
    const expressions = analysis.statements[0]?.queries[0]?.targetList.map((target) => target.expr) ?? []

    for (const expression of expressions.slice(0, 2)) {
      assert.equal(expression.tag, 'RelabelType')
      assert.equal(expression.coercionForm, 'EXPLICIT_CAST')
      assert.equal(expression.nullInputProducesNull, true)
      assert.equal(expression.nonNullInputProducesNonNull, true)
    }

    for (const expression of expressions.slice(2, 4)) {
      assert.equal(expression.tag, 'FuncExpr')
      assert.equal(expression.coercionForm, 'EXPLICIT_CAST')
      assert.equal(expression.nullInputProducesNull, true)
      assert.equal(expression.nonNullInputProducesNonNull, true)
    }
    for (const expression of expressions.slice(4, 6)) {
      assert.equal(expression.tag, 'FuncExpr')
      assert.equal(expression.coercionForm, 'EXPLICIT_CAST')
      assert.equal(expression.nullInputProducesNull, true)
      assert.equal(expression.nonNullInputProducesNonNull, false)
    }

    for (const expression of expressions.slice(6, 8)) {
      assert.equal(expression.tag, 'CoerceViaIO')
      assert.ok((expression.inputFunctionOid ?? 0) > 0)
      assert.ok((expression.outputFunctionOid ?? 0) > 0)
      assert.equal(expression.nullInputProducesNull, true)
      assert.equal(expression.nonNullInputProducesNonNull, true)
    }

    assert.deepEqual(
      expressions.slice(8, 13).map((expression) => ({
        domainNullAdmission: expression.domainNullAdmission,
        nonNullInputProducesNonNull: expression.nonNullInputProducesNonNull,
        nullInputProducesNull: expression.nullInputProducesNull,
        tag: expression.tag,
      })),
      [
        {
          domainNullAdmission: 'accepts',
          nonNullInputProducesNonNull: true,
          nullInputProducesNull: true,
          tag: 'CoerceToDomain',
        },
        {
          domainNullAdmission: 'rejects',
          nonNullInputProducesNonNull: true,
          nullInputProducesNull: false,
          tag: 'CoerceToDomain',
        },
        {
          domainNullAdmission: 'rejects',
          nonNullInputProducesNonNull: true,
          nullInputProducesNull: false,
          tag: 'CoerceToDomain',
        },
        {
          domainNullAdmission: 'unknown',
          nonNullInputProducesNonNull: true,
          nullInputProducesNull: false,
          tag: 'CoerceToDomain',
        },
        {
          domainNullAdmission: 'rejects',
          nonNullInputProducesNonNull: true,
          nullInputProducesNull: false,
          tag: 'CoerceToDomain',
        },
      ]
    )

    for (const expression of expressions.slice(13)) {
      assert.equal(expression.tag, 'ArrayCoerceExpr')
      assert.equal(expression.nullInputProducesNull, true)
      assert.equal(expression.nonNullInputProducesNonNull, true)
      assert.equal(expression.elementExpr?.tag, 'FuncExpr')
    }

    const rowtypeAnalysis = await analyze(
      database,
      `select coercion_child_row::public.coercion_parent_row
       from public.coercion_child_row`,
      []
    )
    const rowtypeCoercion = rowtypeAnalysis.statements[0]?.queries[0]?.targetList[0]?.expr
    assert.equal(rowtypeCoercion?.tag, 'ConvertRowtypeExpr')
    assert.equal(rowtypeCoercion?.coercionForm, 'EXPLICIT_CAST')
    assert.equal(rowtypeCoercion?.nullInputProducesNull, true)
    assert.equal(rowtypeCoercion?.nonNullInputProducesNonNull, true)
  })
})

test('native analyzer exposes PostgreSQL-authoritative immediate RTE outputs', async () => {
  await withDatabase(async (database) => {
    const relation = await analyze(
      database,
      'select account.id, account, account.ctid from public.accounts account',
      []
    )
    const relationQuery = relation.statements[0]?.queries[0]
    const relationRte = relationQuery?.rtable[0]
    assert.equal(relationRte?.kind, 'RELATION')
    assert.ok((relationRte?.relid ?? 0) > 0)
    assert.deepEqual(
      relationQuery?.targetList.map((target) => target.expr.varattno),
      [1, 0, -1]
    )

    const joined = await analyze(
      database,
      `select value
       from (values (1)) left_source(value)
       full join (values (2)) right_source(value) using (value)`,
      []
    )
    const joinRte = joined.statements[0]?.queries[0]?.rtable.find((rte) => rte.kind === 'JOIN')
    assert.deepEqual(joinRte?.erefColumnNames, ['value'])
    assert.equal(joinRte?.joinAliasVars?.length, 1)
    assert.equal(joinRte?.joinAliasVars?.[0]?.tag, 'CoalesceExpr')
    assert.deepEqual(
      joinRte?.joinAliasVars?.[0]?.args?.map((argument) => argument.varnullingrels),
      [[3], [3]]
    )

    const grouped = await analyze(
      database,
      'select source.value from (values (1)) source(value) group by source.value',
      []
    )
    const groupRte = grouped.statements[0]?.queries[0]?.rtable.find((rte) => rte.kind === 'GROUP')
    assert.deepEqual(groupRte?.erefColumnNames, ['value'])
    assert.equal(groupRte?.groupExprs?.[0]?.tag, 'Var')

    const valued = await analyze(database, 'select value from (values (1), (null::integer)) source(value)', [])
    const valuesRte = valued.statements[0]?.queries[0]?.rtable[0]?.subquery?.rtable[0]
    assert.deepEqual(valuesRte?.erefColumnNames, ['column1'])
    assert.deepEqual(
      valuesRte?.valuesLists?.map((row) => row.map((expression) => expression.tag)),
      [['Const'], ['Const']]
    )

    const lateral = await analyze(
      database,
      `select nested.value
       from (values (1)) source(value)
       cross join lateral (select source.value) nested(value)`,
      []
    )
    const lateralRte = lateral.statements[0]?.queries[0]?.rtable[1]
    assert.equal(lateralRte?.kind, 'SUBQUERY')
    assert.equal(lateralRte?.lateral, true)
    assert.equal(lateralRte?.subquery?.targetList[0]?.expr.varlevelsup, 1)

    const recursive = await analyze(
      database,
      `with recursive source(value) as (
         values (1)
         union all
         select value + 1 from source where value < 2
       )
       select value from source`,
      []
    )
    const recursiveCte = recursive.statements[0]?.queries[0]?.cteList[0]
    const selfReferenceRte = recursiveCte?.query?.rtable[1]?.subquery?.rtable[0]
    assert.equal(recursiveCte?.recursive, true)
    assert.deepEqual(
      {
        cteLevelSup: selfReferenceRte?.cteLevelSup,
        cteName: selfReferenceRte?.cteName,
        cteSelfReference: selfReferenceRte?.cteSelfReference,
        kind: selfReferenceRte?.kind,
      },
      {
        cteLevelSup: 2,
        cteName: 'source',
        cteSelfReference: true,
        kind: 'CTE',
      }
    )

    const modifying = await analyze(
      database,
      `with inserted as (
         insert into public.accounts(email) values ('native-envelope@example.com')
         returning id
       )
       select id from inserted`,
      []
    )
    const modifyingCte = modifying.statements[0]?.queries[0]?.cteList[0]
    assert.equal(modifyingCte?.query?.commandType, 'INSERT')
    assert.equal(modifyingCte?.query?.returningList[0]?.expr.tag, 'Var')
    assert.equal(modifyingCte?.query?.returningList[0]?.expr.varreturningtype, 'DEFAULT')
    assert.equal(modifying.statements[0]?.queries[0]?.rtable[0]?.cteName, 'inserted')
  })
})

test('native analyzer preserves PostgreSQL RETURNING row-image identity', async () => {
  await withDatabase(async (database) => {
    await database.query(
      'create table public.returning_identity_native (id integer primary key, value int4range not null)'
    )
    const analysis = await analyze(
      database,
      `delete from public.returning_identity_native
       returning OLD.id as old_id, NEW.id as new_id`,
      []
    )
    const outputs = analysis.statements[0]?.queries[0]?.returningList
    assert.deepEqual(
      outputs?.map((target) => target.expr.varreturningtype),
      ['OLD', 'NEW']
    )
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

test('native analyzer follows only execution-reachable SELECT CTEs', async () => {
  await withDatabase(async (database) => {
    await database.query('create table public.cte_reachability_calls (value integer)')
    await database.query('create table public.cte_reachability_dml (value integer)')
    await database.query(`create function public.record_cte_reachability()
      returns integer
      language plpgsql
      volatile
      as $$
      begin
        insert into public.cte_reachability_calls(value) values (1);
        return 1;
      end
      $$`)

    const unusedVolatileSql = `with unused as (
      select public.record_cte_reachability() as value
    )
    select 1 as value`
    const unusedVolatile = await analyze(database, unusedVolatileSql, [])
    assert.equal(unusedVolatile.statements[0]?.queries[0]?.hasVolatileFunctions, false)
    await database.query(unusedVolatileSql)
    assert.deepEqual((await database.query('select value from public.cte_reachability_calls')).rows, [])

    const referencedVolatileSql = `with reached as (
      select public.record_cte_reachability() as value
    )
    select value from reached`
    const referencedVolatile = await analyze(database, referencedVolatileSql, [])
    assert.equal(referencedVolatile.statements[0]?.queries[0]?.hasVolatileFunctions, true)
    assert.deepEqual((await database.query(referencedVolatileSql)).rows, [{ value: 1 }])

    const unusedLock = await analyze(
      database,
      `with unused as (
         select account.id from public.accounts account for update
       )
       select 1`,
      []
    )
    assert.equal(unusedLock.statements[0]?.queries[0]?.hasRowMarks, false)

    const referencedLock = await analyze(
      database,
      `with reached as (
         select account.id from public.accounts account for update
       )
       select id from reached`,
      []
    )
    assert.equal(referencedLock.statements[0]?.queries[0]?.hasRowMarks, true)

    const unusedFrameSql = `with unused as (
      select sum(value) over (rows $1 preceding) as total
      from (values (1), (2)) input(value)
    )
    select 1 as value`
    const unusedFrame = await analyze(database, unusedFrameSql, [])
    assert.deepEqual(unusedFrame.paramUsageNullAdmissions, ['unknown'])
    assert.deepEqual((await database.query(unusedFrameSql, [null])).rows, [{ value: 1 }])

    const referencedFrameSql = `with reached as (
      select sum(value) over (rows $1 preceding) as total
      from (values (1), (2)) input(value)
    )
    select total from reached`
    const referencedFrame = await analyze(database, referencedFrameSql, [])
    assert.deepEqual(referencedFrame.paramUsageNullAdmissions, ['rejects'])
    await assert.rejects(database.query(referencedFrameSql, [null]), /frame starting offset must not be null/u)

    const unusedDependencyChainSql = `with first_unused as (
      select public.record_cte_reachability() as value
    ), second_unused as (
      select value from first_unused
    )
    select 1`
    const unusedDependencyChain = await analyze(database, unusedDependencyChainSql, [])
    assert.equal(unusedDependencyChain.statements[0]?.queries[0]?.hasVolatileFunctions, false)
    await database.query(unusedDependencyChainSql)
    assert.deepEqual((await database.query('select count(*)::int as count from public.cte_reachability_calls')).rows, [
      { count: 1 },
    ])

    const modifyingCteSql = `with inserted as (
      insert into public.cte_reachability_dml(value) values (1)
      returning value
    )
    select 1`
    const modifyingCte = await analyze(database, modifyingCteSql, [])
    assert.equal(modifyingCte.statements[0]?.queries[0]?.hasModifyingCTE, true)
    await database.query(modifyingCteSql)
    assert.deepEqual((await database.query('select value from public.cte_reachability_dml')).rows, [{ value: 1 }])

    const recursiveSql = `with recursive reached(value) as (
      values (1)
      union all
      select value + 1 from reached where value < 2
    )
    select value from reached order by value`
    const recursive = await analyze(database, recursiveSql, [])
    assert.equal(recursive.statements[0]?.queries[0]?.hasVolatileFunctions, false)
    assert.equal(recursive.statements[0]?.queries[0]?.hasRowMarks, false)
    assert.deepEqual((await database.query(recursiveSql)).rows, [{ value: 1 }, { value: 2 }])
  })
})

test('native analyzer detects reachable volatile aggregate support functions', async () => {
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

    const unboundedWindowSql = `select public.moving_capable_sum(value) over () as total
      from (values (1), (2), (3)) input(value)`
    const unboundedWindow = await analyze(database, unboundedWindowSql, [])
    assert.equal(unboundedWindow.statements[0]?.queries[0]?.hasVolatileFunctions, false)
    assert.deepEqual((await database.query(unboundedWindowSql)).rows, [{ total: 6 }, { total: 6 }, { total: 6 }])
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

    await database.query(`create function public.volatile_ordinary_sum_transition(
      state integer, value integer
    ) returns integer language plpgsql volatile as $$
    begin
      insert into public.aggregate_support_calls(kind) values ('ordinary-transition');
      return coalesce(state, 0) + coalesce(value, 0);
    end
    $$`)
    await database.query(`create function public.immutable_moving_sum_transition(
      state integer, value integer
    ) returns integer language sql immutable as $$
      select coalesce(state, 0) + coalesce(value, 0)
    $$`)
    await database.query(`create function public.immutable_moving_sum_inverse(
      state integer, value integer
    ) returns integer language sql immutable as $$
      select coalesce(state, 0) - coalesce(value, 0)
    $$`)
    await database.query(`create aggregate public.subplan_fallback_sum(integer) (
      sfunc = public.volatile_ordinary_sum_transition,
      stype = integer,
      initcond = '0',
      msfunc = public.immutable_moving_sum_transition,
      minvfunc = public.immutable_moving_sum_inverse,
      mstype = integer,
      minitcond = '0'
    )`)

    const directMovingSql = `select public.subplan_fallback_sum(value) over (
        order by value rows between 1 preceding and current row
      ) as total
      from (values (1), (2), (3)) input(value)`
    const directMoving = await analyze(database, directMovingSql, [])
    assert.equal(directMoving.statements[0]?.queries[0]?.hasVolatileFunctions, false)
    assert.deepEqual((await database.query(directMovingSql)).rows, [{ total: 1 }, { total: 3 }, { total: 5 }])
    assert.deepEqual((await database.query('select kind from public.aggregate_support_calls')).rows, [])

    const subplanFallbackSql = `select public.subplan_fallback_sum((
        select input.value
      )) over (
        order by value rows between 1 preceding and current row
      ) as total
      from (values (1), (2), (3)) input(value)`
    const subplanFallback = await analyze(database, subplanFallbackSql, [])
    assert.equal(subplanFallback.statements[0]?.queries[0]?.hasVolatileFunctions, true)
    assert.deepEqual((await database.query(subplanFallbackSql)).rows, [{ total: 1 }, { total: 3 }, { total: 5 }])
    assert.ok((await database.query('select kind from public.aggregate_support_calls')).rows.length > 0)
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

test('native analyzer marks stable and dynamic utility result surfaces', async () => {
  await withDatabase(async (database) => {
    await database.query(`create procedure public.native_no_result(value integer)
      language plpgsql
      as $$ begin null; end $$`)
    await database.query(`create procedure public.native_out_result(
      input_value integer,
      out output_value integer
    )
      language plpgsql
      as $$ begin output_value := input_value * 2; end $$`)

    const noResultCall = (await analyze(database, 'call public.native_no_result(1)', [])).statements[0]?.queries[0]
    assert.equal(noResultCall?.utilityKind, 'CALL')
    assert.equal(noResultCall?.utilityReturnsTuples, false)

    const outResultCall = (await analyze(database, 'call public.native_out_result(2, null)', [])).statements[0]
      ?.queries[0]
    assert.equal(outResultCall?.utilityKind, 'CALL')
    assert.equal(outResultCall?.utilityReturnsTuples, true)

    const show = (await analyze(database, 'show timezone', [])).statements[0]?.queries[0]
    assert.equal(show?.utilityKind, 'SHOW')
    assert.equal(show?.utilityReturnsTuples, true)

    const explain = (await analyze(database, 'explain select 1', [])).statements[0]?.queries[0]
    assert.equal(explain?.utilityKind, 'EXPLAIN')
    assert.equal(explain?.utilityReturnsTuples, true)

    const fetch = (await analyze(database, 'fetch all from missing_cursor', [])).statements[0]?.queries[0]
    assert.equal(fetch?.utilityKind, 'FETCH')
    assert.equal(fetch?.utilityReturnsTuples, true)

    const execute = (await analyze(database, 'execute missing_statement', [])).statements[0]?.queries[0]
    assert.equal(execute?.utilityKind, 'EXECUTE')
    assert.equal(execute?.utilityReturnsTuples, true)
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

test('native analyzer retains Bind input dependencies after rewrite removes parameters', async () => {
  await withDatabase(async (database) => {
    await database.query('create sequence public.rewritten_bind_sequence')
    await database.query(`create domain public.rewritten_bind_domain as text
      check (nextval('public.rewritten_bind_sequence') > 0)`)
    await database.query('create table public.rewritten_bind_source (value public.rewritten_bind_domain)')
    await database.query('create table public.rewritten_bind_target (value text)')
    await database.query(`create rule rewritten_bind_replace as
      on insert to public.rewritten_bind_source
      do instead insert into public.rewritten_bind_target(value) values ('fixed')`)

    const domainOid = Number(
      (await database.query<{ oid: number }>(`select 'public.rewritten_bind_domain'::regtype::oid as oid`)).rows[0]?.oid
    )
    const sql = 'insert into public.rewritten_bind_source(value) values ($1)'
    const analysis = await analyze(database, sql, [domainOid])
    const query = analysis.statements[0]?.queries[0]

    assert.equal(analysis.statements[0]?.rewrittenQueryCount, 1)
    assert.equal(query?.hasVolatileFunctions, true)
    assert.equal(query?.targetList[0]?.expr.tag, 'Const')
    assert.equal(JSON.stringify(query).includes('"tag":"Param"'), false)

    const stableBind = await analyze(database, sql, [25])
    assert.equal(stableBind.statements[0]?.queries[0]?.hasVolatileFunctions, false)

    await database.query(`prepare rewritten_bind_statement(public.rewritten_bind_domain) as ${sql}`)
    await database.query(`execute rewritten_bind_statement('nonnull')`)
    assert.deepEqual(
      (await database.query<{ value: string }>('select last_value::text as value from public.rewritten_bind_sequence'))
        .rows,
      [{ value: '1' }]
    )

    await database.query('execute rewritten_bind_statement(null)')
    assert.deepEqual(
      (await database.query<{ value: string }>('select last_value::text as value from public.rewritten_bind_sequence'))
        .rows,
      [{ value: '2' }]
    )
    assert.deepEqual((await database.query('select value from public.rewritten_bind_target order by value')).rows, [
      { value: 'fixed' },
      { value: 'fixed' },
    ])
  })
})

test('native analyzer closes protocol result I/O over externally emitted container types only', async () => {
  await withDatabase(async (database) => {
    await database.query("create type public.result_io_mood as enum ('calm', 'busy')")
    await database.query('create domain public.result_io_mood_domain as public.result_io_mood')
    await database.query(`create type public.result_io_envelope as (
      mood public.result_io_mood_domain,
      moods public.result_io_mood[]
    )`)
    await database.query(`create type public.result_io_mood_range as range (
      subtype = public.result_io_mood
    )`)
    await database.query('create table public.result_io_values (value public.result_io_mood)')

    await database.query('alter function pg_catalog.enum_out(anyenum) volatile')
    await database.query('alter function pg_catalog.enum_send(anyenum) volatile')
    for (const [sql, expectedVolatile] of [
      ["select '{}'::public.result_io_mood[] as value", false],
      ["select '{NULL}'::public.result_io_mood[] as value", false],
      ["select '{calm}'::public.result_io_mood[] as value", true],
      ["select '(,{})'::public.result_io_envelope as value", false],
      ["select '(,{NULL})'::public.result_io_envelope as value", false],
      ["select '(calm,{NULL})'::public.result_io_envelope as value", true],
      ["select 'empty'::public.result_io_mood_range as value", false],
      ["select '(,)'::public.result_io_mood_range as value", false],
      ["select '[calm,)'::public.result_io_mood_range as value", true],
      ["select '{}'::public.result_io_mood_multirange as value", false],
      ["select '{(,)}'::public.result_io_mood_multirange as value", false],
      ["select '{[calm,)}'::public.result_io_mood_multirange as value", true],
    ] as const) {
      const analysis = await analyze(database, sql, [])
      const query = analysis.statements[0]?.queries[0]

      assert.equal(query?.targetList[0]?.expr.tag, 'Const', sql)
      assert.equal(query?.hasVolatileFunctions, expectedVolatile, sql)
      assert.equal((await database.query(sql)).rows.length, 1, sql)
    }
    await database.query('alter function pg_catalog.enum_send(anyenum) immutable')

    await database.query('alter function pg_catalog.array_out(anyarray) volatile')
    await database.query('alter function pg_catalog.array_send(anyarray) volatile')
    for (const sql of [
      "select '{}'::public.result_io_mood[] as value",
      "select '{NULL}'::public.result_io_mood[] as value",
    ]) {
      const analysis = await analyze(database, sql, [])
      assert.equal(analysis.statements[0]?.queries[0]?.hasVolatileFunctions, true, sql)
    }
    await database.query('alter function pg_catalog.array_out(anyarray) immutable')
    await database.query('alter function pg_catalog.array_send(anyarray) immutable')

    await database.query('alter function pg_catalog.int2out(smallint) volatile')
    const vectorTextOutput = await analyze(database, "select '1 2'::int2vector as value", [])
    assert.equal(vectorTextOutput.statements[0]?.queries[0]?.hasVolatileFunctions, false)
    await database.query('alter function pg_catalog.int2out(smallint) immutable')

    await database.query('alter function pg_catalog.int2send(smallint) volatile')
    const vectorBinarySend = await analyze(database, "select '1 2'::int2vector as value", [])
    assert.equal(vectorBinarySend.statements[0]?.queries[0]?.hasVolatileFunctions, true)
    await database.query('alter function pg_catalog.int2send(smallint) immutable')

    const resultSql = [
      "select 'calm'::public.result_io_mood as value",
      "select 'calm'::public.result_io_mood_domain as value",
      "select array['calm'::public.result_io_mood] as value",
      `select row(
        'calm'::public.result_io_mood_domain,
        array['busy'::public.result_io_mood]
      )::public.result_io_envelope as value`,
      "select public.result_io_mood_range('calm', 'busy', '[]') as value",
      `select public.result_io_mood_multirange(
        public.result_io_mood_range('calm', 'busy', '[]')
      ) as value`,
    ] as const

    for (const sql of resultSql) {
      const analysis = await analyze(database, sql, [])
      assert.equal(analysis.statements[0]?.queries[0]?.hasVolatileFunctions, true, sql)
      assert.equal((await database.query(sql)).rows.length, 1, sql)
    }

    for (const sql of [
      'select null::public.result_io_mood as value',
      'select array[null::public.result_io_mood] as value',
      'select row(null::public.result_io_mood) as value',
      "select row(1, 'stable') as value",
      "select array[row(1, 'stable')] as value",
      `select nested.visible
       from (
         select 1 as visible, 'calm'::public.result_io_mood as protocol_hidden
       ) nested`,
      `with nested as (
         select 1 as visible, 'calm'::public.result_io_mood as protocol_hidden
       )
       select visible from nested`,
      `select exists(
         select 'calm'::public.result_io_mood as protocol_hidden
       ) as visible`,
    ]) {
      const analysis = await analyze(database, sql, [])
      assert.equal(analysis.statements[0]?.queries[0]?.hasVolatileFunctions, false, sql)
      assert.equal((await database.query(sql)).rows.length, 1, sql)
    }

    for (const sql of [
      `insert into public.result_io_values(value)
       values ('calm') returning value`,
      `update public.result_io_values
       set value = 'busy' returning value`,
      'delete from public.result_io_values returning value',
    ]) {
      const analysis = await analyze(database, sql, [])
      const query = analysis.statements[0]?.queries[0]
      assert.equal(query?.canSetTag, true, sql)
      assert.equal(query?.hasVolatileFunctions, true, sql)
      assert.equal((await database.query(sql)).rows.length, 1, sql)
    }

    /* PostgreSQL printtup selects typsend for a binary result format. */
    await database.query('alter function pg_catalog.enum_out(anyenum) immutable')
    await database.query('alter function pg_catalog.enum_send(anyenum) volatile')
    for (const sql of resultSql) {
      const analysis = await analyze(database, sql, [])
      assert.equal(analysis.statements[0]?.queries[0]?.hasVolatileFunctions, true, sql)
      assert.equal((await database.query(sql)).rows.length, 1, sql)
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

test('native analyzer selects only execution-reachable access-method support roles', async () => {
  await withDatabase(async (database) => {
    await installSortKeyOperatorClass(database, 'precision_sort_key', {
      volatileComparator: false,
      volatileEquality: false,
    })
    await database.query(`create function public.precision_sort_key_in_range(
      value public.precision_sort_key,
      base public.precision_sort_key,
      offset_value public.precision_sort_key,
      subtract boolean,
      less boolean
    ) returns boolean language plpgsql volatile strict as $$
    begin
      insert into public.precision_sort_key_calls default values;
      return true;
    end
    $$`)
    await database.query(`alter operator family public.precision_sort_key_ops
      using btree add function 3 public.precision_sort_key_in_range(
        public.precision_sort_key,
        public.precision_sort_key,
        public.precision_sort_key,
        boolean,
        boolean
      )`)
    await database.query('create table public.precision_sort_key_values (value public.precision_sort_key)')
    await database.query(`insert into public.precision_sort_key_values(value)
      values (row(1)::public.precision_sort_key), (row(2)::public.precision_sort_key)`)

    const btreeSql = `select value
      from public.precision_sort_key_values
      where value operator(public.=) row(1)::public.precision_sort_key`
    const unreachableInRange = await analyze(database, btreeSql, [])
    assert.equal(unreachableInRange.statements[0]?.queries[0]?.hasVolatileFunctions, false)
    assert.equal((await database.query(btreeSql)).rows.length, 1)
    assert.deepEqual((await database.query('select called from public.precision_sort_key_calls')).rows, [])

    await database.query(`create or replace function public.precision_sort_key_compare(
      left_value public.precision_sort_key, right_value public.precision_sort_key
    ) returns integer language plpgsql volatile strict as $$
    begin
      insert into public.precision_sort_key_calls default values;
      return case
        when (left_value).value < (right_value).value then -1
        when (left_value).value > (right_value).value then 1
        else 0
      end;
    end
    $$`)
    const reachableComparator = await analyze(database, btreeSql, [])
    assert.equal(reachableComparator.statements[0]?.queries[0]?.hasVolatileFunctions, true)
    await database.query('truncate public.precision_sort_key_calls')
    assert.equal((await database.query(btreeSql)).rows.length, 1)
    await database.query(`select value
      from public.precision_sort_key_values
      order by value`)
    assert.deepEqual(
      (
        await database.query<{ called: boolean }>(`select exists(
          select 1 from public.precision_sort_key_calls
        ) as called`)
      ).rows,
      [{ called: true }]
    )

    await database.query('create table public.ssort_left (value integer)')
    await database.query('create table public.ssort_right (value integer)')
    await database.query('insert into public.ssort_left values (1), (2)')
    await database.query('insert into public.ssort_right values (2), (3)')
    await database.query('alter function pg_catalog.btint4sortsupport(internal) volatile')
    const sortSupportSql = `select left_value.value
      from public.ssort_left left_value
      join public.ssort_right right_value on left_value.value = right_value.value`
    const reachableSortSupport = await analyze(database, sortSupportSql, [])
    assert.equal(reachableSortSupport.statements[0]?.queries[0]?.hasVolatileFunctions, true)
    await database.query('set enable_hashjoin = off')
    await database.query('set enable_nestloop = off')
    assert.deepEqual((await database.query(sortSupportSql)).rows, [{ value: 2 }])
    await database.query('alter function pg_catalog.btint4sortsupport(internal) immutable')
    await database.query('set enable_hashjoin = on')
    await database.query('set enable_nestloop = on')

    await database.query('create type public.direction_left as (value integer)')
    await database.query('create type public.direction_right as (value integer)')
    await database.query('create table public.direction_calls (called boolean default true)')
    await database.query(`create function public.direction_equal(
      left_value public.direction_left, right_value public.direction_right
    ) returns boolean language sql immutable strict as $$
      select (left_value).value = (right_value).value
    $$`)
    await database.query(`create function public.direction_compare(
      left_value public.direction_left, right_value public.direction_right
    ) returns integer language sql immutable strict as $$
      select case
        when (left_value).value < (right_value).value then -1
        when (left_value).value > (right_value).value then 1
        else 0
      end
    $$`)
    await database.query(`create function public.direction_reverse_compare(
      left_value public.direction_right, right_value public.direction_left
    ) returns integer language plpgsql volatile strict as $$
    begin
      insert into public.direction_calls default values;
      return case
        when (left_value).value < (right_value).value then -1
        when (left_value).value > (right_value).value then 1
        else 0
      end;
    end
    $$`)
    await database.query(`create operator public.=~ (
      leftarg = public.direction_left,
      rightarg = public.direction_right,
      function = public.direction_equal
    )`)
    await database.query('create operator family public.direction_ops using btree')
    await database.query(`alter operator family public.direction_ops using btree add
      operator 3 public.=~ (public.direction_left, public.direction_right),
      function 1 public.direction_compare(public.direction_left, public.direction_right),
      function 1 public.direction_reverse_compare(public.direction_right, public.direction_left)`)
    await database.query('create table public.direction_values (value public.direction_left)')
    await database.query('insert into public.direction_values values (row(1)::public.direction_left)')
    const directionalSql = `select value
      from public.direction_values
      where value operator(public.=~) row(1)::public.direction_right`
    const directional = await analyze(database, directionalSql, [])
    assert.equal(directional.statements[0]?.queries[0]?.hasVolatileFunctions, false)
    assert.equal((await database.query(directionalSql)).rows.length, 1)
    assert.deepEqual((await database.query('select called from public.direction_calls')).rows, [])

    await database.query('create type public.extended_hash_key as (value integer)')
    await database.query('create table public.extended_hash_key_calls (called boolean default true)')
    await database.query(`create function public.extended_hash_key_equal(
      left_value public.extended_hash_key, right_value public.extended_hash_key
    ) returns boolean language sql immutable strict as $$
      select (left_value).value = (right_value).value
    $$`)
    await database.query(`create function public.extended_hash_key_hash(value public.extended_hash_key)
      returns integer language sql immutable strict as $$
        select pg_catalog.hashint4((value).value)
      $$`)
    await database.query(`create function public.extended_hash_key_hash_extended(
      value public.extended_hash_key, seed bigint
    ) returns bigint language plpgsql volatile strict as $$
    begin
      insert into public.extended_hash_key_calls default values;
      return pg_catalog.hashint4extended((value).value, seed);
    end
    $$`)
    await database.query(`create operator public.= (
      leftarg = public.extended_hash_key,
      rightarg = public.extended_hash_key,
      function = public.extended_hash_key_equal,
      hashes
    )`)
    await database.query(`create operator class public.extended_hash_key_ops
      default for type public.extended_hash_key using hash as
        operator 1 public.=,
        function 1 public.extended_hash_key_hash(public.extended_hash_key),
        function 2 public.extended_hash_key_hash_extended(public.extended_hash_key, bigint)`)
    await database.query(`create table public.extended_hash_values (
      value public.extended_hash_key
    ) partition by hash(value)`)
    await database.query(`create table public.extended_hash_values_zero
      partition of public.extended_hash_values for values with (modulus 2, remainder 0)`)
    await database.query(`create table public.extended_hash_values_one
      partition of public.extended_hash_values for values with (modulus 2, remainder 1)`)
    await database.query(`insert into public.extended_hash_values
      values (row(1)::public.extended_hash_key), (row(2)::public.extended_hash_key)`)
    await database.query('truncate public.extended_hash_key_calls')

    const extendedHashSql = `select value
      from public.extended_hash_values
      where value operator(public.=) row(1)::public.extended_hash_key`
    const reachableExtendedHash = await analyze(database, extendedHashSql, [])
    assert.equal(reachableExtendedHash.statements[0]?.queries[0]?.hasVolatileFunctions, true)
    assert.equal((await database.query(extendedHashSql)).rows.length, 1)
    await database.query(`insert into public.extended_hash_values
      values (row(3)::public.extended_hash_key)`)
    assert.deepEqual(
      (
        await database.query<{ called: boolean }>(`select exists(
          select 1 from public.extended_hash_key_calls
        ) as called`)
      ).rows,
      [{ called: true }]
    )
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

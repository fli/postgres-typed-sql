import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import test from 'node:test'

import {
  buildTypedSqlPostgresIrFromCompiledConfigs,
  type TypedSqlPostgresIr,
  type TypedSqlPostgresIrCompiledConfig,
} from '../src/analyzer-ir.js'
import { createAnalysisDatabase } from '../src/engine.js'

const schemaFile = resolve(import.meta.dirname, 'fixtures/schema.sql')

function config(
  name: string,
  sql: string,
  parameterNames: readonly string[] = [],
  parameterTypes?: readonly (string | undefined)[]
): TypedSqlPostgresIrCompiledConfig {
  return {
    name,
    parameterNames,
    ...(parameterTypes ? { parameterTypes } : {}),
    sourceFile: `queries/${name}.typed.sql`,
    sql,
  }
}

test('normalizes PostgreSQL statement, nullability, DML, and cardinality facts conservatively', async () => {
  const database = await createAnalysisDatabase({ schemaFiles: [schemaFile] })
  try {
    await database.query("create table public.rule_source (value text check (value in ('source_a', 'source_b')))")
    await database.query("create table public.rule_sink (value text not null check (value in ('sink_a', 'sink_b')))")
    await database.query('create domain public.account_score as integer check (value >= 0)')
    await database.query('create domain public.account_score_list as integer[]')
    await database.query('create domain public.required_source_text as text not null')
    await database.query('create table public.source_domain_probe (value text)')
    await database.query("create table public.outer_join_probe (value text check (value in ('allowed')))")
    await database.query('create table public.null_admission_sample (value integer)')
    await database.query(`create procedure public.accept_null(value integer)
      language plpgsql
      as $$ begin null; end $$`)
    await database.query(`
      create table public.type_fact_probe (
        score public.account_score,
        score_list public.account_score_list,
        scores public.account_score[],
        status public.account_status
      )
    `)
    await database.query(`
      create rule rule_source_write as
      on insert to public.rule_source do also
      insert into public.rule_sink(value) values (new.value)
    `)

    const result = await buildTypedSqlPostgresIrFromCompiledConfigs(database, [
      config(
        'directRefinement',
        'select account.display_name from public.accounts account where account.display_name is not null'
      ),
      config(
        'andRefinement',
        'select account.display_name from public.accounts account where account.display_name is not null and $1',
        ['include'],
        ['boolean']
      ),
      config(
        'orRefinement',
        'select account.display_name from public.accounts account where account.display_name is not null or $1',
        ['include'],
        ['boolean']
      ),
      config(
        'orIntersectionRefinement',
        `select account.display_name
         from public.accounts account
         where (account.display_name is not null and $1)
            or (account.display_name is not null and not $1)`,
        ['include'],
        ['boolean']
      ),
      config(
        'notRefinement',
        'select account.display_name from public.accounts account where not (account.display_name is not null)'
      ),
      config('scalarSublink', 'select (select account.display_name from public.accounts account limit 1) as value'),
      config('existsSublink', 'select exists(select 1 from public.accounts) as value'),
      config('arraySublink', 'select array(select account.display_name from public.accounts account) as value'),
      config('unionNullability', 'select value from (select 1 as value union all select null::integer) source'),
      config('intersectNullability', 'select value from (select null::integer as value intersect all select 1) source'),
      config('exceptNullability', 'select value from (select 1 as value except all select null::integer) source'),
      config(
        'nestedSetNullability',
        `with source as (
           (select 1 as value union all select null::integer)
           intersect all
           select null::integer
         )
         select value from source`
      ),
      config(
        'divergentJsonUnion',
        `select value
         from (
           select jsonb_build_object('a', 1) as value
           union all
           select jsonb_build_object('b', 'two')
         ) source`
      ),
      config('dynamicLimit', 'select 1 as value limit $1', ['limit']),
      config(
        'rejectingWindowFrame',
        `select sum(value) over (rows between $1 preceding and current row) as total
         from (values (1), (2)) input(value)`,
        ['offset']
      ),
      config(
        'acceptingWindowFrame',
        `select sum(value) over (rows between coalesce($1, 0) preceding and current row) as total
         from (values (1), (2)) input(value)`,
        ['offset']
      ),
      config('rejectingTableSample', 'select value from public.null_admission_sample tablesample system ($1)', [
        'percentage',
      ]),
      config(
        'acceptingTableSample',
        'select value from public.null_admission_sample tablesample system (coalesce($1, 100))',
        ['percentage']
      ),
      config('opaqueCall', 'call public.accept_null($1)', ['value']),
      config('nullLimit', 'select 1 as value limit null'),
      config('allLimit', 'select 1 as value limit all'),
      config('zeroLimit', 'select 1 as value limit 0'),
      config('noFromSelect', 'select 1 as value'),
      config('noFromHaving', 'select 1 as value having false'),
      config('noFromGroupingSets', 'select 1 as value group by grouping sets ((), ())'),
      config('zeroColumnNoFromSelect', 'select'),
      config('zeroColumnNoFromHaving', 'select having false'),
      config('zeroColumnNoFromGroupingSets', 'select group by grouping sets ((), ())'),
      config('nullableSelectParameter', 'select $1::text as value', ['value']),
      config('uniqueLookup', 'select account.id from public.accounts account where account.id = $1', ['id']),
      config(
        'multipliedUniqueLookup',
        `select account.id
         from public.accounts account
         cross join generate_series(1, 2) generated(value)
         where account.id = $1`,
        ['id']
      ),
      config(
        'multiRowInsert',
        `insert into public.accounts(email, display_name)
         values ($1, $2), ($3, $2)
         returning id`,
        ['email', 'display_name', 'second_email']
      ),
      config('mixedTargetInsert', 'insert into public.accounts(email, display_name) values ($1, $1) returning id', [
        'value',
      ]),
      config(
        'opaqueNullableTargetInsert',
        `insert into public.accounts(display_name)
         select $1::text
         union all
         select coalesce($1, 'fallback')`,
        ['display_name']
      ),
      config('checkedRoleInsert', 'insert into public.accounts(email, role) values ($1, $2) returning id', [
        'email',
        'role',
      ]),
      config('recursiveTypeFacts', 'select score, score_list, scores, status from public.type_fact_probe'),
      config('fixedLengthTypeElement', 'select point(1, 2) as value'),
      config(
        'jsonScalarTypeFacts',
        `select jsonb_build_object(
           'role', role,
           'status', status,
           'scores', array[]::public.account_score[]
         ) as value
         from public.accounts`
      ),
      config(
        'modifyingCte',
        `with inserted as (
           insert into public.accounts(email, display_name) values ($1, $2)
           returning id
         )
         select id from inserted`,
        ['email', 'display_name']
      ),
      config('rewrittenInsert', 'insert into public.rule_source(value) values ($1) returning value', ['value']),
      config(
        'domainTypedSource',
        'insert into public.source_domain_probe(value) values ($1::public.required_source_text)',
        ['value']
      ),
      config(
        'rejectingReturningUse',
        `insert into public.source_domain_probe(value)
         values ($1::text)
         returning ($1::text)::public.required_source_text`,
        ['value']
      ),
      config(
        'nullExtendedInsert',
        `insert into public.outer_join_probe(value)
         select candidate.value
         from (values (1)) guaranteed(marker)
         left join (values ($1::text)) candidate(value) on false`,
        ['value']
      ),
      config(
        'nestedRowLock',
        `select left_account.id
         from public.accounts left_account
         join public.accounts right_account on exists (
           select 1
           from public.accounts locked_account
           where locked_account.id = left_account.id
           for update
         )`
      ),
    ])

    const byName = new Map(result.queries.map((query) => [query.name, query]))
    const query = (name: string): TypedSqlPostgresIr => {
      const value = byName.get(name)
      assert.ok(value, `missing normalized query ${name}`)
      return value
    }

    assert.equal(query('directRefinement').resultColumns[0]?.nullable, false)
    assert.equal(query('andRefinement').resultColumns[0]?.nullable, false)
    assert.equal(query('orRefinement').resultColumns[0]?.nullable, true)
    assert.equal(query('orIntersectionRefinement').resultColumns[0]?.nullable, false)
    assert.equal(query('notRefinement').resultColumns[0]?.nullable, true)

    assert.equal(query('scalarSublink').resultColumns[0]?.nullable, true)
    assert.equal(query('existsSublink').resultColumns[0]?.nullable, false)
    assert.equal(query('arraySublink').resultColumns[0]?.nullable, false)
    assert.equal(query('unionNullability').resultColumns[0]?.nullable, true)
    assert.equal(query('intersectNullability').resultColumns[0]?.nullable, false)
    assert.equal(query('exceptNullability').resultColumns[0]?.nullable, false)
    assert.equal(query('nestedSetNullability').resultColumns[0]?.nullable, true)

    const divergentJsonShape = query('divergentJsonUnion').resultColumns[0]?.jsonShape
    assert.equal(divergentJsonShape?.kind, 'union')
    if (divergentJsonShape?.kind === 'union') {
      assert.deepEqual(
        divergentJsonShape.alternatives.map((alternative) =>
          alternative.kind === 'object' ? alternative.fields.map((field) => field.name) : alternative.kind
        ),
        [['a'], ['b']]
      )
    }

    assert.deepEqual(query('dynamicLimit').rowBounds, {
      max: 1,
      min: 0,
      proof: 'select_without_from+dynamic_limit_can_drop_rows',
    })
    assert.equal(query('dynamicLimit').rowCardinality, 'optional')
    assert.equal(query('dynamicLimit').params[0]?.nullAdmission, 'accepts')
    assert.equal(query('dynamicLimit').params[0]?.nullable, true)
    assert.equal(query('rejectingWindowFrame').params[0]?.nullAdmission, 'rejects')
    assert.equal(query('rejectingWindowFrame').params[0]?.nullable, false)
    assert.equal(query('acceptingWindowFrame').params[0]?.nullAdmission, 'unknown')
    assert.equal(query('rejectingTableSample').params[0]?.nullAdmission, 'rejects')
    assert.equal(query('rejectingTableSample').params[0]?.nullable, false)
    assert.equal(query('acceptingTableSample').params[0]?.nullAdmission, 'unknown')
    assert.equal(query('opaqueCall').params[0]?.nullAdmission, 'unknown')
    assert.equal(query('opaqueCall').params[0]?.nullable, false)
    assert.equal(query('nullLimit').rowCardinality, 'one')
    assert.equal(query('allLimit').rowCardinality, 'one')
    assert.equal(query('zeroLimit').rowCardinality, 'none')
    assert.equal(query('noFromSelect').rowCardinality, 'one')
    assert.equal(query('noFromHaving').rowCardinality, 'optional')
    assert.deepEqual(query('noFromGroupingSets').rowBounds, {
      max: null,
      min: 0,
      proof: 'select_without_from_with_grouping',
    })
    assert.equal(query('zeroColumnNoFromSelect').rowCardinality, 'one')
    assert.equal(query('zeroColumnNoFromHaving').rowCardinality, 'optional')
    assert.deepEqual(query('zeroColumnNoFromGroupingSets').rowBounds, {
      max: null,
      min: 0,
      proof: 'select_without_from_with_grouping',
    })
    assert.equal(query('nullableSelectParameter').params[0]?.nullAdmission, 'accepts')
    assert.equal(query('nullableSelectParameter').params[0]?.nullable, true)

    assert.equal(query('uniqueLookup').rowCardinality, 'optional')
    assert.deepEqual(query('multipliedUniqueLookup').rowBounds, {
      max: null,
      min: 0,
      proof: 'unbounded',
    })
    assert.equal(query('multipliedUniqueLookup').rowCardinality, 'many')

    assert.deepEqual(
      query('multiRowInsert').params.map(({ name, nullAdmission, nullable }) => ({
        name,
        nullAdmission,
        nullable,
      })),
      [
        { name: 'email', nullAdmission: 'rejects', nullable: false },
        { name: 'display_name', nullAdmission: 'accepts', nullable: true },
        { name: 'second_email', nullAdmission: 'rejects', nullable: false },
      ]
    )
    assert.equal(query('mixedTargetInsert').params[0]?.nullable, false)
    assert.equal(query('mixedTargetInsert').params[0]?.nullAdmission, 'rejects')
    assert.equal(query('opaqueNullableTargetInsert').params[0]?.nullable, false)
    assert.equal(query('opaqueNullableTargetInsert').params[0]?.nullAdmission, 'unknown')
    assert.equal(query('checkedRoleInsert').params[1]?.checkConstraintTypeName, 'Accounts__Role')

    const [domainType, arrayDomainType, domainArrayType, enumType] = query('recursiveTypeFacts').resultColumns
    assert.equal(domainType?.pgTypeKind, 'domain')
    assert.equal(domainType?.pgBaseType?.pgTypeKind, 'base')
    assert.equal(domainType?.pgBaseType?.pgTypeName, 'int4')
    assert.equal(domainType?.pgBaseType?.pgTypeOid, 23)
    assert.equal(arrayDomainType?.pgTypeKind, 'domain')
    assert.equal(arrayDomainType?.pgBaseType?.pgTypeKind, 'array')
    assert.equal(arrayDomainType?.pgBaseType?.pgTypeOid, 1007)
    assert.equal(arrayDomainType?.pgBaseType?.pgArrayElementType?.pgTypeName, 'int4')
    assert.equal(domainArrayType?.pgTypeKind, 'array')
    assert.equal(domainArrayType?.pgArrayElementType?.pgTypeKind, 'domain')
    assert.equal(domainArrayType?.pgArrayElementType?.pgBaseType?.pgTypeKind, 'base')
    assert.equal(domainArrayType?.pgArrayElementType?.pgBaseType?.pgTypeName, 'int4')
    assert.equal(enumType?.pgTypeKind, 'enum')
    assert.equal(query('fixedLengthTypeElement').resultColumns[0]?.pgTypeKind, 'base')
    assert.equal(query('fixedLengthTypeElement').resultColumns[0]?.pgArrayElementType, undefined)

    const jsonShape = query('jsonScalarTypeFacts').resultColumns[0]?.jsonShape
    assert.equal(jsonShape?.kind, 'object')
    if (jsonShape?.kind === 'object') {
      const jsonFields = new Map(jsonShape.fields.map((field) => [field.name, field.shape]))
      const roleShape = jsonFields.get('role')
      const scoresShape = jsonFields.get('scores')
      const statusShape = jsonFields.get('status')
      assert.equal(roleShape?.kind, 'scalar')
      if (roleShape?.kind === 'scalar') {
        assert.equal(roleShape.pgTypeKind, 'base')
        assert.equal(roleShape.checkConstraintTypeName, 'Accounts__Role')
      }
      assert.equal(scoresShape?.kind, 'scalar')
      if (scoresShape?.kind === 'scalar') {
        assert.equal(scoresShape.pgTypeKind, 'array')
        assert.equal(scoresShape.pgArrayElementType?.pgTypeKind, 'domain')
        assert.equal(scoresShape.pgArrayElementType?.pgBaseType?.pgTypeName, 'int4')
      }
      assert.equal(statusShape?.kind, 'scalar')
      if (statusShape?.kind === 'scalar') {
        assert.equal(statusShape.pgTypeKind, 'enum')
        assert.equal(statusShape.pgTypeName, 'account_status')
      }
    }
    assert.equal(query('modifyingCte').command, 'SELECT')
    assert.equal(query('modifyingCte').hasDataModifyingCte, true)
    assert.equal(query('modifyingCte').isWrite, true)
    assert.deepEqual(
      query('modifyingCte').params.map(({ name, nullable }) => ({ name, nullable })),
      [
        { name: 'email', nullable: false },
        { name: 'display_name', nullable: true },
      ]
    )

    assert.equal(query('rewrittenInsert').command, 'INSERT')
    assert.equal(query('rewrittenInsert').resultColumns[0]?.name, 'value')
    assert.equal(query('rewrittenInsert').isWrite, true)
    assert.equal(query('rewrittenInsert').params[0]?.nullable, false)
    assert.equal(query('rewrittenInsert').params[0]?.nullAdmission, 'rejects')
    assert.equal(query('rewrittenInsert').params[0]?.checkConstraintTypeName, undefined)

    assert.equal(query('domainTypedSource').params[0]?.nullAdmission, 'rejects')
    assert.equal(query('domainTypedSource').params[0]?.nullable, false)
    assert.equal(query('rejectingReturningUse').params[0]?.nullAdmission, 'rejects')
    assert.equal(query('rejectingReturningUse').params[0]?.nullable, false)
    assert.equal(query('nullExtendedInsert').params[0]?.nullAdmission, 'accepts')
    assert.equal(query('nullExtendedInsert').params[0]?.nullable, true)
    assert.equal(query('nullExtendedInsert').params[0]?.checkConstraintTypeName, undefined)
    assert.equal(query('nestedRowLock').isWrite, true)
    assert.equal((await database.query('select 1 as value')).rows.length, 1)
    assert.equal((await database.query('select 1 as value having false')).rows.length, 0)
    assert.equal((await database.query('select 1 as value group by grouping sets ((), ())')).rows.length, 2)
    assert.equal((await database.query('select')).rows.length, 1)
    assert.equal((await database.query('select having false')).rows.length, 0)
    assert.equal((await database.query('select group by grouping sets ((), ())')).rows.length, 2)
    assert.deepEqual((await database.query('select $1::text as value', [null])).rows, [{ value: null }])
    assert.deepEqual((await database.query('select 1 as value limit $1', [null])).rows, [{ value: 1 }])
    await assert.rejects(
      database.query('insert into public.source_domain_probe(value) values ($1::public.required_source_text)', [null]),
      /does not allow null/u
    )
    await assert.rejects(
      database.query(
        `insert into public.source_domain_probe(value)
         values ($1::text)
         returning ($1::text)::public.required_source_text`,
        [null]
      ),
      /does not allow null/u
    )
    await database.query(
      `insert into public.outer_join_probe(value)
       select candidate.value
       from (values (1)) guaranteed(marker)
       left join (values ($1::text)) candidate(value) on false`,
      ['outside-check-union']
    )
    const nullExtendedRows = await database.query<{ readonly value: string | null }>(
      'select value from public.outer_join_probe'
    )
    assert.deepEqual(nullExtendedRows.rows, [{ value: null }])

    await assert.rejects(
      buildTypedSqlPostgresIrFromCompiledConfigs(database, [config('multipleStatements', 'select 1; select 2')]),
      /typed SQL must contain exactly one PostgreSQL statement; received 2/u
    )
  } finally {
    await database.close()
  }
})

test('preserves correlated CHECK metadata and folds CHECK result types through set operations', async () => {
  const database = await createAnalysisDatabase({ schemaFiles: [schemaFile] })
  try {
    for (const sql of [
      `create table public.outer_correlation (
         value text check (value in ('outer_only'))
       )`,
      `create table public.inner_correlation (
         value text not null check (value in ('inner_only'))
       )`,
      "insert into public.outer_correlation(value) values (null), ('outer_only')",
      "insert into public.inner_correlation(value) values ('inner_only')",
      `create table public.check_left (
         value text check (value in ('left_only', 'shared'))
       )`,
      `create table public.check_right (
         value text check (value in ('right_only', 'shared'))
       )`,
      'create table public.check_unknown (value text)',
      "insert into public.check_left(value) values ('left_only'), ('shared')",
      "insert into public.check_right(value) values ('right_only'), ('shared')",
      "insert into public.check_unknown(value) values ('unknown')",
    ]) {
      await database.query(sql)
    }

    const result = await buildTypedSqlPostgresIrFromCompiledConfigs(database, [
      config(
        'correlatedLateral',
        `select lateral_value.value
         from public.outer_correlation outer_row
         cross join lateral (
           select outer_row.value
           from public.inner_correlation inner_row
         ) lateral_value`
      ),
      config(
        'constrainedUnion',
        `select value from public.check_left
         union
         select value from public.check_right`
      ),
      config(
        'constrainedUnknownUnion',
        `select value from public.check_left
         union all
         select value from public.check_unknown`
      ),
      config(
        'unknownConstrainedUnion',
        `select value from public.check_unknown
         union
         select value from public.check_left`
      ),
      config(
        'constrainedIntersect',
        `select value from public.check_left
         intersect all
         select value from public.check_right`
      ),
      config(
        'constrainedUnknownIntersect',
        `select value from public.check_left
         intersect
         select value from public.check_unknown`
      ),
      config(
        'unknownConstrainedIntersect',
        `select value from public.check_unknown
         intersect all
         select value from public.check_left`
      ),
      config(
        'constrainedExcept',
        `select value from public.check_left
         except all
         select value from public.check_right`
      ),
      config(
        'sameVarnoLeaves',
        `select left_value.value from public.check_left left_value
         union all
         select right_value.value from public.check_right right_value`
      ),
      config(
        'nestedSetCheck',
        `(select value from public.check_left
          union
          select value from public.check_right)
         intersect
         select value from public.check_left`
      ),
    ])
    const queries = new Map(result.queries.map((query) => [query.name, query]))
    const refinement = (name: string) => queries.get(name)?.resultColumns[0]?.checkConstraintType
    const left = { kind: 'named', name: 'CheckLeft__Value' } as const
    const right = { kind: 'named', name: 'CheckRight__Value' } as const

    assert.equal(queries.get('correlatedLateral')?.resultColumns[0]?.nullable, true)
    assert.deepEqual(refinement('correlatedLateral'), {
      kind: 'named',
      name: 'OuterCorrelation__Value',
    })
    assert.deepEqual(refinement('constrainedUnion'), { kind: 'union', members: [left, right] })
    assert.equal(refinement('constrainedUnknownUnion'), undefined)
    assert.equal(refinement('unknownConstrainedUnion'), undefined)
    assert.deepEqual(refinement('constrainedIntersect'), { kind: 'intersection', members: [left, right] })
    assert.deepEqual(refinement('constrainedUnknownIntersect'), left)
    assert.deepEqual(refinement('unknownConstrainedIntersect'), left)
    assert.deepEqual(refinement('constrainedExcept'), left)
    assert.deepEqual(refinement('sameVarnoLeaves'), { kind: 'union', members: [left, right] })
    assert.deepEqual(refinement('nestedSetCheck'), {
      kind: 'intersection',
      members: [{ kind: 'union', members: [left, right] }, left],
    })

    const correlatedRows = await database.query<{ readonly value: string | null }>(
      `select lateral_value.value
       from public.outer_correlation outer_row
       cross join lateral (
         select outer_row.value
         from public.inner_correlation inner_row
       ) lateral_value
       order by lateral_value.value nulls first`
    )
    assert.deepEqual(correlatedRows.rows, [{ value: null }, { value: 'outer_only' }])

    const unionRows = await database.query<{ readonly value: string }>(
      `select value from public.check_left
       union
       select value from public.check_right
       order by value`
    )
    assert.deepEqual(unionRows.rows, [{ value: 'left_only' }, { value: 'right_only' }, { value: 'shared' }])
  } finally {
    await database.close()
  }
})

test('resolves correlated derived provenance from the Var owner query scope', async () => {
  const database = await createAnalysisDatabase({ schemaFiles: [schemaFile] })
  try {
    for (const sql of [
      `create table public.scope_outer_left (
         value text check (value in ('outer_left'))
       )`,
      `create table public.scope_outer_right (
         value text check (value in ('outer_right'))
       )`,
      `create table public.scope_inner (
         value text not null check (value in ('inner'))
       )`,
      "insert into public.scope_outer_left(value) values ('outer_left')",
      "insert into public.scope_outer_right(value) values ('outer_right')",
      "insert into public.scope_inner(value) values ('inner')",
    ]) {
      await database.query(sql)
    }

    const outerDerivedSql = `select lateral_value.value, lateral_value.nullable_value, lateral_value.payload
      from (
        select
          value,
          null::text as nullable_value,
          jsonb_build_object('outer_left', value) as payload
        from public.scope_outer_left
        union all
        select
          value,
          'present'::text as nullable_value,
          jsonb_build_object('outer_right', value) as payload
        from public.scope_outer_right
      ) outer_row
      cross join lateral (
        select outer_row.value, outer_row.nullable_value, outer_row.payload
        from (
          select
            value,
            'inner-not-null'::text as nullable_value,
            jsonb_build_object('inner', value) as payload
          from public.scope_inner
        ) unrelated_inner
      ) lateral_value`
    const levelTwoSql = `select level_one.value
      from (
        select value from public.scope_outer_left
        union all
        select value from public.scope_outer_right
      ) outer_row
      cross join lateral (
        select level_two.value
        from (select value from public.scope_inner) unrelated_one
        cross join lateral (
          select outer_row.value
          from (select value from public.scope_inner) unrelated_two
        ) level_two
      ) level_one`

    const result = await buildTypedSqlPostgresIrFromCompiledConfigs(database, [
      config('outerDerivedScope', outerDerivedSql),
      config('levelTwoScope', levelTwoSql),
    ])
    const queries = new Map(result.queries.map((query) => [query.name, query]))
    const outerDerived = queries.get('outerDerivedScope')
    const levelTwo = queries.get('levelTwoScope')
    const left = { kind: 'named', name: 'ScopeOuterLeft__Value' } as const
    const right = { kind: 'named', name: 'ScopeOuterRight__Value' } as const

    assert.deepEqual(outerDerived?.resultColumns[0]?.checkConstraintType, {
      kind: 'union',
      members: [left, right],
    })
    assert.notDeepEqual(outerDerived?.resultColumns[0]?.checkConstraintType, {
      kind: 'named',
      name: 'ScopeInner__Value',
    })
    assert.equal(outerDerived?.resultColumns[1]?.nullable, true)

    const jsonShape = outerDerived?.resultColumns[2]?.jsonShape
    assert.equal(jsonShape?.kind, 'union')
    if (jsonShape?.kind === 'union') {
      assert.deepEqual(
        jsonShape.alternatives.map((alternative) =>
          alternative.kind === 'object' ? alternative.fields.map((field) => field.name) : alternative.kind
        ),
        [['outer_left'], ['outer_right']]
      )
    }

    assert.deepEqual(levelTwo?.resultColumns[0]?.checkConstraintType, {
      kind: 'union',
      members: [left, right],
    })

    const executed = await database.query<{
      readonly nullable_value: string | null
      readonly payload: unknown
      readonly value: string
    }>(`${outerDerivedSql} order by value`)
    assert.deepEqual(executed.rows, [
      { nullable_value: null, payload: { outer_left: 'outer_left' }, value: 'outer_left' },
      { nullable_value: 'present', payload: { outer_right: 'outer_right' }, value: 'outer_right' },
    ])
  } finally {
    await database.close()
  }
})

test('uses exact PostgreSQL proof objects for uniqueness, inheritance, checks, and expression completeness', async () => {
  const database = await createAnalysisDatabase({ schemaFiles: [schemaFile] })
  try {
    for (const sql of [
      'create table public.operator_unique (id integer primary key, payload text)',
      "insert into public.operator_unique values (1, 'first'), (2, 'second')",
      'create unique index operator_unique_id_include on public.operator_unique(id) include (payload)',
      `create table public.deferred_unique (
         id integer,
         constraint deferred_unique_id unique (id) deferrable initially deferred
       )`,
      'create table public.parent_unique (id integer primary key)',
      'create table public.child_unique () inherits (public.parent_unique)',
      'insert into public.parent_unique values (1)',
      'insert into public.child_unique values (1)',
      `create table public.parent_check (
         status text constraint parent_status check (status in ('parent')) no inherit
       )`,
      'create table public.child_check () inherits (public.parent_check)',
      "insert into public.parent_check values ('parent')",
      "insert into public.child_check values ('child')",
      `create table public.inherited_check (
         status text constraint inherited_status check (status in ('shared'))
       )`,
      'create table public.empty_rows ()',
      'insert into public.empty_rows select from generate_series(1, 2)',
      'create table public.tie_rows (sort_key integer, payload text)',
      "insert into public.tie_rows values (1, 'first'), (1, 'second'), (2, 'third')",
      `create function public.always_equal(integer, integer)
       returns boolean language sql immutable
       as $$ select true $$`,
      `create operator public.= (
         leftarg = integer,
         rightarg = integer,
         function = public.always_equal
       )`,
    ]) {
      await database.query(sql)
    }

    const result = await buildTypedSqlPostgresIrFromCompiledConfigs(database, [
      config('customEquality', 'select id from public.operator_unique where id operator(public.=) $1', ['id']),
      config('ordinaryEquality', 'select id from public.operator_unique where id = $1', ['id']),
      config('includeKey', 'select id from public.operator_unique where id = $1', ['id']),
      config('includePayload', 'select id from public.operator_unique where payload = $1', ['payload']),
      config('deferredEquality', 'select id from public.deferred_unique where id = $1', ['id']),
      config('inheritedParent', 'select id from public.parent_unique where id = $1', ['id']),
      config('onlyParent', 'select id from only public.parent_unique where id = $1', ['id']),
      config('noInheritCheck', 'select status from public.parent_check'),
      config('inheritedCheck', 'select status from public.inherited_check'),
      config('emptyRows', 'select from public.empty_rows'),
      config('withTies', 'select payload from public.tie_rows order by sort_key fetch first 1 row with ties'),
      config('withoutTies', 'select payload from public.tie_rows order by sort_key fetch first 1 row only'),
      config('truncatedNull', `select null::text::integer::text::integer::text::integer::text::integer::text as value`),
    ])
    const queries = new Map(result.queries.map((query) => [query.name, query]))
    const query = (name: string): TypedSqlPostgresIr => {
      const value = queries.get(name)
      assert.ok(value, `missing normalized query ${name}`)
      return value
    }

    assert.equal(query('customEquality').rowCardinality, 'many')
    assert.equal(query('ordinaryEquality').rowCardinality, 'optional')
    assert.equal(query('includeKey').rowCardinality, 'optional')
    assert.equal(query('includePayload').rowCardinality, 'many')
    assert.equal(query('deferredEquality').rowCardinality, 'many')
    assert.equal(query('inheritedParent').rowCardinality, 'many')
    assert.equal(query('onlyParent').rowCardinality, 'optional')
    assert.equal(query('noInheritCheck').resultColumns[0]?.checkConstraintType, undefined)
    assert.deepEqual(query('inheritedCheck').resultColumns[0]?.checkConstraintType, {
      kind: 'named',
      name: 'InheritedCheck__Status',
    })
    assert.equal(query('emptyRows').resultColumns.length, 0)
    assert.equal(query('emptyRows').rowCardinality, 'many')
    assert.equal(query('withTies').rowCardinality, 'many')
    assert.equal(query('withoutTies').rowCardinality, 'optional')
    assert.equal(query('truncatedNull').resultColumns[0]?.nullable, true)

    const customRows = await database.query('select id from public.operator_unique where id operator(public.=) $1', [1])
    assert.equal(customRows.rows.length, 2)
    const emptyRows = await database.query('select from public.empty_rows')
    assert.equal(emptyRows.rows.length, 2)
    const tiedRows = await database.query(
      'select payload from public.tie_rows order by sort_key fetch first 1 row with ties'
    )
    assert.equal(tiedRows.rows.length, 2)

    await database.query('begin')
    try {
      await database.query('insert into public.deferred_unique values (1), (1)')
      const deferredRows = await database.query('select id from public.deferred_unique where id = 1')
      assert.equal(deferredRows.rows.length, 2)
    } finally {
      await database.query('rollback')
    }
  } finally {
    await database.close()
  }
})

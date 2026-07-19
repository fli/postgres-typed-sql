import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import test from 'node:test'

import {
  buildTypedSqlPostgresIrFromCompiledConfigs,
  type TypedSqlPostgresIr,
  type TypedSqlPostgresIrCompiledConfig,
} from '../src/analyzer-ir.js'
import type { PostgresQueryable } from '../src/database.js'
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

type MutableEnvelopeObject = Record<string, unknown>

function envelopeObject(value: unknown): MutableEnvelopeObject {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value))
  return value as MutableEnvelopeObject
}

function envelopeArray(value: unknown): unknown[] {
  assert.ok(Array.isArray(value))
  return value
}

function corruptAnalyzerEnvelope(
  database: PostgresQueryable,
  mutate: (analysis: MutableEnvelopeObject) => void
): PostgresQueryable {
  return {
    async query<Row>(text: string, params?: readonly unknown[]) {
      const result = await database.query<Row>(text, params)
      if (!text.includes('postgres_typed_sql_analyze')) {
        return result
      }
      const rows = structuredClone(result.rows) as unknown[]
      const firstRow = envelopeObject(rows[0])
      const analysis = envelopeObject(firstRow.analysis)
      mutate(analysis)
      return { rows: rows as Row[] }
    },
  }
}

function firstEnvelopeQuery(analysis: MutableEnvelopeObject): MutableEnvelopeObject {
  const statement = envelopeObject(envelopeArray(analysis.statements)[0])
  return envelopeObject(envelopeArray(statement.queries)[0])
}

test('loads every referenced relation attribute consistently in large and focused batches', async () => {
  const database = await createAnalysisDatabase({ schemaFiles: [schemaFile] })
  try {
    const stressColumnCount = 1_501
    const stressColumns = Array.from(
      { length: stressColumnCount },
      (_, index) => `column_${index + 1} integer not null`
    )
    await database.query(`create table public.catalog_column_stress (${stressColumns.join(', ')})`)

    const representative = config(
      'batchStableRepresentative',
      `select
         account.id,
         account.role,
         account.display_name,
         jsonb_build_object('role', account.role) as payload
       from public.accounts account
       where account.display_name is not null`
    )
    const stress = config(
      'catalogColumnStress',
      `select ${Array.from({ length: stressColumnCount }, (_, index) => `column_${index + 1}`).join(', ')}
       from public.catalog_column_stress`
    )

    const focused = await buildTypedSqlPostgresIrFromCompiledConfigs(database, [representative])
    const columnCatalogQueries: { readonly params?: readonly unknown[]; readonly text: string }[] = []
    const observedClient: PostgresQueryable = {
      async query<Row>(text: string, params?: readonly unknown[]) {
        if (text.includes('a.attnotnull')) {
          columnCatalogQueries.push({ params, text })
        }
        return database.query<Row>(text, params)
      },
    }
    const batched = await buildTypedSqlPostgresIrFromCompiledConfigs(observedClient, [representative, stress])
    const expectedColumns = await database.query<{ readonly count: number }>(
      `select count(*)::int as count
       from pg_attribute
       where attrelid = any(array['public.accounts'::regclass, 'public.catalog_column_stress'::regclass])
         and attnum > 0
         and not attisdropped`
    )

    assert.equal(columnCatalogQueries.length, 1)
    assert.match(columnCatalogQueries[0]?.text ?? '', /where c\.oid = any\(\$1::oid\[\]\)/u)
    assert.equal(columnCatalogQueries[0]?.params?.length, 1)
    assert.equal((columnCatalogQueries[0]?.params?.[0] as readonly unknown[] | undefined)?.length, 2)
    assert.equal(batched.catalogFacts.columns, expectedColumns.rows[0]?.count)
    assert.deepEqual(batched.queries[0], focused.queries[0])
    assert.equal(batched.queries[1]?.resultColumns.length, stressColumnCount)
    assert.ok(batched.queries[1]?.resultColumns.every((column) => column.nullability.kind === 'nonNull'))

    const [id, role, displayName, payload] = focused.queries[0]?.resultColumns ?? []
    assert.equal(id?.nullability.kind, 'nonNull')
    assert.equal(id?.source.kind, 'tableColumn')
    assert.deepEqual(role?.checkConstraintType, {
      kind: 'literalUnion',
      labels: ['member', 'admin'],
    })
    assert.equal(displayName?.nullability.kind, 'nonNull')
    assert.equal(payload?.jsonShape?.kind, 'object')
  } finally {
    await database.close()
  }
})

test('preserves base alias, outer-join, whole-row, and system-attribute distinctions', async () => {
  const database = await createAnalysisDatabase({ schemaFiles: [schemaFile] })
  try {
    const result = await buildTypedSqlPostgresIrFromCompiledConfigs(database, [
      config('directAlias', 'select account.id from public.accounts account'),
      config(
        'qualifiedOuterJoin',
        `select account.id as account_id, post.id as post_id
         from public.accounts account
         left join public.posts post
           on post.account_id = account.id`
      ),
      config('wholeRowAndSystemAttribute', 'select account as account_row, account.ctid from public.accounts account'),
    ])
    const queries = new Map(result.queries.map((query) => [query.name, query]))

    assert.equal(queries.get('directAlias')?.resultColumns[0]?.nullability.kind, 'nonNull')
    assert.equal(queries.get('qualifiedOuterJoin')?.resultColumns[0]?.nullability.kind, 'nonNull')
    assert.deepEqual(queries.get('qualifiedOuterJoin')?.resultColumns[1]?.nullability, {
      evidence: 'outer_join_column',
      kind: 'nullable',
    })
    assert.deepEqual(queries.get('wholeRowAndSystemAttribute')?.resultColumns[0]?.nullability, {
      basis: 'whole_row',
      kind: 'nonNull',
    })
    assert.deepEqual(queries.get('wholeRowAndSystemAttribute')?.resultColumns[1]?.nullability, {
      kind: 'unknown',
      reason: 'system_attribute:-1',
    })
  } finally {
    await database.close()
  }
})

test('resolves immediate JOIN, GROUP, VALUES, CTE, and opaque RTE sources once for every consumer', async () => {
  const database = await createAnalysisDatabase({ schemaFiles: [schemaFile] })
  try {
    await database.query("create table public.immediate_left (value text not null check (value in ('left')))")
    await database.query("create table public.immediate_right (value text not null check (value in ('right')))")

    const result = await buildTypedSqlPostgresIrFromCompiledConfigs(database, [
      config('innerUsing', 'select value from public.immediate_left inner join public.immediate_right using (value)'),
      config('leftUsing', 'select value from public.immediate_left left join public.immediate_right using (value)'),
      config('rightUsing', 'select value from public.immediate_left right join public.immediate_right using (value)'),
      config('fullUsing', 'select value from public.immediate_left full join public.immediate_right using (value)'),
      config('groupOutput', 'select source.value from public.immediate_left source group by source.value'),
      config('oneRowValues', 'select value from (values (1)) source(value)'),
      config('multiRowValues', 'select value from (values (1), (2)) source(value)'),
      config('mixedValues', 'select value from (values (1), (null::integer)) source(value)'),
      config('ordinaryCte', 'with source as (select value from public.immediate_left) select value from source'),
      config(
        'modifyingCte',
        `with inserted as (
           insert into public.accounts(email) values ('immediate-source@example.com')
           returning id
         )
         select id from inserted`
      ),
      config(
        'recursiveCte',
        `with recursive source(value) as (
           values (1)
           union all
           select value from source where false
         )
         select value from source`
      ),
      config('functionOutput', 'select value from generate_series(1, 2) source(value)'),
      config(
        'jsonJoinOutput',
        `select payload
         from (values (jsonb_build_object('joined', 'value'))) left_source(payload)
         inner join (values (jsonb_build_object('joined', 'value'))) right_source(payload)
           using (payload)`
      ),
      config(
        'jsonGroupOutput',
        `select source.payload
         from (values (jsonb_build_object('grouped', 'value'))) source(payload)
         group by source.payload`
      ),
      config(
        'jsonValuesOutput',
        `select payload
         from (
           values
             (jsonb_build_object('left', 'value')),
             (jsonb_build_object('right', 'value'))
         ) source(payload)`
      ),
    ])
    const queries = new Map(result.queries.map((query) => [query.name, query]))
    const column = (name: string) => {
      const value = queries.get(name)?.resultColumns[0]
      assert.ok(value, `missing result column for ${name}`)
      return value
    }

    const leftCheck = { kind: 'literalUnion', labels: ['left'] } as const
    const rightCheck = { kind: 'literalUnion', labels: ['right'] } as const
    for (const name of ['innerUsing', 'leftUsing'] as const) {
      assert.equal(column(name).nullability.kind, 'nonNull')
      assert.deepEqual(column(name).checkConstraintType, leftCheck)
    }
    assert.equal(column('rightUsing').nullability.kind, 'nonNull')
    assert.deepEqual(column('rightUsing').checkConstraintType, rightCheck)
    assert.deepEqual(column('fullUsing').nullability, {
      evidence: 'coalesce_all_arms_nullable',
      kind: 'nullable',
    })
    assert.equal(column('fullUsing').checkConstraintType, undefined)

    assert.equal(column('groupOutput').nullability.kind, 'nonNull')
    assert.deepEqual(column('groupOutput').checkConstraintType, leftCheck)
    assert.equal(column('oneRowValues').nullability.kind, 'nonNull')
    assert.equal(column('multiRowValues').nullability.kind, 'nonNull')
    assert.deepEqual(column('mixedValues').nullability, {
      evidence: 'rte_expression_union:null_constant',
      kind: 'nullable',
    })

    assert.equal(column('ordinaryCte').nullability.kind, 'nonNull')
    assert.deepEqual(column('ordinaryCte').checkConstraintType, leftCheck)
    assert.equal(column('modifyingCte').nullability.kind, 'nonNull')
    assert.deepEqual(column('recursiveCte').nullability, {
      basis: 'query_union',
      kind: 'nonNull',
    })
    assert.deepEqual(column('functionOutput').nullability, {
      kind: 'unknown',
      reason: 'opaque_rte:function',
    })

    const fieldNames = (name: string): readonly (readonly string[])[] => {
      const shape = column(name).jsonShape
      assert.ok(shape)
      const alternatives = shape.kind === 'union' ? shape.alternatives : [shape]
      return alternatives.map((alternative) => {
        assert.equal(alternative.kind, 'object')
        return alternative.kind === 'object' ? alternative.fields.map((field) => field.name) : []
      })
    }
    assert.deepEqual(fieldNames('jsonJoinOutput'), [['joined']])
    assert.deepEqual(fieldNames('jsonGroupOutput'), [['grouped']])
    assert.deepEqual(fieldNames('jsonValuesOutput'), [['left'], ['right']])
  } finally {
    await database.close()
  }
})

test('throws when a positive base Var is missing its required catalog column fact', async () => {
  const database = await createAnalysisDatabase({ schemaFiles: [schemaFile] })
  try {
    const missingPostIdClient: PostgresQueryable = {
      async query<Row>(text: string, params?: readonly unknown[]) {
        const result = await database.query<Row>(text, params)
        if (!text.includes('a.attnotnull') || !text.includes('from pg_class c')) {
          return result
        }
        return {
          rows: result.rows.filter((row) => {
            const column = row as { readonly attname?: string; readonly relname?: string }
            return column.relname !== 'posts' || column.attname !== 'id'
          }),
        }
      },
    }

    await assert.rejects(
      buildTypedSqlPostgresIrFromCompiledConfigs(missingPostIdClient, [
        config(
          'missingOuterJoinedColumnFact',
          `select post.id
           from public.accounts account
           left join public.posts post
             on post.account_id = account.id`
        ),
      ]),
      /queries\/missingOuterJoinedColumnFact\.typed\.sql: failed to build typed SQL IR missingOuterJoinedColumnFact: internal analyzer catalog inconsistency: missing positive base-column fact for relation OID \d+, attribute number 1 in SELECT query/u
    )
  } finally {
    await database.close()
  }
})

test('throws on malformed owner identity, output indices, aligned expressions, and schema versions', async () => {
  const database = await createAnalysisDatabase({ schemaFiles: [schemaFile] })
  try {
    const cases: readonly {
      readonly corrupt: (analysis: MutableEnvelopeObject) => void
      readonly error: RegExp
      readonly name: string
      readonly sql: string
    }[] = [
      {
        corrupt(analysis) {
          analysis.schemaVersion = 6
        },
        error: /analyzer returned unsupported schema version 6; expected 7/u,
        name: 'staleSchema',
        sql: 'select account.id from public.accounts account',
      },
      {
        corrupt(analysis) {
          const query = firstEnvelopeQuery(analysis)
          const relation = envelopeObject(envelopeArray(query.rtable)[0])
          relation.relid = null
        },
        error: /RELATION RTE 1 is missing its authoritative relation OID/u,
        name: 'missingRelationIdentity',
        sql: 'select account.id from public.accounts account',
      },
      {
        corrupt(analysis) {
          const query = firstEnvelopeQuery(analysis)
          const target = envelopeObject(envelopeArray(query.targetList)[0])
          envelopeObject(target.expr).varattno = 2
        },
        error: /SUBQUERY RTE 1 has no positive output attribute 2; expected 1\.\.1/u,
        name: 'invalidOutputIndex',
        sql: 'select value from (values (1)) source(value)',
      },
      {
        corrupt(analysis) {
          const query = firstEnvelopeQuery(analysis)
          const join = envelopeArray(query.rtable)
            .map(envelopeObject)
            .find((rte) => rte.kind === 'JOIN')
          assert.ok(join)
          delete join.joinAliasVars
        },
        error: /JOIN RTE 3 has misaligned alias output expressions/u,
        name: 'missingJoinAliasExpression',
        sql: 'select value from (values (1)) left_source(value) full join (values (1)) right_source(value) using (value)',
      },
      {
        corrupt(analysis) {
          const query = firstEnvelopeQuery(analysis)
          const group = envelopeArray(query.rtable)
            .map(envelopeObject)
            .find((rte) => rte.kind === 'GROUP')
          assert.ok(group)
          delete group.groupExprs
        },
        error: /GROUP RTE 2 has misaligned output expressions/u,
        name: 'missingGroupExpression',
        sql: 'select source.value from (values (1)) source(value) group by source.value',
      },
      {
        corrupt(analysis) {
          const query = firstEnvelopeQuery(analysis)
          const outerRte = envelopeObject(envelopeArray(query.rtable)[0])
          const nestedQuery = envelopeObject(outerRte.subquery)
          const valuesRte = envelopeObject(envelopeArray(nestedQuery.rtable)[0])
          valuesRte.valuesLists = [[envelopeObject(envelopeArray(envelopeArray(valuesRte.valuesLists)[0])[0])], []]
        },
        error: /VALUES RTE 1 has misaligned row expressions/u,
        name: 'misalignedValuesRows',
        sql: 'select value from (values (1), (2)) source(value)',
      },
    ]

    for (const fixture of cases) {
      await assert.rejects(
        buildTypedSqlPostgresIrFromCompiledConfigs(corruptAnalyzerEnvelope(database, fixture.corrupt), [
          config(fixture.name, fixture.sql),
        ]),
        fixture.error
      )
    }
  } finally {
    await database.close()
  }
})

test('infers structured JSON from scalar subqueries and derived whole rows', async () => {
  const database = await createAnalysisDatabase({ schemaFiles: [schemaFile] })
  try {
    const result = await buildTypedSqlPostgresIrFromCompiledConfigs(database, [
      config(
        'jsonArrayFrom',
        `select coalesce(
          (
            select jsonb_agg(nested_row)
            from (
              select account.id as account_id, account.display_name
              from public.accounts account
            ) nested_row
          ),
          '[]'::jsonb
        ) as accounts`
      ),
      config(
        'jsonObjectFrom',
        `select (
          select to_jsonb(nested_row)
          from (
            select account.id as account_id, account.display_name
            from public.accounts account
            limit 1
          ) nested_row
        ) as account`
      ),
      config(
        'directJsonObject',
        `select to_jsonb(nested_row) as account
        from (
          select account.id as account_id, account.display_name
          from public.accounts account
        ) nested_row`
      ),
    ])

    const arrayShape = result.queries.find((query) => query.name === 'jsonArrayFrom')?.resultColumns[0]?.jsonShape
    assert.equal(arrayShape?.kind, 'array')
    if (arrayShape?.kind === 'array') {
      assert.equal(arrayShape.nullability.kind, 'nonNull')
      assert.equal(arrayShape.element.kind, 'object')
      if (arrayShape.element.kind === 'object') {
        assert.deepEqual(
          arrayShape.element.fields.map((field) => field.name),
          ['account_id', 'display_name']
        )
      }
    }

    const objectShape = result.queries.find((query) => query.name === 'jsonObjectFrom')?.resultColumns[0]?.jsonShape
    assert.equal(objectShape?.kind, 'object')
    if (objectShape?.kind === 'object') {
      assert.deepEqual(
        objectShape.fields.map((field) => field.name),
        ['account_id', 'display_name']
      )
    }
    const directObjectShape = result.queries.find((query) => query.name === 'directJsonObject')?.resultColumns[0]
      ?.jsonShape
    assert.equal(directObjectShape?.kind, 'object')
    assert.equal(directObjectShape?.nullability.kind, 'nonNull')
  } finally {
    await database.close()
  }
})

test('models exposed whole-row names, set operations, and each JSON sublink result kind', async () => {
  const database = await createAnalysisDatabase({ schemaFiles: [schemaFile] })
  try {
    const result = await buildTypedSqlPostgresIrFromCompiledConfigs(database, [
      config('aliasedDerivedRow', 'select to_jsonb(r) as payload from (select 1 as account_id) r(user_id)'),
      config('aliasedCteRow', 'with r(user_id) as (select 1 as account_id) select to_jsonb(r) as payload from r'),
      config(
        'setOperationWholeRow',
        `select to_jsonb(u) as payload
        from (
          select jsonb_build_object('left_key', 1) as details
          union all
          select jsonb_build_object('right_key', 2) as details
        ) u`
      ),
      config(
        'arraySublink',
        `select to_jsonb(array(
          select jsonb_build_object('item_id', account.id)
          from public.accounts account
        )) as payload`
      ),
      config('existsSublink', 'select to_jsonb(exists(select 1)) as payload'),
      config('anySublink', 'select to_jsonb(1 = any(select account.id from public.accounts account)) as payload'),
      config('allSublink', 'select to_jsonb(1 = all(select account.id from public.accounts account)) as payload'),
      config('rowCompareSublink', 'select to_jsonb((1, 2) = (select 1, 2)) as payload'),
    ])
    const shape = (name: string) => result.queries.find((query) => query.name === name)?.resultColumns[0]?.jsonShape

    for (const name of ['aliasedDerivedRow', 'aliasedCteRow']) {
      const rowShape = shape(name)
      assert.equal(rowShape?.kind, 'object')
      if (rowShape?.kind === 'object') {
        assert.deepEqual(
          rowShape.fields.map((field) => field.name),
          ['user_id']
        )
      }
    }

    const setShape = shape('setOperationWholeRow')
    assert.equal(setShape?.kind, 'object')
    if (setShape?.kind === 'object') {
      const details = setShape.fields.find((field) => field.name === 'details')?.shape
      assert.equal(details?.kind, 'union')
      if (details?.kind === 'union') {
        assert.deepEqual(
          details.alternatives.map((alternative) =>
            alternative.kind === 'object' ? alternative.fields.map((field) => field.name) : alternative.kind
          ),
          [['left_key'], ['right_key']]
        )
      }
    }

    const arrayShape = shape('arraySublink')
    assert.equal(arrayShape?.kind, 'array')
    assert.equal(arrayShape?.nullability.kind, 'nonNull')
    if (arrayShape?.kind === 'array') {
      assert.equal(arrayShape.element.kind, 'object')
      if (arrayShape.element.kind === 'object') {
        assert.deepEqual(
          arrayShape.element.fields.map((field) => field.name),
          ['item_id']
        )
      }
    }

    for (const name of ['existsSublink', 'anySublink', 'allSublink', 'rowCompareSublink']) {
      const predicateShape = shape(name)
      assert.equal(predicateShape?.kind, 'scalar')
      if (predicateShape?.kind === 'scalar') {
        assert.equal(predicateShape.pgTypeName, 'bool')
      }
    }
  } finally {
    await database.close()
  }
})

test('rejects unmodeled PostgreSQL utilities while write-routing an opaque no-result CALL', async () => {
  const database = await createAnalysisDatabase({ schemaFiles: [schemaFile] })
  try {
    await database.query(`create procedure public.ir_no_result(value integer)
      language plpgsql
      as $$ begin null; end $$`)
    await database.query(`create procedure public.ir_out_result(
      input_value integer,
      out output_value integer
    )
      language plpgsql
      as $$ begin output_value := input_value * 2; end $$`)

    const result = await buildTypedSqlPostgresIrFromCompiledConfigs(database, [
      config('noResultCall', 'call public.ir_no_result($1)', ['value'], ['integer']),
    ])
    const call = result.queries[0]
    assert.equal(call?.command, 'UTILITY')
    assert.deepEqual(call?.accessEvidence, {
      kind: 'notProvenReadOnly',
      reasons: [{ kind: 'procedureCall' }],
    })
    assert.deepEqual(call?.resultColumns, [])
    assert.deepEqual(call?.rowBounds, { max: 0, min: 0, proof: 'no_result_columns' })
    await database.query('call public.ir_no_result($1)', [1])

    for (const [name, sql, error] of [
      ['show', 'show timezone', /PostgreSQL SHOW utility statements are not supported/u],
      ['explain', 'explain select 1', /PostgreSQL EXPLAIN utility statements are not supported/u],
      ['ddl', 'create table public.unsupported_utility (id integer)', /PostgreSQL OTHER utility statements/u],
      ['outCall', 'call public.ir_out_result(2, null)', /CALL statements with result rows are not supported/u],
      ['fetch', 'fetch all from missing_cursor', /PostgreSQL FETCH utility statements are not supported/u],
      ['execute', 'execute missing_statement', /PostgreSQL EXECUTE utility statements are not supported/u],
    ] as const) {
      await assert.rejects(buildTypedSqlPostgresIrFromCompiledConfigs(database, [config(name, sql)]), error)
    }
  } finally {
    await database.close()
  }
})

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

    assert.equal(query('directRefinement').resultColumns[0]?.nullability.kind, 'nonNull')
    assert.equal(query('andRefinement').resultColumns[0]?.nullability.kind, 'nonNull')
    assert.equal(query('orRefinement').resultColumns[0]?.nullability.kind, 'nullable')
    assert.equal(query('orIntersectionRefinement').resultColumns[0]?.nullability.kind, 'nonNull')
    assert.equal(query('notRefinement').resultColumns[0]?.nullability.kind, 'nullable')

    assert.equal(query('scalarSublink').resultColumns[0]?.nullability.kind, 'nullable')
    assert.equal(query('existsSublink').resultColumns[0]?.nullability.kind, 'nonNull')
    assert.equal(query('arraySublink').resultColumns[0]?.nullability.kind, 'nonNull')
    assert.equal(query('unionNullability').resultColumns[0]?.nullability.kind, 'nullable')
    assert.equal(query('intersectNullability').resultColumns[0]?.nullability.kind, 'nonNull')
    assert.equal(query('exceptNullability').resultColumns[0]?.nullability.kind, 'nonNull')
    assert.equal(query('nestedSetNullability').resultColumns[0]?.nullability.kind, 'nullable')

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
    assert.equal(query('dynamicLimit').params[0]?.nullAdmission, 'accepts')
    assert.equal(query('rejectingWindowFrame').params[0]?.nullAdmission, 'rejects')
    assert.equal(query('acceptingWindowFrame').params[0]?.nullAdmission, 'unknown')
    assert.equal(query('rejectingTableSample').params[0]?.nullAdmission, 'rejects')
    assert.equal(query('acceptingTableSample').params[0]?.nullAdmission, 'unknown')
    assert.equal(query('opaqueCall').params[0]?.nullAdmission, 'unknown')
    assert.deepEqual(query('nullLimit').rowBounds, { max: 1, min: 1, proof: 'select_without_from' })
    assert.deepEqual(query('allLimit').rowBounds, { max: 1, min: 1, proof: 'select_without_from' })
    assert.deepEqual(query('zeroLimit').rowBounds, {
      max: 0,
      min: 0,
      proof: 'select_without_from+constant_limit_0',
    })
    assert.deepEqual(query('noFromSelect').rowBounds, { max: 1, min: 1, proof: 'select_without_from' })
    assert.deepEqual(query('noFromHaving').rowBounds, {
      max: 1,
      min: 0,
      proof: 'select_without_from_with_qual',
    })
    assert.deepEqual(query('noFromGroupingSets').rowBounds, {
      max: null,
      min: 0,
      proof: 'select_without_from_with_grouping',
    })
    assert.deepEqual(query('zeroColumnNoFromSelect').rowBounds, {
      max: 1,
      min: 1,
      proof: 'select_without_from',
    })
    assert.deepEqual(query('zeroColumnNoFromHaving').rowBounds, {
      max: 1,
      min: 0,
      proof: 'select_without_from_with_qual',
    })
    assert.deepEqual(query('zeroColumnNoFromGroupingSets').rowBounds, {
      max: null,
      min: 0,
      proof: 'select_without_from_with_grouping',
    })
    assert.equal(query('nullableSelectParameter').params[0]?.nullAdmission, 'accepts')

    assert.deepEqual(query('uniqueLookup').rowBounds, {
      max: 1,
      min: 0,
      proof: 'primary_key_equality:accounts_pkey',
    })
    assert.deepEqual(query('multipliedUniqueLookup').rowBounds, {
      max: null,
      min: 0,
      proof: 'unbounded',
    })

    assert.deepEqual(
      query('multiRowInsert').params.map(({ name, nullAdmission }) => ({
        name,
        nullAdmission,
      })),
      [
        { name: 'email', nullAdmission: 'rejects' },
        { name: 'display_name', nullAdmission: 'accepts' },
        { name: 'second_email', nullAdmission: 'rejects' },
      ]
    )
    assert.equal(query('mixedTargetInsert').params[0]?.nullAdmission, 'rejects')
    assert.equal(query('opaqueNullableTargetInsert').params[0]?.nullAdmission, 'unknown')
    assert.deepEqual(query('checkedRoleInsert').params[1]?.checkConstraintType, {
      kind: 'literalUnion',
      labels: ['member', 'admin'],
    })

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
        assert.deepEqual(roleShape.checkConstraintType, {
          kind: 'literalUnion',
          labels: ['member', 'admin'],
        })
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
    assert.deepEqual(query('modifyingCte').accessEvidence, {
      kind: 'notProvenReadOnly',
      reasons: [{ kind: 'dataModifyingCte' }, { kind: 'volatileExecution' }],
    })
    assert.deepEqual(
      query('modifyingCte').params.map(({ name, nullAdmission }) => ({ name, nullAdmission })),
      [
        { name: 'email', nullAdmission: 'rejects' },
        { name: 'display_name', nullAdmission: 'accepts' },
      ]
    )

    assert.equal(query('rewrittenInsert').command, 'INSERT')
    assert.equal(query('rewrittenInsert').resultColumns[0]?.name, 'value')
    assert.deepEqual(query('rewrittenInsert').accessEvidence, {
      kind: 'notProvenReadOnly',
      reasons: [{ command: 'INSERT', kind: 'definiteDml' }],
    })
    assert.equal(query('rewrittenInsert').params[0]?.nullAdmission, 'rejects')
    assert.equal(query('rewrittenInsert').params[0]?.checkConstraintType, undefined)

    assert.equal(query('domainTypedSource').params[0]?.nullAdmission, 'rejects')
    assert.equal(query('rejectingReturningUse').params[0]?.nullAdmission, 'rejects')
    assert.equal(query('nullExtendedInsert').params[0]?.nullAdmission, 'accepts')
    assert.equal(query('nullExtendedInsert').params[0]?.checkConstraintType, undefined)
    assert.deepEqual(query('nestedRowLock').accessEvidence, {
      kind: 'notProvenReadOnly',
      reasons: [{ kind: 'rowLock' }],
    })
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
    const left = { kind: 'literalUnion', labels: ['left_only', 'shared'] } as const
    const right = { kind: 'literalUnion', labels: ['right_only', 'shared'] } as const

    assert.equal(queries.get('correlatedLateral')?.resultColumns[0]?.nullability.kind, 'nullable')
    assert.deepEqual(refinement('correlatedLateral'), {
      kind: 'literalUnion',
      labels: ['outer_only'],
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
    const left = { kind: 'literalUnion', labels: ['outer_left'] } as const
    const right = { kind: 'literalUnion', labels: ['outer_right'] } as const

    assert.deepEqual(outerDerived?.resultColumns[0]?.checkConstraintType, {
      kind: 'union',
      members: [left, right],
    })
    assert.notDeepEqual(outerDerived?.resultColumns[0]?.checkConstraintType, {
      kind: 'literalUnion',
      labels: ['inner'],
    })
    assert.equal(outerDerived?.resultColumns[1]?.nullability.kind, 'nullable')

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

    assert.equal(query('customEquality').rowBounds.max, null)
    assert.deepEqual(query('ordinaryEquality').rowBounds, {
      max: 1,
      min: 0,
      proof: 'primary_key_equality:operator_unique_pkey',
    })
    assert.equal(query('includeKey').rowBounds.max, 1)
    assert.equal(query('includePayload').rowBounds.max, null)
    assert.equal(query('deferredEquality').rowBounds.max, null)
    assert.equal(query('inheritedParent').rowBounds.max, null)
    assert.equal(query('onlyParent').rowBounds.max, 1)
    assert.equal(query('noInheritCheck').resultColumns[0]?.checkConstraintType, undefined)
    assert.deepEqual(query('inheritedCheck').resultColumns[0]?.checkConstraintType, {
      kind: 'literalUnion',
      labels: ['shared'],
    })
    assert.equal(query('emptyRows').resultColumns.length, 0)
    assert.equal(query('emptyRows').rowBounds.max, null)
    assert.equal(query('withTies').rowBounds.max, null)
    assert.equal(query('withoutTies').rowBounds.max, 1)
    assert.equal(query('truncatedNull').resultColumns[0]?.nullability.kind, 'unknown')

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

import assert from 'node:assert/strict'
import test from 'node:test'

import { loadCheckConstraintLiteralUnionFacts } from '../src/check-constraint-type-facts.js'
import type { PostgresQueryable, PostgresQueryResult } from '../src/database.js'
import { PGlite } from '../src/vendor/pglite/index.js'

interface TestCatalogRow {
  readonly attname: string
  readonly attnum: number
  readonly collation_is_deterministic: boolean
  readonly constraint_name: string
  readonly expression: string
  readonly operators_are_builtin: boolean
  readonly relid: number
  readonly relname: string
  readonly schema: string
}

function catalogClient(rows: readonly TestCatalogRow[]): PostgresQueryable & { readonly sql: string[] } {
  const sql: string[] = []
  return {
    async query<Row>(text: string): Promise<PostgresQueryResult<Row>> {
      sql.push(text)
      return { rows: [...rows] as Row[] }
    },
    sql,
  }
}

test('refines collatable CHECK literals only when the effective attribute collation is deterministic', async () => {
  const client = catalogClient([
    {
      attname: 'deterministic_value',
      attnum: 1,
      collation_is_deterministic: true,
      constraint_name: 'deterministic_value_check',
      expression: "deterministic_value = ANY (ARRAY['one'::text, 'two'::text])",
      operators_are_builtin: true,
      relid: 41,
      relname: 'collation_probe',
      schema: 'public',
    },
    {
      attname: 'nondeterministic_value',
      attnum: 2,
      collation_is_deterministic: false,
      constraint_name: 'nondeterministic_value_check',
      expression: "nondeterministic_value = ANY (ARRAY['one'::text, 'two'::text])",
      operators_are_builtin: true,
      relid: 41,
      relname: 'collation_probe',
      schema: 'public',
    },
    {
      attname: 'number_value',
      attnum: 3,
      collation_is_deterministic: true,
      constraint_name: 'number_value_check',
      expression: "number_value = ANY (ARRAY['1'::integer, '2'::integer])",
      operators_are_builtin: true,
      relid: 41,
      relname: 'collation_probe',
      schema: 'public',
    },
    {
      attname: 'explicit_collation',
      attnum: 4,
      collation_is_deterministic: true,
      constraint_name: 'explicit_collation_check',
      expression: '(explicit_collation COLLATE "C") = \'one\'::text',
      operators_are_builtin: true,
      relid: 41,
      relname: 'collation_probe',
      schema: 'public',
    },
  ])

  const facts = await loadCheckConstraintLiteralUnionFacts(client)

  assert.deepEqual(
    facts.map(({ attname, labels }) => ({ attname, labels })),
    [
      { attname: 'deterministic_value', labels: ['one', 'two'] },
      { attname: 'number_value', labels: ['1', '2'] },
    ]
  )
  assert.match(client.sql[0] ?? '', /attribute\.attcollation = 0 or collation_definition\.collisdeterministic/u)
  assert.match(client.sql[0] ?? '', /left join pg_collation collation_definition/u)
  assert.match(client.sql[0] ?? '', /operator_dependency\.classid = 'pg_constraint'::regclass/u)
  assert.match(client.sql[0] ?? '', /operator_dependency\.refclassid = 'pg_operator'::regclass/u)
})

test('ignores deparsed literal equality through a custom operator while preserving built-in inference', async () => {
  const database = new PGlite()
  try {
    await database.waitReady
    await database.exec(`
      create function public.always_equal(left_value text, right_value text)
      returns boolean
      language sql
      immutable
      strict
      as 'select true';
      create operator public.= (
        function = public.always_equal,
        leftarg = text,
        rightarg = text
      );
      set search_path = public, pg_catalog;
      create table public.custom_operator_probe (
        value text check (value = 'allowed')
      );
      insert into public.custom_operator_probe values ('forbidden');
    `)

    const customExpression = await database.query<{
      readonly expression: string
      readonly operator_dependency_count: number
    }>(`
      select
        pg_get_expr(con.conbin, con.conrelid) as expression,
        count(operator_dependency.*)::int as operator_dependency_count
      from pg_constraint con
      left join pg_depend operator_dependency
        on operator_dependency.classid = 'pg_constraint'::regclass
        and operator_dependency.objid = con.oid
        and operator_dependency.objsubid = 0
        and operator_dependency.refclassid = 'pg_operator'::regclass
      where con.conrelid = 'public.custom_operator_probe'::regclass
        and con.contype = 'c'
      group by con.oid
    `)
    assert.deepEqual(customExpression.rows, [{ expression: "(value = 'allowed'::text)", operator_dependency_count: 1 }])
    assert.deepEqual(
      (await database.query<{ readonly value: string }>('select value from public.custom_operator_probe')).rows,
      [{ value: 'forbidden' }]
    )
    assert.deepEqual(await loadCheckConstraintLiteralUnionFacts(database), [])

    await database.exec(`
      set search_path = pg_catalog, public;
      create table public.builtin_operator_probe (
        direct_value text check (direct_value = 'direct'),
        any_value text check (any_value in ('one', 'two')),
        or_value text check (or_value = 'left' or or_value = 'right')
      );
    `)
    const facts = await loadCheckConstraintLiteralUnionFacts(database)
    assert.deepEqual(
      facts.map(({ attname, labels }) => ({ attname, labels })),
      [
        { attname: 'direct_value', labels: ['direct'] },
        { attname: 'any_value', labels: ['one', 'two'] },
        { attname: 'or_value', labels: ['left', 'right'] },
      ]
    )
  } finally {
    await database.close()
  }
})

test('does not narrow CHECK literals under a nondeterministic ICU collation', async () => {
  const database = new PGlite()
  try {
    await database.waitReady
    await database.exec(`
      create collation public.case_insensitive (
        provider = icu,
        locale = 'und',
        deterministic = false
      );
      create table public.collation_probe (
        deterministic_value text check (deterministic_value in ('one', 'two')),
        nondeterministic_value text collate public.case_insensitive
          check (nondeterministic_value in ('é', 'two'))
      );
      insert into public.collation_probe values ('one', U&'e\\0301');
    `)

    const facts = await loadCheckConstraintLiteralUnionFacts(database)

    assert.deepEqual(
      facts.map(({ attname, labels }) => ({ attname, labels })),
      [{ attname: 'deterministic_value', labels: ['one', 'two'] }]
    )
    const result = await database.query<{ readonly nondeterministic_value: string }>(
      'select nondeterministic_value from public.collation_probe'
    )
    assert.deepEqual(result.rows, [{ nondeterministic_value: 'é' }])
  } finally {
    await database.close()
  }
})

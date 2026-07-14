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
      config('dynamicLimit', 'select 1 as value limit $1', ['limit']),
      config('nullLimit', 'select 1 as value limit null'),
      config('allLimit', 'select 1 as value limit all'),
      config('zeroLimit', 'select 1 as value limit 0'),
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
      config('checkedRoleInsert', 'insert into public.accounts(email, role) values ($1, $2) returning id', [
        'email',
        'role',
      ]),
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

    assert.deepEqual(query('dynamicLimit').rowBounds, {
      max: 1,
      min: 0,
      proof: 'select_without_from+dynamic_limit_can_drop_rows',
    })
    assert.equal(query('dynamicLimit').rowCardinality, 'optional')
    assert.equal(query('nullLimit').rowCardinality, 'one')
    assert.equal(query('allLimit').rowCardinality, 'one')
    assert.equal(query('zeroLimit').rowCardinality, 'none')

    assert.equal(query('uniqueLookup').rowCardinality, 'optional')
    assert.deepEqual(query('multipliedUniqueLookup').rowBounds, {
      max: null,
      min: 0,
      proof: 'unbounded',
    })
    assert.equal(query('multipliedUniqueLookup').rowCardinality, 'many')

    assert.deepEqual(
      query('multiRowInsert').params.map(({ name, nullable }) => ({ name, nullable })),
      [
        { name: 'email', nullable: false },
        { name: 'display_name', nullable: true },
        { name: 'second_email', nullable: false },
      ]
    )
    assert.equal(query('mixedTargetInsert').params[0]?.nullable, false)
    assert.equal(query('checkedRoleInsert').params[1]?.tsType, 'AccountsRole')
    assert.equal(query('checkedRoleInsert').params[1]?.tsTypeSource, 'checkConstraint')
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
    assert.equal(query('rewrittenInsert').params[0]?.tsType, 'string')
    assert.equal(query('rewrittenInsert').params[0]?.tsTypeSource, undefined)

    await assert.rejects(
      buildTypedSqlPostgresIrFromCompiledConfigs(database, [config('multipleStatements', 'select 1; select 2')]),
      /typed SQL must contain exactly one PostgreSQL statement; received 2/u
    )
  } finally {
    await database.close()
  }
})

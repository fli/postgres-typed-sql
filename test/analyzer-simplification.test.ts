import assert from 'node:assert/strict'

import { buildTypedSqlPostgresIrFromCompiledConfigs, type TypedSqlPostgresIrRowBounds } from '../src/analyzer-ir.js'
import { analysisConfig, testWithDatabase } from './analyzer-test-support.js'

testWithDatabase('preserves uniqueness proofs and source bounds across shared inference paths', async (database) => {
  await database.query('create table proof_parent (id integer primary key)')
  await database.query(`create table proof_child (
      parent_id integer,
      label text,
      constraint proof_child_key unique (parent_id, label)
    )`)
  const cases: readonly (readonly [string, string, readonly string[], TypedSqlPostgresIrRowBounds])[] = [
    [
      'reversed',
      'select id from proof_parent where $1 = id',
      ['id'],
      { max: 1, min: 0, proof: 'primary_key_equality:proof_parent_pkey' },
    ],
    [
      'composite',
      "select label from proof_child where parent_id = $1 and 'fixed' = label",
      ['id'],
      { max: 1, min: 0, proof: 'unique_index_equality:proof_child_key' },
    ],
    [
      'partial',
      'select label from proof_child where parent_id = $1',
      ['id'],
      { max: null, min: 0, proof: 'unbounded' },
    ],
    ['computed', 'select id from proof_parent where id = $1 + 1', ['id'], { max: null, min: 0, proof: 'unbounded' }],
    [
      'joined',
      `select child.label from proof_parent parent join proof_child child
        on parent.id = child.parent_id where parent.id = $1 and child.label = 'fixed'`,
      ['id'],
      { max: 1, min: 0, proof: 'unique_join_closure(primary_key:proof_parent_pkey,unique_index:proof_child_key)' },
    ],
    [
      'updateFrom',
      `update proof_parent target set id = target.id from proof_child source
        where $1 = target.id returning target.id`,
      ['id'],
      { max: 1, min: 0, proof: 'primary_key_equality:proof_parent_pkey' },
    ],
    [
      'deleteUsing',
      `delete from proof_parent target using proof_child source
        where target.id = $1 returning target.id`,
      ['id'],
      { max: 1, min: 0, proof: 'primary_key_equality:proof_parent_pkey' },
    ],
    [
      'cteProjection',
      'with source(value) as (values (1), (2)) select value from source',
      [],
      { max: 2, min: 2, proof: 'cte_projection:values_2_rows' },
    ],
    [
      'cteGrouping',
      'with source(value) as (values (1), (2)) select value from source group by value',
      [],
      { max: 2, min: 1, proof: 'cte_grouping:values_2_rows' },
    ],
    [
      'filteredProjection',
      'select value from (values (1), (2)) source(value) where value > 1',
      [],
      { max: 2, min: 0, proof: 'subquery_projection:values_2_rows+outer_qual_can_filter' },
    ],
    [
      'filteredGrouping',
      'select value from (values (1), (2)) source(value) where value > 1 group by value',
      [],
      { max: 2, min: 0, proof: 'subquery_grouping:values_2_rows+qual_can_filter' },
    ],
  ]
  const configs = cases.map(([name, sql, parameterNames]) => analysisConfig(name, sql, parameterNames))
  const result = await buildTypedSqlPostgresIrFromCompiledConfigs(database, configs)
  assert.deepEqual(
    result.queries.map(({ name, rowBounds }) => [name, rowBounds]),
    cases.map(([name, , , bounds]) => [name, bounds])
  )
})

testWithDatabase('keeps MERGE row-image availability conservative for mixed actions', async (database) => {
  await database.query('create table merge_images (id integer primary key)')
  await database.query('insert into merge_images values (1), (2)')
  const sql = `merge into merge_images target
      using (values (1), (2), (3)) source(id) on target.id = source.id
      when matched and target.id = 1 then delete
      when matched then update set id = source.id
      when not matched then insert values (source.id)
      returning target.id as id, OLD.id as old_id, NEW.id as new_id`
  const result = await buildTypedSqlPostgresIrFromCompiledConfigs(database, [analysisConfig('mergeImages', sql)])
  assert.deepEqual(
    result.queries[0]?.resultColumns.map(({ name, nullability }) => [name, nullability.kind]),
    [
      ['id', 'nonNull'],
      ['old_id', 'nullable'],
      ['new_id', 'nullable'],
    ]
  )
  const actual = await database.query<{ id: number; old_id: number | null; new_id: number | null }>(sql)
  assert.deepEqual(
    actual.rows.toSorted((left, right) => left.id - right.id),
    [
      { id: 1, old_id: 1, new_id: null },
      { id: 2, old_id: 2, new_id: 2 },
      { id: 3, old_id: null, new_id: 3 },
    ]
  )
})

import assert from 'node:assert/strict'

import { analyzeNative, testWithDatabase } from './analyzer-test-support.js'

interface UsageAnalysis {
  readonly paramUsageNullAdmissions: readonly string[]
}

testWithDatabase('NULL-rejecting scalar subquery filters admit NULL without a cardinality assumption', async (db) => {
  const queries = [
    `select (select jsonb_build_object('id', x.id) from (values (1), (2)) x(id)
      where x.id = $1::int limit 1) as result`,
    `select (select jsonb_build_object('id', x.id) from (values (1), (2)) x(id)
      where x.id = $1::int) as result`,
    `select (select jsonb_build_object('id', x.id) from (values (1), (2)) x(id)
      where x.id = $1::int and x.id = outer_row.id) as result
      from (values (1)) outer_row(id)`,
    `select (select x.id from (values (1), (1)) x(id) where x.id = $1::int) as result`,
    `select (select x.id from (values (1)) x(id)
      where x.id = 1 and x.id = $1::int) as result`,
  ]
  for (const sql of queries) {
    const analysis = await analyzeNative<UsageAnalysis>(db, sql)
    assert.deepEqual(analysis.paramUsageNullAdmissions, ['accepts'], sql)
    assert.deepEqual((await db.query(sql, [null])).rows, [{ result: null }])
  }
  const possiblyMultiple = queries[3]
  assert.ok(possiblyMultiple)
  await assert.rejects(db.query(possiblyMultiple, [1]), /more than one row/u)
})

testWithDatabase('scalar filters retain unknown for NULL-enabled cardinality and unsafe evaluation', async (db) => {
  await db.query(`create function public.fail_on_null(value int) returns int language plpgsql as $$
    begin if value is null then raise exception 'null argument'; end if; return value; end $$`)
  await db.query(`create domain public.nonnull_int as int not null`)
  const cases = [
    `with input as (select $1::int as value)
      select public.fail_on_null((select 1 from input where value is not null))`,
    `select (select x.id from (values (1), (2)) x(id) where $1::int is null)`,
    `select (select x.id from (values (1), (2)) x(id) where x.id = $1::int or $1 is null)`,
    `select (select public.fail_on_null($1::int))`,
    `select (select x.id from (values (1)) x(id) where x.id = $1::int limit public.fail_on_null($1::int))`,
    `select (select x.id from (values (1)) x(id) where x.id = $1::int limit coalesce($1::bigint, -1))`,
    `select (select x.id from (values (1)) x(id) where x.id = $1::int offset coalesce($1::bigint, -1))`,
    `select (select x.id from (values (1)) x(id) where x.id = $1::int)::public.nonnull_int`,
    `select (select count(*) from (values (1)) x(id) where x.id = $1::int)`,
    `select public.fail_on_null((select x.id from (values (1)) x(id) where x.id = $1::int))`,
    `select coalesce((select x.id from (values (1)) x(id) where x.id = $1::int), 1)`,
    `select case when (select x.id from (values (1)) x(id) where x.id = $1::int) is null then 1 else 0 end`,
    `select (select x.id from (values (1)) x(id)
      where x.id = $1::int and public.fail_on_null($1::int) = 1)`,
    `select (select x.id from (values (1)) x(id) where x.id = $1::int)
      + public.fail_on_null($1::int)`,
  ]
  for (const sql of cases) {
    assert.deepEqual((await analyzeNative<UsageAnalysis>(db, sql)).paramUsageNullAdmissions, ['unknown'], sql)
  }
  const cardinality = cases[1]
  const callable = cases[3]
  assert.ok(cardinality && callable)
  await assert.rejects(db.query(cardinality, [null]), /more than one row/u)
  await assert.rejects(db.query(callable, [null]), /null argument/u)
  for (const sql of cases.filter((entry) => entry.includes('coalesce($1::bigint, -1)'))) {
    await db.query(sql, [1])
    await assert.rejects(db.query(sql, [null]), /must not be negative/u)
  }
})

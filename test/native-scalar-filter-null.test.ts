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
  ]
  for (const sql of queries) {
    const analysis = await analyzeNative<UsageAnalysis>(db, sql)
    assert.deepEqual(analysis.paramUsageNullAdmissions, ['accepts'], sql)
    assert.deepEqual((await db.query(sql, [null])).rows, [{ result: null }])
  }
})

testWithDatabase('scalar filters retain unknown for NULL-enabled cardinality and unsafe evaluation', async (db) => {
  await db.query(`create function public.fail_on_null(value int) returns int language plpgsql as $$
    begin if value is null then raise exception 'null argument'; end if; return value; end $$`)
  const cases = [
    `select (select x.id from (values (1), (2)) x(id) where $1::int is null)`,
    `select (select x.id from (values (1), (2)) x(id) where x.id = $1::int or $1 is null)`,
    `select (select public.fail_on_null($1::int))`,
    `select (select x.id from (values (1)) x(id)
      where x.id = $1::int and public.fail_on_null($1::int) = 1)`,
    `select (select x.id from (values (1)) x(id) where x.id = $1::int)
      + public.fail_on_null($1::int)`,
  ]
  for (const sql of cases) {
    assert.deepEqual((await analyzeNative<UsageAnalysis>(db, sql)).paramUsageNullAdmissions, ['unknown'], sql)
  }
  await assert.rejects(db.query(cases[0]!, [null]), /more than one row/u)
  await assert.rejects(db.query(cases[2]!, [null]), /null argument/u)
})

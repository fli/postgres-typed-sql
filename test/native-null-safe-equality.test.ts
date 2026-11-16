import assert from 'node:assert/strict'

import { analyzeNative, testWithDatabase } from './analyzer-test-support.js'

interface Analysis {
  readonly paramUsageNullAdmissions: readonly ('accepts' | 'rejects' | 'unknown')[]
}

testWithDatabase('proves null-safe equality through boolean composition', async (database) => {
  await database.query('create table public.null_safe_probe (value text)')
  for (const predicate of [
    'value is not distinct from $1::text',
    'not (value is distinct from $1::text)',
    '(value is not distinct from $1::text) and true',
    '(value is not distinct from $1::text) or false',
    '(value is distinct from $1::text) is not unknown',
    'value::text is not distinct from $1::text',
  ]) {
    const analysis = await analyzeNative<Analysis>(
      database,
      `select value from public.null_safe_probe where ${predicate}`
    )
    assert.deepEqual(analysis.paramUsageNullAdmissions, ['accepts'], predicate)
  }
})

testWithDatabase('uses three-valued predicate proofs only when an insert is unreachable', async (database) => {
  await database.query('create table public.null_safe_sink (value text not null)')
  const cases = [
    { predicate: '$1::text is distinct from null::text', admission: 'accepts' },
    { predicate: 'null::text is distinct from $1::text', admission: 'accepts' },
    { predicate: "'x'::text is distinct from $1::text", admission: 'rejects' },
    { predicate: 'null::text is not distinct from $1::text', admission: 'rejects' },
    { predicate: 'not ($1::text is not distinct from null::text)', admission: 'accepts' },
    { predicate: '($1::text is distinct from null::text) or null::boolean', admission: 'accepts' },
    { predicate: '($1::text is distinct from null::text) is false', admission: 'rejects' },
    { predicate: "$1::text is distinct from 'x'::text", admission: 'rejects' },
    { predicate: '$1::text is not distinct from null::text', admission: 'rejects' },
  ] as const
  for (const { predicate, admission } of cases) {
    const sql = `insert into public.null_safe_sink select $1::text where ${predicate}`
    const analysis = await analyzeNative<
      Analysis & { statements: { queries: { dmlParameterNullAdmissions: { admission: string }[] }[] }[] }
    >(database, sql)
    const actual = analysis.statements[0]?.queries[0]?.dmlParameterNullAdmissions[0]?.admission
    if (admission === 'accepts') {
      assert.equal(actual, 'accepts', predicate)
      await database.query(sql, [null])
    } else {
      assert.notEqual(actual, 'accepts', predicate)
      await assert.rejects(database.query(sql, [null]), /null value/u)
    }
  }
})

testWithDatabase('keeps unsafe operands conservative in null-safe equality', async (database) => {
  await database.query('create table public.null_safe_probe (value text)')
  await database.query("insert into public.null_safe_probe values ('x')")
  await database.query('create domain public.null_safe_required as text not null')
  await database.query(`create function public.null_safe_explode(value text) returns text language plpgsql as $$
    begin raise exception 'unsafe operand'; end $$`)
  for (const predicate of [
    'length(value) is not distinct from length($1::text)',
    '$1::text is not distinct from public.null_safe_explode(value)',
    '$1::text is not distinct from value::public.null_safe_required',
    '$1::text is not distinct from (select value from public.null_safe_probe union all select value from public.null_safe_probe)',
  ]) {
    const sql = `select value from public.null_safe_probe where ${predicate}`
    const analysis = await analyzeNative<Analysis>(database, sql)
    assert.deepEqual(analysis.paramUsageNullAdmissions, ['unknown'], predicate)
  }
  await assert.rejects(
    database.query('select $1::text is not distinct from public.null_safe_explode(value) from public.null_safe_probe', [
      null,
    ]),
    /unsafe operand/u
  )
  await database.query('insert into public.null_safe_probe values (null)')
  await assert.rejects(
    database.query(
      'select $1::text is not distinct from value::public.null_safe_required from public.null_safe_probe',
      [null]
    ),
    /does not allow null/u
  )
  await assert.rejects(
    database.query(
      'select $1::text is not distinct from (select value from public.null_safe_probe union all select value from public.null_safe_probe)',
      [null]
    ),
    /more than one row/u
  )
})

testWithDatabase('does not assume user-defined equality returns a non-null boolean', async (database) => {
  await database.query('create type public.null_safe_item as (value integer)')
  await database.query(`create function public.null_safe_equal(public.null_safe_item, public.null_safe_item)
    returns boolean language sql immutable leakproof as 'select null::boolean'`)
  await database.query(`create operator public.= (
    leftarg = public.null_safe_item, rightarg = public.null_safe_item, function = public.null_safe_equal
  )`)
  await database.query('create table public.null_safe_sink (value text not null)')
  await database.query(
    'create table public.null_safe_source (value public.null_safe_item, other public.null_safe_item)'
  )
  await database.query(
    'insert into public.null_safe_source values (row(1)::public.null_safe_item, row(2)::public.null_safe_item)'
  )
  const sql = `insert into public.null_safe_sink select $1::text from public.null_safe_source
    where (value is distinct from other) is unknown
      and $1::text is null`
  const analysis = await analyzeNative<
    Analysis & { statements: { queries: { dmlParameterNullAdmissions: { admission: string }[] }[] }[] }
  >(database, sql)
  assert.notEqual(analysis.statements[0]?.queries[0]?.dmlParameterNullAdmissions[0]?.admission, 'accepts')
  await assert.rejects(database.query(sql, [null]), /null value/u)
})

testWithDatabase('preserves scalar subquery cardinality with null-safe predicates', async (database) => {
  const many = `select (select x.id from (values (1, null::text), (2, null::text)) x(id, value)
    where x.value is not distinct from $1::text)`
  assert.deepEqual((await analyzeNative<Analysis>(database, many)).paramUsageNullAdmissions, ['unknown'])
  await assert.rejects(database.query(many, [null]), /more than one row/u)

  const none = `select (select x.id from (values (1), (2)) x(id)
    where $1::text is distinct from null::text)`
  assert.deepEqual((await analyzeNative<Analysis>(database, none)).paramUsageNullAdmissions, ['accepts'])
  assert.equal(Object.values((await database.query(none, [null])).rows[0] ?? {})[0], null)
})

testWithDatabase('evaluates null-safe comparisons in CHECK constraints and domains', async (database) => {
  await database.query('create table public.distinct_check (value text check (value is distinct from null::text))')
  await database.query(
    'create table public.not_distinct_check (value text check (value is not distinct from null::text))'
  )
  await database.query('create domain public.distinct_domain as text check (value is distinct from null::text)')
  await database.query('create table public.distinct_domain_sink (value public.distinct_domain)')
  const cases = [
    { table: 'distinct_check', admission: 'rejects' },
    { table: 'not_distinct_check', admission: 'accepts' },
    { table: 'distinct_domain_sink', admission: 'rejects' },
  ] as const
  for (const { table, admission } of cases) {
    const sql = `insert into public.${table} values ($1)`
    const analysis = await analyzeNative<
      Analysis & { statements: { queries: { dmlParameterNullAdmissions: { admission: string }[] }[] }[] }
    >(database, sql)
    assert.equal(analysis.statements[0]?.queries[0]?.dmlParameterNullAdmissions[0]?.admission, admission, table)
    if (admission === 'accepts') await database.query(sql, [null])
    else await assert.rejects(database.query(sql, [null]), /check constraint/u)
  }
})

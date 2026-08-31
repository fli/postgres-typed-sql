import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import test from 'node:test'

import {
  buildTypedSqlPostgresIrFromCompiledConfigs,
  type TypedSqlPostgresIrCompiledConfig,
} from '../src/analyzer-ir.js'
import { createAnalysisDatabase } from '../src/engine.js'

const schemaFile = resolve(import.meta.dirname, 'fixtures/schema.sql')

function config(name: string, sql: string, parameterNames: readonly string[] = []): TypedSqlPostgresIrCompiledConfig {
  return { name, parameterNames, sourceFile: `queries/${name}.typed.sql`, sql }
}

test('uses partial, expression, and nulls-not-distinct unique indexes with exact catalog evidence', async () => {
  const database = await createAnalysisDatabase({ schemaFiles: [schemaFile] })
  try {
    for (const sql of [
      'create table card_contacts (id int primary key, email text not null, deleted_at timestamptz)',
      'create unique index card_contacts_active on card_contacts(email) where deleted_at is null',
      'create table card_users (id int primary key, tenant int not null, email text not null)',
      'create unique index card_users_email on card_users(tenant, lower(email))',
      'create table card_null_keys (a int, b text, unique nulls not distinct (a, b))',
      'create table card_ordinary_nulls (token text unique)',
      'create table card_deferred (id int, unique(id) deferrable initially deferred)',
      'create table card_collation (email text collate "C")',
      'create unique index card_collation_email on card_collation(lower(email))',
    ])
      await database.query(sql)
    const result = await buildTypedSqlPostgresIrFromCompiledConfigs(database, [
      config('partial', 'select id from card_contacts where deleted_at is null and email = $1', ['email']),
      config('partialMissing', 'select id from card_contacts where email = $1', ['email']),
      config('partialWrong', 'select id from card_contacts where deleted_at is not null and email = $1', ['email']),
      config('expression', 'select id from card_users where tenant = $1 and lower(email) = lower($2)', [
        'tenant',
        'email',
      ]),
      config('expressionWrong', 'select id from card_users where tenant = $1 and upper(email) = upper($2)', [
        'tenant',
        'email',
      ]),
      config('expressionPartialKey', 'select id from card_users where lower(email) = lower($1)', ['email']),
      config('nullKey', 'select a from card_null_keys where a is null and b = $1', ['b']),
      config('allNullKeys', 'select a from card_null_keys where a is null and b is null'),
      config('partialNullKey', 'select a from card_null_keys where a is null'),
      config('ordinaryNulls', 'select token from card_ordinary_nulls where token is null'),
      config('deferred', 'select id from card_deferred where id = $1', ['id']),
      config('matchingCollation', 'select email from card_collation where lower(email) = $1', ['email']),
      config('wrongCollation', 'select email from card_collation where lower(email) collate "POSIX" = $1', ['email']),
      config(
        'derivedPartial',
        'select email from (select email from card_contacts where deleted_at is null) q where email = $1',
        ['email']
      ),
      config('derivedPartialMissing', 'select email from (select email from card_contacts) q where email = $1', [
        'email',
      ]),
      config(
        'derivedExpression',
        'select normalized from (select tenant, lower(email) normalized from card_users) q where tenant = $1 and normalized = $2',
        ['tenant', 'email']
      ),
    ])
    const bounded = new Set([
      'partial',
      'expression',
      'nullKey',
      'allNullKeys',
      'matchingCollation',
      'derivedPartial',
      'derivedExpression',
    ])
    for (const query of result.queries) {
      assert.equal(query.rowBounds.max, bounded.has(query.name) ? 1 : null, query.name)
      assert.equal(query.rowBounds.min, 0, query.name)
    }
  } finally {
    await database.close()
  }
})

test('preserves candidate keys through safe projections and bounds finite key alternatives', async () => {
  const database = await createAnalysisDatabase({ schemaFiles: [schemaFile] })
  try {
    const result = await buildTypedSqlPostgresIrFromCompiledConfigs(database, [
      config('subquery', 'select id from (select id from accounts) q where id = $1', ['id']),
      config(
        'nestedCte',
        'with one as (select id renamed from accounts), two as (select renamed from one) select renamed from two where renamed = $1',
        ['id']
      ),
      config(
        'outerCteProjection',
        'with keyed as (select id from accounts) select id from (select id from keyed) q where id = $1',
        ['id']
      ),
      config(
        'shadowedCte',
        'with keyed as (select id from accounts), source as (with keyed as (select account_id as id from posts) select id from keyed) select id from source where id = $1',
        ['id']
      ),
      config('limitedProjection', 'select id from (select id from accounts limit 2 offset 1) q where id = $1', ['id']),
      config(
        'derivedJoin',
        'select q.id from accounts a join (select id from accounts) q on q.id = a.id where a.id = $1',
        ['id']
      ),
      config('duplicatingJoin', 'select id from (select a.id from accounts a cross join posts p) q where id = $1', [
        'id',
      ]),
      config('changedKey', 'select id from (select id % 2 as id from accounts) q where id = $1', ['id']),
      config('unionAll', 'select id from (select id from accounts union all select id from accounts) q where id = $1', [
        'id',
      ]),
      config('incompleteProjection', 'select title from (select title from posts) q where title = $1', ['title']),
      config('finiteIn', 'select id from accounts where id in ($1, $2)', ['one', 'two']),
      config('finiteOr', 'select id from accounts where id = $1 or id = $2', ['one', 'two']),
      config('duplicateIn', 'select id from accounts where id in ($1, $1)', ['id']),
      config('duplicateOr', 'select id from accounts where id = $1 or id = $1', ['id']),
      config('compositeIn', 'select id from posts where account_id in ($1, $2) and title = $3', [
        'one',
        'two',
        'title',
      ]),
      config(
        'compositeOr',
        'select id from posts where (account_id = $1 and title = $2) or (account_id = $3 and title = $4)',
        ['one', 'titleOne', 'two', 'titleTwo']
      ),
      config('unboundedOr', "select id from accounts where id = $1 or role = 'admin'", ['id']),
      config('arrayParameter', 'select id from accounts where id = any($1::bigint[])', ['ids']),
      config('emptyArray', 'select id from accounts where id = any(array[]::bigint[])'),
      config(
        'finiteJoin',
        'select p.id from posts p join accounts a on a.id = p.account_id where p.id = $1 or p.id = $2',
        ['one', 'two']
      ),
    ])
    const maxima: Record<string, number | null> = {
      subquery: 1,
      nestedCte: 1,
      outerCteProjection: 1,
      shadowedCte: null,
      limitedProjection: 1,
      derivedJoin: 1,
      duplicatingJoin: null,
      changedKey: null,
      unionAll: null,
      incompleteProjection: null,
      finiteIn: 2,
      finiteOr: 2,
      duplicateIn: 1,
      duplicateOr: 1,
      compositeIn: 2,
      compositeOr: 2,
      unboundedOr: null,
      arrayParameter: null,
      emptyArray: 0,
      finiteJoin: 2,
    }
    for (const query of result.queries) {
      assert.equal(query.rowBounds.max, maxima[query.name], query.name)
      assert.equal(query.rowBounds.min, 0, query.name)
    }
  } finally {
    await database.close()
  }
})

test('bounds DISTINCT and ordinary grouping by finite values without confusing aggregate or grouping-set inputs', async () => {
  const database = await createAnalysisDatabase({ schemaFiles: [schemaFile] })
  try {
    await database.query("create table card_nullable_values (value text check (value in ('a', 'b')))")
    const result = await buildTypedSqlPostgresIrFromCompiledConfigs(database, [
      config('distinctParam', 'select distinct $1::text as value from accounts', ['value']),
      config('distinctSingleton', "select distinct role from accounts where role = 'admin'"),
      config('groupSingleton', "select role, count(*) from accounts where role = 'admin' group by role"),
      config('distinctFinite', 'select distinct role from accounts'),
      config('groupFinite', 'select role, count(*) from accounts group by role'),
      config('distinctOn', 'select distinct on (role) role, id from accounts'),
      config('nullableDomain', 'select distinct value from card_nullable_values'),
      config('distinctValues', 'select distinct id from (values (1), (1)) q(id)'),
      config('groupValues', 'select id, count(*) from (values (1), (1)) q(id) group by id'),
      config('volatile', 'select distinct random() from accounts'),
      config('customEnumDistinct', 'select distinct $1::account_status from accounts', ['status']),
      config('customEnumGroup', 'select $1::account_status, count(*) from accounts group by $1::account_status', [
        'status',
      ]),
      config('groupingSets', 'select id from (values (1), (1)) q(id) group by grouping sets ((id), (id))'),
      config('empty', 'select id from accounts where false'),
      config('emptySrf', 'select generate_series(1, 3) from accounts where false'),
      config('globalAggregate', 'select count(*) from accounts where false'),
      config('implicitAggregate', 'select 1 from accounts where false having true'),
      config('emptyHaving', 'select count(*) from accounts having false'),
      config('emptyGrouped', 'select role, count(*) from accounts where false group by role'),
      config('emptyInputGroupingSet', 'select count(*) from accounts where false group by grouping sets (())'),
    ])
    const maxima: Record<string, number | null> = {
      distinctParam: 1,
      distinctSingleton: 1,
      groupSingleton: 1,
      distinctFinite: 2,
      groupFinite: 2,
      distinctOn: 2,
      nullableDomain: 3,
      distinctValues: 1,
      groupValues: 1,
      volatile: null,
      customEnumDistinct: null,
      customEnumGroup: null,
      groupingSets: null,
      empty: 0,
      emptySrf: 0,
      globalAggregate: 1,
      implicitAggregate: 1,
      emptyHaving: 0,
      emptyGrouped: 0,
      emptyInputGroupingSet: null,
    }
    for (const query of result.queries) assert.equal(query.rowBounds.max, maxima[query.name], query.name)
    for (const name of ['distinctValues', 'groupValues', 'globalAggregate']) {
      assert.equal(result.queries.find((query) => query.name === name)?.rowBounds.min, 1, name)
    }
  } finally {
    await database.close()
  }
})

import assert from 'node:assert/strict'

import { buildTypedSqlPostgresIrFromCompiledConfigs } from '../src/analyzer-ir.js'

import { analysisConfig as config, testWithDatabase } from './analyzer-test-support.js'

testWithDatabase(
  'propagates at-most-one cardinality through inner joins on primary and unique keys',
  async (database) => {
    for (const sql of [
      'create table public.trainers (id bigint primary key)',
      'create table public.currencies (id bigint primary key)',
      `create table public.trainer_currency (
         trainer_id bigint unique references public.trainers(id),
         currency_id bigint not null references public.currencies(id)
       )`,
      `create table public.trainer_labels (
         trainer_id bigint not null references public.trainers(id),
         label text not null,
         currency_id bigint not null references public.currencies(id),
         unique (trainer_id, label)
       )`,
      `create table public.trainer_tags (
         trainer_id bigint not null references public.trainers(id),
         currency_id bigint not null references public.currencies(id)
       )`,
    ]) {
      await database.query(sql)
    }

    const result = await buildTypedSqlPostgresIrFromCompiledConfigs(database, [
      config(
        'uniqueChain',
        `select currency.id
         from public.trainers trainer
         join public.trainer_currency selected on selected.trainer_id = trainer.id
         join public.currencies currency on currency.id = selected.currency_id
         where trainer.id = $1`,
        ['trainerId']
      ),
      config(
        'reversedEquality',
        `select currency.id
         from public.trainers trainer
         join public.trainer_currency selected on trainer.id = selected.trainer_id
         join public.currencies currency on selected.currency_id = currency.id
         where $1 = trainer.id`,
        ['trainerId']
      ),
      config(
        'compositeChain',
        `select currency.id
         from public.trainers trainer
         join public.trainer_labels selected
           on selected.trainer_id = trainer.id
          and selected.label = $2
         join public.currencies currency on currency.id = selected.currency_id
         where trainer.id = $1`,
        ['trainerId', 'label']
      ),
      config(
        'independentLookups',
        `select trainer.id
         from public.trainers trainer, public.currencies currency
         where trainer.id = $1 and currency.id = $2`,
        ['trainerId', 'currencyId']
      ),
    ])

    for (const query of result.queries) {
      assert.equal(query.rowBounds.max, 1, query.name)
      assert.equal(query.rowBounds.min, 0, query.name)
      assert.match(query.rowBounds.proof, /^unique_join_closure\(/u, query.name)
    }
  }
)

testWithDatabase(
  'fails closed when a join source is not uniquely determined or the join form is unsupported',
  async (database) => {
    for (const sql of [
      'create table public.bound_trainers (id bigint primary key)',
      'create table public.bound_currencies (id bigint primary key)',
      `create table public.bound_labels (
         trainer_id bigint not null,
         label text not null,
         currency_id bigint not null,
         unique (trainer_id, label)
       )`,
      'create table public.bound_tags (trainer_id bigint not null, currency_id bigint not null)',
    ]) {
      await database.query(sql)
    }

    const result = await buildTypedSqlPostgresIrFromCompiledConfigs(database, [
      config(
        'nonUniqueJoin',
        `select currency.id
         from public.bound_trainers trainer
         join public.bound_tags tag on tag.trainer_id = trainer.id
         join public.bound_currencies currency on currency.id = tag.currency_id
         where trainer.id = $1`,
        ['trainerId']
      ),
      config(
        'partialCompositeKey',
        `select label.currency_id
         from public.bound_trainers trainer
         join public.bound_labels label on label.trainer_id = trainer.id
         where trainer.id = $1`,
        ['trainerId']
      ),
      config(
        'orPredicate',
        `select tag.currency_id
         from public.bound_trainers trainer
         join public.bound_tags tag on tag.trainer_id = trainer.id
         where trainer.id = $1 or trainer.id = $2`,
        ['firstTrainerId', 'secondTrainerId']
      ),
      config(
        'fullJoin',
        `select label.currency_id
         from public.bound_trainers trainer
         full join public.bound_labels label
           on label.trainer_id = trainer.id
          and label.label = 'primary'
         where trainer.id = $1`,
        ['trainerId']
      ),
    ])

    for (const query of result.queries) {
      assert.equal(query.rowBounds.max, null, query.name)
      assert.equal(query.rowBounds.min, 0, query.name)
      assert.equal(query.rowBounds.proof, 'unbounded', query.name)
    }
  }
)

testWithDatabase('preserves bounded inputs through windows, distinct, and ordinary grouping', async (database) => {
  const result = await buildTypedSqlPostgresIrFromCompiledConfigs(database, [
    config('windowLookup', 'select id, row_number() over () from accounts where id = $1', ['id']),
    config('windowNoFrom', 'select row_number() over ()'),
    config('windowValues', 'select count(*) over () from (values (1), (2)) v(id)'),
    config('windowAggregate', 'select count(*), row_number() over () from accounts'),
    config('distinctLookup', 'select distinct id from (select id from accounts where id = $1) q', ['id']),
    config('distinctValues', 'select distinct id from (values (1), (1)) v(id)'),
    config('groupedLookup', 'select id, count(*) from accounts where id = $1 group by id', ['id']),
    config('groupedHaving', 'select id, count(*) from (values (1), (2)) v(id) group by id having count(*) > 2'),
    config('groupedWindow', 'select id, row_number() over () from (values (1), (2)) v(id) group by id'),
    config('groupingSets', 'select id from (values (1), (2)) v(id) group by grouping sets ((id), (id))'),
    config('targetSrf', 'select generate_series(1, 3), row_number() over () from accounts where id = $1', ['id']),
  ])
  const expected = new Map<string, readonly [number, number | null]>([
    ['windowLookup', [0, 1]],
    ['windowNoFrom', [1, 1]],
    ['windowValues', [2, 2]],
    ['windowAggregate', [1, 1]],
    ['distinctLookup', [0, 1]],
    ['distinctValues', [1, 1]],
    ['groupedLookup', [0, 1]],
    ['groupedHaving', [0, 2]],
    ['groupedWindow', [1, 2]],
    ['groupingSets', [0, null]],
    ['targetSrf', [0, null]],
  ])
  for (const query of result.queries) {
    assert.deepEqual([query.rowBounds.min, query.rowBounds.max], expected.get(query.name), query.name)
  }
  assert.equal((await database.query('select distinct id from (values (1), (1)) v(id)')).rows.length, 1)
  assert.equal(
    (await database.query('select id from (values (1), (2)) v(id) group by grouping sets ((id), (id))')).rows.length,
    4
  )
})

testWithDatabase('follows outer join direction and treats lateral bounds as per-left-row bounds', async (database) => {
  const result = await buildTypedSqlPostgresIrFromCompiledConfigs(database, [
    config(
      'uniqueLeft',
      `select p.title from accounts a left join posts p
        on p.account_id = a.id and p.title = 'primary' where a.id = $1`,
      ['id']
    ),
    config(
      'mixedJoins',
      `select other.id from accounts a
        left join posts p on p.account_id = a.id and p.title = 'primary'
        join accounts other on other.id = p.account_id where a.id = $1`,
      ['id']
    ),
    config(
      'boundedLeft',
      `select p.title from (values (1::bigint)) a(id)
        left join posts p on p.account_id = a.id and p.title = 'primary'`
    ),
    config(
      'leftLateral',
      `select p.title from accounts a left join lateral
        (select title from posts where account_id = a.id order by id limit 1) p on true where a.id = $1`,
      ['id']
    ),
    config(
      'innerLateral',
      `select p.title from accounts a join lateral
        (select title from posts where account_id = a.id order by id limit 1) p on true where a.id = $1`,
      ['id']
    ),
    config(
      'twoLeftRows',
      `select p.title from (values (1::bigint), (2::bigint)) a(id) left join lateral
        (select title from posts where account_id = a.id order by id limit 1) p on true`
    ),
    config('reverseInner', 'select a.id from accounts a join (select $1::bigint as id) p on a.id = p.id', ['id']),
    config('implicitGlobalGroup', 'select 1 from (select 1 limit 0) a cross join (select 1) b having true'),
    config(
      'onDoesNotFilterLeft',
      `select a.id from accounts a left join posts p
        on a.id = $1 and p.account_id = a.id and p.title = 'primary'`,
      ['id']
    ),
    config('nonUniqueLeft', 'select p.title from accounts a left join posts p on p.account_id = a.id where a.id = $1', [
      'id',
    ]),
    config(
      'unboundedLateralLeft',
      `select p.title from accounts a join lateral
        (select title from posts where account_id = a.id order by id limit 1) p on true`
    ),
    config(
      'lateralTies',
      `select p.title from accounts a left join lateral
        (select title from posts where account_id = a.id order by account_id fetch first 1 row with ties) p
        on true where a.id = $1`,
      ['id']
    ),
  ])
  const expected = new Map<string, readonly [number, number | null]>([
    ['uniqueLeft', [0, 1]],
    ['mixedJoins', [0, 1]],
    ['boundedLeft', [1, 1]],
    ['leftLateral', [0, 1]],
    ['innerLateral', [0, 1]],
    ['twoLeftRows', [2, 2]],
    ['reverseInner', [0, 1]],
    ['implicitGlobalGroup', [0, 1]],
    ['onDoesNotFilterLeft', [0, null]],
    ['nonUniqueLeft', [0, null]],
    ['unboundedLateralLeft', [0, null]],
    ['lateralTies', [0, null]],
  ])
  for (const query of result.queries) {
    assert.deepEqual([query.rowBounds.min, query.rowBounds.max], expected.get(query.name), query.name)
  }
  await database.query("insert into accounts(email) values ('one@example.test'), ('two@example.test')")
  assert.equal(
    (await database.query('select 1 from (select 1 limit 0) a cross join (select 1) b having true')).rows.length,
    1
  )
  assert.equal(
    (
      await database.query(`select a.id from accounts a left join posts p
      on a.id = 1 and p.account_id = a.id and p.title = 'primary'`)
    ).rows.length,
    2
  )
  assert.equal(
    (
      await database.query(`select p.title from (values (1::bigint), (2::bigint)) a(id) left join lateral
      (select title from posts where account_id = a.id limit 1) p on true`)
    ).rows.length,
    2
  )
})

testWithDatabase(
  'recognizes immutable row-independent lookup expressions without trusting volatile or row-dependent values',
  async (database) => {
    await database.query(`create function public.volatile_email(value text) returns text
      language plpgsql volatile as $$ begin return lower(value); end $$`)
    const result = await buildTypedSqlPostgresIrFromCompiledConfigs(database, [
      config('normalizedEmail', 'select id from accounts where email = lower($1)', ['email']),
      config('arithmeticKey', 'select id from accounts where id = $1::bigint + 1', ['id']),
      config('coalescedEmail', 'select id from accounts where email = lower(coalesce($1, $2))', ['email', 'fallback']),
      config(
        'joinedNormalizedKey',
        `select p.id from accounts a join posts p
        on p.account_id = a.id and p.title = lower($2) where a.email = lower($1)`,
        ['email', 'title']
      ),
      config('volatileEmail', 'select id from accounts where email = public.volatile_email($1)', ['email']),
      config('rowDependentEmail', 'select id from accounts where email = lower(email)'),
    ])
    for (const query of result.queries) {
      assert.equal(
        query.rowBounds.max,
        ['volatileEmail', 'rowDependentEmail'].includes(query.name) ? null : 1,
        query.name
      )
    }
  }
)

testWithDatabase(
  'subtracts constant offsets before limits and preserves scalar-subquery row presence',
  async (database) => {
    const result = await buildTypedSqlPostgresIrFromCompiledConfigs(database, [
      config('offsetOne', 'values (1), (2) offset 1'),
      config('offsetZero', 'values (1), (2) offset 0'),
      config('offsetNull', 'values (1), (2) offset null'),
      config('offsetPastEnd', 'values (1), (2) offset 3'),
      config('offsetBeforeLimit', 'values (1), (2), (3) limit 2 offset 1'),
      config(
        'offsetWithTies',
        'select id from (values (1), (1), (1)) v(id) order by id offset 1 fetch first 1 row with ties'
      ),
      config('dynamicOffset', 'values (1), (2) offset $1', ['offset']),
      config('scalarOffset', 'select (select id from (values (1), (2)) v(id) offset 1) as id'),
    ])
    const expected = new Map<string, readonly [number, number | null]>([
      ['offsetOne', [1, 1]],
      ['offsetZero', [2, 2]],
      ['offsetNull', [2, 2]],
      ['offsetPastEnd', [0, 0]],
      ['offsetBeforeLimit', [2, 2]],
      ['offsetWithTies', [1, 2]],
      ['dynamicOffset', [0, 2]],
      ['scalarOffset', [1, 1]],
    ])
    for (const query of result.queries) {
      assert.deepEqual([query.rowBounds.min, query.rowBounds.max], expected.get(query.name), query.name)
    }
    assert.equal(
      result.queries.find((query) => query.name === 'scalarOffset')?.resultColumns[0]?.nullability.kind,
      'nonNull'
    )
    assert.equal((await database.query('values (1), (2), (3) limit 2 offset 1')).rows.length, 2)
  }
)

testWithDatabase(
  'does not use non-strict opfamily equality to bound NULLS DISTINCT unique indexes',
  async (database) => {
    for (const sql of [
      `create function public.null_safe_equal(integer, integer) returns boolean
       language sql immutable as $$ select $1 is not distinct from $2 $$`,
      `create operator public.=== (leftarg = integer, rightarg = integer, function = public.null_safe_equal)`,
      `create operator class public.null_safe_int_ops for type integer using btree as
       operator 1 <, operator 2 <=, operator 3 public.===, operator 4 >=, operator 5 >,
       function 1 btint4cmp(integer, integer)`,
      'create table public.null_keys(id integer)',
      'create unique index null_keys_unique on public.null_keys(id public.null_safe_int_ops)',
      'insert into public.null_keys values (null), (null)',
    ]) {
      await database.query(sql)
    }
    const result = await buildTypedSqlPostgresIrFromCompiledConfigs(database, [
      config('nonStrictLookup', 'select id from null_keys where id operator(public.===) $1', ['id']),
      config(
        'nonStrictJoin',
        `select k.id from (values (null::integer)) v(id)
        left join null_keys k on k.id operator(public.===) v.id`
      ),
    ])
    for (const query of result.queries) {
      assert.equal(query.rowBounds.max, null, query.name)
    }
    assert.equal(
      (await database.query('select id from null_keys where id operator(public.===) $1', [null])).rows.length,
      2
    )
  }
)

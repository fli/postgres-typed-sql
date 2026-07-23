import assert from 'node:assert/strict'
import test from 'node:test'

import { PGlite } from '../src/vendor/pglite/index.js'

test('PostgreSQL prepares and executes authored casts with untyped wire parameters', async () => {
  const database = new PGlite()
  try {
    await database.waitReady

    const temporal = await database.query<{ readonly elapsed: unknown }>(
      'select $1::timestamptz - $2::timestamptz as elapsed',
      ['2026-07-23T12:00:00+09:30', '2026-07-23T11:30:00+09:30']
    )
    assert.equal(temporal.fields[0]?.dataTypeID, 1186)
    assert.equal(temporal.rows.length, 1)

    const bigint = await database.query<{ readonly value: unknown }>('select $1::bigint as value', ['9007199254740993'])
    assert.equal(bigint.fields[0]?.dataTypeID, 20)
    assert.equal(bigint.rows.length, 1)
  } finally {
    await database.close()
  }
})

test('PostgreSQL result metadata flattens domains but preserves custom array and scalar OIDs', async () => {
  const database = new PGlite()
  try {
    await database.waitReady
    await database.exec('create domain score as integer check (value >= 0)')
    await database.exec('create domain score_list as integer[]')
    await database.exec('create domain object_id as oid')
    await database.exec('create type score_span as range (subtype = integer)')
    await database.exec("create type json_mood as enum ('sad', 'ok')")
    await database.exec(`
      create function json_mood_to_json(json_mood)
      returns json
      language sql immutable strict
      as $$ select json_build_object('mood', $1::text) $$
    `)
    await database.exec('create cast (json_mood as json) with function json_mood_to_json(json_mood) as assignment')
    await database.exec('create table events(id integer, value score)')
    await database.exec('insert into events values (1, 42)')

    const scalarDomain = await database.query<{ readonly value: unknown }>('select value from events')
    assert.equal(scalarDomain.fields[0]?.dataTypeID, 23)
    assert.equal(scalarDomain.rows[0]?.value, 42)

    const arrayDomain = await database.query<{ readonly value: unknown }>('select array[1, 2]::score_list as value')
    assert.equal(arrayDomain.fields[0]?.dataTypeID, 1007)
    assert.deepEqual(arrayDomain.rows[0]?.value, [1, 2])

    const domainArray = await database.query<{ readonly value: unknown }>('select array[1, 2]::score[] as value')
    assert.notEqual(domainArray.fields[0]?.dataTypeID, 1007)
    assert.equal(domainArray.rows[0]?.value, '{1,2}')

    const oidDomain = await database.query<{ readonly value: unknown }>('select 42::object_id as value')
    assert.equal(oidDomain.fields[0]?.dataTypeID, 26)
    assert.equal(oidDomain.rows[0]?.value, 42)

    const composite = await database.query<{ readonly value: unknown }>('select events as value from events')
    assert.equal(composite.rows[0]?.value, '(1,42)')

    const range = await database.query<{ readonly value: unknown }>("select '[1,3)'::score_span as value")
    assert.equal(range.rows[0]?.value, '[1,3)')

    const jsonSpecialNumbers = await database.query<{ readonly value: unknown }>(`
      select jsonb_build_object(
        'finite', 1.5::numeric,
        'numeric_nan', 'NaN'::numeric,
        'float_infinity', 'Infinity'::float8,
        'oid', 42::oid,
        'oid_domain', 43::object_id
        ,'custom_cast', 'ok'::json_mood
      ) as value
    `)
    assert.deepEqual(jsonSpecialNumbers.rows[0]?.value, {
      finite: 1.5,
      float_infinity: 'Infinity',
      numeric_nan: 'NaN',
      oid: '42',
      oid_domain: '43',
      custom_cast: { mood: 'ok' },
    })
  } finally {
    await database.close()
  }
})

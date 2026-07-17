import assert from 'node:assert/strict'
import test from 'node:test'

import { loadPostgresTypeFacts } from '../src/postgres-type-facts.js'
import { PGlite } from '../src/vendor/pglite/index.js'

test('catalog facts use PostgreSQL array relationships rather than the array-like category', async () => {
  const database = new PGlite()
  try {
    await database.waitReady
    await database.exec(`
      create type public.json_mood as enum ('sad', 'ok');
      create function public.json_mood_to_json(public.json_mood)
      returns json
      language sql immutable strict
      as $$ select json_build_object('mood', $1::text) $$;
      create cast (public.json_mood as json)
      with function public.json_mood_to_json(public.json_mood)
      as assignment;
      create function public.oid_to_json(oid)
      returns json
      language sql immutable strict
      as $$ select json_build_object('oid', $1::text) $$;
      create cast (oid as json)
      with function public.oid_to_json(oid)
      as assignment;
    `)
    const result = await database.query<{
      readonly array_oid: number
      readonly box_array_oid: number
      readonly json_cast_oid: number
      readonly scalar_oid: number
    }>(`
      select
        'int2vector'::regtype::oid::int as scalar_oid,
        'int2vector[]'::regtype::oid::int as array_oid,
        'box[]'::regtype::oid::int as box_array_oid,
        'public.json_mood'::regtype::oid::int as json_cast_oid
    `)
    const row = result.rows[0]
    assert.ok(row)

    const facts = await loadPostgresTypeFacts(database, [
      26,
      row.scalar_oid,
      row.array_oid,
      row.box_array_oid,
      row.json_cast_oid,
    ])
    const scalar = facts.get(row.scalar_oid)
    const array = facts.get(row.array_oid)

    assert.equal(scalar?.pgTypeName, 'int2vector')
    assert.equal(scalar?.pgTypeKind, 'base')
    assert.equal(scalar?.pgArrayElementType, undefined)
    assert.equal(array?.pgTypeKind, 'array')
    assert.equal(array?.pgArrayElementType?.pgTypeOid, row.scalar_oid)
    assert.equal(array?.pgArrayElementType?.pgTypeName, 'int2vector')
    assert.equal(array?.pgArrayDelimiter, ',')
    assert.equal(facts.get(row.box_array_oid)?.pgArrayDelimiter, ';')
    assert.equal(facts.get(row.json_cast_oid)?.pgCastsToJson, true)
    assert.deepEqual(facts.get(row.json_cast_oid)?.pgEnumLabels, ['sad', 'ok'])
    assert.equal(facts.get(26)?.pgCastsToJson, undefined)
  } finally {
    await database.close()
  }
})

import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { definePostgresCodecProfile, postgresTypeScriptType } from '../src/index.js'
import { createMinimalFixture, generateTypedSql } from './generator-test-support.js'

test('narrows flat SQL arrays while preserving decoder-specific element types and nested dimensions', async () => {
  const root = await createMinimalFixture(
    `create type public.array_state as enum ('ready', 'missing');
     create table public.array_inputs(id integer not null, nullable_id integer);`,
    `select
      array[1, 2] as flat_values,
      array[1, null::integer] as nullable_values,
      array[]::integer[] as empty_values,
      array(select id from public.array_inputs) as selected_values,
      array(select nullable_id from public.array_inputs) as nullable_selected_values,
      array(select array[1, 2]) as nested_selected_values,
      array[array[1, 2]] as nested_values,
      array[1.5] as numeric_values,
      1.5 as numeric_value,
      array[1::numeric] as cast_numeric_values,
      1::numeric as cast_numeric_value,
      array['ready'::public.array_state] as enum_values,
      (select array[1, 2] where false) as optional_values`
  )
  await generateTypedSql({
    codecProfile: 'node-postgres',
    include: ['queries'],
    rootDir: root,
    schema: 'schema.sql',
  })
  const output = await readFile(join(root, 'queries/query.typed-sql.ts'), 'utf8')
  for (const name of ['flat_values', 'empty_values', 'selected_values', 'numeric_values']) {
    assert.match(output, new RegExp(`readonly ${name}: readonly \\(number\\)\\[\\]\\n`, 'u'))
  }
  for (const name of ['nullable_values', 'nullable_selected_values']) {
    assert.match(output, new RegExp(`readonly ${name}: readonly \\(number \\| null\\)\\[\\]\\n`, 'u'))
  }
  assert.match(output, /readonly nested_selected_values: PgArray<number>\n/u)
  assert.match(output, /readonly nested_values: PgArray<number>\n/u)
  assert.match(output, /readonly numeric_value: PgNumericString\n/u)
  assert.match(output, /readonly cast_numeric_values: readonly \(number\)\[\]\n/u)
  assert.match(output, /readonly cast_numeric_value: PgNumericString\n/u)
  assert.match(output, /readonly enum_values: string\n/u)
  assert.match(output, /readonly optional_values: readonly \(number\)\[\] \| null\n/u)
})

test('combines SQL array shape facts across every set-operation output arm', async () => {
  const root = await createMinimalFixture(
    'select 1;',
    'select array[1, 2] as values union all select array[null::integer] as values'
  )
  const config = { codecProfile: 'node-postgres' as const, include: ['queries'], rootDir: root, schema: 'schema.sql' }
  await generateTypedSql(config)
  const outputFile = join(root, 'queries/query.typed-sql.ts')
  let output = await readFile(outputFile, 'utf8')
  assert.match(output, /readonly values: readonly \(number \| null\)\[\]\n/u)
  await writeFile(
    join(root, 'queries/query.typed.sql'),
    'select array[1, 2] as values union all select array[array[1, 2]] as values'
  )
  await generateTypedSql(config)
  output = await readFile(outputFile, 'utf8')
  assert.match(output, /readonly values: PgArray<number>\n/u)
})

test('transports flat array shape through CTEs, VALUES, CASE and COALESCE while rejecting mixed dimensions', async () => {
  const root = await createMinimalFixture(
    'create table array_composition(flag boolean, values integer[]);',
    `
    with arrays as (select array[1,2] as values)
    select a.values as cte_values,
      (select values from (values(array[1,null::integer]),(array[2])) v(values) limit 1) as derived_values,
      case when flag then array[1] else array[2,3] end as case_values,
      case when flag then array[1] else null::integer[] end as optional_case,
      coalesce(null::integer[],array[1]) as coalesced,
      case when flag then array[1] else array[array[2]] end as mixed_dimensions,
      coalesce(t.values,array[1]) as unknown_values
    from array_composition t cross join arrays a`
  )
  await generateTypedSql({ rootDir: root, schema: 'schema.sql', include: ['queries'], codecProfile: 'node-postgres' })
  const output = await readFile(join(root, 'queries/query.typed-sql.ts'), 'utf8')
  for (const name of ['cte_values', 'case_values', 'coalesced'])
    assert.match(output, new RegExp(`readonly ${name}: readonly \\(number\\)\\[\\]\\n`, 'u'))
  assert.match(output, /readonly derived_values: readonly \(number \| null\)\[\]\n/u)
  assert.match(output, /readonly optional_case: readonly \(number\)\[\] \| null\n/u)
  for (const name of ['mixed_dimensions', 'unknown_values'])
    assert.match(output, new RegExp(`readonly ${name}: PgArray<number>\\n`, 'u'))
})

test('does not narrow custom SQL array decoders based on their profile name or TypeScript type text', async () => {
  const root = await createMinimalFixture('select 1;', 'select array[1, 2] as values')
  const config = { include: ['queries'], rootDir: root, schema: 'schema.sql' }
  const sameNameProfile = definePostgresCodecProfile({
    extends: 'node-postgres',
    name: 'node-postgres',
    resultType({ decoderType }, fallback) {
      return decoderType.pgTypeOid === 1007 ? postgresTypeScriptType('string') : fallback()
    },
  })
  await generateTypedSql({ ...config, codecProfile: sameNameProfile })
  const outputFile = join(root, 'queries/query.typed-sql.ts')
  let output = await readFile(outputFile, 'utf8')
  assert.match(output, /readonly values: string\n/u)

  const sameTypeProfile = definePostgresCodecProfile({
    extends: 'node-postgres',
    name: 'same-array-type',
    resultType(_context, fallback) {
      return fallback()
    },
  })
  await generateTypedSql({ ...config, codecProfile: sameTypeProfile })
  output = await readFile(outputFile, 'utf8')
  assert.match(output, /readonly values: PgArray<number>\n/u)
  await generateTypedSql({ ...config, codecProfile: 'conservative' })
  output = await readFile(outputFile, 'utf8')
  assert.match(output, /readonly values: unknown\n/u)
})

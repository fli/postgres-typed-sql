import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { createMinimalFixture, generateTypedSql } from './generator-test-support.js'

test('preserves array element nullability, dimensions, and lossless scalar types', async () => {
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
    include: ['queries'],
    rootDir: root,
    schema: 'schema.sql',
  })
  const output = await readFile(join(root, 'queries/query.typed-sql.ts'), 'utf8')
  for (const name of ['flat_values', 'empty_values', 'selected_values']) {
    assert.match(output, new RegExp(`readonly ${name}: PgArray<number>\\n`, 'u'))
  }
  for (const name of ['nullable_values', 'nullable_selected_values']) {
    assert.match(output, new RegExp(`readonly ${name}: PgArray<number \\| null>\\n`, 'u'))
  }
  assert.match(output, /readonly nested_selected_values: PgArray<number \| null>\n/u)
  assert.match(output, /readonly nested_values: PgArray<number \| null>\n/u)
  assert.match(output, /readonly numeric_values: PgArray<PgDecimal>\n/u)
  assert.match(output, /readonly numeric_value: PgDecimal\n/u)
  assert.match(output, /readonly cast_numeric_values: PgArray<PgDecimal>\n/u)
  assert.match(output, /readonly cast_numeric_value: PgDecimal\n/u)
  assert.match(output, /readonly enum_values: PgArray<"ready" \| "missing">\n/u)
  assert.match(output, /readonly optional_values: PgArray<number> \| null\n/u)
})

test('combines SQL array shape facts across every set-operation output arm', async () => {
  const root = await createMinimalFixture(
    'select 1;',
    'select array[1, 2] as values union all select array[null::integer] as values'
  )
  const config = { include: ['queries'], rootDir: root, schema: 'schema.sql' }
  await generateTypedSql(config)
  const outputFile = join(root, 'queries/query.typed-sql.ts')
  let output = await readFile(outputFile, 'utf8')
  assert.match(output, /readonly values: PgArray<number \| null>\n/u)
  await writeFile(
    join(root, 'queries/query.typed.sql'),
    'select array[1, 2] as values union all select array[array[1, 2]] as values'
  )
  await generateTypedSql(config)
  output = await readFile(outputFile, 'utf8')
  assert.match(output, /readonly values: PgArray<number \| null>\n/u)
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
  await generateTypedSql({ rootDir: root, schema: 'schema.sql', include: ['queries'] })
  const output = await readFile(join(root, 'queries/query.typed-sql.ts'), 'utf8')
  for (const name of ['cte_values', 'case_values', 'coalesced'])
    assert.match(output, new RegExp(`readonly ${name}: PgArray<number>\\n`, 'u'))
  assert.match(output, /readonly derived_values: PgArray<number \| null>\n/u)
  assert.match(output, /readonly optional_case: PgArray<number> \| null\n/u)
  for (const name of ['mixed_dimensions', 'unknown_values'])
    assert.match(output, new RegExp(`readonly ${name}: PgArray<number \\| null>\\n`, 'u'))
})

test('uses conservative array aggregate element types and accepts convenient array parameters', async () => {
  const root = await createMinimalFixture(
    'create table array_members(id bigint not null, maybe_id bigint);',
    `select array_agg(id) as ids,
      array_agg(maybe_id) as maybe_ids,
      array_agg(maybe_id) filter (where maybe_id is not null) as filtered_ids
    from array_members where id = any(:ids::bigint[])`
  )
  await generateTypedSql({ include: ['queries'], rootDir: root, schema: 'schema.sql' })
  const output = await readFile(join(root, 'queries/query.typed-sql.ts'), 'utf8')
  assert.match(output, /readonly ids: PgArray<bigint \| null> \| null\n/u)
  assert.match(output, /readonly maybe_ids: PgArray<bigint \| null> \| null\n/u)
  assert.match(output, /readonly filtered_ids: PgArray<bigint \| null> \| null\n/u)
  assert.match(output, /readonly ids: PgArrayInput<PgInt8Input \| null>/u)
})

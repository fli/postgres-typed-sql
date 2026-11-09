import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { createMinimalFixture, generateTypedSql } from './generator-test-support.js'

test('renders JSON literals and path results while preserving SQL-null metadata and field mapping', async () => {
  const root = await createMinimalFixture(
    'create table public.json_values(display_name text);',
    `select
      '{"state":"ready","count":9007199254740993,"overflow":1e1000,"flag":true,"nothing":null,"items":[{"display_name":"Reader"}]}'::jsonb as literal,
      'null'::jsonb as json_null,
      null::jsonb as sql_null,
      jsonb_build_object('value', display_name) -> 'value' as nullable_value,
      coalesce(jsonb_build_object('value', null::text) -> 'value', '"fallback"'::jsonb) as retained_null,
      jsonb_build_array('ready', 42) -> 0 as first,
      '{"items":[{"display_name":"Reader"}]}'::jsonb #> array['items','0','display_name'] as path,
      '{"items":[null]}'::jsonb #>> array['items','0'] as null_text,
      '{"state":"ready","secret":42}'::jsonb - 'secret' as deleted,
      coalesce(jsonb_build_object('value', 'present') ->> 'absent', 'fallback') as replaced
    from public.json_values`
  )
  await generateTypedSql({
    include: ['queries'],
    naming: { structuredJsonFields: 'camelCase' },
    rootDir: root,
    schema: 'schema.sql',
  })
  const output = await readFile(join(root, 'queries/query.typed-sql.ts'), 'utf8')
  assert.match(output, /Value model: postgres-lossless-v1/u)
  assert.match(output, /import type \{[^}]*PgFiniteDecimal[^}]*PgJson[^}]*\} from 'postgres-typed-sql\/values'/u)
  assert.match(output, /readonly state: 'ready'\n/u)
  assert.match(output, /readonly count: PgFiniteDecimal\n/u)
  assert.doesNotMatch(output, /readonly count: 900719925474099[23]/u)
  assert.match(output, /readonly overflow: PgFiniteDecimal\n/u)
  assert.doesNotMatch(output, /readonly overflow: Infinity/u)
  assert.match(output, /readonly flag: true\n/u)
  assert.match(output, /readonly nothing: null\n/u)
  assert.match(output, /readonly displayName: 'Reader'\n/u)
  assert.match(output, /readonly json_null: PgJson<null>\n/u)
  assert.match(output, /readonly sql_null: PgJson<null> \| null\n/u)
  assert.match(output, /readonly nullable_value: PgJson<string \| null>\n/u)
  assert.match(output, /readonly retained_null: PgJson<null>\n/u)
  assert.match(output, /readonly first: PgJson<'ready'>\n/u)
  assert.match(output, /readonly path: PgJson<'Reader'>\n/u)
  assert.match(output, /readonly null_text: string \| null\n/u)
  assert.match(output, /readonly replaced: 'fallback'\n/u)
  assert.doesNotMatch(output, /readonly secret:/u)
  assert.doesNotMatch(output, /null \| null/u)
  assert.match(output, /name: 'json_null',[\s\S]*?nullable: false/u)
  assert.match(output, /name: 'sql_null',[\s\S]*?nullable: true/u)
  assert.match(output, /"name":"display_name","propertyName":"displayName"/u)
})

test('retains exact JSON numeric values alongside text values', async () => {
  const root = await createMinimalFixture(
    'create table json_union_values(value text, flag boolean, amount integer);',
    `select jsonb_build_object(
      'text', coalesce(value, ''),
      'literal_only', case when flag then '' else 'other' end,
      'number', case when flag then to_jsonb(amount) else '42'::jsonb end,
      'boolean', case when flag then to_jsonb(flag) else 'true'::jsonb end,
      'mixed', case when flag then to_jsonb(value) else '42'::jsonb end
    ) as payload from json_union_values`
  )
  const config = { include: ['queries'], rootDir: root, schema: 'schema.sql' }
  await generateTypedSql(config)
  const output = await readFile(join(root, 'queries/query.typed-sql.ts'), 'utf8')
  assert.match(output, /readonly text: string\n/u)
  assert.match(output, /readonly literal_only: '' \| 'other'\n/u)
  assert.doesNotMatch(output, /readonly number: [^\n]*\b42\b/u)
  assert.doesNotMatch(output, /readonly boolean: [^\n]*\btrue\b/u)
  assert.match(output, /readonly mixed: string \| PgFiniteDecimal \| null\n/u)
})

test('uses a common JSON representation for ambiguous date and text, while explicit SQL text stays text', async () => {
  const root = await createMinimalFixture(
    'create table public.value_choices(flag boolean, day date, label text);',
    `select
      case when flag then to_jsonb(day) else to_jsonb(label) end as ambiguous,
      day::text as day_text,
      to_jsonb(day) as json_day
    from public.value_choices`
  )
  await generateTypedSql({ include: ['queries'], rootDir: root, schema: 'schema.sql' })
  const output = await readFile(join(root, 'queries/query.typed-sql.ts'), 'utf8')
  assert.match(output, /readonly ambiguous: PgJson<string> \| null\n/u)
  assert.match(output, /readonly day_text: string \| null\n/u)
  assert.match(output, /readonly json_day: PgJson<PgDate> \| null\n/u)
})

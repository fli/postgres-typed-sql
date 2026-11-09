import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { createAnalysisDatabase } from '../src/engine.js'

import { createMinimalFixture, generateTypedSql, renderQuery } from './generator-test-support.js'

test('renders a CASE-authored JSON state machine as a precise discriminated union', async () => {
  const output = await renderQuery(
    `create table public.playback_values (
  publication_public_id text,
  manifest_object_key text
);
`,
    `select case
  when playback.publication_public_id is not null
   and playback.manifest_object_key is not null
  then jsonb_build_object(
    'state', 'playable',
    'publicationPublicId', playback.publication_public_id,
    'manifestType', 'hls',
    'manifestObjectKey', playback.manifest_object_key
  )
  else jsonb_build_object('state', 'unavailable')
end as playback
from (values (1)) seed(value)
left join lateral (
  select publication_public_id, manifest_object_key
  from public.playback_values
  limit 1
) playback on true
`
  )
  assert.match(output, /interface QueryJ8_playbackJsonJ12_alternative1 \{[\s\S]*readonly state: 'playable'/u)
  assert.match(output, /readonly publicationPublicId: string\n/u)
  assert.match(output, /readonly manifestType: 'hls'\n/u)
  assert.match(output, /readonly manifestObjectKey: string\n/u)
  assert.match(output, /interface QueryJ8_playbackJsonJ12_alternative2 \{[\s\S]*readonly state: 'unavailable'/u)
  assert.match(
    output,
    /readonly playback: PgJson<QueryJ8_playbackJsonJ12_alternative1 \| QueryJ8_playbackJsonJ12_alternative2>\n/u
  )
  assert.doesNotMatch(output, /readonly publicationPublicId: string \| null/u)
  assert.doesNotMatch(output, /readonly manifestObjectKey: string \| null/u)
})

test('uses generic JSON for ambiguous VALUES objects and keeps function outputs nullable', async () => {
  const output = await renderQuery(
    'select 1;\n',
    `select source.payload, generated.value
from (
  values
    (jsonb_build_object('left', 'left-value')),
    (jsonb_build_object('right', 'right-value'))
) source(payload)
cross join generate_series(1, 2) generated(value)
`
  )
  assert.match(output, /readonly payload: PgJson<PgJsonValue>/u)
  assert.match(output, /jsonPlan: \{"kind":"generic"\}/u)
  assert.match(output, /readonly value: number \| null/u)
  assert.match(output, /name: 'value',[\s\S]*?nullable: true/u)
})

test('renders JSON build-array element structures through existing unions, naming, and opaque fallbacks', async () => {
  const root = await createMinimalFixture(
    'select 1;\n',
    `select jsonb_build_array(
  jsonb_build_object('state', 'ready', 'display_name', 'Reader'::text),
  jsonb_build_object('state', 'missing', 'error_code', null::text)
) as payload
`
  )
  const config = {
    include: ['queries'],
    naming: {
      structuredJsonFields: 'camelCase' as const,
    },
    rootDir: root,
    schema: 'schema.sql',
  }
  const queryFile = join(root, 'queries/query.typed.sql')
  const outputFile = join(root, 'queries/query.typed-sql.ts')

  await generateTypedSql(config)
  let output = await readFile(outputFile, 'utf8')
  assert.match(output, /interface QueryJ7_payloadJsonJ7_elementJ12_alternative1 \{/u)
  assert.match(output, /readonly state: 'ready'/u)
  assert.match(output, /readonly displayName: 'Reader'/u)
  assert.match(output, /interface QueryJ7_payloadJsonJ7_elementJ12_alternative2 \{/u)
  assert.match(output, /readonly state: 'missing'/u)
  assert.match(output, /readonly errorCode: null/u)
  assert.match(
    output,
    /readonly payload: PgJson<readonly \(QueryJ7_payloadJsonJ7_elementJ12_alternative1 \| QueryJ7_payloadJsonJ7_elementJ12_alternative2\)\[\]>\n/u
  )
  assert.doesNotMatch(output, /readonly payload: .*\[\] \| null/u)
  assert.match(output, /jsonPlan: \{"kind":"array","element":/u)
  assert.match(output, /"name":"display_name","propertyName":"displayName"/u)
  assert.match(output, /"name":"error_code","propertyName":"errorCode"/u)

  await writeFile(queryFile, 'select jsonb_build_array() as payload\n')
  await generateTypedSql(config)
  output = await readFile(outputFile, 'utf8')
  assert.match(output, /readonly payload: PgJson<readonly \(PgJsonValue\)\[\]>\n/u)
  assert.doesNotMatch(output, /readonly payload: .*\[\] \| null/u)

  await writeFile(queryFile, 'select jsonb_build_array(variadic :entries::text[]) as payload\n')
  await generateTypedSql(config)
  output = await readFile(outputFile, 'utf8')
  assert.match(output, /readonly payload: PgJson<readonly \(PgJsonValue \| null\)\[\]> \| null/u)
})

test('keeps I/O-cast JSON shapes opaque and strict conversion results nullable', async () => {
  const root = await createMinimalFixture(
    'select 1;\n',
    `select (case when true
  then '{"a":1}'
  else '{"b":2}'
end)::jsonb as payload
`
  )
  const config = {
    include: ['queries'],
    rootDir: root,
    schema: 'schema.sql',
  }
  const queryFile = join(root, 'queries/query.typed.sql')
  const outputFile = join(root, 'queries/query.typed-sql.ts')

  await generateTypedSql(config)
  let output = await readFile(outputFile, 'utf8')
  assert.match(output, /readonly payload: PgJson<PgJsonValue>\n/u)
  assert.doesNotMatch(output, /'\{"a":1\}'/u)
  assert.doesNotMatch(output, /'\{"b":2\}'/u)

  await writeFile(
    queryFile,
    'select row_to_json(source_row, null::boolean) as payload from (values (1)) source_row(value)\n'
  )
  await generateTypedSql(config)
  output = await readFile(outputFile, 'utf8')
  assert.match(output, /readonly payload: PgJson<QueryJ7_payloadJson> \| null/u)
  assert.match(output, /name: 'payload',[\s\S]*?nullable: true/u)

  await writeFile(queryFile, 'select row_to_json(source_row, false) as payload from (values (1)) source_row(value)\n')
  await generateTypedSql(config)
  output = await readFile(outputFile, 'utf8')
  assert.match(output, /readonly payload: PgJson<QueryJ7_payloadJson>\n/u)
  assert.doesNotMatch(output, /readonly payload: PgJson<QueryJ7_payloadJson> \| null/u)
  assert.match(output, /name: 'payload',[\s\S]*?nullable: false/u)
})

test('generates composed JSON unions, projections, conversions, and filtered aggregate element types', async () => {
  const root = await createMinimalFixture(
    'create table public.json_inputs(id integer not null, display_name text);',
    `select
      coalesce(
        (select jsonb_build_object('state', 'ready') from public.json_inputs limit 1),
        jsonb_build_object('state', 'missing')
      ) as fallback,
      to_jsonb('ready'::text) as converted_text,
      to_jsonb(source) as converted_row,
      to_jsonb(array[jsonb_build_object('display_name', 'Reader'::text)]) as converted_array,
      jsonb_build_object('state', 'ready') -> 'state' as projected_json,
      jsonb_build_object('state', 'ready') ->> 'state' as projected_text,
      jsonb_build_object('state', 'old') || jsonb_build_object('state', 'ready') as combined,
      (select jsonb_agg(display_name) filter(where display_name is not null) from public.json_inputs) as filtered,
      (select jsonb_agg_strict(display_name) from public.json_inputs) as strict_values
     from public.json_inputs source`
  )
  await generateTypedSql({
    include: ['queries'],
    naming: { structuredJsonFields: 'camelCase' },
    rootDir: root,
    schema: 'schema.sql',
  })
  const output = await readFile(join(root, 'queries/query.typed-sql.ts'), 'utf8')
  assert.match(output, /readonly fallback: PgJson<[^\n]*alternative1 \| [^\n]*alternative2>\n/u)
  assert.match(output, /readonly converted_text: PgJson<'ready'>\n/u)
  assert.match(output, /readonly converted_row: PgJson<Query[^\n]*Json>\n/u)
  assert.match(output, /readonly id: number\n/u)
  assert.match(output, /readonly displayName: string \| null\n/u)
  assert.match(output, /readonly converted_array: PgJson<readonly \(Query[^\n]*\)\[\]>\n/u)
  assert.match(output, /readonly displayName: 'Reader'\n/u)
  assert.match(output, /readonly projected_json: PgJson<'ready'>\n/u)
  assert.match(output, /readonly projected_text: 'ready'\n/u)
  assert.match(output, /readonly filtered: PgJson<readonly \(string\)\[\]> \| null\n/u)
  assert.match(output, /readonly strict_values: PgJson<readonly \(string\)\[\]> \| null\n/u)
  assert.doesNotMatch(output, /readonly state: 'old'/u)
  assert.match(output, /"name":"display_name","propertyName":"displayName"/u)
})

test('separates JSON-null projections while keeping custom JSON conversions opaque across composition', async () => {
  const root = await createMinimalFixture(
    `create type public.json_source as enum ('ready');
     create function public.json_source_cast(public.json_source) returns json
       language sql immutable as $$ select 'null'::json $$;
     create cast (public.json_source as json) with function public.json_source_cast(public.json_source);
     create domain public.json_source_domain as public.json_source;`,
    `select
      coalesce(jsonb_build_object('value', null::text) -> 'value',
        jsonb_build_object('fallback', 'not-used')) as json_null,
      to_jsonb('ready'::public.json_source) as custom_value,
      to_jsonb(('ready'::public.json_source)::public.json_source_domain) as domain_value,
      to_jsonb(jsonb_build_object('value', 'ready'::public.json_source) ->> 'value') as custom_text`
  )
  await generateTypedSql({
    include: ['queries'],
    rootDir: root,
    schema: 'schema.sql',
  })
  const output = await readFile(join(root, 'queries/query.typed-sql.ts'), 'utf8')
  assert.match(output, /readonly json_null: PgJson<null>\n/u)
  assert.match(output, /readonly custom_value: PgJson<PgJsonValue>\n/u)
  assert.match(output, /readonly domain_value: PgJson<PgJsonValue>\n/u)
  assert.match(output, /readonly custom_text: PgJson<string> \| null\n/u)
  assert.doesNotMatch(output, /readonly fallback:/u)
  const database = await createAnalysisDatabase({ schemaFiles: [join(root, 'schema.sql')] })
  try {
    const query = await readFile(join(root, 'queries/query.typed.sql'), 'utf8')
    assert.deepEqual((await database.query(query)).rows, [
      { json_null: null, custom_value: null, domain_value: null, custom_text: null },
    ])
  } finally {
    await database.close()
  }
})

test('rejects colliding camelCase fields in structured JSON', async () => {
  const root = await createMinimalFixture(
    'select 1;',
    "select jsonb_build_object('foo_bar', 1, 'fooBar', 2) as payload"
  )
  await assert.rejects(
    generateTypedSql({
      include: ['queries'],
      naming: { structuredJsonFields: 'camelCase' },
      rootDir: root,
      schema: 'schema.sql',
    }),
    /duplicate JSON field in result column "payload" name "fooBar"/u
  )
})

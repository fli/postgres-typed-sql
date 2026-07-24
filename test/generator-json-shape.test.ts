import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { definePostgresCodecProfile, postgresTypeScriptType } from '../src/index.js'

import { createMinimalFixture, generateTypedSql } from './generator-test-support.js'

test('renders a CASE-authored JSON state machine as a precise discriminated union', async () => {
  const root = await createMinimalFixture(
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
  await generateTypedSql({
    include: ['queries'],
    rootDir: root,
    codecProfile: 'node-postgres',
    schema: 'schema.sql',
  })

  const output = await readFile(join(root, 'queries/query.typed-sql.ts'), 'utf8')
  assert.match(output, /interface QueryJ8_playbackJsonJ12_alternative1 \{[\s\S]*readonly state: 'playable'/u)
  assert.match(output, /readonly publicationPublicId: string\n/u)
  assert.match(output, /readonly manifestType: 'hls'\n/u)
  assert.match(output, /readonly manifestObjectKey: string\n/u)
  assert.match(output, /interface QueryJ8_playbackJsonJ12_alternative2 \{[\s\S]*readonly state: 'unavailable'/u)
  assert.match(
    output,
    /readonly playback: QueryJ8_playbackJsonJ12_alternative1 \| QueryJ8_playbackJsonJ12_alternative2\n/u
  )
  assert.doesNotMatch(output, /readonly playback: DbJsonSelected/u)
  assert.doesNotMatch(output, /readonly publicationPublicId: string \| null/u)
  assert.doesNotMatch(output, /readonly manifestObjectKey: string \| null/u)
})

test('renders VALUES JSON unions while keeping function RTE outputs explicitly nullable', async () => {
  const root = await createMinimalFixture(
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
  await generateTypedSql({
    include: ['queries'],
    rootDir: root,
    codecProfile: 'node-postgres',
    schema: 'schema.sql',
  })

  const output = await readFile(join(root, 'queries/query.typed-sql.ts'), 'utf8')
  assert.match(output, /readonly left: 'left-value'/u)
  assert.match(output, /readonly right: 'right-value'/u)
  assert.match(output, /readonly payload: QueryJ7_payloadJsonJ12_alternative1 \| QueryJ7_payloadJsonJ12_alternative2/u)
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
    codecProfile: 'node-postgres' as const,
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
  assert.match(output, /readonly errorCode: string \| null/u)
  assert.match(
    output,
    /readonly payload: readonly \(QueryJ7_payloadJsonJ7_elementJ12_alternative1 \| QueryJ7_payloadJsonJ7_elementJ12_alternative2\)\[\]\n/u
  )
  assert.doesNotMatch(output, /readonly payload: DbJsonSelected/u)
  assert.doesNotMatch(output, /readonly payload: .*\[\] \| null/u)
  assert.match(output, /"arrayElement":\{"fields":/u)
  assert.match(output, /"name":"display_name","propertyName":"displayName"/u)
  assert.match(output, /"name":"error_code","propertyName":"errorCode"/u)

  await writeFile(queryFile, 'select jsonb_build_array() as payload\n')
  await generateTypedSql(config)
  output = await readFile(outputFile, 'utf8')
  assert.match(output, /readonly payload: readonly \(DbJsonSelected\)\[\]\n/u)
  assert.doesNotMatch(output, /readonly payload: .*\[\] \| null/u)

  await writeFile(queryFile, 'select jsonb_build_array(variadic :entries::text[]) as payload\n')
  await generateTypedSql(config)
  output = await readFile(outputFile, 'utf8')
  assert.match(output, /readonly payload: readonly \(DbJsonSelected \| null\)\[\] \| null/u)

  const customOpaqueJsonProfile = definePostgresCodecProfile({
    extends: 'node-postgres',
    name: 'custom-opaque-json',
    opaqueJsonType: postgresTypeScriptType('OpaqueJsonValue', {
      scalarImports: ['OpaqueJsonValue'],
    }),
    structuredJson: true,
  })
  await generateTypedSql({ ...config, codecProfile: customOpaqueJsonProfile })
  output = await readFile(outputFile, 'utf8')
  assert.match(output, /import type \{ [^}]*OpaqueJsonValue[^}]* \} from 'postgres-typed-sql\/scalars'/u)
  assert.match(output, /readonly payload: readonly \(OpaqueJsonValue \| null\)\[\] \| null/u)

  await writeFile(queryFile, 'select jsonb_build_array() as payload\n')
  await generateTypedSql({ ...config, codecProfile: customOpaqueJsonProfile })
  output = await readFile(outputFile, 'utf8')
  assert.match(output, /readonly payload: readonly \(OpaqueJsonValue\)\[\]\n/u)
  assert.doesNotMatch(output, /OpaqueJsonValue \| null/u)

  await writeFile(
    queryFile,
    "select jsonb_build_array(jsonb_build_object('display_name', 'Reader'::text)) as payload\n"
  )
  await generateTypedSql({
    ...config,
    codecProfile: 'conservative',
    naming: { structuredJsonFields: 'preserve' },
  })
  output = await readFile(outputFile, 'utf8')
  assert.match(output, /readonly payload: unknown/u)
  assert.doesNotMatch(output, /interface QueryJ7_payloadJson/u)
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
    codecProfile: 'node-postgres' as const,
    schema: 'schema.sql',
  }
  const queryFile = join(root, 'queries/query.typed.sql')
  const outputFile = join(root, 'queries/query.typed-sql.ts')

  await generateTypedSql(config)
  let output = await readFile(outputFile, 'utf8')
  assert.match(output, /readonly payload: DbJsonSelected\n/u)
  assert.doesNotMatch(output, /'\{"a":1\}'/u)
  assert.doesNotMatch(output, /'\{"b":2\}'/u)

  await writeFile(
    queryFile,
    'select row_to_json(source_row, null::boolean) as payload from (values (1)) source_row(value)\n'
  )
  await generateTypedSql(config)
  output = await readFile(outputFile, 'utf8')
  assert.match(output, /readonly payload: QueryJ7_payloadJson \| null/u)
  assert.match(output, /name: 'payload',[\s\S]*?nullable: true/u)

  await writeFile(queryFile, 'select row_to_json(source_row, false) as payload from (values (1)) source_row(value)\n')
  await generateTypedSql(config)
  output = await readFile(outputFile, 'utf8')
  assert.match(output, /readonly payload: QueryJ7_payloadJson\n/u)
  assert.doesNotMatch(output, /readonly payload: QueryJ7_payloadJson \| null/u)
  assert.match(output, /name: 'payload',[\s\S]*?nullable: false/u)
})

test('uses the codec JSON scalar type when exact string-literal refinement is disabled', async () => {
  const root = await createMinimalFixture(
    'select 1;\n',
    "select jsonb_build_object('state', 'active'::text) as payload\n"
  )
  const codecProfile = definePostgresCodecProfile({
    extends: 'node-postgres',
    name: 'decoded-json-text',
    jsonScalarType({ type }, fallback) {
      return type.pgTypeSchema === 'pg_catalog' && type.pgTypeName === 'text'
        ? postgresTypeScriptType('DecodedJsonText', { scalarImports: ['DecodedJsonText'] })
        : fallback()
    },
    supportsStringLiteralRefinement({ position, type }, fallback) {
      return position === 'json' && type.pgTypeSchema === 'pg_catalog' && type.pgTypeName === 'text'
        ? false
        : fallback()
    },
  })

  await generateTypedSql({
    codecProfile,
    include: ['queries'],
    rootDir: root,
    schema: 'schema.sql',
  })

  const output = await readFile(join(root, 'queries/query.typed-sql.ts'), 'utf8')
  assert.match(output, /import type \{ DecodedJsonText \} from 'postgres-typed-sql\/scalars'/u)
  assert.match(output, /readonly state: DecodedJsonText/u)
  assert.doesNotMatch(output, /readonly state: 'active'/u)
})

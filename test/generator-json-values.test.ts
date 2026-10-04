import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { definePostgresCodecProfile, postgresTypeScriptType } from '../src/index.js'
import { createMinimalFixture, generateTypedSql } from './generator-test-support.js'

test('renders JSON literals and path results while preserving SQL-null metadata and field mapping', async () => {
  const root = await createMinimalFixture(
    'create table public.json_values(display_name text);',
    `select
      '{"state":"ready","count":42,"overflow":1e1000,"flag":true,"nothing":null,"items":[{"display_name":"Reader"}]}'::jsonb as literal,
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
    codecProfile: 'node-postgres',
    include: ['queries'],
    naming: { structuredJsonFields: 'camelCase' },
    rootDir: root,
    schema: 'schema.sql',
  })
  const output = await readFile(join(root, 'queries/query.typed-sql.ts'), 'utf8')
  assert.match(output, /readonly state: 'ready'\n/u)
  assert.match(output, /readonly count: 42\n/u)
  assert.match(output, /readonly overflow: DbJsonSelected\n/u)
  assert.doesNotMatch(output, /readonly overflow: Infinity/u)
  assert.match(output, /readonly flag: true\n/u)
  assert.match(output, /readonly nothing: null\n/u)
  assert.match(output, /readonly displayName: 'Reader'\n/u)
  assert.match(output, /readonly json_null: null\n/u)
  assert.match(output, /readonly sql_null: null\n/u)
  assert.match(output, /readonly nullable_value: string \| null\n/u)
  assert.match(output, /readonly retained_null: null\n/u)
  assert.match(output, /readonly first: 'ready'\n/u)
  assert.match(output, /readonly path: 'Reader'\n/u)
  assert.match(output, /readonly null_text: string \| null\n/u)
  assert.match(output, /readonly replaced: 'fallback'\n/u)
  assert.doesNotMatch(output, /readonly secret:/u)
  assert.doesNotMatch(output, /null \| null/u)
  assert.match(output, /name: 'json_null',[\s\S]*?nullable: false/u)
  assert.match(output, /name: 'sql_null',[\s\S]*?nullable: true/u)
  assert.match(output, /"name":"display_name","propertyName":"displayName"/u)
})

test('does not assign source scalar OIDs or builtin parser guarantees to custom decoded JSON literals', async () => {
  const root = await createMinimalFixture(
    'select 1;',
    `select
    '{"state":"ready","count":42,"nothing":null}'::jsonb as literal,
    'null'::jsonb as json_null,
    jsonb_build_object('converted', 'ready'::text) as converted,
    case when :include::boolean then '{"display_name":"Reader"}'::jsonb else 'null'::jsonb end as mixed`
  )
  const seenScalarTypes: string[] = []
  const profile = definePostgresCodecProfile({
    extends: 'node-postgres',
    name: 'node-postgres',
    opaqueJsonType: postgresTypeScriptType('CustomJson', { scalarImports: ['CustomJson'] }),
    jsonScalarType({ type }) {
      seenScalarTypes.push(type.pgTypeName)
      return postgresTypeScriptType('DecodedText', { scalarImports: ['DecodedText'] })
    },
    supportsStringLiteralRefinement({ position }, fallback) {
      return position === 'json' ? false : fallback()
    },
  })
  const config = {
    include: ['queries'],
    naming: { structuredJsonFields: 'camelCase' as const },
    rootDir: root,
    schema: 'schema.sql',
  }
  await generateTypedSql({ ...config, codecProfile: profile })
  let output = await readFile(join(root, 'queries/query.typed-sql.ts'), 'utf8')
  assert.deepEqual([...new Set(seenScalarTypes)], ['text'])
  for (const name of ['state', 'count', 'nothing', 'json_null', 'mixed'])
    assert.match(output, new RegExp(`readonly ${name}: CustomJson\\n`, 'u'))
  assert.match(output, /readonly converted: DecodedText\n/u)
  assert.doesNotMatch(output, /readonly state: 'ready'/u)
  assert.doesNotMatch(output, /"name":"display_name","propertyName":"displayName"/u)

  const raw = definePostgresCodecProfile({
    extends: 'node-postgres',
    name: 'node-postgres',
    structuredJson: false,
    resultType({ decoderType }, fallback) {
      return ['json', 'jsonb'].includes(decoderType.pgTypeName) ? postgresTypeScriptType('string') : fallback()
    },
  })
  await generateTypedSql({ ...config, codecProfile: raw, naming: { structuredJsonFields: 'preserve' } })
  output = await readFile(join(root, 'queries/query.typed-sql.ts'), 'utf8')
  assert.match(output, /readonly literal: string\n/u)
  assert.match(output, /readonly json_null: string\n/u)
  assert.doesNotMatch(output, /interface QueryJ7_literalJson/u)
})

test('retains authored scalar identities for typed NULL embedded in JSON under custom codecs', async () => {
  const root = await createMinimalFixture(
    'select 1;',
    `select jsonb_build_object(
    'email', null::text,
    'position', null::integer,
    'granted_at', null::timestamptz,
    'literal', 'null'::jsonb
  ) as value`
  )
  const profile = definePostgresCodecProfile({
    extends: 'node-postgres',
    name: 'custom-json-null',
    opaqueJsonType: postgresTypeScriptType('OpaqueJson'),
    jsonScalarType({ type }, fallback) {
      if (type.pgTypeName === 'text') return postgresTypeScriptType('EmailText')
      if (type.pgTypeName === 'int4') return postgresTypeScriptType('PositionNumber')
      if (type.pgTypeName === 'timestamptz') return postgresTypeScriptType('TimestampText')
      return fallback()
    },
  })
  await generateTypedSql({ include: ['queries'], rootDir: root, schema: 'schema.sql', codecProfile: profile })
  const output = await readFile(join(root, 'queries/query.typed-sql.ts'), 'utf8')
  assert.match(output, /readonly email: EmailText \| null/u)
  assert.match(output, /readonly position: PositionNumber \| null/u)
  assert.match(output, /readonly granted_at: TimestampText \| null/u)
  assert.match(output, /readonly literal: OpaqueJson/u)
  await generateTypedSql({ include: ['queries'], rootDir: root, schema: 'schema.sql', codecProfile: 'node-postgres' })
  const builtinOutput = await readFile(join(root, 'queries/query.typed-sql.ts'), 'utf8')
  assert.match(builtinOutput, /readonly email: null\n/u)
  assert.match(builtinOutput, /readonly position: null\n/u)
  assert.match(builtinOutput, /readonly granted_at: null\n/u)
})

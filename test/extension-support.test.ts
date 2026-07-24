import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import { tmpdir } from 'node:os'

import { createAnalysisDatabase, supportedExtensions } from '../src/engine.js'

test('loads schema artifacts that use the supported Keepon extensions', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'postgres-typed-sql-extensions-'))
  const schemaFile = resolve(root, 'schema.sql')
  await writeFile(
    schemaFile,
    `create extension citext;
create extension hstore;
create extension pg_stat_statements;
create table public.extension_values (
  email citext not null,
  attributes hstore not null
);
`
  )

  const database = await createAnalysisDatabase({ schemaFiles: [schemaFile] })
  try {
    await database.query(
      `insert into public.extension_values (email, attributes)
       values ('person@example.com', '"enabled"=>"true"')`
    )
    const result = await database.query<{
      readonly emailType: string
      readonly attributesType: string
      readonly statementsInstalled: boolean
    }>(`select
      pg_typeof(email)::text as "emailType",
      pg_typeof(attributes)::text as "attributesType",
      to_regclass('public.pg_stat_statements') is not null as "statementsInstalled"
    from public.extension_values`)
    assert.deepEqual(result.rows, [
      {
        emailType: 'citext',
        attributesType: 'hstore',
        statementsInstalled: true,
      },
    ])
  } finally {
    await database.close()
  }

  assert.equal(supportedExtensions.includes('citext'), true)
  assert.equal(supportedExtensions.includes('hstore'), true)
  assert.equal(supportedExtensions.includes('pg_stat_statements'), true)
})

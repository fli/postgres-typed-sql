import assert from 'node:assert/strict'
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { generateTypedSql } from '../src/generator.js'

const fixtureRoot = new URL('./fixtures/', import.meta.url)

async function copyFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'postgres-typed-sql-'))
  await cp(fixtureRoot, root, { recursive: true })
  return root
}

test('generates PostgreSQL-derived types, nullability, and cardinality', async () => {
  const root = await copyFixture()
  const result = await generateTypedSql({
    extensions: ['pgcrypto'],
    include: ['queries'],
    rootDir: root,
    schema: 'schema.sql',
  })

  assert.equal(result.statementCount, 4)
  const account = await readFile(join(root, 'queries/find-account-by-email.typed-sql.ts'), 'utf8')
  assert.match(account, /cardinality: 'optional'/u)
  assert.match(account, /readonly display_name: string \| null/u)
  assert.match(account, /readonly status: AccountStatus/u)
  assert.match(account, /readonly role: AccountsRole/u)
  assert.match(account, /postgres-typed-sql\/runtime/u)

  const joined = await readFile(join(root, 'queries/list-accounts-with-posts.typed-sql.ts'), 'utf8')
  assert.match(joined, /readonly title: string \| null/u)
  assert.match(joined, /readonly published_at: PgTimestamptzString \| null/u)

  const catalog = await readFile(join(root, 'postgres-typed-sql.types.ts'), 'utf8')
  assert.match(catalog, /export type AccountStatus = 'active' \| 'suspended'/u)
  assert.match(catalog, /export type AccountsRole = 'member' \| 'admin'/u)
})

test('surfaces native PostgreSQL diagnostics for invalid SQL', async () => {
  const root = await copyFixture()
  await writeFile(join(root, 'queries/invalid.typed.sql'), 'select missing_column from public.accounts\n')

  await assert.rejects(
    generateTypedSql({
      include: ['queries'],
      rootDir: root,
      schema: 'schema.sql',
    }),
    /column "missing_column" does not exist/u
  )
})

test('preserves non-code parameter text and limits directives to the header', async () => {
  const root = await copyFixture()
  await writeFile(
    join(root, 'queries/lexical-contexts.typed.sql'),
    `-- @name lexicalContexts
-- @param cutoff timestamp with time zone?
-- @param email text
-- @column cutoff timestamp with time zone
select
  ':not_a_parameter' as literal_value,
  $$:also_not$$ as dollar_value,
  :cutoff as cutoff,
  account.display_name
from public.accounts account
where account.email = :email
  and /* outer :not_this /* inner :nor_this */ */ true
-- @todo this body comment must remain SQL
-- :comment_parameter
`
  )

  const result = await generateTypedSql({
    include: ['queries'],
    rootDir: root,
    schema: 'schema.sql',
  })

  assert.equal(result.statementCount, 5)
  const output = await readFile(join(root, 'queries/lexical-contexts.typed-sql.ts'), 'utf8')
  assert.match(output, /parameterNames: \['cutoff', 'email'\]/u)
  assert.match(output, /readonly cutoff: PgTimestamptzString \| null/u)
  assert.match(output, /name: 'cutoff',[\s\S]*?nullable: true/u)
  assert.match(output, /':not_a_parameter'/u)
  assert.match(output, /\$\$:also_not\$\$/u)
  assert.match(output, /\/\* outer :not_this \/\* inner :nor_this \*\/ \*\//u)
  assert.match(output, /@todo this body comment must remain SQL/u)
  assert.match(output, /-- :comment_parameter/u)
  assert.doesNotMatch(output, /Unknown/u)
})

test('preserves explicit parameter types while PostgreSQL infers unspecified parameter types', async () => {
  const root = await copyFixture()
  await writeFile(
    join(root, 'queries/mixed-parameter-oids.typed.sql'),
    `-- @name mixedParameterOids
-- @param label text
select :label as label
from public.accounts account
where account.id = :account_id
`
  )

  const result = await generateTypedSql({
    include: ['queries'],
    rootDir: root,
    schema: 'schema.sql',
  })

  assert.equal(result.statementCount, 5)
  const output = await readFile(join(root, 'queries/mixed-parameter-oids.typed-sql.ts'), 'utf8')
  assert.match(output, /parameterNames: \['label', 'account_id'\]/u)
  assert.match(output, /readonly label: string/u)
  assert.match(output, /readonly account_id: PgInt8String/u)
  assert.match(output, /name: 'label',[\s\S]*?pgType: 'text'/u)
  assert.match(output, /name: 'account_id',[\s\S]*?pgType: 'bigint'/u)
})

test('uses native DML facts for parameter nullability and nested write access', async () => {
  const root = await copyFixture()
  await writeFile(
    join(root, 'queries/native-dml-facts.typed.sql'),
    `-- @name nativeDmlFacts
insert into public.accounts(email, display_name)
values (:email, :display_name), (:second_email, :display_name)
returning id
`
  )
  await writeFile(
    join(root, 'queries/mixed-dml-target.typed.sql'),
    `-- @name mixedDmlTarget
insert into public.accounts(email, display_name)
values (:value, :value)
returning id
`
  )
  await writeFile(
    join(root, 'queries/modifying-cte.typed.sql'),
    `-- @name modifyingCte
-- @param email text?
with inserted as (
  insert into public.accounts(email, display_name)
  values (:email, :display_name)
  returning id
)
select id from inserted
`
  )

  const result = await generateTypedSql({
    include: ['queries'],
    rootDir: root,
    schema: 'schema.sql',
  })

  assert.equal(result.statementCount, 7)

  const nativeFacts = await readFile(join(root, 'queries/native-dml-facts.typed-sql.ts'), 'utf8')
  assert.match(nativeFacts, /readonly email: string\n/u)
  assert.match(nativeFacts, /readonly display_name: string \| null/u)
  assert.match(nativeFacts, /readonly second_email: string\n/u)

  const mixedTarget = await readFile(join(root, 'queries/mixed-dml-target.typed-sql.ts'), 'utf8')
  assert.match(mixedTarget, /readonly value: string\n/u)
  assert.doesNotMatch(mixedTarget, /readonly value: string \| null/u)

  const modifyingCte = await readFile(join(root, 'queries/modifying-cte.typed-sql.ts'), 'utf8')
  assert.match(modifyingCte, /access: 'write'/u)
  assert.match(modifyingCte, /readonly email: string \| null/u)
  assert.match(modifyingCte, /readonly display_name: string \| null/u)
})

test('preserves exact parameter, result, JSON, relation, and schema-qualified type names', async () => {
  const root = await copyFixture()
  await writeFile(
    join(root, 'queries/exact-names.typed.sql'),
    `-- @name exactNames
select
  :user_id::text as user_id,
  :userId::text as "userId",
  jsonb_build_object(
    'snake_key', :json_value::text,
    'URL', :url_value::text
  ) as payload_json
`
  )

  const schemaPath = join(root, 'schema.sql')
  const schema = await readFile(schemaPath, 'utf8')
  await writeFile(
    schemaPath,
    `${schema}
create schema audit;
create type audit.account_status as enum ('queued', 'complete');
create table audit.events (
  event_id bigint primary key,
  event_status audit.account_status not null,
  event_statuses audit.account_status[] not null
);
`
  )
  await writeFile(
    join(root, 'queries/audit-event.typed.sql'),
    'select event_id, event_status, event_statuses from audit.events where event_id = :event_id\n'
  )

  const result = await generateTypedSql({
    include: ['queries'],
    rootDir: root,
    schema: 'schema.sql',
  })

  assert.equal(result.statementCount, 6)
  const exact = await readFile(join(root, 'queries/exact-names.typed-sql.ts'), 'utf8')
  assert.match(exact, /parameterNames: \['user_id', 'userId', 'json_value', 'url_value'\]/u)
  assert.match(exact, /readonly user_id: string/u)
  assert.match(exact, /readonly userId: string/u)
  assert.match(exact, /readonly json_value: string/u)
  assert.match(exact, /readonly payload_json: ExactNamesPayloadJsonJson/u)
  assert.match(exact, /readonly snake_key: string/u)
  assert.match(exact, /readonly URL: string/u)
  assert.doesNotMatch(exact, /import type \{ URL \}/u)

  const audit = await readFile(join(root, 'queries/audit-event.typed-sql.ts'), 'utf8')
  assert.match(audit, /import type \{ AuditAccountStatus \}/u)
  assert.match(audit, /readonly event_id: PgInt8String/u)
  assert.match(audit, /readonly event_status: AuditAccountStatus/u)
  assert.match(audit, /readonly event_statuses: readonly AuditAccountStatus\[\]/u)

  const catalog = await readFile(join(root, 'postgres-typed-sql.types.ts'), 'utf8')
  assert.match(catalog, /export type AccountStatus = 'active' \| 'suspended'/u)
  assert.match(catalog, /export type AuditAccountStatus = 'queued' \| 'complete'/u)
  assert.match(catalog, /export interface AuditEvents \{[\s\S]*?readonly event_id: PgInt8String/u)
  assert.match(catalog, /readonly "audit\.events": AuditEvents/u)
})

test('rejects duplicate, reserved, and colliding generated names before emission', async () => {
  const invalidSources = [
    {
      error: /duplicate result column name "duplicate"/u,
      file: 'duplicate-result.typed.sql',
      sql: 'select 1 as duplicate, 2 as duplicate\n',
    },
    {
      error: /@name: "class" is not a legal non-reserved TypeScript binding/u,
      file: 'reserved-statement.typed.sql',
      sql: '-- @name class\nselect 1\n',
    },
    {
      error: /@name createTypedSqlStatement collides with the generated runtime import/u,
      file: 'runtime-import-collision.typed.sql',
      sql: '-- @name createTypedSqlStatement\nselect 1\n',
    },
    {
      error: /duplicate @param value/u,
      file: 'duplicate-parameter.typed.sql',
      sql: '-- @param value text\n-- @param value integer\nselect :value\n',
    },
    {
      error: /duplicate JSON field in .* name "value"/u,
      file: 'duplicate-json.typed.sql',
      sql: "select jsonb_build_object('value', 1, 'value', 2) as duplicate_json\n",
    },
  ] as const

  for (const invalid of invalidSources) {
    const root = await copyFixture()
    await writeFile(join(root, 'queries', invalid.file), invalid.sql)
    await assert.rejects(
      generateTypedSql({
        include: ['queries'],
        rootDir: root,
        schema: 'schema.sql',
      }),
      invalid.error
    )
  }

  const root = await copyFixture()
  const schemaPath = join(root, 'schema.sql')
  const schema = await readFile(schemaPath, 'utf8')
  await writeFile(
    schemaPath,
    `${schema}
create schema a;
create type public.a_status as enum ('public');
create type a.status as enum ('schema');
`
  )
  await assert.rejects(
    generateTypedSql({
      include: ['queries'],
      rootDir: root,
      schema: 'schema.sql',
    }),
    /generated TypeScript binding AStatus for enum public\.a_status collides with enum a\.status/u
  )

  const importCollisionRoot = await copyFixture()
  const importCollisionSchemaPath = join(importCollisionRoot, 'schema.sql')
  const importCollisionSchema = await readFile(importCollisionSchemaPath, 'utf8')
  await writeFile(
    importCollisionSchemaPath,
    `${importCollisionSchema}
create type public.collision_params as enum ('one');
`
  )
  await writeFile(
    join(importCollisionRoot, 'queries/collision.typed.sql'),
    "select 'one'::public.collision_params as value\n"
  )
  await assert.rejects(
    generateTypedSql({
      include: ['queries'],
      rootDir: importCollisionRoot,
      schema: 'schema.sql',
    }),
    /generated TypeScript binding CollisionParams for catalog type import collides with parameter interface/u
  )
})

test('rejects nullable column assertions because PostgreSQL determines result nullability', async () => {
  const root = await copyFixture()
  await writeFile(
    join(root, 'queries/invalid-column-nullability.typed.sql'),
    '-- @column id bigint?\nselect id from public.accounts\n'
  )

  await assert.rejects(
    generateTypedSql({
      include: ['queries'],
      rootDir: root,
      schema: 'schema.sql',
    }),
    /queries\/invalid-column-nullability\.typed\.sql:1: @column does not support \?; PostgreSQL determines result nullability/u
  )
})

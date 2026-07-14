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
  assert.match(account, /readonly displayName: string \| null/u)
  assert.match(account, /readonly status: AccountStatus/u)
  assert.match(account, /readonly role: AccountsRole/u)
  assert.match(account, /postgres-typed-sql\/runtime/u)

  const joined = await readFile(join(root, 'queries/list-accounts-with-posts.typed-sql.ts'), 'utf8')
  assert.match(joined, /readonly title: string \| null/u)
  assert.match(joined, /readonly publishedAt: PgTimestamptzString \| null/u)

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
  assert.match(output, /parameterNames: \['label', 'accountId'\]/u)
  assert.match(output, /readonly label: string/u)
  assert.match(output, /readonly accountId: PgInt8String/u)
  assert.match(output, /name: 'label',[\s\S]*?pgType: 'text'/u)
  assert.match(output, /name: 'account_id',[\s\S]*?pgType: 'bigint'/u)
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

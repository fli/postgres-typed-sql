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
  assert.match(account, /@fli\/postgres-typed-sql\/runtime/u)

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

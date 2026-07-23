import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { createMinimalFixture, generateTypedSql } from './generator-test-support.js'

test('uses valid TypeScript filename basenames verbatim as statement names', async () => {
  const root = await createMinimalFixture('select 1;\n', 'select 1::integer as value\n')
  const cases = [
    { name: 'getURL', typeName: 'GetURL' },
    { name: 'find_account', typeName: 'FindAccount' },
    { name: 'FindAccount', typeName: 'FindAccount' },
    { name: '$query', typeName: '$query' },
    { name: '_query', typeName: 'Query' },
  ] as const
  await Promise.all(
    cases.map(({ name }) => writeFile(join(root, 'queries', `${name}.typed.sql`), 'select 1::integer as value\n'))
  )

  const result = await generateTypedSql({
    include: ['queries'],
    rootDir: root,
    codecProfile: 'node-postgres',
    schema: 'schema.sql',
  })

  assert.equal(result.statementCount, cases.length + 1)
  for (const { name, typeName } of cases) {
    const output = await readFile(join(root, 'queries', `${name}.typed-sql.ts`), 'utf8')
    assert.ok(output.includes(`export type ${typeName}Params =`))
    assert.ok(output.includes(`export interface ${typeName}Row {`))
    assert.ok(output.includes(`export const ${name} =`))
    assert.ok(output.includes(`name: '${name}'`))
  }
})

test('allows matching statement basenames in separate module directories', async () => {
  const root = await createMinimalFixture('select 1;\n', 'select 1::integer as value\n')
  await mkdir(join(root, 'queries/accounts'))
  await mkdir(join(root, 'queries/orders'))
  await writeFile(join(root, 'queries/accounts/findById.typed.sql'), 'select 1::integer as account_id\n')
  await writeFile(join(root, 'queries/orders/findById.typed.sql'), 'select 2::integer as order_id\n')

  const result = await generateTypedSql({
    include: ['queries'],
    rootDir: root,
    codecProfile: 'node-postgres',
    schema: 'schema.sql',
  })

  assert.equal(result.statementCount, 3)
  const account = await readFile(join(root, 'queries/accounts/findById.typed-sql.ts'), 'utf8')
  const order = await readFile(join(root, 'queries/orders/findById.typed-sql.ts'), 'utf8')
  assert.match(account, /export const findById =/u)
  assert.match(account, /readonly account_id: number/u)
  assert.match(order, /export const findById =/u)
  assert.match(order, /readonly order_id: number/u)
})

test('validates typed SQL source contracts before initializing PostgreSQL analysis', async () => {
  const root = await createMinimalFixture('this is not valid SQL\n', 'select 1\n')
  await writeFile(join(root, 'queries/find-account.typed.sql'), 'select 1\n')

  await assert.rejects(
    generateTypedSql({
      include: ['queries'],
      rootDir: root,
      schema: 'schema.sql',
    }),
    /typed SQL filename: "find-account" is not a legal non-reserved TypeScript binding/u
  )
})

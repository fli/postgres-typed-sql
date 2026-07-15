import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import { generateTypedSql, postgresVersion } from 'postgres-typed-sql'

assert.equal(postgresVersion, '18.3')
const result = await generateTypedSql({
  include: ['.'],
  rootDir: process.cwd(),
  scalarProfile: 'node-postgres',
  schema: 'schema.sql',
})
assert.equal(result.statementCount, 2)

const output = await readFile('find-widget.typed-sql.ts', 'utf8')
assert.match(output, /cardinality: 'optional'/u)
assert.match(output, /readonly label: string \| null/u)
assert.match(output, /readonly state: Audit_WidgetState/u)
assert.match(output, /readonly metrics: PgArray<number>/u)
assert.match(output, /readonly search_document: string/u)
assert.match(output, /readonly URL: string/u)
assert.match(output, /readonly count: number/u)
assert.doesNotMatch(output, /import type \{ URL \}/u)

const conservativeResult = await generateTypedSql({
  include: ['.'],
  rootDir: process.cwd(),
  schema: 'schema.sql',
})
assert.equal(conservativeResult.statementCount, 2)

const conservativeInsert = await readFile('insert-widget.typed-sql.ts', 'utf8')
assert.match(conservativeInsert, /readonly code: NonNullable<unknown>/u)
assert.match(conservativeInsert, /readonly label: NonNullable<unknown> \| null/u)

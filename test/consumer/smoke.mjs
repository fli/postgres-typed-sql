import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import { generateTypedSql, postgresVersion } from 'postgres-typed-sql'

assert.equal(postgresVersion, '18.3')
const result = await generateTypedSql({
  include: ['.'],
  rootDir: process.cwd(),
  schema: 'schema.sql',
})
assert.equal(result.statementCount, 1)

const output = await readFile('find-widget.typed-sql.ts', 'utf8')
assert.match(output, /cardinality: 'optional'/u)
assert.match(output, /readonly label: string \| null/u)
assert.match(output, /readonly state: AuditWidgetState/u)
assert.match(output, /readonly URL: string/u)
assert.doesNotMatch(output, /import type \{ URL \}/u)

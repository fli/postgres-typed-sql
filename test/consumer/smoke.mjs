import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import { generateTypedSql, generationAnalysisVersion, postgresVersion } from 'postgres-typed-sql'
import { executeTypedSqlOptional } from 'postgres-typed-sql/adapters/node-postgres'

assert.equal(postgresVersion, '18.3')
assert.equal(typeof executeTypedSqlOptional, 'function')
const result = await generateTypedSql(
  {
    include: ['.'],
    imports: {
      runtime: 'postgres-typed-sql/runtime',
      scalars: 'postgres-typed-sql/scalars',
    },
    naming: {
      resultColumns: 'camelCase',
      structuredJsonFields: 'camelCase',
    },
    rootDir: process.cwd(),
    codecProfile: 'node-postgres',
    schema: 'schema.sql',
  },
  { analysis: true }
)
assert.equal(result.statementCount, 3)
assert.equal(result.analysis.version, generationAnalysisVersion)
assert.equal(result.analysis.statements.length, 3)
assert.equal(result.analysis.producer.name, 'postgres-typed-sql')
for (const input of result.analysis.inputs) {
  assert.equal(
    input.sha256,
    createHash('sha256')
      .update(await readFile(input.path))
      .digest('hex')
  )
}
const insertAnalysis = result.analysis.statements.find((entry) => entry.export === 'insertWidget')
assert.deepEqual(insertAnalysis.accessEvidence, {
  concerns: [{ kind: 'definiteDml', command: 'INSERT' }, { kind: 'volatileExecution' }],
})
assert.equal(insertAnalysis.sqlSha256, createHash('sha256').update(insertAnalysis.sql).digest('hex'))
assert.equal(insertAnalysis.access, 'write')
assert.equal(insertAnalysis.parameters.find((parameter) => parameter.name === 'code').nullBinding, 'nonNull')
assert.deepEqual(
  insertAnalysis.parameters.find((parameter) => parameter.name === 'widget_label'),
  {
    name: 'widget_label',
    propertyName: 'widgetLabel',
    nullBinding: 'provedNullable',
    nullAdmission: 'accepts',
  }
)

const output = await readFile('findWidget.typed-sql.ts', 'utf8')
assert.match(output, /cardinality: 'optional'/u)
assert.match(output, /readonly label: string \| null/u)
assert.match(output, /readonly state: "active" \| "archived"/u)
assert.match(output, /readonly metrics: PgArray<number>/u)
assert.match(output, /readonly searchDocument: string/u)
assert.match(output, /readonly detailsJson:/u)
assert.match(output, /readonly URL: string/u)
assert.match(output, /readonly displayName: string \| null/u)
assert.match(output, /readonly count: number/u)
assert.doesNotMatch(output, /import type \{ URL \}/u)

const echoBytes = await readFile('echoBytes.typed-sql.ts', 'utf8')
assert.match(echoBytes, /import type \{ PgArray, PgArrayParameter, PgByteaHexString \}/u)
assert.match(echoBytes, /readonly payloads: PgArrayParameter<PgByteaHexString> \| string/u)
assert.match(echoBytes, /readonly payloads: PgArray<Uint8Array> \| null/u)

const conservativeResult = await generateTypedSql({
  include: ['.'],
  imports: {
    runtime: 'postgres-typed-sql/runtime',
    scalars: 'postgres-typed-sql/scalars',
  },
  rootDir: process.cwd(),
  schema: 'schema.sql',
})
assert.equal(conservativeResult.statementCount, 3)
assert.equal(Object.hasOwn(conservativeResult, 'analysis'), false)

const conservativeInsert = await readFile('insertWidget.typed-sql.ts', 'utf8')
assert.match(conservativeInsert, /readonly code: NonNullable<unknown>/u)
assert.match(conservativeInsert, /readonly widgetLabel: NonNullable<unknown> \| null/u)

await generateTypedSql({
  include: ['.'],
  imports: {
    runtime: 'postgres-typed-sql/runtime',
    scalars: 'postgres-typed-sql/scalars',
  },
  naming: {
    resultColumns: 'camelCase',
    structuredJsonFields: 'camelCase',
  },
  rootDir: process.cwd(),
  codecProfile: 'node-postgres',
  schema: 'schema.sql',
})

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import { generateTypedSql, generationAnalysisVersion, postgresVersion } from 'postgres-typed-sql'
import { nodePostgres } from 'postgres-typed-sql/adapters/node-postgres'
import { decimal } from 'postgres-typed-sql/values'

assert.equal(postgresVersion, '18.3')
assert.equal(typeof nodePostgres, 'function')
assert.equal(decimal('1.20').coefficient, 120n)
const result = await generateTypedSql(
  {
    include: ['.'],
    imports: {
      runtime: './runtime-facade.mjs',
      scalars: 'postgres-typed-sql/values',
    },
    naming: {
      resultColumns: 'camelCase',
      structuredJsonFields: 'camelCase',
    },
    rootDir: process.cwd(),
    schema: 'schema.sql',
  },
  { analysis: true }
)
assert.equal(result.statementCount, 6)
assert.equal(result.analysis.version, generationAnalysisVersion)
assert.equal(result.analysis.statements.length, 6)
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
assert.match(output, /resultKind: 'optional'/u)
assert.match(output, /pgTypeName: 'widget_state'/u)
assert.match(output, /pgTypeSchema: 'audit'/u)
assert.doesNotMatch(output, /"pgTypeOid":(?!0(?:[,}]))\d+/u)
assert.match(output, /readonly label: string \| null/u)
assert.match(output, /readonly state: "active" \| "archived"/u)
assert.match(output, /readonly metrics: PgArray<PgDecimal \| null>/u)
assert.match(output, /readonly searchDocument: PgRawValue/u)
assert.match(output, /readonly detailsJson:/u)
assert.match(output, /readonly URL: string/u)
assert.match(output, /readonly displayName: string \| null/u)
assert.match(output, /readonly count: number/u)
assert.doesNotMatch(output, /import type \{ URL \}/u)

const echoBytes = await readFile('echoBytes.typed-sql.ts', 'utf8')
assert.match(echoBytes, /PgArrayInput/u)
assert.match(echoBytes, /readonly payloads: PgArrayInput<Uint8Array \| null>/u)
assert.match(echoBytes, /readonly payloads: PgArray<Uint8Array \| null> \| null/u)

const defaultResult = await generateTypedSql({
  include: ['.'],
  imports: {
    runtime: './runtime-facade.mjs',
  },
  rootDir: process.cwd(),
  schema: 'schema.sql',
})
assert.equal(defaultResult.statementCount, 6)
assert.equal(Object.hasOwn(defaultResult, 'analysis'), false)

const defaultInsert = await readFile('insertWidget.typed-sql.ts', 'utf8')
assert.match(defaultInsert, /readonly code: string/u)
assert.match(defaultInsert, /readonly widgetLabel: string \| null/u)

await generateTypedSql({
  include: ['.'],
  imports: {
    runtime: './runtime-facade.mjs',
    scalars: 'postgres-typed-sql/values',
  },
  naming: {
    resultColumns: 'camelCase',
    structuredJsonFields: 'camelCase',
  },
  rootDir: process.cwd(),
  schema: 'schema.sql',
})

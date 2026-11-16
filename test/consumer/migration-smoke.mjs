import assert from 'node:assert/strict'
import { writeFile, unlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { findPgJsonUnknownFlows } from 'postgres-typed-sql/migration'

const { default: ts } = await import(pathToFileURL(process.argv[2]).href)
const file = resolve('migration-fixture.mts')
await writeFile(
  file,
  `
type Document = import('postgres-typed-sql/values').PgJson<{ id: bigint }>
declare const document: Document
declare function parse(value: unknown): void
parse(document)
parse(document.value)
`
)
try {
  const program = ts.createProgram([file], {
    strict: true,
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.NodeNext,
    skipLibCheck: true,
  })
  assert.deepEqual(ts.getPreEmitDiagnostics(program), [])
  const diagnostics = findPgJsonUnknownFlows(ts, program)
  assert.equal(diagnostics.length, 1)
  assert.equal(diagnostics[0].code, 95001)
  assert.equal(
    diagnostics[0].file.text.slice(diagnostics[0].start, diagnostics[0].start + diagnostics[0].length),
    'document'
  )
} finally {
  await unlink(file)
}

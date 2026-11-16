import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import ts from 'typescript'
import { findPgJsonUnknownFlows } from '../src/migration.js'

test('finds visible PgJson flows into unknown inputs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pgjson-migration-'))
  try {
    const file = join(dir, 'fixture.ts')
    mkdirSync(join(dir, 'node_modules'))
    symlinkSync(resolve('.'), join(dir, 'node_modules/postgres-typed-sql'), 'dir')
    writeFileSync(
      join(dir, 'value-types.ts'),
      `declare const brand: unique symbol
      export interface PgJson<T> { readonly [brand]: true; readonly value: T }`
    )
    writeFileSync(
      file,
      `
import type { PgJson } from 'postgres-typed-sql/values'
declare const doc: PgJson<{ name: string }>
declare const nullable: PgJson | null
declare const erased: unknown
declare function parse(x: unknown): void
declare function object(x: { payload: unknown }): void
declare function list(x: { payload: unknown }[]): void
declare function forward(x: PgJson<{ name: string }>): void
parse(doc)
parse(nullable)
object({ payload: doc })
const input = { payload: doc }
object(input)
object({ ...input })
object({ ...input, payload: 'safe' })
object({ ...{ payload: 'safe' }, ...input })
list([{ payload: doc }])
parse(doc.value)
parse(erased)
forward(doc)
parse({ kind: 'document', value: {} })
import type { PgJson as OtherJson } from './value-types.js'
declare const other: OtherJson<string>
parse(other)
`
    )
    const program = ts.createProgram([file], {
      strict: true,
      target: ts.ScriptTarget.ES2023,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      skipLibCheck: true,
    })
    const errors = ts
      .getPreEmitDiagnostics(program)
      .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)
    assert.deepEqual(
      errors.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')),
      []
    )
    const findings = findPgJsonUnknownFlows(ts, program)
    assert.deepEqual(
      findings.map((finding) => {
        assert.ok(finding.file && finding.start !== undefined && finding.length !== undefined)
        return finding.file.text.slice(finding.start, finding.start + finding.length)
      }),
      [
        'doc',
        'nullable',
        '{ payload: doc }',
        'input',
        '{ ...input }',
        "{ ...{ payload: 'safe' }, ...input }",
        '[{ payload: doc }]',
      ]
    )
    assert.deepEqual(
      findings.map((finding) => {
        assert.ok(finding.file && finding.start !== undefined)
        return [finding.file.getLineAndCharacterOfPosition(finding.start).line + 1, finding.messageText]
      }),
      [
        [10, 'PgJson flows into unknown at argument 1. Review whether to pass .value instead.'],
        [11, 'PgJson flows into unknown at argument 1. Review whether to pass .value instead.'],
        [12, 'PgJson flows into unknown at argument 1.payload. Review whether to pass .value instead.'],
        [14, 'PgJson flows into unknown at argument 1.payload. Review whether to pass .value instead.'],
        [15, 'PgJson flows into unknown at argument 1.payload. Review whether to pass .value instead.'],
        [17, 'PgJson flows into unknown at argument 1.payload. Review whether to pass .value instead.'],
        [18, 'PgJson flows into unknown at argument 1[].payload. Review whether to pass .value instead.'],
      ]
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('recognizes import-type aliases and constructor boundaries from package declarations', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pgjson-import-type-'))
  try {
    mkdirSync(join(dir, 'node_modules'))
    symlinkSync(resolve('.'), join(dir, 'node_modules/postgres-typed-sql'), 'dir')
    const file = join(dir, 'fixture.mts')
    writeFileSync(
      file,
      `
type Document = import('postgres-typed-sql/values').PgJson<{ id: bigint }>
declare const row: { metadata: Document | null }
declare function parse(value: unknown): void
declare class Validator { constructor(value: unknown) }
parse(row.metadata)
new Validator(row.metadata)
parse(row.metadata?.value)
`
    )
    const program = ts.createProgram([file], {
      strict: true,
      target: ts.ScriptTarget.ES2023,
      module: ts.ModuleKind.NodeNext,
      skipLibCheck: true,
    })
    assert.deepEqual(
      ts.getPreEmitDiagnostics(program).map((item) => ts.flattenDiagnosticMessageText(item.messageText, '\n')),
      []
    )
    const findings = findPgJsonUnknownFlows(ts, program)
    assert.equal(findings.length, 2)
    for (const finding of findings) {
      assert.ok(finding.file && finding.start !== undefined && finding.length !== undefined)
      assert.equal(finding.file.text.slice(finding.start, finding.start + finding.length), 'row.metadata')
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

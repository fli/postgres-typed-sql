// Isolated example of the consumer-owned boundary; uses only public package exports.
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import type { TypedSqlGenerationAnalysis } from '../src/index.js'

export interface PolicyManifest {
  readonly schemaVersion: 1
  readonly generation: TypedSqlGenerationAnalysis
  /** Captured by the consumer before loading the generator configuration. */
  readonly configurationInputs: readonly { readonly path: string; readonly sha256: string }[]
}

interface ParsedStatement {
  readonly module: string
  readonly export: string
  readonly text: string
  readonly access: string
}

const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const identity = (entry: { module: string; export: string }) => JSON.stringify([entry.module, entry.export])

/** Validate before attaching any facts to independently parsed statements. */
export async function validatePolicyManifest(
  manifest: PolicyManifest,
  sqlInventory: readonly string[],
  parsedStatements: readonly ParsedStatement[],
  supportedProducers: readonly string[]
): Promise<void> {
  const report = manifest.generation
  if (
    manifest.schemaVersion !== 1 ||
    report.version !== 1 ||
    report.producer.name !== 'postgres-typed-sql' ||
    !supportedProducers.includes(report.producer.version) ||
    Math.floor(report.postgresVersionNum / 10000) !== 18
  ) {
    throw new Error('Incompatible policy facts')
  }
  if (!manifest.configurationInputs.length || !report.inputs.some((entry) => entry.role === 'schema')) {
    throw new Error('Missing input provenance')
  }
  const inputIdentities = new Set<string>()
  for (const input of report.inputs) {
    const key = JSON.stringify([input.role, input.path])
    if (!['sql', 'schema'].includes(input.role) || inputIdentities.has(key)) {
      throw new Error('Invalid or duplicate input')
    }
    inputIdentities.add(key)
  }
  for (const input of [...report.inputs, ...manifest.configurationInputs]) {
    if (hash(await readFile(input.path)) !== input.sha256) throw new Error('Stale input')
  }
  const sqlInputs = report.inputs
    .filter((entry) => entry.role === 'sql')
    .map((entry) => entry.path)
    .toSorted()
  if (JSON.stringify(sqlInputs) !== JSON.stringify([...sqlInventory].toSorted())) throw new Error('Stale SQL inventory')
  if (report.statements.length !== sqlInputs.length || report.statements.length !== parsedStatements.length) {
    throw new Error('Incomplete statements')
  }
  const byIdentity = new Map(parsedStatements.map((entry) => [identity(entry), entry]))
  if (byIdentity.size !== parsedStatements.length) throw new Error('Duplicate parsed statement')
  const coveredSources = new Set<string>()
  for (const entry of report.statements) {
    const parsed = byIdentity.get(identity(entry))
    if (
      !parsed ||
      parsed.text !== entry.sql ||
      hash(parsed.text) !== entry.sqlSha256 ||
      parsed.access !== entry.access
    ) {
      throw new Error('Stale generated statement')
    }
    if (!sqlInputs.includes(entry.source) || coveredSources.has(entry.source))
      throw new Error('Invalid statement source')
    coveredSources.add(entry.source)
    byIdentity.delete(identity(entry))
    const { concerns } = entry.accessEvidence
    if (!['read', 'write'].includes(entry.access) || !Array.isArray(concerns)) {
      throw new Error('Invalid access evidence')
    }
    if (
      (concerns.length > 0 && entry.access !== 'write') ||
      concerns.some((reason) =>
        reason.kind === 'definiteDml'
          ? !['DELETE', 'INSERT', 'MERGE', 'UPDATE'].includes(reason.command)
          : !['dataModifyingCte', 'rowLock', 'volatileExecution', 'procedureCall'].includes(reason.kind)
      )
    ) {
      throw new Error('Invalid access evidence')
    }
  }
  if (byIdentity.size || coveredSources.size !== sqlInputs.length) throw new Error('Incomplete coverage')
}

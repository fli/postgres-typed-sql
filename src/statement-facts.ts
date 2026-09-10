import type { TypedSqlPostgresIr } from './analyzer-ir-model.js'
import type { ResolvedPostgresTypedSqlConfig } from './config.js'
import { readFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { relative, resolve, isAbsolute } from 'node:path'

export interface StatementFactsInput {
  readonly path: string
  readonly role: 'sql' | 'schema' | 'configuration'
  readonly sha256: string
}
export interface StatementFactsStatement
  extends Pick<
    TypedSqlPostgresIr,
    'analyzerSchemaVersion' | 'postgresVersionNum' | 'command' | 'accessEvidence' | 'rowBounds' | 'resultColumns'
  > {
  readonly module: string
  readonly export: string
  readonly source: string
  readonly sqlSha256: string
  readonly access: 'read' | 'write'
}
/** Paths are relative to generator rootDir. Consumers must reject incompatible versions,
 * changed/missing input hashes, SQL inventory changes, and generated SQL hash mismatches.
 * Unknown bounds stay null; expressionSource describes the immediate expression only.
 */
export interface StatementFactsManifest {
  readonly schemaVersion: 1
  readonly producer: { readonly name: 'postgres-typed-sql'; readonly version: string; readonly factsRevision: 1 }
  readonly include: readonly string[]
  readonly inputs: readonly StatementFactsInput[]
  readonly statements: readonly StatementFactsStatement[]
}

export type StatementFactsAnalysis = Omit<StatementFactsStatement, 'module' | 'export' | 'source' | 'sqlSha256'>
interface SourceInput {
  readonly sourcePath: string
  readonly outputPath: string
  readonly sourceSha256: string
}
interface ResolvedStatement extends SourceInput {
  readonly name: string
  readonly sql: string
  readonly statementFacts: StatementFactsAnalysis
}
function packageVersion(): string {
  let directory = new URL('.', import.meta.url)
  while (true) {
    const manifest = new URL('package.json', directory)
    if (existsSync(manifest)) {
      const value = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string; version?: string }
      if (value.name === 'postgres-typed-sql' && value.version) return value.version
    }
    const parent = new URL('../', directory)
    if (parent.href === directory.href) throw new Error('Cannot find postgres-typed-sql package identity.')
    directory = parent
  }
}
const producerVersion = packageVersion()

export const statementFactsSchemaVersion = 1
export function statementFactsSha256(contents: string | Uint8Array): string {
  return createHash('sha256').update(contents).digest('hex')
}
function relativePath(root: string, path: string): string {
  const value = relative(root, resolve(root, path)).replaceAll('\\', '/')
  if (!value || value === '..' || value.startsWith('../') || isAbsolute(value)) {
    throw new Error(`Statement facts input must be inside rootDir: ${path}`)
  }
  return value
}
export async function snapshotStatementFactsInputs(
  config: ResolvedPostgresTypedSqlConfig,
  configs: readonly SourceInput[]
): Promise<StatementFactsInput[] | undefined> {
  if (!config.statementFacts) return undefined
  const output = resolve(config.statementFacts.output)
  relativePath(config.rootDir, output)
  if (
    !output.endsWith('.json') ||
    output === resolve(config.typesOutput) ||
    configs.some((entry) => output === resolve(entry.outputPath))
  ) {
    throw new Error('Statement facts output must be a separate JSON file.')
  }
  const roles = new Map<string, StatementFactsInput['role']>()
  for (const path of config.statementFacts.configurationFiles) roles.set(path, 'configuration')
  for (const path of config.schemaFiles) roles.set(path, 'schema')
  for (const entry of configs) roles.set(entry.sourcePath, 'sql')
  if ([...roles.keys()].some((path) => resolve(path) === output)) {
    throw new Error('Statement facts output overlaps a generation input.')
  }
  const inputs = await Promise.all(
    [...roles].map(async ([path, role]) => ({
      path: relativePath(config.rootDir, path),
      role,
      sha256: statementFactsSha256(await readFile(path)),
    }))
  )
  for (const entry of configs) {
    const input = inputs.find((input) => input.path === relativePath(config.rootDir, entry.sourcePath))
    if (input?.sha256 !== entry.sourceSha256) {
      throw new Error('SQL source changed during generation; rerun generation.')
    }
  }
  return inputs.sort((a, b) => a.path.localeCompare(b.path, 'en'))
}
export async function buildStatementFacts(
  config: ResolvedPostgresTypedSqlConfig,
  configs: readonly ResolvedStatement[],
  inputs: readonly StatementFactsInput[] | undefined
): Promise<StatementFactsManifest | undefined> {
  if (!inputs) return undefined
  const after = await snapshotStatementFactsInputs(config, configs)
  if (JSON.stringify(inputs) !== JSON.stringify(after)) {
    throw new Error('Statement facts inputs changed during generation; rerun generation.')
  }
  const manifest: StatementFactsManifest = {
    schemaVersion: statementFactsSchemaVersion,
    producer: { name: 'postgres-typed-sql', version: producerVersion, factsRevision: 1 },
    include: config.include.map((path) => relative(config.rootDir, path).replaceAll('\\', '/') || '.'),
    inputs,
    statements: configs.map((entry) => ({
      module: relativePath(config.rootDir, entry.outputPath),
      export: entry.name,
      source: relativePath(config.rootDir, entry.sourcePath),
      sqlSha256: statementFactsSha256(entry.sql),
      ...entry.statementFacts,
    })),
  }
  return JSON.parse(JSON.stringify(manifest)) as StatementFactsManifest
}

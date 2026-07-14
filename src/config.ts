import { isAbsolute, resolve } from 'node:path'

import type { SupportedExtension } from './engine.js'
import { defaultPostgresScalarProfile, type PostgresScalarProfile } from './postgres-types.js'

export interface PostgresTypedSqlConfig {
  /** Directories recursively searched for *.typed.sql files. Defaults to rootDir. */
  readonly include?: readonly string[]
  /** Import specifier written into generated files. */
  readonly packageImport?: string
  /** Project directory used to resolve every relative path. Defaults to process.cwd(). */
  readonly rootDir?: string
  /** Ordered SQL files used to construct the analysis schema. */
  readonly schema: string | readonly string[]
  /** Driver scalar behavior used for generated parameter/result types. Defaults to conservative unknown values. */
  readonly scalarProfile?: PostgresScalarProfile
  /** PostgreSQL extensions that must exist before loading the schema. */
  readonly extensions?: readonly SupportedExtension[]
  /** Generated catalog types file. Defaults to postgres-typed-sql.types.ts in rootDir. */
  readonly typesOutput?: string
}

export interface ResolvedPostgresTypedSqlConfig {
  readonly extensions: readonly SupportedExtension[]
  readonly include: readonly string[]
  readonly packageImport: string
  readonly rootDir: string
  readonly scalarProfile: PostgresScalarProfile
  readonly schemaFiles: readonly string[]
  readonly typesOutput: string
}

export function defineConfig(config: PostgresTypedSqlConfig): PostgresTypedSqlConfig {
  return config
}

function fromRoot(rootDir: string, value: string): string {
  return isAbsolute(value) ? value : resolve(rootDir, value)
}

export function resolveConfig(config: PostgresTypedSqlConfig): ResolvedPostgresTypedSqlConfig {
  const rootDir = resolve(config.rootDir ?? process.cwd())
  const schema = typeof config.schema === 'string' ? [config.schema] : config.schema
  if (schema.length === 0) {
    throw new Error('The schema option must name at least one SQL file.')
  }
  const scalarProfile = config.scalarProfile ?? defaultPostgresScalarProfile
  if (scalarProfile !== 'conservative' && scalarProfile !== 'node-postgres') {
    throw new Error(`Unsupported scalar profile ${JSON.stringify(scalarProfile)}.`)
  }

  return {
    extensions: config.extensions ?? [],
    include: (config.include ?? ['.']).map((entry) => fromRoot(rootDir, entry)),
    packageImport: config.packageImport ?? 'postgres-typed-sql',
    rootDir,
    scalarProfile,
    schemaFiles: schema.map((entry) => fromRoot(rootDir, entry)),
    typesOutput: fromRoot(rootDir, config.typesOutput ?? 'postgres-typed-sql.types.ts'),
  }
}

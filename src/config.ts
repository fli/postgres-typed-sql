import { isAbsolute, resolve } from 'node:path'

import {
  defaultPostgresCodecProfile,
  resolvePostgresCodecProfile,
  type PostgresCodecProfile,
  type ResolvedPostgresCodecProfile,
} from './postgres-codecs.js'
import type { SupportedExtension } from './engine.js'

export type PostgresTypedSqlPropertyNaming = 'camelCase' | 'preserve'

export interface PostgresTypedSqlNamingConfig {
  /** Naming convention for top-level result-row properties. Defaults to preserve. */
  readonly resultColumns?: PostgresTypedSqlPropertyNaming
  /** Naming convention for fields in statically modeled JSON results. Defaults to preserve. */
  readonly structuredJsonFields?: PostgresTypedSqlPropertyNaming
}

export interface PostgresTypedSqlImportsConfig {
  /** Exact module specifier for the generated-code runtime exporting createTypedSqlStatement. */
  readonly runtime: string
  /** Exact module specifier for PostgreSQL scalar type declarations used by generated code. */
  readonly scalars: string
}

export interface PostgresTypedSqlConfig {
  /** Driver codec behavior used for generated parameter, result, and JSON types. Defaults to conservative. */
  readonly codecProfile?: PostgresCodecProfile
  /** Directories recursively searched for *.typed.sql files. Defaults to rootDir. */
  readonly include?: readonly string[]
  /** Exact module specifiers written into generated TypeScript. */
  readonly imports: PostgresTypedSqlImportsConfig
  /** Naming conventions for generated result properties. */
  readonly naming?: PostgresTypedSqlNamingConfig
  /** Project directory used to resolve every relative path. Defaults to process.cwd(). */
  readonly rootDir?: string
  /** Ordered SQL files used to construct the analysis schema. */
  readonly schema: string | readonly string[]
  /** PostgreSQL extensions that must exist before loading the schema. */
  readonly extensions?: readonly SupportedExtension[]
  /** Generated catalog types file. Defaults to postgres-typed-sql.types.ts in rootDir. */
  readonly typesOutput?: string
}

export interface ResolvedPostgresTypedSqlNamingConfig {
  readonly resultColumns: PostgresTypedSqlPropertyNaming
  readonly structuredJsonFields: PostgresTypedSqlPropertyNaming
}

export interface ResolvedPostgresTypedSqlConfig {
  readonly codecProfile: ResolvedPostgresCodecProfile
  readonly extensions: readonly SupportedExtension[]
  readonly imports: PostgresTypedSqlImportsConfig
  readonly include: readonly string[]
  readonly naming: ResolvedPostgresTypedSqlNamingConfig
  readonly rootDir: string
  readonly schemaFiles: readonly string[]
  readonly typesOutput: string
}

export function defineConfig(config: PostgresTypedSqlConfig): PostgresTypedSqlConfig {
  return config
}

function fromRoot(rootDir: string, value: string): string {
  return isAbsolute(value) ? value : resolve(rootDir, value)
}

function requireModuleSpecifier(value: unknown, option: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${option} must be a non-empty module specifier.`)
  }
  return value
}

export function resolveConfig(config: PostgresTypedSqlConfig): ResolvedPostgresTypedSqlConfig {
  if (Object.hasOwn(config, 'packageImport')) {
    throw new Error('packageImport is no longer supported. Configure imports.runtime and imports.scalars explicitly.')
  }
  if (Object.hasOwn(config, 'scalarProfile')) {
    throw new Error('scalarProfile is no longer supported. Configure codecProfile instead.')
  }
  if (!config.imports || typeof config.imports !== 'object') {
    throw new Error('The imports option is required and must configure runtime and scalars.')
  }
  const rootDir = resolve(config.rootDir ?? process.cwd())
  const schema = typeof config.schema === 'string' ? [config.schema] : config.schema
  if (!schema || schema.length === 0) {
    throw new Error('The schema option must name at least one SQL file.')
  }
  const codecProfile = resolvePostgresCodecProfile(config.codecProfile ?? defaultPostgresCodecProfile)
  const resultColumns = config.naming?.resultColumns ?? 'preserve'
  if (resultColumns !== 'preserve' && resultColumns !== 'camelCase') {
    throw new Error(`Unsupported result-column naming ${JSON.stringify(resultColumns)}.`)
  }
  const structuredJsonFields = config.naming?.structuredJsonFields ?? 'preserve'
  if (structuredJsonFields !== 'preserve' && structuredJsonFields !== 'camelCase') {
    throw new Error(`Unsupported structured-JSON field naming ${JSON.stringify(structuredJsonFields)}.`)
  }

  return {
    codecProfile,
    extensions: config.extensions ?? [],
    imports: {
      runtime: requireModuleSpecifier(config.imports.runtime, 'imports.runtime'),
      scalars: requireModuleSpecifier(config.imports.scalars, 'imports.scalars'),
    },
    include: (config.include ?? ['.']).map((entry) => fromRoot(rootDir, entry)),
    naming: {
      resultColumns,
      structuredJsonFields,
    },
    rootDir,
    schemaFiles: schema.map((entry) => fromRoot(rootDir, entry)),
    typesOutput: fromRoot(rootDir, config.typesOutput ?? 'postgres-typed-sql.types.ts'),
  }
}

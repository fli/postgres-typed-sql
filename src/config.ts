import { isAbsolute, resolve } from 'node:path'

import type { SupportedExtension } from './engine.js'

export type PostgresTypedSqlPropertyNaming = 'camelCase' | 'preserve'

export interface PostgresTypedSqlNamingConfig {
  /** Naming convention for generated parameter-object properties. Defaults to camelCase. */
  readonly parameterProperties?: PostgresTypedSqlPropertyNaming
  /** Naming convention for top-level result-row properties. Defaults to preserve. */
  readonly resultColumns?: PostgresTypedSqlPropertyNaming
  /** Naming convention for fields in statically modeled JSON results. Defaults to preserve. */
  readonly structuredJsonFields?: PostgresTypedSqlPropertyNaming
}

export interface PostgresTypedSqlImportsConfig {
  /** Exact module specifier for the generated-code runtime exporting createTypedSqlStatement and createTypedSqlExecutor. */
  readonly runtime: string
  /** Exact module specifier for PostgreSQL scalar type declarations used by generated code. */
  readonly scalars: string
}

export type JsonbContractShape =
  | 'string'
  | 'boolean'
  | 'number'
  | 'int4'
  | 'json'
  | 'null'
  | { readonly object: Readonly<Record<string, JsonbContractField>> }
  | { readonly array: JsonbContractShape }
  | { readonly nullable: JsonbContractShape }
export type JsonbContractField = JsonbContractShape | { readonly optional: JsonbContractShape }
export interface JsonbFunctionContract {
  readonly schema: string
  readonly name: string
  readonly argumentTypes: readonly (string | { readonly schema: string; readonly name: string })[]
  readonly variants: Readonly<Record<string, Readonly<Record<string, JsonbContractField>>>>
  readonly allowJsonNull?: true
}

export interface PostgresTypedSqlConfig {
  /** Runtime-checked JSONB results for direct calls to specific PostgreSQL function overloads. */
  readonly jsonbFunctionContracts?: readonly JsonbFunctionContract[]
  /** Reuse catalog query results in a project session whose catalog and catalog name resolution are stable. */
  readonly assumeStableAnalysisCatalog?: boolean
  /** Directories recursively searched for *.typed.sql files. Defaults to rootDir. */
  readonly include?: readonly string[]
  /** Exact module specifiers written into generated TypeScript. */
  readonly imports?: Partial<PostgresTypedSqlImportsConfig>
  /** Naming conventions for generated TypeScript properties. */
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
  readonly parameterProperties: PostgresTypedSqlPropertyNaming
  readonly resultColumns: PostgresTypedSqlPropertyNaming
  readonly structuredJsonFields: PostgresTypedSqlPropertyNaming
}

export interface ResolvedPostgresTypedSqlConfig {
  readonly assumeStableAnalysisCatalog?: true
  readonly jsonbFunctionContracts: readonly JsonbFunctionContract[]
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
    throw new Error('scalarProfile is no longer supported. Generated values use the built-in lossless model.')
  }
  if (Object.hasOwn(config, 'codecProfile')) {
    throw new Error('codecProfile is no longer supported. Map the built-in lossless values in application code.')
  }
  const assumeStableAnalysisCatalog = config.assumeStableAnalysisCatalog
  if (assumeStableAnalysisCatalog !== undefined && typeof assumeStableAnalysisCatalog !== 'boolean') {
    throw new Error('assumeStableAnalysisCatalog must be a boolean.')
  }
  if (config.imports !== undefined && (!config.imports || typeof config.imports !== 'object')) {
    throw new Error('The imports option must configure runtime and scalars module specifiers.')
  }
  const rootDir = resolve(config.rootDir ?? process.cwd())
  const schema = typeof config.schema === 'string' ? [config.schema] : config.schema
  if (!schema || schema.length === 0) {
    throw new Error('The schema option must name at least one SQL file.')
  }
  const parameterProperties = config.naming?.parameterProperties ?? 'camelCase'
  if (parameterProperties !== 'preserve' && parameterProperties !== 'camelCase') {
    throw new Error(`Unsupported parameter-property naming ${JSON.stringify(parameterProperties)}.`)
  }
  const resultColumns = config.naming?.resultColumns ?? 'preserve'
  if (resultColumns !== 'preserve' && resultColumns !== 'camelCase') {
    throw new Error(`Unsupported result-column naming ${JSON.stringify(resultColumns)}.`)
  }
  const structuredJsonFields = config.naming?.structuredJsonFields ?? 'preserve'
  if (structuredJsonFields !== 'preserve' && structuredJsonFields !== 'camelCase') {
    throw new Error(`Unsupported structured-JSON field naming ${JSON.stringify(structuredJsonFields)}.`)
  }

  return {
    ...(assumeStableAnalysisCatalog ? { assumeStableAnalysisCatalog: true } : {}),
    jsonbFunctionContracts: parseContracts(config.jsonbFunctionContracts),
    extensions: config.extensions ?? [],
    imports: {
      runtime: requireModuleSpecifier(config.imports?.runtime ?? 'postgres-typed-sql/runtime', 'imports.runtime'),
      scalars: requireModuleSpecifier(config.imports?.scalars ?? 'postgres-typed-sql/values', 'imports.scalars'),
    },
    include: (config.include ?? ['.']).map((entry) => fromRoot(rootDir, entry)),
    naming: {
      parameterProperties,
      resultColumns,
      structuredJsonFields,
    },
    rootDir,
    schemaFiles: schema.map((entry) => fromRoot(rootDir, entry)),
    typesOutput: fromRoot(rootDir, config.typesOutput ?? 'postgres-typed-sql.types.ts'),
  }
}

function contractRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected an object in jsonbFunctionContracts.')
  const prototype: unknown = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null)
    throw new Error('Expected a plain object in jsonbFunctionContracts.')
  return value as Record<string, unknown>
}

function contractIdentifier(value: unknown): string {
  if (typeof value !== 'string' || !value.length || value.includes('\0'))
    throw new Error('Invalid PostgreSQL name in jsonbFunctionContracts.')
  return value
}

function contractShape(value: unknown, depth: number): JsonbContractShape {
  if (depth > 100) throw new Error('JSONB contract is too deeply nested.')
  switch (value) {
    case 'string':
    case 'boolean':
    case 'number':
    case 'int4':
    case 'json':
    case 'null':
      return value
  }
  const record = contractRecord(value)
  const keys = Object.keys(record)
  if (keys.length === 1) {
    switch (keys[0]) {
      case 'object':
        return { object: contractFields(record.object, depth + 1) }
      case 'array':
        return { array: contractShape(record.array, depth + 1) }
      case 'nullable':
        return { nullable: contractShape(record.nullable, depth + 1) }
    }
  }
  throw new Error('Invalid JSONB contract shape.')
}

function contractFields(value: unknown, depth: number): Readonly<Record<string, JsonbContractField>> {
  return Object.fromEntries(
    Object.entries(contractRecord(value)).map(([key, entry]) => {
      if (entry && typeof entry === 'object') {
        const record = contractRecord(entry)
        if (Object.keys(record).length === 1 && Object.hasOwn(record, 'optional'))
          return [key, { optional: contractShape(record.optional, depth) }]
      }
      return [key, contractShape(entry, depth)]
    })
  )
}

function parseContracts(input: unknown): readonly JsonbFunctionContract[] {
  if (input === undefined) return []
  if (!Array.isArray(input)) throw new Error('jsonbFunctionContracts must be an array.')
  return Array.from(input, (entry: unknown) => {
    const contract = contractRecord(entry)
    const schema = contractIdentifier(contract.schema)
    const name = contractIdentifier(contract.name)
    if (!Array.isArray(contract.argumentTypes)) throw new Error('Invalid JSONB contract argumentTypes.')
    const argumentTypes = Array.from(contract.argumentTypes, (value: unknown) => {
      if (typeof value === 'string') return contractIdentifier(value)
      const type = contractRecord(value)
      return { schema: contractIdentifier(type.schema), name: contractIdentifier(type.name) }
    })
    if (contract.allowJsonNull !== undefined && contract.allowJsonNull !== true)
      throw new Error('allowJsonNull must be true when present.')
    const entries = Object.entries(contractRecord(contract.variants))
    if (entries.length < 2) throw new Error('JSONB contract requires at least two variants.')
    const variants = Object.fromEntries(
      entries.map(([tag, fields]) => {
        const parsed = contractFields(fields, 0)
        if (Object.hasOwn(parsed, 'kind')) throw new Error('JSONB contract variant cannot declare kind.')
        return [tag, parsed]
      })
    )
    return { schema, name, argumentTypes, variants, allowJsonNull: contract.allowJsonNull }
  })
}

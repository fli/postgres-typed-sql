export { defineConfig, resolveConfig } from './config.js'
export type {
  PostgresTypedSqlConfig,
  PostgresTypedSqlImportsConfig,
  PostgresTypedSqlNamingConfig,
  PostgresTypedSqlPropertyNaming,
  ResolvedPostgresTypedSqlConfig,
  ResolvedPostgresTypedSqlNamingConfig,
} from './config.js'
export { generateTypedSql } from './generator.js'
export type { GenerateTypedSqlResult } from './generator.js'
export { postgresVersion, supportedExtensions } from './engine.js'
export type { SupportedExtension } from './engine.js'
export type { PostgresScalarProfile } from './postgres-types.js'

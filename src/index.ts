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
export type { GenerateTypedSqlOptions, GenerateTypedSqlResult, GenerateTypedSqlAnalysisResult } from './generator.js'
export { generationAnalysisVersion } from './generation-analysis.js'
export type {
  TypedSqlAccessConcern,
  TypedSqlAccessEvidence,
  TypedSqlAnalysisInput,
  TypedSqlGenerationAnalysis,
  TypedSqlParameterAnalysis,
  TypedSqlStatementAnalysis,
} from './generation-analysis.js'
export { postgresVersion, supportedExtensions } from './engine.js'
export type { SupportedExtension } from './engine.js'
export type { PostgresTypeFact, PostgresTypeKind } from './postgres-types.js'

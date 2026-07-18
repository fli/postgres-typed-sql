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
export {
  defaultPostgresCodecProfile,
  definePostgresCodecProfile,
  postgresResultTypesByOid,
  postgresTypeScriptType,
  resolvePostgresCodecProfile,
} from './postgres-codecs.js'
export type {
  BuiltInPostgresCodecProfile,
  PostgresBooleanFallback,
  PostgresCodecProfile,
  PostgresCodecProfileDefinition,
  PostgresCodecTypePosition,
  PostgresJsonScalarTypeContext,
  PostgresParameterTypeContext,
  PostgresResultTypeContext,
  PostgresStringLiteralRefinementContext,
  PostgresTypeScriptResolution,
  PostgresTypeScriptResolutionFallback,
  ResolvedPostgresCodecProfile,
} from './postgres-codecs.js'
export type { PostgresTypeFact, PostgresTypeKind } from './postgres-types.js'

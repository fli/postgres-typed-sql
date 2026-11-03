import type { TypedSqlAccessEvidence, TypedSqlParameterAnalysis } from './generation-analysis.js'
import type {
  TypedSqlAccessKind,
  TypedSqlColumnMetadata,
  TypedSqlCommandKind,
  TypedSqlParameterMetadata,
  TypedSqlResultKind,
  TypedSqlRowBounds,
} from './runtime.js'
import type { SupportedExtension } from './engine.js'

/** Version of the project analysis shape and its semantic guarantees. */
export const projectAnalysisVersion = 1 as const

export interface QueryDescriptor {
  readonly name: string
  readonly text: string
  readonly access: TypedSqlAccessKind
  readonly resultKind: TypedSqlResultKind
  readonly rowBounds: TypedSqlRowBounds
  readonly columns: readonly TypedSqlColumnMetadata[]
  readonly command: TypedSqlCommandKind
  readonly parameterNames: readonly string[]
  readonly parameters: readonly TypedSqlParameterMetadata[]
  readonly resultRowMapping: 'positional'
}

export interface QueryAnalysis {
  readonly source: string
  /** SHA-256 of the UTF-8 source buffer supplied to analysis. */
  readonly sourceSha256: string
  readonly exports: { readonly statement: string; readonly executor: 'default'; readonly types: readonly string[] }
  readonly sqlSha256: string
  readonly descriptor: QueryDescriptor
  readonly accessEvidence: TypedSqlAccessEvidence
  readonly parameters: readonly TypedSqlParameterAnalysis[]
  /** TypeScript module text for the source, never written by the session. */
  readonly moduleText: string
}

export interface ProjectInput {
  readonly path: string
  readonly sha256: string
  readonly role: 'config' | 'schema' | 'sql' | 'engine'
}

export interface ProjectAnalysis {
  readonly version: typeof projectAnalysisVersion
  readonly producer: { readonly name: 'postgres-typed-sql'; readonly version: string }
  readonly postgresVersionNum: number
  readonly configIdentity: string
  readonly rootDir: string
  readonly include: readonly string[]
  readonly extensions: readonly SupportedExtension[]
  readonly inputs: readonly ProjectInput[]
  readonly statements: readonly QueryAnalysis[]
}

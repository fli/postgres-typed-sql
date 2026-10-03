import type { SupportedExtension } from './engine.js'

/** Version of both the report shape and its semantic guarantees. */
export const generationAnalysisVersion = 1 as const

/** Positive evidence from the PostgreSQL access classifier; only the DML concerns prove DML. */
export type TypedSqlAccessConcern =
  | { readonly kind: 'definiteDml'; readonly command: 'DELETE' | 'INSERT' | 'MERGE' | 'UPDATE' }
  | { readonly kind: 'dataModifyingCte' }
  | { readonly kind: 'rowLock' }
  | { readonly kind: 'volatileExecution' }
  | { readonly kind: 'procedureCall' }

export interface TypedSqlAccessEvidence {
  /** Empty means no concerns detected, not proof of purity or absence of mutation/locking. */
  readonly concerns: readonly TypedSqlAccessConcern[]
}

export interface TypedSqlAnalysisInput {
  /** Absolute path used to read this input. */
  readonly path: string
  readonly role: 'schema' | 'sql'
  /** Lowercase SHA-256 of the original bytes consumed by generation. */
  readonly sha256: string
}

export interface TypedSqlStatementAnalysis {
  readonly source: string
  /** Absolute generated module path. Together with export, identifies the emitted statement. */
  readonly module: string
  readonly export: string
  /** Exact compiled SQL passed to PostgreSQL analysis and emitted as statement.text. */
  readonly sql: string
  /** Lowercase SHA-256 of the UTF-8 encoding of sql. */
  readonly sqlSha256: string
  /** Emitted access, including any conservative @access write override. */
  readonly access: 'read' | 'write'
  /** Independent of access overrides. Does not establish absence of mutation. */
  readonly accessEvidence: TypedSqlAccessEvidence
}

/** Complete report for one successful generation; never a partial stream of facts. */
export interface TypedSqlGenerationAnalysis {
  readonly version: typeof generationAnalysisVersion
  readonly producer: { readonly name: 'postgres-typed-sql'; readonly version: string }
  readonly postgresVersionNum: number
  readonly rootDir: string
  readonly include: readonly string[]
  readonly extensions: readonly SupportedExtension[]
  /** Schema inputs in execution order, then every discovered SQL source in statement order. */
  readonly inputs: readonly TypedSqlAnalysisInput[]
  /** Exactly one entry per generated statement, including when outputs did not change. */
  readonly statements: readonly TypedSqlStatementAnalysis[]
}

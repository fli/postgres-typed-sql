import runOneWidget, { type OneWidgetRow } from './oneWidget.typed-sql.js'
import runDeleteWidget from './deleteWidget.typed-sql.js'
import runCallWidget from './callWidget.typed-sql.js'
import { echoBytes } from './echoBytes.typed-sql.js'
import runFindWidget, { findWidget, type FindWidgetRow } from './findWidget.typed-sql.js'
import runInsertWidget, { insertWidget, type InsertWidgetRow } from './insertWidget.typed-sql.js'
import type { NodePostgresTypedSqlClient } from 'postgres-typed-sql/adapters/node-postgres'
import type { TypedSqlColumnMetadata } from 'postgres-typed-sql/runtime'
import type { PgArray, PgArrayParameter } from 'postgres-typed-sql/scalars'
import {
  generateTypedSql,
  generationAnalysisVersion,
  type GenerateTypedSqlAnalysisResult,
  type PostgresTypedSqlConfig,
  type TypedSqlAccessConcern,
  type TypedSqlGenerationAnalysis,
  type TypedSqlParameterAnalysis,
} from 'postgres-typed-sql'

declare const generatorConfig: PostgresTypedSqlConfig
const analysisResult: GenerateTypedSqlAnalysisResult = await generateTypedSql(generatorConfig, { analysis: true })
const analysis: TypedSqlGenerationAnalysis = analysisResult.analysis
const analysisVersion: 2 = generationAnalysisVersion
for (const statement of analysis.statements) {
  for (const parameter of statement.parameters) {
    const publicParameter: TypedSqlParameterAnalysis = parameter
    const binding: 'nonNull' | 'provedNullable' | 'callerNullable' = parameter.nullBinding
    const admission: 'accepts' | 'rejects' | 'unknown' = parameter.nullAdmission
    void publicParameter
    void binding
    void admission
  }
  for (const concern of statement.accessEvidence.concerns) {
    const publicConcern: TypedSqlAccessConcern = concern
    if (concern.kind === 'definiteDml') {
      const command: 'DELETE' | 'INSERT' | 'MERGE' | 'UPDATE' = concern.command
      void command
    }
    void publicConcern
  }
}
const optionalResult = await generateTypedSql(generatorConfig)
// @ts-expect-error Analysis must be requested or checked before it is consumed.
const requiredAnalysis: TypedSqlGenerationAnalysis = optionalResult.analysis
void requiredAnalysis
void analysisVersion

declare const client: NodePostgresTypedSqlClient

type IsExactly<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2 ? true : false
type AssertTrue<Value extends true> = Value
type PublicMetadataHasNoSource = AssertTrue<IsExactly<Extract<keyof TypedSqlColumnMetadata, 'source'>, never>>

const publicColumnMetadata: TypedSqlColumnMetadata = {
  expressionSource: { kind: 'expression', tag: 'Const' },
  name: 'value',
  nullable: false,
  pgType: 'integer',
  pgTypeName: 'int4',
  pgTypeSchema: 'pg_catalog',
  propertyName: 'value',
}
const publicMetadataHasNoSource: PublicMetadataHasNoSource = true

void publicColumnMetadata.expressionSource
void publicMetadataHasNoSource

const query = findWidget.query({ code: 'widget-code', metrics: [] })
const values: readonly unknown[] = query.values

void values
void client.query(query)

echoBytes.query({ payloads: [] })
echoBytes.query({ payloads: [null] })

// @ts-expect-error Top-level SQL NULL requires explicit caller permission.
echoBytes.query({ payloads: null })

findWidget.query({ code: 'widget-code', metrics: [] })
findWidget.query({ code: 'widget-code', metrics: [1, '2', 3n, null] })
findWidget.query({ code: 'widget-code', metrics: '{{1,2},{3,4}}' })

// @ts-expect-error Array element NULL does not make the top-level SQL parameter nullable.
findWidget.query({ code: 'widget-code', metrics: null })

const flatParameter: PgArrayParameter<number> = [1, null, 2]
const recursiveResult: PgArray<number> = [
  [1, null],
  [2, null],
]
void flatParameter
void recursiveResult

// @ts-expect-error Nested JavaScript arrays cannot prove rectangular PostgreSQL dimensions.
findWidget.query({ code: 'widget-code', metrics: [[1], [2, 3]] })

// @ts-expect-error SQL NULL array elements are accepted, but NULL subarrays are not representable.
findWidget.query({ code: 'widget-code', metrics: [[1], null] })

insertWidget.query({ code: 'widget-code', widgetLabel: null })

// @ts-expect-error PostgreSQL rejects SQL NULL for the NOT NULL code column.
insertWidget.query({ code: null, widgetLabel: null })

// @ts-expect-error SQL parameters do not accept JavaScript undefined.
insertWidget.query({ code: 'widget-code', widgetLabel: undefined })

const inferredFind = await runFindWidget(client, { code: 'widget-code', metrics: [] })
const inferredInsert = await runInsertWidget(client, { code: 'new-widget', widgetLabel: null })
const findType: IsExactly<typeof inferredFind, FindWidgetRow | null> = true
const insertType: IsExactly<typeof inferredInsert, InsertWidgetRow[]> = true
void inferredFind
void inferredInsert
void findType
void insertType
// @ts-expect-error The generated callable requires its parameter object.
await runFindWidget(client)
// @ts-expect-error Nullable properties remain required.
await runInsertWidget(client, { code: 'new-widget' })
// @ts-expect-error Callers cannot choose an execution result generic.
await runFindWidget<string>(client, { code: 'widget-code', metrics: [] })

const inferredOne = await runOneWidget(client)
await runOneWidget(client, {})
const inferredCommand = await runDeleteWidget(client, { code: 'removed' })
const inferredVoid = await runCallWidget(client)
const oneType: IsExactly<typeof inferredOne, OneWidgetRow> = true
const commandType: IsExactly<typeof inferredCommand, number> = true
const voidType: IsExactly<typeof inferredVoid, void> = true
void inferredOne
void inferredCommand
void inferredVoid
void oneType
void commandType
void voidType

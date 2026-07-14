/* oxlint-disable eslint/no-use-before-define -- The analyzer IR traversal uses small mutually recursive local helpers. */

import { readFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'

import {
  checkConstraintLiteralUnionColumnKey,
  loadCheckConstraintLiteralUnionFacts,
  type CheckConstraintLiteralUnionFact,
} from './check-constraint-type-facts.js'
import type { PostgresQueryable } from './database.js'

const ANALYZER_SCHEMA_VERSION = 2
const ANALYZER_SQL_FUNCTION = 'pg_temp.postgres_typed_sql_analyze'
const TYPED_SQL_SOURCE_SUFFIX = '.typed.sql'

export interface TypedSqlPostgresIr {
  readonly analyzerSchemaVersion: number
  readonly command: string
  readonly diagnostics: readonly string[]
  readonly hasDataModifyingCte: boolean
  readonly name: string
  readonly params: readonly TypedSqlPostgresIrParam[]
  readonly postgresVersionNum: number
  readonly resultColumns: readonly TypedSqlPostgresIrColumn[]
  readonly rowBounds: TypedSqlPostgresIrRowBounds
  readonly rowCardinality: TypedSqlPostgresIrRowCardinality
  readonly sourceFile: string
  readonly typePreview: string
}

export type TypedSqlPostgresIrRowCardinality = 'many' | 'none' | 'one' | 'optional'

export interface TypedSqlPostgresIrRowBounds {
  readonly max: number | null
  readonly min: number
  readonly proof: string
}

export interface TypedSqlPostgresIrParam {
  readonly name: string
  readonly pgType: string
  readonly pgTypeName: string
  readonly pgTypeSchema: string
  readonly propertyName: string
  readonly tsType: string
  readonly tsTypeSource?: 'checkConstraint'
}

export interface TypedSqlPostgresIrColumn {
  readonly jsonShape?: TypedSqlPostgresIrJsonShape
  readonly name: string | null
  readonly nullable: boolean
  readonly pgType: string
  readonly pgTypeName: string
  readonly pgTypeSchema: string
  readonly source: TypedSqlPostgresIrColumnSource
  readonly tsType: string
}

export type TypedSqlPostgresIrJsonShape =
  | {
      readonly kind: 'array'
      readonly element: TypedSqlPostgresIrJsonShape
      readonly nullable: boolean
    }
  | {
      readonly fields: readonly TypedSqlPostgresIrJsonField[]
      readonly kind: 'object'
      readonly nullable: boolean
    }
  | {
      readonly kind: 'opaque'
      readonly nullable: boolean
    }
  | {
      readonly kind: 'scalar'
      readonly nullable: boolean
      readonly pgType: string
      readonly pgTypeName: string
      readonly pgTypeSchema: string
      readonly tsType?: string
    }

export interface TypedSqlPostgresIrJsonField {
  readonly name: string
  readonly shape: TypedSqlPostgresIrJsonShape
}

export type TypedSqlPostgresIrColumnSource =
  | {
      readonly attname?: string
      readonly kind: 'derivedVar' | 'tableColumn'
      readonly relname?: string | null
      readonly varattno: number
      readonly varlevelsup: number
      readonly varno: number
      readonly varnullingrels: readonly number[]
    }
  | {
      readonly kind: 'expression'
      readonly tag: string
    }

interface SqlConfig {
  readonly name: string
  readonly params: ReadonlyMap<string, string>
  readonly sourceFile: string
  readonly sql: string
}

interface CompiledSqlConfig extends SqlConfig {
  readonly parameterNames: readonly string[]
}

export interface TypedSqlPostgresIrCompiledConfig {
  readonly name: string
  readonly parameterNames: readonly string[]
  readonly parameterTypes?: readonly (string | undefined)[]
  readonly sourceFile: string
  readonly sql: string
}

interface PgAnalyzerResult {
  readonly paramTypeOids: readonly number[]
  readonly postgresVersionNum: number
  readonly schemaVersion: number
  readonly statements: readonly PgAnalyzerStatement[]
}

export async function bindTypedSqlPostgresAnalyzer(client: PostgresQueryable): Promise<void> {
  await client.query(`
    create function ${ANALYZER_SQL_FUNCTION}(text, oid[]) returns text
    as '$libdir/postgres_typed_sql_analyzer', 'postgres_typed_sql_analyze'
    language c strict
  `)
}

interface PgAnalyzerStatement {
  readonly queries: readonly PgAnalyzerQuery[]
}

interface PgAnalyzerQuery {
  readonly commandType: string
  readonly cteList?: readonly PgAnalyzerCte[]
  readonly distinctClauseCount?: number
  readonly groupClauseCount?: number
  readonly groupingSetsCount?: number
  readonly hasAggs?: boolean
  readonly hasHavingQual?: boolean
  readonly hasLimitOffset?: boolean
  readonly hasSetOperations?: boolean
  readonly hasTargetSRFs?: boolean
  readonly hasWindowFuncs?: boolean
  readonly limitCount?: PgAnalyzerExpr | null
  readonly returningList?: readonly PgAnalyzerTarget[]
  readonly resultRelation?: number
  readonly rtable?: readonly PgAnalyzerRte[]
  readonly targetList?: readonly PgAnalyzerTarget[]
  readonly whereQual?: PgAnalyzerExpr | null
}

interface PgAnalyzerTarget {
  readonly expr?: PgAnalyzerExpr | null
  readonly resno?: number
  readonly resjunk?: boolean
  readonly resname?: string | null
}

interface PgAnalyzerCte {
  readonly commandType?: string
  readonly name: string
  readonly query?: PgAnalyzerQuery
  readonly recursive?: boolean
}

interface PgAnalyzerRte {
  readonly cteName?: string
  readonly kind: string
  readonly relid?: number | null
  readonly subquery?: PgAnalyzerQuery
}

interface PgAnalyzerExpr {
  readonly aggname?: string
  readonly arg?: PgAnalyzerExpr | null
  readonly args?: readonly (PgAnalyzerExpr | { readonly expr?: PgAnalyzerExpr | null })[]
  readonly attname?: string
  readonly boolOp?: string
  readonly constInteger?: string
  readonly constIsNull?: boolean
  readonly constString?: string
  readonly defresult?: PgAnalyzerExpr | null
  readonly expr?: PgAnalyzerExpr | null
  readonly funcid?: number
  readonly funcname?: string
  readonly nullTestType?: string
  readonly opfuncid?: number
  readonly opname?: string
  readonly paramTypeOid?: number
  readonly paramId?: number
  readonly relid?: number
  readonly relname?: string | null
  readonly result?: PgAnalyzerExpr | null
  readonly tag: string
  readonly typeName?: string
  readonly typeOid?: number
  readonly varattno?: number
  readonly varlevelsup?: number
  readonly varno?: number
  readonly varnullingrels?: readonly number[]
  readonly whenClauses?: readonly PgAnalyzerExpr[]
}

interface TypeCatalogRow {
  readonly formatted_type: string
  readonly oid: number
  readonly type_schema: string
  readonly typname: string
}

interface ProcCatalogRow {
  readonly oid: number
  readonly proisstrict: boolean
}

interface ColumnCatalogRow {
  readonly attname: string
  readonly attnotnull: boolean
  readonly attnum: number
  readonly relid: number
  readonly relname: string
}

interface UniqueIndexCatalogRow {
  readonly attnums: readonly number[]
  readonly index_name: string
  readonly indexrelid: number
  readonly indisprimary: boolean
  readonly relid: number
}

interface CatalogFacts {
  readonly checkConstraintTypesByColumn: ReadonlyMap<string, CheckConstraintLiteralUnionFact>
  readonly columns: ReadonlyMap<string, ColumnCatalogRow>
  readonly procs: ReadonlyMap<number, ProcCatalogRow>
  readonly types: ReadonlyMap<number, TypeCatalogRow>
  readonly uniqueIndexesByRelid: ReadonlyMap<number, readonly UniqueIndexCatalogRow[]>
}

export interface TypedSqlPostgresIrBuildResult {
  readonly catalogFacts: {
    readonly columns: number
    readonly checkConstraintLiteralUnions: number
    readonly procs: number
    readonly types: number
    readonly uniqueIndexes: number
  }
  readonly queries: readonly TypedSqlPostgresIr[]
}

const pgTypeToTsType = new Map<string, string>([
  ['bigint', 'PgInt8String'],
  ['bit', 'string'],
  ['bit varying', 'string'],
  ['boolean', 'boolean'],
  ['box', 'string'],
  ['bytea', 'PgByteaHexString'],
  ['char', 'string'],
  ['cidr', 'string'],
  ['circle', 'string'],
  ['date', 'PgDateString'],
  ['double precision', 'PgFloat8String'],
  ['inet', 'string'],
  ['integer', 'PgInt4String'],
  ['interval', 'PgIntervalString'],
  ['json', 'DbJsonSelected'],
  ['jsonb', 'DbJsonSelected'],
  ['line', 'string'],
  ['lseg', 'string'],
  ['macaddr', 'string'],
  ['macaddr8', 'string'],
  ['money', 'string'],
  ['name', 'string'],
  ['numeric', 'PgNumericString'],
  ['oid', 'PgOidString'],
  ['path', 'string'],
  ['pg_lsn', 'string'],
  ['point', 'string'],
  ['polygon', 'string'],
  ['real', 'PgFloat4String'],
  ['smallint', 'PgInt2String'],
  ['text', 'string'],
  ['time without time zone', 'PgTimeString'],
  ['time with time zone', 'PgTimetzString'],
  ['timestamp without time zone', 'PgTimestampString'],
  ['timestamp with time zone', 'PgTimestamptzString'],
  ['timestamptz', 'PgTimestamptzString'],
  ['tsquery', 'string'],
  ['tsvector', 'string'],
  ['unknown', 'unknown'],
  ['uuid', 'PgUuidString'],
  ['void', 'unknown'],
  ['xml', 'string'],
  ['uuid[]', 'readonly PgUuidString[]'],
])

for (const rangeType of ['daterange', 'int4range', 'int8range', 'numrange', 'tsrange', 'tstzrange']) {
  pgTypeToTsType.set(rangeType, 'string')
}

function camelCaseIdentifier(identifier: string): string {
  return identifier.replaceAll(/_([a-z0-9])/gu, (_match, letter: string) => letter.toUpperCase())
}

function normalizePgTypeName(pgType: string): string {
  if (pgType.startsWith('character varying') || pgType.startsWith('character(') || pgType === 'varchar') {
    return 'text'
  }
  if (pgType.startsWith('numeric(')) {
    return 'numeric'
  }
  if (pgType.startsWith('timestamp(') && pgType.endsWith(' without time zone')) {
    return 'timestamp without time zone'
  }
  if (pgType.startsWith('timestamp(') && pgType.endsWith(' with time zone')) {
    return 'timestamp with time zone'
  }
  if (pgType.startsWith('time(') && pgType.endsWith(' without time zone')) {
    return 'time without time zone'
  }
  if (pgType.startsWith('time(') && pgType.endsWith(' with time zone')) {
    return 'time with time zone'
  }
  return pgType
}

function postgresArrayElementType(pgType: string, typeName: string): string | null {
  const normalizedPgType = normalizePgTypeName(pgType)
  if (normalizedPgType.endsWith('[]')) {
    return normalizedPgType.slice(0, -2)
  }

  const normalizedTypeName = normalizePgTypeName(typeName)
  if (normalizedTypeName.startsWith('_') && normalizedTypeName.length > 1) {
    return normalizedTypeName.slice(1)
  }

  return null
}

function splitSchemaQualifiedPgType(pgType: string): { readonly schema: string; readonly typeName: string } | null {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)(\[\])?$/u.exec(pgType)
  if (!match?.[1] || !match[2]) {
    return null
  }

  return { schema: match[1], typeName: `${match[2]}${match[3] ?? ''}` }
}

function lowerCamelCaseFromPathBase(base: string): string {
  const parts = base.split(/[^A-Za-z0-9]+/u)
  const head = parts.find((part) => part.length > 0)
  if (!head) {
    throw new Error(`${base}: typed SQL filename must contain at least one identifier segment.`)
  }
  const tail = parts.slice(parts.indexOf(head) + 1).filter((part) => part.length > 0)
  const identifier = [
    head.toLowerCase(),
    ...tail.map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1).toLowerCase()}`),
  ].join('')
  if (!/^[a-z][A-Za-z0-9]*$/u.test(identifier)) {
    throw new Error(`${base}: typed SQL filename must produce a lower camel-case identifier.`)
  }
  return identifier
}

function pascalCaseIdentifier(identifier: string): string {
  const camel = camelCaseIdentifier(identifier)
  return `${camel.slice(0, 1).toUpperCase()}${camel.slice(1)}`
}

function quotePropertyName(propertyName: string): string {
  return /^[A-Za-z_$][\w$]*$/u.test(propertyName) ? propertyName : JSON.stringify(propertyName)
}

function tsTypeForPgType(typeFact: Pick<TypedSqlPostgresIrColumn, 'pgType' | 'pgTypeName' | 'pgTypeSchema'>): string {
  const schemaQualifiedType =
    typeFact.pgTypeSchema === 'pg_catalog' && !typeFact.pgTypeName ? splitSchemaQualifiedPgType(typeFact.pgType) : null
  if (schemaQualifiedType) {
    return tsTypeForPgType({
      pgType: schemaQualifiedType.typeName,
      pgTypeName: schemaQualifiedType.typeName,
      pgTypeSchema: schemaQualifiedType.schema,
    })
  }

  const arrayElementType = postgresArrayElementType(typeFact.pgType, typeFact.pgTypeName)
  if (arrayElementType) {
    const elementType =
      typeFact.pgTypeSchema === 'pg_catalog'
        ? tsTypeForPgType({
            pgType: arrayElementType,
            pgTypeName: arrayElementType,
            pgTypeSchema: 'pg_catalog',
          })
        : pascalCaseIdentifier(arrayElementType)
    return `readonly ${elementType}[]`
  }

  if (typeFact.pgTypeSchema !== 'pg_catalog') {
    return pascalCaseIdentifier(typeFact.pgTypeName || typeFact.pgType)
  }

  const tsType = pgTypeToTsType.get(normalizePgTypeName(typeFact.pgType))
  if (!tsType) {
    throw new Error(`No TypeScript mapping configured for PostgreSQL type ${typeFact.pgType}.`)
  }

  return tsType
}

function parseDirectiveLine(line: string): readonly string[] | null {
  const match = /^--\s*@(\w+)\s+(.+)$/u.exec(line)
  if (!match) {
    return null
  }

  const kind = match[1]
  const body = match[2]
  return kind && body ? [kind, ...body.trim().split(/\s+/u)] : null
}

function stripNullablePgTypeSuffix(pgType: string): string {
  return pgType.endsWith('?') ? pgType.slice(0, -1) : pgType
}

async function readConfigs(sqlDir: string): Promise<readonly SqlConfig[]> {
  const sourceFiles = (await readdir(sqlDir)).filter((file) => file.endsWith(TYPED_SQL_SOURCE_SUFFIX)).toSorted()
  return sourceFiles.map((sourceFile) => {
    const params = new Map<string, string>()
    const sqlLines: string[] = []
    let name = lowerCamelCaseFromPathBase(basename(sourceFile, TYPED_SQL_SOURCE_SUFFIX))

    for (const line of readFileSync(join(sqlDir, sourceFile), 'utf8').split(/\r?\n/u)) {
      const directive = parseDirectiveLine(line)
      if (!directive) {
        sqlLines.push(line)
        continue
      }

      const [kind, identifier, pgType] = directive
      if (kind === 'name') {
        if (identifier) {
          name = identifier
        }
      } else if (kind === 'param' && identifier && pgType) {
        params.set(identifier, stripNullablePgTypeSuffix(pgType))
      }
    }

    return {
      name,
      params,
      sourceFile,
      sql: sqlLines.join('\n').trim(),
    } satisfies SqlConfig
  })
}

function compileNamedParams(config: SqlConfig): CompiledSqlConfig {
  const parameterNames: string[] = []
  const placeholdersByName = new Map<string, number>()
  const sql = config.sql.replaceAll(/(?<!:):([A-Za-z_][A-Za-z0-9_]*)/gu, (_match, name: string) => {
    const existing = placeholdersByName.get(name)
    if (existing !== undefined) {
      return `$${existing}`
    }

    const index = parameterNames.length + 1
    placeholdersByName.set(name, index)
    parameterNames.push(name)
    return `$${index}`
  })

  return {
    ...config,
    parameterNames,
    sql,
  }
}

async function explicitParamTypeOids(client: PostgresQueryable, config: CompiledSqlConfig): Promise<readonly number[]> {
  if (config.parameterNames.length === 0 || !config.parameterNames.every((name) => config.params.has(name))) {
    return []
  }

  const typeOids: number[] = []
  for (const name of config.parameterNames) {
    const pgType = config.params.get(name)
    if (!pgType) {
      throw new Error(`${config.sourceFile}: missing parameter type for ${name}.`)
    }

    const result = await client.query<{ readonly oid: number | null }>('select to_regtype($1)::oid::int as oid', [
      pgType,
    ])
    const oid = result.rows[0]?.oid
    if (!oid) {
      throw new Error(`${config.sourceFile}: unknown explicit parameter type ${pgType}.`)
    }
    typeOids.push(oid)
  }
  return typeOids
}

async function explicitCompiledParamTypeOids(
  client: PostgresQueryable,
  config: TypedSqlPostgresIrCompiledConfig
): Promise<readonly number[]> {
  const parameterTypes = config.parameterTypes ?? []
  if (parameterTypes.every((pgType) => !pgType)) {
    return []
  }

  const typeOids: number[] = []
  for (const [index, pgType] of parameterTypes.entries()) {
    if (!pgType) {
      typeOids.push(0)
      continue
    }

    const result = await client.query<{ readonly oid: number | null }>('select to_regtype($1)::oid::int as oid', [
      pgType,
    ])
    const oid = result.rows[0]?.oid
    if (!oid) {
      throw new Error(
        `${config.sourceFile}: unknown explicit parameter type ${pgType} for parameter ${
          config.parameterNames[index] ?? index + 1
        }.`
      )
    }
    typeOids.push(oid)
  }
  return typeOids
}

function exprChildren(expr: PgAnalyzerExpr): readonly PgAnalyzerExpr[] {
  const children: PgAnalyzerExpr[] = []
  for (const key of ['arg', 'defresult', 'expr'] as const) {
    const child = expr[key]
    if (child) {
      children.push(child)
    }
  }
  for (const whenClause of expr.whenClauses ?? []) {
    children.push(whenClause)
  }
  for (const arg of expr.args ?? []) {
    if ('tag' in arg) {
      children.push(arg)
    } else if (arg.expr) {
      children.push(arg.expr)
    }
  }
  return children
}

function walkExpr(expr: PgAnalyzerExpr | null | undefined, visit: (expr: PgAnalyzerExpr) => void): void {
  if (!expr) {
    return
  }

  visit(expr)
  for (const child of exprChildren(expr)) {
    walkExpr(child, visit)
  }
}

function resultTargets(query: PgAnalyzerQuery): readonly PgAnalyzerTarget[] {
  const targets = ['UPDATE', 'INSERT', 'DELETE', 'MERGE'].includes(query.commandType)
    ? (query.returningList ?? [])
    : (query.targetList ?? [])

  return targets.filter((target) => target.resjunk !== true)
}

function rowCardinalityFromBounds(bounds: TypedSqlPostgresIrRowBounds): TypedSqlPostgresIrRowCardinality {
  if (bounds.min === 0 && bounds.max === 0) {
    return 'none'
  }
  if (bounds.min === 1 && bounds.max === 1) {
    return 'one'
  }
  if (bounds.min === 0 && bounds.max === 1) {
    return 'optional'
  }
  return 'many'
}

function constNonNegativeSafeInteger(expr: PgAnalyzerExpr | null | undefined): number | null {
  const unwrapped = unwrapTransparentExpr(expr)
  if (unwrapped?.tag === 'FuncExpr' && unwrapped.funcname === 'int8' && unwrapped.args?.length === 1) {
    return constNonNegativeSafeInteger(targetExprFromAggregateArg(unwrapped.args[0]))
  }

  if (!unwrapped || unwrapped.tag !== 'Const' || unwrapped.constIsNull === true || !unwrapped.constInteger) {
    return null
  }

  const parsed = Number(unwrapped.constInteger)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
}

function applyLimitBounds(query: PgAnalyzerQuery, base: TypedSqlPostgresIrRowBounds): TypedSqlPostgresIrRowBounds {
  const limit = constNonNegativeSafeInteger(query.limitCount)
  const maxAfterLimit = limit === null ? base.max : base.max === null ? limit : Math.min(base.max, limit)
  const minAfterLimit = limit === 0 || query.hasLimitOffset === true ? 0 : base.min

  if (limit === null && query.hasLimitOffset !== true) {
    return base
  }

  return {
    max: maxAfterLimit,
    min: maxAfterLimit === 0 ? 0 : Math.min(minAfterLimit, maxAfterLimit ?? minAfterLimit),
    proof: [
      base.proof,
      limit === null ? null : `constant_limit_${limit}`,
      query.hasLimitOffset === true ? 'offset_can_drop_rows' : null,
    ]
      .filter((part): part is string => part !== null)
      .join('+'),
  }
}

function simpleRelationRelid(query: PgAnalyzerQuery): number | null {
  const relationRtes = (query.rtable ?? []).filter(
    (rte): rte is PgAnalyzerRte & { readonly relid: number } => rte.kind === 'RELATION' && typeof rte.relid === 'number'
  )
  return relationRtes.length === 1 ? (relationRtes[0]?.relid ?? null) : null
}

function isParamOrConstValue(expr: PgAnalyzerExpr | null | undefined): boolean {
  const unwrapped = unwrapTransparentExpr(expr)
  return unwrapped?.tag === 'Param' || unwrapped?.tag === 'Const'
}

function constrainedAttnumsFromQual(
  expr: PgAnalyzerExpr | null | undefined,
  relid: number,
  output = new Set<number>()
): ReadonlySet<number> {
  if (!expr) {
    return output
  }

  if (expr.tag === 'BoolExpr' && expr.boolOp === 'AND') {
    for (const child of exprChildren(expr)) {
      constrainedAttnumsFromQual(child, relid, output)
    }
    return output
  }

  if (expr.tag !== 'OpExpr' || expr.opname !== '=' || expr.args?.length !== 2) {
    return output
  }

  const left = targetExprFromAggregateArg(expr.args[0])
  const right = targetExprFromAggregateArg(expr.args[1])
  const leftVar = unwrapTransparentExpr(left)
  const rightVar = unwrapTransparentExpr(right)
  if (leftVar?.tag === 'Var' && leftVar.relid === relid && leftVar.varattno && isParamOrConstValue(right)) {
    output.add(leftVar.varattno)
  } else if (rightVar?.tag === 'Var' && rightVar.relid === relid && rightVar.varattno && isParamOrConstValue(left)) {
    output.add(rightVar.varattno)
  }

  return output
}

function compareUniqueIndexCatalogRows(left: UniqueIndexCatalogRow, right: UniqueIndexCatalogRow): number {
  if (left.indisprimary !== right.indisprimary) {
    return left.indisprimary ? -1 : 1
  }

  const attnumCountDelta = left.attnums.length - right.attnums.length
  if (attnumCountDelta !== 0) {
    return attnumCountDelta
  }

  const nameDelta = left.index_name.localeCompare(right.index_name)
  if (nameDelta !== 0) {
    return nameDelta
  }

  return left.indexrelid - right.indexrelid
}

function uniqueIndexRowBounds(catalog: CatalogFacts, query: PgAnalyzerQuery): TypedSqlPostgresIrRowBounds | null {
  if (query.commandType !== 'SELECT' && query.commandType !== 'UPDATE' && query.commandType !== 'DELETE') {
    return null
  }
  if (
    query.hasAggs === true ||
    query.hasSetOperations === true ||
    query.hasTargetSRFs === true ||
    query.hasWindowFuncs === true ||
    (query.groupClauseCount ?? 0) > 0 ||
    (query.groupingSetsCount ?? 0) > 0
  ) {
    return null
  }

  const relid = simpleRelationRelid(query)
  if (relid === null || !query.whereQual) {
    return null
  }

  const constrainedAttnums = constrainedAttnumsFromQual(query.whereQual, relid)
  const uniqueIndex = catalog.uniqueIndexesByRelid
    .get(relid)
    ?.find((index) => index.attnums.every((attnum) => constrainedAttnums.has(attnum)))
  if (!uniqueIndex) {
    return null
  }

  return {
    max: 1,
    min: 0,
    proof: `${uniqueIndex.indisprimary ? 'primary_key' : 'unique_index'}_equality:${uniqueIndex.index_name}`,
  }
}

function projectionSourceRowBounds(catalog: CatalogFacts, query: PgAnalyzerQuery): TypedSqlPostgresIrRowBounds | null {
  if (
    query.commandType !== 'SELECT' ||
    query.hasAggs === true ||
    query.hasSetOperations === true ||
    query.hasTargetSRFs === true ||
    query.hasWindowFuncs === true ||
    query.hasHavingQual === true ||
    (query.groupClauseCount ?? 0) > 0 ||
    (query.groupingSetsCount ?? 0) > 0 ||
    (query.distinctClauseCount ?? 0) > 0
  ) {
    return null
  }

  const sourceRte = query.rtable?.length === 1 ? query.rtable[0] : undefined
  let sourceQuery: PgAnalyzerQuery | undefined
  let sourceKind: string
  if (sourceRte?.kind === 'SUBQUERY') {
    sourceQuery = sourceRte.subquery
    sourceKind = 'subquery'
  } else if (sourceRte?.kind === 'CTE') {
    const cte = cteByName(query, sourceRte.cteName)
    if (cte?.recursive === true) {
      return null
    }
    sourceQuery = cte?.query
    sourceKind = 'cte'
  } else {
    return null
  }

  if (!sourceQuery) {
    return null
  }

  const sourceBounds = inferRowBounds(catalog, sourceQuery, resultTargets(sourceQuery).length)
  return {
    max: sourceBounds.max,
    min: query.whereQual ? 0 : sourceBounds.min,
    proof: `${sourceKind}_projection:${sourceBounds.proof}${query.whereQual ? '+outer_qual_can_filter' : ''}`,
  }
}

function inferBaseRowBounds(
  catalog: CatalogFacts,
  query: PgAnalyzerQuery,
  resultColumnCount: number
): TypedSqlPostgresIrRowBounds {
  if (resultColumnCount === 0) {
    return { max: 0, min: 0, proof: 'no_result_columns' }
  }

  if (query.hasTargetSRFs === true || query.hasSetOperations === true) {
    return {
      max: null,
      min: 0,
      proof: query.hasTargetSRFs === true ? 'target_srf' : 'set_operations',
    }
  }

  const uniqueBounds = uniqueIndexRowBounds(catalog, query)
  if (uniqueBounds) {
    return uniqueBounds
  }
  const projectionBounds = projectionSourceRowBounds(catalog, query)
  if (projectionBounds) {
    return projectionBounds
  }

  if (query.commandType === 'SELECT') {
    const hasGrouping = (query.groupClauseCount ?? 0) > 0 || (query.groupingSetsCount ?? 0) > 0
    if (query.hasAggs === true && !hasGrouping && query.hasWindowFuncs !== true) {
      return query.hasHavingQual === true
        ? { max: 1, min: 0, proof: 'global_aggregate_with_having' }
        : { max: 1, min: 1, proof: 'global_aggregate' }
    }

    if ((query.rtable?.length ?? 0) === 0 && query.hasWindowFuncs !== true) {
      return query.whereQual
        ? { max: 1, min: 0, proof: 'select_without_from_with_qual' }
        : { max: 1, min: 1, proof: 'select_without_from' }
    }
  }

  return { max: null, min: 0, proof: 'unbounded' }
}

function inferRowBounds(
  catalog: CatalogFacts,
  query: PgAnalyzerQuery,
  resultColumnCount: number
): TypedSqlPostgresIrRowBounds {
  return applyLimitBounds(query, inferBaseRowBounds(catalog, query, resultColumnCount))
}

function isDataModifyingCommand(commandType: string | undefined): boolean {
  return commandType === 'UPDATE' || commandType === 'INSERT' || commandType === 'DELETE' || commandType === 'MERGE'
}

function queryHasDataModifyingCte(query: PgAnalyzerQuery): boolean {
  for (const cte of query.cteList ?? []) {
    if (isDataModifyingCommand(cte.commandType) || (cte.query && isDataModifyingCommand(cte.query.commandType))) {
      return true
    }
    if (cte.query && queryHasDataModifyingCte(cte.query)) {
      return true
    }
  }
  for (const rte of query.rtable ?? []) {
    if (rte.subquery && queryHasDataModifyingCte(rte.subquery)) {
      return true
    }
  }
  return false
}

function walkQuery(query: PgAnalyzerQuery, visitExpr: (expr: PgAnalyzerExpr) => void): void {
  for (const target of [...(query.targetList ?? []), ...(query.returningList ?? [])]) {
    walkExpr(target.expr, visitExpr)
  }
  walkExpr(query.whereQual, visitExpr)
  for (const cte of query.cteList ?? []) {
    if (cte.query) {
      walkQuery(cte.query, visitExpr)
    }
  }
  for (const rte of query.rtable ?? []) {
    if (rte.subquery) {
      walkQuery(rte.subquery, visitExpr)
    }
  }
}

function collectOids(analysis: PgAnalyzerResult): {
  readonly procOids: ReadonlySet<number>
  readonly relationColumns: readonly {
    readonly attnum: number
    readonly relid: number
  }[]
  readonly relationRelids: ReadonlySet<number>
  readonly typeOids: ReadonlySet<number>
} {
  const typeOids = new Set<number>(analysis.paramTypeOids)
  const procOids = new Set<number>()
  const relationColumns = new Map<string, { readonly attnum: number; readonly relid: number }>()
  const relationRelids = new Set<number>()

  for (const statement of analysis.statements) {
    for (const query of statement.queries) {
      walkQueryRelations(query, (relid) => {
        relationRelids.add(relid)
      })
      walkQuery(query, (expr) => {
        if (expr.typeOid) {
          typeOids.add(expr.typeOid)
        }
        if (expr.paramTypeOid) {
          typeOids.add(expr.paramTypeOid)
        }
        for (const oid of [expr.funcid, expr.opfuncid]) {
          if (oid) {
            procOids.add(oid)
          }
        }
        if (expr.relid && expr.varattno && expr.varattno > 0) {
          relationColumns.set(`${expr.relid}:${expr.varattno}`, {
            attnum: expr.varattno,
            relid: expr.relid,
          })
        }
      })
    }
  }

  return {
    procOids,
    relationColumns: [...relationColumns.values()],
    relationRelids,
    typeOids,
  }
}

function walkQueryRelations(query: PgAnalyzerQuery, visitRelid: (relid: number) => void): void {
  for (const rte of query.rtable ?? []) {
    if (rte.kind === 'RELATION' && typeof rte.relid === 'number') {
      visitRelid(rte.relid)
    }
    if (rte.subquery) {
      walkQueryRelations(rte.subquery, visitRelid)
    }
  }
  for (const cte of query.cteList ?? []) {
    if (cte.query) {
      walkQueryRelations(cte.query, visitRelid)
    }
  }
}

async function loadCatalog(client: PostgresQueryable, analyses: readonly PgAnalyzerResult[]): Promise<CatalogFacts> {
  const typeOids = new Set<number>()
  const procOids = new Set<number>()
  const relationColumnKeys = new Map<string, { readonly attnum: number; readonly relid: number }>()
  const relationRelids = new Set<number>()
  for (const analysis of analyses) {
    const collected = collectOids(analysis)
    for (const oid of collected.typeOids) {
      typeOids.add(oid)
    }
    for (const oid of collected.procOids) {
      procOids.add(oid)
    }
    for (const column of collected.relationColumns) {
      relationColumnKeys.set(`${column.relid}:${column.attnum}`, column)
    }
    for (const relid of collected.relationRelids) {
      relationRelids.add(relid)
    }
  }

  const types = new Map<number, TypeCatalogRow>()
  if (typeOids.size > 0) {
    const result = await client.query<TypeCatalogRow>(
      `
        select
          t.oid::int as oid,
          format_type(t.oid, null) as formatted_type,
          n.nspname as type_schema,
          t.typname
        from pg_type t
        inner join pg_namespace n
          on n.oid = t.typnamespace
        where t.oid = any($1::oid[])
      `,
      [[...typeOids]]
    )
    for (const row of result.rows) {
      types.set(row.oid, row)
    }
  }

  const procs = new Map<number, ProcCatalogRow>()
  if (procOids.size > 0) {
    const result = await client.query<ProcCatalogRow>(
      `
        select
          p.oid::int as oid,
          p.proisstrict
        from pg_proc p
        where p.oid = any($1::oid[])
      `,
      [[...procOids]]
    )
    for (const row of result.rows) {
      procs.set(row.oid, row)
    }
  }

  const columns = new Map<string, ColumnCatalogRow>()
  const relationColumns = [...relationColumnKeys.values()]
  if (relationColumns.length > 0) {
    const result = await client.query<ColumnCatalogRow>(
      `
        select
          c.oid::int as relid,
          c.relname,
          a.attnum::int as attnum,
          a.attname,
          a.attnotnull
        from pg_class c
        join pg_attribute a
          on a.attrelid = c.oid
        where (c.oid::int, a.attnum) in (${relationColumns.map((_, index) => `($${index * 2 + 1}::int, $${index * 2 + 2}::int)`).join(', ')})
          and not a.attisdropped
      `,
      relationColumns.flatMap((column) => [column.relid, column.attnum])
    )
    for (const row of result.rows) {
      columns.set(`${row.relid}:${row.attnum}`, row)
    }
  }

  const uniqueIndexesByRelid = new Map<number, UniqueIndexCatalogRow[]>()
  if (relationRelids.size > 0) {
    const result = await client.query<UniqueIndexCatalogRow>(
      `
        select
          i.indrelid::int as relid,
          i.indexrelid::int as indexrelid,
          index_class.relname as index_name,
          i.indisprimary,
          array_agg(key.attnum::int order by key.ordinality) as attnums
        from pg_index i
        join pg_class index_class
          on index_class.oid = i.indexrelid
        cross join lateral unnest(string_to_array(i.indkey::text, ' ')::int[]) with ordinality as key(attnum, ordinality)
        where i.indrelid = any($1::oid[])
          and i.indisunique
          and i.indisvalid
          and i.indpred is null
          and i.indexprs is null
          and key.attnum > 0
        group by i.indrelid, i.indexrelid, index_class.relname, i.indisprimary
      `,
      [[...relationRelids]]
    )
    for (const row of result.rows) {
      const entries = uniqueIndexesByRelid.get(row.relid) ?? []
      entries.push(row)
      uniqueIndexesByRelid.set(row.relid, entries)
    }
    for (const entries of uniqueIndexesByRelid.values()) {
      entries.sort(compareUniqueIndexCatalogRows)
    }
  }

  const checkConstraintTypesByColumn = new Map<string, CheckConstraintLiteralUnionFact>()
  if (relationRelids.size > 0) {
    for (const fact of await loadCheckConstraintLiteralUnionFacts(client, {
      relids: [...relationRelids],
    })) {
      checkConstraintTypesByColumn.set(checkConstraintLiteralUnionColumnKey(fact), fact)
    }
  }

  return {
    checkConstraintTypesByColumn,
    columns,
    procs,
    types,
    uniqueIndexesByRelid,
  }
}

function typeFactForOid(
  catalog: CatalogFacts,
  oid: number | undefined,
  fallback: string | undefined
): Pick<TypedSqlPostgresIrColumn, 'pgType' | 'pgTypeName' | 'pgTypeSchema'> {
  if (oid) {
    const type = catalog.types.get(oid)
    if (type) {
      return {
        pgType: type.formatted_type,
        pgTypeName: type.typname,
        pgTypeSchema: type.type_schema,
      }
    }
    return {
      pgType: fallback ?? `oid:${oid}`,
      pgTypeName: `oid_${oid}`,
      pgTypeSchema: 'unknown',
    }
  }

  return {
    pgType: fallback ?? 'unknown',
    pgTypeName: fallback ?? 'unknown',
    pgTypeSchema: 'unknown',
  }
}

function exprKey(expr: PgAnalyzerExpr | null | undefined): string | null {
  if (!expr || expr.tag !== 'Var' || expr.varno === undefined || expr.varattno === undefined) {
    return null
  }
  return `${expr.varno}:${expr.varattno}:${expr.varlevelsup ?? 0}`
}

function collectNonNullVarKeys(
  expr: PgAnalyzerExpr | null | undefined,
  output = new Set<string>()
): ReadonlySet<string> {
  if (!expr) {
    return output
  }

  if (expr.tag === 'NullTest' && expr.nullTestType === 'IS_NOT_NULL') {
    const key = exprKey(expr.arg)
    if (key) {
      output.add(key)
    }
  }
  for (const child of exprChildren(expr)) {
    collectNonNullVarKeys(child, output)
  }
  return output
}

function cteByName(query: PgAnalyzerQuery, name: string | undefined): PgAnalyzerCte | undefined {
  return name ? (query.cteList ?? []).find((cte) => cte.name === name) : undefined
}

function checkConstraintTypeForExpr(
  catalog: CatalogFacts,
  query: PgAnalyzerQuery,
  expr: PgAnalyzerExpr | null | undefined,
  seen = new Set<string>()
): string | null {
  const unwrapped = unwrapTransparentExpr(expr)
  if (!unwrapped || unwrapped.tag !== 'Var') {
    return null
  }

  const key = exprKey(unwrapped)
  if (key && seen.has(key)) {
    return null
  }
  if (key) {
    seen.add(key)
  }

  if (unwrapped.relid && unwrapped.varattno) {
    const fact = catalog.checkConstraintTypesByColumn.get(
      checkConstraintLiteralUnionColumnKey({
        attnum: unwrapped.varattno,
        relid: unwrapped.relid,
      })
    )
    if (fact) {
      return fact.typeName
    }
  }

  const rte = unwrapped.varno ? query.rtable?.[unwrapped.varno - 1] : undefined
  if (rte?.kind === 'CTE') {
    const cte = cteByName(query, rte.cteName)
    const cteQuery = cte?.query
    const source = cteQuery ? resultTargets(cteQuery)[(unwrapped.varattno ?? 1) - 1] : undefined
    return source && cteQuery ? checkConstraintTypeForExpr(catalog, cteQuery, source.expr, seen) : null
  }
  if (rte?.kind === 'SUBQUERY' && rte.subquery) {
    const source = resultTargets(rte.subquery)[(unwrapped.varattno ?? 1) - 1]
    return source ? checkConstraintTypeForExpr(catalog, rte.subquery, source.expr, seen) : null
  }

  return null
}

function tsTypeForExpr(
  catalog: CatalogFacts,
  query: PgAnalyzerQuery,
  expr: PgAnalyzerExpr | null | undefined,
  typeFact: Pick<TypedSqlPostgresIrColumn, 'pgType' | 'pgTypeName' | 'pgTypeSchema'>
): string {
  return checkConstraintTypeForExpr(catalog, query, expr) ?? tsTypeForPgType(typeFact)
}

function resultRelationRelid(query: PgAnalyzerQuery): number | null {
  const resultRelationIndex = query.resultRelation
  if (!resultRelationIndex) {
    return null
  }

  const rte = query.rtable?.[resultRelationIndex - 1]
  return rte?.kind === 'RELATION' && typeof rte.relid === 'number' ? rte.relid : null
}

function directParamId(expr: PgAnalyzerExpr | null | undefined): number | null {
  const unwrapped = unwrapTransparentExpr(expr)
  return unwrapped?.tag === 'Param' && Number.isInteger(unwrapped.paramId) ? (unwrapped.paramId ?? null) : null
}

function collectDirectCheckedColumnParamTypes(
  catalog: CatalogFacts,
  query: PgAnalyzerQuery,
  output = new Map<number, Set<string>>()
): Map<number, Set<string>> {
  if (query.commandType === 'INSERT' || query.commandType === 'UPDATE') {
    const relid = resultRelationRelid(query)
    if (relid) {
      for (const target of query.targetList ?? []) {
        if (target.resjunk === true) {
          continue
        }

        const attnum = target.resno
        const paramId = directParamId(target.expr)
        if (!attnum || !paramId) {
          continue
        }

        const fact = catalog.checkConstraintTypesByColumn.get(checkConstraintLiteralUnionColumnKey({ attnum, relid }))
        if (!fact) {
          continue
        }

        const types = output.get(paramId) ?? new Set<string>()
        types.add(fact.typeName)
        output.set(paramId, types)
      }
    }
  }

  for (const cte of query.cteList ?? []) {
    if (cte.query) {
      collectDirectCheckedColumnParamTypes(catalog, cte.query, output)
    }
  }
  for (const rte of query.rtable ?? []) {
    if (rte.subquery) {
      collectDirectCheckedColumnParamTypes(catalog, rte.subquery, output)
    }
  }

  return output
}

function checkedColumnParamTypes(catalog: CatalogFacts, query: PgAnalyzerQuery): ReadonlyMap<number, string> {
  const candidates = collectDirectCheckedColumnParamTypes(catalog, query)
  const resolved = new Map<number, string>()
  for (const [paramId, types] of candidates) {
    if (types.size === 1) {
      const [typeName] = types
      if (typeName) {
        resolved.set(paramId, typeName)
      }
    }
  }
  return resolved
}

function expressionNullable(
  catalog: CatalogFacts,
  query: PgAnalyzerQuery,
  expr: PgAnalyzerExpr | null | undefined,
  refinements = collectNonNullVarKeys(query.whereQual)
): boolean {
  if (!expr) {
    return true
  }

  if (expr.tag === 'Var') {
    if ((expr.varnullingrels ?? []).length > 0) {
      return true
    }
    if (refinements.has(exprKey(expr) ?? '')) {
      return false
    }
    if (expr.relid && expr.varattno) {
      const column = catalog.columns.get(`${expr.relid}:${expr.varattno}`)
      if (column) {
        return !column.attnotnull
      }
    }

    const rte = expr.varno ? query.rtable?.[expr.varno - 1] : undefined
    if (rte?.kind === 'CTE') {
      const cte = cteByName(query, rte.cteName)
      const cteQuery = cte?.query
      const source = cteQuery ? resultTargets(cteQuery)[(expr.varattno ?? 1) - 1] : undefined
      return source && cteQuery ? expressionNullable(catalog, cteQuery, source.expr) : true
    }
    if (rte?.kind === 'SUBQUERY' && rte.subquery) {
      const source = resultTargets(rte.subquery)[(expr.varattno ?? 1) - 1]
      return source ? expressionNullable(catalog, rte.subquery, source.expr) : true
    }
    return true
  }

  if (expr.tag === 'Const') {
    return expr.constIsNull === true
  }
  if (expr.tag === 'Param') {
    return true
  }
  if (expr.tag === 'NullTest' || expr.tag === 'BooleanTest' || expr.tag === 'SubLink') {
    return false
  }
  if (expr.tag === 'Aggref') {
    return expr.aggname !== 'count'
  }
  if (expr.tag === 'CoalesceExpr') {
    return !exprChildren(expr).some((child) => !expressionNullable(catalog, query, child, refinements))
  }
  if (expr.tag === 'CaseExpr') {
    const results = [...(expr.whenClauses ?? []).map((whenClause) => whenClause.result), expr.defresult].filter(
      (child): child is PgAnalyzerExpr => Boolean(child)
    )
    return results.length === 0 || results.some((result) => expressionNullable(catalog, query, result, refinements))
  }
  if (expr.tag === 'BoolExpr') {
    return exprChildren(expr).some((child) => expressionNullable(catalog, query, child, refinements))
  }
  if (expr.tag === 'OpExpr' || expr.tag === 'FuncExpr' || expr.tag === 'ScalarArrayOpExpr') {
    const proc = catalog.procs.get(expr.opfuncid ?? expr.funcid ?? 0)
    if (
      proc?.proisstrict === true &&
      exprChildren(expr).every((child) => !expressionNullable(catalog, query, child, refinements))
    ) {
      return false
    }
    if (expr.funcname === 'jsonb_build_object' || expr.funcname === 'json_build_object') {
      return false
    }
  }
  if (expr.tag === 'RelabelType' || expr.tag === 'CoerceViaIO') {
    return expressionNullable(catalog, query, expr.arg, refinements)
  }

  return true
}

function sourceForExpr(expr: PgAnalyzerExpr | null | undefined): TypedSqlPostgresIrColumnSource {
  if (!expr || expr.tag !== 'Var' || expr.varno === undefined || expr.varattno === undefined) {
    return { kind: 'expression', tag: expr?.tag ?? 'unknown' }
  }
  return {
    attname: expr.attname,
    kind: expr.relname ? 'tableColumn' : 'derivedVar',
    relname: expr.relname,
    varattno: expr.varattno,
    varlevelsup: expr.varlevelsup ?? 0,
    varno: expr.varno,
    varnullingrels: expr.varnullingrels ?? [],
  }
}

function isJsonType(typeName: string | undefined): boolean {
  return typeName === 'json' || typeName === 'jsonb'
}

function unwrapTransparentExpr(expr: PgAnalyzerExpr | null | undefined): PgAnalyzerExpr | null | undefined {
  let current = expr
  while (current?.tag === 'RelabelType' || current?.tag === 'CoerceViaIO' || current?.tag === 'CoerceToDomain') {
    current = current.arg
  }
  return current
}

function constStringValue(expr: PgAnalyzerExpr | null | undefined): string | null {
  const unwrapped = unwrapTransparentExpr(expr)
  if (!unwrapped || unwrapped.tag !== 'Const' || unwrapped.constIsNull === true) {
    return null
  }
  return typeof unwrapped.constString === 'string' ? unwrapped.constString : null
}

function isEmptyJsonArrayConst(expr: PgAnalyzerExpr | null | undefined): boolean {
  return constStringValue(expr) === '[]'
}

function targetExprFromAggregateArg(
  arg: PgAnalyzerExpr | { readonly expr?: PgAnalyzerExpr | null } | undefined
): PgAnalyzerExpr | null | undefined {
  if (!arg) {
    return null
  }
  return 'tag' in arg ? arg : arg.expr
}

function jsonShapeWithNullability(shape: TypedSqlPostgresIrJsonShape, nullable: boolean): TypedSqlPostgresIrJsonShape {
  switch (shape.kind) {
    case 'array':
      return { ...shape, nullable }
    case 'object':
      return { ...shape, nullable }
    case 'opaque':
      return { ...shape, nullable }
    case 'scalar':
      return { ...shape, nullable }
  }
}

function scalarJsonShapeForExpr(
  catalog: CatalogFacts,
  query: PgAnalyzerQuery,
  expr: PgAnalyzerExpr,
  refinements: ReadonlySet<string>
): TypedSqlPostgresIrJsonShape {
  const typeFact = typeFactForOid(catalog, expr.typeOid, expr.typeName)
  if (isJsonType(typeFact.pgTypeName)) {
    return {
      kind: 'opaque',
      nullable: expressionNullable(catalog, query, expr, refinements),
    }
  }

  const checkConstraintType = checkConstraintTypeForExpr(catalog, query, expr)
  return {
    kind: 'scalar',
    nullable: expressionNullable(catalog, query, expr, refinements),
    ...typeFact,
    ...(checkConstraintType ? { tsType: checkConstraintType } : {}),
  }
}

function inferJsonShape(
  catalog: CatalogFacts,
  query: PgAnalyzerQuery,
  expr: PgAnalyzerExpr | null | undefined,
  refinements = collectNonNullVarKeys(query.whereQual),
  seen = new Set<string>(),
  queryScope = 'root'
): TypedSqlPostgresIrJsonShape | null {
  const unwrapped = unwrapTransparentExpr(expr)
  if (!unwrapped) {
    return null
  }

  if (unwrapped.tag === 'CoalesceExpr') {
    const children = exprChildren(unwrapped)
    const firstShape = inferJsonShape(catalog, query, children[0], refinements, seen, queryScope)
    if (!firstShape) {
      return null
    }

    if (firstShape.kind === 'array' && children.slice(1).some(isEmptyJsonArrayConst)) {
      return jsonShapeWithNullability(firstShape, false)
    }

    return jsonShapeWithNullability(firstShape, expressionNullable(catalog, query, unwrapped, refinements))
  }

  if (
    unwrapped.tag === 'FuncExpr' &&
    (unwrapped.funcname === 'jsonb_build_object' || unwrapped.funcname === 'json_build_object')
  ) {
    const args = unwrapped.args ?? []
    const fields: TypedSqlPostgresIrJsonField[] = []
    for (let index = 0; index + 1 < args.length; index += 2) {
      const keyExpr = args[index]
      const valueExpr = args[index + 1]
      const key = constStringValue(targetExprFromAggregateArg(keyExpr))
      const value = targetExprFromAggregateArg(valueExpr)
      if (!key || !value) {
        return {
          kind: 'opaque',
          nullable: expressionNullable(catalog, query, unwrapped, refinements),
        }
      }

      fields.push({
        name: key,
        shape:
          inferJsonShape(catalog, query, value, refinements, seen, queryScope) ??
          scalarJsonShapeForExpr(catalog, query, value, refinements),
      })
    }

    return {
      fields,
      kind: 'object',
      nullable: expressionNullable(catalog, query, unwrapped, refinements),
    }
  }

  if (unwrapped.tag === 'Aggref' && (unwrapped.aggname === 'jsonb_agg' || unwrapped.aggname === 'json_agg')) {
    const valueExpr = targetExprFromAggregateArg(unwrapped.args?.[0])
    if (!valueExpr) {
      return null
    }

    return {
      element:
        inferJsonShape(catalog, query, valueExpr, refinements, seen, queryScope) ??
        scalarJsonShapeForExpr(catalog, query, valueExpr, refinements),
      kind: 'array',
      nullable: expressionNullable(catalog, query, unwrapped, refinements),
    }
  }

  if (unwrapped.tag === 'Var') {
    const key = exprKey(unwrapped)
    const scopedKey = key ? `${queryScope}:${key}` : null
    if (scopedKey && seen.has(scopedKey)) {
      return null
    }
    const nestedSeen = scopedKey ? new Set(seen) : seen
    if (scopedKey) {
      nestedSeen.add(scopedKey)
    }

    const rte = unwrapped.varno ? query.rtable?.[unwrapped.varno - 1] : undefined
    if (rte?.kind === 'CTE') {
      const cte = cteByName(query, rte.cteName)
      const cteQuery = cte?.query
      const source = cteQuery ? resultTargets(cteQuery)[(unwrapped.varattno ?? 1) - 1] : undefined
      const shape =
        source && cteQuery
          ? inferJsonShape(catalog, cteQuery, source.expr, undefined, nestedSeen, `${queryScope}/cte:${rte.cteName}`)
          : null
      return shape ? jsonShapeWithNullability(shape, expressionNullable(catalog, query, unwrapped, refinements)) : null
    }

    if (rte?.kind === 'SUBQUERY' && rte.subquery) {
      const source = resultTargets(rte.subquery)[(unwrapped.varattno ?? 1) - 1]
      const shape = source
        ? inferJsonShape(
            catalog,
            rte.subquery,
            source.expr,
            undefined,
            nestedSeen,
            `${queryScope}/subquery:${key ?? 'var'}`
          )
        : null
      return shape ? jsonShapeWithNullability(shape, expressionNullable(catalog, query, unwrapped, refinements)) : null
    }
  }

  if (isJsonType(unwrapped.typeName)) {
    return {
      kind: 'opaque',
      nullable: expressionNullable(catalog, query, unwrapped, refinements),
    }
  }

  return null
}

function renderInterface(
  name: string,
  fields: readonly {
    readonly nullable: boolean
    readonly propertyName: string
    readonly tsType: string
  }[]
): string {
  if (fields.length === 0) {
    return `export type ${name} = Record<string, never>`
  }

  return [
    `export interface ${name} {`,
    ...fields.map(
      (field) =>
        `  readonly ${quotePropertyName(field.propertyName)}: ${field.tsType}${field.nullable ? ' | null' : ''}`
    ),
    '}',
  ].join('\n')
}

function renderTypePreview(ir: Omit<TypedSqlPostgresIr, 'typePreview'>): string {
  const baseName = pascalCaseIdentifier(ir.name)
  return [
    renderInterface(
      `${baseName}Params`,
      ir.params.map((param) => ({
        nullable: false,
        propertyName: param.propertyName,
        tsType: param.tsType,
      }))
    ),
    '',
    renderInterface(
      `${baseName}Row`,
      ir.resultColumns.map((entry, index) => ({
        nullable: entry.nullable,
        propertyName: camelCaseIdentifier(entry.name ?? `column_${index + 1}`),
        tsType: entry.tsType,
      }))
    ),
  ].join('\n')
}

function normalizeIr(catalog: CatalogFacts, config: CompiledSqlConfig, analysis: PgAnalyzerResult): TypedSqlPostgresIr {
  const query = analysis.statements[0]?.queries[0]
  if (!query) {
    throw new Error(`${config.sourceFile}: analyzer returned no query.`)
  }

  const resultColumns = resultTargets(query).map((target): TypedSqlPostgresIrColumn => {
    const expr = target.expr
    const typeFact = typeFactForOid(catalog, expr?.typeOid, expr?.typeName)
    const tsType = tsTypeForExpr(catalog, query, expr, typeFact)
    return {
      jsonShape: isJsonType(typeFact.pgTypeName) ? (inferJsonShape(catalog, query, expr) ?? undefined) : undefined,
      name: target.resname ?? null,
      nullable: expressionNullable(catalog, query, expr),
      ...typeFact,
      source: sourceForExpr(expr),
      tsType,
    }
  })

  const checkConstraintParamTypes = checkedColumnParamTypes(catalog, query)
  const params = config.parameterNames.map((name, index): TypedSqlPostgresIrParam => {
    const oid = analysis.paramTypeOids[index]
    const typeFact = typeFactForOid(catalog, oid, config.params.get(name))
    const checkConstraintTsType = checkConstraintParamTypes.get(index + 1)
    return {
      name,
      ...typeFact,
      propertyName: camelCaseIdentifier(name),
      tsType: checkConstraintTsType ?? tsTypeForPgType(typeFact),
      ...(checkConstraintTsType ? { tsTypeSource: 'checkConstraint' as const } : {}),
    }
  })
  const rowBounds = inferRowBounds(catalog, query, resultColumns.length)

  const partial = {
    analyzerSchemaVersion: analysis.schemaVersion,
    command: query.commandType,
    diagnostics: [],
    hasDataModifyingCte: queryHasDataModifyingCte(query),
    name: config.name,
    params,
    postgresVersionNum: analysis.postgresVersionNum,
    resultColumns,
    rowBounds,
    rowCardinality: rowCardinalityFromBounds(rowBounds),
    sourceFile: config.sourceFile,
  } satisfies Omit<TypedSqlPostgresIr, 'typePreview'>

  return {
    ...partial,
    typePreview: renderTypePreview(partial),
  }
}

function normalizeCompiledIr(
  catalog: CatalogFacts,
  config: TypedSqlPostgresIrCompiledConfig,
  analysis: PgAnalyzerResult
): TypedSqlPostgresIr {
  const query = analysis.statements[0]?.queries[0]
  if (!query) {
    throw new Error(`${config.sourceFile}: analyzer returned no query.`)
  }

  const resultColumns = resultTargets(query).map((target): TypedSqlPostgresIrColumn => {
    const expr = target.expr
    const typeFact = typeFactForOid(catalog, expr?.typeOid, expr?.typeName)
    const tsType = tsTypeForExpr(catalog, query, expr, typeFact)
    return {
      jsonShape: isJsonType(typeFact.pgTypeName) ? (inferJsonShape(catalog, query, expr) ?? undefined) : undefined,
      name: target.resname ?? null,
      nullable: expressionNullable(catalog, query, expr),
      ...typeFact,
      source: sourceForExpr(expr),
      tsType,
    }
  })

  const checkConstraintParamTypes = checkedColumnParamTypes(catalog, query)
  const params = config.parameterNames.map((name, index): TypedSqlPostgresIrParam => {
    const oid = analysis.paramTypeOids[index]
    const typeFact = typeFactForOid(catalog, oid, config.parameterTypes?.[index])
    const checkConstraintTsType = checkConstraintParamTypes.get(index + 1)
    return {
      name,
      ...typeFact,
      propertyName: name,
      tsType: checkConstraintTsType ?? tsTypeForPgType(typeFact),
      ...(checkConstraintTsType ? { tsTypeSource: 'checkConstraint' as const } : {}),
    }
  })
  const rowBounds = inferRowBounds(catalog, query, resultColumns.length)

  const partial = {
    analyzerSchemaVersion: analysis.schemaVersion,
    command: query.commandType,
    diagnostics: [],
    hasDataModifyingCte: queryHasDataModifyingCte(query),
    name: config.name,
    params,
    postgresVersionNum: analysis.postgresVersionNum,
    resultColumns,
    rowBounds,
    rowCardinality: rowCardinalityFromBounds(rowBounds),
    sourceFile: config.sourceFile,
  } satisfies Omit<TypedSqlPostgresIr, 'typePreview'>

  return {
    ...partial,
    typePreview: renderTypePreview(partial),
  }
}

async function analyzeConfig(client: PostgresQueryable, config: CompiledSqlConfig): Promise<PgAnalyzerResult> {
  const result = await client.query<{ readonly analysis: PgAnalyzerResult }>(
    `select ${ANALYZER_SQL_FUNCTION}($1, $2::oid[])::jsonb as analysis`,
    [config.sql, await explicitParamTypeOids(client, config)]
  )
  const analysis = result.rows[0]?.analysis
  if (!analysis || analysis.schemaVersion !== ANALYZER_SCHEMA_VERSION) {
    throw new Error(`${config.sourceFile}: analyzer returned unsupported schema.`)
  }
  return analysis
}

async function analyzeCompiledConfig(
  client: PostgresQueryable,
  config: TypedSqlPostgresIrCompiledConfig
): Promise<PgAnalyzerResult> {
  const result = await client.query<{ readonly analysis: PgAnalyzerResult }>(
    `select ${ANALYZER_SQL_FUNCTION}($1, $2::oid[])::jsonb as analysis`,
    [config.sql, await explicitCompiledParamTypeOids(client, config)]
  )
  const analysis = result.rows[0]?.analysis
  if (!analysis || analysis.schemaVersion !== ANALYZER_SCHEMA_VERSION) {
    throw new Error(`${config.sourceFile}: analyzer returned unsupported schema.`)
  }
  return analysis
}

export async function buildTypedSqlPostgresIr(
  client: PostgresQueryable,
  sqlDir: string
): Promise<TypedSqlPostgresIrBuildResult> {
  const configs = (await readConfigs(sqlDir)).map(compileNamedParams)
  const analyses: {
    readonly analysis: PgAnalyzerResult
    readonly config: CompiledSqlConfig
  }[] = []
  for (const config of configs) {
    analyses.push({ analysis: await analyzeConfig(client, config), config })
  }

  const catalog = await loadCatalog(
    client,
    analyses.map((entry) => entry.analysis)
  )
  return {
    catalogFacts: {
      checkConstraintLiteralUnions: catalog.checkConstraintTypesByColumn.size,
      columns: catalog.columns.size,
      procs: catalog.procs.size,
      types: catalog.types.size,
      uniqueIndexes: [...catalog.uniqueIndexesByRelid.values()].reduce((count, entries) => count + entries.length, 0),
    },
    queries: analyses.map(({ analysis, config }) => normalizeIr(catalog, config, analysis)),
  }
}

export async function buildTypedSqlPostgresIrFromCompiledConfigs(
  client: PostgresQueryable,
  configs: readonly TypedSqlPostgresIrCompiledConfig[]
): Promise<TypedSqlPostgresIrBuildResult> {
  const analyses: {
    readonly analysis: PgAnalyzerResult
    readonly config: TypedSqlPostgresIrCompiledConfig
  }[] = []
  for (const config of configs) {
    try {
      analyses.push({
        analysis: await analyzeCompiledConfig(client, config),
        config,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`${config.sourceFile}: failed to analyze typed SQL ${config.name}: ${message}`, {
        cause: error,
      })
    }
  }

  const catalog = await loadCatalog(
    client,
    analyses.map((entry) => entry.analysis)
  )
  return {
    catalogFacts: {
      checkConstraintLiteralUnions: catalog.checkConstraintTypesByColumn.size,
      columns: catalog.columns.size,
      procs: catalog.procs.size,
      types: catalog.types.size,
      uniqueIndexes: [...catalog.uniqueIndexesByRelid.values()].reduce((count, entries) => count + entries.length, 0),
    },
    queries: analyses.map(({ analysis, config }) => normalizeCompiledIr(catalog, config, analysis)),
  }
}

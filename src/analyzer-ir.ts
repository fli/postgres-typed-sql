/* oxlint-disable eslint/no-use-before-define -- The analyzer IR traversal uses small mutually recursive local helpers. */

import {
  checkConstraintLiteralUnionColumnKey,
  loadCheckConstraintLiteralUnionFacts,
  type CheckConstraintLiteralUnionFact,
} from './check-constraint-type-facts.js'
import type { PostgresQueryable } from './database.js'
import { typeScriptTypeForPostgresType } from './postgres-types.js'
import { pascalCaseIdentifier, quotePropertyName } from './typescript-names.js'

const ANALYZER_SCHEMA_VERSION = 3
const ANALYZER_SQL_FUNCTION = 'pg_temp.postgres_typed_sql_analyze'

export interface TypedSqlPostgresIr {
  readonly analyzerSchemaVersion: number
  readonly command: string
  readonly diagnostics: readonly string[]
  readonly hasDataModifyingCte: boolean
  readonly isWrite: boolean
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
  readonly nullable: boolean
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
  readonly tsTypeSource?: 'checkConstraint'
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
  readonly rawStatementCount: number
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
  readonly rewrittenQueryCount: number
}

interface PgAnalyzerQuery {
  readonly canSetTag: boolean
  readonly commandType: string
  readonly cteList?: readonly PgAnalyzerCte[]
  readonly dmlParameterTargets: readonly PgAnalyzerDmlParameterTarget[]
  readonly distinctClauseCount?: number
  readonly groupClauseCount?: number
  readonly groupingSetsCount?: number
  readonly hasAggs?: boolean
  readonly hasHavingQual?: boolean
  readonly hasLimitOffset?: boolean
  readonly hasLimitCount?: boolean
  readonly hasModifyingCTE?: boolean
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

interface PgAnalyzerDmlParameterTarget {
  readonly paramId: number
  readonly source: 'INSERT' | 'MERGE_INSERT' | 'MERGE_UPDATE' | 'ON_CONFLICT_UPDATE' | 'UPDATE'
  readonly targetAttname: string
  readonly targetAttnum: number
  readonly targetNullable: boolean
  readonly targetRelid: number
  readonly targetTypeName: string | null
  readonly targetTypeOid: number
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
  readonly condition?: PgAnalyzerExpr | null
  readonly defresult?: PgAnalyzerExpr | null
  readonly elements?: readonly PgAnalyzerExpr[]
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
  readonly subLinkType?: string
  readonly subquery?: PgAnalyzerQuery | null
  readonly tag: string
  readonly testExpr?: PgAnalyzerExpr | null
  readonly typeName?: string
  readonly typeOid?: number
  readonly varattno?: number
  readonly varlevelsup?: number
  readonly varno?: number
  readonly varnullingrels?: readonly number[]
  readonly whenClauses?: readonly PgAnalyzerExpr[]
}

interface AnalyzedCompiledConfig {
  readonly analysis: PgAnalyzerResult
  readonly config: TypedSqlPostgresIrCompiledConfig
  readonly primaryQuery: PgAnalyzerQuery
  readonly rewrittenQueries: readonly PgAnalyzerQuery[]
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

function tsTypeForPgType(typeFact: Pick<TypedSqlPostgresIrColumn, 'pgType' | 'pgTypeName' | 'pgTypeSchema'>): string {
  return typeScriptTypeForPostgresType(typeFact)
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
  for (const key of ['arg', 'condition', 'defresult', 'expr', 'result', 'testExpr'] as const) {
    const child = expr[key]
    if (child) {
      children.push(child)
    }
  }
  children.push(...(expr.elements ?? []))
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

type LimitFact =
  | { readonly kind: 'absent' | 'unbounded' }
  | { readonly kind: 'constant'; readonly value: number }
  | { readonly kind: 'dynamic' }

function limitFact(query: PgAnalyzerQuery): LimitFact {
  if (query.hasLimitCount !== true) {
    return { kind: 'absent' }
  }

  const unwrapped = unwrapTransparentExpr(query.limitCount)
  if (unwrapped?.tag === 'Const' && unwrapped.constIsNull === true) {
    return { kind: 'unbounded' }
  }

  const value = constNonNegativeSafeInteger(query.limitCount)
  return value === null ? { kind: 'dynamic' } : { kind: 'constant', value }
}

function applyLimitBounds(query: PgAnalyzerQuery, base: TypedSqlPostgresIrRowBounds): TypedSqlPostgresIrRowBounds {
  const limit = limitFact(query)
  const hasOffset = query.hasLimitOffset === true
  if ((limit.kind === 'absent' || limit.kind === 'unbounded') && !hasOffset) {
    return base
  }

  const maxAfterLimit =
    limit.kind === 'constant' ? (base.max === null ? limit.value : Math.min(base.max, limit.value)) : base.max
  const minAfterLimit =
    hasOffset || limit.kind === 'dynamic' || (limit.kind === 'constant' && limit.value === 0) ? 0 : base.min

  return {
    max: maxAfterLimit,
    min: maxAfterLimit === 0 ? 0 : Math.min(minAfterLimit, maxAfterLimit ?? minAfterLimit),
    proof: [
      base.proof,
      limit.kind === 'constant' ? `constant_limit_${limit.value}` : null,
      limit.kind === 'dynamic' ? 'dynamic_limit_can_drop_rows' : null,
      hasOffset ? 'offset_can_drop_rows' : null,
    ]
      .filter((part): part is string => part !== null)
      .join('+'),
  }
}

interface UniqueProofRelation {
  readonly relid: number
  readonly varno: number
}

function uniqueProofRelation(query: PgAnalyzerQuery): UniqueProofRelation | null {
  const rtable = query.rtable ?? []
  if (query.commandType === 'SELECT') {
    const rowSources = rtable.map((rte, index) => ({ rte, varno: index + 1 })).filter(({ rte }) => rte.kind !== 'JOIN')
    const source = rowSources.length === 1 ? rowSources[0] : undefined
    return source?.rte.kind === 'RELATION' && typeof source.rte.relid === 'number'
      ? { relid: source.rte.relid, varno: source.varno }
      : null
  }

  if (query.commandType !== 'UPDATE' && query.commandType !== 'DELETE') {
    return null
  }

  const varno = query.resultRelation
  if (!varno) {
    return null
  }
  const target = rtable[varno - 1]
  return target?.kind === 'RELATION' && typeof target.relid === 'number' ? { relid: target.relid, varno } : null
}

function isParamOrConstValue(expr: PgAnalyzerExpr | null | undefined): boolean {
  const unwrapped = unwrapTransparentExpr(expr)
  return unwrapped?.tag === 'Param' || unwrapped?.tag === 'Const'
}

function constrainedAttnumsFromQual(
  expr: PgAnalyzerExpr | null | undefined,
  relation: UniqueProofRelation,
  output = new Set<number>()
): ReadonlySet<number> {
  if (!expr) {
    return output
  }

  if (expr.tag === 'BoolExpr' && expr.boolOp === 'AND') {
    for (const child of exprChildren(expr)) {
      constrainedAttnumsFromQual(child, relation, output)
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
  if (
    leftVar?.tag === 'Var' &&
    leftVar.relid === relation.relid &&
    leftVar.varno === relation.varno &&
    (leftVar.varlevelsup ?? 0) === 0 &&
    leftVar.varattno &&
    isParamOrConstValue(right)
  ) {
    output.add(leftVar.varattno)
  } else if (
    rightVar?.tag === 'Var' &&
    rightVar.relid === relation.relid &&
    rightVar.varno === relation.varno &&
    (rightVar.varlevelsup ?? 0) === 0 &&
    rightVar.varattno &&
    isParamOrConstValue(left)
  ) {
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

  const relation = uniqueProofRelation(query)
  if (!relation || !query.whereQual) {
    return null
  }

  const constrainedAttnums = constrainedAttnumsFromQual(query.whereQual, relation)
  const uniqueIndex = catalog.uniqueIndexesByRelid
    .get(relation.relid)
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

function walkDirectQueryExpressions(query: PgAnalyzerQuery, visitExpr: (expr: PgAnalyzerExpr) => void): void {
  for (const target of [...(query.targetList ?? []), ...(query.returningList ?? [])]) {
    walkExpr(target.expr, visitExpr)
  }
  walkExpr(query.whereQual, visitExpr)
}

function walkQueryTree(query: PgAnalyzerQuery, visitQuery: (query: PgAnalyzerQuery) => void): void {
  visitQuery(query)
  for (const rte of query.rtable ?? []) {
    if (rte.subquery) {
      walkQueryTree(rte.subquery, visitQuery)
    }
  }
  for (const cte of query.cteList ?? []) {
    if (cte.query) {
      walkQueryTree(cte.query, visitQuery)
    }
  }
  walkDirectQueryExpressions(query, (expr) => {
    if (expr.subquery) {
      walkQueryTree(expr.subquery, visitQuery)
    }
  })
}

function queryHasDataModifyingCte(query: PgAnalyzerQuery): boolean {
  if (query.hasModifyingCTE === true) {
    return true
  }

  let hasDataModifyingCte = false
  walkQueryTree(query, (nested) => {
    if (nested !== query && isDataModifyingCommand(nested.commandType)) {
      hasDataModifyingCte = true
    }
  })
  return hasDataModifyingCte
}

function queryTreeIsWrite(query: PgAnalyzerQuery): boolean {
  let isWrite = query.hasModifyingCTE === true
  walkQueryTree(query, (nested) => {
    if (isDataModifyingCommand(nested.commandType)) {
      isWrite = true
    }
  })
  return isWrite
}

function dmlParameterNullability(queries: readonly PgAnalyzerQuery[]): ReadonlyMap<number, boolean> {
  const nullableByParamId = new Map<number, boolean>()
  for (const query of queries) {
    walkQueryTree(query, (nested) => {
      for (const target of nested.dmlParameterTargets) {
        nullableByParamId.set(target.paramId, (nullableByParamId.get(target.paramId) ?? true) && target.targetNullable)
      }
    })
  }
  return nullableByParamId
}

function walkQuery(query: PgAnalyzerQuery, visitExpr: (expr: PgAnalyzerExpr) => void): void {
  walkQueryTree(query, (nested) => {
    walkDirectQueryExpressions(nested, visitExpr)
  })
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
  walkQueryTree(query, (nested) => {
    for (const rte of nested.rtable ?? []) {
      if (rte.kind === 'RELATION' && typeof rte.relid === 'number') {
        visitRelid(rte.relid)
      }
    }
  })
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

function collectNonNullVarKeys(expr: PgAnalyzerExpr | null | undefined): ReadonlySet<string> {
  if (expr?.tag === 'NullTest' && expr.nullTestType === 'IS_NOT_NULL') {
    const key = exprKey(expr.arg)
    return key ? new Set([key]) : new Set()
  }

  if (expr?.tag !== 'BoolExpr' || expr.boolOp === 'NOT') {
    return new Set()
  }

  const branches = exprChildren(expr).map(collectNonNullVarKeys)
  if (expr.boolOp === 'AND') {
    return new Set(branches.flatMap((branch) => [...branch]))
  }

  if (expr.boolOp === 'OR' && branches.length > 0) {
    const [first, ...rest] = branches
    return new Set([...(first ?? [])].filter((key) => rest.every((branch) => branch.has(key))))
  }

  return new Set()
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

function checkedColumnParamTypes(
  catalog: CatalogFacts,
  queries: readonly PgAnalyzerQuery[],
  paramTypeOids: readonly number[]
): ReadonlyMap<number, string> {
  const candidates = new Map<number, Set<string>>()
  for (const query of queries) {
    walkQueryTree(query, (nested) => {
      for (const target of nested.dmlParameterTargets) {
        if (paramTypeOids[target.paramId - 1] !== target.targetTypeOid) {
          continue
        }

        const fact = catalog.checkConstraintTypesByColumn.get(
          checkConstraintLiteralUnionColumnKey({
            attnum: target.targetAttnum,
            relid: target.targetRelid,
          })
        )
        if (!fact) {
          continue
        }

        const types = candidates.get(target.paramId) ?? new Set<string>()
        types.add(fact.typeName)
        candidates.set(target.paramId, types)
      }
    })
  }

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
  if (expr.tag === 'NullTest' || expr.tag === 'BooleanTest') {
    return false
  }
  if (expr.tag === 'SubLink') {
    return expr.subLinkType !== 'EXISTS' && expr.subLinkType !== 'ARRAY'
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
        nullable: param.nullable,
        propertyName: param.propertyName,
        tsType: param.tsType,
      }))
    ),
    '',
    renderInterface(
      `${baseName}Row`,
      ir.resultColumns.map((entry, index) => ({
        nullable: entry.nullable,
        propertyName: entry.name ?? `column_${index + 1}`,
        tsType: entry.tsType,
      }))
    ),
  ].join('\n')
}

function normalizeCompiledIr(catalog: CatalogFacts, analyzed: AnalyzedCompiledConfig): TypedSqlPostgresIr {
  const { analysis, config, primaryQuery: query, rewrittenQueries } = analyzed

  const resultColumns = resultTargets(query).map((target): TypedSqlPostgresIrColumn => {
    const expr = target.expr
    const typeFact = typeFactForOid(catalog, expr?.typeOid, expr?.typeName)
    const checkConstraintTsType = checkConstraintTypeForExpr(catalog, query, expr)
    const tsType = checkConstraintTsType ?? tsTypeForPgType(typeFact)
    return {
      jsonShape: isJsonType(typeFact.pgTypeName) ? (inferJsonShape(catalog, query, expr) ?? undefined) : undefined,
      name: target.resname ?? null,
      nullable: expressionNullable(catalog, query, expr),
      ...typeFact,
      source: sourceForExpr(expr),
      tsType,
      ...(checkConstraintTsType ? { tsTypeSource: 'checkConstraint' as const } : {}),
    }
  })

  const checkConstraintParamTypes = checkedColumnParamTypes(catalog, rewrittenQueries, analysis.paramTypeOids)
  const nullableByParamId = dmlParameterNullability(rewrittenQueries)
  const params = config.parameterNames.map((name, index): TypedSqlPostgresIrParam => {
    const oid = analysis.paramTypeOids[index]
    const typeFact = typeFactForOid(catalog, oid, config.parameterTypes?.[index])
    const checkConstraintTsType = checkConstraintParamTypes.get(index + 1)
    return {
      name,
      nullable: nullableByParamId.get(index + 1) ?? false,
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
    hasDataModifyingCte: rewrittenQueries.some(queryHasDataModifyingCte),
    isWrite: rewrittenQueries.some(queryTreeIsWrite),
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

async function analyzeCompiledConfig(
  client: PostgresQueryable,
  config: TypedSqlPostgresIrCompiledConfig
): Promise<AnalyzedCompiledConfig> {
  const result = await client.query<{ readonly analysis: PgAnalyzerResult }>(
    `select ${ANALYZER_SQL_FUNCTION}($1, $2::oid[])::jsonb as analysis`,
    [config.sql, await explicitCompiledParamTypeOids(client, config)]
  )
  const analysis = result.rows[0]?.analysis
  if (!analysis || analysis.schemaVersion !== ANALYZER_SCHEMA_VERSION) {
    throw new Error('analyzer returned unsupported schema.')
  }
  if (analysis.rawStatementCount !== 1) {
    throw new Error(`typed SQL must contain exactly one PostgreSQL statement; received ${analysis.rawStatementCount}.`)
  }
  if (analysis.statements.length !== 1) {
    throw new Error(`analyzer returned ${analysis.statements.length} statement envelopes for one raw statement.`)
  }
  if (analysis.paramTypeOids.length !== config.parameterNames.length) {
    throw new Error(
      `analyzer returned ${analysis.paramTypeOids.length} parameter types for ${config.parameterNames.length} compiled parameters.`
    )
  }

  const statement = analysis.statements[0]
  if (!statement || statement.rewrittenQueryCount !== statement.queries.length) {
    throw new Error('analyzer returned an inconsistent rewritten-query envelope.')
  }
  const tagSettingQueries = statement.queries.filter((query) => query.canSetTag)
  if (tagSettingQueries.length !== 1) {
    throw new Error(`expected exactly one tag-setting rewritten query; received ${tagSettingQueries.length}.`)
  }

  return {
    analysis,
    config,
    primaryQuery: tagSettingQueries[0] as PgAnalyzerQuery,
    rewrittenQueries: statement.queries,
  }
}

export async function buildTypedSqlPostgresIrFromCompiledConfigs(
  client: PostgresQueryable,
  configs: readonly TypedSqlPostgresIrCompiledConfig[]
): Promise<TypedSqlPostgresIrBuildResult> {
  const analyses: AnalyzedCompiledConfig[] = []
  for (const config of configs) {
    try {
      analyses.push(await analyzeCompiledConfig(client, config))
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
    queries: analyses.map((analyzed) => normalizeCompiledIr(catalog, analyzed)),
  }
}

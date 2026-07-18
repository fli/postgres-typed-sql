/* oxlint-disable eslint/no-use-before-define -- The analyzer IR traversal uses small mutually recursive local helpers. */

import {
  checkConstraintLiteralUnionColumnKey,
  loadCheckConstraintLiteralUnionFacts,
  type CheckConstraintLiteralUnionFact,
} from './check-constraint-type-facts.js'
import {
  checkConstraintTypeKey,
  intersectJsonShapes,
  joinJsonShapes,
  jsonShapeWithNullability,
  unionJsonShapes,
  type TypedSqlPostgresIr,
  type TypedSqlPostgresIrCheckConstraintTypeExpression,
  type TypedSqlPostgresIrColumn,
  type TypedSqlPostgresIrColumnSource,
  type TypedSqlPostgresIrCompiledConfig,
  type TypedSqlPostgresIrJsonField,
  type TypedSqlPostgresIrJsonShape,
  type TypedSqlPostgresIrParam,
  type TypedSqlPostgresIrParamNullAdmission,
  type TypedSqlPostgresIrRowBounds,
  type TypedSqlPostgresIrRowCardinality,
} from './analyzer-ir-model.js'
import type { PostgresQueryable } from './database.js'
import { loadPostgresTypeFacts } from './postgres-type-facts.js'
import { postgresJsonSupportsStringLiteralRefinement, type PostgresTypeFact } from './postgres-types.js'

export type {
  TypedSqlPostgresIr,
  TypedSqlPostgresIrCheckConstraintTypeExpression,
  TypedSqlPostgresIrColumn,
  TypedSqlPostgresIrColumnSource,
  TypedSqlPostgresIrCompiledConfig,
  TypedSqlPostgresIrJsonField,
  TypedSqlPostgresIrJsonShape,
  TypedSqlPostgresIrParam,
  TypedSqlPostgresIrParamNullAdmission,
  TypedSqlPostgresIrRowBounds,
  TypedSqlPostgresIrRowCardinality,
} from './analyzer-ir-model.js'

const ANALYZER_SCHEMA_VERSION = 6
const ANALYZER_SQL_FUNCTION = 'pg_temp.postgres_typed_sql_analyze'

interface PgAnalyzerResult {
  readonly paramTypeOids: readonly number[]
  readonly paramTypeNullAdmissions: readonly TypedSqlPostgresIrParamNullAdmission[]
  readonly paramUsageNullAdmissions: readonly TypedSqlPostgresIrParamNullAdmission[]
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
  readonly hasRowMarks?: boolean
  readonly hasSetOperations?: boolean
  readonly hasTargetSRFs?: boolean
  readonly hasVolatileFunctions?: boolean
  readonly hasWindowFuncs?: boolean
  readonly limitCount?: PgAnalyzerExpr | null
  readonly limitWithTies?: boolean
  readonly returningList?: readonly PgAnalyzerTarget[]
  readonly resultRelation?: number
  readonly rtable?: readonly PgAnalyzerRte[]
  readonly setOperation?: PgAnalyzerSetOperation | null
  readonly targetList?: readonly PgAnalyzerTarget[]
  readonly utilityKind?: 'CALL' | 'EXECUTE' | 'EXPLAIN' | 'FETCH' | 'NONE' | 'OTHER' | 'SHOW'
  readonly utilityReturnsTuples?: boolean
  readonly whereQual?: PgAnalyzerExpr | null
}

type PgAnalyzerSetOperation =
  | {
      readonly kind: 'leaf'
      readonly rtindex: number
    }
  | {
      readonly all: boolean
      readonly kind: 'operation'
      readonly left: PgAnalyzerSetOperation
      readonly operation: 'EXCEPT' | 'INTERSECT' | 'UNION'
      readonly right: PgAnalyzerSetOperation
    }

interface PgAnalyzerDmlParameterTarget {
  readonly directAssignment: boolean
  readonly paramId: number
  readonly source: 'INSERT' | 'MERGE_INSERT' | 'MERGE_UPDATE' | 'ON_CONFLICT_UPDATE' | 'UPDATE'
  readonly targetAttname: string
  readonly targetAttnum: number
  readonly targetNullAdmission: TypedSqlPostgresIrParamNullAdmission
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
  readonly cteLevelSup?: number
  readonly erefColumnNames?: readonly string[]
  readonly inh?: boolean
  readonly kind: string
  readonly relid?: number | null
  readonly subquery?: PgAnalyzerQuery
}

interface PgAnalyzerExpr {
  readonly aggfnoid?: number
  readonly aggname?: string
  readonly arg?: PgAnalyzerExpr | null
  readonly args?: readonly (PgAnalyzerExpr | { readonly expr?: PgAnalyzerExpr | null })[]
  readonly attname?: string
  readonly boolOp?: string
  readonly constInteger?: string
  readonly constEmptyJsonArray?: boolean
  readonly constIsNull?: boolean
  readonly constString?: string
  readonly condition?: PgAnalyzerExpr | null
  readonly defresult?: PgAnalyzerExpr | null
  readonly elements?: readonly PgAnalyzerExpr[]
  readonly expr?: PgAnalyzerExpr | null
  readonly funcid?: number
  readonly funcname?: string
  readonly funcVariadic?: boolean
  readonly inputCollationOid?: number
  readonly multidims?: boolean
  readonly nullTestType?: string
  readonly opfuncid?: number
  readonly opno?: number
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
  readonly truncated?: boolean
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

interface ProcCatalogRow {
  readonly is_builtin: boolean
  readonly oid: number
  readonly proname: string
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
  readonly collation_oids: readonly number[]
  readonly has_inheritors: boolean
  readonly index_name: string
  readonly indexrelid: number
  readonly indisprimary: boolean
  readonly opfamily_oids: readonly number[]
  readonly relkind: string
  readonly relid: number
}

interface UniqueEqualityOperatorCatalogRow {
  readonly amopfamily: number
  readonly amopopr: number
}

interface CatalogFacts {
  readonly checkConstraintTypesByColumn: ReadonlyMap<string, CheckConstraintLiteralUnionFact>
  readonly columns: ReadonlyMap<string, ColumnCatalogRow>
  readonly procs: ReadonlyMap<number, ProcCatalogRow>
  readonly types: ReadonlyMap<number, PostgresTypeFact>
  readonly uniqueEqualityOperators: ReadonlySet<string>
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

type VarKey = string
type NonNullFacts = ReadonlyMap<PgAnalyzerQuery, ReadonlySet<VarKey>>

interface VarLocation {
  readonly key: VarKey
  readonly query: PgAnalyzerQuery
}

const noNonNullFacts: NonNullFacts = new Map()

interface QueryScope {
  readonly nonNullVars: NonNullFacts
  readonly parent: QueryScope | null
  readonly query: PgAnalyzerQuery
}

function queryScope(query: PgAnalyzerQuery, parent: QueryScope | null = null): QueryScope {
  return scopeWithQual({ nonNullVars: parent?.nonNullVars ?? noNonNullFacts, parent, query }, query.whereQual)
}

function queryScopeAtLevel(scope: QueryScope, levelsUp: number): QueryScope | null {
  let owner: QueryScope | null = scope
  for (let level = 0; owner && level < levelsUp; level += 1) {
    owner = owner.parent
  }
  return owner
}

function queryScopeForRteOutput(ownerScope: QueryScope, rte: PgAnalyzerRte): QueryScope | null {
  if (rte.kind === 'SUBQUERY' && rte.subquery) {
    return queryScope(rte.subquery, ownerScope)
  }
  if (rte.kind !== 'CTE') {
    return null
  }

  const cteOwnerScope = queryScopeAtLevel(ownerScope, rte.cteLevelSup ?? 0)
  const cteQuery = cteOwnerScope ? cteByName(cteOwnerScope.query, rte.cteName)?.query : undefined
  return cteQuery && cteOwnerScope ? queryScope(cteQuery, cteOwnerScope) : null
}

function varOwnerRte(scope: QueryScope, expr: PgAnalyzerExpr): readonly [QueryScope, PgAnalyzerRte] | null {
  if (expr.tag !== 'Var' || !expr.varno) {
    return null
  }

  const ownerScope = queryScopeAtLevel(scope, expr.varlevelsup ?? 0)
  const rte = ownerScope?.query.rtable?.[expr.varno - 1]
  return ownerScope && rte ? [ownerScope, rte] : null
}

interface QueryOutputSemantics<T> {
  readonly except: (left: T, right: T) => T
  readonly intersect: (left: T, right: T) => T
  readonly target: (scope: QueryScope, target: PgAnalyzerTarget) => T
  readonly union: (left: T, right: T) => T
  readonly unknown: () => T
}

function foldQueryOutput<T>(scope: QueryScope, outputIndex: number, semantics: QueryOutputSemantics<T>): T {
  const { query } = scope
  const foldSetOperation = (operation: PgAnalyzerSetOperation): T => {
    if (operation.kind === 'leaf') {
      const leafQuery = query.rtable?.[operation.rtindex - 1]?.subquery
      return leafQuery ? foldQueryOutput(queryScope(leafQuery, scope), outputIndex, semantics) : semantics.unknown()
    }

    const left = foldSetOperation(operation.left)
    const right = foldSetOperation(operation.right)
    switch (operation.operation) {
      case 'UNION':
        return semantics.union(left, right)
      case 'INTERSECT':
        return semantics.intersect(left, right)
      case 'EXCEPT':
        return semantics.except(left, right)
    }
  }

  if (query.setOperation) {
    return foldSetOperation(query.setOperation)
  }

  const target = resultTargets(query)[outputIndex]
  return target ? semantics.target(scope, target) : semantics.unknown()
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

function constNonNegativeSafeInteger(catalog: CatalogFacts, expr: PgAnalyzerExpr | null | undefined): number | null {
  const unwrapped = unwrapCoercionExpr(expr)
  if (
    unwrapped?.tag === 'FuncExpr' &&
    isBuiltinPgProcNamed(catalog, unwrapped.funcid, 'int8') &&
    unwrapped.args?.length === 1
  ) {
    return constNonNegativeSafeInteger(catalog, targetExprFromAggregateArg(unwrapped.args[0]))
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

function limitFact(catalog: CatalogFacts, query: PgAnalyzerQuery): LimitFact {
  if (query.hasLimitCount !== true) {
    return { kind: 'absent' }
  }

  const unwrapped = unwrapCoercionExpr(query.limitCount)
  if (unwrapped?.tag === 'Const' && unwrapped.constIsNull === true) {
    return { kind: 'unbounded' }
  }

  const value = constNonNegativeSafeInteger(catalog, query.limitCount)
  return value === null ? { kind: 'dynamic' } : { kind: 'constant', value }
}

function applyLimitBounds(
  catalog: CatalogFacts,
  query: PgAnalyzerQuery,
  base: TypedSqlPostgresIrRowBounds
): TypedSqlPostgresIrRowBounds {
  const limit = limitFact(catalog, query)
  const hasOffset = query.hasLimitOffset === true
  if ((limit.kind === 'absent' || limit.kind === 'unbounded') && !hasOffset) {
    return base
  }

  const maxAfterLimit =
    limit.kind === 'constant' && (query.limitWithTies !== true || limit.value === 0)
      ? base.max === null
        ? limit.value
        : Math.min(base.max, limit.value)
      : base.max
  const minAfterLimit =
    hasOffset || limit.kind === 'dynamic' || (limit.kind === 'constant' && limit.value === 0) ? 0 : base.min

  return {
    max: maxAfterLimit,
    min: maxAfterLimit === 0 ? 0 : Math.min(minAfterLimit, maxAfterLimit ?? minAfterLimit),
    proof: [
      base.proof,
      limit.kind === 'constant'
        ? query.limitWithTies === true
          ? `constant_fetch_with_ties_${limit.value}`
          : `constant_limit_${limit.value}`
        : null,
      limit.kind === 'dynamic' ? 'dynamic_limit_can_drop_rows' : null,
      hasOffset ? 'offset_can_drop_rows' : null,
    ]
      .filter((part): part is string => part !== null)
      .join('+'),
  }
}

interface UniqueProofRelation {
  readonly inh: boolean
  readonly relid: number
  readonly varno: number
}

function uniqueProofRelation(query: PgAnalyzerQuery): UniqueProofRelation | null {
  const rtable = query.rtable ?? []
  if (query.commandType === 'SELECT') {
    const rowSources = rtable.map((rte, index) => ({ rte, varno: index + 1 })).filter(({ rte }) => rte.kind !== 'JOIN')
    const source = rowSources.length === 1 ? rowSources[0] : undefined
    return source?.rte.kind === 'RELATION' && typeof source.rte.relid === 'number'
      ? { inh: source.rte.inh === true, relid: source.rte.relid, varno: source.varno }
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
  return target?.kind === 'RELATION' && typeof target.relid === 'number'
    ? { inh: target.inh === true, relid: target.relid, varno }
    : null
}

function isParamOrConstValue(expr: PgAnalyzerExpr | null | undefined): boolean {
  const unwrapped = unwrapValuePreservingExpr(expr)
  return unwrapped?.tag === 'Param' || unwrapped?.tag === 'Const'
}

interface EqualityConstraint {
  readonly attnum: number
  readonly inputCollationOid: number
  readonly opno: number
}

function equalityConstraintsFromQual(
  expr: PgAnalyzerExpr | null | undefined,
  relation: UniqueProofRelation,
  output: EqualityConstraint[] = []
): readonly EqualityConstraint[] {
  if (!expr) {
    return output
  }

  if (expr.tag === 'BoolExpr' && expr.boolOp === 'AND') {
    for (const child of exprChildren(expr)) {
      equalityConstraintsFromQual(child, relation, output)
    }
    return output
  }

  if (expr.tag !== 'OpExpr' || !expr.opno || expr.args?.length !== 2) {
    return output
  }

  const left = targetExprFromAggregateArg(expr.args[0])
  const right = targetExprFromAggregateArg(expr.args[1])
  const leftVar = unwrapValuePreservingExpr(left)
  const rightVar = unwrapValuePreservingExpr(right)
  let attnum: number | undefined
  if (
    leftVar?.tag === 'Var' &&
    leftVar.relid === relation.relid &&
    leftVar.varno === relation.varno &&
    (leftVar.varlevelsup ?? 0) === 0 &&
    leftVar.varattno &&
    isParamOrConstValue(right)
  ) {
    attnum = leftVar.varattno
  } else if (
    rightVar?.tag === 'Var' &&
    rightVar.relid === relation.relid &&
    rightVar.varno === relation.varno &&
    (rightVar.varlevelsup ?? 0) === 0 &&
    rightVar.varattno &&
    isParamOrConstValue(left)
  ) {
    attnum = rightVar.varattno
  }
  if (attnum) {
    output.push({
      attnum,
      inputCollationOid: expr.inputCollationOid ?? 0,
      opno: expr.opno,
    })
  }

  return output
}

function uniqueEqualityOperatorKey(opfamilyOid: number, operatorOid: number): string {
  return `${opfamilyOid}:${operatorOid}`
}

function uniqueIndexIsConstrained(
  catalog: CatalogFacts,
  index: UniqueIndexCatalogRow,
  constraints: readonly EqualityConstraint[]
): boolean {
  return index.attnums.every((attnum, keyIndex) =>
    constraints.some(
      (constraint) =>
        constraint.attnum === attnum &&
        constraint.inputCollationOid === index.collation_oids[keyIndex] &&
        catalog.uniqueEqualityOperators.has(
          uniqueEqualityOperatorKey(index.opfamily_oids[keyIndex] ?? 0, constraint.opno)
        )
    )
  )
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

  const constraints = equalityConstraintsFromQual(query.whereQual, relation)
  const uniqueIndex = catalog.uniqueIndexesByRelid
    .get(relation.relid)
    ?.find(
      (index) =>
        !(relation.inh && index.has_inheritors && index.relkind !== 'p') &&
        uniqueIndexIsConstrained(catalog, index, constraints)
    )
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
  if (resultColumnCount === 0 && query.commandType !== 'SELECT') {
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
      if (hasGrouping) {
        return { max: null, min: 0, proof: 'select_without_from_with_grouping' }
      }
      return query.whereQual || query.hasHavingQual === true
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
  return applyLimitBounds(catalog, query, inferBaseRowBounds(catalog, query, resultColumnCount))
}

function isDataModifyingCommand(commandType: string | undefined): boolean {
  return commandType === 'UPDATE' || commandType === 'INSERT' || commandType === 'DELETE' || commandType === 'MERGE'
}

function walkDirectQueryExpressions(query: PgAnalyzerQuery, visitExpr: (expr: PgAnalyzerExpr) => void): void {
  for (const target of [...(query.targetList ?? []), ...(query.returningList ?? [])]) {
    walkExpr(target.expr, visitExpr)
  }
  walkExpr(query.whereQual, visitExpr)
  walkExpr(query.limitCount, visitExpr)
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
  return (
    isDataModifyingCommand(query.commandType) ||
    query.commandType === 'UTILITY' ||
    query.hasModifyingCTE === true ||
    query.hasRowMarks === true ||
    query.hasVolatileFunctions === true
  )
}

function combineParameterNullAdmission(
  current: TypedSqlPostgresIrParamNullAdmission | undefined,
  next: TypedSqlPostgresIrParamNullAdmission
): TypedSqlPostgresIrParamNullAdmission {
  if (current === 'rejects' || next === 'rejects') {
    return 'rejects'
  }
  if (current === 'unknown' || next === 'unknown') {
    return 'unknown'
  }
  return 'accepts'
}

function dmlParameterNullAdmissions(
  queries: readonly PgAnalyzerQuery[],
  paramTypeNullAdmissions: readonly TypedSqlPostgresIrParamNullAdmission[],
  paramUsageNullAdmissions: readonly TypedSqlPostgresIrParamNullAdmission[]
): ReadonlyMap<number, TypedSqlPostgresIrParamNullAdmission> {
  const admissionByParamId = new Map<number, TypedSqlPostgresIrParamNullAdmission>()
  for (const [index, admission] of paramTypeNullAdmissions.entries()) {
    admissionByParamId.set(
      index + 1,
      combineParameterNullAdmission(admission, paramUsageNullAdmissions[index] ?? 'unknown')
    )
  }
  for (const query of queries) {
    walkQueryTree(query, (nested) => {
      for (const target of nested.dmlParameterTargets) {
        admissionByParamId.set(
          target.paramId,
          combineParameterNullAdmission(admissionByParamId.get(target.paramId), target.targetNullAdmission)
        )
      }
    })
  }
  return admissionByParamId
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
        for (const oid of [expr.aggfnoid, expr.funcid, expr.opfuncid]) {
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

  const types = await loadPostgresTypeFacts(client, [...typeOids])

  const procs = new Map<number, ProcCatalogRow>()
  if (procOids.size > 0) {
    const result = await client.query<ProcCatalogRow>(
      `
        select
          p.oid < 16384 and namespace.nspname = 'pg_catalog' as is_builtin,
          p.oid::int as oid,
          p.proname
        from pg_proc p
        join pg_namespace namespace
          on namespace.oid = p.pronamespace
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
  const uniqueEqualityOperators = new Set<string>()
  if (relationRelids.size > 0) {
    const result = await client.query<UniqueIndexCatalogRow>(
      `
        select
          i.indrelid::int as relid,
          i.indexrelid::int as indexrelid,
          index_class.relname as index_name,
          i.indisprimary,
          relation_class.relkind,
          exists (
            select 1
            from pg_inherits inheritance
            where inheritance.inhparent = i.indrelid
          ) as has_inheritors,
          array_agg(key.attnum::int order by key.ordinality) as attnums,
          array_agg(key.collation_oid::int order by key.ordinality) as collation_oids,
          array_agg(opclass.opcfamily::int order by key.ordinality) as opfamily_oids
        from pg_index i
        join pg_class index_class
          on index_class.oid = i.indexrelid
        join pg_class relation_class
          on relation_class.oid = i.indrelid
        cross join lateral unnest(
          i.indkey::smallint[],
          i.indclass::oid[],
          i.indcollation::oid[]
        ) with ordinality as key(attnum, opclass_oid, collation_oid, ordinality)
        join pg_opclass opclass
          on opclass.oid = key.opclass_oid
        join pg_am access_method
          on access_method.oid = opclass.opcmethod
         and access_method.amname = 'btree'
        where i.indrelid = any($1::oid[])
          and i.indisunique
          and i.indisvalid
          and i.indimmediate
          and i.indpred is null
          and i.indexprs is null
          and key.ordinality <= i.indnkeyatts
          and key.attnum > 0
        group by
          i.indrelid,
          i.indexrelid,
          index_class.relname,
          i.indisprimary,
          relation_class.relkind
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

    const opfamilyOids = [...new Set(result.rows.flatMap((row) => row.opfamily_oids))]
    if (opfamilyOids.length > 0) {
      const equalityResult = await client.query<UniqueEqualityOperatorCatalogRow>(
        `
          select
            operator.amopfamily::int as amopfamily,
            operator.amopopr::int as amopopr
          from pg_amop operator
          join pg_operator definition
            on definition.oid = operator.amopopr
          join pg_proc implementation
            on implementation.oid = definition.oprcode
          join pg_am access_method
            on access_method.oid = operator.amopmethod
          where operator.amopfamily = any($1::oid[])
            and operator.amopstrategy = 3
            and operator.amoppurpose = 's'
            and access_method.amname = 'btree'
            and implementation.proisstrict
        `,
        [opfamilyOids]
      )
      for (const row of equalityResult.rows) {
        uniqueEqualityOperators.add(uniqueEqualityOperatorKey(row.amopfamily, row.amopopr))
      }
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
    uniqueEqualityOperators,
    uniqueIndexesByRelid,
  }
}

function typeFactForOid(
  catalog: CatalogFacts,
  oid: number | undefined,
  fallback: string | undefined
): PostgresTypeFact {
  if (oid) {
    const type = catalog.types.get(oid)
    if (type) {
      return type
    }
    return {
      pgType: fallback ?? `oid:${oid}`,
      pgTypeKind: 'unknown',
      pgTypeName: `oid_${oid}`,
      pgTypeOid: oid,
      pgTypeSchema: 'unknown',
    }
  }

  return {
    pgType: fallback ?? 'unknown',
    pgTypeKind: 'unknown',
    pgTypeName: fallback ?? 'unknown',
    pgTypeOid: 0,
    pgTypeSchema: 'unknown',
  }
}

function varLocation(scope: QueryScope, expr: PgAnalyzerExpr | null | undefined): VarLocation | null {
  if (!expr || expr.tag !== 'Var' || expr.varno === undefined || expr.varattno === undefined) {
    return null
  }
  const ownerScope = queryScopeAtLevel(scope, expr.varlevelsup ?? 0)
  return ownerScope ? { key: `${expr.varno}:${expr.varattno}`, query: ownerScope.query } : null
}

function visitVar(
  seen: readonly VarLocation[],
  scope: QueryScope,
  expr: PgAnalyzerExpr
): readonly VarLocation[] | null {
  const location = varLocation(scope, expr)
  if (!location || seen.some((visited) => visited.query === location.query && visited.key === location.key)) {
    return null
  }
  return [...seen, location]
}

interface CaseArm {
  readonly result: PgAnalyzerExpr
  readonly scope: QueryScope
}

function mergeNonNullFacts(left: NonNullFacts, right: NonNullFacts): NonNullFacts {
  if (right.size === 0) {
    return left
  }
  const merged = new Map(left)
  for (const [query, rightKeys] of right) {
    merged.set(query, new Set([...(merged.get(query) ?? []), ...rightKeys]))
  }
  return merged
}

function intersectNonNullFacts(facts: readonly NonNullFacts[]): NonNullFacts {
  const [first, ...rest] = facts
  if (!first) {
    return noNonNullFacts
  }
  const intersection = new Map<PgAnalyzerQuery, ReadonlySet<VarKey>>()
  for (const [query, keys] of first) {
    const shared = new Set([...keys].filter((key) => rest.every((candidate) => candidate.get(query)?.has(key))))
    if (shared.size > 0) {
      intersection.set(query, shared)
    }
  }
  return intersection
}

function collectNonNullVarFacts(scope: QueryScope, expr: PgAnalyzerExpr | null | undefined): NonNullFacts {
  if (expr?.tag === 'NullTest' && expr.nullTestType === 'IS_NOT_NULL') {
    const location = varLocation(scope, unwrapValuePreservingExpr(expr.arg))
    return location ? new Map([[location.query, new Set([location.key])]]) : noNonNullFacts
  }

  if (expr?.tag !== 'BoolExpr' || expr.boolOp === 'NOT') {
    return noNonNullFacts
  }

  const branches = exprChildren(expr).map((child) => collectNonNullVarFacts(scope, child))
  if (expr.boolOp === 'AND') {
    return branches.reduce(mergeNonNullFacts, noNonNullFacts)
  }

  if (expr.boolOp === 'OR' && branches.length > 0) {
    return intersectNonNullFacts(branches)
  }

  return noNonNullFacts
}

function scopeWithQual(scope: QueryScope, qual: PgAnalyzerExpr | null | undefined): QueryScope {
  const nonNullVars = mergeNonNullFacts(scope.nonNullVars, collectNonNullVarFacts(scope, qual))
  return nonNullVars === scope.nonNullVars ? scope : { ...scope, nonNullVars }
}

function scopeProvesNonNull(scope: QueryScope, expr: PgAnalyzerExpr): boolean {
  const location = varLocation(scope, expr)
  return Boolean(location && scope.nonNullVars.get(location.query)?.has(location.key))
}

function caseArms(scope: QueryScope, expr: PgAnalyzerExpr): readonly CaseArm[] {
  const arms: CaseArm[] = []
  for (const whenClause of expr.whenClauses ?? []) {
    if (whenClause.result) {
      arms.push({
        result: whenClause.result,
        scope: scopeWithQual(scope, whenClause.condition),
      })
    }
  }
  if (expr.defresult) {
    arms.push({ result: expr.defresult, scope })
  }
  return arms
}

function cteByName(query: PgAnalyzerQuery, name: string | undefined): PgAnalyzerCte | undefined {
  return name ? (query.cteList ?? []).find((cte) => cte.name === name) : undefined
}

function checkConstraintTypeForQueryOutput(
  catalog: CatalogFacts,
  scope: QueryScope,
  outputIndex: number,
  seen: readonly VarLocation[]
): TypedSqlPostgresIrCheckConstraintTypeExpression | null {
  return foldQueryOutput<TypedSqlPostgresIrCheckConstraintTypeExpression | null>(scope, outputIndex, {
    except: (left) => left,
    intersect: (left, right) =>
      left && right ? combineCheckConstraintTypes('intersection', left, right) : (left ?? right),
    target: (targetScope, target) => checkConstraintTypeForExpr(catalog, targetScope, target.expr, seen),
    union: (left, right) => (left && right ? combineCheckConstraintTypes('union', left, right) : null),
    unknown: () => null,
  })
}

function combineCheckConstraintTypes(
  kind: 'intersection' | 'union',
  left: TypedSqlPostgresIrCheckConstraintTypeExpression,
  right: TypedSqlPostgresIrCheckConstraintTypeExpression
): TypedSqlPostgresIrCheckConstraintTypeExpression {
  if (checkConstraintTypeKey(left) === checkConstraintTypeKey(right)) {
    return left
  }

  const candidates = [left, right].flatMap((type) => (type.kind === kind ? type.members : [type]))
  const members = candidates.filter(
    (type, index) =>
      candidates.findIndex((candidate) => checkConstraintTypeKey(candidate) === checkConstraintTypeKey(type)) === index
  )
  return members.length === 1 ? (members[0] as TypedSqlPostgresIrCheckConstraintTypeExpression) : { kind, members }
}

function checkConstraintTypeForExpr(
  catalog: CatalogFacts,
  scope: QueryScope,
  expr: PgAnalyzerExpr | null | undefined,
  seen: readonly VarLocation[]
): TypedSqlPostgresIrCheckConstraintTypeExpression | null {
  const unwrapped = unwrapValuePreservingExpr(expr)
  if (!unwrapped || unwrapped.tag !== 'Var') {
    return null
  }

  const nestedSeen = visitVar(seen, scope, unwrapped)
  if (!nestedSeen) {
    return null
  }

  if (unwrapped.relid && unwrapped.varattno) {
    const fact = catalog.checkConstraintTypesByColumn.get(
      checkConstraintLiteralUnionColumnKey({
        attnum: unwrapped.varattno,
        relid: unwrapped.relid,
      })
    )
    if (fact) {
      return { kind: 'literalUnion', labels: fact.labels }
    }
  }

  const ownerRte = varOwnerRte(scope, unwrapped)
  const outputScope = ownerRte ? queryScopeForRteOutput(...ownerRte) : null
  return outputScope
    ? checkConstraintTypeForQueryOutput(catalog, outputScope, (unwrapped.varattno ?? 1) - 1, nestedSeen)
    : null
}

function literalCheckConstraintTypeForExpr(
  catalog: CatalogFacts,
  scope: QueryScope,
  expr: PgAnalyzerExpr | null | undefined
): TypedSqlPostgresIrCheckConstraintTypeExpression | null {
  const type = checkConstraintTypeForExpr(catalog, scope, expr, [])
  return type?.kind === 'literalUnion' ? type : null
}

function checkedColumnParamTypes(
  catalog: CatalogFacts,
  queries: readonly PgAnalyzerQuery[],
  paramTypeOids: readonly number[]
): ReadonlyMap<number, TypedSqlPostgresIrCheckConstraintTypeExpression> {
  const candidates = new Map<number, Map<string, TypedSqlPostgresIrCheckConstraintTypeExpression>>()
  for (const query of queries) {
    walkQueryTree(query, (nested) => {
      for (const target of nested.dmlParameterTargets) {
        if (!target.directAssignment) {
          continue
        }
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

        const types =
          candidates.get(target.paramId) ?? new Map<string, TypedSqlPostgresIrCheckConstraintTypeExpression>()
        const type = { kind: 'literalUnion', labels: fact.labels } as const
        types.set(checkConstraintTypeKey(type), type)
        candidates.set(target.paramId, types)
      }
    })
  }

  const resolved = new Map<number, TypedSqlPostgresIrCheckConstraintTypeExpression>()
  for (const [paramId, types] of candidates) {
    if (types.size === 1) {
      const [type] = types.values()
      if (type) {
        resolved.set(paramId, type)
      }
    }
  }
  return resolved
}

function queryOutputNullable(
  catalog: CatalogFacts,
  scope: QueryScope,
  outputIndex: number,
  seen: readonly VarLocation[] = []
): boolean {
  return foldQueryOutput<boolean>(scope, outputIndex, {
    except: (left) => left,
    intersect: (left, right) => left && right,
    target: (targetScope, target) => expressionNullable(catalog, targetScope, target.expr, seen),
    union: (left, right) => left || right,
    unknown: () => true,
  })
}

function expressionNullable(
  catalog: CatalogFacts,
  scope: QueryScope,
  expr: PgAnalyzerExpr | null | undefined,
  seen: readonly VarLocation[] = []
): boolean {
  if (!expr || expr.truncated === true) {
    return true
  }

  if (expr.tag === 'Var') {
    if (scopeProvesNonNull(scope, expr)) {
      return false
    }
    if (expr.varattno === 0) {
      return (expr.varnullingrels?.length ?? 0) > 0
    }
    if ((expr.varnullingrels ?? []).length > 0) {
      return true
    }
    if (expr.relid && expr.varattno) {
      const column = catalog.columns.get(`${expr.relid}:${expr.varattno}`)
      if (column) {
        return !column.attnotnull
      }
    }

    if (!varLocation(scope, expr)) {
      return true
    }
    const nestedSeen = visitVar(seen, scope, expr)
    if (!nestedSeen) {
      // Recursive CTE evaluation starts from the nonrecursive term. A repeated
      // exact Var is the bottom of this monotone nullability recurrence; the
      // seed or another set-operation arm still contributes its nullable fact.
      return false
    }

    const ownerRte = varOwnerRte(scope, expr)
    const outputScope = ownerRte ? queryScopeForRteOutput(...ownerRte) : null
    return outputScope ? queryOutputNullable(catalog, outputScope, (expr.varattno ?? 1) - 1, nestedSeen) : true
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
    return !isBuiltinPgProcNamed(catalog, expr.aggfnoid, 'count')
  }
  if (expr.tag === 'CoalesceExpr') {
    return !exprChildren(expr).some((child) => !expressionNullable(catalog, scope, child, seen))
  }
  if (expr.tag === 'CaseExpr') {
    const arms = caseArms(scope, expr)
    return arms.length === 0 || arms.some((arm) => expressionNullable(catalog, arm.scope, arm.result, seen))
  }
  if (expr.tag === 'BoolExpr') {
    return exprChildren(expr).some((child) => expressionNullable(catalog, scope, child, seen))
  }
  if (expr.tag === 'ArrayExpr') {
    return false
  }
  if (expr.tag === 'FuncExpr') {
    if (
      isBuiltinPgProcNamed(catalog, expr.funcid, 'to_json') ||
      isBuiltinPgProcNamed(catalog, expr.funcid, 'to_jsonb') ||
      isBuiltinPgProcNamed(catalog, expr.funcid, 'row_to_json')
    ) {
      const args = expr.args?.map(targetExprFromAggregateArg)
      return !args || args.length === 0 || args.some((arg) => expressionNullable(catalog, scope, arg, seen))
    }
    if (
      isBuiltinPgProcNamed(catalog, expr.funcid, 'jsonb_build_object') ||
      isBuiltinPgProcNamed(catalog, expr.funcid, 'json_build_object')
    ) {
      if (expr.funcVariadic !== true) {
        return false
      }
      const args = expr.args?.map(targetExprFromAggregateArg)
      return args?.length === 1 ? expressionNullable(catalog, scope, args[0], seen) : true
    }
  }
  if (expr.tag === 'RelabelType' || expr.tag === 'CoerceViaIO' || expr.tag === 'CoerceToDomain') {
    return expressionNullable(catalog, scope, expr.arg, seen)
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

function isBuiltinPgProcNamed(catalog: CatalogFacts, oid: number | undefined, name: string): boolean {
  const proc = oid ? catalog.procs.get(oid) : undefined
  return proc?.is_builtin === true && proc.proname === name
}

function unwrapValuePreservingExpr(expr: PgAnalyzerExpr | null | undefined): PgAnalyzerExpr | null | undefined {
  let current = expr
  while (current?.tag === 'RelabelType' || current?.tag === 'CoerceToDomain') {
    current = current.arg
  }
  return current
}

function unwrapCoercionExpr(expr: PgAnalyzerExpr | null | undefined): PgAnalyzerExpr | null | undefined {
  let current = expr
  while (current?.tag === 'RelabelType' || current?.tag === 'CoerceViaIO' || current?.tag === 'CoerceToDomain') {
    current = current.arg
  }
  return current
}

function constStringValue(expr: PgAnalyzerExpr | null | undefined): string | null {
  const unwrapped = unwrapCoercionExpr(expr)
  if (!unwrapped || unwrapped.tag !== 'Const' || unwrapped.constIsNull === true) {
    return null
  }
  return typeof unwrapped.constString === 'string' ? unwrapped.constString : null
}

function isEmptyJsonArrayConst(expr: PgAnalyzerExpr | null | undefined): boolean {
  const unwrapped = unwrapCoercionExpr(expr)
  return unwrapped?.constEmptyJsonArray === true || constStringValue(unwrapped) === '[]'
}

function jsonBuildObjectArguments(expr: PgAnalyzerExpr): readonly PgAnalyzerExpr[] | null {
  const args = expr.args?.map(targetExprFromAggregateArg)
  if (!args || args.some((arg) => !arg)) {
    return null
  }

  let objectArgs = args as readonly PgAnalyzerExpr[]
  if (expr.funcVariadic === true) {
    if (objectArgs.length !== 1) {
      return null
    }
    const array = unwrapCoercionExpr(objectArgs[0])
    if (!array || array.tag !== 'ArrayExpr' || array.multidims === true || !array.elements) {
      return null
    }
    objectArgs = array.elements
  }

  return objectArgs.length % 2 === 0 ? objectArgs : null
}

function targetExprFromAggregateArg(
  arg: PgAnalyzerExpr | { readonly expr?: PgAnalyzerExpr | null } | undefined
): PgAnalyzerExpr | null | undefined {
  if (!arg) {
    return null
  }
  return 'tag' in arg ? arg : arg.expr
}

function jsonLeafShapeForExpr(
  catalog: CatalogFacts,
  scope: QueryScope,
  expr: PgAnalyzerExpr,
  seen: readonly VarLocation[]
): TypedSqlPostgresIrJsonShape {
  const typeFact = typeFactForOid(catalog, expr.typeOid, expr.typeName)
  const constantExpr = unwrapValuePreservingExpr(expr)
  if (
    postgresJsonSupportsStringLiteralRefinement(typeFact) &&
    constantExpr?.tag === 'Const' &&
    constantExpr.constIsNull !== true &&
    typeof constantExpr.constString === 'string'
  ) {
    return { kind: 'stringLiteral', nullable: false, value: constantExpr.constString }
  }
  if (isJsonType(typeFact.pgTypeName)) {
    return {
      kind: 'opaque',
      nullable: expressionNullable(catalog, scope, expr, seen),
    }
  }

  const checkConstraintType = literalCheckConstraintTypeForExpr(catalog, scope, expr)
  return {
    kind: 'scalar',
    nullable: expressionNullable(catalog, scope, expr, seen),
    ...typeFact,
    ...(checkConstraintType ? { checkConstraintType } : {}),
  }
}

function jsonShapeForExpr(
  catalog: CatalogFacts,
  scope: QueryScope,
  expr: PgAnalyzerExpr,
  seen: readonly VarLocation[]
): TypedSqlPostgresIrJsonShape {
  return inferStructuredJsonShape(catalog, scope, expr, seen) ?? jsonLeafShapeForExpr(catalog, scope, expr, seen)
}

function jsonShapeForCaseArm(
  catalog: CatalogFacts,
  arm: CaseArm,
  seen: readonly VarLocation[]
): TypedSqlPostgresIrJsonShape | null {
  const unwrapped = unwrapCoercionExpr(arm.result)
  return unwrapped?.tag === 'Const' && unwrapped.constIsNull === true
    ? null
    : jsonShapeForExpr(catalog, arm.scope, arm.result, seen)
}

function inferQueryOutputJsonShape(
  catalog: CatalogFacts,
  scope: QueryScope,
  outputIndex: number,
  seen: readonly VarLocation[]
): TypedSqlPostgresIrJsonShape {
  return foldQueryOutput<TypedSqlPostgresIrJsonShape>(scope, outputIndex, {
    except: (left) => left,
    intersect: (left, right) => intersectJsonShapes(left, right),
    target: (targetScope, target) => {
      const targetExpr = target.expr
      return targetExpr ? jsonShapeForExpr(catalog, targetScope, targetExpr, seen) : { kind: 'opaque', nullable: true }
    },
    union: (left, right) => unionJsonShapes(left, right),
    unknown: () => ({ kind: 'opaque', nullable: true }),
  })
}

function inferStructuredJsonShape(
  catalog: CatalogFacts,
  scope: QueryScope,
  expr: PgAnalyzerExpr | null | undefined,
  seen: readonly VarLocation[] = []
): TypedSqlPostgresIrJsonShape | null {
  const unwrapped = unwrapValuePreservingExpr(expr)
  if (!unwrapped || unwrapped.truncated === true) {
    return null
  }

  if (unwrapped.tag === 'CaseExpr') {
    const arms = caseArms(scope, unwrapped)
    return joinJsonShapes(
      arms.map((arm) => jsonShapeForCaseArm(catalog, arm, seen)),
      jsonLeafShapeForExpr(catalog, scope, unwrapped, seen)
    )
  }

  if (unwrapped.tag === 'CoalesceExpr') {
    const children = exprChildren(unwrapped)
    const firstShape = inferStructuredJsonShape(catalog, scope, children[0], seen)
    if (!firstShape) {
      return null
    }

    if (firstShape.kind === 'array' && children.length > 1 && children.slice(1).every(isEmptyJsonArrayConst)) {
      return jsonShapeWithNullability(firstShape, false)
    }

    return {
      kind: 'opaque',
      nullable: expressionNullable(catalog, scope, unwrapped, seen),
    }
  }

  if (unwrapped.tag === 'SubLink' && unwrapped.subquery) {
    const subqueryScope = queryScope(unwrapped.subquery, scope)
    switch (unwrapped.subLinkType) {
      case 'EXPR': {
        const shape = inferQueryOutputJsonShape(catalog, subqueryScope, 0, seen)
        return jsonShapeWithNullability(shape, expressionNullable(catalog, scope, unwrapped, seen))
      }
      case 'ARRAY':
        return {
          element: inferQueryOutputJsonShape(catalog, subqueryScope, 0, seen),
          kind: 'array',
          nullable: expressionNullable(catalog, scope, unwrapped, seen),
        }
      case 'ALL':
      case 'ANY':
      case 'EXISTS':
      case 'ROWCOMPARE':
        return jsonLeafShapeForExpr(catalog, scope, unwrapped, seen)
      case 'CTE':
      case 'MULTIEXPR':
      default:
        return null
    }
  }

  if (
    unwrapped.tag === 'FuncExpr' &&
    (isBuiltinPgProcNamed(catalog, unwrapped.funcid, 'to_json') ||
      isBuiltinPgProcNamed(catalog, unwrapped.funcid, 'to_jsonb') ||
      isBuiltinPgProcNamed(catalog, unwrapped.funcid, 'row_to_json'))
  ) {
    const value = targetExprFromAggregateArg(unwrapped.args?.[0])
    const shape = value ? inferStructuredJsonShape(catalog, scope, value, seen) : null
    const nullable = expressionNullable(catalog, scope, unwrapped, seen)
    return shape
      ? jsonShapeWithNullability(shape, nullable)
      : {
          kind: 'opaque',
          nullable,
        }
  }

  if (
    unwrapped.tag === 'FuncExpr' &&
    (isBuiltinPgProcNamed(catalog, unwrapped.funcid, 'jsonb_build_object') ||
      isBuiltinPgProcNamed(catalog, unwrapped.funcid, 'json_build_object'))
  ) {
    const args = jsonBuildObjectArguments(unwrapped)
    if (!args) {
      return {
        kind: 'opaque',
        nullable: expressionNullable(catalog, scope, unwrapped, seen),
      }
    }
    const fields = new Map<string, TypedSqlPostgresIrJsonField>()
    for (let index = 0; index + 1 < args.length; index += 2) {
      const keyExpr = args[index]
      const valueExpr = args[index + 1]
      const key = constStringValue(targetExprFromAggregateArg(keyExpr))
      const value = targetExprFromAggregateArg(valueExpr)
      if (key === null || !value) {
        return {
          kind: 'opaque',
          nullable: expressionNullable(catalog, scope, unwrapped, seen),
        }
      }

      fields.set(key, {
        name: key,
        shape: jsonShapeForExpr(catalog, scope, value, seen),
      })
    }

    return {
      fields: [...fields.values()],
      kind: 'object',
      nullable: expressionNullable(catalog, scope, unwrapped, seen),
    }
  }

  if (
    unwrapped.tag === 'Aggref' &&
    (isBuiltinPgProcNamed(catalog, unwrapped.aggfnoid, 'jsonb_agg') ||
      isBuiltinPgProcNamed(catalog, unwrapped.aggfnoid, 'json_agg'))
  ) {
    const valueExpr = targetExprFromAggregateArg(unwrapped.args?.[0])
    if (!valueExpr) {
      return null
    }

    return {
      element: jsonShapeForExpr(catalog, scope, valueExpr, seen),
      kind: 'array',
      nullable: expressionNullable(catalog, scope, unwrapped, seen),
    }
  }

  if (unwrapped.tag === 'Var') {
    const nestedSeen = visitVar(seen, scope, unwrapped)
    if (!nestedSeen) {
      return null
    }

    const ownerRte = varOwnerRte(scope, unwrapped)
    const outputScope = ownerRte ? queryScopeForRteOutput(...ownerRte) : null
    if (ownerRte && outputScope && unwrapped.varattno === 0) {
      const [, rte] = ownerRte
      return {
        fields: resultTargets(outputScope.query).map((target, targetIndex) => {
          const name = rte.erefColumnNames?.[targetIndex] ?? target.resname ?? `column_${targetIndex + 1}`
          return {
            name,
            shape: inferQueryOutputJsonShape(catalog, outputScope, targetIndex, nestedSeen),
          }
        }),
        kind: 'object',
        nullable: expressionNullable(catalog, scope, unwrapped, seen),
      }
    }
    const shape = outputScope
      ? inferQueryOutputJsonShape(catalog, outputScope, (unwrapped.varattno ?? 1) - 1, nestedSeen)
      : null
    return shape ? jsonShapeWithNullability(shape, expressionNullable(catalog, scope, unwrapped, seen)) : null
  }

  if (isJsonType(unwrapped.typeName)) {
    return {
      kind: 'opaque',
      nullable: expressionNullable(catalog, scope, unwrapped, seen),
    }
  }

  return null
}

function normalizeCompiledIr(catalog: CatalogFacts, analyzed: AnalyzedCompiledConfig): TypedSqlPostgresIr {
  const { analysis, config, primaryQuery: query, rewrittenQueries } = analyzed
  const rootScope = queryScope(query)

  const resultColumns = resultTargets(query).map((target, outputIndex): TypedSqlPostgresIrColumn => {
    const expr = target.expr
    const typeFact = typeFactForOid(catalog, expr?.typeOid, expr?.typeName)
    const checkConstraintType = checkConstraintTypeForQueryOutput(catalog, rootScope, outputIndex, [])
    const nullable = queryOutputNullable(catalog, rootScope, outputIndex)
    const inferredJsonShape = isJsonType(typeFact.pgTypeName)
      ? inferQueryOutputJsonShape(catalog, rootScope, outputIndex, [])
      : undefined
    const jsonShape = inferredJsonShape ? jsonShapeWithNullability(inferredJsonShape, nullable) : undefined
    return {
      jsonShape,
      name: target.resname ?? null,
      nullable,
      ...typeFact,
      source: sourceForExpr(expr),
      ...(checkConstraintType ? { checkConstraintType } : {}),
    }
  })

  const checkConstraintParamTypes = checkedColumnParamTypes(catalog, rewrittenQueries, analysis.paramTypeOids)
  const nullAdmissionByParamId = dmlParameterNullAdmissions(
    rewrittenQueries,
    analysis.paramTypeNullAdmissions,
    analysis.paramUsageNullAdmissions
  )
  const params = config.parameterNames.map((name, index): TypedSqlPostgresIrParam => {
    const oid = analysis.paramTypeOids[index]
    const typeFact = typeFactForOid(catalog, oid, config.parameterTypes?.[index])
    const checkConstraintType = checkConstraintParamTypes.get(index + 1)
    const nullAdmission = nullAdmissionByParamId.get(index + 1) ?? 'unknown'
    return {
      name,
      nullAdmission,
      nullable: nullAdmission === 'accepts',
      ...typeFact,
      propertyName: name,
      ...(checkConstraintType ? { checkConstraintType } : {}),
    }
  })
  const rowBounds = inferRowBounds(catalog, query, resultColumns.length)

  return {
    analyzerSchemaVersion: analysis.schemaVersion,
    command: query.commandType,
    hasDataModifyingCte: rewrittenQueries.some(queryHasDataModifyingCte),
    isWrite: rewrittenQueries.some(queryTreeIsWrite),
    name: config.name,
    params,
    postgresVersionNum: analysis.postgresVersionNum,
    resultColumns,
    rowBounds,
    rowCardinality: rowCardinalityFromBounds(rowBounds),
    sourceFile: config.sourceFile,
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
  if (analysis.paramTypeNullAdmissions.length !== config.parameterNames.length) {
    throw new Error(
      `analyzer returned ${analysis.paramTypeNullAdmissions.length} parameter type NULL admissions for ${config.parameterNames.length} compiled parameters.`
    )
  }
  if (analysis.paramUsageNullAdmissions.length !== config.parameterNames.length) {
    throw new Error(
      `analyzer returned ${analysis.paramUsageNullAdmissions.length} parameter usage NULL admissions for ${config.parameterNames.length} compiled parameters.`
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
  const primaryQuery = tagSettingQueries[0] as PgAnalyzerQuery
  if (primaryQuery.commandType === 'UTILITY') {
    if (primaryQuery.utilityKind === 'CALL' && primaryQuery.utilityReturnsTuples === false) {
      return {
        analysis,
        config,
        primaryQuery,
        rewrittenQueries: statement.queries,
      }
    }
    if (primaryQuery.utilityKind === 'CALL' && primaryQuery.utilityReturnsTuples === true) {
      throw new Error('PostgreSQL CALL statements with result rows are not supported by typed SQL.')
    }

    const utilityKind = primaryQuery.utilityKind ?? 'UNKNOWN'
    throw new Error(
      `PostgreSQL ${utilityKind} utility statements are not supported by typed SQL; only CALL statements without result rows are supported.`
    )
  }

  return {
    analysis,
    config,
    primaryQuery,
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

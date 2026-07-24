/* oxlint-disable eslint/no-use-before-define -- The analyzer IR traversal uses small mutually recursive local helpers. */

import {
  checkConstraintLiteralUnionColumnKey,
  loadCheckConstraintLiteralUnionFacts,
  type CheckConstraintLiteralUnionFact,
} from './check-constraint-type-facts.js'
import {
  intersectPredicateFacts,
  mergePredicateFacts,
  nonNullVarFactKey,
  noPredicateFacts,
  singletonPredicateFact,
  unaryFunctionFalseFactKey,
  unaryFunctionNonNullFactKey,
  type PredicateFacts,
} from './analyzer-predicate-facts.js'
import {
  collectUniqueJoinProofInput,
  inferUniqueJoinClosure,
  type UniqueJoinRelation as UniqueJoinClosureRelation,
} from './analyzer-unique-joins.js'
import {
  checkConstraintTypeKey,
  intersectResultNullabilities,
  intersectJsonShapes,
  joinJsonShapes,
  jsonShapeWithNullability,
  unionResultNullabilities,
  unionJsonShapes,
  type TypedSqlPostgresIr,
  type TypedSqlPostgresIrAccessConcern,
  type TypedSqlPostgresIrAccessEvidence,
  type TypedSqlPostgresIrCheckConstraintTypeExpression,
  type TypedSqlPostgresIrColumn,
  type TypedSqlPostgresIrColumnExpressionSource,
  type TypedSqlPostgresIrCompiledConfig,
  type TypedSqlPostgresIrJsonField,
  type TypedSqlPostgresIrJsonShape,
  type TypedSqlPostgresIrParam,
  type TypedSqlPostgresIrParamNullAdmission,
  type TypedSqlPostgresIrResultNullability,
  type TypedSqlPostgresIrRowBounds,
} from './analyzer-ir-model.js'
import type { PostgresQueryable } from './database.js'
import { loadPostgresTypeFacts } from './postgres-type-facts.js'
import {
  analyzerExprChildren as exprChildren,
  staticVariadicFunctionArguments,
  targetExprFromAggregateArg,
  type PgAnalyzerCte,
  type PgAnalyzerExpr,
  type PgAnalyzerQuery,
  type PgAnalyzerResult,
  type PgAnalyzerRteKind,
  type PgAnalyzerSetOperation,
  type PgAnalyzerTarget,
  unwrapValuePreservingExpr,
} from './postgres-analyzer-model.js'
import { postgresJsonSupportsTextualLiteralRefinement, type PostgresTypeFact } from './postgres-types.js'

export type {
  TypedSqlPostgresIr,
  TypedSqlPostgresIrAccessConcern,
  TypedSqlPostgresIrAccessEvidence,
  TypedSqlPostgresIrCheckConstraintTypeExpression,
  TypedSqlPostgresIrColumn,
  TypedSqlPostgresIrColumnExpressionSource,
  TypedSqlPostgresIrCompiledConfig,
  TypedSqlPostgresIrJsonField,
  TypedSqlPostgresIrJsonShape,
  TypedSqlPostgresIrParam,
  TypedSqlPostgresIrParamNullAdmission,
  TypedSqlPostgresIrResultNullability,
  TypedSqlPostgresIrRowBounds,
} from './analyzer-ir-model.js'

const ANALYZER_SCHEMA_VERSION = 10
const ANALYZER_SQL_FUNCTION = 'pg_temp.postgres_typed_sql_analyze'

function dollarQuotedSqlText(sql: string): string {
  let delimiter = '$postgres_typed_sql$'
  while (sql.includes(delimiter)) {
    delimiter = `${delimiter.slice(0, -1)}_$`
  }
  return `${delimiter}${sql}${delimiter}`
}

export async function bindTypedSqlPostgresAnalyzer(client: PostgresQueryable): Promise<void> {
  await client.query(`
    create function ${ANALYZER_SQL_FUNCTION}(text) returns text
    as '$libdir/postgres_typed_sql_analyzer', 'postgres_typed_sql_analyze'
    language c strict
  `)
  // PGlite lazily finishes loading a newly bound C module on the next
  // statement. Keep that bootstrap statement separate from analyzer work.
  await client.query('select 1')
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

interface VarLocation {
  readonly key: VarKey
  readonly query: PgAnalyzerQuery
}

// Qualifiers observe a query's input tuple. Result expressions observe the
// qualified tuple after command-specific transformations such as UPDATE SET.
type QueryEvaluationPhase = 'input' | 'result'

interface QueryScope {
  readonly evaluationPhase: QueryEvaluationPhase
  readonly predicateFacts: PredicateFacts
  readonly parent: QueryScope | null
  readonly query: PgAnalyzerQuery
}

function queryScope(query: PgAnalyzerQuery, parent: QueryScope | null = null): QueryScope {
  const inputScope: QueryScope = {
    evaluationPhase: 'input',
    predicateFacts: parent?.predicateFacts ?? noPredicateFacts,
    parent,
    query,
  }
  // Record WHERE facts against input identities before advancing result
  // expression analysis to its own evaluation phase.
  const qualifiedInputScope = scopeWithQual(inputScope, query.whereQual)
  return { ...qualifiedInputScope, evaluationPhase: 'result' }
}

function queryScopeAtLevel(scope: QueryScope, levelsUp: number): QueryScope | null {
  let owner: QueryScope | null = scope
  for (let level = 0; owner && level < levelsUp; level += 1) {
    owner = owner.parent
  }
  return owner
}

type ImmediateVarSource =
  | {
      readonly attnum: number
      readonly kind: 'relationColumn'
      readonly relid: number
    }
  | {
      readonly kind: 'queryOutput'
      readonly outputIndex: number
      readonly scope: QueryScope
    }
  | {
      readonly expressions: readonly PgAnalyzerExpr[]
      readonly kind: 'expressions'
      readonly scope: QueryScope
    }
  | {
      readonly kind: 'opaque'
      readonly rteKind: PgAnalyzerRteKind
    }
  | {
      readonly kind: 'wholeRow'
      readonly output: {
        readonly columnNames: readonly string[]
        readonly scope: QueryScope
      } | null
    }
  | {
      readonly attnum: number
      readonly kind: 'specialAttribute'
    }

function resolveImmediateVarSource(scope: QueryScope, expr: PgAnalyzerExpr): ImmediateVarSource {
  if (
    expr.tag !== 'Var' ||
    !Number.isInteger(expr.varno) ||
    (expr.varno as number) <= 0 ||
    !Number.isInteger(expr.varattno) ||
    !Number.isInteger(expr.varlevelsup ?? 0) ||
    (expr.varlevelsup ?? 0) < 0
  ) {
    throw new Error('internal analyzer envelope inconsistency: malformed Var identity')
  }

  const ownerScope = queryScopeAtLevel(scope, expr.varlevelsup ?? 0)
  if (!ownerScope) {
    throw new Error(
      `internal analyzer envelope inconsistency: Var level ${expr.varlevelsup ?? 0} has no owning query scope`
    )
  }
  const rte = ownerScope.query.rtable?.[(expr.varno as number) - 1]
  if (!rte) {
    throw new Error(
      `internal analyzer envelope inconsistency: Var owner RTE ${expr.varno as number} is absent from ${ownerScope.query.commandType} query`
    )
  }

  const outputColumnNames = (): readonly string[] => {
    if (!rte.erefColumnNames) {
      throw new Error(
        `internal analyzer envelope inconsistency: ${rte.kind} RTE ${expr.varno as number} is missing output column identity`
      )
    }
    return rte.erefColumnNames
  }
  const requireOutputIndex = (attnum: number): number => {
    const outputIndex = attnum - 1
    const columnCount = outputColumnNames().length
    if (outputIndex < 0 || outputIndex >= columnCount) {
      throw new Error(
        `internal analyzer envelope inconsistency: ${rte.kind} RTE ${expr.varno as number} has no positive output attribute ${attnum}; expected 1..${columnCount}`
      )
    }
    return outputIndex
  }
  const queryOutputScope = (): QueryScope => {
    if (rte.kind === 'SUBQUERY') {
      if (!rte.subquery) {
        throw new Error(
          `internal analyzer envelope inconsistency: SUBQUERY RTE ${expr.varno as number} is missing its query`
        )
      }
      return queryScope(rte.subquery, ownerScope)
    }
    if (rte.kind !== 'CTE') {
      throw new Error(`internal analyzer envelope inconsistency: ${rte.kind} RTE has no query output`)
    }
    if (typeof rte.cteName !== 'string' || !Number.isInteger(rte.cteLevelSup) || (rte.cteLevelSup as number) < 0) {
      throw new Error(
        `internal analyzer envelope inconsistency: CTE RTE ${expr.varno as number} has malformed owner identity`
      )
    }
    const cteOwnerScope = queryScopeAtLevel(ownerScope, rte.cteLevelSup as number)
    if (!cteOwnerScope) {
      throw new Error(
        `internal analyzer envelope inconsistency: CTE ${JSON.stringify(rte.cteName)} owner level ${rte.cteLevelSup as number} has no query scope`
      )
    }
    const cte = cteByName(cteOwnerScope.query, rte.cteName)
    if (!cte?.query) {
      throw new Error(
        `internal analyzer envelope inconsistency: CTE ${JSON.stringify(rte.cteName)} is absent from its exact owner query`
      )
    }
    if (rte.cteSelfReference === true && cte.recursive !== true) {
      throw new Error(
        `internal analyzer envelope inconsistency: nonrecursive CTE ${JSON.stringify(rte.cteName)} is marked as a self-reference`
      )
    }
    return queryScope(cte.query, cteOwnerScope)
  }

  const attnum = expr.varattno as number
  if (attnum === 0) {
    let output: Extract<ImmediateVarSource, { readonly kind: 'wholeRow' }>['output'] = null
    if (rte.kind === 'SUBQUERY' || rte.kind === 'CTE') {
      const columnNames = outputColumnNames()
      const outputScope = queryOutputScope()
      if (columnNames.length !== resultTargets(outputScope.query).length) {
        throw new Error(
          `internal analyzer envelope inconsistency: ${rte.kind} RTE ${expr.varno as number} has misaligned whole-row output identity`
        )
      }
      output = { columnNames, scope: outputScope }
    }
    return { kind: 'wholeRow', output }
  }
  if (attnum < 0) {
    return { attnum, kind: 'specialAttribute' }
  }

  switch (rte.kind) {
    case 'RELATION': {
      if (typeof rte.relid !== 'number' || rte.relid <= 0) {
        throw new Error(
          `internal analyzer envelope inconsistency: RELATION RTE ${expr.varno as number} is missing its authoritative relation OID`
        )
      }
      if (typeof expr.relid === 'number' && expr.relid > 0 && expr.relid !== rte.relid) {
        throw new Error(
          `internal analyzer envelope inconsistency: Var relation OID ${expr.relid} contradicts owner RTE relation OID ${rte.relid}`
        )
      }
      return { attnum, kind: 'relationColumn', relid: rte.relid }
    }
    case 'SUBQUERY':
    case 'CTE':
      return { kind: 'queryOutput', outputIndex: requireOutputIndex(attnum), scope: queryOutputScope() }
    case 'JOIN': {
      const outputIndex = requireOutputIndex(attnum)
      const expression = rte.joinAliasVars?.[outputIndex]
      if (!expression || rte.joinAliasVars?.length !== outputColumnNames().length) {
        throw new Error(
          `internal analyzer envelope inconsistency: JOIN RTE ${expr.varno as number} has misaligned alias output expressions`
        )
      }
      return { expressions: [expression], kind: 'expressions', scope: ownerScope }
    }
    case 'GROUP': {
      const outputIndex = requireOutputIndex(attnum)
      const expression = rte.groupExprs?.[outputIndex]
      if (!expression || rte.groupExprs?.length !== outputColumnNames().length) {
        throw new Error(
          `internal analyzer envelope inconsistency: GROUP RTE ${expr.varno as number} has misaligned output expressions`
        )
      }
      return { expressions: [expression], kind: 'expressions', scope: ownerScope }
    }
    case 'VALUES': {
      const outputIndex = requireOutputIndex(attnum)
      if (!rte.valuesLists || rte.valuesLists.length === 0) {
        throw new Error(
          `internal analyzer envelope inconsistency: VALUES RTE ${expr.varno as number} is missing row expressions`
        )
      }
      const expressions = rte.valuesLists.map((row) => row[outputIndex])
      if (
        expressions.some((expression) => !expression) ||
        rte.valuesLists.some((row) => row.length !== outputColumnNames().length)
      ) {
        throw new Error(
          `internal analyzer envelope inconsistency: VALUES RTE ${expr.varno as number} has misaligned row expressions`
        )
      }
      return { expressions: expressions as readonly PgAnalyzerExpr[], kind: 'expressions', scope: ownerScope }
    }
    case 'FUNCTION':
    case 'NAMEDTUPLESTORE':
    case 'RESULT':
    case 'TABLEFUNC':
    case 'UNRECOGNIZED':
      requireOutputIndex(attnum)
      return { kind: 'opaque', rteKind: rte.kind }
  }
}

interface QueryOutputSemantics<T> {
  readonly except: (left: T, right: T) => T
  readonly intersect: (left: T, right: T) => T
  readonly target: (scope: QueryScope, target: PgAnalyzerTarget) => T
  readonly union: (left: T, right: T) => T
}

function foldQueryOutput<T>(scope: QueryScope, outputIndex: number, semantics: QueryOutputSemantics<T>): T {
  const { query } = scope
  const foldSetOperation = (operation: PgAnalyzerSetOperation): T => {
    if (operation.kind === 'leaf') {
      const leafQuery = query.rtable?.[operation.rtindex - 1]?.subquery
      if (!leafQuery) {
        throw new Error(
          `internal analyzer envelope inconsistency: set-operation leaf RTE ${operation.rtindex} is missing its query`
        )
      }
      return foldQueryOutput(queryScope(leafQuery, scope), outputIndex, semantics)
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
  if (!target) {
    throw new Error(
      `internal analyzer envelope inconsistency: ${query.commandType} query has no result output ${outputIndex + 1}`
    )
  }
  return semantics.target(scope, target)
}

function constNonNegativeSafeInteger(catalog: CatalogFacts, expr: PgAnalyzerExpr | null | undefined): number | null {
  const unwrapped = unwrapValuePreservingExpr(expr)
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

  const unwrapped = unwrapValuePreservingExpr(query.limitCount)
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
    hasOffset || limit.kind === 'dynamic' ? 0 : limit.kind === 'constant' ? Math.min(base.min, limit.value) : base.min

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

function uniqueJoinRowBounds(catalog: CatalogFacts, query: PgAnalyzerQuery): TypedSqlPostgresIrRowBounds | null {
  if (
    query.commandType !== 'SELECT' ||
    query.hasAggs === true ||
    query.hasSetOperations === true ||
    query.hasTargetSRFs === true ||
    query.hasWindowFuncs === true ||
    (query.groupClauseCount ?? 0) > 0 ||
    (query.groupingSetsCount ?? 0) > 0
  ) {
    return null
  }
  const input = collectUniqueJoinProofInput(query)
  if (!input) {
    return null
  }

  const relations: UniqueJoinClosureRelation[] = input.sources.map((relation) => ({
    indexes: (catalog.uniqueIndexesByRelid.get(relation.relid) ?? [])
      .filter((index) => !(relation.inh && index.has_inheritors && index.relkind !== 'p'))
      .map((index) => ({
        attnums: index.attnums,
        collationOids: index.collation_oids,
        opfamilyOids: index.opfamily_oids,
        proof: `${index.indisprimary ? 'primary_key' : 'unique_index'}:${index.index_name}`,
      })),
    varno: relation.varno,
  }))
  const proofs = inferUniqueJoinClosure(relations, input.constraints, catalog.uniqueEqualityOperators)

  return proofs ? { max: 1, min: 0, proof: `unique_join_closure(${proofs.join(',')})` } : null
}

function projectionSourceRowBounds(
  catalog: CatalogFacts,
  query: PgAnalyzerQuery,
  seen: readonly PgAnalyzerQuery[]
): TypedSqlPostgresIrRowBounds | null {
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

  const sourceBounds = inferRowBounds(catalog, sourceQuery, seen)
  return {
    max: sourceBounds.max,
    min: query.whereQual ? 0 : sourceBounds.min,
    proof: `${sourceKind}_projection:${sourceBounds.proof}${query.whereQual ? '+outer_qual_can_filter' : ''}`,
  }
}

function exactValuesRowBounds(query: PgAnalyzerQuery): TypedSqlPostgresIrRowBounds | null {
  if (
    query.commandType !== 'SELECT' ||
    query.hasAggs === true ||
    query.hasSetOperations === true ||
    query.hasTargetSRFs === true ||
    query.hasWindowFuncs === true ||
    query.whereQual ||
    query.hasHavingQual === true ||
    (query.groupClauseCount ?? 0) > 0 ||
    (query.groupingSetsCount ?? 0) > 0 ||
    (query.distinctClauseCount ?? 0) > 0
  ) {
    return null
  }

  const values = query.rtable?.length === 1 ? query.rtable[0] : undefined
  if (values?.kind !== 'VALUES' || !values.valuesLists) {
    return null
  }
  const count = values.valuesLists.length
  return { max: count, min: count, proof: `values_${count}_rows` }
}

function groupedSourceRowBounds(
  catalog: CatalogFacts,
  query: PgAnalyzerQuery,
  seen: readonly PgAnalyzerQuery[]
): TypedSqlPostgresIrRowBounds | null {
  if (
    query.commandType !== 'SELECT' ||
    (query.groupClauseCount ?? 0) === 0 ||
    (query.groupingSetsCount ?? 0) > 0 ||
    query.hasSetOperations === true ||
    query.hasTargetSRFs === true ||
    query.hasWindowFuncs === true ||
    query.hasHavingQual === true ||
    (query.distinctClauseCount ?? 0) > 0
  ) {
    return null
  }

  const rowSources = (query.rtable ?? []).filter((rte) => rte.kind !== 'GROUP')
  const source = rowSources.length === 1 ? rowSources[0] : undefined
  let sourceQuery: PgAnalyzerQuery | undefined
  let sourceKind: string
  if (source?.kind === 'SUBQUERY') {
    sourceQuery = source.subquery
    sourceKind = 'subquery'
  } else if (source?.kind === 'CTE') {
    const cte = cteByName(query, source.cteName)
    if (cte?.recursive === true) {
      return null
    }
    sourceQuery = cte?.query
    sourceKind = 'cte'
  } else if (source?.kind === 'VALUES' && source.valuesLists) {
    const count = source.valuesLists.length
    const min = query.whereQual || count === 0 ? 0 : 1
    return { max: count, min, proof: `values_grouping_${count}_rows${query.whereQual ? '+qual_can_filter' : ''}` }
  } else {
    return null
  }
  if (!sourceQuery) {
    return null
  }

  const sourceBounds = inferRowBounds(catalog, sourceQuery, seen)
  return {
    max: sourceBounds.max,
    min: query.whereQual || sourceBounds.min === 0 ? 0 : 1,
    proof: `${sourceKind}_grouping:${sourceBounds.proof}${query.whereQual ? '+qual_can_filter' : ''}`,
  }
}

function addBound(left: number | null, right: number | null): number | null {
  if (left === null || right === null) {
    return null
  }
  const sum = left + right
  return Number.isSafeInteger(sum) ? sum : null
}

function setOperationRowBounds(
  catalog: CatalogFacts,
  query: PgAnalyzerQuery,
  operation: PgAnalyzerSetOperation,
  seen: readonly PgAnalyzerQuery[]
): TypedSqlPostgresIrRowBounds {
  if (operation.kind === 'leaf') {
    const leafQuery = query.rtable?.[operation.rtindex - 1]?.subquery
    if (!leafQuery) {
      throw new Error(
        `internal analyzer envelope inconsistency: set-operation leaf RTE ${operation.rtindex} is missing its query`
      )
    }
    return inferRowBounds(catalog, leafQuery, seen)
  }

  const left = setOperationRowBounds(catalog, query, operation.left, seen)
  const right = setOperationRowBounds(catalog, query, operation.right, seen)
  switch (operation.operation) {
    case 'UNION':
      return {
        max: addBound(left.max, right.max),
        min: operation.all
          ? (addBound(left.min, right.min) ?? Math.max(left.min, right.min))
          : left.min > 0 || right.min > 0
            ? 1
            : 0,
        proof: `${operation.all ? 'union_all' : 'union'}(${left.proof},${right.proof})`,
      }
    case 'INTERSECT':
      return {
        max: left.max === null ? right.max : right.max === null ? left.max : Math.min(left.max, right.max),
        min: 0,
        proof: `${operation.all ? 'intersect_all' : 'intersect'}(${left.proof},${right.proof})`,
      }
    case 'EXCEPT':
      return {
        max: left.max,
        min: right.max === 0 ? (operation.all ? left.min : left.min > 0 ? 1 : 0) : 0,
        proof: `${operation.all ? 'except_all' : 'except'}(${left.proof},${right.proof})`,
      }
  }
}

function inferBaseRowBounds(
  catalog: CatalogFacts,
  query: PgAnalyzerQuery,
  seen: readonly PgAnalyzerQuery[]
): TypedSqlPostgresIrRowBounds {
  if (resultTargets(query).length === 0 && query.commandType !== 'SELECT') {
    return { max: 0, min: 0, proof: 'no_result_columns' }
  }

  if (query.hasTargetSRFs === true) {
    return { max: null, min: 0, proof: 'target_srf' }
  }
  if (query.setOperation) {
    return setOperationRowBounds(catalog, query, query.setOperation, seen)
  }
  if (query.hasSetOperations === true) {
    throw new Error('internal analyzer envelope inconsistency: query has set operations without a set-operation tree')
  }

  const valuesBounds = exactValuesRowBounds(query)
  if (valuesBounds) {
    return valuesBounds
  }

  const uniqueBounds = uniqueIndexRowBounds(catalog, query)
  if (uniqueBounds) {
    return uniqueBounds
  }
  const uniqueJoinBounds = uniqueJoinRowBounds(catalog, query)
  if (uniqueJoinBounds) {
    return uniqueJoinBounds
  }
  const projectionBounds = projectionSourceRowBounds(catalog, query, seen)
  if (projectionBounds) {
    return projectionBounds
  }
  const groupedBounds = groupedSourceRowBounds(catalog, query, seen)
  if (groupedBounds) {
    return groupedBounds
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
  seen: readonly PgAnalyzerQuery[] = []
): TypedSqlPostgresIrRowBounds {
  if (seen.includes(query)) {
    throw new Error('internal analyzer envelope inconsistency: cyclic query row-bound ownership')
  }
  const nestedSeen = [...seen, query]
  return applyLimitBounds(catalog, query, inferBaseRowBounds(catalog, query, nestedSeen))
}

function isDataModifyingCommand(
  commandType: string | undefined
): commandType is 'DELETE' | 'INSERT' | 'MERGE' | 'UPDATE' {
  return commandType === 'UPDATE' || commandType === 'INSERT' || commandType === 'DELETE' || commandType === 'MERGE'
}

function walkDirectQueryExpressions(query: PgAnalyzerQuery, visitExpr: (expr: PgAnalyzerExpr) => void): void {
  for (const target of [...(query.targetList ?? []), ...(query.returningList ?? [])]) {
    walkExpr(target.expr, visitExpr)
  }
  for (const rte of query.rtable ?? []) {
    for (const expression of [...(rte.joinAliasVars ?? []), ...(rte.groupExprs ?? [])]) {
      walkExpr(expression, visitExpr)
    }
    for (const row of rte.valuesLists ?? []) {
      for (const expression of row) {
        walkExpr(expression, visitExpr)
      }
    }
  }
  walkExpr(query.whereQual, visitExpr)
  walkExpr(query.limitCount, visitExpr)
}

function walkQueryTree(
  query: PgAnalyzerQuery,
  visitQuery: (query: PgAnalyzerQuery) => void,
  owners: readonly PgAnalyzerQuery[] = []
): void {
  if (owners.includes(query)) {
    throw new Error('internal analyzer envelope inconsistency: cyclic nested-query ownership')
  }
  const nestedOwners = [...owners, query]
  visitQuery(query)
  for (const rte of query.rtable ?? []) {
    if (rte.subquery) {
      walkQueryTree(rte.subquery, visitQuery, nestedOwners)
    }
  }
  for (const cte of query.cteList ?? []) {
    if (cte.query) {
      walkQueryTree(cte.query, visitQuery, nestedOwners)
    }
  }
  walkDirectQueryExpressions(query, (expr) => {
    if (expr.subquery) {
      walkQueryTree(expr.subquery, visitQuery, nestedOwners)
    }
  })
}

function accessEvidence(queries: readonly PgAnalyzerQuery[]): TypedSqlPostgresIrAccessEvidence {
  const reasons: TypedSqlPostgresIrAccessConcern[] = []
  const seen = new Set<string>()
  const add = (reason: TypedSqlPostgresIrAccessConcern): void => {
    const key = reason.kind === 'definiteDml' ? `${reason.kind}:${reason.command}` : reason.kind
    if (!seen.has(key)) {
      seen.add(key)
      reasons.push(reason)
    }
  }

  for (const query of queries) {
    if (isDataModifyingCommand(query.commandType)) {
      add({
        command: query.commandType,
        kind: 'definiteDml',
      })
    }
    if (query.hasModifyingCTE === true) {
      add({ kind: 'dataModifyingCte' })
    }
    if (query.hasRowMarks === true) {
      add({ kind: 'rowLock' })
    }
    if (query.hasVolatileFunctions === true) {
      add({ kind: 'volatileExecution' })
    }
    if (query.commandType === 'UTILITY' && query.utilityKind === 'CALL') {
      add({ kind: 'procedureCall' })
    }
  }

  const [first, ...rest] = reasons
  return first ? { kind: 'notProvenReadOnly', reasons: [first, ...rest] } : { kind: 'provenReadOnly' }
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
      for (const fact of nested.dmlParameterNullAdmissions) {
        admissionByParamId.set(
          fact.paramId,
          combineParameterNullAdmission(admissionByParamId.get(fact.paramId), fact.admission)
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
  readonly relationRelids: ReadonlySet<number>
  readonly typeOids: ReadonlySet<number>
} {
  const typeOids = new Set<number>(analysis.paramTypeOids)
  const procOids = new Set<number>()
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
      })
    }
  }

  return {
    procOids,
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
  const relationRelids = new Set<number>()
  for (const analysis of analyses) {
    const collected = collectOids(analysis)
    for (const oid of collected.typeOids) {
      typeOids.add(oid)
    }
    for (const oid of collected.procOids) {
      procOids.add(oid)
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
  if (relationRelids.size > 0) {
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
        where c.oid = any($1::oid[])
          and a.attnum > 0
          and not a.attisdropped
      `,
      [[...relationRelids]]
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

type ReturningRowImage = 'actionDefault' | 'new' | 'old' | 'possiblyUnavailable' | 'unavailable' | 'unknown'

function isDmlTargetVar(scope: QueryScope, expr: PgAnalyzerExpr): boolean {
  return (
    ['DELETE', 'INSERT', 'MERGE', 'UPDATE'].includes(scope.query.commandType) &&
    expr.varno === scope.query.resultRelation
  )
}

function returningRowImage(scope: QueryScope, expr: PgAnalyzerExpr): ReturningRowImage | null {
  if (scope.evaluationPhase !== 'result' || !isDmlTargetVar(scope, expr)) {
    return null
  }

  switch (scope.query.commandType) {
    case 'DELETE':
      switch (expr.varreturningtype) {
        case 'DEFAULT':
        case 'OLD':
          return 'old'
        case 'NEW':
          return 'unavailable'
        case 'UNRECOGNIZED':
        case undefined:
          return 'unknown'
      }
      break
    case 'INSERT':
      switch (expr.varreturningtype) {
        case 'DEFAULT':
        case 'NEW':
          return 'new'
        case 'OLD':
          return 'unavailable'
        case 'UNRECOGNIZED':
        case undefined:
          return 'unknown'
      }
      break
    case 'UPDATE':
      switch (expr.varreturningtype) {
        case 'DEFAULT':
        case 'NEW':
          return 'new'
        case 'OLD':
          return 'old'
        case 'UNRECOGNIZED':
        case undefined:
          return 'unknown'
      }
      break
    case 'MERGE':
      switch (expr.varreturningtype) {
        case 'DEFAULT':
          return 'actionDefault'
        case 'NEW':
        case 'OLD':
          return 'possiblyUnavailable'
        case 'UNRECOGNIZED':
        case undefined:
          return 'unknown'
      }
      break
  }

  return 'unknown'
}

function updateAssignsAttribute(scope: QueryScope, expr: PgAnalyzerExpr): boolean {
  return (
    scope.query.commandType === 'UPDATE' &&
    scope.query.targetList?.some((target) => target.resjunk !== true && target.resno === expr.varattno) === true
  )
}

function varValueVersion(scope: QueryScope, expr: PgAnalyzerExpr): string {
  if (!isDmlTargetVar(scope, expr)) {
    return ''
  }
  if (scope.evaluationPhase === 'input') {
    return ':old'
  }

  const rowImage = returningRowImage(scope, expr)
  switch (rowImage) {
    case 'old':
      return ':old'
    case 'new':
      // An unchanged UPDATE attribute is the same value in OLD and NEW, so
      // input facts remain applicable without conflating assigned attributes.
      return scope.query.commandType === 'UPDATE' && !updateAssignsAttribute(scope, expr) ? ':old' : ':new'
    case 'actionDefault':
      return ':merge_action_default'
    case 'possiblyUnavailable':
      return `:merge_${expr.varreturningtype?.toLowerCase() ?? 'unknown'}`
    case 'unavailable':
      return `:unavailable_${expr.varreturningtype?.toLowerCase() ?? 'unknown'}`
    case 'unknown':
    case null:
      return ':unknown_returning'
  }
}

function varLocation(scope: QueryScope, expr: PgAnalyzerExpr | null | undefined): VarLocation | null {
  if (!expr || expr.tag !== 'Var' || expr.varno === undefined || expr.varattno === undefined) {
    return null
  }
  const ownerScope = queryScopeAtLevel(scope, expr.varlevelsup ?? 0)
  if (!ownerScope) {
    return null
  }

  const version = varValueVersion(ownerScope, expr)
  return { key: `${expr.varno}:${expr.varattno}${version}`, query: ownerScope.query }
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

function collectPredicateFacts(scope: QueryScope, expr: PgAnalyzerExpr | null | undefined): PredicateFacts {
  if (expr?.tag === 'NullTest' && expr.nullTestType === 'IS_NOT_NULL') {
    const tested = unwrapValuePreservingExpr(expr.arg)
    const location = varLocation(scope, tested)
    if (location) {
      return singletonPredicateFact(location.query, nonNullVarFactKey(location.key))
    }
    if (tested?.tag === 'FuncExpr' && tested.funcid && tested.args?.length === 1) {
      const argumentLocation = varLocation(scope, unwrapValuePreservingExpr(targetExprFromAggregateArg(tested.args[0])))
      if (argumentLocation) {
        return singletonPredicateFact(
          argumentLocation.query,
          unaryFunctionNonNullFactKey(tested.funcid, argumentLocation.key)
        )
      }
    }
    return noPredicateFacts
  }

  if (expr?.tag !== 'BoolExpr') {
    return noPredicateFacts
  }

  const children = exprChildren(expr)
  if (expr.boolOp === 'NOT') {
    const child = children.length === 1 ? unwrapValuePreservingExpr(children[0]) : undefined
    if (child?.tag === 'FuncExpr' && child.funcid && child.args?.length === 1) {
      const location = varLocation(scope, unwrapValuePreservingExpr(targetExprFromAggregateArg(child.args[0])))
      if (location) {
        return singletonPredicateFact(location.query, unaryFunctionFalseFactKey(child.funcid, location.key))
      }
    }
    return noPredicateFacts
  }

  const branches = children.map((child) => collectPredicateFacts(scope, child))
  if (expr.boolOp === 'AND') {
    return branches.reduce(mergePredicateFacts, noPredicateFacts)
  }

  if (expr.boolOp === 'OR' && branches.length > 0) {
    return intersectPredicateFacts(branches)
  }

  return noPredicateFacts
}

function scopeWithQual(scope: QueryScope, qual: PgAnalyzerExpr | null | undefined): QueryScope {
  const predicateFacts = mergePredicateFacts(scope.predicateFacts, collectPredicateFacts(scope, qual))
  return predicateFacts === scope.predicateFacts ? scope : { ...scope, predicateFacts }
}

function scopeProvesNonNull(scope: QueryScope, expr: PgAnalyzerExpr): boolean {
  const location = varLocation(scope, expr)
  return Boolean(location && scope.predicateFacts.get(location.query)?.has(nonNullVarFactKey(location.key)))
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

  const source = resolveImmediateVarSource(scope, unwrapped)
  switch (source.kind) {
    case 'relationColumn': {
      const fact = catalog.checkConstraintTypesByColumn.get(
        checkConstraintLiteralUnionColumnKey({
          attnum: source.attnum,
          relid: source.relid,
        })
      )
      return fact ? { kind: 'literalUnion', labels: fact.labels } : null
    }
    case 'queryOutput':
      return checkConstraintTypeForQueryOutput(catalog, source.scope, source.outputIndex, nestedSeen)
    case 'expressions': {
      const types = source.expressions.map((expression) =>
        checkConstraintTypeForExpr(catalog, source.scope, expression, nestedSeen)
      )
      if (types.some((type) => !type)) {
        return null
      }
      return (types as readonly TypedSqlPostgresIrCheckConstraintTypeExpression[]).reduce((left, right) =>
        combineCheckConstraintTypes('union', left, right)
      )
    }
    case 'opaque':
    case 'specialAttribute':
    case 'wholeRow':
      return null
  }
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
      for (const target of nested.dmlDirectAssignments) {
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

function queryOutputNullability(
  catalog: CatalogFacts,
  scope: QueryScope,
  outputIndex: number,
  seen: readonly VarLocation[] = []
): TypedSqlPostgresIrResultNullability {
  return foldQueryOutput<TypedSqlPostgresIrResultNullability>(scope, outputIndex, {
    except: (left) => left,
    intersect: (left, right) => intersectResultNullabilities(left, right, 'query_intersection'),
    target: (targetScope, target) => expressionNullability(catalog, targetScope, target.expr, seen),
    union: (left, right) => unionResultNullabilities([left, right], 'query_union'),
  })
}

function scalarSubqueryNullability(
  catalog: CatalogFacts,
  scope: QueryScope,
  expr: PgAnalyzerExpr,
  seen: readonly VarLocation[]
): TypedSqlPostgresIrResultNullability {
  const subquery = expr.subquery
  if (!subquery) {
    throw new Error('internal analyzer envelope inconsistency: EXPR SubLink is missing its query')
  }
  const outputs = resultTargets(subquery)
  if (outputs.length !== 1) {
    throw new Error(
      `internal analyzer envelope inconsistency: EXPR SubLink query has ${outputs.length} result outputs; expected exactly 1`
    )
  }

  const subqueryScope = queryScope(subquery, scope)
  const output = queryOutputNullability(catalog, subqueryScope, 0, seen)
  const bounds = inferRowBounds(catalog, subquery)
  if (bounds.max === 0) {
    return { evidence: 'scalar_sublink_empty_query', kind: 'nullable' }
  }
  if (bounds.min > 0 || output.kind === 'nullable') {
    return output
  }
  return { kind: 'unknown', reason: 'scalar_sublink_row_presence_unresolved' }
}

function expressionNullability(
  catalog: CatalogFacts,
  scope: QueryScope,
  expr: PgAnalyzerExpr | null | undefined,
  seen: readonly VarLocation[] = []
): TypedSqlPostgresIrResultNullability {
  if (!expr) {
    return { kind: 'unknown', reason: 'missing_expression' }
  }
  if (expr.truncated === true) {
    return { kind: 'unknown', reason: `truncated_expression:${expr.tag}` }
  }

  if (expr.tag === 'Var') {
    const rowImage = returningRowImage(scope, expr)
    if (rowImage === 'unavailable' || rowImage === 'possiblyUnavailable' || rowImage === 'unknown') {
      return {
        evidence:
          rowImage === 'unavailable'
            ? `returning_${expr.varreturningtype?.toLowerCase() ?? 'unknown'}_row_unavailable`
            : 'returning_row_availability_unresolved',
        kind: 'nullable',
      }
    }
    if (expr.varattno === 0) {
      if (scopeProvesNonNull(scope, expr)) {
        return { basis: 'where_is_not_null', kind: 'nonNull' }
      }
      return (expr.varnullingrels?.length ?? 0) > 0
        ? { evidence: 'outer_join_whole_row', kind: 'nullable' }
        : { basis: 'whole_row', kind: 'nonNull' }
    }
    const source = resolveImmediateVarSource(scope, expr)
    let relationNullability: TypedSqlPostgresIrResultNullability | undefined
    if (source.kind === 'relationColumn') {
      const baseColumn = catalog.columns.get(`${source.relid}:${source.attnum}`)
      if (!baseColumn) {
        throw new Error(
          `internal analyzer catalog inconsistency: missing positive base-column fact for relation OID ${source.relid}, attribute number ${source.attnum} in ${scope.query.commandType} query`
        )
      }
      relationNullability = baseColumn.attnotnull
        ? { basis: `not_null_column:${baseColumn.relname}.${baseColumn.attname}`, kind: 'nonNull' }
        : { evidence: `nullable_column:${baseColumn.relname}.${baseColumn.attname}`, kind: 'nullable' }
    }
    if (scopeProvesNonNull(scope, expr)) {
      return { basis: 'where_is_not_null', kind: 'nonNull' }
    }
    if ((expr.varnullingrels ?? []).length > 0) {
      return { evidence: 'outer_join_column', kind: 'nullable' }
    }
    const nestedSeen = visitVar(seen, scope, expr)
    if (!nestedSeen) {
      // Recursive CTE evaluation starts from the nonrecursive term. A repeated
      // exact Var is the bottom of this monotone nullability recurrence; the
      // seed or another set-operation arm still contributes its nullable fact.
      return { basis: 'recursive_cte_recurrence_bottom', kind: 'nonNull' }
    }

    switch (source.kind) {
      case 'relationColumn':
        if (!relationNullability) {
          throw new Error('internal analyzer catalog inconsistency: relation nullability was not established')
        }
        return relationNullability
      case 'queryOutput':
        return queryOutputNullability(catalog, source.scope, source.outputIndex, nestedSeen)
      case 'expressions': {
        const nullabilities = source.expressions.map((expression) =>
          expressionNullability(catalog, source.scope, expression, nestedSeen)
        )
        return nullabilities.length === 1
          ? (nullabilities[0] as TypedSqlPostgresIrResultNullability)
          : unionResultNullabilities(nullabilities, 'rte_expression_union')
      }
      case 'opaque':
        return { kind: 'unknown', reason: `opaque_rte:${source.rteKind.toLowerCase()}` }
      case 'wholeRow':
        return { basis: 'whole_row', kind: 'nonNull' }
      case 'specialAttribute':
        return { kind: 'unknown', reason: `system_attribute:${source.attnum}` }
    }
  }

  if (expr.tag === 'Const') {
    return expr.constIsNull === true
      ? { evidence: 'null_constant', kind: 'nullable' }
      : { basis: 'non_null_constant', kind: 'nonNull' }
  }
  if (expr.tag === 'Param') {
    return { kind: 'unknown', reason: 'parameter' }
  }
  if (expr.tag === 'NullTest' || expr.tag === 'BooleanTest') {
    return { basis: expr.tag === 'NullTest' ? 'null_test' : 'boolean_test', kind: 'nonNull' }
  }
  if (expr.tag === 'SubLink') {
    if (expr.subLinkType === 'EXISTS' || expr.subLinkType === 'ARRAY') {
      return { basis: `${expr.subLinkType.toLowerCase()}_sublink`, kind: 'nonNull' }
    }
    if (expr.subLinkType === 'EXPR') {
      return scalarSubqueryNullability(catalog, scope, expr, seen)
    }
    return {
      evidence: `${(expr.subLinkType ?? 'unknown').toLowerCase()}_sublink_can_return_null`,
      kind: 'nullable',
    }
  }
  if (expr.tag === 'Aggref') {
    return isBuiltinPgProcNamed(catalog, expr.aggfnoid, 'count')
      ? { basis: 'count_aggregate', kind: 'nonNull' }
      : { kind: 'unknown', reason: `aggregate:${expr.aggname ?? expr.aggfnoid ?? 'unknown'}` }
  }
  if (expr.tag === 'CoalesceExpr') {
    const children = exprChildren(expr).map((child) => expressionNullability(catalog, scope, child, seen))
    if (children.some((child) => child.kind === 'nonNull')) {
      return { basis: 'coalesce_non_null_arm', kind: 'nonNull' }
    }
    if (children.length > 0 && children.every((child) => child.kind === 'nullable')) {
      return { evidence: 'coalesce_all_arms_nullable', kind: 'nullable' }
    }
    return { kind: 'unknown', reason: 'coalesce_without_non_null_proof' }
  }
  if (expr.tag === 'CaseExpr') {
    const arms = caseArms(scope, expr)
    return arms.length === 0
      ? { kind: 'unknown', reason: 'case_without_arms' }
      : unionResultNullabilities(
          arms.map((arm) => expressionNullability(catalog, arm.scope, arm.result, seen)),
          'case'
        )
  }
  if (expr.tag === 'BoolExpr') {
    return unionResultNullabilities(
      exprChildren(expr).map((child) => expressionNullability(catalog, scope, child, seen)),
      `boolean_${(expr.boolOp ?? 'unknown').toLowerCase()}`
    )
  }
  if (expr.tag === 'ArrayExpr') {
    return { basis: 'array_constructor', kind: 'nonNull' }
  }
  if (expr.tag === 'FuncExpr') {
    if (
      (isBuiltinPgProcNamed(catalog, expr.funcid, 'lower') || isBuiltinPgProcNamed(catalog, expr.funcid, 'upper')) &&
      expr.funcid &&
      expr.args?.length === 1
    ) {
      const argument = targetExprFromAggregateArg(expr.args[0])
      const argumentType = argument ? typeFactForOid(catalog, argument.typeOid, argument.typeName) : undefined
      if (argument && (argumentType?.pgTypeKind === 'range' || argumentType?.pgTypeKind === 'multirange')) {
        const endpoint = isBuiltinPgProcNamed(catalog, expr.funcid, 'lower') ? 'lower' : 'upper'
        if (scopeProvesUnaryFunctionResultNonNull(scope, expr.funcid, argument)) {
          return { basis: 'where_function_is_not_null', kind: 'nonNull' }
        }
        if (
          scopeProvesBuiltinUnaryFunctionFalse(catalog, scope, 'isempty', argument) &&
          scopeProvesBuiltinUnaryFunctionFalse(catalog, scope, `${endpoint}_inf`, argument)
        ) {
          return { basis: `finite_nonempty_range_${endpoint}`, kind: 'nonNull' }
        }
        return { evidence: `range_${endpoint}_endpoint_can_be_absent`, kind: 'nullable' }
      }
    }

    if (
      isBuiltinPgProcNamed(catalog, expr.funcid, 'to_json') ||
      isBuiltinPgProcNamed(catalog, expr.funcid, 'to_jsonb') ||
      isBuiltinPgProcNamed(catalog, expr.funcid, 'row_to_json')
    ) {
      const args = expr.args?.map(targetExprFromAggregateArg)
      return !args || args.length === 0
        ? { kind: 'unknown', reason: `json_conversion_arguments:${expr.funcname ?? expr.funcid ?? 'unknown'}` }
        : unionResultNullabilities(
            args.map((arg) => expressionNullability(catalog, scope, arg, seen)),
            'strict_json_conversion'
          )
    }
    const jsonBuildKind = builtinJsonBuildKind(catalog, expr)
    if (jsonBuildKind) {
      if (expr.funcVariadic === false) {
        return { basis: `json_build_${jsonBuildKind}`, kind: 'nonNull' }
      }
      if (expr.funcVariadic === true) {
        const args = expr.args?.map(targetExprFromAggregateArg)
        return args?.length === 1
          ? expressionNullability(catalog, scope, args[0], seen)
          : { kind: 'unknown', reason: `variadic_json_build_${jsonBuildKind}_arguments` }
      }
      return { kind: 'unknown', reason: `missing_json_build_${jsonBuildKind}_variadic_fact` }
    }

    if ((expr.coercionForm === 'EXPLICIT_CAST' || expr.coercionForm === 'IMPLICIT_CAST') && expr.args?.length === 1) {
      return coercionNullability(catalog, scope, expr, targetExprFromAggregateArg(expr.args[0]), seen)
    }
  }
  if (
    expr.tag === 'RelabelType' ||
    expr.tag === 'CoerceViaIO' ||
    expr.tag === 'CoerceToDomain' ||
    expr.tag === 'ArrayCoerceExpr' ||
    expr.tag === 'ConvertRowtypeExpr'
  ) {
    return coercionNullability(catalog, scope, expr, expr.arg, seen)
  }

  return { kind: 'unknown', reason: `unsupported_expression:${expr.tag}` }
}

function coercionNullability(
  catalog: CatalogFacts,
  scope: QueryScope,
  coercion: PgAnalyzerExpr,
  argument: PgAnalyzerExpr | null | undefined,
  seen: readonly VarLocation[]
): TypedSqlPostgresIrResultNullability {
  if (!argument) {
    throw new Error(`internal analyzer envelope inconsistency: ${coercion.tag} is missing its coercion argument`)
  }
  if (
    coercion.coercionForm === undefined ||
    coercion.coercionForm === 'UNRECOGNIZED' ||
    typeof coercion.nullInputProducesNull !== 'boolean' ||
    typeof coercion.nonNullInputProducesNonNull !== 'boolean'
  ) {
    throw new Error(
      `internal analyzer envelope inconsistency: ${coercion.tag} is missing canonical coercion nullability facts`
    )
  }
  if (
    coercion.tag === 'CoerceViaIO' &&
    (!(coercion.inputFunctionOid && coercion.inputFunctionOid > 0) ||
      !(coercion.outputFunctionOid && coercion.outputFunctionOid > 0))
  ) {
    throw new Error(
      'internal analyzer envelope inconsistency: CoerceViaIO is missing authoritative type I/O function identity'
    )
  }

  const argumentNullability = expressionNullability(catalog, scope, argument, seen)
  if (coercion.tag === 'CoerceToDomain') {
    switch (coercion.domainNullAdmission) {
      case 'rejects':
        return { basis: 'domain_rejects_null', kind: 'nonNull' }
      case 'accepts':
        return argumentNullability
      case 'unknown':
        return argumentNullability.kind === 'nonNull'
          ? argumentNullability
          : { kind: 'unknown', reason: 'domain_null_admission' }
      default:
        throw new Error(
          'internal analyzer envelope inconsistency: CoerceToDomain is missing canonical domain NULL admission'
        )
    }
  }

  if (argumentNullability.kind === 'nonNull') {
    return coercion.nonNullInputProducesNonNull
      ? argumentNullability
      : { kind: 'unknown', reason: `opaque_non_null_coercion:${coercion.tag}` }
  }
  if (argumentNullability.kind === 'nullable') {
    return coercion.nullInputProducesNull
      ? argumentNullability
      : { kind: 'unknown', reason: `opaque_null_coercion:${coercion.tag}` }
  }
  return argumentNullability
}

function expressionSourceForExpr(expr: PgAnalyzerExpr | null | undefined): TypedSqlPostgresIrColumnExpressionSource {
  if (!expr || expr.tag !== 'Var' || expr.varno === undefined || expr.varattno === undefined) {
    return { kind: 'expression', tag: expr?.tag ?? 'unknown' }
  }
  return expr.relname
    ? {
        attname: expr.attname,
        kind: 'tableColumn',
        relname: expr.relname,
        varattno: expr.varattno,
        varlevelsup: expr.varlevelsup ?? 0,
        varno: expr.varno,
        varnullingrels: expr.varnullingrels ?? [],
      }
    : {
        kind: 'derivedVar',
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

type JsonBuildKind = 'array' | 'object'

function builtinJsonBuildKind(catalog: CatalogFacts, expr: PgAnalyzerExpr): JsonBuildKind | null {
  if (
    isBuiltinPgProcNamed(catalog, expr.funcid, 'json_build_array') ||
    isBuiltinPgProcNamed(catalog, expr.funcid, 'jsonb_build_array')
  ) {
    return 'array'
  }
  if (
    isBuiltinPgProcNamed(catalog, expr.funcid, 'json_build_object') ||
    isBuiltinPgProcNamed(catalog, expr.funcid, 'jsonb_build_object')
  ) {
    return 'object'
  }
  return null
}

function scopeProvesUnaryFunctionResultNonNull(scope: QueryScope, funcid: number, argument: PgAnalyzerExpr): boolean {
  const location = varLocation(scope, unwrapValuePreservingExpr(argument))
  return Boolean(
    location && scope.predicateFacts.get(location.query)?.has(unaryFunctionNonNullFactKey(funcid, location.key))
  )
}

function scopeProvesBuiltinUnaryFunctionFalse(
  catalog: CatalogFacts,
  scope: QueryScope,
  functionName: string,
  argument: PgAnalyzerExpr,
  seen: readonly VarLocation[] = []
): boolean {
  const unwrapped = unwrapValuePreservingExpr(argument)
  const location = varLocation(scope, unwrapped)
  if (!location) {
    return false
  }
  const facts = scope.predicateFacts.get(location.query)
  for (const [oid, proc] of catalog.procs) {
    if (proc.is_builtin && proc.proname === functionName && facts?.has(unaryFunctionFalseFactKey(oid, location.key))) {
      return true
    }
  }

  if (!unwrapped || unwrapped.tag !== 'Var') {
    return false
  }
  if ((unwrapped.varnullingrels?.length ?? 0) > 0) {
    return false
  }
  const nestedSeen = visitVar(seen, scope, unwrapped)
  if (!nestedSeen) {
    return false
  }
  const source = resolveImmediateVarSource(scope, unwrapped)
  if (source.kind === 'queryOutput') {
    return foldQueryOutput<boolean>(source.scope, source.outputIndex, {
      except: (left) => left,
      intersect: (left, right) => left || right,
      target: (targetScope, target) =>
        Boolean(
          target.expr &&
            scopeProvesBuiltinUnaryFunctionFalse(catalog, targetScope, functionName, target.expr, nestedSeen)
        ),
      union: (left, right) => left && right,
    })
  }
  if (source.kind === 'expressions') {
    return (
      source.expressions.length > 0 &&
      source.expressions.every((sourceExpr) =>
        scopeProvesBuiltinUnaryFunctionFalse(catalog, source.scope, functionName, sourceExpr, nestedSeen)
      )
    )
  }
  return false
}

function constStringValue(expr: PgAnalyzerExpr | null | undefined): string | null {
  const unwrapped = unwrapValuePreservingExpr(expr)
  if (!unwrapped || unwrapped.tag !== 'Const' || unwrapped.constIsNull === true) {
    return null
  }
  return typeof unwrapped.constString === 'string' ? unwrapped.constString : null
}

function isEmptyJsonArrayConst(expr: PgAnalyzerExpr | null | undefined): boolean {
  const unwrapped = unwrapValuePreservingExpr(expr)
  return unwrapped?.constEmptyJsonArray === true || constStringValue(unwrapped) === '[]'
}

function jsonBuildObjectArguments(expr: PgAnalyzerExpr): readonly PgAnalyzerExpr[] | null {
  const decoded = staticVariadicFunctionArguments(expr)
  return decoded.kind === 'known' && decoded.arguments.length % 2 === 0 ? decoded.arguments : null
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
    postgresJsonSupportsTextualLiteralRefinement(typeFact) &&
    constantExpr?.tag === 'Const' &&
    constantExpr.constIsNull !== true &&
    typeof constantExpr.constString === 'string'
  ) {
    return {
      ...typeFact,
      kind: 'stringLiteral',
      nullability: { basis: 'non_null_string_constant', kind: 'nonNull' },
      value: constantExpr.constString,
    }
  }
  if (isJsonType(typeFact.pgTypeName)) {
    return {
      kind: 'opaque',
      nullability: expressionNullability(catalog, scope, expr, seen),
    }
  }

  const checkConstraintType = literalCheckConstraintTypeForExpr(catalog, scope, expr)
  return {
    kind: 'scalar',
    nullability: expressionNullability(catalog, scope, expr, seen),
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
  const unwrapped = unwrapValuePreservingExpr(arm.result)
  return unwrapped?.tag === 'Const' && unwrapped.constIsNull === true
    ? null
    : jsonShapeForExpr(catalog, arm.scope, arm.result, seen)
}

function jsonBuildArrayElementShape(
  catalog: CatalogFacts,
  scope: QueryScope,
  expr: PgAnalyzerExpr,
  seen: readonly VarLocation[]
): TypedSqlPostgresIrJsonShape {
  const decoded = staticVariadicFunctionArguments(expr)
  if (decoded.kind === 'unavailable') {
    return {
      kind: 'opaque',
      nullability: { kind: 'unknown', reason: 'dynamic_variadic_json_build_array_element' },
    }
  }

  const [firstElementShape, ...remainingElementShapes] = decoded.arguments.map((argument) =>
    jsonShapeForExpr(catalog, scope, argument, seen)
  )
  return firstElementShape
    ? joinJsonShapes([firstElementShape, ...remainingElementShapes], firstElementShape)
    : {
        kind: 'opaque',
        nullability: { basis: 'empty_json_build_array_element', kind: 'nonNull' },
      }
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
      return targetExpr
        ? jsonShapeForExpr(catalog, targetScope, targetExpr, seen)
        : { kind: 'opaque', nullability: { kind: 'unknown', reason: 'missing_json_target' } }
    },
    union: (left, right) => unionJsonShapes(left, right),
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
      return jsonShapeWithNullability(firstShape, { basis: 'coalesce_empty_json_array', kind: 'nonNull' })
    }

    return {
      kind: 'opaque',
      nullability: expressionNullability(catalog, scope, unwrapped, seen),
    }
  }

  if (unwrapped.tag === 'SubLink' && unwrapped.subquery) {
    const subqueryScope = queryScope(unwrapped.subquery, scope)
    switch (unwrapped.subLinkType) {
      case 'EXPR': {
        const shape = inferQueryOutputJsonShape(catalog, subqueryScope, 0, seen)
        return jsonShapeWithNullability(shape, expressionNullability(catalog, scope, unwrapped, seen))
      }
      case 'ARRAY':
        return {
          element: inferQueryOutputJsonShape(catalog, subqueryScope, 0, seen),
          kind: 'array',
          nullability: expressionNullability(catalog, scope, unwrapped, seen),
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
    const nullability = expressionNullability(catalog, scope, unwrapped, seen)
    return shape
      ? jsonShapeWithNullability(shape, nullability)
      : {
          kind: 'opaque',
          nullability,
        }
  }

  const jsonBuildKind = unwrapped.tag === 'FuncExpr' ? builtinJsonBuildKind(catalog, unwrapped) : null
  if (jsonBuildKind === 'object') {
    const args = jsonBuildObjectArguments(unwrapped)
    if (!args) {
      return {
        kind: 'opaque',
        nullability: expressionNullability(catalog, scope, unwrapped, seen),
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
          nullability: expressionNullability(catalog, scope, unwrapped, seen),
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
      nullability: expressionNullability(catalog, scope, unwrapped, seen),
    }
  }

  if (jsonBuildKind === 'array') {
    return {
      element: jsonBuildArrayElementShape(catalog, scope, unwrapped, seen),
      kind: 'array',
      nullability: expressionNullability(catalog, scope, unwrapped, seen),
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
      nullability: expressionNullability(catalog, scope, unwrapped, seen),
    }
  }

  if (unwrapped.tag === 'Var') {
    const nestedSeen = visitVar(seen, scope, unwrapped)
    if (!nestedSeen) {
      return null
    }

    const source = resolveImmediateVarSource(scope, unwrapped)
    let shape: TypedSqlPostgresIrJsonShape | null
    switch (source.kind) {
      case 'queryOutput':
        shape = inferQueryOutputJsonShape(catalog, source.scope, source.outputIndex, nestedSeen)
        break
      case 'expressions': {
        const shapes = source.expressions.map((expression) =>
          jsonShapeForExpr(catalog, source.scope, expression, nestedSeen)
        )
        const [firstShape, ...remainingShapes] = shapes
        if (!firstShape) {
          throw new Error('internal analyzer envelope inconsistency: immediate expression source is empty')
        }
        shape = remainingShapes.reduce((left, right) => unionJsonShapes(left, right), firstShape)
        break
      }
      case 'wholeRow': {
        const output = source.output
        shape = output
          ? {
              fields: output.columnNames.map((name, outputIndex) => ({
                name,
                shape: inferQueryOutputJsonShape(catalog, output.scope, outputIndex, nestedSeen),
              })),
              kind: 'object',
              nullability: expressionNullability(catalog, scope, unwrapped, seen),
            }
          : null
        break
      }
      case 'opaque':
      case 'relationColumn':
      case 'specialAttribute':
        shape = null
        break
    }
    return shape ? jsonShapeWithNullability(shape, expressionNullability(catalog, scope, unwrapped, seen)) : null
  }

  if (isJsonType(unwrapped.typeName)) {
    return {
      kind: 'opaque',
      nullability: expressionNullability(catalog, scope, unwrapped, seen),
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
    const nullability = queryOutputNullability(catalog, rootScope, outputIndex)
    const inferredJsonShape = isJsonType(typeFact.pgTypeName)
      ? inferQueryOutputJsonShape(catalog, rootScope, outputIndex, [])
      : undefined
    const jsonShape = inferredJsonShape ? jsonShapeWithNullability(inferredJsonShape, nullability) : undefined
    return {
      expressionSource: expressionSourceForExpr(expr),
      jsonShape,
      name: target.resname ?? null,
      nullability,
      ...typeFact,
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
    const typeFact = typeFactForOid(catalog, oid, undefined)
    const checkConstraintType = checkConstraintParamTypes.get(index + 1)
    const nullAdmission = nullAdmissionByParamId.get(index + 1) ?? 'unknown'
    return {
      name,
      nullAdmission,
      ...typeFact,
      ...(checkConstraintType ? { checkConstraintType } : {}),
    }
  })
  const rowBounds = inferRowBounds(catalog, query)

  return {
    accessEvidence: accessEvidence(rewrittenQueries),
    analyzerSchemaVersion: analysis.schemaVersion,
    command: query.commandType,
    name: config.name,
    params,
    postgresVersionNum: analysis.postgresVersionNum,
    resultColumns,
    rowBounds,
    sourceFile: config.sourceFile,
  }
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

function hasExactlyKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function validateDmlQueryEnvelope(query: PgAnalyzerQuery, parameterCount: number): void {
  walkQueryTree(query, (nested) => {
    if (!Array.isArray(nested.dmlDirectAssignments)) {
      throw new Error('analyzer returned a query without required DML direct-assignment facts.')
    }
    if (!Array.isArray(nested.dmlParameterNullAdmissions)) {
      throw new Error('analyzer returned a query without required DML parameter NULL-admission facts.')
    }

    for (const assignment of nested.dmlDirectAssignments) {
      if (
        typeof assignment !== 'object' ||
        assignment === null ||
        !hasExactlyKeys(assignment, ['paramId', 'targetAttnum', 'targetRelid', 'targetTypeOid']) ||
        !isPositiveInteger(assignment.paramId) ||
        assignment.paramId > parameterCount ||
        !isPositiveInteger(assignment.targetRelid) ||
        !isPositiveInteger(assignment.targetAttnum) ||
        !isPositiveInteger(assignment.targetTypeOid)
      ) {
        throw new Error('analyzer returned an inconsistent DML direct-assignment fact.')
      }
    }

    for (const fact of nested.dmlParameterNullAdmissions) {
      if (
        typeof fact !== 'object' ||
        fact === null ||
        !hasExactlyKeys(fact, ['admission', 'basis', 'paramId']) ||
        !isPositiveInteger(fact.paramId) ||
        fact.paramId > parameterCount ||
        !(
          (fact.admission === 'accepts' &&
            (fact.basis === 'action_unreachable_when_null' ||
              fact.basis === 'row_values_preserved_when_null' ||
              fact.basis === 'direct_target_null_admission')) ||
          (fact.admission === 'rejects' && fact.basis === 'direct_target_null_admission') ||
          (fact.admission === 'unknown' && fact.basis === 'unresolved')
        )
      ) {
        throw new Error('analyzer returned an inconsistent DML parameter NULL-admission fact.')
      }
    }
  })
}

type AnalyzedCompiledConfigAttempt =
  | { readonly cause: unknown; readonly kind: 'failure' }
  | { readonly kind: 'success'; readonly value: AnalyzedCompiledConfig }

interface ValidatedAnalyzerEnvelope {
  readonly primaryQuery: PgAnalyzerQuery
  readonly rewrittenQueries: readonly PgAnalyzerQuery[]
}

const nativeAnalyzerProbeSql = 'select 1'

async function invokeNativeAnalyzer(client: PostgresQueryable, sql: string): Promise<PgAnalyzerResult | undefined> {
  const result = await client.query<{ readonly analysis: PgAnalyzerResult }>(
    `select ${ANALYZER_SQL_FUNCTION}(${dollarQuotedSqlText(sql)})::jsonb as analysis`
  )
  return result.rows[0]?.analysis
}

function validateAnalyzerSchema(analysis: PgAnalyzerResult | undefined): asserts analysis is PgAnalyzerResult {
  if (!analysis || analysis.schemaVersion !== ANALYZER_SCHEMA_VERSION) {
    throw new Error(
      `analyzer returned unsupported schema version ${analysis?.schemaVersion ?? 'missing'}; expected ${ANALYZER_SCHEMA_VERSION}.`
    )
  }
}

function validateSingleStatementAnalyzerEnvelope(
  analysis: PgAnalyzerResult,
  parameterCount: number
): ValidatedAnalyzerEnvelope {
  if (analysis.rawStatementCount !== 1) {
    throw new Error(`analyzer returned ${analysis.rawStatementCount} raw statements for a single-statement envelope.`)
  }
  if (analysis.statements.length !== 1) {
    throw new Error(`analyzer returned ${analysis.statements.length} statement envelopes for one raw statement.`)
  }
  if (analysis.paramTypeOids.length !== parameterCount) {
    throw new Error(
      `analyzer returned ${analysis.paramTypeOids.length} parameter types for ${parameterCount} compiled parameters.`
    )
  }
  if (analysis.paramTypeNullAdmissions.length !== parameterCount) {
    throw new Error(
      `analyzer returned ${analysis.paramTypeNullAdmissions.length} parameter type NULL admissions for ${parameterCount} compiled parameters.`
    )
  }
  if (analysis.paramUsageNullAdmissions.length !== parameterCount) {
    throw new Error(
      `analyzer returned ${analysis.paramUsageNullAdmissions.length} parameter usage NULL admissions for ${parameterCount} compiled parameters.`
    )
  }

  const statement = analysis.statements[0]
  if (!statement || statement.rewrittenQueryCount !== statement.queries.length) {
    throw new Error('analyzer returned an inconsistent rewritten-query envelope.')
  }
  for (const query of statement.queries) {
    validateDmlQueryEnvelope(query, parameterCount)
  }
  const tagSettingQueries = statement.queries.filter((query) => query.canSetTag)
  if (tagSettingQueries.length !== 1) {
    throw new Error(`expected exactly one tag-setting rewritten query; received ${tagSettingQueries.length}.`)
  }
  return {
    primaryQuery: tagSettingQueries[0] as PgAnalyzerQuery,
    rewrittenQueries: statement.queries,
  }
}

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause))
}

function indentedMessage(message: string, prefix: string): string {
  const [first = '', ...continuation] = message.split(/\r?\n/u)
  return [`${prefix}${first}`, ...continuation.map((line) => `  ${line}`)].join('\n')
}

function validateNativeAnalyzerProbe(probe: ValidatedAnalyzerEnvelope): void {
  if (probe.rewrittenQueries.length !== 1 || probe.primaryQuery.commandType !== 'SELECT') {
    throw new Error(
      `native analyzer health probe returned ${probe.rewrittenQueries.length} rewritten queries with command type ${probe.primaryQuery.commandType}; expected one SELECT query.`
    )
  }
  const targets = probe.primaryQuery.targetList ?? []
  const target = targets[0]
  if (
    targets.length !== 1 ||
    target?.resjunk === true ||
    target?.expr?.tag !== 'Const' ||
    target.expr.typeOid !== 23 ||
    target.expr.constInteger !== '1'
  ) {
    throw new Error('native analyzer health probe returned an unexpected SELECT 1 target.')
  }
}

async function assertNativeAnalyzerHealthy(client: PostgresQueryable, rejectedInvocationCause: unknown): Promise<void> {
  try {
    // Re-establish the same parameter-free boundary before probing the native
    // analyzer itself. This is a continuation gate, not a retry of user SQL.
    await client.query('select 1')
    const analysis = await invokeNativeAnalyzer(client, nativeAnalyzerProbeSql)
    validateAnalyzerSchema(analysis)
    const probe = validateSingleStatementAnalyzerEnvelope(analysis, 0)
    validateNativeAnalyzerProbe(probe)
  } catch (probeCause) {
    const invocationError = asError(rejectedInvocationCause)
    const probeError = asError(probeCause)
    throw new AggregateError(
      [invocationError, probeError],
      [
        'The native analyzer health probe failed after the current analyzer invocation rejected; batch continuation is unsafe.',
        indentedMessage(invocationError.message, 'Original invocation: '),
        indentedMessage(probeError.message, 'Health probe: '),
      ].join('\n')
    )
  }
}

async function attemptAnalyzeCompiledConfig(
  client: PostgresQueryable,
  config: TypedSqlPostgresIrCompiledConfig
): Promise<AnalyzedCompiledConfigAttempt> {
  // PGlite can retain extended-query parameter state from the preceding
  // catalog lookup. Enter the re-entrant variable-parameter analyzer from a
  // parameter-free statement boundary.
  await client.query('select 1')

  let analysis: PgAnalyzerResult | undefined
  try {
    analysis = await invokeNativeAnalyzer(client, config.sql)
  } catch (cause) {
    await assertNativeAnalyzerHealthy(client, cause)
    return { cause, kind: 'failure' }
  }

  validateAnalyzerSchema(analysis)
  if (analysis.rawStatementCount !== 1) {
    return {
      cause: new Error(
        `typed SQL must contain exactly one PostgreSQL statement; received ${analysis.rawStatementCount}.`
      ),
      kind: 'failure',
    }
  }

  const { primaryQuery, rewrittenQueries } = validateSingleStatementAnalyzerEnvelope(
    analysis,
    config.parameterNames.length
  )
  if (primaryQuery.commandType === 'UTILITY') {
    if (primaryQuery.utilityKind === 'CALL' && primaryQuery.utilityReturnsTuples === false) {
      return {
        kind: 'success',
        value: {
          analysis,
          config,
          primaryQuery,
          rewrittenQueries,
        },
      }
    }
    if (primaryQuery.utilityKind === 'CALL' && primaryQuery.utilityReturnsTuples === true) {
      return {
        cause: new Error('PostgreSQL CALL statements with result rows are not supported by typed SQL.'),
        kind: 'failure',
      }
    }

    const utilityKind = primaryQuery.utilityKind ?? 'UNKNOWN'
    return {
      cause: new Error(
        `PostgreSQL ${utilityKind} utility statements are not supported by typed SQL; only CALL statements without result rows are supported.`
      ),
      kind: 'failure',
    }
  }

  return {
    kind: 'success',
    value: {
      analysis,
      config,
      primaryQuery,
      rewrittenQueries,
    },
  }
}

function contextualizedAnalysisFailure(config: TypedSqlPostgresIrCompiledConfig, cause: unknown): Error {
  const message = cause instanceof Error ? cause.message : String(cause)
  const parameterMap =
    config.parameterNames.length === 0
      ? ''
      : ` Compiled parameter map: ${config.parameterNames.map((name, index) => `$${index + 1} = :${name}`).join(', ')}.`
  return new Error(`${config.sourceFile}: failed to analyze typed SQL ${config.name}: ${message}${parameterMap}`, {
    cause,
  })
}

function formatTypedSqlAnalysisFailures(failures: readonly Error[]): string {
  const entries = failures.map((failure, index) => {
    const [first = '', ...continuation] = failure.message.split(/\r?\n/u)
    return [`${index + 1}. ${first}`, ...continuation.map((line) => `   ${line}`)].join('\n')
  })
  return `Failed to analyze ${failures.length} typed SQL statements:\n${entries.join('\n')}`
}

export async function buildTypedSqlPostgresIrFromCompiledConfigs(
  client: PostgresQueryable,
  configs: readonly TypedSqlPostgresIrCompiledConfig[]
): Promise<TypedSqlPostgresIrBuildResult> {
  const analyses: AnalyzedCompiledConfig[] = []
  const failures: Error[] = []
  for (const config of configs) {
    let attempt: AnalyzedCompiledConfigAttempt
    try {
      attempt = await attemptAnalyzeCompiledConfig(client, config)
    } catch (cause) {
      throw contextualizedAnalysisFailure(config, cause)
    }

    if (attempt.kind === 'failure') {
      failures.push(contextualizedAnalysisFailure(config, attempt.cause))
    } else {
      analyses.push(attempt.value)
    }
  }

  if (failures.length === 1) {
    throw failures[0]
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, formatTypedSqlAnalysisFailures(failures))
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
    queries: analyses.map((analyzed) => {
      try {
        return normalizeCompiledIr(catalog, analyzed)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(
          `${analyzed.config.sourceFile}: failed to build typed SQL IR ${analyzed.config.name}: ${message}`,
          { cause: error }
        )
      }
    }),
  }
}

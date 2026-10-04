/* oxlint-disable eslint/no-use-before-define -- The analyzer IR traversal uses small mutually recursive local helpers. */

import {
  checkConstraintLiteralUnionColumnKey,
  loadCheckConstraintLiteralUnionFacts,
  type CheckConstraintLiteralUnionFact,
} from './check-constraint-type-facts.js'
import {
  intersectPredicateFacts,
  mergePredicateFacts,
  literalVarFactKey,
  literalVarFacts,
  excludedVarFactKey,
  excludedVarFacts,
  equalVarsFactKey,
  expressionTruthFactKey,
  nonNullExpressionFactKey,
  nonNullVarFactKey,
  noPredicateFacts,
  nullVarFactKey,
  rowPresentFactKey,
  singletonPredicateFact,
  unaryFunctionFalseFactKey,
  unaryFunctionNonNullFactKey,
  type PredicateFacts,
} from './analyzer-predicate-facts.js'
import {
  collectUniqueJoinProofInput,
  inferJoinTreeRowBounds,
  inferUniqueJoinClosure,
  isImmutableRowIndependentExpr,
  uniqueEqualityOperatorKey,
  type JoinRowBoundSource,
  type UniqueJoinRelation as UniqueJoinClosureRelation,
  type UniqueJoinSource,
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
  type PgAnalyzerFromNode,
  type PgAnalyzerQuery,
  type PgAnalyzerResult,
  type PgAnalyzerRte,
  type PgAnalyzerRteKind,
  type PgAnalyzerSetOperation,
  type PgAnalyzerTarget,
  unwrapValuePreservingExpr,
} from './postgres-analyzer-model.js'
import {
  postgresJsonSupportsTextualLiteralRefinement,
  postgresJsonValueMayBeStructured,
  type PostgresTypeFact,
} from './postgres-types.js'

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

const ANALYZER_SCHEMA_VERSION = 12
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
  await client.query(`
    create function pg_temp.postgres_typed_sql_column_check_not_null(oid, integer) returns boolean
    as '$libdir/postgres_typed_sql_analyzer', 'postgres_typed_sql_column_check_not_null'
    language c strict
  `)
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
  readonly check_rejects_null: boolean
  readonly attnum: number
  readonly atttypid: number
  readonly relid: number
  readonly relname: string
  readonly update_may_change_implicitly: boolean
}

interface UniqueIndexCatalogRow {
  readonly attnums: readonly number[]
  readonly collation_oids: readonly number[]
  readonly has_inheritors: boolean
  readonly index_name: string
  readonly indexrelid: number
  readonly indisprimary: boolean
  readonly indnullsnotdistinct: boolean
  readonly expressions_sql: string | null
  readonly predicate_sql: string | null
  readonly qualified_relation: string
  readonly expressions?: readonly PgAnalyzerExpr[]
  readonly predicate?: PgAnalyzerExpr | null
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
  readonly catalog: CatalogFacts
  readonly evaluationPhase: QueryEvaluationPhase
  readonly inputPredicateFacts: PredicateFacts
  readonly predicateFacts: PredicateFacts
  readonly parent: QueryScope | null
  readonly query: PgAnalyzerQuery
}

function queryScope(query: PgAnalyzerQuery, parent: QueryScope | null = null, catalog = parent?.catalog): QueryScope {
  if (!catalog) {
    throw new Error('internal analyzer inconsistency: query scope has no catalog')
  }
  const inputScope: QueryScope = {
    catalog,
    evaluationPhase: 'input',
    inputPredicateFacts: parent?.predicateFacts ?? noPredicateFacts,
    predicateFacts: parent?.predicateFacts ?? noPredicateFacts,
    parent,
    query,
  }
  // Record WHERE facts against input identities before advancing result
  // expression analysis to its own evaluation phase.
  let qualifiedInputScope = scopeWithQual(inputScope, query.whereQual)
  for (const qual of guaranteedJoinQuals(query.fromTree)) {
    qualifiedInputScope = scopeWithQual(qualifiedInputScope, qual)
  }
  const mayEmitEmptyGroup =
    query.commandType === 'SELECT' &&
    (((query.hasAggs || query.hasHavingQual) && (query.groupClauseCount ?? 0) === 0) ||
      (query.groupingSetsCount ?? 0) > 0)
  return scopeWithQual(
    {
      ...qualifiedInputScope,
      evaluationPhase: 'result',
      inputPredicateFacts: qualifiedInputScope.predicateFacts,
      // The implicit empty group is still emitted when WHERE is false. Those
      // input facts cannot constrain a parameter or CASE in the result tuple.
      predicateFacts: mayEmitEmptyGroup
        ? (parent?.predicateFacts ?? noPredicateFacts)
        : qualifiedInputScope.predicateFacts,
    },
    query.havingQual
  )
}

function aggregateInputScope(scope: QueryScope): QueryScope {
  return {
    ...scope,
    evaluationPhase: 'input',
    predicateFacts: mergePredicateFacts(scope.inputPredicateFacts, scope.predicateFacts),
  }
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
  const offsetExpr = unwrapValuePreservingExpr(query.limitOffset)
  const offset =
    !hasOffset || (offsetExpr?.tag === 'Const' && offsetExpr.constIsNull === true)
      ? 0
      : constNonNegativeSafeInteger(catalog, query.limitOffset)
  if ((limit.kind === 'absent' || limit.kind === 'unbounded') && !hasOffset) {
    return base
  }

  const maxAfterOffset = base.max === null || offset === null ? base.max : Math.max(0, base.max - offset)
  const minAfterOffset = offset === null ? 0 : Math.max(0, base.min - offset)
  const maxAfterLimit =
    limit.kind === 'constant' && (query.limitWithTies !== true || limit.value === 0)
      ? maxAfterOffset === null
        ? limit.value
        : Math.min(maxAfterOffset, limit.value)
      : maxAfterOffset
  const minAfterLimit =
    limit.kind === 'dynamic' ? 0 : limit.kind === 'constant' ? Math.min(minAfterOffset, limit.value) : minAfterOffset

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
      hasOffset ? (offset === null ? 'offset_can_drop_rows' : `constant_offset_${offset}`) : null,
    ]
      .filter((part): part is string => part !== null)
      .join('+'),
  }
}

function uniqueProofRelation(query: PgAnalyzerQuery): UniqueJoinSource | null {
  const rtable = query.rtable ?? []
  if (query.commandType === 'SELECT') {
    const rowSources = rtable
      .map((rte, index) => ({ rte, varno: index + 1 }))
      .filter(({ rte }) => rte.kind !== 'JOIN' && rte.kind !== 'GROUP')
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

interface EqualityConstraint {
  readonly expressionKey: string
  readonly inputCollationOid: number
  readonly opno: number | null
}

interface UniqueLookupKey {
  readonly columns: readonly {
    readonly expression: PgAnalyzerExpr
    readonly collationOid: number
    readonly opfamilyOid: number
  }[]
  readonly nullsNotDistinct: boolean
  readonly proof: string
}

function rebaseIndexExpression(expr: PgAnalyzerExpr, relid: number, varno: number): PgAnalyzerExpr {
  const rebase = (child: PgAnalyzerExpr) => rebaseIndexExpression(child, relid, varno)
  if (expr.tag === 'Var') {
    return (expr.varlevelsup ?? 0) === 0 && expr.relid === relid ? { ...expr, varno } : { tag: 'UNRECOGNIZED' }
  }
  return {
    ...expr,
    ...(expr.arg ? { arg: rebase(expr.arg) } : {}),
    ...(expr.args
      ? { args: expr.args.map((arg) => rebase(targetExprFromAggregateArg(arg) ?? { tag: 'UNRECOGNIZED' })) }
      : {}),
    ...(expr.elements ? { elements: expr.elements.map(rebase) } : {}),
    ...(expr.whenClauses ? { whenClauses: expr.whenClauses.map(rebase) } : {}),
    ...(expr.condition ? { condition: rebase(expr.condition) } : {}),
    ...(expr.result ? { result: rebase(expr.result) } : {}),
    ...(expr.defresult ? { defresult: rebase(expr.defresult) } : {}),
  }
}

function uniquePredicateKey(scope: QueryScope, expr: PgAnalyzerExpr | null | undefined): string | null {
  if (!expr || expr.truncated) return null
  if ((expr.tag === 'NullTest' && expr.argIsRow === false) || expr.tag === 'BooleanTest') {
    const arg = predicateExpressionKey(scope, expr.arg)
    return arg ? JSON.stringify([expr.tag, expr.nullTestType ?? expr.boolTestType, arg]) : null
  }
  if (expr.tag === 'BoolExpr' && expr.args) {
    const args = expr.args.map((arg) => uniquePredicateKey(scope, targetExprFromAggregateArg(arg)))
    return args.every((arg) => arg !== null) ? JSON.stringify([expr.boolOp, args]) : null
  }
  return predicateExpressionKey(scope, expr)
}

function partialIndexApplies(scope: QueryScope, predicate: PgAnalyzerExpr): boolean {
  const outcomes = predicateTruthValues(scope, predicate)
  if (outcomes.length === 1 && outcomes[0] === true) return true
  if (predicate.tag === 'BoolExpr' && predicate.boolOp === 'AND') {
    return exprChildren(predicate).every((child) => partialIndexApplies(scope, child))
  }
  const key = uniquePredicateKey(scope, predicate)
  if (!key) return false
  const contains = (qual: PgAnalyzerExpr | null | undefined): boolean =>
    Boolean(
      qual &&
        (uniquePredicateKey(scope, qual) === key ||
          (qual.tag === 'BoolExpr' && qual.boolOp === 'AND' && exprChildren(qual).some(contains)))
    )
  return contains(scope.query.whereQual)
}

function sourceLookupKeys(
  catalog: CatalogFacts,
  query: PgAnalyzerQuery,
  varno: number,
  seen: readonly PgAnalyzerQuery[] = [],
  parent: QueryScope | null = null
): readonly UniqueLookupKey[] {
  if (seen.includes(query) || seen.length >= 32) return []
  const rte = query.rtable?.[varno - 1]
  const scope = queryScope(query, parent, catalog)
  if (rte?.kind === 'RELATION' && rte.relid) {
    const relid = rte.relid
    return (catalog.uniqueIndexesByRelid.get(relid) ?? []).flatMap((index) => {
      if (rte.inh && index.has_inheritors && index.relkind !== 'p') return []
      if (index.predicate && !partialIndexApplies(scope, rebaseIndexExpression(index.predicate, relid, varno))) {
        return []
      }
      let expressionIndex = 0
      const columns = index.attnums.map((attnum, keyIndex) => {
        const column = catalog.columns.get(`${relid}:${attnum}`)
        const expression = attnum === 0 ? index.expressions?.[expressionIndex++] : undefined
        return {
          collationOid: index.collation_oids[keyIndex] ?? 0,
          expression: expression
            ? rebaseIndexExpression(expression, relid, varno)
            : ({
                relid,
                tag: 'Var',
                typeOid: column?.atttypid,
                varattno: attnum,
                varlevelsup: 0,
                varno,
                varreturningtype: 'DEFAULT',
              } as const),
          opfamilyOid: index.opfamily_oids[keyIndex] ?? 0,
        }
      })
      if (columns.length === 0 || columns.some((column) => !predicateExpressionKey(scope, column.expression))) {
        return []
      }
      return [
        {
          columns,
          nullsNotDistinct: index.indnullsnotdistinct,
          proof: `${index.indisprimary ? 'primary_key' : 'unique_index'}_equality:${index.index_name}`,
        },
      ]
    })
  }
  let source: PgAnalyzerQuery | undefined
  let sourceParent = scope
  if (rte?.kind === 'SUBQUERY') source = rte.subquery
  if (rte?.kind === 'CTE' && rte.cteSelfReference !== true) {
    const owner = queryScopeAtLevel(scope, rte.cteLevelSup ?? 0)
    const cte = owner ? cteByName(owner.query, rte.cteName) : undefined
    if (owner && cte?.recursive !== true) {
      source = cte?.query
      sourceParent = owner
    }
  }
  if (!source || source.commandType !== 'SELECT' || !hasSimpleProjection(source) || source.rtable?.length !== 1)
    return []
  const sourceScope = queryScope(source, sourceParent)
  const targets = resultTargets(source)
  return sourceLookupKeys(catalog, source, 1, [...seen, query], sourceParent).flatMap((key) => {
    const columns = key.columns.map((column) => {
      const identity = predicateExpressionKey(sourceScope, column.expression)
      const outputIndex = targets.findIndex(
        (target) => identity !== null && predicateExpressionKey(sourceScope, target.expr) === identity
      )
      const target = targets[outputIndex]
      return outputIndex < 0 || !target?.expr
        ? null
        : {
            ...column,
            expression: {
              tag: 'Var',
              typeOid: target.expr.typeOid,
              varattno: outputIndex + 1,
              varlevelsup: 0,
              varno,
            } as PgAnalyzerExpr,
          }
    })
    return columns.every((column) => column !== null)
      ? [{ ...key, columns, proof: `${rte?.kind === 'CTE' ? 'cte' : 'subquery'}_key:${key.proof}` }]
      : []
  })
}

function equalityConstraintsFromQual(
  expr: PgAnalyzerExpr | null | undefined,
  scope: QueryScope,
  output: EqualityConstraint[] = []
): readonly EqualityConstraint[] {
  if (!expr) {
    return output
  }

  if (expr.tag === 'BoolExpr' && expr.boolOp === 'AND') {
    for (const child of exprChildren(expr)) {
      equalityConstraintsFromQual(child, scope, output)
    }
    return output
  }

  if (expr.tag === 'NullTest' && expr.argIsRow === false && expr.nullTestType === 'IS_NULL') {
    const expressionKey = predicateExpressionKey(scope, expr.arg)
    if (expressionKey) output.push({ expressionKey, inputCollationOid: 0, opno: null })
    return output
  }
  if (expr.tag !== 'OpExpr' || expr.isStrict !== true || !expr.opno || expr.args?.length !== 2) {
    return output
  }

  const left = targetExprFromAggregateArg(expr.args[0])
  const right = targetExprFromAggregateArg(expr.args[1])
  const expressionKey = isImmutableRowIndependentExpr(right)
    ? predicateExpressionKey(scope, left)
    : isImmutableRowIndependentExpr(left)
      ? predicateExpressionKey(scope, right)
      : null
  if (expressionKey) {
    output.push({
      expressionKey,
      inputCollationOid: expr.inputCollationOid ?? 0,
      opno: expr.opno,
    })
  }

  return output
}

function uniqueIndexIsConstrained(
  catalog: CatalogFacts,
  scope: QueryScope,
  index: UniqueLookupKey,
  constraints: readonly EqualityConstraint[]
): boolean {
  return index.columns.every((column) =>
    constraints.some(
      (constraint) =>
        constraint.expressionKey === predicateExpressionKey(scope, column.expression) &&
        (constraint.opno === null
          ? index.nullsNotDistinct
          : constraint.inputCollationOid === column.collationOid &&
            catalog.uniqueEqualityOperators.has(uniqueEqualityOperatorKey(column.opfamilyOid, constraint.opno)))
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

function uniqueClosureRelation(catalog: CatalogFacts, scope: QueryScope, varno: number): UniqueJoinClosureRelation {
  const { query } = scope
  return {
    indexes: sourceLookupKeys(catalog, query, varno, [], scope.parent).flatMap((key) => {
      if (
        key.columns.some(
          (column) =>
            column.expression.tag !== 'Var' || column.expression.varno !== varno || !column.expression.varattno
        )
      )
        return []
      return [
        {
          attnums: key.columns.map((column) => column.expression.varattno as number),
          collationOids: key.columns.map((column) => column.collationOid),
          opfamilyOids: key.columns.map((column) => column.opfamilyOid),
          proof: key.proof.replace('_equality:', ':'),
        },
      ]
    }),
    varno,
  }
}

function hasSimpleProjection(query: PgAnalyzerQuery): boolean {
  return !(
    query.hasAggs === true ||
    query.hasSetOperations === true ||
    query.hasTargetSRFs === true ||
    (query.groupClauseCount ?? 0) > 0 ||
    (query.groupingSetsCount ?? 0) > 0
  )
}

function uniqueIndexRowBounds(catalog: CatalogFacts, scope: QueryScope): TypedSqlPostgresIrRowBounds | null {
  const { query } = scope
  if (query.commandType !== 'SELECT' && query.commandType !== 'UPDATE' && query.commandType !== 'DELETE') {
    return null
  }
  if (
    (query.hasAggs === true && (query.groupClauseCount ?? 0) === 0) ||
    (query.hasHavingQual === true && (query.groupClauseCount ?? 0) === 0) ||
    query.hasSetOperations === true ||
    query.hasTargetSRFs === true ||
    (query.groupingSetsCount ?? 0) > 0
  ) {
    return null
  }

  const relation = uniqueProofRelation(query)
  const varno = relation?.varno ?? (query.commandType === 'SELECT' && query.rtable?.length === 1 ? 1 : null)
  if (!varno || !query.whereQual) {
    return null
  }

  const constraints = equalityConstraintsFromQual(query.whereQual, scope)
  const uniqueIndex = sourceLookupKeys(catalog, query, varno, [], scope.parent).find((index) =>
    uniqueIndexIsConstrained(catalog, scope, index, constraints)
  )
  if (!uniqueIndex) {
    return null
  }

  return {
    max: 1,
    min: 0,
    proof: uniqueIndex.proof,
  }
}

function uniqueJoinRowBounds(
  catalog: CatalogFacts,
  scope: QueryScope,
  seen: readonly PgAnalyzerQuery[]
): TypedSqlPostgresIrRowBounds | null {
  const { query } = scope
  if (
    query.commandType !== 'SELECT' ||
    (query.hasAggs === true && (query.groupClauseCount ?? 0) === 0) ||
    (query.hasHavingQual === true && (query.groupClauseCount ?? 0) === 0) ||
    query.hasSetOperations === true ||
    query.hasTargetSRFs === true ||
    (query.groupingSetsCount ?? 0) > 0
  ) {
    return null
  }
  const input = collectUniqueJoinProofInput(query)
  const relations = (input?.sources ?? []).map((relation) => uniqueClosureRelation(catalog, scope, relation.varno))
  const proofs = input ? inferUniqueJoinClosure(relations, input.constraints, catalog.uniqueEqualityOperators) : null

  if (proofs) {
    return { max: 1, min: 0, proof: `unique_join_closure(${proofs.join(',')})` }
  }
  if ((query.rtable ?? []).filter((rte) => rte.kind !== 'JOIN' && rte.kind !== 'GROUP').length < 2) {
    return null
  }

  const sources: JoinRowBoundSource[] = (query.rtable ?? []).map((rte, index) => {
    let bounds: TypedSqlPostgresIrRowBounds = { max: null, min: 0, proof: 'unbounded' }
    const source = rowBoundSource(scope, rte)
    if (source) {
      bounds = inferRowBounds(catalog, source.scope, seen)
    } else if (rte.kind === 'VALUES' && rte.valuesLists) {
      const count = rte.valuesLists.length
      bounds = { max: count, min: count, proof: `values_${count}_rows` }
    }
    return {
      bounds,
      indexes: uniqueClosureRelation(catalog, scope, index + 1).indexes,
      lateral: rte.lateral === true,
      relid: rte.kind === 'RELATION' ? (rte.relid ?? null) : null,
      varno: index + 1,
    }
  })
  const bounds = inferJoinTreeRowBounds(query, sources, catalog.uniqueEqualityOperators)
  if (!bounds) {
    return null
  }

  return {
    ...bounds,
    min:
      query.hasHavingQual === true
        ? 0
        : (query.groupClauseCount ?? 0) > 0 || (query.distinctClauseCount ?? 0) > 0
          ? Math.min(bounds.min, 1)
          : bounds.min,
  }
}

// Expand only a bounded number of alternatives. An unknown disjunct must
// remain present: dropping it would turn an upper bound into an underestimate.
function finiteQualAlternatives(
  expr: PgAnalyzerExpr,
  budget: { remaining: number }
): readonly (readonly PgAnalyzerExpr[])[] | null {
  budget.remaining -= 1
  if (budget.remaining < 0 || expr.truncated) return null
  if (expr.tag === 'ScalarArrayOpExpr' && expr.useOr === true && expr.isStrict === true && expr.args?.length === 2) {
    const left = targetExprFromAggregateArg(expr.args[0])
    const right = targetExprFromAggregateArg(expr.args[1])
    if (
      left &&
      right?.tag === 'ArrayExpr' &&
      right.multidims === false &&
      right.elements?.every(isImmutableRowIndependentExpr)
    ) {
      if (right.elements.length > 64) return null
      return right.elements.map((element) => [{ ...expr, args: [left, element], returnsSet: false, tag: 'OpExpr' }])
    }
  }
  if (expr.tag !== 'BoolExpr' || !expr.args || !['AND', 'OR'].includes(expr.boolOp ?? '')) return [[expr]]
  let alternatives: readonly (readonly PgAnalyzerExpr[])[] = expr.boolOp === 'AND' ? [[]] : []
  for (const child of exprChildren(expr)) {
    const next = finiteQualAlternatives(child, budget)
    if (!next) return null
    if (expr.boolOp === 'AND') {
      if (alternatives.length * next.length > 64) return null
      alternatives = alternatives.flatMap((left) => next.map((right) => [...left, ...right]))
    } else {
      if (alternatives.length + next.length > 64) return null
      alternatives = [...alternatives, ...next]
    }
  }
  return alternatives
}

function finiteKeyAlternativeRowBounds(
  catalog: CatalogFacts,
  scope: QueryScope,
  seen: readonly PgAnalyzerQuery[]
): TypedSqlPostgresIrRowBounds | null {
  const { query } = scope
  if (
    !query.whereQual ||
    query.hasTargetSRFs ||
    query.hasSetOperations ||
    (query.groupingSetsCount ?? 0) > 0 ||
    ((query.hasAggs || query.hasHavingQual) && (query.groupClauseCount ?? 0) === 0)
  )
    return null
  const alternatives = finiteQualAlternatives(query.whereQual, { remaining: 256 })
  if (
    !alternatives ||
    (alternatives.length === 1 && alternatives[0]?.length === 1 && alternatives[0]?.[0] === query.whereQual)
  )
    return null
  const seenAlternatives = new Set<string>()
  let max = 0
  for (const clauses of alternatives) {
    const keys = clauses.map((clause) => uniquePredicateKey(scope, clause))
    if (keys.every((key) => key !== null)) {
      const key = JSON.stringify([...new Set(keys)].sort())
      if (seenAlternatives.has(key)) continue
      seenAlternatives.add(key)
    }
    const whereQual: PgAnalyzerExpr =
      clauses.length === 1 ? (clauses[0] as PgAnalyzerExpr) : { tag: 'BoolExpr', boolOp: 'AND', args: clauses }
    const branch = { ...query, whereQual }
    const bounds =
      uniqueIndexRowBounds(catalog, queryScope(branch, scope.parent, catalog)) ??
      uniqueJoinRowBounds(catalog, queryScope(branch, scope.parent, catalog), seen)
    if (bounds?.max === null || bounds?.max === undefined) return null
    max += bounds.max
    if (!Number.isSafeInteger(max)) return null
  }
  return { max, min: 0, proof: `finite_key_alternatives_${max}` }
}

function finiteProjectedValues(
  scope: QueryScope,
  expr: PgAnalyzerExpr | null | undefined,
  seen: readonly VarLocation[] = []
): ReadonlySet<string> | null {
  if (!expr || expr.truncated || seen.length > 32) return null
  if (isImmutableRowIndependentExpr(expr)) {
    const key = predicateExpressionKey(scope, expr)
    return key ? new Set([key]) : null
  }
  const unwrapped = unwrapValuePreservingExpr(expr)
  if (unwrapped?.tag !== 'Var' || (unwrapped.varlevelsup ?? 0) > 0) return null
  const nestedSeen = visitVar(seen, scope, unwrapped)
  if (!nestedSeen) return null
  const source = resolveImmediateVarSource(scope, unwrapped)
  const union = (left: ReadonlySet<string> | null, right: ReadonlySet<string> | null): ReadonlySet<string> | null => {
    if (!left || !right || left.size + right.size > 256) return null
    return new Set([...left, ...right])
  }
  let values: ReadonlySet<string> | null = null
  if (source.kind === 'expressions') {
    values = source.expressions.reduce<ReadonlySet<string> | null>(
      (domain, expression) => union(domain, finiteProjectedValues(source.scope, expression, nestedSeen)),
      new Set()
    )
  } else if (source.kind === 'queryOutput') {
    values = foldQueryOutput<ReadonlySet<string> | null>(source.scope, source.outputIndex, {
      except: (left) => left,
      intersect: (left, right) => (!left ? right : !right || left.size <= right.size ? left : right),
      target: (targetScope, target) => finiteProjectedValues(targetScope, target.expr, nestedSeen),
      union,
    })
  }
  return values && (unwrapped.varnullingrels?.length ?? 0) > 0
    ? new Set([...values, JSON.stringify(['null', unwrapped.typeOid])])
    : values
}

function finiteDistinctGroupingBounds(
  catalog: CatalogFacts,
  scope: QueryScope,
  bounds: TypedSqlPostgresIrRowBounds
): TypedSqlPostgresIrRowBounds {
  const { query } = scope
  if (
    query.commandType !== 'SELECT' ||
    query.hasTargetSRFs ||
    query.hasSetOperations ||
    (query.groupingSetsCount ?? 0) > 0
  )
    return bounds
  const sets = [
    { count: query.groupClauseCount ?? 0, expressions: query.groupExpressions, label: 'group_values' },
    { count: query.distinctClauseCount ?? 0, expressions: query.distinctExpressions, label: 'distinct_values' },
  ]
  if (sets.every((set) => set.count === 0)) return bounds
  let result = bounds
  for (const set of sets) {
    if (set.count === 0 || set.expressions?.length !== set.count) continue
    let maximum: number | null = 1
    for (const expression of set.expressions) {
      // The envelope currently carries grouping expressions, not their
      // equality operators. Do not assume custom type/operator semantics.
      const type = catalog.types.get(expression.typeOid ?? 0)
      if (!type || type.pgTypeSchema !== 'pg_catalog' || type.pgTypeOid >= 16384 || type.pgTypeKind !== 'base') {
        maximum = null
        break
      }
      let correlated = false
      walkExpr(expression, (expr) => {
        if (expr.tag === 'Var' && (expr.varlevelsup ?? 0) > 0) correlated = true
      })
      const inferred = correlated ? null : expressionFiniteCardinality(catalog, scope, expression)
      const projected = correlated ? null : (finiteProjectedValues(scope, expression)?.size ?? null)
      const count = inferred === null ? projected : projected === null ? inferred : Math.min(inferred, projected)
      if (count === null || !Number.isSafeInteger(maximum * count)) {
        maximum = null
        break
      }
      maximum *= count
    }
    if (maximum !== null && (result.max === null || maximum < result.max)) {
      result = { max: maximum, min: Math.min(result.min, maximum), proof: `${result.proof}+${set.label}_${maximum}` }
    }
  }
  return result
}

function rowBoundSource(
  scope: QueryScope,
  source: PgAnalyzerRte | undefined
): { readonly kind: 'cte' | 'subquery'; readonly scope: QueryScope } | null {
  if (source?.kind === 'SUBQUERY') {
    if (!source.subquery) {
      throw new Error('internal analyzer envelope inconsistency: SUBQUERY row source is missing its query')
    }
    return { kind: 'subquery', scope: queryScope(source.subquery, scope) }
  }
  if (source?.kind === 'CTE' && source.cteSelfReference !== true) {
    if (
      typeof source.cteName !== 'string' ||
      !Number.isInteger(source.cteLevelSup) ||
      (source.cteLevelSup as number) < 0
    ) {
      throw new Error('internal analyzer envelope inconsistency: CTE row source has malformed owner identity')
    }
    const owner = queryScopeAtLevel(scope, source.cteLevelSup as number)
    if (!owner) {
      throw new Error(
        `internal analyzer envelope inconsistency: CTE ${JSON.stringify(source.cteName)} owner level ${source.cteLevelSup as number} has no query scope`
      )
    }
    const cte = cteByName(owner.query, source.cteName)
    if (!cte?.query) {
      throw new Error(
        `internal analyzer envelope inconsistency: CTE ${JSON.stringify(source.cteName)} is absent from its exact owner query`
      )
    }
    return cte.recursive === true ? null : { kind: 'cte', scope: queryScope(cte.query, owner) }
  }
  return null
}

function projectionSourceRowBounds(
  catalog: CatalogFacts,
  scope: QueryScope,
  seen: readonly PgAnalyzerQuery[]
): TypedSqlPostgresIrRowBounds | null {
  const { query } = scope
  if (query.commandType !== 'SELECT' || !hasSimpleProjection(query) || query.hasHavingQual === true) {
    return null
  }

  const source = rowBoundSource(scope, query.rtable?.length === 1 ? query.rtable[0] : undefined)
  if (!source) {
    return null
  }

  const sourceBounds = inferRowBounds(catalog, source.scope, seen)
  return {
    max: sourceBounds.max,
    min: query.whereQual ? 0 : (query.distinctClauseCount ?? 0) > 0 ? Math.min(sourceBounds.min, 1) : sourceBounds.min,
    proof: `${source.kind}_projection:${sourceBounds.proof}${query.whereQual ? '+outer_qual_can_filter' : ''}${(query.distinctClauseCount ?? 0) > 0 ? '+distinct_can_merge_rows' : ''}`,
  }
}

function exactValuesRowBounds(query: PgAnalyzerQuery): TypedSqlPostgresIrRowBounds | null {
  if (
    query.commandType !== 'SELECT' ||
    !hasSimpleProjection(query) ||
    query.whereQual ||
    query.hasHavingQual === true
  ) {
    return null
  }

  const values = query.rtable?.length === 1 ? query.rtable[0] : undefined
  if (values?.kind !== 'VALUES' || !values.valuesLists) {
    return null
  }
  const count = values.valuesLists.length
  return {
    max: count,
    min: (query.distinctClauseCount ?? 0) > 0 ? Math.min(count, 1) : count,
    proof: `values_${count}_rows${(query.distinctClauseCount ?? 0) > 0 ? '+distinct_can_merge_rows' : ''}`,
  }
}

function groupedSourceRowBounds(
  catalog: CatalogFacts,
  scope: QueryScope,
  seen: readonly PgAnalyzerQuery[]
): TypedSqlPostgresIrRowBounds | null {
  const { query } = scope
  if (
    query.commandType !== 'SELECT' ||
    (query.groupClauseCount ?? 0) === 0 ||
    (query.groupingSetsCount ?? 0) > 0 ||
    query.hasSetOperations === true ||
    query.hasTargetSRFs === true
  ) {
    return null
  }

  const rowSources = (query.rtable ?? []).filter((rte) => rte.kind !== 'GROUP')
  const source = rowSources.length === 1 ? rowSources[0] : undefined
  if (source?.kind === 'VALUES' && source.valuesLists) {
    const count = source.valuesLists.length
    const min = query.whereQual || query.hasHavingQual === true || count === 0 ? 0 : 1
    return { max: count, min, proof: `values_grouping_${count}_rows${query.whereQual ? '+qual_can_filter' : ''}` }
  }
  const sourceQuery = rowBoundSource(scope, source)
  if (!sourceQuery) {
    return null
  }

  const sourceBounds = inferRowBounds(catalog, sourceQuery.scope, seen)
  return {
    max: sourceBounds.max,
    min: query.whereQual || query.hasHavingQual === true || sourceBounds.min === 0 ? 0 : 1,
    proof: `${sourceQuery.kind}_grouping:${sourceBounds.proof}${query.whereQual ? '+qual_can_filter' : ''}`,
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
  scope: QueryScope,
  operation: PgAnalyzerSetOperation,
  seen: readonly PgAnalyzerQuery[]
): TypedSqlPostgresIrRowBounds {
  const { query } = scope
  if (operation.kind === 'leaf') {
    const leafQuery = query.rtable?.[operation.rtindex - 1]?.subquery
    if (!leafQuery) {
      throw new Error(
        `internal analyzer envelope inconsistency: set-operation leaf RTE ${operation.rtindex} is missing its query`
      )
    }
    return inferRowBounds(catalog, queryScope(leafQuery, scope), seen)
  }

  const left = setOperationRowBounds(catalog, scope, operation.left, seen)
  const right = setOperationRowBounds(catalog, scope, operation.right, seen)
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
  scope: QueryScope,
  seen: readonly PgAnalyzerQuery[]
): TypedSqlPostgresIrRowBounds {
  const { query } = scope
  if (resultTargets(query).length === 0 && query.commandType !== 'SELECT') {
    return { max: 0, min: 0, proof: 'no_result_columns' }
  }

  const hasGroupingSets = (query.groupingSetsCount ?? 0) > 0
  const globalAggregate =
    query.commandType === 'SELECT' &&
    (query.hasAggs || query.hasHavingQual) &&
    (query.groupClauseCount ?? 0) === 0 &&
    !hasGroupingSets
  // A global aggregate produces its implicit group even when WHERE removes
  // every input row. Grouping sets can also contain an empty grouping set.
  const contradictionQuery = globalAggregate || hasGroupingSets ? { ...query, whereQual: null, fromTree: null } : query
  if (scopeHasContradiction(queryScope(contradictionQuery, scope.parent, catalog))) {
    return { max: 0, min: 0, proof: 'contradictory_qual' }
  }

  if (query.hasTargetSRFs === true) {
    return { max: null, min: 0, proof: 'target_srf' }
  }
  if (query.setOperation) {
    return setOperationRowBounds(catalog, scope, query.setOperation, seen)
  }
  if (query.hasSetOperations === true) {
    throw new Error('internal analyzer envelope inconsistency: query has set operations without a set-operation tree')
  }

  const valuesBounds = exactValuesRowBounds(query)
  if (valuesBounds) {
    return valuesBounds
  }

  const uniqueBounds = uniqueIndexRowBounds(catalog, scope)
  if (uniqueBounds) {
    return uniqueBounds
  }
  const uniqueJoinBounds = uniqueJoinRowBounds(catalog, scope, seen)
  if (uniqueJoinBounds) {
    return uniqueJoinBounds
  }
  const finiteKeyBounds = finiteKeyAlternativeRowBounds(catalog, scope, seen)
  if (finiteKeyBounds) return finiteKeyBounds
  const projectionBounds = projectionSourceRowBounds(catalog, scope, seen)
  if (projectionBounds) {
    return projectionBounds
  }
  const groupedBounds = groupedSourceRowBounds(catalog, scope, seen)
  if (groupedBounds) {
    return groupedBounds
  }

  if (query.commandType === 'SELECT') {
    const hasGrouping = (query.groupClauseCount ?? 0) > 0 || (query.groupingSetsCount ?? 0) > 0
    if ((query.hasAggs === true || query.hasHavingQual === true) && !hasGrouping) {
      return query.hasHavingQual === true
        ? { max: 1, min: 0, proof: 'global_aggregate_with_having' }
        : { max: 1, min: 1, proof: 'global_aggregate' }
    }

    if ((query.rtable?.length ?? 0) === 0) {
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
  scope: QueryScope,
  seen: readonly PgAnalyzerQuery[] = []
): TypedSqlPostgresIrRowBounds {
  const { query } = scope
  if (seen.includes(query)) {
    throw new Error('internal analyzer envelope inconsistency: cyclic query row-bound ownership')
  }
  const nestedSeen = [...seen, query]
  return applyLimitBounds(
    catalog,
    query,
    finiteDistinctGroupingBounds(catalog, scope, inferBaseRowBounds(catalog, scope, nestedSeen))
  )
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
  const walkFromQuals = (node: PgAnalyzerFromNode | null | undefined): void => {
    if (!node || node.truncated === true) {
      return
    }
    if (node.tag === 'FromExpr') {
      // The root qualification is already represented by query.whereQual.
      if (node !== query.fromTree) {
        walkExpr(node.quals, visitExpr)
      }
      for (const child of node.fromlist ?? []) {
        walkFromQuals(child)
      }
    } else if (node.tag === 'JoinExpr') {
      walkExpr(node.quals, visitExpr)
      walkFromQuals(node.left)
      walkFromQuals(node.right)
    }
  }
  walkFromQuals(query.fromTree)
  walkExpr(query.havingQual, visitExpr)
  walkExpr(query.limitCount, visitExpr)
  walkExpr(query.limitOffset, visitExpr)
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
    for (const flag of ['hasModifyingCTE', 'hasRowMarks', 'hasVolatileFunctions'] as const) {
      if (typeof query[flag] !== 'boolean') {
        throw new Error(`analyzer returned a query without required access fact ${flag}.`)
      }
    }
    if (!['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'UTILITY'].includes(query.commandType)) {
      throw new Error(`analyzer returned an unsupported access command ${query.commandType}.`)
    }
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
    } else if (query.commandType === 'UTILITY') {
      throw new Error(`analyzer returned an unsupported rewritten utility ${query.utilityKind ?? 'UNKNOWN'}.`)
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
        for (const oid of [expr.aggfnoid, expr.funcid, expr.opfuncid, expr.winfnoid]) {
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
          a.atttypid::int as atttypid,
          a.attname,
          a.attnotnull,
          case when c.relkind in ('r', 'p')
            then pg_temp.postgres_typed_sql_column_check_not_null(c.oid, a.attnum::integer)
            else false end as check_rejects_null,
          (c.relhastriggers or c.relhassubclass or a.attgenerated <> '') as update_may_change_implicitly
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
      typeOids.add(row.atttypid)
    }
  }

  // Whole-row JSON conversions need every visible attribute type, even when
  // the parsed expression only mentions the relation's composite type.
  typeOids.add(25)
  const types = await loadPostgresTypeFacts(client, [...typeOids])

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
          i.indnullsnotdistinct,
          min(pg_get_expr(i.indexprs, i.indrelid)) as expressions_sql,
          min(pg_get_expr(i.indpred, i.indrelid)) as predicate_sql,
          format('%I.%I', relation_namespace.nspname, relation_class.relname) as qualified_relation,
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
        join pg_namespace relation_namespace
          on relation_namespace.oid = relation_class.relnamespace
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
          and key.ordinality <= i.indnkeyatts
          and key.attnum >= 0
        group by
          i.indrelid,
          i.indexrelid,
          index_class.relname,
          i.indisprimary,
          i.indnullsnotdistinct,
          i.indnkeyatts,
          relation_class.relkind,
          relation_namespace.nspname,
          relation_class.relname
        having count(*) = i.indnkeyatts
      `,
      [[...relationRelids]]
    )
    for (const row of result.rows) {
      let expressions: readonly PgAnalyzerExpr[] = []
      let predicate: PgAnalyzerExpr | null = null
      if (row.expressions_sql || row.predicate_sql) {
        // pg_get_expr supplies PostgreSQL's own deparse, and the native entry
        // point only parses/analyzes this SELECT. Index expressions and
        // predicates are never executed while loading catalog evidence.
        const analysis = await invokeNativeAnalyzer(
          client,
          `select ${row.expressions_sql ?? '1'} from only ${row.qualified_relation}${row.predicate_sql ? ` where ${row.predicate_sql}` : ''}`
        )
        validateAnalyzerSchema(analysis)
        const indexQuery = validateSingleStatementAnalyzerEnvelope(analysis, 0).primaryQuery
        expressions = row.expressions_sql
          ? resultTargets(indexQuery).flatMap((target) => (target.expr ? [target.expr] : []))
          : []
        predicate = indexQuery.whereQual ?? null
        if (expressions.length !== row.attnums.filter((attnum) => attnum === 0).length) continue
      }
      const entries = uniqueIndexesByRelid.get(row.relid) ?? []
      entries.push({ ...row, expressions, predicate })
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

const returningRowImages = {
  DELETE: { DEFAULT: 'old', NEW: 'unavailable', OLD: 'old' },
  INSERT: { DEFAULT: 'new', NEW: 'new', OLD: 'unavailable' },
  MERGE: { DEFAULT: 'actionDefault', NEW: 'possiblyUnavailable', OLD: 'possiblyUnavailable' },
  UPDATE: { DEFAULT: 'new', NEW: 'new', OLD: 'old' },
} as const

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

  const { commandType } = scope.query
  const rowType = expr.varreturningtype
  return isDataModifyingCommand(commandType) && (rowType === 'DEFAULT' || rowType === 'NEW' || rowType === 'OLD')
    ? returningRowImages[commandType][rowType]
    : 'unknown'
}

function updateAssignsAttribute(scope: QueryScope, expr: PgAnalyzerExpr): boolean {
  return (
    scope.query.commandType === 'UPDATE' &&
    scope.query.targetList?.some((target) => target.resjunk !== true && target.resno === expr.varattno) === true
  )
}

function updatePreservesAttribute(scope: QueryScope, expr: PgAnalyzerExpr): boolean {
  if (scope.query.commandType !== 'UPDATE' || updateAssignsAttribute(scope, expr)) {
    return false
  }
  const target = scope.query.rtable?.[(expr.varno ?? 0) - 1]
  return target?.kind === 'RELATION' && target.relid !== undefined
    ? scope.catalog.columns.get(`${target.relid}:${expr.varattno}`)?.update_may_change_implicitly === false
    : false
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
      // Triggers, descendants, and generated columns can change attributes
      // absent from SET. Reuse input facts only with explicit catalog evidence.
      return updatePreservesAttribute(scope, expr) ? ':old' : ':new'
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

function guaranteedJoinQuals(node: PgAnalyzerFromNode | null | undefined): readonly PgAnalyzerExpr[] {
  if (!node || node.truncated) return []
  if (node.tag === 'FromExpr') {
    return (node.fromlist ?? []).flatMap(guaranteedJoinQuals)
  }
  if (node.tag !== 'JoinExpr') return []
  if (node.joinType === 'INNER') {
    return [...guaranteedJoinQuals(node.left), ...guaranteedJoinQuals(node.right), ...(node.quals ? [node.quals] : [])]
  }
  // ON does not constrain the preserved side of an outer join. Facts from
  // inner joins nested in its nullable side also cease to hold after extension.
  if (node.joinType === 'LEFT') return guaranteedJoinQuals(node.left)
  if (node.joinType === 'RIGHT') return guaranteedJoinQuals(node.right)
  return []
}

function rowLocation(scope: QueryScope, expr: PgAnalyzerExpr): VarLocation | null {
  const owner = queryScopeAtLevel(scope, expr.varlevelsup ?? 0)
  return expr.tag === 'Var' && owner && expr.varno !== undefined
    ? { key: `${expr.varno}${varValueVersion(owner, expr)}`, query: owner.query }
    : null
}

function scopeProvesRowPresent(scope: QueryScope, expr: PgAnalyzerExpr): boolean {
  const location = rowLocation(scope, expr)
  return Boolean(location && scope.predicateFacts.get(location.query)?.has(rowPresentFactKey(location.key)))
}

function scopeProvesNull(scope: QueryScope, expr: PgAnalyzerExpr): boolean {
  if (expr.tag === 'Const') return expr.constIsNull === true
  const location = varLocation(scope, unwrapValuePreservingExpr(expr))
  return Boolean(location && scope.predicateFacts.get(location.query)?.has(nullVarFactKey(location.key)))
}

// Only fingerprint expressions whose value identity is fully represented in
// the native envelope. Unknown constants, volatile calls, and aggregate order
// or DISTINCT semantics cannot be equated by their truncated representation.
function predicateExpressionKey(scope: QueryScope, expr: PgAnalyzerExpr | null | undefined): string | null {
  if (!expr || expr.truncated) return null
  const type = expr.typeOid
  if (expr.tag === 'Var') {
    if ((expr.varlevelsup ?? 0) !== 0) return null
    const location = varLocation(scope, expr)
    return location ? JSON.stringify(['var', type, location.key, expr.varnullingrels ?? []]) : null
  }
  if (expr.tag === 'Param') return JSON.stringify(['param', type, expr.paramId])
  if (expr.tag === 'Const') {
    if (expr.constIsNull) return JSON.stringify(['null', type])
    if (expr.constString !== undefined) return JSON.stringify(['string', type, expr.constString])
    if (expr.constInteger !== undefined) return JSON.stringify(['integer', type, expr.constInteger])
    if (expr.constBoolean !== undefined) return JSON.stringify(['boolean', type, expr.constBoolean])
    return null
  }
  if (expr.tag === 'RelabelType') return predicateExpressionKey(scope, expr.arg)
  if (expr.tag === 'NullTest' || expr.tag === 'BooleanTest') {
    const arg = predicateExpressionKey(scope, expr.arg)
    return arg ? JSON.stringify([expr.tag, expr.nullTestType, expr.boolTestType, expr.argIsRow, arg]) : null
  }
  if (expr.tag === 'BoolExpr') {
    const args = exprChildren(expr).map((arg) => predicateExpressionKey(scope, arg))
    return args.every((arg) => arg !== null) ? JSON.stringify([expr.tag, expr.boolOp, args]) : null
  }
  if (expr.tag === 'FuncExpr' || expr.tag === 'OpExpr') {
    if (expr.isImmutable !== true || expr.returnsSet !== false || !expr.args) return null
    const args = expr.args.map((arg) => predicateExpressionKey(scope, targetExprFromAggregateArg(arg)))
    return args.every((arg) => arg !== null)
      ? JSON.stringify([expr.tag, type, expr.funcid ?? expr.opno, expr.inputCollationOid, args])
      : null
  }
  if (expr.tag === 'Aggref') {
    const proc = expr.aggfnoid ? scope.catalog.procs.get(expr.aggfnoid) : undefined
    if (
      !proc?.is_builtin ||
      ![
        'count',
        'sum',
        'min',
        'max',
        'avg',
        'array_agg',
        'json_agg',
        'jsonb_agg',
        'bool_and',
        'bool_or',
        'every',
        'string_agg',
        'bit_and',
        'bit_or',
      ].includes(proc.proname) ||
      expr.aggOrderCount !== 0 ||
      expr.aggDistinctCount !== 0 ||
      expr.agglevelsup !== 0 ||
      expr.aggfilter === undefined ||
      !expr.args
    )
      return null
    const args = expr.args.map((arg) => predicateExpressionKey(scope, targetExprFromAggregateArg(arg)))
    const filter = expr.aggfilter ? predicateExpressionKey(scope, expr.aggfilter) : 'no_filter'
    return filter && args.every((arg) => arg !== null)
      ? JSON.stringify(['aggregate', type, expr.aggfnoid, expr.inputCollationOid, expr.aggstar, args, filter])
      : null
  }
  return null
}

function scopeProvesExpressionNonNull(scope: QueryScope, expr: PgAnalyzerExpr): boolean {
  const key = predicateExpressionKey(scope, expr)
  return Boolean(key && scope.predicateFacts.get(scope.query)?.has(nonNullExpressionFactKey(key)))
}

function nonNullPredicateFacts(scope: QueryScope, expression: PgAnalyzerExpr | null | undefined): PredicateFacts {
  const expr = unwrapValuePreservingExpr(expression)
  if (!expr || expr.truncated) return noPredicateFacts
  let facts: PredicateFacts = noPredicateFacts
  const location = varLocation(scope, expr)
  if (location) {
    facts = singletonPredicateFact(location.query, nonNullVarFactKey(location.key))
    const row = rowLocation(scope, expr)
    if (row) facts = mergePredicateFacts(facts, singletonPredicateFact(row.query, rowPresentFactKey(row.key)))
  }
  const key = predicateExpressionKey(scope, expr)
  if (key) facts = mergePredicateFacts(facts, singletonPredicateFact(scope.query, nonNullExpressionFactKey(key)))
  if (expr.tag === 'FuncExpr' && expr.isImmutable === true && expr.funcid && expr.args?.length === 1) {
    const argument = varLocation(scope, unwrapValuePreservingExpr(targetExprFromAggregateArg(expr.args[0])))
    if (argument)
      facts = mergePredicateFacts(
        facts,
        singletonPredicateFact(argument.query, unaryFunctionNonNullFactKey(expr.funcid, argument.key))
      )
  }
  if ((expr.tag === 'FuncExpr' || expr.tag === 'OpExpr') && expr.isStrict === true) {
    for (const arg of expr.args ?? []) {
      facts = mergePredicateFacts(facts, nonNullPredicateFacts(scope, targetExprFromAggregateArg(arg)))
    }
  }
  return facts
}

function nullPredicateFacts(scope: QueryScope, expr: PgAnalyzerExpr | null | undefined): PredicateFacts {
  const location = varLocation(scope, unwrapValuePreservingExpr(expr))
  return location ? singletonPredicateFact(location.query, nullVarFactKey(location.key)) : noPredicateFacts
}

type PredicateOutcome = 'true' | 'false' | 'notTrue' | 'notFalse'

function collectPredicateFacts(
  scope: QueryScope,
  expr: PgAnalyzerExpr | null | undefined,
  outcome: PredicateOutcome = 'true'
): PredicateFacts {
  if (!expr || expr.truncated) return noPredicateFacts
  const accepts = (value: boolean | null) =>
    outcome === 'true'
      ? value === true
      : outcome === 'false'
        ? value === false
        : outcome === 'notTrue'
          ? value !== true
          : value !== false
  if (!predicateTruthValues(scope, expr).some(accepts)) return singletonPredicateFact(scope.query, 'contradiction')
  const facts = collectPredicateStructureFacts(scope, expr, outcome)
  const key = predicateExpressionKey(scope, expr)
  return key
    ? mergePredicateFacts(facts, singletonPredicateFact(scope.query, expressionTruthFactKey(key, outcome)))
    : facts
}

function collectPredicateStructureFacts(
  scope: QueryScope,
  expr: PgAnalyzerExpr,
  outcome: PredicateOutcome
): PredicateFacts {
  if (expr.tag === 'NullTest') {
    if (expr.nullTestType !== 'IS_NULL' && expr.nullTestType !== 'IS_NOT_NULL') return noPredicateFacts
    const positive = outcome === 'true' || outcome === 'notFalse'
    const nonNull = (expr.nullTestType === 'IS_NOT_NULL') === positive
    return nonNull
      ? nonNullPredicateFacts(scope, expr.arg)
      : expr.argIsRow === false
        ? nullPredicateFacts(scope, expr.arg)
        : noPredicateFacts
  }
  if (expr.tag === 'BooleanTest') {
    const positive = outcome === 'true' || outcome === 'notFalse'
    switch (expr.boolTestType) {
      case 'IS_TRUE':
        return collectPredicateFacts(scope, expr.arg, positive ? 'true' : 'notTrue')
      case 'IS_FALSE':
        return collectPredicateFacts(scope, expr.arg, positive ? 'false' : 'notFalse')
      case 'IS_NOT_TRUE':
        return collectPredicateFacts(scope, expr.arg, positive ? 'notTrue' : 'true')
      case 'IS_NOT_FALSE':
        return collectPredicateFacts(scope, expr.arg, positive ? 'notFalse' : 'false')
      case 'IS_UNKNOWN':
        return positive ? nullPredicateFacts(scope, expr.arg) : nonNullPredicateFacts(scope, expr.arg)
      case 'IS_NOT_UNKNOWN':
        return positive ? nonNullPredicateFacts(scope, expr.arg) : nullPredicateFacts(scope, expr.arg)
      default:
        return noPredicateFacts
    }
  }
  if (expr.tag === 'BoolExpr') {
    const children = exprChildren(expr)
    if (expr.boolOp === 'NOT') {
      const inverse = { true: 'false', false: 'true', notTrue: 'notFalse', notFalse: 'notTrue' } as const
      return children.length === 1 ? collectPredicateFacts(scope, children[0], inverse[outcome]) : noPredicateFacts
    }
    const branches = children.map((child) => collectPredicateFacts(scope, child, outcome))
    const allRequired =
      expr.boolOp === 'AND'
        ? outcome === 'true' || outcome === 'notFalse'
        : expr.boolOp === 'OR' && (outcome === 'false' || outcome === 'notTrue')
    return allRequired ? branches.reduce(mergePredicateFacts, noPredicateFacts) : intersectPredicateFacts(branches)
  }
  if (outcome === 'notTrue' || outcome === 'notFalse') return noPredicateFacts
  let facts = nonNullPredicateFacts(scope, expr)
  if (
    expr.tag === 'FuncExpr' &&
    outcome === 'false' &&
    expr.isImmutable === true &&
    expr.funcid &&
    expr.args?.length === 1
  ) {
    const location = varLocation(scope, unwrapValuePreservingExpr(targetExprFromAggregateArg(expr.args[0])))
    if (location)
      facts = mergePredicateFacts(
        facts,
        singletonPredicateFact(location.query, unaryFunctionFalseFactKey(expr.funcid, location.key))
      )
  }
  if (
    expr.tag === 'ScalarArrayOpExpr' &&
    expr.isStrict === true &&
    ((expr.useOr === true && outcome === 'true') || (expr.useOr === false && outcome === 'false'))
  ) {
    for (const arg of expr.args ?? [])
      facts = mergePredicateFacts(facts, nonNullPredicateFacts(scope, targetExprFromAggregateArg(arg)))
  }
  const equality = expr.textEqualityIsExact === true
  const inequality = expr.textInequalityIsExact === true
  if ((equality || inequality) && expr.args?.length === 2) {
    const positive = (outcome === 'true') === equality
    const left = unwrapValuePreservingExpr(targetExprFromAggregateArg(expr.args[0]))
    const right = unwrapValuePreservingExpr(targetExprFromAggregateArg(expr.args[1]))
    const addLiterals = (value: PgAnalyzerExpr | null | undefined, candidates: readonly PgAnalyzerExpr[]) => {
      const location = varLocation(scope, value)
      const labels = candidates
        .filter((candidate) => candidate.constIsNull !== true)
        .map((candidate) => (candidate.tag === 'Const' ? candidate.constString : undefined))
      if (location && labels.length > 0 && labels.every((label): label is string => label !== undefined)) {
        facts = mergePredicateFacts(
          facts,
          singletonPredicateFact(
            location.query,
            (positive ? literalVarFactKey : excludedVarFactKey)(location.key, [...new Set(labels)])
          )
        )
      }
    }
    if (expr.tag === 'OpExpr') {
      if (right) addLiterals(left, [right])
      if (left) addLiterals(right, [left])
      const leftLocation = varLocation(scope, left)
      const rightLocation = varLocation(scope, right)
      if (positive && leftLocation && rightLocation && leftLocation.query === rightLocation.query) {
        facts = mergePredicateFacts(
          facts,
          singletonPredicateFact(leftLocation.query, equalVarsFactKey(leftLocation.key, rightLocation.key))
        )
      }
    } else if (
      expr.tag === 'ScalarArrayOpExpr' &&
      ((expr.useOr === true && outcome === 'true' && equality) ||
        (expr.useOr === false && outcome === 'true' && inequality)) &&
      right?.tag === 'ArrayExpr' &&
      right.multidims === false &&
      right.elements
    ) {
      addLiterals(left, right.elements)
    }
  }
  return facts
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
  let remainingScope = scope
  let canFallThrough = true
  for (const whenClause of expr.whenClauses ?? []) {
    const outcomes = predicateTruthValues(remainingScope, whenClause.condition)
    if (whenClause.result && outcomes.includes(true)) {
      arms.push({
        result: whenClause.result,
        scope: scopeWithQual(remainingScope, whenClause.condition),
      })
    }
    if (outcomes.every((outcome) => outcome === true)) {
      canFallThrough = false
      break
    }
    remainingScope = {
      ...remainingScope,
      predicateFacts: mergePredicateFacts(
        remainingScope.predicateFacts,
        collectPredicateFacts(remainingScope, whenClause.condition, 'notTrue')
      ),
    }
  }
  if (expr.defresult && canFallThrough) {
    arms.push({ result: expr.defresult, scope: remainingScope })
  }
  return arms
}

function predicateTruthValues(scope: QueryScope, expr: PgAnalyzerExpr | null | undefined): readonly (boolean | null)[] {
  if (!expr || expr.truncated) return [true, false, null]
  const key = predicateExpressionKey(scope, expr)
  const facts = scope.predicateFacts.get(scope.query)
  if (key && facts?.has(expressionTruthFactKey(key, 'true'))) return [true]
  if (key && facts?.has(expressionTruthFactKey(key, 'false'))) return [false]
  if (expr.tag === 'Const') {
    if (expr.constIsNull) return [null]
    if (expr.constBoolean !== undefined) return [expr.constBoolean]
  }
  if (expr.tag === 'NullTest' && expr.arg && expr.argIsRow === false) {
    const arg = unwrapValuePreservingExpr(expr.arg)
    if (arg && scopeProvesNull(scope, arg)) return [expr.nullTestType === 'IS_NULL']
    if (arg && scopeProvesNonNull(scope, arg)) return [expr.nullTestType === 'IS_NOT_NULL']
    return [true, false]
  }
  if (
    expr.tag === 'OpExpr' &&
    (expr.textEqualityIsExact === true || expr.textInequalityIsExact === true) &&
    expr.args?.length === 2
  ) {
    const operands = expr.args.map((arg) => unwrapValuePreservingExpr(targetExprFromAggregateArg(arg)))
    const domains = operands.map((operand) => {
      if (operand?.tag === 'Const' && operand.constString !== undefined) return [operand.constString]
      const location = varLocation(scope, operand)
      const [first, ...rest] = location ? literalVarFacts(scope.predicateFacts.get(location.query), location.key) : []
      return first?.filter((label) => rest.every((labels) => labels.includes(label)))
    })
    if (operands.some((operand) => operand && scopeProvesNull(scope, operand))) return [null]
    const [leftDomain, rightDomain] = domains
    if (leftDomain?.length && rightDomain?.length) {
      const results: (boolean | null)[] = [
        ...new Set(
          leftDomain.flatMap((left) =>
            rightDomain.map((right) => (left === right) === (expr.textEqualityIsExact === true))
          )
        ),
      ]
      if (!operands.every((operand) => operand && (operand.tag === 'Const' || scopeProvesNonNull(scope, operand))))
        results.push(null)
      return results
    }
  }
  let values: readonly (boolean | null)[] = [true, false, null]
  if (expr.tag === 'BoolExpr') {
    const children = exprChildren(expr).map((child) => predicateTruthValues(scope, child))
    if (expr.boolOp === 'NOT' && children.length === 1)
      values = children[0]?.map((value) => (value === null ? null : !value)) ?? values
    if (expr.boolOp === 'AND' || expr.boolOp === 'OR') {
      values = children.reduce<readonly (boolean | null)[]>(
        (left, right) => [
          ...new Set(
            left.flatMap((a) =>
              right.map((b) =>
                expr.boolOp === 'AND'
                  ? a === false || b === false
                    ? false
                    : a === null || b === null
                      ? null
                      : true
                  : a === true || b === true
                    ? true
                    : a === null || b === null
                      ? null
                      : false
              )
            )
          ),
        ],
        [expr.boolOp === 'AND']
      )
    }
  } else if (expr.tag === 'BooleanTest') {
    values = [
      ...new Set(
        predicateTruthValues(scope, expr.arg).map((value) => {
          switch (expr.boolTestType) {
            case 'IS_TRUE':
              return value === true
            case 'IS_NOT_TRUE':
              return value !== true
            case 'IS_FALSE':
              return value === false
            case 'IS_NOT_FALSE':
              return value !== false
            case 'IS_UNKNOWN':
              return value === null
            case 'IS_NOT_UNKNOWN':
              return value !== null
            default:
              return null
          }
        })
      ),
    ]
  }
  return values.filter(
    (value) =>
      !(
        key &&
        ((value === true && facts?.has(expressionTruthFactKey(key, 'notTrue'))) ||
          (value === false && facts?.has(expressionTruthFactKey(key, 'notFalse'))))
      )
  )
}

function scopeHasContradiction(scope: QueryScope): boolean {
  if ([...scope.predicateFacts.values()].some((facts) => facts.has('contradiction'))) return true
  let contradiction = false
  const inputScope = { ...scope, evaluationPhase: 'input' as const }
  for (const expression of [scope.query.whereQual, ...guaranteedJoinQuals(scope.query.fromTree)]) {
    walkExpr(expression, (expr) => {
      if (expr.tag !== 'Var' || (expr.varlevelsup ?? 0) !== 0 || !scopeProvesNonNull(inputScope, expr)) return
      const type = checkConstraintTypeForExpr(scope.catalog, inputScope, expr, [])
      if (type?.kind === 'literalUnion' && type.labels.length === 0) contradiction = true
    })
  }
  return contradiction
}

function expressionFiniteCardinality(catalog: CatalogFacts, scope: QueryScope, expr: PgAnalyzerExpr): number | null {
  const unwrapped = unwrapValuePreservingExpr(expr)
  if (!unwrapped || unwrapped.truncated) return null
  if (unwrapped.tag === 'Const' || unwrapped.tag === 'Param') return 1
  const literal = checkConstraintTypeForExpr(catalog, scope, unwrapped, [])
  if (literal?.kind !== 'literalUnion') return null
  return new Set(literal.labels).size + (expressionNullability(catalog, scope, unwrapped).kind === 'nonNull' ? 0 : 1)
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
  expression: PgAnalyzerExpr | null | undefined,
  seen: readonly VarLocation[]
): TypedSqlPostgresIrCheckConstraintTypeExpression | null {
  const expr = unwrapValuePreservingExpr(expression)
  if (!expr || expr.truncated) return null
  if (
    expr.tag === 'Const' &&
    !expr.constIsNull &&
    expr.constString !== undefined &&
    postgresJsonSupportsTextualLiteralRefinement(typeFactForOid(catalog, expr.typeOid, expr.typeName))
  ) {
    return { kind: 'literalUnion', labels: [expr.constString] }
  }
  if (expr.tag === 'CaseExpr' || expr.tag === 'CoalesceExpr') {
    const arms: CaseArm[] = expr.tag === 'CaseExpr' ? [...caseArms(scope, expr)] : []
    if (expr.tag === 'CoalesceExpr') {
      for (const child of exprChildren(expr)) {
        arms.push({ result: child, scope })
        if (expressionNullability(catalog, scope, child, seen).kind === 'nonNull') break
      }
    }
    const types: TypedSqlPostgresIrCheckConstraintTypeExpression[] = []
    for (const arm of arms) {
      if (scopeProvesNull(arm.scope, arm.result)) continue
      const value = unwrapValuePreservingExpr(arm.result)
      if (value?.tag === 'OpExpr' && jsonOperatorShapeForExpr(catalog, arm.scope, value, seen)?.kind === 'sqlNull')
        continue
      const type = checkConstraintTypeForExpr(catalog, arm.scope, arm.result, seen)
      if (!type) return null
      types.push(type)
    }
    if (types.length === 0) return null
    if (types.every((type) => type.kind === 'literalUnion')) {
      return { kind: 'literalUnion', labels: [...new Set(types.flatMap((type) => type.labels))] }
    }
    return types.reduce((left, right) => combineCheckConstraintTypes('union', left, right))
  }
  if (expr.tag === 'NullIfExpr') {
    return checkConstraintTypeForExpr(catalog, scope, targetExprFromAggregateArg(expr.args?.[0]), seen)
  }
  if (expr.tag === 'OpExpr') {
    const shape = jsonOperatorShapeForExpr(catalog, scope, expr, seen)
    if (shape?.kind === 'stringLiteral') return { kind: 'literalUnion', labels: [shape.value] }
    if (shape?.kind === 'scalar' && shape.checkConstraintType) return shape.checkConstraintType
    return null
  }
  if (expr.tag !== 'Var') return null
  let type = checkConstraintTypeForVar(catalog, scope, expr, seen)
  const location = varLocation(scope, expr)
  for (const labels of location ? literalVarFacts(scope.predicateFacts.get(location.query), location.key) : []) {
    type =
      type?.kind === 'literalUnion'
        ? { kind: 'literalUnion', labels: type.labels.filter((label) => labels.includes(label)) }
        : type
          ? combineCheckConstraintTypes('intersection', type, { kind: 'literalUnion', labels })
          : { kind: 'literalUnion', labels }
  }
  if (location && type?.kind === 'literalUnion') {
    const excluded = excludedVarFacts(scope.predicateFacts.get(location.query), location.key)
    type = { kind: 'literalUnion', labels: type.labels.filter((label) => !excluded.includes(label)) }
  }
  return type
}

function checkConstraintTypeForVar(
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
  const bounds = inferRowBounds(catalog, subqueryScope)
  if (bounds.max === 0) {
    return { evidence: 'scalar_sublink_empty_query', kind: 'nullable' }
  }
  if (bounds.min > 0 || output.kind === 'nullable') {
    return output
  }
  return { kind: 'unknown', reason: 'scalar_sublink_row_presence_unresolved' }
}

function auditedBuiltinNullability(
  catalog: CatalogFacts,
  scope: QueryScope,
  expr: PgAnalyzerExpr,
  seen: readonly VarLocation[]
): TypedSqlPostgresIrResultNullability | null {
  if (expr.nonNullInputProducesNonNull !== true || expr.isStrict !== true || expr.returnsSet !== false) {
    return null
  }
  const args = expr.args?.map(targetExprFromAggregateArg)
  if (!args || args.length === 0 || args.some((argument) => !argument)) {
    return { kind: 'unknown', reason: 'audited_builtin_arguments_unavailable' }
  }
  return unionResultNullabilities(
    args.map((argument) => expressionNullability(catalog, scope, argument, seen)),
    'audited_builtin_non_null_inputs'
  )
}

function aggregateNullability(
  catalog: CatalogFacts,
  scope: QueryScope,
  expr: PgAnalyzerExpr,
  seen: readonly VarLocation[]
): TypedSqlPostgresIrResultNullability {
  if (isBuiltinPgProcNamed(catalog, expr.aggfnoid, 'count')) {
    return { basis: 'count_aggregate', kind: 'nonNull' }
  }
  const unknown = { kind: 'unknown', reason: `aggregate:${expr.aggname ?? expr.aggfnoid ?? 'unknown'}` } as const
  if (expr.agglevelsup !== 0) {
    return unknown
  }
  const ordinaryGroup = (scope.query.groupClauseCount ?? 0) > 0 && scope.query.groupingSetsCount === 0
  const inputPresent =
    (aggregateFilterIsUnrestricted(expr) && (ordinaryGroup || aggregateSourceIsNonempty(catalog, scope))) ||
    havingProvesAggregateInput(scope, expr, false)
  if (aggregateIncludesNullInputs(catalog, expr.aggfnoid)) {
    return inputPresent
      ? { basis: ordinaryGroup ? 'nonempty_group_aggregate' : 'nonempty_input_aggregate', kind: 'nonNull' }
      : unknown
  }
  if (!aggregateReturnsNonNullForNonNullInput(catalog, expr.aggfnoid)) {
    return unknown
  }
  const argument = aggregateInputArguments(expr)[0]
  return (inputPresent &&
    argument &&
    expressionNullability(catalog, scopeWithQual(aggregateInputScope(scope), expr.aggfilter), argument, seen).kind ===
      'nonNull') ||
    havingProvesAggregateInput(scope, expr, true)
    ? {
        basis: ordinaryGroup ? 'nonempty_group_non_null_argument' : 'nonempty_non_null_aggregate_input',
        kind: 'nonNull',
      }
    : unknown
}

function aggregateInputArguments(expr: PgAnalyzerExpr): readonly PgAnalyzerExpr[] {
  return (expr.args ?? []).flatMap((argument) => {
    if (!('tag' in argument) && argument.resjunk === true) return []
    const value = targetExprFromAggregateArg(argument)
    return value ? [value] : []
  })
}

function aggregateIncludesNullInputs(catalog: CatalogFacts, oid: number | undefined): boolean {
  return ['array_agg', 'json_agg', 'jsonb_agg'].some((name) => isBuiltinPgProcNamed(catalog, oid, name))
}

function aggregateReturnsNonNullForNonNullInput(catalog: CatalogFacts, oid: number | undefined): boolean {
  return [
    'min',
    'max',
    'sum',
    'avg',
    'bool_and',
    'bool_or',
    'every',
    'string_agg',
    'bit_and',
    'bit_or',
    'bit_xor',
  ].some((name) => isBuiltinPgProcNamed(catalog, oid, name))
}

function aggregateFilterIsUnrestricted(expr: PgAnalyzerExpr): boolean {
  const filter = unwrapValuePreservingExpr(expr.aggfilter)
  return expr.aggfilter === null || (filter?.tag === 'Const' && filter.constBoolean === true)
}

function aggregateSourceIsNonempty(catalog: CatalogFacts, scope: QueryScope): boolean {
  const { query } = scope
  const where = unwrapValuePreservingExpr(query.whereQual)
  if (query.whereQual && !(where?.tag === 'Const' && where.constBoolean === true)) return false
  const from = query.fromTree
  if (from?.tag !== 'FromExpr' || from.truncated === true) return false
  if (from.fromlist?.length === 0) return true
  const node = from.fromlist?.length === 1 ? from.fromlist[0] : undefined
  if (node?.tag !== 'RangeTblRef' || node.truncated === true) return false
  const source = query.rtable?.[(node.rtindex ?? 0) - 1]
  if (source?.kind === 'VALUES') return (source.valuesLists?.length ?? 0) > 0
  const rowSource = rowBoundSource(scope, source)
  return rowSource !== null && inferRowBounds(catalog, rowSource.scope, [query]).min > 0
}

function havingProvesAggregateInput(
  scope: QueryScope,
  aggregate: PgAnalyzerExpr,
  requireNonNullValue: boolean
): boolean {
  const value = aggregateInputArguments(aggregate)[0]
  const valueKey = value ? predicateExpressionKey(scope, value) : null
  const filterKey = aggregate.aggfilter === null ? 'no_filter' : predicateExpressionKey(scope, aggregate.aggfilter)
  if (!filterKey || (requireNonNullValue && !valueKey)) return false
  const prove = (qual: PgAnalyzerExpr | null | undefined, positive = true): boolean => {
    if (!qual || qual.truncated === true) return false
    if (qual.tag === 'BoolExpr') {
      const children = exprChildren(qual)
      if (qual.boolOp === 'NOT') return children.length === 1 && prove(children[0], !positive)
      if (qual.boolOp !== 'AND' && qual.boolOp !== 'OR') return false
      if (children.length === 0) return false
      const oneSuffices = (qual.boolOp === 'AND') === positive
      return oneSuffices
        ? children.some((child) => prove(child, positive))
        : children.every((child) => prove(child, positive))
    }
    if (positive && qual.tag === 'BooleanTest' && qual.boolTestType === 'IS_TRUE') return prove(qual.arg)
    if (qual.tag !== 'OpExpr' || qual.args?.length !== 2) return false
    const proc = qual.opfuncid ? scope.catalog.procs.get(qual.opfuncid) : undefined
    const comparison = proc?.is_builtin
      ? /^int(?:8|82|28|84|48)(eq|ne|gt|ge|lt|le)$/u.exec(proc.proname)?.[1]
      : undefined
    if (!comparison) return false
    const left = unwrapValuePreservingExpr(targetExprFromAggregateArg(qual.args[0]))
    const right = unwrapValuePreservingExpr(targetExprFromAggregateArg(qual.args[1]))
    const count = left?.tag === 'Aggref' ? left : right?.tag === 'Aggref' ? right : undefined
    const constant = count === left ? right : left
    if (!count || count.agglevelsup !== 0 || !isBuiltinPgProcNamed(scope.catalog, count.aggfnoid, 'count')) return false
    const threshold = constNonNegativeSafeInteger(scope.catalog, constant)
    if (threshold === null) return false
    const reversed: Readonly<Record<string, string>> = { eq: 'eq', ne: 'ne', gt: 'lt', ge: 'le', lt: 'gt', le: 'ge' }
    const negated: Readonly<Record<string, string>> = { eq: 'ne', ne: 'eq', gt: 'le', ge: 'lt', lt: 'ge', le: 'gt' }
    let operation = count === left ? comparison : reversed[comparison]
    if (!positive && operation) operation = negated[operation]
    const requiresPositiveCount =
      operation === 'gt' ||
      ((operation === 'ge' || operation === 'eq') && threshold >= 1) ||
      (operation === 'ne' && threshold === 0)
    if (!requiresPositiveCount) return false
    const countFilterKey = count.aggfilter === null ? 'no_filter' : predicateExpressionKey(scope, count.aggfilter)
    if (countFilterKey !== filterKey) return false
    if (!requireNonNullValue) return true
    const countedValue = aggregateInputArguments(count)[0]
    return countedValue !== undefined && predicateExpressionKey(scope, countedValue) === valueKey
  }
  return prove(scope.query.havingQual)
}

function windowFunctionNullability(
  catalog: CatalogFacts,
  scope: QueryScope,
  expr: PgAnalyzerExpr,
  seen: readonly VarLocation[]
): TypedSqlPostgresIrResultNullability {
  const unknown = { kind: 'unknown', reason: `window_function:${expr.winname ?? expr.winfnoid ?? 'unknown'}` } as const
  if (expr.winagg === true && isBuiltinPgProcNamed(catalog, expr.winfnoid, 'count')) {
    return { basis: 'count_window_aggregate', kind: 'nonNull' }
  }
  const args = expr.args?.map(targetExprFromAggregateArg)
  const first = args?.[0]
  const firstNullability = first ? expressionNullability(catalog, scope, first, seen) : undefined
  // CASE facts describe only the current output row. Values fetched from a
  // different row may use only the query's WHERE/HAVING and correlated facts.
  const otherRowNullability = () =>
    first ? expressionNullability(catalog, queryScope(scope.query, scope.parent, catalog), first, seen) : undefined
  if (expr.winagg === false) {
    if (
      ['row_number', 'rank', 'dense_rank', 'percent_rank', 'cume_dist'].some((name) =>
        isBuiltinPgProcNamed(catalog, expr.winfnoid, name)
      )
    ) {
      return { basis: 'ranking_window_function', kind: 'nonNull' }
    }
    if (['lag', 'lead'].some((name) => isBuiltinPgProcNamed(catalog, expr.winfnoid, name))) {
      const offset = args?.[1]
      if (offset && scopeProvesNull(scope, offset)) return { evidence: 'null_window_offset', kind: 'nullable' }
      if (offset && constNonNegativeSafeInteger(catalog, offset) === 0 && firstNullability) return firstNullability
      if (
        args?.length === 3 &&
        otherRowNullability()?.kind === 'nonNull' &&
        expressionNullability(catalog, scope, offset, seen).kind === 'nonNull' &&
        expressionNullability(catalog, scope, args[2], seen).kind === 'nonNull'
      ) {
        return { basis: 'window_non_null_value_and_default', kind: 'nonNull' }
      }
      return unknown
    }
    if (isBuiltinPgProcNamed(catalog, expr.winfnoid, 'ntile') && firstNullability?.kind === 'nonNull') {
      return { basis: 'window_non_null_bucket_count', kind: 'nonNull' }
    }
    if (
      expr.windowFrameIncludesCurrentRow === true &&
      otherRowNullability()?.kind === 'nonNull' &&
      (['first_value', 'last_value'].some((name) => isBuiltinPgProcNamed(catalog, expr.winfnoid, name)) ||
        (isBuiltinPgProcNamed(catalog, expr.winfnoid, 'nth_value') &&
          constNonNegativeSafeInteger(catalog, args?.[1]) === 1))
    )
      return { basis: 'nonempty_window_frame_value', kind: 'nonNull' }
  }
  if (expr.winagg === true && expr.windowFrameIncludesCurrentRow === true && aggregateFilterIsUnrestricted(expr)) {
    if (
      aggregateIncludesNullInputs(catalog, expr.winfnoid) ||
      (aggregateReturnsNonNullForNonNullInput(catalog, expr.winfnoid) && firstNullability?.kind === 'nonNull')
    ) {
      return { basis: 'nonempty_window_frame_aggregate', kind: 'nonNull' }
    }
  }
  return unknown
}

function nullIfArgumentsAreUnequal(
  catalog: CatalogFacts,
  scope: QueryScope,
  expr: PgAnalyzerExpr,
  seen: readonly VarLocation[]
): boolean {
  const left = targetExprFromAggregateArg(expr.args?.[0])
  const right = targetExprFromAggregateArg(expr.args?.[1])
  if (!left || !right) return false
  if (scopeProvesNull(scope, right)) return true
  if (expr.textEqualityIsExact === true) {
    const leftType = checkConstraintTypeForExpr(catalog, scope, left, seen)
    const rightType = checkConstraintTypeForExpr(catalog, scope, right, seen)
    return (
      leftType?.kind === 'literalUnion' &&
      rightType?.kind === 'literalUnion' &&
      leftType.labels.every((label) => !rightType.labels.includes(label))
    )
  }
  const proc = expr.opfuncid ? catalog.procs.get(expr.opfuncid) : undefined
  if (proc?.is_builtin !== true || !/^int(?:2|4|8|24|42|28|82|48|84)eq$/u.test(proc.proname)) return false
  return (
    left.tag === 'Const' &&
    right.tag === 'Const' &&
    left.constInteger !== undefined &&
    right.constInteger !== undefined &&
    /^-?\d+$/u.test(left.constInteger) &&
    /^-?\d+$/u.test(right.constInteger) &&
    BigInt(left.constInteger) !== BigInt(right.constInteger)
  )
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
    const ownerScope = queryScopeAtLevel(scope, expr.varlevelsup ?? 0)
    if (!ownerScope) {
      throw new Error(
        `internal analyzer envelope inconsistency: Var level ${expr.varlevelsup ?? 0} has no owning query scope`
      )
    }
    const rowImage = returningRowImage(ownerScope, expr)
    if (rowImage === 'unavailable' || rowImage === 'possiblyUnavailable' || rowImage === 'unknown') {
      return {
        evidence:
          rowImage === 'unavailable'
            ? `returning_${expr.varreturningtype?.toLowerCase() ?? 'unknown'}_row_unavailable`
            : 'returning_row_availability_unresolved',
        kind: 'nullable',
      }
    }
    if (scopeProvesNull(scope, expr)) {
      return { evidence: 'predicate_is_null', kind: 'nullable' }
    }
    if (
      ownerScope.evaluationPhase === 'result' &&
      (ownerScope.query.groupingSetsCount ?? 0) > 0 &&
      !scopeProvesNonNull(scope, expr)
    ) {
      return { evidence: 'grouping_set_column_can_be_absent', kind: 'nullable' }
    }
    if (expr.varattno === 0) {
      if (scopeProvesNonNull(scope, expr)) {
        return { basis: 'where_is_not_null', kind: 'nonNull' }
      }
      return (expr.varnullingrels?.length ?? 0) > 0 && !scopeProvesRowPresent(scope, expr)
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
      relationNullability =
        baseColumn.attnotnull || baseColumn.check_rejects_null
          ? {
              basis: `${baseColumn.attnotnull ? 'not_null_column' : 'check_rejects_null_column'}:${baseColumn.relname}.${baseColumn.attname}`,
              kind: 'nonNull',
            }
          : { evidence: `nullable_column:${baseColumn.relname}.${baseColumn.attname}`, kind: 'nullable' }
    }
    if (scopeProvesNonNull(scope, expr)) {
      return { basis: 'where_is_not_null', kind: 'nonNull' }
    }
    if ((expr.varnullingrels ?? []).length > 0 && !scopeProvesRowPresent(scope, expr)) {
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
  if (scopeProvesExpressionNonNull(scope, expr)) {
    return {
      basis:
        expr.tag === 'FuncExpr' && expr.args?.length === 1
          ? 'where_function_is_not_null'
          : 'predicate_non_null_expression',
      kind: 'nonNull',
    }
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
    return aggregateNullability(catalog, scope, expr, seen)
  }
  if (expr.tag === 'WindowFunc') {
    return windowFunctionNullability(catalog, scope, expr, seen)
  }
  if (expr.tag === 'DistinctExpr') {
    return expr.returnsSet === false &&
      (expr.nonNullInputProducesNonNull === true ||
        expr.args?.some((argument) => {
          const value = targetExprFromAggregateArg(argument)
          return value !== null && value !== undefined && scopeProvesNull(scope, value)
        }))
      ? { basis: 'audited_distinctness', kind: 'nonNull' }
      : { kind: 'unknown', reason: 'distinctness_equality_can_return_null' }
  }
  if (expr.tag === 'NullIfExpr') {
    const first = targetExprFromAggregateArg(expr.args?.[0])
    if (first && nullIfArgumentsAreUnequal(catalog, scope, expr, seen)) {
      return expressionNullability(catalog, scope, first, seen)
    }
    return { evidence: 'nullif_equal_arguments', kind: 'nullable' }
  }
  if (expr.tag === 'SQLValueFunction') {
    return [
      'CURRENT_DATE',
      'CURRENT_TIME',
      'CURRENT_TIMESTAMP',
      'LOCALTIME',
      'LOCALTIMESTAMP',
      'CURRENT_ROLE',
      'CURRENT_USER',
      'USER',
      'SESSION_USER',
      'CURRENT_CATALOG',
    ].includes(expr.sqlValueFunction ?? '')
      ? { basis: 'non_null_sql_value_function', kind: 'nonNull' }
      : { kind: 'unknown', reason: `sql_value_function:${expr.sqlValueFunction ?? 'unknown'}` }
  }
  if (expr.tag === 'CoalesceExpr' || expr.tag === 'MinMaxExpr') {
    const basis = expr.tag === 'CoalesceExpr' ? 'coalesce' : 'minmax'
    const children = exprChildren(expr).map((child) => expressionNullability(catalog, scope, child, seen))
    if (children.some((child) => child.kind === 'nonNull')) {
      return { basis: `${basis}_non_null_arm`, kind: 'nonNull' }
    }
    if (children.length > 0 && children.every((child) => child.kind === 'nullable')) {
      return { evidence: `${basis}_all_arms_nullable`, kind: 'nullable' }
    }
    return { kind: 'unknown', reason: `${basis}_without_non_null_proof` }
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
    if (!predicateTruthValues(scope, expr).includes(null)) return { basis: 'boolean_truth_table', kind: 'nonNull' }
    return unionResultNullabilities(
      exprChildren(expr).map((child) => expressionNullability(catalog, scope, child, seen)),
      `boolean_${(expr.boolOp ?? 'unknown').toLowerCase()}`
    )
  }
  if (expr.tag === 'ArrayExpr') {
    return { basis: 'array_constructor', kind: 'nonNull' }
  }
  if (expr.tag === 'OpExpr') {
    const jsonShape = jsonOperatorShapeForExpr(catalog, scope, expr, seen)
    if (jsonShape) {
      return jsonShape.nullability
    }
    const audited = auditedBuiltinNullability(catalog, scope, expr, seen)
    if (audited) {
      return audited
    }
  }
  if (expr.tag === 'FuncExpr') {
    if (expr.alwaysNonNull === true && expr.returnsSet === false && expr.args?.length === 0) {
      return { basis: 'audited_zero_argument_function', kind: 'nonNull' }
    }
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
    const audited = auditedBuiltinNullability(catalog, scope, expr, seen)
    if (audited) {
      return audited
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
  if ((unwrapped.varnullingrels?.length ?? 0) > 0 && !scopeProvesRowPresent(scope, unwrapped)) {
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
  if (constantExpr?.tag === 'Const' && constantExpr.constIsNull === true) {
    return jsonSqlNullShape('sql_null_constant', typeFact)
  }
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

function jsonNestedShapeForExpr(
  catalog: CatalogFacts,
  scope: QueryScope,
  expr: PgAnalyzerExpr,
  seen: readonly VarLocation[]
): TypedSqlPostgresIrJsonShape {
  return jsonNestedShape(jsonShapeForExpr(catalog, scope, expr, seen))
}

function jsonNestedShape(shape: TypedSqlPostgresIrJsonShape): TypedSqlPostgresIrJsonShape {
  return shape.kind === 'sqlNull'
    ? {
        kind: 'null',
        ...(shape.sqlType ? { sqlType: shape.sqlType } : {}),
        nullability: { basis: 'embedded_sql_null', kind: 'nonNull' },
      }
    : shape
}

function jsonShapeAlternatives(shape: TypedSqlPostgresIrJsonShape): readonly TypedSqlPostgresIrJsonShape[] {
  return shape.kind === 'union' ? shape.alternatives.flatMap(jsonShapeAlternatives) : [shape]
}

function hasCustomJsonCast(type: PostgresTypeFact): boolean {
  return type.pgCastsToJson === true || (type.pgBaseType !== undefined && hasCustomJsonCast(type.pgBaseType))
}

function jsonSqlNullShape(evidence: string, sqlType?: PostgresTypeFact): TypedSqlPostgresIrJsonShape {
  return { kind: 'sqlNull', ...(sqlType ? { sqlType } : {}), nullability: { evidence, kind: 'nullable' } }
}

function jsonLiteralShape(expr: PgAnalyzerExpr): TypedSqlPostgresIrJsonShape | null {
  if (
    expr.tag !== 'Const' ||
    expr.constIsNull === true ||
    typeof expr.constJson !== 'string' ||
    expr.constJson.length > 262144
  ) {
    return null
  }
  const nullability = { basis: 'json_literal', kind: 'nonNull' } as const
  let nodes = 0
  const visit = (value: unknown, depth: number): TypedSqlPostgresIrJsonShape => {
    if (++nodes > 4096 || depth > 64) throw new Error('JSON literal shape limit')
    if (value === null) return { kind: 'null', nullability }
    // Keep the public, JSON-serializable IR free of Infinity/-Infinity: JSON
    // serialization would silently turn those values into null.
    if (typeof value === 'number' && !Number.isFinite(value)) return { kind: 'opaque', nullability }
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return { kind: 'jsonScalar', nullability, value }
    }
    if (Array.isArray(value)) {
      const elements = value.map((element: unknown) => visit(element, depth + 1))
      return {
        element: joinJsonShapes(elements, { kind: 'opaque', nullability }),
        elements,
        kind: 'array',
        nullability,
      }
    }
    return {
      fields: Object.entries(value as Record<string, unknown>).map(([name, field]) => ({
        name,
        shape: visit(field, depth + 1),
      })),
      kind: 'object',
      nullability,
    }
  }
  try {
    return visit(JSON.parse(expr.constJson) as unknown, 0)
  } catch {
    return null
  }
}

/** Nested SQL NULLs become JSON null values when a constructor embeds them. */
function jsonEmbeddedValueShape(shape: TypedSqlPostgresIrJsonShape): TypedSqlPostgresIrJsonShape {
  const nullability = { basis: 'embedded_json_value', kind: 'nonNull' } as const
  if (shape.kind === 'sqlNull') return { kind: 'null', nullability }
  const value = jsonShapeWithNullability(shape, nullability)
  return shape.nullability.kind === 'nonNull' ? value : joinJsonShapes([value, { kind: 'null', nullability }], value)
}

function constantJsonIndex(expr: PgAnalyzerExpr): number | null {
  const constant = unwrapValuePreservingExpr(expr)
  if (constant?.tag !== 'Const' || constant.constIsNull === true || constant.constInteger === undefined) return null
  const value = Number(constant.constInteger)
  return Number.isSafeInteger(value) ? value : null
}

function constantJsonPath(expr: PgAnalyzerExpr): readonly string[] | null {
  const value = unwrapValuePreservingExpr(expr)
  if (value?.tag === 'Const' && value.constIsNull !== true && value.constTextArray) {
    return value.constTextArray.every((element): element is string => element !== null) ? value.constTextArray : null
  }
  if (value?.tag !== 'ArrayExpr' || value.multidims === true || !value.elements) return null
  const elements = value.elements.map(constStringValue)
  return elements.every((element): element is string => element !== null) ? elements : null
}

function projectJsonShape(
  shape: TypedSqlPostgresIrJsonShape,
  key: number | string,
  path: boolean,
  scalarArrayIndex = false
): TypedSqlPostgresIrJsonShape | null {
  const projected: TypedSqlPostgresIrJsonShape[] = []
  for (const alternative of jsonShapeAlternatives(shape)) {
    if (
      alternative.kind === 'opaque' ||
      (alternative.kind === 'scalar' && postgresJsonValueMayBeStructured(alternative))
    )
      return null
    let field: TypedSqlPostgresIrJsonShape | undefined
    if (alternative.kind === 'object' && typeof key === 'string') {
      field = alternative.fields.find((candidate) => candidate.name === key)?.shape
    } else if (alternative.kind === 'array' && (typeof key === 'number' || path)) {
      if (!alternative.elements) return null
      // PostgreSQL's strtoint accepts leading ASCII whitespace and a sign,
      // but requires the final parsed character to end the path component.
      const index = typeof key === 'number' ? key : /^[ \t\n\r\f\v]*[+-]?\d+$/u.test(key) ? Number(key) : NaN
      if (Number.isSafeInteger(index)) {
        field = alternative.elements[index < 0 ? alternative.elements.length + index : index]
      }
    } else if (
      scalarArrayIndex &&
      (key === 0 || key === -1) &&
      (alternative.kind === 'null' ||
        alternative.kind === 'jsonScalar' ||
        alternative.kind === 'scalar' ||
        alternative.kind === 'stringLiteral')
    ) {
      // jsonb stores a scalar in a singleton array; its integer -> overload
      // exposes that element. Text JSON and #> do not share this behavior.
      field = jsonShapeWithNullability(alternative, { basis: 'jsonb_scalar_array_element', kind: 'nonNull' })
    }
    projected.push(field ? jsonEmbeddedValueShape(field) : jsonSqlNullShape('missing_json_path'))
  }
  const result = joinJsonShapes(projected, jsonSqlNullShape('missing_json_path'))
  return jsonShapeWithNullability(
    result,
    unionResultNullabilities([shape.nullability, result.nullability], 'json_projection')
  )
}

function jsonShapeAsText(catalog: CatalogFacts, shape: TypedSqlPostgresIrJsonShape): TypedSqlPostgresIrJsonShape {
  const textType = typeFactForOid(catalog, 25, 'text')
  const alternatives = jsonShapeAlternatives(shape).map((field): TypedSqlPostgresIrJsonShape => {
    const nullability = { basis: 'json_text_value', kind: 'nonNull' } as const
    if (field.kind === 'null' || field.kind === 'sqlNull') return jsonSqlNullShape('json_null_text_projection')
    if (field.kind === 'stringLiteral' || (field.kind === 'jsonScalar' && typeof field.value === 'string')) {
      return { ...textType, kind: 'stringLiteral', nullability, value: field.value as string }
    }
    return {
      ...textType,
      kind: 'scalar',
      nullability:
        field.kind === 'opaque' || (field.kind === 'scalar' && postgresJsonValueMayBeStructured(field))
          ? { evidence: 'opaque_json_can_be_json_null', kind: 'nullable' }
          : nullability,
      ...(field.kind === 'scalar' && field.checkConstraintType && postgresJsonSupportsTextualLiteralRefinement(field)
        ? { checkConstraintType: field.checkConstraintType }
        : {}),
    }
  })
  const result = joinJsonShapes(alternatives, jsonSqlNullShape('json_null_text_projection'))
  return jsonShapeWithNullability(
    result,
    unionResultNullabilities([shape.nullability, result.nullability], 'json_text_projection')
  )
}

function jsonOperatorShapeForExpr(
  catalog: CatalogFacts,
  scope: QueryScope,
  expr: PgAnalyzerExpr,
  seen: readonly VarLocation[] = []
): TypedSqlPostgresIrJsonShape | null {
  if (expr.tag !== 'OpExpr' || expr.args?.length !== 2) return null
  const left = targetExprFromAggregateArg(expr.args[0])
  const right = targetExprFromAggregateArg(expr.args[1])
  if (!left || !right) return null
  const builtin = (...names: readonly string[]) =>
    names.some((name) => isBuiltinPgProcNamed(catalog, expr.opfuncid, name))
  const objectProjection = builtin(
    'json_object_field',
    'jsonb_object_field',
    'json_object_field_text',
    'jsonb_object_field_text'
  )
  const arrayProjection = builtin(
    'json_array_element',
    'jsonb_array_element',
    'json_array_element_text',
    'jsonb_array_element_text'
  )
  const pathProjection = builtin(
    'json_extract_path',
    'jsonb_extract_path',
    'json_extract_path_text',
    'jsonb_extract_path_text'
  )
  const projectsText = builtin(
    'json_object_field_text',
    'jsonb_object_field_text',
    'json_array_element_text',
    'jsonb_array_element_text',
    'json_extract_path_text',
    'jsonb_extract_path_text'
  )
  const concatenatesObjects = builtin('jsonb_concat')
  const deletes = builtin('jsonb_delete')
  if (!objectProjection && !arrayProjection && !pathProjection && !concatenatesObjects && !deletes) return null

  const leftShape = jsonShapeForExpr(catalog, scope, left, seen)
  const rightConstant = unwrapValuePreservingExpr(right)
  if (leftShape.kind === 'sqlNull' || (rightConstant?.tag === 'Const' && rightConstant.constIsNull === true)) {
    return jsonSqlNullShape('strict_json_operator_null_input')
  }
  if (objectProjection || arrayProjection || pathProjection) {
    if (
      pathProjection &&
      (rightConstant?.constTextArray?.includes(null) ||
        (rightConstant?.tag === 'ArrayExpr' &&
          rightConstant.elements?.some((element) => {
            const constant = unwrapValuePreservingExpr(element)
            return constant?.tag === 'Const' && constant.constIsNull === true
          })))
    )
      return jsonSqlNullShape('null_json_path_component')
    const key = objectProjection ? constStringValue(right) : arrayProjection ? constantJsonIndex(right) : null
    const path = pathProjection ? constantJsonPath(right) : key === null ? null : [key]
    if (!path) return null
    let result: TypedSqlPostgresIrJsonShape = leftShape
    for (const component of path) {
      const projected = projectJsonShape(
        result,
        component,
        pathProjection,
        builtin('jsonb_array_element', 'jsonb_array_element_text')
      )
      if (!projected) return null
      result = projected
    }
    return projectsText ? jsonShapeAsText(catalog, result) : result
  }

  const leftAlternatives = jsonShapeAlternatives(leftShape)
  if (deletes) {
    const key = constStringValue(right)
    const keys = key === null ? constantJsonPath(right) : [key]
    const index = constantJsonIndex(right)
    if (!keys && index === null) return null
    const results: TypedSqlPostgresIrJsonShape[] = []
    for (const alternative of leftAlternatives) {
      if (alternative.kind === 'object' && keys) {
        results.push({ ...alternative, fields: alternative.fields.filter((field) => !keys.includes(field.name)) })
      } else if (alternative.kind === 'array' && alternative.elements && index !== null) {
        const position = index < 0 ? alternative.elements.length + index : index
        const elements = alternative.elements.filter((_, elementIndex) => elementIndex !== position)
        results.push({ ...alternative, element: joinJsonShapes(elements, alternative.element), elements })
      } else return null
    }
    return jsonShapeWithNullability(joinJsonShapes(results, leftShape), leftShape.nullability)
  }

  const rightShape = jsonShapeForExpr(catalog, scope, right, seen)
  const rightAlternatives = jsonShapeAlternatives(rightShape)
  if (rightShape.kind === 'sqlNull') return jsonSqlNullShape('strict_json_concat_null_input')
  if (
    !leftAlternatives.every((alternative) => alternative.kind === 'object') ||
    !rightAlternatives.every((alternative) => alternative.kind === 'object') ||
    leftAlternatives.length * rightAlternatives.length > 64
  )
    return null
  const combinations = leftAlternatives.flatMap((leftAlternative) =>
    rightAlternatives.flatMap((rightAlternative): TypedSqlPostgresIrJsonShape[] => {
      if (leftAlternative.kind !== 'object' || rightAlternative.kind !== 'object') return []
      const fields = new Map(leftAlternative.fields.map((field) => [field.name, field]))
      for (const field of rightAlternative.fields) fields.set(field.name, field)
      return [
        { fields: [...fields.values()], kind: 'object', nullability: { basis: 'json_object_concat', kind: 'nonNull' } },
      ]
    })
  )
  return jsonShapeWithNullability(
    joinJsonShapes(combinations, leftShape),
    unionResultNullabilities([leftShape.nullability, rightShape.nullability], 'json_object_concat')
  )
}

function baseRelationWholeRowJsonShape(
  catalog: CatalogFacts,
  scope: QueryScope,
  expr: PgAnalyzerExpr,
  seen: readonly VarLocation[]
): TypedSqlPostgresIrJsonShape | null {
  const owner = queryScopeAtLevel(scope, expr.varlevelsup ?? 0)
  const rte = owner?.query.rtable?.[(expr.varno as number) - 1]
  const type = typeFactForOid(catalog, expr.typeOid, expr.typeName)
  if (rte?.kind !== 'RELATION' || !rte.relid || type.pgCastsToJson === true) {
    return null
  }
  const fields = [...catalog.columns.values()]
    .filter((column) => column.relid === rte.relid)
    .toSorted((left, right) => left.attnum - right.attnum)
    .map(
      (column): TypedSqlPostgresIrJsonField => ({
        name: column.attname,
        shape: jsonNestedShapeForExpr(
          catalog,
          scope,
          {
            ...expr,
            attname: column.attname,
            typeName: catalog.types.get(column.atttypid)?.pgType,
            typeOid: column.atttypid,
            varattno: column.attnum,
            // If an outer join supplies no row, the entire JSON result is SQL
            // NULL. Fields of a present row retain their underlying constraints.
            varnullingrels: [],
          },
          seen
        ),
      })
    )
  return { fields, kind: 'object', nullability: expressionNullability(catalog, scope, expr, seen) }
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
    jsonNestedShapeForExpr(catalog, scope, argument, seen)
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
  if (hasCustomJsonCast(typeFactForOid(catalog, expr?.typeOid, expr?.typeName))) {
    return null
  }
  if (unwrapped.tag === 'Const' && unwrapped.constIsNull === true)
    return jsonSqlNullShape('sql_null_constant', typeFactForOid(catalog, unwrapped.typeOid, unwrapped.typeName))

  const literal = jsonLiteralShape(unwrapped)
  if (literal) return literal

  if (unwrapped.tag === 'CaseExpr') {
    const arms = caseArms(scope, unwrapped)
    return joinJsonShapes(
      arms.map((arm) => jsonShapeForCaseArm(catalog, arm, seen)),
      jsonLeafShapeForExpr(catalog, scope, unwrapped, seen)
    )
  }

  if (unwrapped.tag === 'CoalesceExpr') {
    const children: PgAnalyzerExpr[] = []
    for (const child of exprChildren(unwrapped)) {
      const constant = unwrapValuePreservingExpr(child)
      if (constant?.tag === 'Const' && constant.constIsNull === true) {
        continue
      }
      if (jsonShapeForExpr(catalog, scope, child, seen).kind === 'sqlNull') continue
      children.push(child)
      if (expressionNullability(catalog, scope, child, seen).kind === 'nonNull') {
        break
      }
    }
    const first = children[0]
    const firstShape = first ? jsonShapeForExpr(catalog, scope, first, seen) : null
    const nullability = expressionNullability(catalog, scope, unwrapped, seen)

    if (
      firstShape?.kind === 'array' &&
      !firstShape.elements &&
      children.length > 1 &&
      children.slice(1).every(isEmptyJsonArrayConst)
    ) {
      return jsonShapeWithNullability(firstShape, nullability)
    }

    return jsonShapeWithNullability(
      joinJsonShapes(
        children.map((child) => jsonShapeForExpr(catalog, scope, child, seen)),
        { kind: 'opaque', nullability }
      ),
      nullability
    )
  }

  if (unwrapped.tag === 'OpExpr') {
    const shape = jsonOperatorShapeForExpr(catalog, scope, unwrapped, seen)
    if (shape) {
      return shape
    }
  }

  if (unwrapped.tag === 'ArrayExpr' && unwrapped.elements) {
    const elements = unwrapped.elements.map((element) => jsonNestedShapeForExpr(catalog, scope, element, seen))
    return {
      element: joinJsonShapes(elements, {
        kind: 'opaque',
        nullability: { basis: 'empty_array_element', kind: 'nonNull' },
      }),
      elements,
      kind: 'array',
      nullability: { basis: 'array_constructor', kind: 'nonNull' },
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
          element: jsonNestedShape(inferQueryOutputJsonShape(catalog, subqueryScope, 0, seen)),
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
    const shape = value ? jsonShapeForExpr(catalog, scope, value, seen) : null
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
        shape: jsonNestedShapeForExpr(catalog, scope, value, seen),
      })
    }

    return {
      fields: [...fields.values()],
      kind: 'object',
      nullability: expressionNullability(catalog, scope, unwrapped, seen),
    }
  }

  if (jsonBuildKind === 'array') {
    const decoded = staticVariadicFunctionArguments(unwrapped)
    return {
      element: jsonBuildArrayElementShape(catalog, scope, unwrapped, seen),
      ...(decoded.kind === 'known'
        ? { elements: decoded.arguments.map((argument) => jsonNestedShapeForExpr(catalog, scope, argument, seen)) }
        : {}),
      kind: 'array',
      nullability: expressionNullability(catalog, scope, unwrapped, seen),
    }
  }

  if (
    unwrapped.tag === 'Aggref' &&
    (isBuiltinPgProcNamed(catalog, unwrapped.aggfnoid, 'jsonb_agg') ||
      isBuiltinPgProcNamed(catalog, unwrapped.aggfnoid, 'json_agg') ||
      isBuiltinPgProcNamed(catalog, unwrapped.aggfnoid, 'jsonb_agg_strict') ||
      isBuiltinPgProcNamed(catalog, unwrapped.aggfnoid, 'json_agg_strict'))
  ) {
    const valueExpr = targetExprFromAggregateArg(unwrapped.args?.[0])
    if (!valueExpr) {
      return null
    }

    const argumentScope = scopeWithQual(aggregateInputScope(scope), unwrapped.aggfilter)
    const element = jsonNestedShapeForExpr(catalog, argumentScope, valueExpr, seen)
    const skipsNulls =
      isBuiltinPgProcNamed(catalog, unwrapped.aggfnoid, 'jsonb_agg_strict') ||
      isBuiltinPgProcNamed(catalog, unwrapped.aggfnoid, 'json_agg_strict')
    return {
      element: skipsNulls
        ? jsonShapeWithNullability(element, { basis: 'strict_json_aggregate_element', kind: 'nonNull' })
        : element,
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
                shape: jsonNestedShape(inferQueryOutputJsonShape(catalog, output.scope, outputIndex, nestedSeen)),
              })),
              kind: 'object',
              nullability: expressionNullability(catalog, scope, unwrapped, seen),
            }
          : baseRelationWholeRowJsonShape(catalog, scope, unwrapped, nestedSeen)
        break
      }
      case 'opaque':
      case 'relationColumn':
      case 'specialAttribute':
        shape = null
        break
    }
    if (shape?.kind === 'sqlNull') {
      // The referencing Var carries PostgreSQL's resolved output type, including
      // set-operation coercions; leaf scalar identities are no longer authoritative.
      shape = { ...shape, sqlType: typeFactForOid(catalog, unwrapped.typeOid, unwrapped.typeName) }
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

type SqlArrayShape = NonNullable<TypedSqlPostgresIrColumn['arrayShape']>

function isSqlArrayType(type: PostgresTypeFact): boolean {
  return type.pgTypeKind === 'array' || (type.pgBaseType !== undefined && isSqlArrayType(type.pgBaseType))
}

function queryOutputIsSqlScalar(catalog: CatalogFacts, scope: QueryScope, outputIndex: number): boolean {
  return foldQueryOutput<boolean>(scope, outputIndex, {
    except: (left) => left,
    intersect: (left, right) => left && right,
    target: (_targetScope, target) => {
      const type = typeFactForOid(catalog, target.expr?.typeOid, target.expr?.typeName)
      return type.pgTypeKind !== 'unknown' && !isSqlArrayType(type)
    },
    union: (left, right) => left && right,
  })
}

function sqlArrayShapeForExpr(
  catalog: CatalogFacts,
  scope: QueryScope,
  expr: PgAnalyzerExpr | null | undefined,
  seen: readonly VarLocation[] = []
): SqlArrayShape | null {
  const unwrapped = unwrapValuePreservingExpr(expr)
  if (!unwrapped || unwrapped.truncated) {
    return null
  }
  if (unwrapped.tag === 'ArrayExpr' && unwrapped.multidims === false && unwrapped.elements) {
    return {
      dimensions: 1,
      elementNullability:
        unwrapped.elements.length === 0
          ? { basis: 'empty_sql_array', kind: 'nonNull' }
          : unionResultNullabilities(
              unwrapped.elements.map((element) => expressionNullability(catalog, scope, element)),
              'sql_array_elements'
            ),
    }
  }
  if (unwrapped.tag === 'SubLink' && unwrapped.subLinkType === 'ARRAY' && unwrapped.subquery) {
    const source = queryScope(unwrapped.subquery, scope)
    return queryOutputIsSqlScalar(catalog, source, 0)
      ? { dimensions: 1, elementNullability: queryOutputNullability(catalog, source, 0) }
      : null
  }
  if (unwrapped.tag === 'SubLink' && unwrapped.subLinkType === 'EXPR' && unwrapped.subquery) {
    return queryOutputSqlArrayShape(catalog, queryScope(unwrapped.subquery, scope), 0, seen)
  }
  if (unwrapped.tag === 'CaseExpr' || unwrapped.tag === 'CoalesceExpr') {
    const arms: CaseArm[] = unwrapped.tag === 'CaseExpr' ? [...caseArms(scope, unwrapped)] : []
    if (unwrapped.tag === 'CoalesceExpr') {
      for (const child of exprChildren(unwrapped)) {
        arms.push({ result: child, scope })
        if (expressionNullability(catalog, scope, child, seen).kind === 'nonNull') break
      }
    }
    const shapes = arms
      .filter((arm) => !scopeProvesNull(arm.scope, arm.result))
      .map((arm) => sqlArrayShapeForExpr(catalog, arm.scope, arm.result, seen))
    return shapes.length > 0 ? shapes.reduce(combineSqlArrayShapes) : null
  }
  if (unwrapped.tag === 'Var') {
    const nestedSeen = visitVar(seen, scope, unwrapped)
    if (!nestedSeen) return null
    const source = resolveImmediateVarSource(scope, unwrapped)
    if (source.kind === 'queryOutput')
      return queryOutputSqlArrayShape(catalog, source.scope, source.outputIndex, nestedSeen)
    if (source.kind === 'expressions') {
      const shapes = source.expressions
        .filter((expression) => !scopeProvesNull(source.scope, expression))
        .map((expression) => sqlArrayShapeForExpr(catalog, source.scope, expression, nestedSeen))
      return shapes.length > 0 ? shapes.reduce(combineSqlArrayShapes) : null
    }
  }
  return null
}

function combineSqlArrayShapes(left: SqlArrayShape | null, right: SqlArrayShape | null): SqlArrayShape | null {
  return left && right
    ? {
        dimensions: 1,
        elementNullability: unionResultNullabilities(
          [left.elementNullability, right.elementNullability],
          'sql_array_output_union'
        ),
      }
    : null
}

function queryOutputSqlArrayShape(
  catalog: CatalogFacts,
  scope: QueryScope,
  outputIndex: number,
  seen: readonly VarLocation[] = []
): SqlArrayShape | null {
  return foldQueryOutput<SqlArrayShape | null>(scope, outputIndex, {
    except: (left) => left,
    intersect: combineSqlArrayShapes,
    target: (targetScope, target) => sqlArrayShapeForExpr(catalog, targetScope, target.expr, seen),
    union: combineSqlArrayShapes,
  })
}

function normalizeCompiledIr(catalog: CatalogFacts, analyzed: AnalyzedCompiledConfig): TypedSqlPostgresIr {
  const { analysis, config, primaryQuery: query, rewrittenQueries } = analyzed
  const rootScope = queryScope(query, null, catalog)

  const resultColumns = resultTargets(query).map((target, outputIndex): TypedSqlPostgresIrColumn => {
    const expr = target.expr
    const typeFact = typeFactForOid(catalog, expr?.typeOid, expr?.typeName)
    const checkConstraintType = checkConstraintTypeForQueryOutput(catalog, rootScope, outputIndex, [])
    const nullability = queryOutputNullability(catalog, rootScope, outputIndex)
    const inferredJsonShape = isJsonType(typeFact.pgTypeName)
      ? inferQueryOutputJsonShape(catalog, rootScope, outputIndex, [])
      : undefined
    const jsonShape = inferredJsonShape ? jsonShapeWithNullability(inferredJsonShape, nullability) : undefined
    const arrayShape = isSqlArrayType(typeFact) ? queryOutputSqlArrayShape(catalog, rootScope, outputIndex) : null
    return {
      ...(arrayShape ? { arrayShape } : {}),
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
  const rowBounds = inferRowBounds(catalog, rootScope)

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

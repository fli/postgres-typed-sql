import type { TypedSqlPostgresIrParamNullAdmission } from './analyzer-ir-model.js'

export interface PgAnalyzerResult {
  readonly paramTypeOids: readonly number[]
  readonly paramTypeNullAdmissions: readonly TypedSqlPostgresIrParamNullAdmission[]
  readonly paramUsageNullAdmissions: readonly TypedSqlPostgresIrParamNullAdmission[]
  readonly postgresVersionNum: number
  readonly rawStatementCount: number
  readonly schemaVersion: number
  readonly statements: readonly PgAnalyzerStatement[]
}

export interface PgAnalyzerStatement {
  readonly queries: readonly PgAnalyzerQuery[]
  readonly rewrittenQueryCount: number
}

export interface PgAnalyzerQuery {
  readonly canSetTag: boolean
  readonly commandType: string
  readonly cteList?: readonly PgAnalyzerCte[]
  readonly dmlParameterTargets: readonly PgAnalyzerDmlParameterTarget[]
  readonly distinctClauseCount?: number
  readonly fromTree: PgAnalyzerFromNode | null
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

export type PgAnalyzerSetOperation =
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

export interface PgAnalyzerDmlParameterTarget {
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

export interface PgAnalyzerTarget {
  readonly expr?: PgAnalyzerExpr | null
  readonly resno?: number
  readonly resjunk?: boolean
  readonly resname?: string | null
}

export interface PgAnalyzerCte {
  readonly commandType?: string
  readonly name: string
  readonly query?: PgAnalyzerQuery
  readonly recursive?: boolean
}

export type PgAnalyzerRteKind =
  | 'CTE'
  | 'FUNCTION'
  | 'GROUP'
  | 'JOIN'
  | 'NAMEDTUPLESTORE'
  | 'RELATION'
  | 'RESULT'
  | 'SUBQUERY'
  | 'TABLEFUNC'
  | 'UNRECOGNIZED'
  | 'VALUES'

export interface PgAnalyzerRte {
  readonly cteName?: string
  readonly cteLevelSup?: number
  readonly cteSelfReference?: boolean
  readonly erefColumnNames?: readonly string[]
  readonly groupExprs?: readonly PgAnalyzerExpr[]
  readonly inh?: boolean
  readonly joinAliasVars?: readonly (PgAnalyzerExpr | null)[]
  readonly kind: PgAnalyzerRteKind
  readonly lateral?: boolean
  readonly relid?: number | null
  readonly subquery?: PgAnalyzerQuery
  readonly valuesLists?: readonly (readonly PgAnalyzerExpr[])[]
}

export type PgAnalyzerJoinType =
  | 'ANTI'
  | 'FULL'
  | 'INNER'
  | 'LEFT'
  | 'RIGHT'
  | 'RIGHT_ANTI'
  | 'RIGHT_SEMI'
  | 'SEMI'
  | 'UNIQUE_INNER'
  | 'UNIQUE_OUTER'
  | 'UNRECOGNIZED'

export type PgAnalyzerFromNode =
  | {
      readonly fromlist?: readonly PgAnalyzerFromNode[]
      readonly quals?: PgAnalyzerExpr | null
      readonly tag: 'FromExpr'
      readonly truncated?: boolean
    }
  | {
      readonly joinType?: PgAnalyzerJoinType
      readonly left?: PgAnalyzerFromNode | null
      readonly quals?: PgAnalyzerExpr | null
      readonly right?: PgAnalyzerFromNode | null
      readonly rtindex?: number
      readonly tag: 'JoinExpr'
      readonly truncated?: boolean
    }
  | {
      readonly relid?: number | null
      readonly rtindex?: number
      readonly tag: 'RangeTblRef'
      readonly truncated?: boolean
    }
  | {
      readonly tag: 'UNRECOGNIZED'
      readonly truncated?: boolean
      readonly unsupported?: boolean
    }

export interface PgAnalyzerExpr {
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
  readonly coercionForm?: 'EXPLICIT_CALL' | 'EXPLICIT_CAST' | 'IMPLICIT_CAST' | 'SQL_SYNTAX' | 'UNRECOGNIZED'
  readonly defresult?: PgAnalyzerExpr | null
  readonly domainNullAdmission?: TypedSqlPostgresIrParamNullAdmission
  readonly elementExpr?: PgAnalyzerExpr | null
  readonly elements?: readonly PgAnalyzerExpr[]
  readonly expr?: PgAnalyzerExpr | null
  readonly funcid?: number
  readonly funcname?: string
  readonly funcVariadic?: boolean
  readonly inputCollationOid?: number
  readonly inputFunctionOid?: number
  readonly multidims?: boolean
  readonly nullTestType?: string
  readonly nullInputProducesNull?: boolean
  readonly nonNullInputProducesNonNull?: boolean
  readonly opfuncid?: number
  readonly opno?: number
  readonly opname?: string
  readonly outputFunctionOid?: number
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
  readonly varreturningtype?: 'DEFAULT' | 'NEW' | 'OLD' | 'UNRECOGNIZED'
  readonly whenClauses?: readonly PgAnalyzerExpr[]
}

export function targetExprFromAggregateArg(
  arg: PgAnalyzerExpr | { readonly expr?: PgAnalyzerExpr | null } | undefined
): PgAnalyzerExpr | null | undefined {
  if (!arg) {
    return null
  }
  return 'tag' in arg ? arg : arg.expr
}

export function unwrapValuePreservingExpr(expr: PgAnalyzerExpr | null | undefined): PgAnalyzerExpr | null | undefined {
  let current = expr
  while (current?.tag === 'RelabelType' || current?.tag === 'CoerceToDomain') {
    current = current.arg
  }
  return current
}

export function analyzerExprChildren(expr: PgAnalyzerExpr): readonly PgAnalyzerExpr[] {
  const children: PgAnalyzerExpr[] = []
  for (const key of ['arg', 'condition', 'defresult', 'elementExpr', 'expr', 'result', 'testExpr'] as const) {
    const child = expr[key]
    if (child) {
      children.push(child)
    }
  }
  children.push(...(expr.elements ?? []))
  children.push(...(expr.whenClauses ?? []))
  for (const arg of expr.args ?? []) {
    const child = targetExprFromAggregateArg(arg)
    if (child) {
      children.push(child)
    }
  }
  return children
}

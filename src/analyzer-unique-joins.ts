import {
  analyzerExprChildren,
  targetExprFromAggregateArg,
  unwrapValuePreservingExpr,
  type PgAnalyzerExpr,
  type PgAnalyzerFromNode,
  type PgAnalyzerQuery,
} from './postgres-analyzer-model.js'

export interface UniqueJoinConstraint {
  readonly determinantVarno: number | null
  readonly inputCollationOid: number
  readonly opno: number
  readonly targetAttnum: number
  readonly targetVarno: number
}

export interface UniqueJoinIndex {
  readonly attnums: readonly number[]
  readonly collationOids: readonly number[]
  readonly opfamilyOids: readonly number[]
  readonly proof: string
}

export interface UniqueJoinRelation {
  readonly indexes: readonly UniqueJoinIndex[]
  readonly varno: number
}

export interface UniqueJoinSource {
  readonly inh: boolean
  readonly relid: number
  readonly varno: number
}

export interface UniqueJoinProofInput {
  readonly constraints: readonly UniqueJoinConstraint[]
  readonly sources: readonly UniqueJoinSource[]
}

function isParamOrConst(expr: PgAnalyzerExpr | null | undefined): boolean {
  const unwrapped = unwrapValuePreservingExpr(expr)
  return unwrapped?.tag === 'Param' || unwrapped?.tag === 'Const'
}

function constraintsFromQual(
  expr: PgAnalyzerExpr | null | undefined,
  sources: readonly UniqueJoinSource[],
  output: UniqueJoinConstraint[] = []
): readonly UniqueJoinConstraint[] {
  if (!expr) {
    return output
  }
  if (expr.tag === 'BoolExpr' && expr.boolOp === 'AND') {
    for (const child of analyzerExprChildren(expr)) {
      constraintsFromQual(child, sources, output)
    }
    return output
  }
  if (expr.tag !== 'OpExpr' || !expr.opno || expr.args?.length !== 2) {
    return output
  }

  const left = unwrapValuePreservingExpr(targetExprFromAggregateArg(expr.args[0]))
  const right = unwrapValuePreservingExpr(targetExprFromAggregateArg(expr.args[1]))
  const addConstraint = (candidate: PgAnalyzerExpr | null | undefined, value: PgAnalyzerExpr | null | undefined) => {
    const source =
      candidate?.tag === 'Var'
        ? sources.find(
            (entry) =>
              entry.varno === candidate.varno && entry.relid === candidate.relid && (candidate.varlevelsup ?? 0) === 0
          )
        : undefined
    if (!source || candidate?.tag !== 'Var' || !candidate.varattno) {
      return
    }
    if (isParamOrConst(value)) {
      output.push({
        determinantVarno: null,
        inputCollationOid: expr.inputCollationOid ?? 0,
        opno: expr.opno as number,
        targetAttnum: candidate.varattno,
        targetVarno: source.varno,
      })
      return
    }
    if (
      value?.tag === 'Var' &&
      (value.varlevelsup ?? 0) === 0 &&
      typeof value.varno === 'number' &&
      value.varno !== source.varno &&
      sources.some((entry) => entry.varno === value.varno && entry.relid === value.relid)
    ) {
      output.push({
        determinantVarno: value.varno,
        inputCollationOid: expr.inputCollationOid ?? 0,
        opno: expr.opno as number,
        targetAttnum: candidate.varattno,
        targetVarno: source.varno,
      })
    }
  }

  addConstraint(left, right)
  addConstraint(right, left)
  return output
}

export function collectUniqueJoinProofInput(query: PgAnalyzerQuery): UniqueJoinProofInput | null {
  const root = query.fromTree
  if (!root || root.truncated === true || root.tag !== 'FromExpr' || !root.fromlist) {
    return null
  }

  const sources: UniqueJoinSource[] = []
  const quals: PgAnalyzerExpr[] = query.whereQual ? [query.whereQual] : []
  const visit = (node: PgAnalyzerFromNode): boolean => {
    if (node.truncated === true) {
      return false
    }
    switch (node.tag) {
      case 'FromExpr':
        if (!node.fromlist) {
          return false
        }
        if (node !== root && node.quals) {
          quals.push(node.quals)
        }
        return node.fromlist.every(visit)
      case 'JoinExpr':
        if (node.joinType !== 'INNER' || !node.left || !node.right) {
          return false
        }
        if (node.quals) {
          quals.push(node.quals)
        }
        return visit(node.left) && visit(node.right)
      case 'RangeTblRef': {
        if (!Number.isInteger(node.rtindex) || (node.rtindex as number) <= 0) {
          return false
        }
        const varno = node.rtindex as number
        const rte = query.rtable?.[varno - 1]
        if (
          rte?.kind !== 'RELATION' ||
          rte.lateral === true ||
          typeof rte.relid !== 'number' ||
          rte.relid <= 0 ||
          (typeof node.relid === 'number' && node.relid !== rte.relid)
        ) {
          return false
        }
        sources.push({ inh: rte.inh === true, relid: rte.relid, varno })
        return true
      }
      case 'UNRECOGNIZED':
        return false
    }
  }

  if (!visit(root) || sources.length <= 1) {
    return null
  }
  return {
    constraints: quals.flatMap((qual) => constraintsFromQual(qual, sources)),
    sources,
  }
}

function equalityOperatorKey(opfamilyOid: number, operatorOid: number): string {
  return `${opfamilyOid}:${operatorOid}`
}

export function inferUniqueJoinClosure(
  relations: readonly UniqueJoinRelation[],
  constraints: readonly UniqueJoinConstraint[],
  equalityOperators: ReadonlySet<string>
): readonly string[] | null {
  const determined = new Set<number>()
  const proofs: string[] = []
  let changed = true
  while (changed) {
    changed = false
    for (const relation of relations) {
      if (determined.has(relation.varno)) {
        continue
      }
      const index = relation.indexes.find((candidate) =>
        candidate.attnums.every((attnum, keyIndex) =>
          constraints.some(
            (constraint) =>
              constraint.targetVarno === relation.varno &&
              constraint.targetAttnum === attnum &&
              constraint.inputCollationOid === candidate.collationOids[keyIndex] &&
              (constraint.determinantVarno === null || determined.has(constraint.determinantVarno)) &&
              equalityOperators.has(equalityOperatorKey(candidate.opfamilyOids[keyIndex] ?? 0, constraint.opno))
          )
        )
      )
      if (index) {
        determined.add(relation.varno)
        proofs.push(index.proof)
        changed = true
      }
    }
  }
  return determined.size === relations.length ? proofs : null
}

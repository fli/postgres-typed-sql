import {
  analyzerExprChildren,
  targetExprFromAggregateArg,
  unwrapValuePreservingExpr,
  type PgAnalyzerExpr,
  type PgAnalyzerFromNode,
  type PgAnalyzerQuery,
} from './postgres-analyzer-model.js'
import type { TypedSqlPostgresIrRowBounds } from './analyzer-ir-model.js'

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

export function isImmutableRowIndependentExpr(expr: PgAnalyzerExpr | null | undefined): boolean {
  if (!expr || expr.truncated === true) {
    return false
  }
  switch (expr.tag) {
    case 'Param':
    case 'Const':
      return true
    case 'RelabelType':
    case 'CoerceToDomain':
      return isImmutableRowIndependentExpr(expr.arg)
    case 'FuncExpr':
    case 'OpExpr':
      return (
        expr.isImmutable === true &&
        expr.returnsSet === false &&
        expr.args !== undefined &&
        expr.args.every((arg) => isImmutableRowIndependentExpr(targetExprFromAggregateArg(arg)))
      )
    case 'CoalesceExpr':
    case 'BoolExpr':
      return (
        expr.args !== undefined &&
        expr.args.every((arg) => isImmutableRowIndependentExpr(targetExprFromAggregateArg(arg)))
      )
    case 'ArrayExpr':
      return expr.elements !== undefined && expr.elements.every(isImmutableRowIndependentExpr)
    default:
      return false
  }
}

export function collectUniqueConstraints(
  expr: PgAnalyzerExpr | null | undefined,
  sources: readonly { readonly varno: number; readonly relid: number | null }[],
  output: UniqueJoinConstraint[] = []
): readonly UniqueJoinConstraint[] {
  if (!expr) {
    return output
  }
  if (expr.tag === 'BoolExpr' && expr.boolOp === 'AND') {
    for (const child of analyzerExprChildren(expr)) {
      collectUniqueConstraints(child, sources, output)
    }
    return output
  }
  if (expr.tag !== 'OpExpr' || expr.isStrict !== true || !expr.opno || expr.args?.length !== 2) {
    return output
  }

  const left = unwrapValuePreservingExpr(targetExprFromAggregateArg(expr.args[0]))
  const right = unwrapValuePreservingExpr(targetExprFromAggregateArg(expr.args[1]))
  const addConstraint = (candidate: PgAnalyzerExpr | null | undefined, value: PgAnalyzerExpr | null | undefined) => {
    const source =
      candidate?.tag === 'Var'
        ? sources.find(
            (entry) =>
              entry.varno === candidate.varno &&
              entry.relid === (candidate.relid ?? null) &&
              (candidate.varlevelsup ?? 0) === 0
          )
        : undefined
    if (!source || candidate?.tag !== 'Var' || !candidate.varattno) {
      return
    }
    if (isImmutableRowIndependentExpr(value)) {
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
      sources.some((entry) => entry.varno === value.varno && entry.relid === (value.relid ?? null))
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
    constraints: quals.flatMap((qual) => collectUniqueConstraints(qual, sources)),
    sources,
  }
}

export function uniqueEqualityOperatorKey(opfamilyOid: number, operatorOid: number): string {
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
              equalityOperators.has(uniqueEqualityOperatorKey(candidate.opfamilyOids[keyIndex] ?? 0, constraint.opno))
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

export interface JoinRowBoundSource extends UniqueJoinRelation {
  readonly bounds: TypedSqlPostgresIrRowBounds
  readonly lateral: boolean
  readonly relid: number | null
}

interface JoinNodeBounds {
  readonly bounds: TypedSqlPostgresIrRowBounds
  readonly lateral: boolean
  readonly varnos: readonly number[]
}

function multiplyBounds(left: number | null, right: number | null): number | null {
  if (left === 0 || right === 0) {
    return 0
  }
  if (left === null || right === null) {
    return null
  }
  const product = left * right
  return Number.isSafeInteger(product) ? product : null
}

/** Infer per-input bounds along the join tree, keeping outer ON predicates on their own side. */
export function inferJoinTreeRowBounds(
  query: PgAnalyzerQuery,
  sources: readonly JoinRowBoundSource[],
  equalityOperators: ReadonlySet<string>
): TypedSqlPostgresIrRowBounds | null {
  let remainingVisits = 4096
  const infer = (
    node: PgAnalyzerFromNode,
    quals: readonly PgAnalyzerExpr[],
    determined: ReadonlySet<number>
  ): JoinNodeBounds | null => {
    remainingVisits -= 1
    if (remainingVisits < 0 || node.truncated === true) {
      return null
    }
    if (node.tag === 'RangeTblRef') {
      const source = sources.find((candidate) => candidate.varno === node.rtindex)
      if (!source || (node.relid != null && source.relid !== node.relid)) {
        return null
      }
      const constraints = quals.flatMap((qual) => collectUniqueConstraints(qual, sources))
      const index = source.indexes.find((candidate) =>
        candidate.attnums.every((attnum, keyIndex) =>
          constraints.some(
            (constraint) =>
              constraint.targetVarno === source.varno &&
              constraint.targetAttnum === attnum &&
              constraint.inputCollationOid === candidate.collationOids[keyIndex] &&
              (constraint.determinantVarno === null || determined.has(constraint.determinantVarno)) &&
              equalityOperators.has(uniqueEqualityOperatorKey(candidate.opfamilyOids[keyIndex] ?? 0, constraint.opno))
          )
        )
      )
      return {
        bounds: index ? { max: 1, min: 0, proof: index.proof } : source.bounds,
        lateral: source.lateral,
        varnos: [source.varno],
      }
    }
    if (node.tag === 'FromExpr') {
      if (!node.fromlist || node.fromlist.length === 0) {
        return null
      }
      const combinedQuals = node.quals ? [...quals, node.quals] : quals
      const [first, ...rest] = node.fromlist
      if (!first) {
        return null
      }
      const joined = rest.reduce<PgAnalyzerFromNode>(
        (left, right) => ({ joinType: 'INNER', left, right, tag: 'JoinExpr' }),
        first
      )
      const result = infer(joined, combinedQuals, determined)
      return result && node.quals ? { ...result, bounds: { ...result.bounds, min: 0 } } : result
    }
    if (node.tag !== 'JoinExpr' || !node.left || !node.right) {
      return null
    }
    if (node.joinType !== 'INNER' && node.joinType !== 'LEFT') {
      return null
    }

    const matchingQuals = node.quals ? [...quals, node.quals] : quals
    const left = infer(node.left, node.joinType === 'LEFT' ? quals : matchingQuals, determined)
    if (!left) {
      return null
    }
    // Each tuple on the left supplies a single value for all of its columns,
    // even when the complete left input has more than one tuple.
    const right = infer(node.right, matchingQuals, new Set([...determined, ...left.varnos]))
    if (!right) {
      return null
    }
    const rightMax =
      node.joinType === 'LEFT' && right.bounds.max !== null ? Math.max(1, right.bounds.max) : right.bounds.max
    let max = multiplyBounds(left.bounds.max, rightMax)
    if (node.joinType === 'INNER' && !right.lateral) {
      // The opposite orientation can expose a unique lookup on the right.
      // A lateral source only has bounds per left tuple, so it cannot seed this orientation.
      const independentRight = infer(node.right, matchingQuals, determined)
      const dependentLeft = independentRight
        ? infer(node.left, matchingQuals, new Set([...determined, ...independentRight.varnos]))
        : null
      if (independentRight && dependentLeft) {
        const reverseMax = multiplyBounds(independentRight.bounds.max, dependentLeft.bounds.max)
        if (reverseMax !== null) {
          max = max === null ? reverseMax : Math.min(max, reverseMax)
        }
      }
    }
    const min =
      node.joinType === 'LEFT'
        ? left.bounds.min
        : matchingQuals.length > 0
          ? 0
          : (multiplyBounds(left.bounds.min, right.bounds.min) ?? 0)
    return {
      bounds: {
        max,
        min,
        proof: `${node.joinType === 'LEFT' ? 'left' : 'inner'}_join(${left.bounds.proof},${right.bounds.proof})`,
      },
      lateral: left.lateral || right.lateral,
      varnos: [...left.varnos, ...right.varnos],
    }
  }

  if (!query.fromTree) {
    return null
  }
  const result = infer(query.fromTree, query.whereQual ? [query.whereQual] : [], new Set())
  if (!result || result.varnos.length < 2 || result.bounds.max === null) {
    return null
  }
  return query.whereQual ? { ...result.bounds, min: 0 } : result.bounds
}

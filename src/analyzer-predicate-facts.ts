import type { PgAnalyzerQuery } from './postgres-analyzer-model.js'

export type PredicateFactKey =
  | `unary_function_false:${number}:${string}`
  | `unary_function_non_null:${number}:${string}`
  | `var_non_null:${string}`
export type PredicateFacts = ReadonlyMap<PgAnalyzerQuery, ReadonlySet<PredicateFactKey>>

export const noPredicateFacts: PredicateFacts = new Map()

export function nonNullVarFactKey(varKey: string): PredicateFactKey {
  return `var_non_null:${varKey}`
}

export function unaryFunctionFalseFactKey(funcid: number, varKey: string): PredicateFactKey {
  return `unary_function_false:${funcid}:${varKey}`
}

export function unaryFunctionNonNullFactKey(funcid: number, varKey: string): PredicateFactKey {
  return `unary_function_non_null:${funcid}:${varKey}`
}

export function singletonPredicateFact(query: PgAnalyzerQuery, key: PredicateFactKey): PredicateFacts {
  return new Map([[query, new Set([key])]])
}

export function mergePredicateFacts(left: PredicateFacts, right: PredicateFacts): PredicateFacts {
  if (right.size === 0) {
    return left
  }
  const merged = new Map(left)
  for (const [query, rightKeys] of right) {
    merged.set(query, new Set([...(merged.get(query) ?? []), ...rightKeys]))
  }
  return merged
}

export function intersectPredicateFacts(facts: readonly PredicateFacts[]): PredicateFacts {
  const [first, ...rest] = facts
  if (!first) {
    return noPredicateFacts
  }
  const intersection = new Map<PgAnalyzerQuery, ReadonlySet<PredicateFactKey>>()
  for (const [query, keys] of first) {
    const shared = new Set([...keys].filter((key) => rest.every((candidate) => candidate.get(query)?.has(key))))
    if (shared.size > 0) {
      intersection.set(query, shared)
    }
  }
  return intersection
}

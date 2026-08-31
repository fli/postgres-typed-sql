import type { PgAnalyzerQuery } from './postgres-analyzer-model.js'

export type PredicateFactKey =
  | 'contradiction'
  | `expression_true:${string}`
  | `expression_false:${string}`
  | `expression_notTrue:${string}`
  | `expression_notFalse:${string}`
  | `expression_non_null:${string}`
  | `row_present:${string}`
  | `unary_function_false:${number}:${string}`
  | `unary_function_non_null:${number}:${string}`
  | `var_literal:${string}:${string}`
  | `var_excluded:${string}:${string}`
  | `var_equal:${string}`
  | `var_non_null:${string}`
  | `var_null:${string}`
export type PredicateFacts = ReadonlyMap<PgAnalyzerQuery, ReadonlySet<PredicateFactKey>>

export const noPredicateFacts: PredicateFacts = new Map()

export function nonNullVarFactKey(varKey: string): PredicateFactKey {
  return `var_non_null:${varKey}`
}

export function nullVarFactKey(varKey: string): PredicateFactKey {
  return `var_null:${varKey}`
}

export function rowPresentFactKey(rowKey: string): PredicateFactKey {
  return `row_present:${rowKey}`
}

export function nonNullExpressionFactKey(expressionKey: string): PredicateFactKey {
  return `expression_non_null:${expressionKey}`
}

export function literalVarFactKey(varKey: string, labels: readonly string[]): PredicateFactKey {
  return `var_literal:${varKey}:${JSON.stringify(labels)}`
}

export function excludedVarFactKey(varKey: string, labels: readonly string[]): PredicateFactKey {
  return `var_excluded:${varKey}:${JSON.stringify(labels)}`
}

export function equalVarsFactKey(left: string, right: string): PredicateFactKey {
  return `var_equal:${JSON.stringify([left, right].sort())}`
}

export function expressionTruthFactKey(
  expressionKey: string,
  outcome: 'true' | 'false' | 'notTrue' | 'notFalse'
): PredicateFactKey {
  return `expression_${outcome}:${expressionKey}`
}

export function excludedVarFacts(facts: ReadonlySet<PredicateFactKey> | undefined, varKey: string): readonly string[] {
  const prefix = `var_excluded:${varKey}:`
  return [...(facts ?? [])]
    .filter((key) => key.startsWith(prefix))
    .flatMap((key) => JSON.parse(key.slice(prefix.length)) as readonly string[])
}

export function literalVarFacts(
  facts: ReadonlySet<PredicateFactKey> | undefined,
  varKey: string
): readonly (readonly string[])[] {
  const prefix = `var_literal:${varKey}:`
  return [...(facts ?? [])]
    .filter((key) => key.startsWith(prefix))
    .map((key) => JSON.parse(key.slice(prefix.length)) as readonly string[])
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
    merged.set(query, normalizePredicateKeys(new Set([...(merged.get(query) ?? []), ...rightKeys])))
  }
  return merged
}

function literalFactVarKey(key: PredicateFactKey): string | null {
  return key.startsWith('var_literal:') || key.startsWith('var_excluded:')
    ? key.slice(key.indexOf(':') + 1, key.indexOf('[') - 1)
    : null
}

function normalizePredicateKeys(keys: Set<PredicateFactKey>): ReadonlySet<PredicateFactKey> {
  const groups: Set<string>[] = []
  for (const key of keys) {
    if (!key.startsWith('var_equal:')) continue
    const pair = JSON.parse(key.slice('var_equal:'.length)) as string[]
    const overlapping = groups.filter((group) => pair.some((member) => group.has(member)))
    const combined = new Set([...pair, ...overlapping.flatMap((group) => [...group])])
    for (const group of overlapping) groups.splice(groups.indexOf(group), 1)
    groups.push(combined)
  }
  const variables = new Set([...keys].map(literalFactVarKey).filter((key): key is string => key !== null))
  for (const group of groups) {
    const labels = [...group].flatMap((variable) => literalVarFacts(keys, variable))
    const excluded = [...group].flatMap((variable) => excludedVarFacts(keys, variable))
    for (const variable of group) {
      variables.add(variable)
      for (const candidates of labels) keys.add(literalVarFactKey(variable, candidates))
      if (excluded.length > 0) keys.add(excludedVarFactKey(variable, excluded))
      if ([...group].some((member) => keys.has(nonNullVarFactKey(member)))) keys.add(nonNullVarFactKey(variable))
      for (const other of group) if (variable !== other) keys.add(equalVarsFactKey(variable, other))
    }
  }
  for (const variable of variables) {
    const [first, ...rest] = literalVarFacts(keys, variable)
    const excluded = excludedVarFacts(keys, variable)
    if (first) {
      const allowed = first.filter(
        (label) => rest.every((labels) => labels.includes(label)) && !excluded.includes(label)
      )
      keys.add(literalVarFactKey(variable, allowed))
      if (allowed.length === 0) keys.add('contradiction')
    }
  }
  for (const key of keys) {
    if (key.startsWith('var_null:') && keys.has(nonNullVarFactKey(key.slice('var_null:'.length))))
      keys.add('contradiction')
    if (key.startsWith('expression_true:')) {
      const expression = key.slice('expression_true:'.length)
      if (
        keys.has(expressionTruthFactKey(expression, 'notTrue')) ||
        keys.has(expressionTruthFactKey(expression, 'false'))
      )
        keys.add('contradiction')
      keys.add(expressionTruthFactKey(expression, 'notFalse'))
    }
    if (key.startsWith('expression_false:')) {
      const expression = key.slice('expression_false:'.length)
      if (keys.has(expressionTruthFactKey(expression, 'notFalse'))) keys.add('contradiction')
      keys.add(expressionTruthFactKey(expression, 'notTrue'))
    }
  }
  return keys
}

export function intersectPredicateFacts(facts: readonly PredicateFacts[]): PredicateFacts {
  const [first, ...rest] = facts.filter(
    (candidate) => ![...candidate.values()].some((keys) => keys.has('contradiction'))
  )
  if (!first) {
    return facts[0] ?? noPredicateFacts
  }
  const intersection = new Map<PgAnalyzerQuery, ReadonlySet<PredicateFactKey>>()
  for (const [query, keys] of first) {
    const shared = new Set([...keys].filter((key) => rest.every((candidate) => candidate.get(query)?.has(key))))
    const variables = new Set([...keys].map(literalFactVarKey).filter((key): key is string => key !== null))
    for (const variable of variables) {
      const alternatives = [first, ...rest].map((candidate) => {
        const [labels, ...constraints] = literalVarFacts(candidate.get(query), variable)
        return labels?.filter((label) => constraints.every((constraint) => constraint.includes(label)))
      })
      if (alternatives.every((labels) => labels !== undefined)) {
        shared.add(literalVarFactKey(variable, [...new Set(alternatives.flat())]))
      }
    }
    if (shared.size > 0) {
      intersection.set(query, shared)
    }
  }
  return intersection
}

import assert from 'node:assert/strict'
import { log } from 'node:console'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const [referenceArg, candidateArg, seedsArg = '200'] = process.argv.slice(2)
assert.ok(
  referenceArg && candidateArg,
  'Usage: node scripts/compare-predicate-facts.mjs REFERENCE_MODULE CANDIDATE_MODULE [SEEDS]'
)
const reference = await import(pathToFileURL(resolve(referenceArg)))
const candidate = await import(pathToFileURL(resolve(candidateArg)))
const seeds = Number(seedsArg)
assert.ok(Number.isSafeInteger(seeds) && seeds > 0)
const queries = [{ name: 'outer' }, { name: 'inner' }, { name: 'sibling' }]
const keys = [
  'contradiction',
  ...['a', 'b', 'c'].flatMap((variable) => [
    reference.nonNullVarFactKey(variable),
    reference.nullVarFactKey(variable),
    reference.literalVarFactKey(variable, ['ready', 'queued']),
    reference.literalVarFactKey(variable, ['queued', 'ready']),
    reference.literalVarFactKey(variable, []),
    reference.literalVarFactKey(variable, ['a:b', 'x["\\', '\u0000']),
    reference.excludedVarFactKey(variable, ['ready']),
    reference.excludedVarFactKey(variable, ['queued', 'queued']),
    reference.rowPresentFactKey(variable),
  ]),
  reference.equalVarsFactKey('a', 'b'),
  reference.equalVarsFactKey('b', 'c'),
  reference.equalVarsFactKey('c', 'a'),
  ...['true', 'false', 'notTrue', 'notFalse'].map((outcome) => reference.expressionTruthFactKey('same', outcome)),
]
const view = (facts) => [...facts].map(([query, values]) => [query.name, [...values]])
let operations = 0
for (let seed = 1; seed <= seeds; seed += 1) {
  let random = seed
  const next = (bound) => {
    random = (Math.imul(random, 1664525) + 1013904223) >>> 0
    return Math.floor((random / 0x100000000) * bound)
  }
  const pool = [[reference.noPredicateFacts, candidate.noPredicateFacts]]
  const trace = []
  for (let step = 0; step < 60; step += 1) {
    const kind = next(4)
    let pair
    if (kind === 0 || pool.length < 3) {
      const query = queries[next(queries.length)]
      const key = keys[next(keys.length)]
      trace.push(['singleton', query.name, key])
      pair = [reference.singletonPredicateFact(query, key), candidate.singletonPredicateFact(query, key)]
    } else if (kind <= 2) {
      const left = next(pool.length)
      const right = kind === 2 ? left : next(pool.length)
      trace.push(['merge', left, right])
      pair = [
        reference.mergePredicateFacts(pool[left][0], pool[right][0]),
        candidate.mergePredicateFacts(pool[left][1], pool[right][1]),
      ]
    } else {
      const branches = Array.from({ length: next(4) }, () => next(pool.length))
      trace.push(['intersect', branches])
      pair = [
        reference.intersectPredicateFacts(branches.map((index) => pool[index][0])),
        candidate.intersectPredicateFacts(branches.map((index) => pool[index][1])),
      ]
    }
    assert.deepEqual(view(pair[1]), view(pair[0]), `seed ${seed}, trace ${JSON.stringify(trace)}`)
    for (const [oldFacts, newFacts] of [...pool, pair]) {
      assert.deepEqual(view(newFacts), view(oldFacts), `mutated prior branch, seed ${seed}`)
      for (const query of queries)
        for (const variable of ['a', 'b', 'c']) {
          assert.deepEqual(
            candidate.literalVarFacts(newFacts.get(query), variable),
            reference.literalVarFacts(oldFacts.get(query), variable)
          )
          assert.deepEqual(
            candidate.excludedVarFacts(newFacts.get(query), variable),
            reference.excludedVarFacts(oldFacts.get(query), variable)
          )
        }
    }
    pool.push(pair)
    operations += 1
  }
}
function mergeOutcome(module, entries) {
  try {
    return {
      value: view(module.mergePredicateFacts(module.noPredicateFacts, new Map([[queries[0], new Set(entries)]]))),
    }
  } catch (error) {
    return { error: { name: error.name, message: error.message } }
  }
}
const unusual = [
  ['var_literal:a:["ready"]', 'var_excluded:a:["done"]', 'var_literal:a:b:["queued"]'],
  ['var_equal:["a","a:b"]', 'var_literal:a:b:["queued"]', 'var_excluded:a:["ready"]'],
  ['var_literal:a:[malformed', 'var_excluded:a:[malformed'],
  ['var_excluded:a:[malformed', 'var_literal:a:[malformed'],
  ['var_equal:[malformed'],
  ['expression_false:same', 'expression_true:same', 'expression_notTrue:same'],
]
for (const entries of unusual) assert.deepEqual(mergeOutcome(candidate, entries), mergeOutcome(reference, entries))
log(JSON.stringify({ seeds, operations, unusualCases: unusual.length, errors: 0, orderedFactsAndReadersEqual: true }))

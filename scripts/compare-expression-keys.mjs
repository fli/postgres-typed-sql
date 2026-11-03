import assert from 'node:assert/strict'
import { log } from 'node:console'
import { readFile, writeFile, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const [oldArg, newArg] = process.argv.slice(2)
assert.ok(oldArg && newArg, 'Usage: node scripts/compare-expression-keys.mjs OLD_IR_MODULE NEW_IR_MODULE')
const temporary = []
async function probe(modulePath) {
  const original = resolve(modulePath)
  const path = join(dirname(original), `predicate-key-probe-${process.pid}.js`)
  temporary.push(path)
  await writeFile(
    path,
    `${await readFile(original, 'utf8')}\nexport { predicateExpressionKey, predicateTruthValues, queryScope };\n`
  )
  return import(pathToFileURL(path))
}
try {
  const old = await probe(oldArg)
  const current = await probe(newArg)
  const variable = { tag: 'Var', typeOid: 25, varno: 1, varattno: 2, varlevelsup: 0, varreturningtype: 'DEFAULT' }
  const constant = { tag: 'Const', typeOid: 25, constString: 'ready' }
  const immutable = {
    tag: 'FuncExpr',
    typeOid: 25,
    isImmutable: true,
    returnsSet: false,
    funcid: 123,
    inputCollationOid: 100,
    args: [variable],
  }
  const aggregate = {
    tag: 'Aggref',
    typeOid: 25,
    aggfnoid: 1,
    aggOrderCount: 0,
    aggDistinctCount: 0,
    agglevelsup: 0,
    aggfilter: null,
    aggstar: false,
    args: [variable],
  }
  const expressions = [
    undefined,
    null,
    variable,
    constant,
    immutable,
    aggregate,
    { ...variable, varlevelsup: 1 },
    { ...variable, varnullingrels: [2] },
    { ...variable, varreturningtype: 'OLD' },
    { ...variable, varreturningtype: 'NEW' },
    { ...variable, varreturningtype: 'UNRECOGNIZED' },
    { ...variable, varattno: undefined },
    { ...immutable, isImmutable: false },
    { ...immutable, returnsSet: true },
    { ...immutable, inputCollationOid: 200 },
    { ...immutable, truncated: true },
    { ...aggregate, aggOrderCount: 1 },
    { ...aggregate, aggDistinctCount: 1 },
    { ...aggregate, agglevelsup: 1 },
    { ...aggregate, aggfilter: undefined },
    { ...aggregate, aggfilter: { tag: 'BooleanTest', boolTestType: 'IS_TRUE', arg: variable } },
    { tag: 'RelabelType', arg: variable },
    { tag: 'NullTest', nullTestType: 'IS_NULL', argIsRow: false, arg: variable },
    { tag: 'BoolExpr', boolOp: 'AND', args: [immutable, immutable] },
    { tag: 'BoolExpr', boolOp: 'OR', args: [immutable, { ...immutable, isImmutable: false }] },
    { tag: 'Const', typeOid: 25, constIsNull: true },
    { tag: 'Const', typeOid: 23, constInteger: '1' },
    { tag: 'Const', typeOid: 16, constBoolean: false },
    { tag: 'Const', typeOid: 25 },
    { tag: 'Unsupported', typeOid: 25 },
  ]
  let comparisons = 0
  const phaseKeys = []
  for (const builtin of [true, false])
    for (const preserves of [true, false]) {
      const catalog = {
        procs: new Map([[1, { is_builtin: builtin, proname: 'max' }]]),
        columns: new Map([['7:2', { update_may_change_implicitly: preserves }]]),
      }
      const work = { catalog, expressionKeys: new WeakMap(), queryScopes: new WeakMap() }
      for (const commandType of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'MERGE']) {
        const query = {
          commandType,
          resultRelation: 1,
          rtable: [{ kind: 'RELATION', relid: 7 }],
          targetList: [{ resno: 2, expr: constant }],
        }
        for (const evaluationPhase of ['input', 'result']) {
          const scope = {
            catalog,
            work,
            evaluationPhase,
            query,
            parent: null,
            predicateFacts: new Map(),
            inputPredicateFacts: new Map(),
          }
          for (let repeat = 0; repeat < 4; repeat += 1)
            for (const expr of expressions) {
              assert.equal(
                current.predicateExpressionKey(scope, expr),
                old.predicateExpressionKey(scope, expr),
                `${commandType}/${evaluationPhase}/${builtin}/${preserves}/${expr?.tag}`
              )
              comparisons += 1
            }
          if (commandType === 'UPDATE' && builtin && preserves) {
            phaseKeys.push(current.predicateExpressionKey(scope, variable))
          }
          const truth = { tag: 'Const', typeOid: 16, constBoolean: true }
          const key = current.predicateExpressionKey(scope, truth)
          for (const facts of [new Map(), new Map([[query, new Set([`expression_false:${key}`])]])]) {
            const branch = { ...scope, predicateFacts: facts }
            assert.deepEqual(current.predicateTruthValues(branch, truth), old.predicateTruthValues(branch, truth))
          }
        }
      }
    }
  assert.notEqual(phaseKeys[0], phaseKeys[1], 'DML input/result fingerprints must differ for assigned columns')
  const catalog = { procs: new Map(), columns: new Map() }
  const work = { catalog, expressionKeys: new WeakMap(), queryScopes: new WeakMap() }
  const parentQuery = { commandType: 'SELECT' }
  const parent = {
    query: parentQuery,
    catalog,
    work,
    parent: null,
    evaluationPhase: 'result',
    predicateFacts: new Map(),
    inputPredicateFacts: new Map(),
  }
  const parents = [
    null,
    parent,
    { ...parent, evaluationPhase: 'input' },
    { ...parent, predicateFacts: new Map([[parentQuery, new Set(['var_null:1:2'])]]) },
  ]
  const scopes = []
  for (const hasAggs of [false, true])
    for (const havingQual of [null, { tag: 'Const', typeOid: 16, constBoolean: false }]) {
      const query = {
        commandType: 'SELECT',
        hasAggs,
        groupClauseCount: 0,
        havingQual,
        whereQual: { tag: 'NullTest', nullTestType: 'IS_NOT_NULL', argIsRow: false, arg: variable },
      }
      for (const owner of parents)
        for (let repeat = 0; repeat < 3; repeat += 1) {
          const expected = old.queryScope(query, owner, catalog)
          const actual = current.queryScope(query, owner, work)
          const view = (scope) => ({
            evaluationPhase: scope.evaluationPhase,
            predicateFacts: [...scope.predicateFacts].map(([identity, keys]) => [identity, [...keys]]),
            inputPredicateFacts: [...scope.inputPredicateFacts].map(([identity, keys]) => [identity, [...keys]]),
          })
          assert.deepEqual(
            view(actual),
            view(expected),
            'Complete scopes differ across parent/phase/aggregate contexts'
          )
          assert.equal(actual.parent, owner)
          scopes.push([actual, view(actual)])
          for (const [saved, before] of scopes) assert.deepEqual(view(saved), before, 'Earlier scope mutated')
        }
    }
  log(JSON.stringify({ comparisons, scopes: scopes.length, errors: 0, phaseKeys, cachedKeysAndRefusalsEqual: true }))
} finally {
  await Promise.all(temporary.map((path) => rm(path, { force: true })))
}

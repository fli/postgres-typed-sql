import assert from 'node:assert/strict'
import test from 'node:test'

import { staticVariadicFunctionArguments, type PgAnalyzerExpr } from '../src/postgres-analyzer-model.js'

const scalar = (tag: string): PgAnalyzerExpr => ({ tag })

test('decodes ordinary and explicit-variadic function argument envelopes without conflating unavailable input', () => {
  assert.deepEqual(
    staticVariadicFunctionArguments({
      args: [],
      funcVariadic: false,
      tag: 'FuncExpr',
    }),
    { arguments: [], kind: 'known' }
  )
  assert.deepEqual(
    staticVariadicFunctionArguments({
      args: [scalar('Const'), scalar('Param')],
      funcVariadic: false,
      tag: 'FuncExpr',
    }),
    { arguments: [scalar('Const'), scalar('Param')], kind: 'known' }
  )
  assert.deepEqual(
    staticVariadicFunctionArguments({
      args: [
        {
          elements: [scalar('Const'), scalar('Param')],
          multidims: false,
          tag: 'ArrayExpr',
        },
      ],
      funcVariadic: true,
      tag: 'FuncExpr',
    }),
    { arguments: [scalar('Const'), scalar('Param')], kind: 'known' }
  )
  assert.deepEqual(
    staticVariadicFunctionArguments({
      args: [
        {
          arg: {
            elements: [],
            multidims: false,
            tag: 'ArrayExpr',
          },
          tag: 'RelabelType',
        },
      ],
      funcVariadic: true,
      tag: 'FuncExpr',
    }),
    { arguments: [], kind: 'known' }
  )

  for (const expression of [
    scalar('Param'),
    { args: [], tag: 'FuncExpr' },
    { args: [], funcVariadic: false, tag: 'FuncExpr', truncated: true },
    { args: [scalar('Param')], funcVariadic: true, tag: 'FuncExpr' },
    {
      args: [{ elements: [], multidims: true, tag: 'ArrayExpr' }],
      funcVariadic: true,
      tag: 'FuncExpr',
    },
    {
      args: [{ elements: [], tag: 'ArrayExpr' }],
      funcVariadic: true,
      tag: 'FuncExpr',
    },
    {
      args: [{ multidims: false, tag: 'ArrayExpr' }],
      funcVariadic: true,
      tag: 'FuncExpr',
    },
    {
      args: [{ elements: [], multidims: false, tag: 'ArrayExpr', truncated: true }],
      funcVariadic: true,
      tag: 'FuncExpr',
    },
    {
      args: [scalar('Const'), scalar('Const')],
      funcVariadic: true,
      tag: 'FuncExpr',
    },
  ] satisfies readonly PgAnalyzerExpr[]) {
    assert.deepEqual(staticVariadicFunctionArguments(expression), { kind: 'unavailable' })
  }
})

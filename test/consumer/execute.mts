import runFindWidget, { findWidget } from './findWidget.typed-sql.js'
import runInsertWidget from './insertWidget.typed-sql.js'
import runOneWidget from './oneWidget.typed-sql.js'
import runDeleteWidget from './deleteWidget.typed-sql.js'
import runCallWidget from './callWidget.typed-sql.js'
import { createPostgresExecutor, PgExecutionError } from 'postgres-typed-sql/runtime'

function equal(actual: unknown, expected: unknown): void {
  const serialize = (value: unknown) =>
    JSON.stringify(value, (_key, entry: unknown) => (typeof entry === 'bigint' ? `${entry}n` : entry))
  if (serialize(actual) !== serialize(expected)) {
    throw new Error(`Expected ${serialize(expected)}, received ${serialize(actual)}`)
  }
}

let calls = 0
const findExecutor = createPostgresExecutor(async (request) => {
  calls++
  equal(request.text, findWidget.text)
  equal(request.values, ['widget-code', '{}'])
  return {
    rows: [
      [
        '7',
        'widget-code',
        null,
        'active',
        '[0:1]={1.20,NULL}',
        'document',
        '{"URL":"widget-code","display_name":null,"count":1}',
      ],
    ],
    rowCount: 1,
  }
})
const found = await runFindWidget(findExecutor, { code: 'widget-code', metrics: [] })
if (!found) throw new Error('Expected a widget')
equal(found.id, 7n)
equal(found.code, 'widget-code')
equal(found.label, null)
equal(found.state, 'active')
equal(found.metrics, {
  dimensions: [{ lowerBound: 0, length: 2 }],
  values: [{ kind: 'finite', negative: false, coefficient: 120n, exponent: -2n }, null],
})
equal(found.searchDocument, {
  kind: 'raw',
  type: { schema: 'pg_catalog', name: 'tsquery' },
  source: { format: 'text', value: 'document' },
})
equal(found.detailsJson.value, { URL: 'widget-code', displayName: null, count: 1 })
equal(found.detailsJson.source, '{"URL":"widget-code","display_name":null,"count":1}')
if (!Object.isFrozen(found.detailsJson.value) || !Object.isFrozen(found.metrics)) {
  throw new Error('Expected immutable decoded values')
}
const returningExecutor = createPostgresExecutor(async () => {
  calls++
  return { rows: [['8']], rowCount: 1 }
})
equal(await runInsertWidget(returningExecutor, { code: 'inserted', widgetLabel: null }), [{ id: 8n }])
const oneExecutor = createPostgresExecutor(async () => {
  calls++
  return { rows: [['1']], rowCount: 1 }
})
equal(await runOneWidget(oneExecutor), { value: 1 })
equal(await runOneWidget(oneExecutor, {}), { value: 1 })
const commandExecutor = createPostgresExecutor(async () => {
  calls++
  return { rows: [], rowCount: 2 }
})
equal(await runDeleteWidget(commandExecutor, { code: 'deleted' }), 2)
const callExecutor = createPostgresExecutor(async () => {
  calls++
  return { rows: [], rowCount: null }
})
equal(await runCallWidget(callExecutor), undefined)
equal(calls, 6)

const inheritedParams: { code: string; metrics: readonly number[] } = Object.assign(
  Object.create({ code: 'widget-code' }),
  { metrics: [] }
)
try {
  await runFindWidget(findExecutor, inheritedParams)
  throw new Error('Expected inherited parameter rejection')
} catch (error) {
  if (!(error instanceof PgExecutionError) || error.phase !== 'encode' || error.executionState !== 'notExecuted') {
    throw error
  }
}
const emptyExecutor = createPostgresExecutor(async () => ({
  rows: [],
  rowCount: 0,
}))
try {
  await runOneWidget(emptyExecutor)
  throw new Error('Expected cardinality rejection')
} catch (error) {
  if (
    !(error instanceof PgExecutionError) ||
    error.phase !== 'contract' ||
    error.executionState !== 'mayHaveExecuted'
  ) {
    throw error
  }
}
equal(calls, 6)

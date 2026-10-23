import runFindWidget, { findWidget } from './findWidget.typed-sql.js'
import runInsertWidget from './insertWidget.typed-sql.js'
import runOneWidget from './oneWidget.typed-sql.js'
import runDeleteWidget from './deleteWidget.typed-sql.js'
import runCallWidget from './callWidget.typed-sql.js'
import type { NodePostgresTypedSqlClient } from 'postgres-typed-sql/adapters/node-postgres'

function equal(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`)
  }
}

let calls = 0
const findClient: NodePostgresTypedSqlClient = {
  async query(config) {
    calls++
    equal(config.text, findWidget.text)
    equal(config.values, ['widget-code', []])
    equal(config.rowMode, 'array')
    equal(Object.hasOwn(config, 'name'), false)
    return {
      rows: [
        ['7', 'widget-code', null, 'active', [], 'document', { URL: 'widget-code', display_name: null, count: 1 }],
      ],
      rowCount: 1,
    }
  },
}
equal(await runFindWidget(findClient, { code: 'widget-code', metrics: [] }), {
  id: '7',
  code: 'widget-code',
  label: null,
  state: 'active',
  metrics: [],
  searchDocument: 'document',
  detailsJson: { URL: 'widget-code', displayName: null, count: 1 },
})
const returningClient: NodePostgresTypedSqlClient = {
  async query() {
    calls++
    return { rows: [['8']], rowCount: 1 }
  },
}
equal(await runInsertWidget(returningClient, { code: 'inserted', widgetLabel: null }), [{ id: '8' }])
const oneClient: NodePostgresTypedSqlClient = {
  async query() {
    calls++
    return { rows: [[1]], rowCount: 1 }
  },
}
equal(await runOneWidget(oneClient), { value: 1 })
equal(await runOneWidget(oneClient, {}), { value: 1 })
const commandClient: NodePostgresTypedSqlClient = {
  async query() {
    calls++
    return { rows: [], rowCount: 2 }
  },
}
equal(await runDeleteWidget(commandClient, { code: 'deleted' }), 2)
const callClient: NodePostgresTypedSqlClient = {
  async query() {
    calls++
    return { rows: [], rowCount: null }
  },
}
equal(await runCallWidget(callClient), undefined)
equal(calls, 6)

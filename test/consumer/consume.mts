import { echoBytes } from './echo-bytes.typed-sql.js'
import { findWidget } from './find-widget.typed-sql.js'
import { insertWidget } from './insert-widget.typed-sql.js'
import type { NodePostgresTypedSqlClient } from 'postgres-typed-sql/adapters/node-postgres'
import type { PgArray, PgArrayParameter } from 'postgres-typed-sql/scalars'

declare const client: NodePostgresTypedSqlClient

const query = findWidget.query({ code: 'widget-code', metrics: [] })
const values: readonly unknown[] = query.values

void values
void client.query(query)

echoBytes.query({ payloads: [] })

findWidget.query({ code: 'widget-code', metrics: [] })
findWidget.query({ code: 'widget-code', metrics: [1, '2', 3n, null] })
findWidget.query({ code: 'widget-code', metrics: '{{1,2},{3,4}}' })

const flatParameter: PgArrayParameter<number> = [1, null, 2]
const recursiveResult: PgArray<number> = [
  [1, null],
  [2, null],
]
void flatParameter
void recursiveResult

// @ts-expect-error Nested JavaScript arrays cannot prove rectangular PostgreSQL dimensions.
findWidget.query({ code: 'widget-code', metrics: [[1], [2, 3]] })

// @ts-expect-error SQL NULL array elements are accepted, but NULL subarrays are not representable.
findWidget.query({ code: 'widget-code', metrics: [[1], null] })

insertWidget.query({ code: 'widget-code', widgetLabel: null })

// @ts-expect-error PostgreSQL rejects SQL NULL for the NOT NULL code column.
insertWidget.query({ code: null, widgetLabel: null })

// @ts-expect-error SQL parameters do not accept JavaScript undefined.
insertWidget.query({ code: 'widget-code', widgetLabel: undefined })

import { echoBytes } from './echo-bytes.typed-sql.js'
import { findWidget } from './find-widget.typed-sql.js'
import { insertWidget } from './insert-widget.typed-sql.js'
import type { NodePostgresTypedSqlClient } from 'postgres-typed-sql/adapters/node-postgres'
import type { TypedSqlColumnMetadata } from 'postgres-typed-sql/runtime'
import type { PgArray, PgArrayParameter } from 'postgres-typed-sql/scalars'

declare const client: NodePostgresTypedSqlClient

type IsExactly<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2 ? true : false
type AssertTrue<Value extends true> = Value
type PublicMetadataHasNoSource = AssertTrue<IsExactly<Extract<keyof TypedSqlColumnMetadata, 'source'>, never>>

const publicColumnMetadata: TypedSqlColumnMetadata = {
  expressionSource: { kind: 'expression', tag: 'Const' },
  name: 'value',
  nullable: false,
  pgType: 'integer',
  pgTypeName: 'int4',
  pgTypeSchema: 'pg_catalog',
  propertyName: 'value',
}
const publicMetadataHasNoSource: PublicMetadataHasNoSource = true

void publicColumnMetadata.expressionSource
void publicMetadataHasNoSource

const query = findWidget.query({ code: 'widget-code', metrics: [] })
const values: readonly unknown[] = query.values

void values
void client.query(query)

echoBytes.query({ payloads: [] })
echoBytes.query({ payloads: [null] })

// @ts-expect-error Top-level SQL NULL requires explicit caller permission.
echoBytes.query({ payloads: null })

findWidget.query({ code: 'widget-code', metrics: [] })
findWidget.query({ code: 'widget-code', metrics: [1, '2', 3n, null] })
findWidget.query({ code: 'widget-code', metrics: '{{1,2},{3,4}}' })

// @ts-expect-error Array element NULL does not make the top-level SQL parameter nullable.
findWidget.query({ code: 'widget-code', metrics: null })

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

import { findWidget } from './find-widget.typed-sql.js'
import { insertWidget } from './insert-widget.typed-sql.js'

const query = findWidget.query({ code: 'widget-code' })
const values: readonly unknown[] = query.values

void values

insertWidget.query({ code: 'widget-code', label: null })

// @ts-expect-error PostgreSQL rejects SQL NULL for the NOT NULL code column.
insertWidget.query({ code: null, label: null })

// @ts-expect-error SQL parameters do not accept JavaScript undefined.
insertWidget.query({ code: 'widget-code', label: undefined })

import { findWidget } from './find-widget.typed-sql.js'

const query = findWidget.query({ code: 'widget-code' })
const values: readonly unknown[] = query.values

void values

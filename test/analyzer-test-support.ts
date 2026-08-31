import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import test from 'node:test'

import type { TypedSqlPostgresIrCompiledConfig } from '../src/analyzer-ir.js'
import { createAnalysisDatabase, type AnalysisDatabase } from '../src/engine.js'

const schemaFile = resolve(import.meta.dirname, 'fixtures/schema.sql')

export function analysisConfig(
  name: string,
  sql: string,
  parameterNames: readonly string[] = []
): TypedSqlPostgresIrCompiledConfig {
  return { name, parameterNames, sourceFile: `queries/${name}.typed.sql`, sql }
}

export function testWithDatabase(name: string, run: (database: AnalysisDatabase) => Promise<void>) {
  return test(name, async () => {
    const database = await createAnalysisDatabase({ schemaFiles: [schemaFile] })
    try {
      await run(database)
    } finally {
      await database.close()
    }
  })
}

export async function analyzeNative<Result>(database: AnalysisDatabase, sql: string): Promise<Result> {
  let delimiter = '$native_analyzer_sql$'
  while (sql.includes(delimiter)) {
    delimiter = `${delimiter.slice(0, -1)}_$`
  }
  await database.query('select 1')
  const result = await database.query<{ analysis: string }>(
    `select pg_temp.postgres_typed_sql_analyze(${delimiter}${sql}${delimiter}) as analysis`
  )
  const payload = result.rows[0]?.analysis
  assert.ok(typeof payload === 'string')
  return JSON.parse(payload) as Result
}

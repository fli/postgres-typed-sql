import assert from 'node:assert/strict'

import type { AnalysisDatabase } from '../src/engine.js'
import type { PgAnalyzerResult } from '../src/postgres-analyzer-model.js'

import { testWithDatabase } from './analyzer-test-support.js'

async function analyze(database: AnalysisDatabase, sql: string) {
  const result = await database.query<{ analysis: string }>(
    'select pg_temp.postgres_typed_sql_analyze($1) as analysis',
    [sql]
  )
  const raw = result.rows[0]?.analysis
  assert.ok(typeof raw === 'string')
  return { raw, analysis: JSON.parse(raw) as PgAnalyzerResult }
}

testWithDatabase(
  'native JSON strings preserve control characters, Unicode, empty strings, and null fields',
  async (database) => {
    const value = `"\\é😀${String.fromCharCode(...Array.from({ length: 31 }, (_, index) => index + 1))}`
    const alias = 'quoted"\\\n😀'
    const { raw, analysis } = await analyze(
      database,
      `select $value$${value}$value$::text as "${alias.replaceAll('"', '""')}", ''::text
       from (values (1)) input(id)`
    )
    const targets = analysis.statements[0]?.queries[0]?.targetList
    assert.equal(targets?.[0]?.resname, alias)
    assert.equal(targets?.[0]?.expr?.constString, value)
    assert.equal(targets?.[1]?.expr?.constString, '')
    assert.ok(raw.includes(`"constString":${JSON.stringify(value)}`))
    assert.ok(raw.includes('"relname":null'))
  }
)

testWithDatabase(
  'native function and operator proofs retain strictness, volatility, and sibling-error boundaries',
  async (database) => {
    await database.query('create table proof_probe (value integer, divisor integer)')
    await database.query('insert into proof_probe values (7, 0)')
    await database.query('set plan_cache_mode = force_generic_plan')
    for (const [name, operator, attributes, usage, preserves] of [
      ['strict', '#+#', 'immutable strict', 'accepts', true],
      ['nonstrict', '#-#', 'immutable called on null input', 'unknown', false],
      ['volatile', '#*#', 'volatile strict', 'accepts', false],
    ] as const) {
      await database.query(`create function public.proof_${name}(a integer, b integer)
        returns integer language plpgsql ${attributes}
        as $$ begin return coalesce(a, 0) + b; end $$`)
      await database.query(`create operator public.${operator}
        (function = public.proof_${name}, leftarg = integer, rightarg = integer)`)
      for (const call of [
        (right: string) => `public.proof_${name}($1::integer, ${right})`,
        (right: string) => `$1::integer operator(public.${operator}) (${right})`,
      ]) {
        const expression = call('1')
        const { analysis } = await analyze(database, `select ${expression}`)
        assert.deepEqual(analysis.paramUsageNullAdmissions, [usage], expression)
        const sql = `update proof_probe set value = coalesce(${expression}, value) returning value`
        const { analysis: update } = await analyze(database, sql)
        const admissions = update.statements[0]?.queries[0]?.dmlParameterNullAdmissions
        assert.ok(admissions)
        assert.equal(
          admissions.some(({ admission }) => admission === 'accepts'),
          preserves,
          expression
        )
        await database.query('update proof_probe set value = 7')
        assert.deepEqual((await database.query(sql, [null])).rows, [{ value: name === 'nonstrict' ? 1 : 7 }])

        if (name === 'strict') {
          const unsafe = call('1 / divisor')
          const unsafeSql = `update proof_probe set value = coalesce(${unsafe}, value)`
          const { analysis: unsafeUpdate } = await analyze(database, unsafeSql)
          assert.equal(
            unsafeUpdate.statements[0]?.queries[0]?.dmlParameterNullAdmissions.some(
              ({ admission }) => admission === 'accepts'
            ),
            false,
            unsafe
          )
          await database.query(`prepare unsafe_call(integer) as ${unsafeSql}`)
          await assert.rejects(database.query('execute unsafe_call(null)'), /division by zero/u)
          await database.query('deallocate unsafe_call')
        }
      }
    }
  }
)

import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import test from 'node:test'

import { createAnalysisDatabase, type AnalysisDatabase } from '../src/engine.js'

const schemaFile = resolve(import.meta.dirname, 'fixtures/schema.sql')

interface NativeAnalysis {
  readonly paramTypeOids: readonly number[]
  readonly postgresVersionNum: number
  readonly rawStatementCount: number
  readonly schemaVersion: number
  readonly statements: readonly NativeStatement[]
}

interface NativeStatement {
  readonly queries: readonly NativeQuery[]
  readonly rewrittenQueryCount: number
}

interface NativeQuery {
  readonly canSetTag: boolean
  readonly commandType: string
  readonly cteList: readonly NativeCte[]
  readonly dmlParameterTargets: readonly NativeDmlParameterTarget[]
  readonly hasLimitCount: boolean
  readonly rtable: readonly { readonly kind: string; readonly subquery?: NativeQuery }[]
  readonly targetList: readonly { readonly expr: NativeExpr }[]
}

interface NativeCte {
  readonly name: string
  readonly query?: NativeQuery
}

interface NativeDmlParameterTarget {
  readonly paramId: number
  readonly source: string
  readonly targetAttname: string
  readonly targetAttnum: number
  readonly targetNullable: boolean
  readonly targetRelid: number
  readonly targetTypeName: string
  readonly targetTypeOid: number
}

interface NativeExpr {
  readonly subLinkType?: string
  readonly tag: string
}

async function analyze(
  database: AnalysisDatabase,
  sql: string,
  paramTypeOids: readonly number[]
): Promise<NativeAnalysis> {
  const result = await database.query<{ analysis: string }>(
    'select pg_temp.postgres_typed_sql_analyze($1, $2::oid[]) as analysis',
    [sql, paramTypeOids]
  )
  const payload = result.rows[0]?.analysis
  assert.ok(typeof payload === 'string')
  return JSON.parse(payload) as NativeAnalysis
}

async function withDatabase(run: (database: AnalysisDatabase) => Promise<void>): Promise<void> {
  const database = await createAnalysisDatabase({ schemaFiles: [schemaFile] })
  try {
    await run(database)
  } finally {
    await database.close()
  }
}

test('native analyzer exposes the versioned PostgreSQL query envelope', async () => {
  await withDatabase(async (database) => {
    const analysis = await analyze(
      database,
      'select exists(select 1) as present from generate_series(1, 2) generated(n) cross join (values (1)) value(n) limit $1',
      [20]
    )

    assert.equal(analysis.schemaVersion, 3)
    assert.equal(analysis.postgresVersionNum, 180003)
    assert.equal(analysis.rawStatementCount, 1)
    assert.deepEqual(analysis.paramTypeOids, [20])
    assert.equal(analysis.statements.length, 1)
    assert.equal(analysis.statements[0]?.rewrittenQueryCount, 1)

    const query = analysis.statements[0]?.queries[0]
    assert.ok(query)
    assert.equal(query.canSetTag, true)
    assert.equal(query.commandType, 'SELECT')
    assert.equal(query.hasLimitCount, true)
    assert.deepEqual(
      query.rtable.map((entry) => entry.kind),
      ['FUNCTION', 'SUBQUERY', 'JOIN']
    )
    assert.deepEqual(
      query.rtable[1]?.subquery?.rtable.map((entry) => entry.kind),
      ['VALUES']
    )
    assert.equal(query.targetList[0]?.expr.tag, 'SubLink')
    assert.equal(query.targetList[0]?.expr.subLinkType, 'EXISTS')
  })
})

test('native analyzer preserves explicit parameter OIDs while inferring zero slots', async () => {
  await withDatabase(async (database) => {
    const analysis = await analyze(database, 'select $1::text, $2 + 1', [25, 0])

    assert.deepEqual(analysis.paramTypeOids, [25, 23])
  })
})

test('native analyzer maps direct DML parameters to PostgreSQL target columns', async () => {
  await withDatabase(async (database) => {
    const insert = await analyze(
      database,
      'insert into public.accounts(email, display_name) values ($1, $2), ($3, $4)',
      []
    )
    assert.deepEqual(
      insert.statements[0]?.queries[0]?.dmlParameterTargets.map(
        ({ paramId, source, targetAttname, targetNullable }) => ({
          paramId,
          source,
          targetAttname,
          targetNullable,
        })
      ),
      [
        { paramId: 1, source: 'INSERT', targetAttname: 'email', targetNullable: false },
        { paramId: 3, source: 'INSERT', targetAttname: 'email', targetNullable: false },
        { paramId: 2, source: 'INSERT', targetAttname: 'display_name', targetNullable: true },
        { paramId: 4, source: 'INSERT', targetAttname: 'display_name', targetNullable: true },
      ]
    )
    assert.ok(
      insert.statements[0]?.queries[0]?.dmlParameterTargets.every(
        (target) => target.targetRelid > 0 && target.targetAttnum > 0 && target.targetTypeOid > 0
      )
    )

    const repeatedInsert = await analyze(
      database,
      'insert into public.accounts(email, display_name) values ($1, $2), ($1, $2)',
      []
    )
    assert.deepEqual(
      repeatedInsert.statements[0]?.queries[0]?.dmlParameterTargets.map(({ paramId, targetAttname }) => ({
        paramId,
        targetAttname,
      })),
      [
        { paramId: 1, targetAttname: 'email' },
        { paramId: 2, targetAttname: 'display_name' },
      ]
    )

    const cteInsert = await analyze(
      database,
      `with source(email) as (select $1::text)
       insert into public.accounts(email)
       select source.email from source`,
      []
    )
    assert.deepEqual(
      cteInsert.statements[0]?.queries[0]?.dmlParameterTargets.map(
        ({ paramId, source, targetAttname, targetNullable }) => ({
          paramId,
          source,
          targetAttname,
          targetNullable,
        })
      ),
      [{ paramId: 1, source: 'INSERT', targetAttname: 'email', targetNullable: false }]
    )

    const update = await analyze(
      database,
      'update public.accounts account set display_name = $1::text, email = $2 where account.id = $3',
      [23, 25, 20]
    )
    assert.deepEqual(
      update.statements[0]?.queries[0]?.dmlParameterTargets.map(
        ({ paramId, source, targetAttname, targetNullable, targetTypeName }) => ({
          paramId,
          source,
          targetAttname,
          targetNullable,
          targetTypeName,
        })
      ),
      [
        { paramId: 2, source: 'UPDATE', targetAttname: 'email', targetNullable: false, targetTypeName: 'text' },
        {
          paramId: 1,
          source: 'UPDATE',
          targetAttname: 'display_name',
          targetNullable: true,
          targetTypeName: 'text',
        },
      ]
    )

    const upsert = await analyze(
      database,
      `insert into public.accounts(email, display_name)
       values ($1, $2)
       on conflict (email) do update set display_name = $3`,
      []
    )
    assert.deepEqual(
      upsert.statements[0]?.queries[0]?.dmlParameterTargets.map(({ paramId, source, targetAttname }) => ({
        paramId,
        source,
        targetAttname,
      })),
      [
        { paramId: 1, source: 'INSERT', targetAttname: 'email' },
        { paramId: 2, source: 'INSERT', targetAttname: 'display_name' },
        { paramId: 3, source: 'ON_CONFLICT_UPDATE', targetAttname: 'display_name' },
      ]
    )

    const merge = await analyze(
      database,
      `merge into public.accounts account
       using (values ($1::text, $2::text)) source(email, display_name)
       on account.email = source.email
       when matched then update set display_name = $3
       when not matched then insert (email, display_name) values (source.email, $4)`,
      []
    )
    assert.deepEqual(
      merge.statements[0]?.queries[0]?.dmlParameterTargets.map(({ paramId, source, targetAttname }) => ({
        paramId,
        source,
        targetAttname,
      })),
      [
        { paramId: 3, source: 'MERGE_UPDATE', targetAttname: 'display_name' },
        { paramId: 1, source: 'MERGE_INSERT', targetAttname: 'email' },
        { paramId: 4, source: 'MERGE_INSERT', targetAttname: 'display_name' },
      ]
    )

    const modifyingCte = await analyze(
      database,
      `with inserted as (
         insert into public.accounts(email, display_name) values ($1, $2)
         returning id
       )
       select id from inserted`,
      []
    )
    assert.deepEqual(modifyingCte.statements[0]?.queries[0]?.dmlParameterTargets, [])
    assert.deepEqual(
      modifyingCte.statements[0]?.queries[0]?.cteList[0]?.query?.dmlParameterTargets.map(
        ({ paramId, source, targetAttname }) => ({ paramId, source, targetAttname })
      ),
      [
        { paramId: 1, source: 'INSERT', targetAttname: 'email' },
        { paramId: 2, source: 'INSERT', targetAttname: 'display_name' },
      ]
    )

    const setOperation = await analyze(
      database,
      `insert into public.accounts(email)
       select $1::text
       union all
       select coalesce($1, 'fallback')`,
      []
    )
    assert.deepEqual(setOperation.statements[0]?.queries[0]?.dmlParameterTargets, [])

    await database.query('create domain public.non_null_text as text not null')
    await database.query('create table public.domain_probe (value text)')
    const domainCoercion = await analyze(
      database,
      'insert into public.domain_probe(value) values (($1::text)::public.non_null_text)',
      []
    )
    assert.deepEqual(domainCoercion.statements[0]?.queries[0]?.dmlParameterTargets, [])
  })
})

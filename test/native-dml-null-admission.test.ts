import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import test from 'node:test'

import { createAnalysisDatabase, type AnalysisDatabase } from '../src/engine.js'

const schemaFile = resolve(import.meta.dirname, 'fixtures/schema.sql')

type DmlAdmission = {
  readonly paramId: number
} & (
  | {
      readonly admission: 'accepts'
      readonly basis: 'action_unreachable_when_null' | 'direct_target_null_admission' | 'row_values_preserved_when_null'
    }
  | { readonly admission: 'rejects'; readonly basis: 'direct_target_null_admission' }
  | { readonly admission: 'unknown'; readonly basis: 'unresolved' }
)

interface DmlAnalysis {
  readonly statements: readonly {
    readonly queries: readonly {
      readonly dmlDirectAssignments: readonly { readonly paramId: number }[]
      readonly dmlParameterNullAdmissions: readonly DmlAdmission[]
    }[]
  }[]
}

async function analyze(database: AnalysisDatabase, sql: string): Promise<DmlAnalysis> {
  const result = await database.query<{ readonly analysis: string }>(
    'select pg_temp.postgres_typed_sql_analyze($1, $2::oid[]) as analysis',
    [sql, []]
  )
  const payload = result.rows[0]?.analysis
  assert.ok(typeof payload === 'string')
  return JSON.parse(payload) as DmlAnalysis
}

async function withDatabase(run: (database: AnalysisDatabase) => Promise<void>): Promise<void> {
  const database = await createAnalysisDatabase({ schemaFiles: [schemaFile] })
  try {
    await run(database)
  } finally {
    await database.close()
  }
}

function queryFacts(analysis: DmlAnalysis) {
  const query = analysis.statements[0]?.queries[0]
  assert.ok(query)
  return query
}

test('executable indexes make NULL admission incomplete without erasing assignment identity', async () => {
  await withDatabase(async (database) => {
    await database.query('create table public.index_enforcement_probe (value integer)')
    await database.query(`create function public.index_enforcement_key(value integer)
      returns integer language plpgsql immutable as $$
      begin
        if value is null then
          raise exception 'null index key';
        end if;
        return value;
      end
      $$`)
    await database.query(`create index index_enforcement_probe_key
      on public.index_enforcement_probe (public.index_enforcement_key(value))`)

    const sql = 'insert into public.index_enforcement_probe(value) values ($1::integer)'
    const facts = queryFacts(await analyze(database, sql))

    assert.deepEqual(
      facts.dmlDirectAssignments.map(({ paramId }) => paramId),
      [1]
    )
    assert.deepEqual(facts.dmlParameterNullAdmissions, [{ admission: 'unknown', basis: 'unresolved', paramId: 1 }])
    await assert.rejects(database.query(sql, [null]), /null index key/u)
  })
})

test('partial and exclusion indexes are conservative without erasing assignment identity', async () => {
  await withDatabase(async (database) => {
    await database.query('create table public.partial_index_probe (value integer)')
    await database.query(`create function public.partial_index_predicate(value integer)
      returns boolean language plpgsql immutable as $$
      begin
        if value is null then
          raise exception 'null partial predicate';
        end if;
        return value > 0;
      end
      $$`)
    await database.query(`create index partial_index_probe_positive
      on public.partial_index_probe (value)
      where public.partial_index_predicate(value)`)
    const partialSql = 'insert into public.partial_index_probe(value) values ($1::integer)'
    const partialFacts = queryFacts(await analyze(database, partialSql))

    assert.deepEqual(
      partialFacts.dmlDirectAssignments.map(({ paramId }) => paramId),
      [1]
    )
    assert.deepEqual(partialFacts.dmlParameterNullAdmissions, [
      { admission: 'unknown', basis: 'unresolved', paramId: 1 },
    ])
    await assert.rejects(database.query(partialSql, [null]), /null partial predicate/u)

    await database.query('create extension if not exists btree_gist')
    await database.query(`create table public.exclusion_probe (
      value integer,
      exclude using gist (value with =)
    )`)
    const exclusionSql = 'insert into public.exclusion_probe(value) values ($1::integer)'
    const exclusionFacts = queryFacts(await analyze(database, exclusionSql))

    assert.deepEqual(
      exclusionFacts.dmlDirectAssignments.map(({ paramId }) => paramId),
      [1]
    )
    assert.deepEqual(exclusionFacts.dmlParameterNullAdmissions, [
      { admission: 'unknown', basis: 'unresolved', paramId: 1 },
    ])
    await database.query(exclusionSql, [null])
  })
})

test('incomplete enforcement preserves structural identity and definite rejection', async () => {
  await withDatabase(async (database) => {
    await database.query(`create table public.nnd_required_probe (
      value integer not null unique nulls not distinct
    )`)
    const nndSql = 'insert into public.nnd_required_probe(value) values ($1::integer)'
    const nndFacts = queryFacts(await analyze(database, nndSql))

    assert.deepEqual(
      nndFacts.dmlDirectAssignments.map(({ paramId }) => paramId),
      [1]
    )
    assert.deepEqual(nndFacts.dmlParameterNullAdmissions, [
      { admission: 'rejects', basis: 'direct_target_null_admission', paramId: 1 },
    ])

    await database.query('create table public.rls_identity_probe (value integer)')
    await database.query('alter table public.rls_identity_probe enable row level security')
    await database.query(`create policy require_value on public.rls_identity_probe
      for insert with check (value is not null)`)
    const rlsFacts = queryFacts(
      await analyze(database, 'insert into public.rls_identity_probe(value) values ($1::integer)')
    )

    assert.deepEqual(
      rlsFacts.dmlDirectAssignments.map(({ paramId }) => paramId),
      [1]
    )
    assert.deepEqual(rlsFacts.dmlParameterNullAdmissions, [{ admission: 'unknown', basis: 'unresolved', paramId: 1 }])
  })
})

test('constant and leaf-partition checks participate in target NULL admission', async () => {
  await withDatabase(async (database) => {
    await database.query('create table public.constant_check_probe (value integer check (false))')
    const constantSql = 'insert into public.constant_check_probe(value) values ($1::integer)'
    const constantFacts = queryFacts(await analyze(database, constantSql))

    assert.deepEqual(constantFacts.dmlParameterNullAdmissions, [
      { admission: 'rejects', basis: 'direct_target_null_admission', paramId: 1 },
    ])
    await assert.rejects(database.query(constantSql, [null]), /constant_check_probe_check/u)

    const unreachableSql = `update public.constant_check_probe
      set value = $1::integer where $1::integer is not null`
    const unreachableFacts = queryFacts(await analyze(database, unreachableSql))
    assert.deepEqual(unreachableFacts.dmlParameterNullAdmissions, [
      { admission: 'accepts', basis: 'action_unreachable_when_null', paramId: 1 },
    ])
    await database.query(unreachableSql, [null])

    await database.query(`create table public.partition_check_probe (
      bucket integer,
      value integer
    ) partition by list (bucket)`)
    await database.query(`create table public.partition_check_probe_one
      partition of public.partition_check_probe for values in (1)`)
    const leafSql = `insert into public.partition_check_probe_one(bucket, value)
      values ($1::integer, 1)`
    const leafFacts = queryFacts(await analyze(database, leafSql))

    assert.deepEqual(
      leafFacts.dmlDirectAssignments.map(({ paramId }) => paramId),
      [1]
    )
    assert.deepEqual(leafFacts.dmlParameterNullAdmissions, [{ admission: 'unknown', basis: 'unresolved', paramId: 1 }])
    await assert.rejects(database.query(leafSql, [null]), /partition constraint/u)
  })
})

test('statement triggers block action-unreachable proofs while row enforcement does not erase safe old rows', async () => {
  await withDatabase(async (database) => {
    await database.query('create table public.statement_trigger_probe (value integer)')
    await database.query('insert into public.statement_trigger_probe(value) values (1)')
    await database.query(`create function public.raise_statement_trigger()
      returns trigger language plpgsql as $$
      begin
        raise exception 'statement trigger executed';
      end
      $$`)
    await database.query(`create trigger raise_statement
      before update on public.statement_trigger_probe
      for each statement execute function public.raise_statement_trigger()`)
    const triggerSql = `update public.statement_trigger_probe
      set value = coalesce($1::integer, value)
      where $1::integer is not null`
    const triggerFacts = queryFacts(await analyze(database, triggerSql))

    assert.equal(
      triggerFacts.dmlParameterNullAdmissions.some(
        ({ admission, paramId }) => admission === 'accepts' && paramId === 1
      ),
      false
    )
    await assert.rejects(database.query(triggerSql, [null]), /statement trigger executed/u)

    await database.query('create table public.preserved_index_probe (value integer)')
    await database.query('insert into public.preserved_index_probe(value) values (1)')
    await database.query(`create index preserved_index_probe_key
      on public.preserved_index_probe ((value + 1))`)
    const preservedSql = `update public.preserved_index_probe
      set value = coalesce($1::integer, value)`
    const preservedFacts = queryFacts(await analyze(database, preservedSql))

    assert.deepEqual(preservedFacts.dmlParameterNullAdmissions, [
      { admission: 'accepts', basis: 'row_values_preserved_when_null', paramId: 1 },
    ])
    await database.query(preservedSql, [null])
  })
})

test('enforced unvalidated foreign keys block old-row preservation', async () => {
  await withDatabase(async (database) => {
    await database.query('create table public.fk_parent_probe (id integer primary key)')
    await database.query(`create table public.fk_child_probe (
      id integer primary key,
      parent_id integer
    )`)
    await database.query('begin')
    await database.query('insert into public.fk_child_probe(id, parent_id) values (1, 99)')
    await database.query(`alter table public.fk_child_probe
      add constraint fk_child_parent foreign key (parent_id)
      references public.fk_parent_probe(id) not valid`)
    const sql = `update public.fk_child_probe
      set parent_id = coalesce($1::integer, parent_id)
      where id = 1`
    const facts = queryFacts(await analyze(database, sql))

    assert.equal(
      facts.dmlParameterNullAdmissions.some(({ admission, paramId }) => admission === 'accepts' && paramId === 1),
      false
    )
    await assert.rejects(database.query(sql, [null]), /fk_child_parent/u)
    await database.query('rollback')
  })
})

import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import test from 'node:test'

import {
  buildTypedSqlPostgresIrFromCompiledConfigs,
  type TypedSqlPostgresIrCompiledConfig,
} from '../src/analyzer-ir.js'
import { createAnalysisDatabase } from '../src/engine.js'

const schemaFile = resolve(import.meta.dirname, 'fixtures/schema.sql')

function config(name: string, sql: string, parameterNames: readonly string[]): TypedSqlPostgresIrCompiledConfig {
  return { name, parameterNames, sourceFile: `queries/${name}.typed.sql`, sql }
}

test('propagates at-most-one cardinality through inner joins on primary and unique keys', async () => {
  const database = await createAnalysisDatabase({ schemaFiles: [schemaFile] })
  try {
    for (const sql of [
      'create table public.trainers (id bigint primary key)',
      'create table public.currencies (id bigint primary key)',
      `create table public.trainer_currency (
         trainer_id bigint unique references public.trainers(id),
         currency_id bigint not null references public.currencies(id)
       )`,
      `create table public.trainer_labels (
         trainer_id bigint not null references public.trainers(id),
         label text not null,
         currency_id bigint not null references public.currencies(id),
         unique (trainer_id, label)
       )`,
      `create table public.trainer_tags (
         trainer_id bigint not null references public.trainers(id),
         currency_id bigint not null references public.currencies(id)
       )`,
    ]) {
      await database.query(sql)
    }

    const result = await buildTypedSqlPostgresIrFromCompiledConfigs(database, [
      config(
        'uniqueChain',
        `select currency.id
         from public.trainers trainer
         join public.trainer_currency selected on selected.trainer_id = trainer.id
         join public.currencies currency on currency.id = selected.currency_id
         where trainer.id = $1`,
        ['trainerId']
      ),
      config(
        'reversedEquality',
        `select currency.id
         from public.trainers trainer
         join public.trainer_currency selected on trainer.id = selected.trainer_id
         join public.currencies currency on selected.currency_id = currency.id
         where $1 = trainer.id`,
        ['trainerId']
      ),
      config(
        'compositeChain',
        `select currency.id
         from public.trainers trainer
         join public.trainer_labels selected
           on selected.trainer_id = trainer.id
          and selected.label = $2
         join public.currencies currency on currency.id = selected.currency_id
         where trainer.id = $1`,
        ['trainerId', 'label']
      ),
      config(
        'independentLookups',
        `select trainer.id
         from public.trainers trainer, public.currencies currency
         where trainer.id = $1 and currency.id = $2`,
        ['trainerId', 'currencyId']
      ),
    ])

    for (const query of result.queries) {
      assert.equal(query.rowBounds.max, 1, query.name)
      assert.equal(query.rowBounds.min, 0, query.name)
      assert.match(query.rowBounds.proof, /^unique_join_closure\(/u, query.name)
    }
  } finally {
    await database.close()
  }
})

test('fails closed when a join source is not uniquely determined or the join form is unsupported', async () => {
  const database = await createAnalysisDatabase({ schemaFiles: [schemaFile] })
  try {
    for (const sql of [
      'create table public.bound_trainers (id bigint primary key)',
      'create table public.bound_currencies (id bigint primary key)',
      `create table public.bound_labels (
         trainer_id bigint not null,
         label text not null,
         currency_id bigint not null,
         unique (trainer_id, label)
       )`,
      'create table public.bound_tags (trainer_id bigint not null, currency_id bigint not null)',
    ]) {
      await database.query(sql)
    }

    const result = await buildTypedSqlPostgresIrFromCompiledConfigs(database, [
      config(
        'nonUniqueJoin',
        `select currency.id
         from public.bound_trainers trainer
         join public.bound_tags tag on tag.trainer_id = trainer.id
         join public.bound_currencies currency on currency.id = tag.currency_id
         where trainer.id = $1`,
        ['trainerId']
      ),
      config(
        'partialCompositeKey',
        `select label.currency_id
         from public.bound_trainers trainer
         join public.bound_labels label on label.trainer_id = trainer.id
         where trainer.id = $1`,
        ['trainerId']
      ),
      config(
        'orPredicate',
        `select tag.currency_id
         from public.bound_trainers trainer
         join public.bound_tags tag on tag.trainer_id = trainer.id
         where trainer.id = $1 or trainer.id = $2`,
        ['firstTrainerId', 'secondTrainerId']
      ),
      config(
        'leftJoin',
        `select label.currency_id
         from public.bound_trainers trainer
         left join public.bound_labels label
           on label.trainer_id = trainer.id
          and label.label = 'primary'
         where trainer.id = $1`,
        ['trainerId']
      ),
    ])

    for (const query of result.queries) {
      assert.equal(query.rowBounds.max, null, query.name)
      assert.equal(query.rowBounds.min, 0, query.name)
      assert.equal(query.rowBounds.proof, 'unbounded', query.name)
    }
  } finally {
    await database.close()
  }
})

import assert from 'node:assert/strict'

import test from 'node:test'

import { renderQuery } from './generator-test-support.js'

test('generates precise range JSON fields and optional cardinality through a unique join chain', async () => {
  const output = await renderQuery(
    `create table public.trainers (
  id bigint primary key,
  active_span int4range not null
);
create table public.currencies (
  id bigint primary key
);
create table public.trainer_currency (
  trainer_id bigint unique references public.trainers(id),
  currency_id bigint not null references public.currencies(id)
);
`,
    `select jsonb_build_object(
  'lower', lower(trainer.active_span),
  'upper', upper(trainer.active_span),
  'currency_id', currency.id
) as payload
from public.trainers trainer
join public.trainer_currency selected
  on selected.trainer_id = trainer.id
join public.currencies currency
  on currency.id = selected.currency_id
where trainer.id = :trainer_id
  and not isempty(trainer.active_span)
  and not lower_inf(trainer.active_span)
  and not upper_inf(trainer.active_span)
`
  )
  assert.match(output, /cardinality: 'optional'/u)
  assert.match(output, /readonly lower: number\n/u)
  assert.match(output, /readonly upper: number\n/u)
  assert.doesNotMatch(output, /readonly lower: number \| null/u)
  assert.doesNotMatch(output, /readonly upper: number \| null/u)
})

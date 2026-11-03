import assert from 'node:assert/strict'

import { buildTypedSqlPostgresIrFromCompiledConfigs } from '../src/analyzer-ir.js'
import { analysisConfig, testWithDatabase } from './analyzer-test-support.js'

testWithDatabase('repeated scope analysis preserves CASE parents, window rows, and empty groups', async (database) => {
  await database.query('create table reuse_probe(id integer primary key, n integer, label text)')
  await database.query("insert into reuse_probe values(1,5,'ready'),(2,null,'queued'),(3,7,null)")
  const statements = [
    analysisConfig(
      'caseParents',
      `select
      case when n is not null then (select p.n) else 0 end as present,
      case when n is null then (select p.n) else null end as absent
      from reuse_probe p order by id`
    ),
    analysisConfig(
      'windowRows',
      `select
      case when n is not null then lead(n) over(order by id) else 0 end as next_n
      from reuse_probe order by id`
    ),
    analysisConfig(
      'cteParents',
      `with shared as (select id,n,label from reuse_probe)
      select case when s.n is not null then (select x.n from shared x where x.id=s.id) else null end as v,
        case when s.n is null then (select x.n from shared x where x.id=s.id) else 0 end as other
      from shared s order by s.id`
    ),
    analysisConfig(
      'emptyGroup',
      `select count(*) as count,
      case when max(n) is not null then max(n) else null end as n
      from reuse_probe where n is not null and false`
    ),
  ]
  const result = await buildTypedSqlPostgresIrFromCompiledConfigs(database, statements)
  const queries = new Map(result.queries.map((query) => [query.name, query]))
  assert.equal(queries.get('caseParents')?.resultColumns[0]?.nullability.kind, 'nonNull')
  assert.notEqual(queries.get('caseParents')?.resultColumns[1]?.nullability.kind, 'nonNull')
  assert.notEqual(queries.get('windowRows')?.resultColumns[0]?.nullability.kind, 'nonNull')
  assert.notEqual(queries.get('emptyGroup')?.resultColumns[1]?.nullability.kind, 'nonNull')
  const expected = new Map<string, readonly Record<string, unknown>[]>([
    [
      'caseParents',
      [
        { present: 5, absent: null },
        { present: 0, absent: null },
        { present: 7, absent: null },
      ],
    ],
    ['windowRows', [{ next_n: null }, { next_n: 0 }, { next_n: null }]],
    [
      'cteParents',
      [
        { v: 5, other: 0 },
        { v: null, other: null },
        { v: 7, other: 0 },
      ],
    ],
    ['emptyGroup', [{ count: 0, n: null }]],
  ])
  for (const statement of statements) {
    const rows = (await database.query(statement.sql)).rows
    assert.deepEqual(rows, expected.get(statement.name), statement.name)
    for (const column of queries.get(statement.name)?.resultColumns ?? []) {
      if (column.nullability.kind === 'nonNull')
        assert.ok(
          rows.every((row) => row[column.name ?? ''] !== null),
          `${statement.name}.${column.name}`
        )
    }
  }
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { getTypeParser, type TypeId } from 'pg-types'

import { typeScriptParameterTypeForPostgresType, typeScriptTypeForPostgresType } from '../src/postgres-types.js'

test('central PostgreSQL type rules honor explicit scalar profiles and exact driver array OIDs', () => {
  const pgCatalog = (pgType: string, pgTypeName = pgType, pgTypeOid = 0) => ({
    pgType,
    pgTypeName,
    pgTypeOid,
    pgTypeSchema: 'pg_catalog',
  })

  assert.equal(typeScriptTypeForPostgresType(pgCatalog('integer', 'int4')), 'number')
  assert.equal(typeScriptTypeForPostgresType(pgCatalog('bigint', 'int8')), 'PgInt8String')
  assert.equal(
    typeScriptTypeForPostgresType(pgCatalog('timestamp with time zone', 'timestamptz', 1184)),
    'Date | number'
  )
  assert.equal(typeScriptTypeForPostgresType(pgCatalog('tsquery')), 'string')
  assert.equal(
    typeScriptTypeForPostgresType({
      pgType: 'audit.account_status[]',
      pgTypeName: '_account_status',
      pgTypeOid: 16_384,
      pgTypeSchema: 'audit',
    }),
    'unknown'
  )
  assert.equal(typeScriptTypeForPostgresType(pgCatalog('numeric[]', '_numeric', 1231)), 'PgArray<number>')
  assert.equal(typeScriptTypeForPostgresType(pgCatalog('bigint[]', '_int8', 1016)), 'PgArray<PgInt8String>')
  assert.equal(typeScriptTypeForPostgresType(pgCatalog('date[]', '_date', 1182)), 'PgArray<Date | number>')
  assert.equal(typeScriptTypeForPostgresType(pgCatalog('tsquery[]', '_tsquery', 3645)), 'unknown')

  assert.equal(typeScriptParameterTypeForPostgresType(pgCatalog('jsonb[]', '_jsonb', 3807)), 'PgArray<DbJsonInput>')
  assert.equal(
    typeScriptParameterTypeForPostgresType(pgCatalog('bigint[]', '_int8', 1016)),
    'PgArray<bigint | number | string>'
  )
  assert.equal(
    typeScriptParameterTypeForPostgresType({
      pgType: 'audit.account_status[]',
      pgTypeName: '_account_status',
      pgTypeOid: 16_384,
      pgTypeSchema: 'audit',
    }),
    'PgArray<AuditAccountStatus>'
  )

  assert.equal(typeScriptTypeForPostgresType(pgCatalog('integer', 'int4'), undefined, 'conservative'), 'unknown')
  assert.equal(
    typeScriptTypeForPostgresType(
      { pgType: 'account_status', pgTypeName: 'account_status', pgTypeSchema: 'public' },
      undefined,
      'conservative'
    ),
    'unknown'
  )
})

test('node-postgres parser fixtures match the modeled array, fallback, and infinity behavior', () => {
  const parseNumericArray = getTypeParser(1231 as TypeId)
  assert.deepEqual(parseNumericArray('{{1.5,NULL},{-2,3}}'), [
    [1.5, null],
    [-2, 3],
  ])

  const rawDynamicType = getTypeParser(90_000 as TypeId)
  assert.equal(rawDynamicType('{queued,complete}'), '{queued,complete}')
  assert.equal(rawDynamicType('42'), '42')

  const parseDate = getTypeParser(1082 as TypeId)
  const parseDateArray = getTypeParser(1182 as TypeId)
  const parseTimestamp = getTypeParser(1184 as TypeId)
  assert.equal(parseDate('infinity'), Infinity)
  const dateArray = parseDateArray('{infinity,2026-07-15}') as unknown[]
  assert.equal(dateArray[0], Infinity)
  assert.ok(dateArray[1] instanceof Date)
  assert.equal(parseTimestamp('-infinity'), -Infinity)
  assert.ok(parseTimestamp('2026-07-15 12:00:00+09:30') instanceof Date)
})

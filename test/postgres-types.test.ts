import assert from 'node:assert/strict'
import test from 'node:test'

import { typeScriptParameterTypeForPostgresType, typeScriptTypeForPostgresType } from '../src/postgres-types.js'

test('central PostgreSQL type rules honor explicit scalar profiles', () => {
  const pgCatalog = (pgType: string, pgTypeName = pgType) => ({
    pgType,
    pgTypeName,
    pgTypeSchema: 'pg_catalog',
  })

  assert.equal(typeScriptTypeForPostgresType(pgCatalog('integer', 'int4')), 'number')
  assert.equal(typeScriptTypeForPostgresType(pgCatalog('bigint', 'int8')), 'PgInt8String')
  assert.equal(typeScriptTypeForPostgresType(pgCatalog('timestamp with time zone', 'timestamptz')), 'Date')
  assert.equal(typeScriptTypeForPostgresType(pgCatalog('tsquery')), 'string')
  assert.equal(
    typeScriptTypeForPostgresType({
      pgType: 'audit.account_status[]',
      pgTypeName: '_account_status',
      pgTypeSchema: 'audit',
    }),
    'readonly AuditAccountStatus[]'
  )

  assert.equal(typeScriptParameterTypeForPostgresType(pgCatalog('jsonb[]', '_jsonb')), 'readonly DbJsonInput[]')
  assert.equal(
    typeScriptParameterTypeForPostgresType(pgCatalog('bigint[]', '_int8')),
    'readonly (bigint | number | string)[]'
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

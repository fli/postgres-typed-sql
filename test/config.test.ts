import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveConfig, type PostgresTypedSqlConfig } from '../src/config.js'

test('config defaults to conservative scalars and rejects unknown profiles', () => {
  assert.equal(resolveConfig({ schema: 'schema.sql' }).scalarProfile, 'conservative')
  assert.throws(
    () =>
      resolveConfig({
        scalarProfile: 'custom-driver' as PostgresTypedSqlConfig['scalarProfile'],
        schema: 'schema.sql',
      }),
    /Unsupported scalar profile "custom-driver"/u
  )
})

import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveConfig, type PostgresTypedSqlConfig } from '../src/config.js'

test('config defaults to conservative scalars and rejects unknown profiles', () => {
  const resolved = resolveConfig({ schema: 'schema.sql' })
  assert.equal(resolved.scalarProfile, 'conservative')
  assert.deepEqual(resolved.naming, {
    resultColumns: 'preserve',
    structuredJsonFields: 'preserve',
  })
  assert.throws(
    () =>
      resolveConfig({
        scalarProfile: 'custom-driver' as PostgresTypedSqlConfig['scalarProfile'],
        schema: 'schema.sql',
      }),
    /Unsupported scalar profile "custom-driver"/u
  )
})

test('config resolves and validates generated output naming', () => {
  assert.deepEqual(
    resolveConfig({
      naming: {
        resultColumns: 'camelCase',
        structuredJsonFields: 'camelCase',
      },
      schema: 'schema.sql',
    }).naming,
    {
      resultColumns: 'camelCase',
      structuredJsonFields: 'camelCase',
    }
  )
  assert.throws(
    () =>
      resolveConfig({
        naming: {
          resultColumns: 'pascalCase' as 'camelCase',
        },
        schema: 'schema.sql',
      }),
    /Unsupported result-column naming "pascalCase"/u
  )
  assert.throws(
    () =>
      resolveConfig({
        naming: {
          structuredJsonFields: 'snakeCase' as 'camelCase',
        },
        schema: 'schema.sql',
      }),
    /Unsupported structured-JSON field naming "snakeCase"/u
  )
})

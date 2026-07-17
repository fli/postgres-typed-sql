import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveConfig as resolveConfigBase, type PostgresTypedSqlConfig } from '../src/config.js'

const testImports = {
  runtime: 'postgres-typed-sql/runtime',
  scalars: 'postgres-typed-sql/scalars',
} as const

function resolveConfig(
  config: Omit<PostgresTypedSqlConfig, 'imports'> & { imports?: PostgresTypedSqlConfig['imports'] }
) {
  return resolveConfigBase({ ...config, imports: config.imports ?? testImports })
}

test('config requires exact generated-code imports and rejects the removed package prefix', () => {
  assert.throws(
    () => resolveConfigBase({ schema: 'schema.sql' } as PostgresTypedSqlConfig),
    /imports option is required/u
  )
  assert.throws(
    () => resolveConfig({ imports: { runtime: '', scalars: 'postgres-typed-sql/scalars' }, schema: 'schema.sql' }),
    /imports\.runtime must be a non-empty module specifier/u
  )
  assert.throws(
    () => resolveConfig({ imports: { runtime: 'postgres-typed-sql/runtime', scalars: ' ' }, schema: 'schema.sql' }),
    /imports\.scalars must be a non-empty module specifier/u
  )
  assert.throws(
    () =>
      resolveConfigBase({
        imports: testImports,
        packageImport: '@example/db',
        schema: 'schema.sql',
      } as PostgresTypedSqlConfig),
    /packageImport is no longer supported/u
  )
})

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

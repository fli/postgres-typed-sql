import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveConfig as resolveConfigBase } from '../src/config.js'

const resolveConfig = resolveConfigBase

test('config defaults generated imports and permits independent overrides', () => {
  const defaults = resolveConfig({ schema: 'schema.sql' })
  assert.deepEqual(defaults.imports, {
    runtime: 'postgres-typed-sql/runtime',
    scalars: 'postgres-typed-sql/values',
  })
  assert.deepEqual(resolveConfig({ schema: 'schema.sql', imports: { runtime: '@example/runtime' } }).imports, {
    runtime: '@example/runtime',
    scalars: 'postgres-typed-sql/values',
  })
  assert.deepEqual(resolveConfig({ schema: 'schema.sql', imports: { scalars: '@example/values' } }).imports, {
    runtime: 'postgres-typed-sql/runtime',
    scalars: '@example/values',
  })
  assert.deepEqual(defaults.naming, {
    parameterProperties: 'camelCase',
    resultColumns: 'preserve',
    structuredJsonFields: 'preserve',
  })
  assert.throws(
    () => resolveConfig({ schema: 'schema.sql', imports: { runtime: '' } }),
    /imports\.runtime must be a non-empty module specifier/u
  )
  assert.throws(
    () => resolveConfig({ schema: 'schema.sql', imports: { scalars: ' ' } }),
    /imports\.scalars must be a non-empty module specifier/u
  )
})

test('removed config options fail with migration guidance even for JavaScript callers', () => {
  for (const [option, value, message] of [
    ['packageImport', '@example/db', /packageImport is no longer supported/u],
    ['scalarProfile', 'node-postgres', /scalarProfile is no longer supported.*lossless model/u],
    ['codecProfile', 'node-postgres', /codecProfile is no longer supported.*application code/u],
    [
      'codecProfile',
      { name: 'custom', extends: 'node-postgres' },
      /codecProfile is no longer supported.*application code/u,
    ],
    ['codecProfile', undefined, /codecProfile is no longer supported/u],
  ] as const) {
    assert.throws(() => resolveConfig({ schema: 'schema.sql', [option]: value }), message)
  }
})

test('config resolves and validates generated output naming', () => {
  assert.deepEqual(
    resolveConfig({
      naming: {
        parameterProperties: 'preserve',
        resultColumns: 'camelCase',
        structuredJsonFields: 'camelCase',
      },
      schema: 'schema.sql',
    }).naming,
    {
      parameterProperties: 'preserve',
      resultColumns: 'camelCase',
      structuredJsonFields: 'camelCase',
    }
  )
  assert.throws(
    () =>
      resolveConfig({
        naming: {
          parameterProperties: 'pascalCase' as 'camelCase',
        },
        schema: 'schema.sql',
      }),
    /Unsupported parameter-property naming "pascalCase"/u
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

test('JSONB contract reserves kind for the generated discriminator', () => {
  assert.throws(
    () =>
      resolveConfig({
        schema: 'schema.sql',
        jsonbFunctionContracts: [
          {
            schema: 'public',
            name: 'checkout',
            argumentTypes: [],
            variants: { ready: { kind: 'string' }, unavailable: {} },
          },
        ],
      }),
    /variant cannot declare kind/u
  )
})

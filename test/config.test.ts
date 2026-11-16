import assert from 'node:assert/strict'
import test from 'node:test'

import { jsonbContractProjectionPaths, resolveConfig as resolveConfigBase } from '../src/config.js'

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

test('JSONB contracts accept one root shape and discover nested projections', async () => {
  const { jsonbContractProjectionPaths } = await import('../src/config.js')
  const contracts = resolveConfig({
    schema: 'schema.sql',
    jsonbFunctionContracts: [
      {
        schema: 'public',
        name: 'checkout',
        argumentTypes: [],
        returns: { object: { item: { optional: { array: { projection: 'item.typed.sql' } } } } },
        allowJsonNull: true,
      },
    ],
  }).jsonbFunctionContracts
  assert.deepEqual(jsonbContractProjectionPaths(contracts), ['item.typed.sql'])
})

test('JSONB contracts require exactly one contract form', () => {
  const base = { schema: 'public', name: 'checkout', argumentTypes: [] }
  // @ts-expect-error A contract requires a return shape or variants.
  const neither: import('../src/config.js').JsonbFunctionContract = base
  // @ts-expect-error Contract forms are exclusive.
  const both: import('../src/config.js').JsonbFunctionContract = {
    ...base,
    returns: 'string',
    variants: { a: {}, b: {} },
  }
  for (const contract of [neither, both]) {
    assert.throws(() => resolveConfig({ schema: 'schema.sql', jsonbFunctionContracts: [contract] }), /exactly one/u)
  }
  assert.throws(
    () => resolveConfig({ schema: 'schema.sql', jsonbFunctionContracts: [{ ...base, variants: { only: {} } }] }),
    /at least two variants/u
  )
  assert.throws(
    () =>
      resolveConfig({
        schema: 'schema.sql',
        jsonbFunctionContracts: [{ ...base, returns: { projection: 'bad.sql' } }],
      }),
    /must name a .typed.sql file/u
  )
})

test('nested variants validate branches, depth, and projection discovery', () => {
  const resolveUntypedConfig = (config: unknown) => resolveConfig(config as Parameters<typeof resolveConfig>[0])
  const base = { schema: 'public', name: 'f', argumentTypes: [] } as const
  const variants = {
    a: { item: { projection: 'one.typed.sql' } },
    b: { item: { optional: { projection: 'two.typed.sql' } } },
  } as const
  const resolved = resolveConfig({
    schema: 'schema.sql',
    jsonbFunctionContracts: [
      { ...base, returns: { object: { x: { array: { nullable: { variants } } }, y: { variants } } } },
      { ...base, variants: { a: { nested: { variants } }, b: {} } },
    ],
  })
  assert.deepEqual(jsonbContractProjectionPaths(resolved.jsonbFunctionContracts), ['one.typed.sql', 'two.typed.sql'])
  for (const invalid of [
    { variants: {} },
    { variants: { a: {} } },
    { variants: { a: { kind: 'string' }, b: {} } },
    { variants: { a: {}, b: null } },
    { variants: { a: {}, b: {} }, array: 'string' },
  ]) {
    assert.throws(() =>
      resolveUntypedConfig({
        schema: 'schema.sql',
        jsonbFunctionContracts: [{ ...base, returns: invalid }],
      })
    )
  }
  let shape: unknown = 'string'
  for (let i = 0; i < 100; i++) shape = { array: shape }
  const parse = (value: unknown) =>
    resolveUntypedConfig({
      schema: 'schema.sql',
      jsonbFunctionContracts: [{ ...base, returns: value }],
    })
  assert.doesNotThrow(() => parse(shape))
  let nested: unknown = { variants: { a: { field: 'string' }, b: {} } }
  for (let i = 0; i < 99; i++) nested = { array: nested }
  assert.doesNotThrow(() => parse(nested))
  assert.throws(() => parse({ array: nested }), /too deeply nested/u)
  assert.doesNotThrow(() =>
    resolveUntypedConfig({
      schema: 'schema.sql',
      jsonbFunctionContracts: [{ ...base, variants: { a: { field: shape }, b: {} } }],
    })
  )
  assert.throws(() => parse({ variants: { a: { field: shape }, b: {} } }), /too deeply nested/u)
})

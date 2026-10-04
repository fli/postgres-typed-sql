/* eslint-disable @typescript-eslint/no-require-imports, no-undef -- This packed-consumer proof deliberately exercises CommonJS export resolution. */

const assert = require('node:assert/strict')

const runtime = require('postgres-typed-sql/runtime')
assert.equal(
  Object.keys(require.cache).some((path) =>
    /postgres-typed-sql\/dist\/(?:engine|generator|generation-analysis)\.js$/u.test(path)
  ),
  false
)
const packageApi = require('postgres-typed-sql')
const nodePostgresAdapter = require('postgres-typed-sql/adapters/node-postgres')
const scalars = require('postgres-typed-sql/scalars')

assert.equal(typeof packageApi.generateTypedSql, 'function')
assert.equal(packageApi.generationAnalysisVersion, 2)
assert.equal('generationAnalysisVersion' in runtime, false)
assert.equal(typeof runtime.createTypedSqlStatement, 'function')
assert.equal(typeof nodePostgresAdapter.executeTypedSql, 'function')
assert.equal(typeof scalars, 'object')

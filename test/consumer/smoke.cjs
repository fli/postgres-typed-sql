/* eslint-disable @typescript-eslint/no-require-imports, no-undef -- This packed-consumer proof deliberately exercises CommonJS export resolution. */

const assert = require('node:assert/strict')

const packageApi = require('postgres-typed-sql')
const runtime = require('postgres-typed-sql/runtime')
const nodePostgresAdapter = require('postgres-typed-sql/adapters/node-postgres')
const scalars = require('postgres-typed-sql/scalars')

assert.equal(typeof packageApi.generateTypedSql, 'function')
assert.equal(typeof runtime.createTypedSqlStatement, 'function')
assert.equal(typeof nodePostgresAdapter.executeTypedSql, 'function')
assert.equal(typeof scalars, 'object')

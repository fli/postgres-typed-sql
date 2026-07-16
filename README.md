# Postgres Typed SQL

Postgres Typed SQL generates TypeScript statements from SQL by asking an embedded PostgreSQL engine to perform parse analysis and query rewriting against your real schema.

The package does not approximate PostgreSQL semantics with a separate parser. It bundles PostgreSQL 18.3 through a custom PGlite build and fails when a schema requires an unsupported database feature or extension.

## Status

The `0.1.x` line is a public beta. Its compatibility contract is deliberately narrow:

- Node.js 20.19 or newer
- PostgreSQL 18.3 analysis semantics
- local schema SQL files
- no connection to a hosted or production database
- no native compilation or lifecycle scripts during installation
- no fallback analyzer

Supported extensions are `btree_gin`, `btree_gist`, `pg_trgm`, `pgcrypto`, `plpgsql`, and `uuid-ossp`.

## Install

```sh
npm install --save-dev postgres-typed-sql
```

Create `postgres-typed-sql.config.mjs`:

```js
import { defineConfig } from 'postgres-typed-sql'

export default defineConfig({
  schema: './db/schema.sql',
  include: ['./src'],
  extensions: ['pgcrypto'],
  scalarProfile: 'node-postgres',
})
```

Add a script:

```json
{
  "scripts": {
    "generate:sql": "postgres-typed-sql generate"
  }
}
```

## Write SQL

Files ending in `.typed.sql` are generated next to their source. Named parameters use `:name` syntax:

```sql
-- src/queries/find-account-by-email.typed.sql
-- @param email text
select id, email, display_name
from public.accounts
where email = :email
```

Inside PostgreSQL expression subscripts, an unparenthesized top-level colon remains the native array-slice delimiter. Use `items[(:index)]` for a named subscript, and use `items[1 : :upper]` or `items[1:(:upper)]` for a named slice bound. `ARRAY[:value]` continues to treat `:value` as a named parameter because `ARRAY[...]` is an array constructor rather than a subscript.

Running `npm run generate:sql` creates `find-account-by-email.typed-sql.ts` containing:

- parameter and result-row interfaces
- PostgreSQL types and nullability
- inferred row cardinality and its proof
- read/write classification
- stable parameter ordering
- the compiled `$1`, `$2`, … SQL text
- metadata for runtime row mapping

The generated statement can be passed directly to a driver that accepts PostgreSQL query configuration objects:

```ts
import type { TypedSqlRawRow } from 'postgres-typed-sql/runtime'

const result = await client.query<TypedSqlRawRow>(findAccountByEmail.query({ email }))
```

Direct driver execution returns driver-defined raw object rows whose scalar values should be treated as `unknown`, because `query()` controls neither row construction nor scalar parsers. The node-postgres result-row generic is not inferred from a query configuration object, so a direct unannotated `client.query(statement.query(params))` call defaults to `any`; pass `TypedSqlRawRow` explicitly as shown above. The optional runtime helpers under `postgres-typed-sql/runtime` instead request array rows, map them by result-column position, enforce `one`, `optional`, and `many` result shapes, and return the generated row type selected by the configured scalar profile. Positional mapping preserves every unique PostgreSQL result name safely, including names such as `__proto__` that object-row construction cannot represent reliably.

## Scalar profiles

Drivers choose how PostgreSQL values become JavaScript values, and applications can replace those parsers. Postgres Typed SQL therefore does not claim one universal decoded scalar type.

The default `conservative` profile emits `unknown` for parameter and result scalar values. It is safe when the generator does not know the driver's conversion rules.

Set `scalarProfile: 'node-postgres'` only when execution uses the `pg-types` 2.2.0 default text-parser contract used by the supported node-postgres 8.x releases. This profile models parsed JSON, JavaScript numbers for the built-in integer and floating-point parsers, structural objects for `point`, `circle`, and `interval`, strings for scalar `bigint` and `numeric` values, and `Date | number` for `date`/`timestamp`/`timestamptz` because PostgreSQL infinity values decode to numeric infinities. In contrast to scalar `numeric`, the registered `numeric[]` parser applies `parseFloat` to each non-NULL element, so generated `numeric[]` results contain JavaScript numbers and can lose decimal precision. Registered built-in array results use a recursive `PgArray<T>` type that includes multidimensional arrays and SQL `NULL` elements. Unregistered result OIDs—including user-defined enum and domain arrays, composites, and ranges—use node-postgres's raw-string fallback; scalar enums are narrowed to their database labels. PostgreSQL reports scalar domains using their recursively resolved base result type, so a domain over `integer` is a number while a domain over `integer[]` uses the registered array parser. Comma-delimited array parameters use `PgArrayParameter<T> | string`: the array form accepts one-dimensional JavaScript arrays and SQL `NULL` elements, while a serialized PostgreSQL array-literal string is the escape hatch for valid multidimensional values. Nested JavaScript arrays are excluded because TypeScript cannot prove that their dimensions are rectangular or rule out `NULL` subarrays. Non-comma-delimited arrays use serialized strings, domains over arrays use one serialized string per outer element, and `bytea[]` elements use `PgByteaHexString` for compatibility across supported node-postgres 8.x releases. Interval objects and temporal infinity numbers can be passed back as parameters. Root `json`/`jsonb` parameters follow node-postgres serialization: objects are JSON-stringified, while JSON arrays, JSON strings, and JSON null should be supplied as serialized JSON text because root JavaScript arrays and `null` mean PostgreSQL arrays and SQL `NULL`. If the application installs custom type parsers, uses binary result mode, or uses a node-postgres release with a different default parser table, use the conservative profile unless those parser results still match the generated contract.

## Directives

Directives are SQL comments at the beginning of a `.typed.sql` file:

```sql
-- @name findAccount
-- @access read
-- @param email text
-- @param display_name text?
-- @column id bigint
```

- `@name` overrides the lower-camel-case name derived from the filename.
- `@access` can explicitly declare `read` or `write`.
- `@param` provides a PostgreSQL type when PostgreSQL cannot infer one. A trailing `?` permits a nullable input when NULL admission is otherwise unknown; generation rejects it when PostgreSQL proves that the parameter type, an evaluated use, or a DML target rejects NULL.
- `@column` asserts that a result column exists and optionally asserts its PostgreSQL type.

PostgreSQL still performs the authoritative parse, name resolution, type inference, rewriting, function/operator resolution, and catalog lookup.

## Schema input

Schema files are executed in order inside a new in-memory database for each generation. They should contain plain PostgreSQL SQL. `pg_dump` guard lines such as `\\restrict` and `\\unrestrict` are accepted; other `psql` meta-commands are rejected.

For fidelity, generate from the same canonical schema artifact used by deployment. Include tables, views, types, domains, functions, constraints, indexes, and extensions that affect query analysis.

## Compatibility

PostgreSQL major versions and extensions can change analysis results. Version `0.1.x` makes no compatibility claim for PostgreSQL 17 or earlier, future PostgreSQL releases, or extensions outside the supported list. Unsupported configurations produce an error instead of falling back to approximate types.

## Programmatic API

```ts
import { generateTypedSql } from 'postgres-typed-sql'

const result = await generateTypedSql({
  rootDir: process.cwd(),
  schema: ['./db/base.sql', './db/functions.sql'],
  include: ['./src'],
})
```

Generation is intentionally single-flight within one Node.js process because each run owns an isolated PostgreSQL instance.

## Security

Schema SQL is executable code. Only generate from schema files you trust. The embedded database is local and in-memory, but SQL functions and extension behavior should still be treated as code execution within the generator process.

See [SECURITY.md](./SECURITY.md) for reporting instructions.

## License

MIT. Published packages also include the PGlite and PostgreSQL license texts for the bundled engine.

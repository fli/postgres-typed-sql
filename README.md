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
const result = await client.query(findAccountByEmail.query({ email }))
```

Direct driver execution returns raw rows: SQL column names are preserved, but scalar values are typed as `unknown` because `query()` does not control a driver's parsers. The optional runtime helpers under `postgres-typed-sql/runtime` enforce `one`, `optional`, and `many` result shapes and return the generated row type selected by the configured scalar profile.

## Scalar profiles

Drivers choose how PostgreSQL values become JavaScript values, and applications can replace those parsers. Postgres Typed SQL therefore does not claim one universal decoded scalar type.

The default `conservative` profile emits `unknown` for parameter and result scalar values. It is safe when the generator does not know the driver's conversion rules.

Set `scalarProfile: 'node-postgres'` only when execution uses the default `node-postgres` conversion behavior. This profile models documented conversions such as parsed JSON, JavaScript `Date` values for `date`/`timestamp`/`timestamptz`, JavaScript numbers for the built-in integer and floating-point parsers, and strings for `bigint` and `numeric`. Types without a stable modeled default remain `unknown`. If the application installs custom type parsers, use the conservative profile unless those parser results still match the generated contract.

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
- `@param` provides a PostgreSQL type when PostgreSQL cannot infer one. A trailing `?` marks a nullable input.
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

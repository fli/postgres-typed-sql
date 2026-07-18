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
npm install postgres-typed-sql
```

Create `postgres-typed-sql.config.mjs`:

```js
import { defineConfig } from 'postgres-typed-sql'

export default defineConfig({
  schema: './db/schema.sql',
  include: ['./src'],
  imports: {
    runtime: 'postgres-typed-sql/runtime',
    scalars: 'postgres-typed-sql/scalars',
  },
  extensions: ['pgcrypto'],
  codecProfile: 'node-postgres',
  naming: {
    parameterProperties: 'camelCase',
    resultColumns: 'camelCase',
    structuredJsonFields: 'camelCase',
  },
})
```

`imports` is required because generated statements have a runtime value dependency and a type-only scalar-support dependency. One generation invocation uses the same two exact module specifiers for every output; workspaces that publish different generated-code façades should use separate configurations. The configured modules are two addresses within the ABI owned by this generator version: `runtime` must export `createTypedSqlStatement`, and `scalars` must export the scalar bindings used by the selected profile. No package suffixes are inferred.

The generated catalog defaults to `postgres-typed-sql.types.ts` and can be relocated with `typesOutput`. Statement files do not import that artifact: enum labels and supported CHECK-constraint refinements are rendered directly into their parameter, result, and structured-JSON types. The catalog remains available as a standalone database model for application code that needs it.

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

Named parameter tokens retain their exact spelling for SQL compilation, `@param` directives, diagnostics, and runtime metadata. Generated parameter-object properties are application-facing and use conservative camel case by default, so `:platform_slug` is supplied as `{ platformSlug }`. Repeated uses of one raw token still share one positional placeholder and one public property. Set `naming.parameterProperties` to `'preserve'` only when callers deliberately use the raw token spelling.

Inside PostgreSQL expression subscripts, an unparenthesized top-level colon remains the native array-slice delimiter. Use `items[(:index)]` for a named subscript, and use `items[1 : :upper]` or `items[1:(:upper)]` for a named slice bound. `ARRAY[:value]` continues to treat `:value` as a named parameter because `ARRAY[...]` is an array constructor rather than a subscript.

Running `npm run generate:sql` creates `find-account-by-email.typed-sql.ts` containing:

- parameter and result-row interfaces
- PostgreSQL types and nullability
- a conservative row contract and the analyzer's canonical row bounds
- conservative read/write execution routing
- stable parameter ordering
- the compiled `$1`, `$2`, … SQL text
- metadata for runtime row mapping

The generated statement can be passed directly to a driver that accepts PostgreSQL query configuration objects:

```ts
import type { TypedSqlRawRow } from 'postgres-typed-sql/runtime'

const result = await client.query<TypedSqlRawRow>(findAccountByEmail.query({ email }))
```

Direct driver execution returns driver-defined raw object rows whose scalar values should be treated as `unknown`, because `query()` controls neither row construction nor scalar parsers. The node-postgres result-row generic is not inferred from a query configuration object, so a direct unannotated `client.query(statement.query(params))` call defaults to `any`; pass `TypedSqlRawRow` explicitly as shown above.

The core runtime is driver-neutral. It owns statement construction, named-parameter ordering, result metadata, positional/object row mapping, structured-JSON mapping, and affected-row-count normalization. Driver query options and execution live in adapters. For node-postgres:

```ts
import { executeTypedSqlOptional } from 'postgres-typed-sql/adapters/node-postgres'

const account = await executeTypedSqlOptional(client, findAccountByEmail, { email })
```

The node-postgres adapter requests array rows for generated statements, maps them by result-column position, enforces `one`, `optional`, and `many` result shapes, and returns the generated row type selected by the configured codec profile. Positional mapping preserves every unique PostgreSQL result name safely, including names such as `__proto__` that object-row construction cannot represent reliably. Other drivers can consume statement `text`, `values(params)`, `columns`, and `resultRowMapping` and use the core mapping functions without importing any node-postgres contract.

## Generated property naming

Postgres Typed SQL uses application-facing camel-case parameter properties by default while preserving PostgreSQL result and JSON field names by default. Configure the three boundaries independently:

```js
export default defineConfig({
  schema: './db/schema.sql',
  imports: {
    runtime: 'postgres-typed-sql/runtime',
    scalars: 'postgres-typed-sql/scalars',
  },
  codecProfile: 'node-postgres',
  naming: {
    parameterProperties: 'camelCase',
    resultColumns: 'camelCase',
    structuredJsonFields: 'camelCase',
  },
})
```

For example, the raw token `:account_id` is compiled to a positional placeholder but exposed to callers as `accountId`. Parameter metadata retains `name: 'account_id'` and records `propertyName: 'accountId'`; runtime `parameterNames` and `values(params)` lookup use only the public `accountId` property. `@param account_id ...` remains keyed by the raw token.

For result values, a PostgreSQL column `account_id` becomes the mapped row property `accountId`. A modeled JSON value such as `jsonb_build_object('display_name', display_name)` exposes `displayName`. The structured JSON policy applies recursively through inferred objects, arrays, unions, `json_agg`/`jsonb_agg`, and JSON object or array projections from derived subqueries. Opaque JSON values—including selected JSON columns and dynamically keyed objects—are not traversed, so their internal keys and object identity are preserved.

Naming is deterministic and conservative: conventional lower-snake-case identifiers are camel-cased, already camel-case names stay unchanged, and unusual names such as `URL`, `__proto__`, leading or repeated underscores, spaces, and hyphens are preserved. Generation rejects parameter, result, or modeled JSON properties that collide after transformation. Parameter collisions must be resolved by choosing distinct SQL tokens or explicitly selecting `'preserve'`; they never fall back, receive suffixes, or overwrite one another.

The generated row type describes mapped execution through the node-postgres adapter's `executeTypedSql`, `executeTypedSqlOne`, and `executeTypedSqlOptional`. Direct `client.query(statement.query(params))` execution remains raw and returns driver/PostgreSQL result names because the driver constructs those object rows. Parameter-object lookup still uses the generated public property names. Generated catalog types and opaque JSON contents are unaffected.

Structured JSON field naming requires a codec profile with `structuredJson: true` when a query needs a nested mapping, because the runtime must know that `json` and `jsonb` values are decoded into JavaScript objects and arrays. The built-in `node-postgres` profile provides this capability.

## Codec profiles

Drivers choose how PostgreSQL values become JavaScript values, and applications can replace those parsers. Postgres Typed SQL therefore does not claim one universal decoded scalar type.

The default `conservative` profile emits `unknown` for parameter and result scalar values. It is safe when the generator does not know the driver's conversion rules.

Set `codecProfile: 'node-postgres'` only when execution uses the `pg-types` 2.2.0 default text-parser contract used by the supported node-postgres 8.x releases. This profile models parsed JSON, JavaScript numbers for the built-in integer and floating-point parsers, structural objects for `point`, `circle`, and `interval`, strings for scalar `bigint` and `numeric` values, and `Date | number` for `date`/`timestamp`/`timestamptz` because PostgreSQL infinity values decode to numeric infinities. In contrast to scalar `numeric`, the registered `numeric[]` parser applies `parseFloat` to each non-NULL element, so generated `numeric[]` results contain JavaScript numbers and can lose decimal precision. Registered built-in array results use a recursive `PgArray<T>` type that includes multidimensional arrays and SQL `NULL` elements. Unregistered result OIDs—including user-defined enum and domain arrays, composites, and ranges—use node-postgres's raw-string fallback; scalar enums are narrowed to their database labels. PostgreSQL reports scalar domains using their recursively resolved base result type, so a domain over `integer` is a number while a domain over `integer[]` uses the registered array parser. Comma-delimited array parameters use `PgArrayParameter<T> | string`: the array form accepts one-dimensional JavaScript arrays and SQL `NULL` elements, while a serialized PostgreSQL array-literal string is the escape hatch for valid multidimensional values. Nested JavaScript arrays are excluded because TypeScript cannot prove that their dimensions are rectangular or rule out `NULL` subarrays. Non-comma-delimited arrays use serialized strings, domains over arrays use one serialized string per outer element, and `bytea[]` elements use `PgByteaHexString` for compatibility across supported node-postgres 8.x releases. Interval objects and temporal infinity numbers can be passed back as parameters. Root `json`/`jsonb` parameters follow node-postgres serialization: objects are JSON-stringified, while JSON arrays, JSON strings, and JSON null should be supplied as serialized JSON text because root JavaScript arrays and `null` mean PostgreSQL arrays and SQL `NULL`. If the application installs custom type parsers, uses binary result mode, or uses a node-postgres release with a different default parser table, use the conservative profile unless those parser results still match the generated contract.

### Custom codecs and OIDs

Applications can extend either built-in profile. A profile has a stable `name`, an `extends` fallback, and independent hooks for result decoding, parameter encoding, and scalar values nested inside PostgreSQL JSON conversion:

```ts
import {
  defineConfig,
  definePostgresCodecProfile,
  postgresResultTypesByOid,
  postgresTypeScriptType,
} from 'postgres-typed-sql'

const moneyOid = 81_234
const moneyArrayOid = 81_235

const applicationCodecs = definePostgresCodecProfile({
  name: 'application-codecs-v1',
  extends: 'node-postgres',

  resultType: postgresResultTypesByOid({
    [moneyOid]: postgresTypeScriptType('Money', { scalarImports: ['Money'] }),
    [moneyArrayOid]: postgresTypeScriptType('PgArray<Money>', {
      scalarImports: ['Money', 'PgArray'],
    }),
  }),

  parameterType({ type }, fallback) {
    return type.pgTypeSchema === 'billing' && type.pgTypeName === 'money'
      ? postgresTypeScriptType('MoneyInput', { scalarImports: ['MoneyInput'] })
      : fallback()
  },

  jsonScalarType({ type }, fallback) {
    return type.pgTypeSchema === 'billing' && type.pgTypeName === 'money'
      ? postgresTypeScriptType('MoneyJson', { scalarImports: ['MoneyJson'] })
      : fallback()
  },
})

export default defineConfig({
  codecProfile: applicationCodecs,
  // schema, include, and imports omitted
})
```

Every hook must either return `postgresTypeScriptType(...)` or call its `fallback`. Names listed in `scalarImports` are emitted as type-only imports from `imports.scalars`, so the configured scalar façade must export them. `ambientBindings` is available for global TypeScript names such as `Date` and `Uint8Array`.

Result OIDs are intentionally exact. Registering a custom parser for scalar OID `81_234` says nothing about array OID `81_235`; node-postgres can register and invoke those parsers independently. Define both entries when both runtime parsers are installed. Parameter hooks are different: the node-postgres fallback recursively asks the active custom profile for array element input types because JavaScript array parameters are serialized element by element. JSON hooks describe values after PostgreSQL has converted them into JSON, which is a third representation boundary and should not be inferred from either the result or parameter hook.

OID matching is ideal when the runtime parser registration is itself keyed by OID. For extension or application types whose OIDs vary between databases, hooks can instead match `pgTypeSchema` and `pgTypeName`. A result hook receives both `declaredType` and `decoderType`: `declaredType` preserves the SQL expression's domain identity, while `decoderType` reflects PostgreSQL text-protocol domain flattening. Generated statement and catalog headers record the resolved profile name so checked-in output makes its decoder contract visible.

A profile that decodes `json`/`jsonb` into traversable objects and arrays may set `structuredJson: true`. If it does, provide `opaqueJsonType` when the inherited opaque type is not accurate. `supportsStringLiteralRefinement` can additionally enable or disable enum, CHECK-constraint, and exact JSON-string refinements when a custom conversion preserves—or changes—their textual representation.

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
- `@access` can explicitly declare `read` or `write`. `read` is an assertion that analysis can prove read-only-compatible execution; it is not a trust override. `write` selects the conservative write execution route and does not necessarily claim that the statement mutates data.
- `@param` provides a PostgreSQL type when PostgreSQL cannot infer one. A trailing `?` permits a nullable input when NULL admission is otherwise unknown; generation rejects it when PostgreSQL proves that the parameter type, an evaluated use, or a DML target rejects NULL.
- `@column` asserts that a result column exists and optionally asserts its PostgreSQL type.

PostgreSQL still performs the authoritative parse, name resolution, type inference, rewriting, function/operator resolution, and catalog lookup.

Generated cardinality is derived from the analyzer's row bounds. A `rowBounds.max` value of `null` means that analysis proved no finite upper bound, not that execution is known to produce multiple rows; the public contract remains conservatively `many`.

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

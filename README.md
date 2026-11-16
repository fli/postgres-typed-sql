# Postgres Typed SQL

Generate TypeScript queries using embedded PostgreSQL analysis, then execute them through a lossless, driver-independent runtime.

```sh
npm install postgres-typed-sql
```

Create `postgres-typed-sql.config.mjs`:

```js
import { defineConfig } from 'postgres-typed-sql'

export default defineConfig({ schema: './schema.sql', include: ['./src'] })
```

Write queries in `*.typed.sql` files with `:named` parameters, then generate:

```sh
npx postgres-typed-sql generate
```

Execute a generated query with a caller-owned, configured client or pool:

```ts
import { nodePostgres } from 'postgres-typed-sql/adapters/node-postgres'
import findAccount from './findAccount.typed-sql.js'

const db = nodePostgres({ pool })
const account = await findAccount(db, { email: 'reader@example.com' })
```

The node-postgres adapter sends one application query per execution. Configure every client or
pool connection with UTF8 client encoding, `DateStyle=ISO,YMD`, `IntervalStyle=postgres`,
`TimeZone=UTC`, `bytea_output=hex`, and `extra_float_digits=3`. Use a schema and search path
compatible with the ones used to generate the statements. The adapter does not verify session
settings or database types. Incompatible settings or schema changes can cause incorrect values
or decoding errors.

If you implement a custom transport with `createPostgresExecutor`, use `request.columnNames`
in place of `request.columns`. Check the actual field count, names, order, and text format even
when the result has no rows. Return `{ rows, rowCount }` with positional raw text or SQL NULL
values. Remove any use of `request.parameters` and any returned `columnTypes`; the runtime now
uses the generated statement metadata to encode and decode values.

Install the driver in the application. Only load trusted schema and configuration files.

Direct imports and `openQueryProject()` can reuse catalog lookups within one analysis database. Set
`assumeStableAnalysisCatalog: true` in the SQL config only if analyzing statements leaves the catalog
and its name resolution stable for the session. This includes code reached during PostgreSQL parsing,
such as type input functions. Catalog contents, search path, and settings that affect catalog output
must stay stable. The default is `false`. The worker discards its database and catalog results after
an analysis error or when the project closes. Source text and native statement analysis still run
for each request.

### Declare nullable inputs

Parameters reject SQL NULL by default. `-- @nullable name` permits it only when analysis
proves that every modeled use accepts NULL. This includes a direct `INSERT ... SELECT`
whose `WHERE :name IS NOT NULL` condition prevents the insert when the input is NULL.

Use `-- @bindNull name` when the caller owns NULL admission, such as an optional argument
of a PL/pgSQL function whose body the analyzer cannot prove safe:

```sql
-- @bindNull acceptance_snapshot
select result
from public.reserve_paypal_checkout_approval(
  :public_id::uuid, :checkout_session_id::bigint, :environment::text,
  :client_id::text, :partner_merchant_id::text, :checkout_public_id::uuid,
  :acceptance_snapshot::jsonb
) as result
limit 1
```

Both declarations generate a required parameter property that accepts `null`.
`@bindNull` grants permission to bind SQL NULL; it does not establish that execution
will succeed. The analysis report keeps that permission separate from admission evidence.
No input CTE is needed. A plain `null` JSON parameter means SQL NULL; `json(null)`
means a non-null JSON document containing JSON null.

### Declare a JSONB function result

For an ordinary object, declare `returns` with an object shape or an existing query projection:

```js
{
  schema: 'public',
  name: 'reserve_paypal_checkout_approval',
  argumentTypes: ['uuid', 'int8', 'text', 'text', 'text', 'uuid', 'jsonb'],
  returns: { projection: 'apps/web/src/features/checkout/load-paypal-checkout-approval.typed.sql' },
}
```

`returns` accepts the same shape grammar as nested fields. Declare exactly one of
`returns` and `variants`. An ordinary object needs no discriminator.

When a PL/pgSQL function returns different JSONB objects, add a string `kind` field to each
outcome in SQL. For example, return `jsonb_build_object('kind', 'unavailable')` when there is no
checkout and `jsonb_build_object('kind', 'ready', 'session', locked, 'payment', payment, 'buyer', buyer)`
when it is ready.

Declare the function's result in `postgres-typed-sql.config.mjs`. Each key under `variants`
is a possible value of `kind`. The fields listed for that variant are required by default.

```js
import { defineConfig } from 'postgres-typed-sql'

export default defineConfig({
  schema: './schema.sql',
  jsonbFunctionContracts: [
    {
      schema: 'public',
      name: 'prepare_checkout_buyer_draft',
      argumentTypes: ['uuid', 'bytea'],
      variants: {
        unavailable: {},
        ready: {
          session: { object: { publicId: 'string', pricingDetails: 'json' } },
          payment: { object: { paymentStarted: 'boolean' } },
          buyer: { projection: 'apps/web/src/features/checkout/load-checkout-buyer-state.typed.sql' },
        },
      },
    },
  ],
})
```

Add the other fields the application reads to the contract. The keys in each object are the
wire names. Generated properties follow `naming.structuredJsonFields`. Unlisted fields are
preserved as generic JSON at runtime and aren't part of the generated TypeScript type.

`projection` names a typed SQL file relative to `rootDir`. Its selected columns define the
JSON object fields, their wire names, codecs, and nullability. Analysis uses the original
statement's result columns, so `UPDATE ... RETURNING` and data-modifying CTEs work as
projections without executing their writes. The generator tracks the file
as an input. Use `{ nullable: { projection: '...' } }` when the object itself may be null.
The function must produce the same object shape as the projection. The decoder checks it
when the function result is read.

Projection properties follow `naming.resultColumns`, matching the standalone query row.
JSON columns within a projection decode to `PgJson` documents with the same nested
interpretation as standalone results. Fields inside those documents follow
`naming.structuredJsonFields`. Ordinary contract object fields also use
`naming.structuredJsonFields`.

PostgreSQL serializes both a SQL NULL JSON column and a JSON-null document as JSON null
inside a row object. A nullable projected JSON column decodes that wire null to SQL `null`.
A nonnullable projected JSON column retains a `PgJson` document with `value: null`.
Use an explicit SQL discriminator if that original distinction is required. SQL arrays
lose lower bounds when converted to JSON, so their projected values retain the JSON
representation rather than pretending to recover a `PgArray`. Custom JSON casts also
retain their JSON representation. Reversible scalars, including bytea, bigint and
microsecond timestamps, use their standalone SQL value types.
Projected bytea remains a `Uint8Array`. If its bytes are edited, the enclosing document's
`source` reflects the edit through its generated codec, so subsequent JSON bindings send
the current bytes. Documents without bytea retain their original source text.

JSON parameters accept plain objects with `undefined` properties. Encoding omits those
properties recursively and preserves explicit `null`. An `undefined` array element or a
top-level `undefined` JSON input is invalid.

Use the function as a direct result expression in a typed SQL query:

```sql
select public.prepare_checkout_buyer_draft(
  :checkout_session_public_id::uuid,
  :browser_binding_token_hash::bytea
) as result
```

Regenerate the query, then branch on the decoded document's `value.kind`:

```ts
const { result } = await prepareCheckoutBuyerDraft(db, { checkoutSessionPublicId, browserBindingTokenHash })
if (result?.value.kind === 'ready') {
  const sessionId: string = result.value.session.publicId
  const paymentStarted: boolean = result.value.payment.paymentStarted
  const revision = BigInt(result.value.buyer.revision)
}
```

The contract targets one PostgreSQL function overload declared `RETURNS jsonb` or
`RETURNS SETOF jsonb`. Each returned document is checked independently. Direct target
calls and direct range-function outputs support contracts, including lateral calls,
aliases, ordinality, and transparent CTE or subquery forwarding.
Use exact catalog type names for its declared input types in order, including defaulted inputs.
A string names a type in `pg_catalog` (for example, `int4` for `integer`). Use
`{ schema: 'app', name: 'checkout_id' }` for a type in another schema. PostgreSQL chooses the
overload; calls without a matching contract use the existing inference rules. The contract only
applies to the direct result column. A SQL transformation such as `function_call(...) -> 'session'`
does not send the full document to the decoder and uses the existing inference rules.

Use `'string'`, `'boolean'`, `'number'`, `'int4'`, `'null'`, or `'json'` for leaf values.
`'number'` decodes a JSON number as an exact `PgFiniteDecimal`. `'int4'` accepts an integer
within PostgreSQL's 32-bit signed range and decodes it as a JavaScript number. `'json'` leaves
the subtree generic and preserves exact numbers. Use `{ object: { ... } }` for nested objects
and `{ array: 'string' }` for an array of a given shape.

A required field with `{ nullable: 'string' }` can contain JSON null but must be present.
`{ optional: { nullable: 'string' } }` also permits the field to be absent. SQL NULL produces
a null column. Add `allowJsonNull: true` to accept a JSON null document, which produces a
`PgJson` with `value: null`. An unknown tag, missing required field, or wrong value type
raises a `PgExecutionError` in the `decode` phase.

### Construct typed JSON fixtures

Every generated statement exposes `jsonCodecs` keyed by its JSON result properties.
Use the existing `json` or `parseJson` constructor with that codec before any database call:

For example, generate `image-dimensions.typed.sql` from:

```sql
select jsonb_build_object('width', 1600::int4, 'height', 900::int4) as dimensions
```

Then construct the document with native-number fields:

```ts
import { json } from 'postgres-typed-sql/values'
import { imageDimensions } from './image-dimensions.typed-sql.js'

const dimensions = json({ width: 1600, height: 900 }, imageDimensions.jsonCodecs.dimensions)
```

Supply all fields required by the generated shape. The codec checks the same field names,
scalar interpretations, variants and nullability as execution. Generic `json(value)` still
uses exact decimal values for JSON numbers; a generated codec can instead interpret an
inferred PostgreSQL int4 as a native number. Rebuild fixtures with their codec when values
change so `value`, `source`, and `codec` stay consistent. Nested `PgJson` documents are
accepted only where a generated projection codec declares a JSON column boundary.

See the [consumer migration examples](docs/consumer-contract-migration.md) for the four consumer changes.
See [native value migration](https://github.com/fli/postgres-typed-sql/blob/main/docs/native-value-migration.md)
for nullable scalar filters, exact string IDs, RPC integer boundaries, and passing
decoded PgJson values to domain parsers.

Use the code for API details:

- [Value types](src/value-types.ts) and [constructors](src/values.ts).
- [Execution](src/runtime.ts) and [node-postgres connection requirements](src/adapters/node-postgres.ts).
- [Configuration](src/config.ts), [direct-import integration](src/content-mapper.ts), and [esbuild integration](src/esbuild.ts).
- [Analysis report types](src/generation-analysis.ts) and [executable examples](test/consumer).

For development, run `pnpm setup:worktree`, `pnpm build:engine` when the native engine needs building, and `pnpm test:all`.

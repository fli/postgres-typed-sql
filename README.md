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

Install the driver in the application. Only load trusted schema and configuration files.

Direct imports and `openQueryProject()` can reuse catalog lookups within one analysis database. Set
`assumeStableAnalysisCatalog: true` in the SQL config only if analyzing statements leaves the catalog
and its name resolution stable for the session. This includes code reached during PostgreSQL parsing,
such as type input functions. Catalog contents, search path, and settings that affect catalog output
must stay stable. The default is `false`. The worker discards its database and catalog results after
an analysis error or when the project closes. Source text and native statement analysis still run
for each request.

### Declare a JSONB function result

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
          buyer: { object: { revision: 'string', buyerDraft: 'json', taxQuote: 'json' } },
        },
      },
    },
  ],
})
```

Add the other fields the application reads to the contract. The keys in each object are the
wire names. Generated properties follow `naming.structuredJsonFields`. Unlisted fields are
preserved as generic JSON at runtime and aren't part of the generated TypeScript type.

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

The contract targets one overload of a scalar PostgreSQL function declared `RETURNS jsonb`.
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

Use the code for API details:

- [Value types](src/value-types.ts) and [constructors](src/values.ts).
- [Execution](src/runtime.ts) and [node-postgres connection requirements](src/adapters/node-postgres.ts).
- [Configuration](src/config.ts), [direct-import integration](src/content-mapper.ts), and [esbuild integration](src/esbuild.ts).
- [Analysis report types](src/generation-analysis.ts) and [executable examples](test/consumer).

For development, run `pnpm setup:worktree`, `pnpm build:engine` when the native engine needs building, and `pnpm test:all`.

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

Use the code for API details:

- [Value types](src/value-types.ts) and [constructors](src/values.ts).
- [Execution](src/runtime.ts) and [node-postgres connection requirements](src/adapters/node-postgres.ts).
- [Configuration](src/config.ts), [direct-import integration](src/content-mapper.ts), and [esbuild integration](src/esbuild.ts).
- [Analysis report types](src/generation-analysis.ts) and [executable examples](test/consumer).

For development, run `pnpm setup:worktree`, `pnpm build:engine` when the native engine needs building, and `pnpm test:all`.

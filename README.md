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

Use the code for API details:

- [Value types](src/value-types.ts) and [constructors](src/values.ts).
- [Execution](src/runtime.ts) and [node-postgres connection requirements](src/adapters/node-postgres.ts).
- [Configuration](src/config.ts), [direct-import integration](src/content-mapper.ts), and [esbuild integration](src/esbuild.ts).
- [Analysis report types](src/generation-analysis.ts) and [executable examples](test/consumer).

For development, run `pnpm setup:worktree`, `pnpm build:engine` when the native engine needs building, and `pnpm test:all`.

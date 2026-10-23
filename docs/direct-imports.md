# Use direct SQL imports in a bundled Node application

This experimental workflow requires TypeScript 7.1.0-beta and esbuild 0.25 or later. It checks `.typed.sql` imports and bundles executable query modules without a generation command or generated siblings.

## Configure the project

Install the package and build tools.

```sh
npm install postgres-typed-sql@beta
npm install --save-dev typescript@7.1.0-beta esbuild
```

Create `postgres-typed-sql.config.mjs` beside your `tsconfig.json`.

```js
export default {
  schema: ['schema.sql'],
  codecProfile: 'node-postgres',
  imports: {
    runtime: 'postgres-typed-sql/adapters/node-postgres',
    scalars: 'postgres-typed-sql/scalars',
  },
}
```

Keep your existing codec profile if your driver has custom codecs. The default remains conservative when `codecProfile` is omitted.

Add the mapper at the top level of `tsconfig.json`.

```json
{
  "compilerOptions": {
    "strict": true,
    "noEmit": true,
    "module": "nodenext",
    "target": "es2023"
  },
  "contentMappers": [
    {
      "package": "postgres-typed-sql",
      "extensions": [".typed.sql"],
      "options": { "config": "./postgres-typed-sql.config.mjs" }
    }
  ]
}
```

The mapper resolves `options.config` relative to the effective tsconfig file. Its default is `postgres-typed-sql.config.mjs`. The SQL config directory is the default application root. A relative `rootDir` is resolved from that directory. Ordered schema paths resolve from the application root. The legacy CLI retains its existing path behavior.

## Import and check a query

Write `findWidget.typed.sql`.

```sql
select id, display_name from widget where id = :id
```

Import the SQL file directly from your application.

```ts
import findWidget from './findWidget.typed.sql'

const widget = await findWidget(client, { id: 1 })
```

Check with permission to run the mapper.

```sh
npx tsc --noEmit --runExternalCode
```

The mapper executes your configuration and the embedded PostgreSQL analyzer during checking. Use it with trusted projects. TypeScript reports SQL failures as diagnostics and consumes the current SQL buffer supplied by the host. SQL checking writes no generated modules or catalog file.

The default callable, named statement, exported type names, and execution semantics match generated modules. A direct driver call with `statement.query(params)` retains its existing raw-driver behavior. It does not apply the supplied-client adapter's result mapping.

## Bundle the application

Create `build.mjs`.

```js
import { build } from 'esbuild'
import { postgresTypedSql } from 'postgres-typed-sql/esbuild'

await build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/main.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  plugins: [postgresTypedSql({ config: './postgres-typed-sql.config.mjs' })],
})
```

Run `node build.mjs`. The adapter resolves its config path from the build script process's working directory. Relative runtime and scalar facade imports resolve from each original SQL file's directory. Esbuild transpiles the query module as TypeScript.

TypeScript does not emit executable SQL modules. Use the esbuild build API with this plugin for runtime output. The standalone esbuild transform API does not run plugins.

The bundle executes query descriptors through the existing runtime. Query imports in the bundle do not load schemas, evaluate configuration, or initialize the analyzer. Application code that explicitly imports generator APIs still includes those APIs.

## Refresh inputs

Each project owns a separate analysis process. Query work is serialized within that process. Reopening a mapper project or starting an esbuild build evaluates configuration in a fresh process. Closing a project rejects outstanding work and disposes its process. Analysis errors discard the database before the next query.

Configuration and helpers must use ESM. The mapper tracks the source actually loaded for file modules, including imported local helpers. CommonJS config dependencies are rejected. Saved schema and module-source changes invalidate the project. A transform rejects results when a captured input changes during analysis.

Use `configDependencies` for package manifests and other files read by configuration. Node does not expose every package-metadata read through its module hooks, so automatic module-source tracking does not cover these inputs. List every such file whose saved changes must refresh the project. Paths resolve from the SQL configuration module's directory.

```json
{
  "package": "postgres-typed-sql",
  "extensions": [".typed.sql"],
  "options": {
    "config": "./settings/config.mjs",
    "configDependencies": ["package.json", "node_modules/config-helper/package.json"]
  }
}
```

Pass the same dependency list to the build adapter.

```js
postgresTypedSql({
  config: './settings/config.mjs',
  configDependencies: ['package.json', 'node_modules/config-helper/package.json'],
})
```

This example watches the package scope and helper package beneath `settings/`. Include all manifests involved in `imports`, `exports`, or module-format selection. Unlisted package-metadata changes require restarting the tooling host.

Listed files are fingerprinted before configuration evaluation and checked around compilation. They do not form an atomic filesystem snapshot. Configuration and codec callbacks must be deterministic for the captured inputs.

Use a fixed, ordered schema file list. Glob inventories, directory enumeration, late dynamic imports in callbacks, inherited environment variables, package installations, and symbolic-link targets require restarting the tooling host after changes. Clear TypeScript incremental build information when changing inputs outside the watched set. Unsaved schema or config edits are not read.

Esbuild registers SQL and configuration dependencies for watching and closes the analysis process when the build context is disposed. In watch mode, SQL failures retain the dependency list so a correction can rebuild.

## Keep generation where it is still required

Code that imports `postgres-typed-sql.types.ts` still needs catalog generation. The complete version-2 generation-analysis report remains part of the existing generator API.

The initial direct-import workflow covers bundled ESM Node applications. It does not claim downstream library declarations, unbundled emission, or CommonJS direct SQL imports. Diagnostics currently identify the SQL file without precise ranges. SQL navigation and editor-specific behavior have not been validated.

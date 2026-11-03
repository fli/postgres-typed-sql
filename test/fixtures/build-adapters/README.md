# Build adapter fixture

Build the package first, including the staged engine. Copy this directory to a sibling directory before running these checks. The dev probes modify SQL, schema, and helper files. Install the fixture dependencies in the copy.

Run `npx vitest run`, then `node vite-probe.mjs`. Reset `query.typed.sql`, `schema.sql`, and `helper.mjs` from this fixture. Run `npx next build --turbopack`, start the production server with `npx next start -p 3991`, and request `/api/probe`. Repeat the build and request with `npx next build --webpack`. Stop that server, start `npx next dev --turbopack -p 3992`, and run `node next-probe.mjs`.

The scripts expect the listed ports to be free. Set `TEST_TURBOPACK_ROOT` to the common parent of the fixture and installed dependencies when the dependency manager uses symlinks outside the fixture.

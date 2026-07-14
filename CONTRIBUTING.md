# Contributing

Install dependencies without running lifecycle scripts:

```sh
pnpm install --ignore-scripts
```

Build the pinned PostgreSQL/PGlite engine:

```sh
pnpm build:engine
```

Run the full validation:

```sh
pnpm test:all
```

Changes to the C analyzer or normalized intermediate representation must include focused conformance fixtures. A release is not valid unless the packed-package consumer test succeeds with lifecycle scripts disabled.

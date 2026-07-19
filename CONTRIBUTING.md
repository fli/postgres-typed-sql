# Contributing

Install dependencies without running lifecycle scripts:

```sh
pnpm run setup:worktree
```

This also prepares the pinned PostgreSQL/PGlite source at `source/pglite`.
Worktrees share an exact-key immutable source cache beneath Git's common
directory, but every worktree receives a private tree. On APFS the private copy
uses copy-on-write; other filesystems receive a full copy.

Build the native engine when changing the C analyzer, its Makefile, the
postgres-pglite patch, or the pinned engine:

```sh
pnpm build:engine
```

Successful builds publish reusable intermediates for worktrees with the exact
same engine identity. Package staging rejects stale native output, so run the
engine build before `pnpm build` or `pnpm test:all` after changing native inputs.
The current identity and cache inputs are inspectable with:

```sh
pnpm run engine:prepare --print-identity
```

Run the full validation:

```sh
pnpm test:all
```

Changes to the C analyzer or normalized intermediate representation must include focused conformance fixtures. A release is not valid unless the packed-package consumer test succeeds with lifecycle scripts disabled.

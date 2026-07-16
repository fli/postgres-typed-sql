# Changelog

## 0.1.0-beta.2

- Breaking beta.1 migration: regenerate every checked-in `*.typed-sql.ts` file. Scalar profiles now describe the driver contract explicitly, and runtime execution consumes PostgreSQL's positional result rows so otherwise non-object-safe unique names such as `__proto__` remain exact. Duplicate result-column names are rejected during generation and require aliases because a generated object row cannot represent both values under one property name.
- Expanded PostgreSQL analysis for nested query scopes, rewrites and DML lineage, set operations, row bounds, parameter NULL admission, JSON shapes, CHECK constraints, row locks, volatile functions, and execution support hidden behind aggregates, sorting, grouping, operators, domains, triggers, and rules.
- PostgreSQL/JSON property spelling is preserved exactly as PostgreSQL reports it; this is intentional rather than a generated TypeScript naming normalization.
- Improved the typed-SQL scanner and generated-name validation with source-oriented diagnostics for malformed directives, unresolved parameters, duplicate names, reserved bindings, and TypeScript identifier collisions.
- Made generated output publication atomic and added a packed-consumer verification path covering script-free installation, typechecking, and runtime package exports.

## 0.1.0-beta.1

- Initial public beta.
- PostgreSQL 18.3 analysis through a bundled custom PGlite engine.
- Typed parameters, result columns, nullability, cardinality, JSON shapes, catalog types, and runtime statement metadata.
- Script-free consumer installation.

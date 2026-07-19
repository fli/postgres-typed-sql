# Changelog

## Unreleased

- Breaking: public analyzer IR and generated runtime result-column metadata now expose the required `expressionSource` field instead of the ambiguous `source`. It describes only the immediate analyzed expression—a direct table column, derived `Var`, or expression tag—and does not claim ultimate lineage.
- Breaking: generated parameter properties are now non-null by default. `@param name ?` requests nullable caller input with an inferred PostgreSQL type, while `@param name type?` combines the request with an explicit type; both forms require analyzer-proved `accepts` NULL admission. PostgreSQL admission no longer widens caller types implicitly, and generated parameter metadata now requires `nullable` to describe only the resolved caller contract.

## 0.1.0-beta.6

- Breaking: generated parameter-object properties now use conservative camel case by default while SQL tokens, `@param` directives, analyzer labels, and parameter metadata retain their raw spelling. Configure `naming.parameterProperties: 'preserve'` only for a deliberate exact-name API; post-transform collisions are rejected.
- Replaced the closed `scalarProfile` switch with composable codec profiles. Applications can now define exact result-OID mappings or portable schema/name hooks, independently model result, parameter, and nested-JSON representations, inherit built-in behavior, declare structured-JSON capability, and expose custom scalar imports.
- Added the selected codec profile name to generated statement and catalog headers, and applied codec behavior consistently to catalog columns, JSON shape rendering, enum/CHECK literal refinement, parameters, and results.
- Moved node-postgres query options, client typing, and execution helpers from `postgres-typed-sql/runtime` to `postgres-typed-sql/adapters/node-postgres`. The core runtime now contains only driver-neutral statement and mapping behavior. Replace `scalarProfile` with `codecProfile`, import execution helpers from the adapter, and regenerate checked-in output.

## 0.1.0-beta.5

- Added precise, statically inferred discriminated unions for `CASE`-authored JSON objects, including exact string-literal discriminants and branch-scoped non-null facts, without query directives or annotations.
- Preserved representation-changing PostgreSQL I/O coercions as type-analysis boundaries so casts such as `CASE ... END::jsonb` retain their runtime JSON representation.
- Kept SQL result nullability independent from JSON shape nullability, including strict-function null propagation across every argument to `row_to_json`.
- Consolidated structured-JSON inference around a canonical shared shape model, semantic normalization, and a single owner for root SQL nullability, with focused regression coverage for composition and ordering.

## 0.1.0-beta.4

- Breaking beta.3 migration: generator configuration now requires exact `imports.runtime` and `imports.scalars` module specifiers; the ambiguous `packageImport` option was removed.
- Generated statement modules no longer import the generated catalog. Enum and CHECK-constraint refinements are emitted directly into statement types, while the generated catalog remains a standalone artifact.
- Generated runtime imports now make `postgres-typed-sql` a normal consumer dependency rather than a development-only dependency.

## 0.1.0-beta.3

- Added opt-in `camelCase` naming for generated result-column properties and recursively modeled structured JSON fields while preserving PostgreSQL names in query and runtime metadata.
- Added runtime JSON mappings for the `node-postgres` scalar profile, including safe handling for arrays, unions, opaque values, prototype-sensitive keys, and post-mapping collisions.
- Expanded structured JSON analysis for scalar subqueries, `ARRAY` and predicate sublinks, `to_json`/`to_jsonb`/`row_to_json`, derived whole rows, CTE aliases, and every set-operation arm.
- Kept unusual PostgreSQL identifiers unchanged, rejected genuine generated-name collisions, and treated unknown, composite, array, JSON-cast, and other structurally opaque alternatives as traversal barriers.

## 0.1.0-beta.2

- Breaking beta.1 migration: regenerate every checked-in `*.typed-sql.ts` file. Generated catalog domain aliases were removed because PostgreSQL protocol results resolve domains through their base result types, and encoded or schema-qualified catalog type bindings were renamed; update any handwritten imports of those generated names. Scalar profiles now describe the driver contract explicitly, and runtime execution consumes PostgreSQL's positional result rows so otherwise non-object-safe unique names such as `__proto__` remain exact. The public runtime contract also removed the phantom `type` property and the row generic from `TypedSqlQueryConfig`; handwritten consumers must remove `type`, pass an explicit result-row generic to direct driver `query()` calls, and provide explicit `Params` and `Row` type arguments to `createTypedSqlStatement` where they previously relied on `type`-based inference. `TypedSqlQueryConfig.values` is now mutable for driver compatibility; copy a handwritten readonly array with `values: [...values]` or otherwise supply a mutable array. Duplicate result-column names are rejected during generation and require aliases because a generated object row cannot represent both values under one property name. Beta.1 treated `values[:index]` as a named subscript, but beta.2 parses it as native PostgreSQL slice syntax; rewrite named indexes as `values[(:index)]` and use the explicit named slice-bound forms documented in the README.
- Expanded PostgreSQL analysis for nested query scopes, rewrites and DML lineage, set operations, row bounds, parameter NULL admission, JSON shapes, CHECK constraints, row locks, volatile functions, and execution support hidden behind aggregates, sorting, grouping, operators, domains, triggers, and rules.
- PostgreSQL/JSON property spelling is preserved exactly as PostgreSQL reports it; this is intentional rather than a generated TypeScript naming normalization.
- Improved the typed-SQL scanner and generated-name validation with source-oriented diagnostics for malformed directives, unresolved parameters, duplicate names, reserved bindings, and TypeScript identifier collisions.
- Generated outputs are staged before replacement, and rollback is attempted when a commit error is caught. Publication is not crash-atomic, so interrupted generation must be rerun. Added a packed-consumer verification path covering script-free installation, typechecking, and runtime package exports.

## 0.1.0-beta.1

- Initial public beta.
- PostgreSQL 18.3 analysis through a bundled custom PGlite engine.
- Typed parameters, result columns, nullability, cardinality, JSON shapes, catalog types, and runtime statement metadata.
- Script-free consumer installation.

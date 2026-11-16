# Migrate native values at application boundaries

Keep generated PostgreSQL values inside SQL-facing code. Convert them where an ID,
RPC, or domain parser requires a different representation. The examples below come
from an application migration to beta.28. They do not require a consumer package patch.

## Restore compiler-proven nullable scalar filters

The analyzer can prove that a scalar SELECT returns SQL NULL when its safe WHERE
filter cannot be true for a NULL input. This includes conjunctions with correlated
filters. The result does not depend on an assumption that the table has at most one
row. An empty scalar result is SQL NULL.

Before the proof fix, the annotation lookup needed caller permission:

```sql
-- @bindNull annotation_public_id
select (
  select jsonb_build_object('id', annotation.id)
  from public.video_annotations annotation
  where annotation.public_id = :annotation_public_id::uuid
    and annotation.asset_id = asset.public_id
  limit 1
) as annotation
from public.assets asset
```

The same SQL now supports `-- @nullable annotation_public_id`. The image-callout
lookup's `callout_public_id` supports the same change without adding LIMIT.
No application rewrite or runtime NULL validator is needed.

This proof is deliberately bounded. Aggregate, grouping, set-operation, modifying
CTE, row-security, unsafe-bound, and unsupported enclosing-callable cases remain
conservative. For LIMIT/OFFSET the proof accepts NULL bounds and audited
nonnegative integer constants. `LIMIT coalesce(:input, -1)` remains unproven because
NULL can select an invalid bound. A non-NULL binding may still raise a scalar
cardinality error. `@nullable` proves NULL admission, not the absence of every SQL
error for every possible input.

The generator distinguishes evidence in its diagnostics:

- `PostgreSQL could not prove that every use accepts NULL` means analysis is
  unproven. It does not establish an unsafe query.
- `PostgreSQL proves that one of its uses rejects NULL` means there is rejecting
  evidence, such as a direct assignment into a NOT NULL target.

`@bindNull` records caller-owned permission and retains the analyzer's evidence.
It is appropriate when companion flags or modes make NULL legitimate. For example,
the application's multipart upload ID is required in multipart mode, and patch fields may be
required when their `*_provided` flag is true. Those invariants do not justify an
unconditional compiler proof. An opaque SQL or PL/pgSQL function also remains
unproven without an implemented proof of its behavior.

The [65-declaration source matrix](audits/beta28-nullable-inputs.tsv) records two
compiler-proven restorations, six companion-dependent declarations, thirteen
opaque-callable cases, and forty-four other unproven candidates. The last group
is a source-review classification, not forty-four established false positives.
All 65 reported `unknown` on the beta.28 baseline; the revised compiler accepts
only the two editor filters. Keep the other 63 declarations caller-owned.
The audit script compiles one restored annotation at a time against a copied
schema, without modifying the consumer:

```sh
node scripts/audit-nullable-inputs.mjs /path/to/application \
  /path/to/application/.audit/beta28/nullability-results.json /tmp/nullable-results.json
```

The script preserves naming and extension settings and omits unrelated JSONB
function contracts. It is a compilation audit, not a NULL execution sweep or a
certificate for uninspected triggers, RLS policies, or function bodies.

## Use exact bigint IDs with existing APIs

`int8` results are native `bigint`. Parameters accept `bigint`, exact decimal
strings, and safe integer numbers. The encoder checks PostgreSQL's int8 range and
rejects unsafe JavaScript numbers. Do not convert an int8 ID to `number` to satisfy
a string contract.

The application's platform lookup can remove a redundant constructor if it does not need
earlier validation or canonicalization:

```ts
const params = { userId: pgInt8FromInteger(userId) }
```

The same SQL parameter can receive the string directly:

```ts
const params = { userId }
```

The generated encoder still checks the external decimal string before issuing SQL.
Keep earlier boundary parsing if other work needs the validated value first.

When the application exposes string IDs, serialize once while building its DTO:

```ts
const dto = { platformId: row.platformId.toString() }
```

This remains necessary for the application's string-shaped platform permissions and durable
JSON contracts. `JSON.stringify` does not accept native bigint values. Preserve
native bigint for arithmetic, ordering, and code whose contract already uses it.

A native ID projection infers `bigint` and requires `row.id.toString()` for a DTO:

```sql
select id from public.platforms;
```

A query dedicated to a string-ID endpoint can select the exact decimal string
directly. Its generated `id` is `string`, so the DTO can use `row.id`:

```sql
select id::text as id from public.platforms;
```

PostgreSQL formats the int8 without losing digits. This is an explicit projection
choice for that query. Keep `id` as bigint if other consumers need the native value.
No global string mode, mapper profile, or serialization callback is needed.

## Respect existing int4 RPC contracts

`int4` parameters and results use JavaScript numbers. The encoder checks integral
values in the range -2147483648 through 2147483647. A decoded int4 does not need a
second number conversion:

```ts
const renditionPriority = pgInt4ToNumber(row.renditionPriority)
```

Use the decoded value directly:

```ts
const renditionPriority = row.renditionPriority
```

The application's preparation producer loads track values, maps them into branded string
planner types, forwards them through `preparation-controller.ts`, and serializes
the RPC with `JSON.stringify`. Its `preparation-contract.ts` also declares poster
dimensions and preview counts as decimal strings. The remote task therefore still
needs this conversion with the existing contract:

```ts
await rpc.call('publishPoster', {
  ...poster,
  assetSourceId: poster.assetSourceId.toString(),
  posterSizeBytes: poster.posterSizeBytes.toString(),
  posterWidth: poster.posterWidth.toString(),
  posterHeight: poster.posterHeight.toString(),
})
```

The conversion of width 640 to the wire string `"640"` is covered by the application's RPC
regression test. Changing the SQL library cannot change that wire schema. To keep
int4 values as numbers end to end, migrate the producer's SQL JSON projection,
planner types, RPC schema, and receiver together. Then the corresponding caller is:

```ts
await rpc.call('publishPoster', {
  ...poster,
  assetSourceId: poster.assetSourceId.toString(),
  posterSizeBytes: poster.posterSizeBytes.toString(),
})
```

That example requires the application contract migration. It is not a library
change. Keep int8 size and ID strings at the JSON boundary.

External RPC strings entering bounded integer parameters still need a checked
conversion. The application's `pgInt4FromInteger(value)` performs that application boundary
work. Do not replace it with unchecked `Number(value)` or a TypeScript assertion.
The library also checks the encoded number before SQL. Those checks protect
different boundaries. Existing bigint-to-number indexing guards must remain.

## Pass decoded JSON to domain parsers

`PgJson<T>` is a document with `.value`, `.source`, and `.codec`. A domain parser
usually expects the decoded value. TypeScript permits every value, including the
document wrapper, to flow into `unknown`, so it cannot reject this mistake through
the wrapper's brand alone.

The search projection previously passed a wrapper into its ProseMirror extractor:

```ts
const content = { document: row.document }
buildCurrentContentEntries({ audience: 'admin', ...content })
```

Pass the decoded value into the same domain function:

```ts
const content = { document: row.document?.value }
buildCurrentContentEntries({ audience: 'admin', ...content })
```

The extractor expects a document with `type: 'doc'`. Receiving a PgJson wrapper can
silently produce no searchable text. The CMAF parser had the corresponding direct
argument mistake:

```ts
const metadata = finalCmafMetadataValidator.parse(row.audioFinalCmaf)
```

Unwrap the document before parsing:

```ts
const metadata = finalCmafMetadataValidator.parse(row.audioFinalCmaf?.value)
```

Choose null normalization according to the domain contract. `document?.value`
maps SQL NULL to `undefined`; `document === null ? null : document.value` preserves
SQL NULL as `null`. A non-null PgJson containing JSON null has `.value === null`.
Do not blindly autofix between those cases.

Use the optional `postgres-typed-sql/migration` entry point to review statically
visible call boundaries in an existing TypeScript program:

```ts
import ts from 'typescript'
import { findPgJsonUnknownFlows } from 'postgres-typed-sql/migration'

const findings = findPgJsonUnknownFlows(ts, program)
console.error(
  ts.formatDiagnosticsWithColorAndContext(findings, {
    getCanonicalFileName: (file) => file,
    getCurrentDirectory: () => process.cwd(),
    getNewLine: () => '\n',
  })
)
if (findings.length > 0) process.exitCode = 1
```

Supply the same TypeScript instance used to create `program`. If your application
uses virtual SQL modules, supply the program from its existing mapper-aware host.
The checker does not compile SQL or construct overlays. The runtime and ordinary
generation do not load TypeScript. The checker is tested with TypeScript 5.8.3.

Diagnostic 95001 reports a branded PgJson flowing into an `unknown` argument or
known property, including statically typed intermediate objects and effective
spread properties. `.value` and forwarding to a PgJson parameter remain clean.
Intentional forwarding to an unknown-accepting document consumer can also produce
findings. Review those findings at the integration boundary. The checker has no
inline suppression directives or automatic fixes.

This is an opt-in migration aid. It checks call/new arguments, follows known
properties to depth five, and recognizes brands through imports or exports of
`postgres-typed-sql`, `/values`, and `/scalars`. Already-erased `unknown` or `any`,
dynamic properties, rest arguments, broad destination unions, return/assignment
flows, and deeper dataflow can escape it. Legitimate document consumers accepting
unknown can produce findings. Review findings manually; no automatic unwrap or
claim of complete migration safety is provided.

Unwrapping does not reparse or revalidate. Generated nested JSONB projections,
exact numeric values, bytea values, SQL/JSON null distinctions, and fixture codecs
keep their existing interpretation. Use generated codecs when constructing typed
fixtures. The existing [contract migration guide](consumer-contract-migration.md)
shows those fixture and composition patterns.

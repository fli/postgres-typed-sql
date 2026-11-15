# Remove beta.26 consumer workarounds

These examples use the checkout application evaluated for beta.26. They describe upstream
changes; applying them to the application is a separate migration. The upstream implementation
does not add driver queries or application validators.

## Bind legitimate nullable inputs directly

Beta.26 has two input declarations. `@nullable` asks for a proof that every modeled
use admits SQL NULL. `@bindNull` grants caller-owned permission to bind SQL NULL,
while preserving the analyzer's independent `accepts`, `rejects`, or `unknown`
evidence. Parameters without either declaration remain non-null.

The application's `reserve-paypal-checkout-approval.typed.sql` currently hides the nullable
argument in a one-row CTE:

```sql
-- @nullable acceptance_snapshot
with approval_options as materialized (
  select :acceptance_snapshot::jsonb as acceptance_snapshot
)
select result
from approval_options
cross join lateral public.reserve_paypal_checkout_approval(
  :public_id::uuid,
  :checkout_session_id::bigint,
  :environment::text,
  :client_id::text,
  :partner_merchant_id::text,
  :checkout_public_id::uuid,
  approval_options.acceptance_snapshot
) as result
limit 1
```

The direct caller-owned declaration removes that CTE:

```sql
-- @access write
-- @bindNull acceptance_snapshot
select result
from public.reserve_paypal_checkout_approval(
  :public_id::uuid,
  :checkout_session_id::bigint,
  :environment::text,
  :client_id::text,
  :partner_merchant_id::text,
  :checkout_public_id::uuid,
  :acceptance_snapshot::jsonb
) as result
limit 1
```

The same replacement removes `upload_options` from
`insert-upload-asset.typed.sql`, and `version_options` from
`create-asset-version-with-source.typed.sql`, `create-external-video-asset.typed.sql`,
and `create-initial-asset-version.typed.sql`. Bind each optional function argument
directly with its original SQL cast and change its declaration to `@bindNull`.
Keep the queries' functional CTEs, including inserts and returned-row updates.

For `replace-current-lesson-assignment.typed.sql`, replace each scalar reference
`(select checklist from assignment_input)` with `:checklist::jsonb`, remove only
`assignment_input`, and declare `-- @bindNull checklist`. The existing removal
branch still uses `:checklist::jsonb IS NULL`; the insert branch keeps
`:checklist::jsonb IS NOT NULL AND decision.changed`. Its conflict update and
other CTEs remain intact. That complete statement still needs caller-owned
permission because its proof spans more than the supported direct insert case.

A simple guarded insert now satisfies strict `@nullable`:

```sql
-- @nullable checklist
insert into lesson_assignment_checklists(checklist)
select :checklist::jsonb
where :checklist::jsonb is not null
```

The proof does not bypass unsafe uses elsewhere, aggregate-generated rows,
conflict actions, rules, or trigger constraints. A materialized CTE no longer
provides false proof for an unsafe function, domain cast, or required-nonnull
expression reached through its values.

Pass `null` for SQL NULL and `json(null)` for a non-null JSON document containing
JSON null. Undefined object properties in JSON inputs are still omitted.

## Reuse the pricing update as a contract projection

The application currently points `load_priced_checkout_page` at a copied SELECT projection:

```js
updated: {
  projection: 'apps/web/src/features/checkout/load-checkout-session-pricing-projection.typed.sql',
},
```

Point it at the existing statement instead:

```js
updated: {
  projection: 'apps/web/src/features/checkout/update-checkout-session-pricing.typed.sql',
},
```

Delete `load-checkout-session-pricing-projection.typed.sql` when its last reference
is removed. Projection analysis consumes the original statement's analyzed result
columns. It does not wrap the SQL in a subquery or execute its update CTE. Project
input hashes, dependency watching, invalidation, overload references, field names,
nullability, and nested JSON interpretation continue to come from the SQL sources.

Projection object properties now use `naming.resultColumns`, matching standalone
rows. Fields inside JSON documents use `naming.structuredJsonFields`. Projects
that previously used different naming settings for a projection's row fields
must update those accesses when regenerating.

## Describe the untagged PayPal result once

The application currently duplicates `load-paypal-checkout-approval.typed.sql` in a TypeBox
`reservedApproval` schema and reparses the result source:

```ts
function mapReservedApproval(result: PgJson | null): LoadPaypalCheckoutApprovalRow {
  const value: unknown = result === null ? null : JSON.parse(result.source)
  if (!reservedApproval.Check(value)) throw new TypeError('Invalid reserved PayPal approval')
  return value
}
```

Add one root projection contract:

```js
{
  schema: 'public',
  name: 'reserve_paypal_checkout_approval',
  argumentTypes: ['uuid', 'int8', 'text', 'text', 'text', 'uuid', 'jsonb'],
  returns: {
    projection: 'apps/web/src/features/checkout/load-paypal-checkout-approval.typed.sql',
  },
}
```

The exact overload returns `SETOF jsonb`. Its direct range-function result is now
contracted, and `LIMIT 1` continues to produce an optional query row. After handling
the existing absent-row and SQL-null cases, use the generated value directly:

```ts
const reserved = await reservePaypalCheckoutApproval(db, params)
if (reserved === null || reserved.result === null) {
  throw new TypeError('PayPal approval was not reserved')
}
const approval: LoadPaypalCheckoutApprovalRow = reserved.result.value
```

Delete `reservedApproval`, `mapReservedApproval`, and imports used only by that
schema. The upstream decoder checks field presence, enums, text check-constraint
unions, scalar ranges, and nullability. `acceptanceSnapshot` stays `string | null`
because both the function and projection explicitly cast that column to text.

For a hand-written ordinary object use `returns: { object: { ... } }`. For true
domain alternatives keep the existing `variants` declaration. Declare exactly one
of `returns` and `variants`; no synthetic `kind` is needed for an ordinary object.

## Pass projected rows to standalone consumers

The application currently rebuilds nested documents in `load-checkout-page.ts`:

```ts
const locked = mapCheckoutSessionRow({
  ...raw.session,
  customerTaxLocation:
    raw.session.customerTaxLocation === null ? null : json<PgJsonInput>(raw.session.customerTaxLocation),
  pricingDetails: json<PgJsonInput>(raw.session.pricingDetails),
})
const draft = checkoutBuyerDraftFromState(session, {
  ...buyer,
  buyerDraft: json<PgJsonInput>(buyer.buyerDraft),
})
```

Explicit projection boundaries now retain JSON columns as real `PgJson` documents
with their generated nested codecs:

```ts
const locked = mapCheckoutSessionRow(raw.session)
const session = raw.kind === 'editable' ? mapCheckoutSessionRow(raw.updated) : locked
const buyer = raw.kind === 'editable' ? raw.updated : raw.buyer
const draft = checkoutBuyerDraftFromState(session, buyer)

const quote =
  raw.kind === 'editable' && raw.tax
    ? checkoutTaxQuoteContextFromPolicy(raw.tax, session, stripeExecution, draft.values.billingAddress).cached
    : null
```

Keep the original business guards around `quote`. The example abbreviates those
conditions to show the row argument. Remove the JSON reconstruction for
`pricingDetails`, `customerTaxLocation`, `buyerDraft`, `taxQuote`, `managedPolicy`,
and `manualPolicy`. Projected bytea also uses `Uint8Array`, so the separate
`Buffer.from(...slice(2), 'hex')` reconstruction of `browserBindingTokenHash` can
be removed. The page builder intentionally accepts a DTO that transforms two JSON
columns into arrays. Its existing `mapCheckoutSessionPageReadRow` helper already
owns that transformation and the `tokenHashKey` check, so reuse it:

```ts
const presentation = buildCheckoutSessionPageReadData({
  row: mapCheckoutSessionPageReadRow(raw.presentation),
  rememberedAccountCookieSnapshot: { candidates: [] },
  tokenHashEntries: [],
})
```

No new adapter or validator is needed. Code that directly reads a projected JSON
column's contents now uses `.value`, exactly as it does for a standalone row.

### Construct fixtures with generated codecs

Generic `json(value)` interprets all numbers as lossless decimals. A fixture for
an inferred int4 or float JSON field instead needs its generated column codec.
Every statement now exposes those codecs without a database call.

The video test's binding fixture can replace its double assertion with:

```ts
import { loadVideoAuthorizationSnapshot } from '@/lib/load-video-authorization-snapshot.typed.sql'

const bindings = json(
  [
    {
      assetRole: 'featured',
      courseHasPassword: false,
      courseGrantExpiresAt: null,
      coursePublicId: COURSE_PUBLIC_ID,
      coursePublicationState: 'published',
      document: { attrs: { schemaVersion: 4 }, content: [], type: 'doc' },
      kind: 'lesson',
      lessonPermission: 'full',
      lessonUnlistedToken: null,
    },
  ],
  loadVideoAuthorizationSnapshot.jsonCodecs.bindings
)
```

Opaque JSON subtrees accept ordinary JSON inputs and decode numbers losslessly.
Inferred numeric fields retain their native SQL interpretation. To change a fixture,
construct a new document with the same codec instead of replacing `.value` alone.

The lesson-link test can replace its spread of `json(null)` and double assertion with:

```ts
import { loadCueCardLessonLinkCardRows } from '@/features/asset-editor/load-cue-card-lesson-link-card-rows.typed.sql'

const featuredAsset = json(
  {
    publicId,
    type,
    externalUrl,
    objectKey: `assets/v1/${publicId}`,
    imageWidth: 1600,
    posterObjectKey: `assets/v1/${publicId}`,
    posterWidth: 1600,
  },
  loadCueCardLessonLinkCardRows.jsonCodecs.featuredAsset
)
```

No extra fixture factory or application schema is needed. The constructor checks
required fields and scalar interpretations and produces consistent source text.

## Representation limits

A nullable SQL JSON column and a JSON-null document both serialize as JSON null
inside PostgreSQL row JSON. A projected nullable JSON field therefore uses `null`
for that wire value. A nonnullable projected JSON column preserves a `PgJson` whose
value is null. Root SQL NULL and root JSON null remain separate. An application that
needs the original distinction for a nullable nested JSON column must encode it
explicitly in SQL.

SQL array lower bounds and custom JSON casts can also lose information during
PostgreSQL JSON conversion. Those projections retain the JSON representation;
they do not promise an exact standalone SQL array or custom scalar value. The application's
checkout row assignments and the two fixture examples are checked separately from
these general limits. Ordinary inferred JSON constructors still return embedded
values; automatic nested documents belong to explicit query projections.

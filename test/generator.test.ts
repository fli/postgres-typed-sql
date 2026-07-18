import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { PGlite } from '../src/vendor/pglite/index.js'
import { definePostgresCodecProfile, postgresResultTypesByOid, postgresTypeScriptType } from '../src/index.js'
import {
  assertTypeScriptBindingIdentifier,
  camelCaseOutputProperty,
  postgresCheckConstraintTypeBinding,
  postgresIdentifierTypeSegment,
  postgresNamedTypeBinding,
  renderTypeScriptLineCommentValue,
} from '../src/typescript-names.js'

import { copyFixture, createMinimalFixture, generateTypedSql } from './generator-test-support.js'

test('camel-cases only conventional PostgreSQL output identifiers', () => {
  assert.equal(camelCaseOutputProperty('account_id'), 'accountId')
  assert.equal(camelCaseOutputProperty('api_v2_url'), 'apiV2Url')
  assert.equal(camelCaseOutputProperty('column_1'), 'column1')
  assert.equal(camelCaseOutputProperty('displayName'), 'displayName')
  assert.equal(camelCaseOutputProperty('__proto__'), '__proto__')
  assert.equal(camelCaseOutputProperty('outer-key'), 'outer-key')
  assert.equal(camelCaseOutputProperty('URL'), 'URL')
})

test('escapes every ECMAScript line terminator in generated line-comment values', () => {
  assert.equal(renderTypeScriptLineCommentValue('before\r\n\u2028\u2029after'), 'before\\r\\n\\u2028\\u2029after')
})

test('generates PostgreSQL-derived types, nullability, and cardinality', async () => {
  const root = await copyFixture()
  const result = await generateTypedSql({
    extensions: ['pgcrypto'],
    include: ['queries'],
    rootDir: root,
    codecProfile: 'node-postgres',
    schema: 'schema.sql',
  })

  assert.equal(result.statementCount, 4)
  const account = await readFile(join(root, 'queries/find-account-by-email.typed-sql.ts'), 'utf8')
  assert.match(account, /cardinality: 'optional'/u)
  assert.match(account, /readonly display_name: string \| null/u)
  assert.match(account, /readonly status: "active" \| "suspended"/u)
  assert.match(account, /readonly role: 'member' \| 'admin'/u)
  assert.doesNotMatch(account, /postgres-typed-sql\.types/u)
  assert.match(account, /postgres-typed-sql\/runtime/u)

  const joined = await readFile(join(root, 'queries/list-accounts-with-posts.typed-sql.ts'), 'utf8')
  assert.match(joined, /readonly title: string \| null/u)
  assert.match(joined, /readonly published_at: Date \| number \| null/u)

  const catalog = await readFile(join(root, 'postgres-typed-sql.types.ts'), 'utf8')
  assert.match(catalog, /export type AccountStatus = "active" \| "suspended"/u)
  assert.match(catalog, /export type Accounts__Role = "member" \| "admin"/u)
})

test('defaults to conservative unknown driver scalar values', async () => {
  const root = await copyFixture()
  await generateTypedSql({
    include: ['queries'],
    rootDir: root,
    schema: 'schema.sql',
  })

  const account = await readFile(join(root, 'queries/find-account-by-email.typed-sql.ts'), 'utf8')
  assert.match(account, /export interface FindAccountByEmailParams \{[\s\S]*readonly email: NonNullable<unknown>/u)
  assert.match(account, /export interface FindAccountByEmailRow \{[\s\S]*readonly email: unknown/u)
  assert.match(account, /readonly display_name: unknown \| null/u)
  assert.match(account, /readonly status: unknown/u)
  assert.doesNotMatch(account, /import type \{ AccountStatus/u)

  const catalog = await readFile(join(root, 'postgres-typed-sql.types.ts'), 'utf8')
  assert.match(catalog, /readonly id: unknown/u)
  assert.match(catalog, /readonly status: unknown/u)
})

test('applies custom codec hooks to parameters, results, structured JSON, catalog types, and artifact metadata', async () => {
  const root = await createMinimalFixture(
    `create type public.item_state as enum ('active', 'archived');
create table public.items (id integer primary key, state public.item_state not null);
`,
    `select
  :value::integer as direct_value,
  jsonb_build_object('nested_value', :value::integer) as payload,
  'active'::public.item_state as state
`
  )
  const codecProfile = definePostgresCodecProfile({
    extends: 'node-postgres',
    name: 'application-codecs',
    opaqueJsonType: postgresTypeScriptType('ApplicationJson', { scalarImports: ['ApplicationJson'] }),
    parameterType({ type }, fallback) {
      return type.pgTypeOid === 23
        ? postgresTypeScriptType('ApplicationIntInput', { scalarImports: ['ApplicationIntInput'] })
        : fallback()
    },
    resultType: (() => {
      const byOid = postgresResultTypesByOid({
        23: postgresTypeScriptType('ApplicationInt', { scalarImports: ['ApplicationInt'] }),
      })
      return (context, fallback) =>
        context.declaredType.pgTypeSchema === 'public' && context.declaredType.pgTypeName === 'item_state'
          ? postgresTypeScriptType('ApplicationItemState', { scalarImports: ['ApplicationItemState'] })
          : byOid(context, fallback)
    })(),
    jsonScalarType({ type }, fallback) {
      return type.pgTypeOid === 23
        ? postgresTypeScriptType('ApplicationJsonInt', { scalarImports: ['ApplicationJsonInt'] })
        : fallback()
    },
  })

  await generateTypedSql({
    codecProfile,
    include: ['queries'],
    rootDir: root,
    schema: 'schema.sql',
  })

  const output = await readFile(join(root, 'queries/query.typed-sql.ts'), 'utf8')
  assert.match(output, /\/\/ Codec profile: application-codecs/u)
  assert.match(output, /readonly value: ApplicationIntInput/u)
  assert.match(output, /readonly direct_value: ApplicationInt \| null/u)
  assert.match(output, /readonly nested_value: ApplicationJsonInt \| null/u)
  assert.match(output, /readonly state: ApplicationItemState/u)
  assert.match(
    output,
    /import type \{ ApplicationInt, ApplicationIntInput, ApplicationItemState, ApplicationJsonInt \} from 'postgres-typed-sql\/scalars'/u
  )

  const catalog = await readFile(join(root, 'postgres-typed-sql.types.ts'), 'utf8')
  assert.match(catalog, /\/\/ Codec profile: application-codecs/u)
  assert.match(catalog, /readonly id: ApplicationInt/u)
  assert.match(catalog, /readonly state: ApplicationItemState/u)
})

test('deduplicates Record when generated empty objects and codec types use the same ambient dependency', async () => {
  const root = await createMinimalFixture('select 1;\n', 'select 1::integer as value\n')
  const codecProfile = definePostgresCodecProfile({
    extends: 'node-postgres',
    name: 'ambient-record-result',
    resultType({ decoderType }, fallback) {
      return decoderType.pgTypeOid === 23
        ? postgresTypeScriptType('Record<string, unknown>', { ambientBindings: ['Record'] })
        : fallback()
    },
  })

  await generateTypedSql({
    codecProfile,
    include: ['queries'],
    rootDir: root,
    schema: 'schema.sql',
  })

  const output = await readFile(join(root, 'queries/query.typed-sql.ts'), 'utf8')
  assert.match(output, /export type QueryParams = Record<string, never>/u)
  assert.match(output, /readonly value: Record<string, unknown>/u)
})

test('generates nullable parameters when a direct SELECT use proves NULL is accepted', async () => {
  const root = await createMinimalFixture('select 1;\n', 'select :value::text as value\n')
  await generateTypedSql({
    include: ['queries'],
    rootDir: root,
    codecProfile: 'node-postgres',
    schema: 'schema.sql',
  })

  const output = await readFile(join(root, 'queries/query.typed-sql.ts'), 'utf8')
  assert.match(output, /export interface QueryParams \{[\s\S]*readonly value: string \| null/u)
})

test('preserves PostgreSQL array slices through named-parameter compilation and analysis', async () => {
  const root = await createMinimalFixture(
    'select 1;\n',
    `select numbers[1:upper_bound] as sliced
from (values (array[10, 20, 30], 2)) as bounds(numbers, upper_bound)
`
  )
  await generateTypedSql({
    include: ['queries'],
    rootDir: root,
    codecProfile: 'node-postgres',
    schema: 'schema.sql',
  })

  const output = await readFile(join(root, 'queries/query.typed-sql.ts'), 'utf8')
  assert.match(output, /parameterNames: \[\]/u)
  assert.match(output, /numbers\[1:upper_bound\]/u)
})

test('generates and executes named parameters inside CASE array subscripts', async () => {
  const sql = `select numbers[case when :use_first then 1 else 2 end] as picked
from (values (array[10, 20])) as input(numbers)
`
  const root = await createMinimalFixture('select 1;\n', sql)
  await generateTypedSql({
    include: ['queries'],
    rootDir: root,
    codecProfile: 'node-postgres',
    schema: 'schema.sql',
  })

  const output = await readFile(join(root, 'queries/query.typed-sql.ts'), 'utf8')
  assert.match(output, /parameterNames: \['use_first'\]/u)
  assert.match(output, /numbers\[case when \$1 then 1 else 2 end\]/u)

  const database = new PGlite()
  try {
    await database.waitReady
    const compiledSql =
      'select numbers[case when $1 then 1 else 2 end] as picked from (values (array[10, 20])) input(numbers)'
    assert.deepEqual((await database.query(compiledSql, [true])).rows, [{ picked: 10 }])
    assert.deepEqual((await database.query(compiledSql, [false])).rows, [{ picked: 20 }])
  } finally {
    await database.close()
  }
})

test('requires serialized strings for PostgreSQL arrays whose element delimiter is not a comma', async () => {
  const root = await createMinimalFixture(
    'create domain public.int_list as integer[];\n',
    `select
  cardinality(:boxes::box[]) as box_count,
  cardinality(:lists::public.int_list[]) as list_count
`
  )
  await generateTypedSql({
    include: ['queries'],
    rootDir: root,
    codecProfile: 'node-postgres',
    schema: 'schema.sql',
  })

  const output = await readFile(join(root, 'queries/query.typed-sql.ts'), 'utf8')
  assert.match(output, /readonly boxes: string/u)
  assert.doesNotMatch(output, /readonly boxes: PgArray/u)
  assert.match(output, /readonly lists: PgArrayParameter<string> \| string/u)
  assert.doesNotMatch(output, /readonly lists: PgArrayParameter<PgArray/u)
})

test('imports every scalar dependency used by bytea array parameters', async () => {
  const root = await createMinimalFixture(
    'select 1;\n',
    `select :payloads::bytea[] as payloads
`
  )
  await generateTypedSql({
    include: ['queries'],
    rootDir: root,
    codecProfile: 'node-postgres',
    schema: 'schema.sql',
  })

  const output = await readFile(join(root, 'queries/query.typed-sql.ts'), 'utf8')
  assert.match(
    output,
    /import type \{ PgArray, PgArrayParameter, PgByteaHexString \} from 'postgres-typed-sql\/scalars'/u
  )
  assert.match(
    output,
    /export interface QueryParams \{[\s\S]*readonly payloads: PgArrayParameter<PgByteaHexString> \| string/u
  )
  assert.match(output, /export interface QueryRow \{[\s\S]*readonly payloads: PgArray<Uint8Array> \| null/u)
})

test('surfaces native PostgreSQL diagnostics for invalid SQL', async () => {
  const root = await copyFixture()
  await writeFile(join(root, 'queries/invalid.typed.sql'), 'select missing_column from public.accounts\n')

  await assert.rejects(
    generateTypedSql({
      include: ['queries'],
      rootDir: root,
      codecProfile: 'node-postgres',
      schema: 'schema.sql',
    }),
    /column "missing_column" does not exist/u
  )
})

test('configuration failure releases the in-process generation guard', async () => {
  const root = await copyFixture()
  await assert.rejects(
    generateTypedSql({ rootDir: root, schema: [] }),
    /schema option must name at least one SQL file/u
  )

  const result = await generateTypedSql({
    include: ['queries'],
    rootDir: root,
    schema: 'schema.sql',
  })
  assert.equal(result.statementCount, 4)
})

test('rejects unresolved parameter types instead of generating a phantom Unknown import', async () => {
  const root = await copyFixture()
  await writeFile(join(root, 'queries/unresolved-parameter.typed.sql'), 'select pg_typeof(:value)\n')

  await assert.rejects(
    generateTypedSql({
      include: ['queries'],
      rootDir: root,
      codecProfile: 'node-postgres',
      schema: 'schema.sql',
    }),
    /could not determine data type of parameter \$1/u
  )
  await assert.rejects(
    readFile(join(root, 'queries/unresolved-parameter.typed-sql.ts'), 'utf8'),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENOENT'
  )
})

test('does not allow directives to downgrade PostgreSQL write access', async () => {
  const root = await copyFixture()
  await writeFile(
    join(root, 'queries/downgraded-write.typed.sql'),
    '-- @access read\ndelete from public.posts where id = :id\n'
  )

  await assert.rejects(
    generateTypedSql({
      include: ['queries'],
      rootDir: root,
      codecProfile: 'node-postgres',
      schema: 'schema.sql',
    }),
    /@access read conflicts with PostgreSQL's write classification/u
  )
})

test('classifies volatile PostgreSQL function calls conservatively as writes', async () => {
  const root = await createMinimalFixture(
    `create sequence public.event_sequence;
create table public.lock_values (value integer);
create function public.volatile_sum_transition(state integer, value integer)
returns integer
language plpgsql volatile
as $$
begin
  insert into public.lock_values(value) values (value);
  return coalesce(state, 0) + value;
end
$$;
create aggregate public.volatile_sum(integer) (
  sfunc = public.volatile_sum_transition,
  stype = integer,
  initcond = '0'
);
`,
    `-- @access read
select 1 as value limit nextval('public.event_sequence')
`
  )
  const config = {
    include: ['queries'],
    rootDir: root,
    codecProfile: 'node-postgres' as const,
    schema: 'schema.sql',
  }
  await assert.rejects(generateTypedSql(config), /@access read conflicts with PostgreSQL's write classification/u)

  await writeFile(
    join(root, 'queries/query.typed.sql'),
    `-- @access read
select public.volatile_sum(value) from (values (1), (2), (3)) input(value)
`
  )
  await assert.rejects(generateTypedSql(config), /@access read conflicts with PostgreSQL's write classification/u)

  await writeFile(
    join(root, 'queries/query.typed.sql'),
    `-- @access read
select value from public.lock_values for update
`
  )
  await assert.rejects(generateTypedSql(config), /@access read conflicts with PostgreSQL's write classification/u)

  await writeFile(
    join(root, 'queries/query.typed.sql'),
    `-- @access read
select left_value.value
from public.lock_values left_value
join public.lock_values right_value on exists (
  select 1
  from public.lock_values nested_lock
  where nested_lock.value = left_value.value
  for update
)
`
  )
  await assert.rejects(generateTypedSql(config), /@access read conflicts with PostgreSQL's write classification/u)
})

test('rejects read access for volatile btree comparator execution hidden behind ORDER BY', async () => {
  const root = await createMinimalFixture(
    `create type public.volatile_sort_key as (value integer);
create table public.volatile_sort_key_calls (called boolean default true);
create function public.volatile_sort_key_lt(
  left_value public.volatile_sort_key, right_value public.volatile_sort_key
) returns boolean language sql immutable strict
as $$ select (left_value).value < (right_value).value $$;
create function public.volatile_sort_key_le(
  left_value public.volatile_sort_key, right_value public.volatile_sort_key
) returns boolean language sql immutable strict
as $$ select (left_value).value <= (right_value).value $$;
create function public.volatile_sort_key_eq(
  left_value public.volatile_sort_key, right_value public.volatile_sort_key
) returns boolean language sql immutable strict
as $$ select (left_value).value = (right_value).value $$;
create function public.volatile_sort_key_ge(
  left_value public.volatile_sort_key, right_value public.volatile_sort_key
) returns boolean language sql immutable strict
as $$ select (left_value).value >= (right_value).value $$;
create function public.volatile_sort_key_gt(
  left_value public.volatile_sort_key, right_value public.volatile_sort_key
) returns boolean language sql immutable strict
as $$ select (left_value).value > (right_value).value $$;
create function public.volatile_sort_key_compare(
  left_value public.volatile_sort_key, right_value public.volatile_sort_key
) returns integer language plpgsql volatile strict as $$
begin
  insert into public.volatile_sort_key_calls default values;
  return case
    when (left_value).value < (right_value).value then -1
    when (left_value).value > (right_value).value then 1
    else 0
  end;
end
$$;
create operator public.< (
  leftarg = public.volatile_sort_key,
  rightarg = public.volatile_sort_key,
  function = public.volatile_sort_key_lt
);
create operator public.<= (
  leftarg = public.volatile_sort_key,
  rightarg = public.volatile_sort_key,
  function = public.volatile_sort_key_le
);
create operator public.= (
  leftarg = public.volatile_sort_key,
  rightarg = public.volatile_sort_key,
  function = public.volatile_sort_key_eq
);
create operator public.>= (
  leftarg = public.volatile_sort_key,
  rightarg = public.volatile_sort_key,
  function = public.volatile_sort_key_ge
);
create operator public.> (
  leftarg = public.volatile_sort_key,
  rightarg = public.volatile_sort_key,
  function = public.volatile_sort_key_gt
);
create operator class public.volatile_sort_key_ops
default for type public.volatile_sort_key using btree as
  operator 1 public.<,
  operator 2 public.<=,
  operator 3 public.=,
  operator 4 public.>=,
  operator 5 public.>,
  function 1 public.volatile_sort_key_compare(
    public.volatile_sort_key, public.volatile_sort_key
  );
`,
    `-- @access read
select value
from (values
  (row(3)::public.volatile_sort_key),
  (row(1)::public.volatile_sort_key),
  (row(2)::public.volatile_sort_key)
) input(value)
order by value
`
  )

  await assert.rejects(
    generateTypedSql({
      include: ['queries'],
      rootDir: root,
      codecProfile: 'node-postgres',
      schema: 'schema.sql',
    }),
    /@access read conflicts with PostgreSQL's write classification/u
  )
})

test('preserves non-code parameter text and limits directives to the header', async () => {
  const root = await copyFixture()
  await writeFile(
    join(root, 'queries/lexical-contexts.typed.sql'),
    `-- @name lexicalContexts
-- @param cutoff timestamp with time zone?
-- @param email text
-- @column cutoff timestamp with time zone
select
  ':not_a_parameter' as literal_value,
  $$:also_not$$ as dollar_value,
  :cutoff as cutoff,
  account.display_name
from public.accounts account
where account.email = :email
  and /* outer :not_this /* inner :nor_this */ */ true
-- @todo this body comment must remain SQL
-- :comment_parameter
`
  )

  const result = await generateTypedSql({
    include: ['queries'],
    rootDir: root,
    codecProfile: 'node-postgres',
    schema: 'schema.sql',
  })

  assert.equal(result.statementCount, 5)
  const output = await readFile(join(root, 'queries/lexical-contexts.typed-sql.ts'), 'utf8')
  assert.match(output, /parameterNames: \['cutoff', 'email'\]/u)
  assert.match(output, /readonly cutoff: Date \| number \| string \| null/u)
  assert.match(output, /name: 'cutoff',[\s\S]*?nullable: true/u)
  assert.match(output, /':not_a_parameter'/u)
  assert.match(output, /\$\$:also_not\$\$/u)
  assert.match(output, /\/\* outer :not_this \/\* inner :nor_this \*\/ \*\//u)
  assert.match(output, /@todo this body comment must remain SQL/u)
  assert.match(output, /-- :comment_parameter/u)
  assert.doesNotMatch(output, /Unknown/u)
})

test('rejects duplicate singular header directives instead of using the last value', async () => {
  const root = await createMinimalFixture(
    'select 1;\n',
    `-- @name firstName
-- @name secondName
select 1
`
  )
  await assert.rejects(
    generateTypedSql({ include: ['queries'], rootDir: root, schema: 'schema.sql' }),
    /duplicate @name; first declared/u
  )

  await writeFile(
    join(root, 'queries/query.typed.sql'),
    `-- @access read
-- @access write
select 1
`
  )
  await assert.rejects(
    generateTypedSql({ include: ['queries'], rootDir: root, schema: 'schema.sql' }),
    /duplicate @access; first declared/u
  )
})

test('preserves explicit parameter types while PostgreSQL infers unspecified parameter types', async () => {
  const root = await copyFixture()
  await writeFile(
    join(root, 'queries/mixed-parameter-oids.typed.sql'),
    `-- @name mixedParameterOids
-- @param label text
select :label as label
from public.accounts account
where account.id = :account_id
`
  )

  const result = await generateTypedSql({
    include: ['queries'],
    rootDir: root,
    codecProfile: 'node-postgres',
    schema: 'schema.sql',
  })

  assert.equal(result.statementCount, 5)
  const output = await readFile(join(root, 'queries/mixed-parameter-oids.typed-sql.ts'), 'utf8')
  assert.match(output, /parameterNames: \['label', 'account_id'\]/u)
  assert.match(output, /readonly label: string/u)
  assert.match(output, /readonly account_id: bigint \| number \| string/u)
  assert.match(output, /name: 'label',[\s\S]*?pgType: 'text'/u)
  assert.match(output, /name: 'account_id',[\s\S]*?pgType: 'bigint'/u)
})

test('uses native DML facts for parameter nullability and nested write access', async () => {
  const root = await copyFixture()
  const schemaPath = join(root, 'schema.sql')
  const schema = await readFile(schemaPath, 'utf8')
  await writeFile(
    schemaPath,
    `${schema}
create domain public.maybe_text as text;
create domain public.checked_text as text check (value <> '');
create domain public.required_text as text not null;
create domain public.nested_required_text as public.required_text;
create table public.domain_inputs (
  raw_value text,
  maybe_value public.maybe_text,
  checked_value public.checked_text,
  required_value public.required_text,
  nested_required_value public.nested_required_text
);
create table public.outer_join_inputs (
  value text check (value in ('allowed'))
);
create function public.reject_null_arg(value integer)
returns integer
language plpgsql
immutable
as $$
begin
  if value is null then
    raise exception 'reject_null_arg rejected null';
  end if;
  return value;
end
$$;
create table public.unsafe_insert_select (
  value integer check (value = public.reject_null_arg(value))
);
`
  )
  await writeFile(
    join(root, 'queries/native-dml-facts.typed.sql'),
    `-- @name nativeDmlFacts
insert into public.accounts(email, display_name)
values (:email, :display_name), (:second_email, :display_name)
returning id
`
  )
  await writeFile(
    join(root, 'queries/mixed-dml-target.typed.sql'),
    `-- @name mixedDmlTarget
insert into public.accounts(email, display_name)
values (:value, :value)
returning id
`
  )
  await writeFile(
    join(root, 'queries/modifying-cte.typed.sql'),
    `-- @name modifyingCte
-- @param email text
with inserted as (
  insert into public.accounts(email, display_name)
  values (:email, :display_name)
  returning id
)
select id from inserted
`
  )
  await writeFile(
    join(root, 'queries/domain-nullability.typed.sql'),
    `insert into public.domain_inputs(maybe_value, checked_value, required_value, nested_required_value)
values (:maybe_value, :checked_value, :required_value, :nested_required_value)
`
  )
  await writeFile(
    join(root, 'queries/mixed-domain-path.typed.sql'),
    `insert into public.domain_inputs(raw_value)
values (:value), ((:value::text)::public.required_text)
`
  )
  await writeFile(
    join(root, 'queries/rejecting-returning-use.typed.sql'),
    `insert into public.domain_inputs(raw_value)
values (:value::text)
returning (:value::text)::public.required_text
`
  )
  await writeFile(
    join(root, 'queries/null-extended-input.typed.sql'),
    `insert into public.outer_join_inputs(value)
select candidate.value
from (values (1)) guaranteed(marker)
left join (values (:value::text)) candidate(value) on false
`
  )
  await writeFile(
    join(root, 'queries/unsafe-insert-select.typed.sql'),
    `insert into public.unsafe_insert_select(value)
select :value
`
  )

  const result = await generateTypedSql({
    include: ['queries'],
    rootDir: root,
    codecProfile: 'node-postgres',
    schema: 'schema.sql',
  })

  assert.equal(result.statementCount, 12)

  const nativeFacts = await readFile(join(root, 'queries/native-dml-facts.typed-sql.ts'), 'utf8')
  assert.match(nativeFacts, /readonly email: string\n/u)
  assert.match(nativeFacts, /readonly display_name: string \| null/u)
  assert.match(nativeFacts, /readonly second_email: string\n/u)

  const mixedTarget = await readFile(join(root, 'queries/mixed-dml-target.typed-sql.ts'), 'utf8')
  assert.match(mixedTarget, /readonly value: string\n/u)
  assert.doesNotMatch(mixedTarget, /readonly value: string \| null/u)

  const modifyingCte = await readFile(join(root, 'queries/modifying-cte.typed-sql.ts'), 'utf8')
  assert.match(modifyingCte, /access: 'write'/u)
  assert.match(modifyingCte, /readonly email: string\n/u)
  assert.match(modifyingCte, /readonly display_name: string \| null/u)

  const domainNullability = await readFile(join(root, 'queries/domain-nullability.typed-sql.ts'), 'utf8')
  assert.match(domainNullability, /readonly maybe_value: string \| null/u)
  assert.match(domainNullability, /readonly checked_value: string \| null/u)
  assert.match(domainNullability, /readonly required_value: string\n/u)
  assert.match(domainNullability, /readonly nested_required_value: string\n/u)

  const mixedDomainPath = await readFile(join(root, 'queries/mixed-domain-path.typed-sql.ts'), 'utf8')
  assert.match(mixedDomainPath, /readonly value: string\n/u)
  assert.doesNotMatch(mixedDomainPath, /readonly value: string \| null/u)

  const rejectingReturningUse = await readFile(join(root, 'queries/rejecting-returning-use.typed-sql.ts'), 'utf8')
  assert.match(rejectingReturningUse, /readonly value: string\n/u)
  assert.doesNotMatch(rejectingReturningUse, /readonly value: string \| null/u)

  const nullExtendedInput = await readFile(join(root, 'queries/null-extended-input.typed-sql.ts'), 'utf8')
  assert.match(nullExtendedInput, /readonly value: string \| null/u)
  assert.doesNotMatch(nullExtendedInput, /OuterJoinInputs__Value/u)

  const unsafeInsertSelect = await readFile(join(root, 'queries/unsafe-insert-select.typed-sql.ts'), 'utf8')
  assert.match(unsafeInsertSelect, /readonly value: bigint \| number \| string\n/u)
  assert.doesNotMatch(unsafeInsertSelect, /readonly value: bigint \| number \| string \| null/u)
})

test('preserves exact parameter, result, JSON, relation, and schema-qualified type names', async () => {
  const root = await copyFixture()
  await writeFile(
    join(root, 'queries/exact-names.typed.sql'),
    `-- @name exactNames
select
  :user_id::text as user_id,
  :userId::text as "userId",
  jsonb_build_object(
    'snake_key', :json_value::text,
    'URL', :url_value::text,
    'n', 1,
    'big', 2::bigint,
    'ratio', 1.5::numeric,
    'numbers', :json_numbers::numeric[]
  ) as payload_json,
  :json_values::jsonb[] as json_values,
  :prototype_value::text as "__proto__"
`
  )

  const schemaPath = join(root, 'schema.sql')
  const schema = await readFile(schemaPath, 'utf8')
  await writeFile(
    schemaPath,
    `${schema}
create schema audit;
create type audit.account_status as enum ('queued', 'complete');
create type audit.control_label as enum (E'line\\nbreak');
create type audit.score_span as range (subtype = integer);
create domain audit.score as integer check (value >= 0);
create domain audit.score_list as integer[];
create table audit.events (
  event_id bigint primary key,
  event_status audit.account_status not null,
  event_statuses audit.account_status[] not null,
  numeric_values numeric[] not null,
  occurred_at timestamp with time zone not null,
  score audit.score not null,
  score_list audit.score_list not null,
  score_history audit.score[] not null,
  score_span audit.score_span not null,
  search_document tsquery not null
);
`
  )
  await writeFile(
    join(root, 'queries/audit-event.typed.sql'),
    `select
  event_id,
  event_status,
  event_statuses,
  numeric_values,
  occurred_at,
  score,
  score_list,
  score_history,
  score_span,
  search_document,
  event as whole_event,
  jsonb_build_object('score', score, 'status', event_status, 'whole_event', event) as details_json
from audit.events event
where event_id = :event_id
  and event is distinct from :event_record::audit.events
`
  )

  const result = await generateTypedSql({
    include: ['queries'],
    rootDir: root,
    codecProfile: 'node-postgres',
    schema: 'schema.sql',
  })

  assert.equal(result.statementCount, 6)
  const exact = await readFile(join(root, 'queries/exact-names.typed-sql.ts'), 'utf8')
  assert.match(
    exact,
    /parameterNames: \['user_id', 'userId', 'json_value', 'url_value', 'json_numbers', 'json_values', 'prototype_value'\]/u
  )
  assert.match(exact, /readonly user_id: string/u)
  assert.match(exact, /readonly userId: string/u)
  assert.match(exact, /readonly json_value: string/u)
  assert.match(exact, /readonly payload_json: ExactNamesJ12_payload_jsonJson/u)
  assert.match(exact, /readonly snake_key: string/u)
  assert.match(exact, /readonly URL: string/u)
  assert.match(exact, /readonly n: number/u)
  assert.match(exact, /readonly big: number/u)
  assert.match(exact, /readonly ratio: number/u)
  assert.match(exact, /readonly numbers: DbJsonSelected/u)
  assert.match(exact, /readonly json_numbers: PgArrayParameter<bigint \| number \| string> \| string/u)
  assert.match(exact, /readonly json_values: PgArrayParameter<DbJsonParameter> \| string/u)
  assert.match(exact, /readonly json_values: PgArray<DbJsonSelected> \| null/u)
  assert.match(exact, /readonly __proto__: string/u)
  assert.match(exact, /name: '__proto__',[\s\S]*?propertyName: '__proto__'/u)
  assert.match(exact, /import type \{ DbJsonParameter, DbJsonSelected, PgArray, PgArrayParameter \}/u)
  assert.doesNotMatch(exact, /import type \{ URL \}/u)

  const audit = await readFile(join(root, 'queries/audit-event.typed-sql.ts'), 'utf8')
  assert.doesNotMatch(audit, /Audit_AccountStatus/u)
  assert.match(audit, /readonly event_record: string/u)
  assert.match(audit, /readonly event_id: PgInt8String/u)
  assert.match(audit, /readonly event_status: "queued" \| "complete"/u)
  assert.match(audit, /readonly event_statuses: string/u)
  assert.match(audit, /readonly numeric_values: PgArray<number>/u)
  assert.match(audit, /readonly occurred_at: Date \| number/u)
  assert.match(audit, /readonly score: number/u)
  assert.match(audit, /readonly score_list: PgArray<number>/u)
  assert.match(audit, /readonly score_history: string/u)
  assert.match(audit, /readonly score_span: string/u)
  assert.match(audit, /readonly search_document: string/u)
  assert.match(audit, /readonly whole_event: string/u)
  assert.match(audit, /readonly details_json: AuditEventJ12_details_jsonJson/u)
  assert.match(audit, /readonly score: number/u)
  assert.match(audit, /readonly status: "queued" \| "complete"/u)
  assert.match(audit, /readonly whole_event: DbJsonSelected/u)
  assert.doesNotMatch(audit, /AuditScore|AuditScoreSpan/u)

  const catalog = await readFile(join(root, 'postgres-typed-sql.types.ts'), 'utf8')
  assert.match(catalog, /export type AccountStatus = "active" \| "suspended"/u)
  assert.match(catalog, /export type Audit_AccountStatus = "queued" \| "complete"/u)
  assert.match(catalog, /export type Audit_ControlLabel = "line\\nbreak"/u)
  assert.match(catalog, /export interface Audit_Events \{[\s\S]*?readonly event_id: PgInt8String/u)
  assert.match(catalog, /readonly event_statuses: string/u)
  assert.match(catalog, /readonly numeric_values: PgArray<number>/u)
  assert.match(catalog, /readonly occurred_at: Date \| number/u)
  assert.match(catalog, /readonly score: number/u)
  assert.match(catalog, /readonly score_list: PgArray<number>/u)
  assert.match(catalog, /readonly score_history: string/u)
  assert.match(catalog, /readonly score_span: string/u)
  assert.match(catalog, /readonly search_document: string/u)
  assert.doesNotMatch(catalog, /export type AuditScore/u)
  assert.match(catalog, /readonly "audit\.events": Audit_Events/u)
})

test('rejects duplicate, reserved, and colliding generated names before emission', async () => {
  const invalidSources = [
    {
      error: /duplicate result column name "duplicate"/u,
      file: 'duplicate-result.typed.sql',
      sql: 'select 1 as duplicate, 2 as duplicate\n',
    },
    {
      error: /@name: "class" is not a legal non-reserved TypeScript binding/u,
      file: 'reserved-statement.typed.sql',
      sql: '-- @name class\nselect 1\n',
    },
    {
      error: /@name createTypedSqlStatement collides with the generated runtime import/u,
      file: 'runtime-import-collision.typed.sql',
      sql: '-- @name createTypedSqlStatement\nselect 1\n',
    },
    {
      error: /duplicate @param value/u,
      file: 'duplicate-parameter.typed.sql',
      sql: '-- @param value text\n-- @param value integer\nselect :value\n',
    },
  ] as const

  for (const invalid of invalidSources) {
    const root = await copyFixture()
    await writeFile(join(root, 'queries', invalid.file), invalid.sql)
    await assert.rejects(
      generateTypedSql({
        include: ['queries'],
        rootDir: root,
        codecProfile: 'node-postgres',
        schema: 'schema.sql',
      }),
      invalid.error
    )
  }

  for (const scalarImport of ['createTypedSqlStatement', 'query']) {
    const root = await createMinimalFixture('select 1;\n', 'select 1::integer as value\n')
    const codecProfile = definePostgresCodecProfile({
      extends: 'node-postgres',
      name: `colliding-${scalarImport}`,
      resultType({ decoderType }, fallback) {
        return decoderType.pgTypeOid === 23
          ? postgresTypeScriptType(scalarImport, { scalarImports: [scalarImport] })
          : fallback()
      },
    })
    await assert.rejects(
      generateTypedSql({
        codecProfile,
        include: ['queries'],
        rootDir: root,
        schema: 'schema.sql',
      }),
      new RegExp(
        `generated TypeScript binding ${scalarImport} for postgres-typed-sql scalar type import collides with ${
          scalarImport === 'createTypedSqlStatement' ? 'generated runtime import' : 'exported statement constant'
        }`,
        'u'
      )
    )
  }

  const root = await copyFixture()
  const schemaPath = join(root, 'schema.sql')
  const schema = await readFile(schemaPath, 'utf8')
  await writeFile(
    schemaPath,
    `${schema}
create schema a;
create type public.a_status as enum ('public');
create type a.status as enum ('schema');
`
  )
  await generateTypedSql({
    include: ['queries'],
    rootDir: root,
    codecProfile: 'node-postgres',
    schema: 'schema.sql',
  })
  const injectiveCatalog = await readFile(join(root, 'postgres-typed-sql.types.ts'), 'utf8')
  assert.match(injectiveCatalog, /export type AStatus = "public"/u)
  assert.match(injectiveCatalog, /export type A_Status = "schema"/u)

  const importCollisionRoot = await copyFixture()
  const importCollisionSchemaPath = join(importCollisionRoot, 'schema.sql')
  const importCollisionSchema = await readFile(importCollisionSchemaPath, 'utf8')
  await writeFile(
    importCollisionSchemaPath,
    `${importCollisionSchema}
create type public.collision_params as enum ('one');
`
  )
  await writeFile(
    join(importCollisionRoot, 'queries/collision.typed.sql'),
    "select 'one'::public.collision_params as value\n"
  )
  await generateTypedSql({
    include: ['queries'],
    rootDir: importCollisionRoot,
    codecProfile: 'node-postgres',
    schema: 'schema.sql',
  })
  assert.match(
    await readFile(join(importCollisionRoot, 'queries/collision.typed-sql.ts'), 'utf8'),
    /readonly value: "one"/u
  )

  const dateCatalogCollisionRoot = await copyFixture()
  const dateCatalogSchemaPath = join(dateCatalogCollisionRoot, 'schema.sql')
  const dateCatalogSchema = await readFile(dateCatalogSchemaPath, 'utf8')
  await writeFile(dateCatalogSchemaPath, `${dateCatalogSchema}\ncreate type public.date as enum ('today');\n`)
  await assert.rejects(
    generateTypedSql({
      include: ['queries'],
      rootDir: dateCatalogCollisionRoot,
      codecProfile: 'node-postgres',
      schema: 'schema.sql',
    }),
    /generated TypeScript binding Date for enum public\.date collides with ambient TypeScript type/u
  )

  const byteaCatalogCollisionRoot = await copyFixture()
  const byteaCatalogSchemaPath = join(byteaCatalogCollisionRoot, 'schema.sql')
  const byteaCatalogSchema = await readFile(byteaCatalogSchemaPath, 'utf8')
  await writeFile(
    byteaCatalogSchemaPath,
    `${byteaCatalogSchema}
create type public.uint8_array as enum ('bytes');
create table public.bytea_probe (payload bytea);
`
  )
  await assert.rejects(
    generateTypedSql({
      include: ['queries'],
      rootDir: byteaCatalogCollisionRoot,
      codecProfile: 'node-postgres',
      schema: 'schema.sql',
    }),
    /generated TypeScript binding Uint8Array for enum public\.uint8_array collides with ambient TypeScript type/u
  )

  const dateStatementCollisionRoot = await createMinimalFixture(
    `create type public.date as enum ('today');
create table public.readings (kind public.date not null);
`,
    'select kind, now()::timestamp with time zone as measured_at from public.readings\n'
  )
  await generateTypedSql({
    include: ['queries'],
    rootDir: dateStatementCollisionRoot,
    codecProfile: 'node-postgres',
    schema: 'schema.sql',
  })
  const dateStatement = await readFile(join(dateStatementCollisionRoot, 'queries/query.typed-sql.ts'), 'utf8')
  assert.match(dateStatement, /readonly kind: "today"/u)
  assert.match(dateStatement, /readonly measured_at: Date \| number/u)
})

test('reserves only TypeScript utility, ambient, and scalar bindings used by each generated file', async () => {
  const unusedCollisionRoot = await createMinimalFixture(
    `create type public.pg_int8_string as enum ('scalar');
create type public.record as enum ('utility');
create type public.date as enum ('ambient_date');
create type public.uint8_array as enum ('ambient_bytes');
`,
    `select
  :utility_kind::public.record as utility_kind,
  :date_kind::public.date as date_kind,
  :bytes_kind::public.uint8_array as bytes_kind
`
  )
  await generateTypedSql({
    include: ['queries'],
    rootDir: unusedCollisionRoot,
    codecProfile: 'node-postgres',
    schema: 'schema.sql',
  })
  const unusedCollisionOutput = await readFile(join(unusedCollisionRoot, 'queries/query.typed-sql.ts'), 'utf8')
  assert.doesNotMatch(unusedCollisionOutput, /import type/u)
  assert.match(unusedCollisionOutput, /readonly utility_kind: "utility" \| null/u)
  assert.match(unusedCollisionOutput, /readonly date_kind: "ambient_date" \| null/u)
  assert.match(unusedCollisionOutput, /readonly bytes_kind: "ambient_bytes" \| null/u)
  assert.doesNotMatch(unusedCollisionOutput, /PgInt8String/u)
  assert.doesNotMatch(unusedCollisionOutput, /Record<string, never>/u)

  const cases = [
    {
      schema: `create type public.pg_int8_string as enum ('scalar');
`,
      sql: 'select :kind::public.pg_int8_string as kind, 1::bigint as count\n',
    },
    {
      schema: `create type public.pg_array_parameter as enum ('scalar');
`,
      sql: 'select :kind::public.pg_array_parameter as kind, cardinality(:values::integer[]) as count\n',
    },
    {
      schema: `create type public.record as enum ('utility');
`,
      sql: "select 'utility'::public.record as kind\n",
    },
    {
      schema: `create type public.date as enum ('ambient_date');
`,
      sql: "select 'ambient_date'::public.date as kind, now() as observed_at\n",
    },
    {
      schema: `create type public.uint8_array as enum ('ambient_bytes');
`,
      sql: "select 'ambient_bytes'::public.uint8_array as kind, decode('', 'hex') as payload\n",
    },
  ] as const

  for (const collision of cases) {
    const root = await createMinimalFixture(collision.schema, collision.sql)
    await generateTypedSql({
      include: ['queries'],
      rootDir: root,
      codecProfile: 'node-postgres',
      schema: 'schema.sql',
    })
  }

  const catalogScalarCollisionRoot = await createMinimalFixture(
    `create type public.pg_int8_string as enum ('scalar');
create table public.binding_values (id bigint not null);
`,
    'select 1 as value\n'
  )
  await assert.rejects(
    generateTypedSql({
      include: ['queries'],
      rootDir: catalogScalarCollisionRoot,
      codecProfile: 'node-postgres',
      schema: 'schema.sql',
    }),
    /generated TypeScript binding PgInt8String for enum public\.pg_int8_string collides with postgres-typed-sql scalar type import/u
  )
})

test('encodes arbitrary PostgreSQL identifiers injectively and renders complete catalogs', async () => {
  const identifiers = ['foo', 'foo_bar', 'fooBar', 'Foo', '_foo', 'foo_1', 'foo$1', 'foo-bar', 'λ']
  const segments = identifiers.map(postgresIdentifierTypeSegment)
  assert.equal(new Set(segments).size, identifiers.length)
  for (const segment of segments) {
    assert.doesNotThrow(() => assertTypeScriptBindingIdentifier(segment, 'test identifier'))
  }
  assert.equal(postgresIdentifierTypeSegment('account_status'), 'AccountStatus')
  assert.equal(postgresIdentifierTypeSegment('order-items'), '$Qorder$2d$items')
  assert.notEqual(postgresNamedTypeBinding('public', 'audit_events'), postgresNamedTypeBinding('audit', 'events'))
  assert.notEqual(
    postgresNamedTypeBinding('audit', 'events_status'),
    postgresCheckConstraintTypeBinding('public', 'audit_events', 'status')
  )

  const root = await createMinimalFixture(
    `create schema "a.b";
create schema a;
create type public."state-code" as enum ('ok');
create table public."order-items" (
  id bigint,
  "display-name" text,
  state public."state-code" not null
);
create table "a.b".c (d text check (d in ('left')));
create table a."b.c" (d text check (d in ('right')));
create table public.empty_table ();
`,
    'select id, "display-name", state from public."order-items"\n'
  )
  await generateTypedSql({
    include: ['queries'],
    imports: {
      runtime: "package'quoted/typed-sql",
      scalars: "package'quoted/pg-scalars",
    },
    rootDir: root,
    codecProfile: 'node-postgres',
    schema: 'schema.sql',
    typesOutput: "types'o.ts",
  })

  const catalog = await readFile(join(root, "types'o.ts"), 'utf8')
  const query = await readFile(join(root, 'queries/query.typed-sql.ts'), 'utf8')
  assert.match(catalog, /export type \$Qstate\$2d\$code = "ok"/u)
  assert.match(catalog, /export interface \$Qorder\$2d\$items/u)
  assert.match(catalog, /export type EmptyTable = \{ readonly \[key: string\]: never \}/u)
  assert.match(catalog, /readonly empty_table: EmptyTable/u)
  assert.match(catalog, /export type \$Qa\$2e\$b_C__D = "left"/u)
  assert.match(catalog, /export type A_\$Qb\$2e\$c__D = "right"/u)
  assert.ok(catalog.includes('readonly "\\"a.b\\".c": $Qa$2e$b_C'))
  assert.ok(catalog.includes('readonly "a.\\"b.c\\"": A_$Qb$2e$c'))
  assert.match(query, /readonly state: "ok"/u)
  assert.doesNotMatch(query, /types'o\.js/u)
  assert.ok(query.includes('from "package\'quoted/typed-sql"'))
  assert.ok(query.includes('from "package\'quoted/pg-scalars"'))
  assert.ok(catalog.includes('from "package\'quoted/pg-scalars"'))
})

test('inlines excluded-schema enums instead of referencing undeclared catalog aliases', async () => {
  const root = await createMinimalFixture(
    `create type pg_catalog.review_enum as enum ('a', 'b');
create domain public.review_enum_domain as pg_catalog.review_enum;
create table public.review_rows (
  direct_value pg_catalog.review_enum not null,
  domain_value public.review_enum_domain not null
);
`,
    'select direct_value, domain_value from public.review_rows\n'
  )

  await generateTypedSql({
    include: ['queries'],
    rootDir: root,
    codecProfile: 'node-postgres',
    schema: 'schema.sql',
  })

  const catalog = await readFile(join(root, 'postgres-typed-sql.types.ts'), 'utf8')
  assert.match(catalog, /readonly direct_value: "a" \| "b"/u)
  assert.match(catalog, /readonly domain_value: "a" \| "b"/u)
  assert.doesNotMatch(catalog, /PgCatalog_ReviewEnum/u)
})

test('uses authoritative JSON-cast facts and refuses nullable overrides of proven rejecting targets', async () => {
  const jsonCastRoot = await createMinimalFixture(
    `create type public.json_mood as enum ('sad', 'ok');
create function public.json_mood_to_json(public.json_mood)
returns json
language sql immutable strict
as $$ select json_build_object('mood', $1::text) $$;
create cast (public.json_mood as json)
with function public.json_mood_to_json(public.json_mood)
as assignment;
`,
    `select jsonb_build_object('value', 'ok'::public.json_mood) as payload
`
  )
  await generateTypedSql({
    include: ['queries'],
    rootDir: jsonCastRoot,
    codecProfile: 'node-postgres',
    schema: 'schema.sql',
  })
  const jsonCastOutput = await readFile(join(jsonCastRoot, 'queries/query.typed-sql.ts'), 'utf8')
  assert.match(jsonCastOutput, /readonly value: DbJsonSelected/u)
  assert.match(jsonCastOutput, /import type \{ DbJsonSelected \}/u)
  assert.doesNotMatch(jsonCastOutput, /readonly value: JsonMood/u)

  const rejectingOverrideRoot = await createMinimalFixture(
    'create table public.required_values (value text not null);\n',
    `-- @param value text?
insert into public.required_values(value) values (:value)
`
  )
  await assert.rejects(
    generateTypedSql({
      include: ['queries'],
      rootDir: rejectingOverrideRoot,
      codecProfile: 'node-postgres',
      schema: 'schema.sql',
    }),
    /@param value cannot be nullable because PostgreSQL proves that one of its uses rejects NULL/u
  )
})

test('enforces required-nonnull contexts while keeping opaque and transformed uses overridable', async () => {
  const root = await createMinimalFixture(
    `create table public.null_admission_sample (value integer);
create procedure public.accept_null(value integer)
language plpgsql
as $$ begin null; end $$;
`,
    `-- @param offset bigint?
select sum(value) over (rows between :offset preceding and current row) as total
from (values (1), (2)) input(value)
`
  )
  const config = {
    include: ['queries'],
    rootDir: root,
    codecProfile: 'node-postgres' as const,
    schema: 'schema.sql',
  }
  const queryFile = join(root, 'queries/query.typed.sql')
  const outputFile = join(root, 'queries/query.typed-sql.ts')

  await assert.rejects(
    generateTypedSql(config),
    /@param offset cannot be nullable because PostgreSQL proves that one of its uses rejects NULL/u
  )

  await writeFile(
    queryFile,
    `-- @param offset bigint?
select sum(value) over (rows between coalesce(:offset, 0) preceding and current row) as total
from (values (1), (2)) input(value)
`
  )
  await generateTypedSql(config)
  let output = await readFile(outputFile, 'utf8')
  assert.match(output, /readonly offset: [^\n]+ \| null/u)
  assert.match(output, /name: 'offset',[\s\S]*?nullable: true/u)

  await writeFile(
    queryFile,
    `-- @param percentage real?
select value from public.null_admission_sample tablesample system (:percentage)
`
  )
  await assert.rejects(
    generateTypedSql(config),
    /@param percentage cannot be nullable because PostgreSQL proves that one of its uses rejects NULL/u
  )

  await writeFile(
    queryFile,
    `-- @param percentage real?
select value
from public.null_admission_sample tablesample system (coalesce(:percentage, 100))
`
  )
  await generateTypedSql(config)
  output = await readFile(outputFile, 'utf8')
  assert.match(output, /readonly percentage: bigint \| number \| string \| null/u)
  assert.match(output, /name: 'percentage',[\s\S]*?nullable: true/u)

  await writeFile(
    queryFile,
    `-- @param value integer
call public.accept_null(:value)
`
  )
  await generateTypedSql(config)
  output = await readFile(outputFile, 'utf8')
  assert.match(output, /readonly value: bigint \| number \| string/u)
  assert.doesNotMatch(output, /readonly value: bigint \| number \| string \| null/u)
  assert.match(output, /name: 'value',[\s\S]*?nullable: false/u)

  await writeFile(
    queryFile,
    `-- @param value integer?
call public.accept_null(:value)
`
  )
  await generateTypedSql(config)
  output = await readFile(outputFile, 'utf8')
  assert.match(output, /readonly value: bigint \| number \| string \| null/u)
  assert.match(output, /name: 'value',[\s\S]*?nullable: true/u)
})

test('narrows CHECK parameters only for direct value-preserving assignments', async () => {
  const root = await createMinimalFixture(
    "create table public.checked_values (value text not null check (value in ('A', 'B')));\n",
    `insert into public.checked_values(value) values (upper(:value))
`
  )
  const config = {
    include: ['queries'],
    rootDir: root,
    codecProfile: 'node-postgres' as const,
    schema: 'schema.sql',
  }
  await generateTypedSql(config)
  let output = await readFile(join(root, 'queries/query.typed-sql.ts'), 'utf8')
  assert.match(output, /readonly value: string/u)
  assert.doesNotMatch(output, /readonly value: CheckedValues__Value/u)

  await writeFile(
    join(root, 'queries/query.typed.sql'),
    `-- @param value text?
insert into public.checked_values(value) values (coalesce(:value, 'A'))
`
  )
  await generateTypedSql(config)
  output = await readFile(join(root, 'queries/query.typed-sql.ts'), 'utf8')
  assert.match(output, /readonly value: string \| null/u)
  assert.doesNotMatch(output, /readonly value: CheckedValues__Value/u)
})

test('does not narrow CHECK parameters across rewriting triggers or miss INTERSECT right-side lineage', async () => {
  const root = await createMinimalFixture(
    `create table public.trigger_checked_values (
  value text check (value in ('allowed'))
);
create function public.force_allowed_trigger() returns trigger
language plpgsql as $$
begin
  new.value := 'allowed';
  return new;
end
$$;
create trigger force_allowed before insert on public.trigger_checked_values
for each row execute function public.force_allowed_trigger();
create table public.intersect_accounts (
  email text not null,
  display_name text
);
`,
    `insert into public.trigger_checked_values(value) values (:value)
`
  )
  const config = {
    include: ['queries'],
    rootDir: root,
    codecProfile: 'node-postgres' as const,
    schema: 'schema.sql',
  }

  await generateTypedSql(config)
  const outputFile = join(root, 'queries/query.typed-sql.ts')
  let output = await readFile(outputFile, 'utf8')
  assert.match(output, /readonly value: string/u)
  assert.doesNotMatch(output, /readonly value: TriggerCheckedValues__Value/u)

  await writeFile(
    join(root, 'queries/query.typed.sql'),
    `insert into public.intersect_accounts(email, display_name)
select null::text, :value::text
intersect
select :value::text, :value::text
`
  )
  await generateTypedSql(config)
  output = await readFile(outputFile, 'utf8')
  assert.match(output, /readonly value: string/u)
  assert.doesNotMatch(output, /readonly value: string \| null/u)
})

test('does not apply textual CHECK aliases to transformed driver or JSON representations', async () => {
  const root = await createMinimalFixture(
    "create table public.char_values (value char(3) check (value = 'A'));\n",
    `select value, jsonb_build_object('value', value) as payload
from public.char_values
`
  )
  await generateTypedSql({
    include: ['queries'],
    rootDir: root,
    codecProfile: 'node-postgres',
    schema: 'schema.sql',
  })

  const output = await readFile(join(root, 'queries/query.typed-sql.ts'), 'utf8')
  assert.match(output, /readonly value: string \| null/u)
  assert.match(output, /readonly payload: QueryJ7_payloadJson/u)
  assert.match(output, /readonly value: string \| null/u)
  assert.doesNotMatch(output, /readonly value: CharValues__Value/u)

  const catalog = await readFile(join(root, 'postgres-typed-sql.types.ts'), 'utf8')
  assert.match(catalog, /readonly value: string \| null/u)
  assert.doesNotMatch(catalog, /readonly value: CharValues__Value/u)
})

test('keeps strict expressions nullable and CHECK refinements representation-preserving', async () => {
  const root = await createMinimalFixture(
    `create function public.always_null(integer)
returns text
language sql strict
as $$ select null::text $$;
create table public.checked_text_values (value text check (value in ('01')));
`,
    `select
  public.always_null(1) as function_value,
  1 = any(array[null]::integer[]) as operator_value,
  value::integer::text as transformed_value
from public.checked_text_values
`
  )
  const config = {
    include: ['queries'],
    rootDir: root,
    codecProfile: 'node-postgres' as const,
    schema: 'schema.sql',
  }
  await generateTypedSql(config)

  let output = await readFile(join(root, 'queries/query.typed-sql.ts'), 'utf8')
  assert.match(output, /readonly function_value: string \| null/u)
  assert.match(output, /readonly operator_value: boolean \| null/u)
  assert.match(output, /readonly transformed_value: string \| null/u)
  assert.doesNotMatch(output, /readonly transformed_value: CheckedTextValues__Value/u)

  await writeFile(
    join(root, 'queries/query.typed.sql'),
    `-- @param value text
insert into public.checked_text_values(value) values (:value::integer::text)
`
  )
  await generateTypedSql(config)
  output = await readFile(join(root, 'queries/query.typed-sql.ts'), 'utf8')
  assert.match(output, /readonly value: string/u)
  assert.doesNotMatch(output, /readonly value: CheckedTextValues__Value/u)
})

test('renders nullable and union JSON aggregate element types with array precedence', async () => {
  const root = await createMinimalFixture(
    'create table public.json_values (value text);\n',
    `select
  jsonb_agg(value) as text_values,
  jsonb_agg(1.5::numeric) as numeric_values,
  coalesce(
    jsonb_agg(jsonb_build_object('value', value)) filter (where false),
    '[]'::jsonb
  ) as object_values
from public.json_values
`
  )
  await generateTypedSql({
    include: ['queries'],
    rootDir: root,
    codecProfile: 'node-postgres',
    schema: 'schema.sql',
  })

  const output = await readFile(join(root, 'queries/query.typed-sql.ts'), 'utf8')
  assert.match(output, /readonly text_values: readonly \(string \| null\)\[\] \| null/u)
  assert.match(output, /readonly numeric_values: readonly \(number \| string\)\[\] \| null/u)
  assert.match(output, /readonly object_values: readonly \(QueryJ13_object_valuesJsonJ7_element\)\[\]/u)
  assert.doesNotMatch(output, /readonly object_values: DbJsonSelected/u)
})

test('generates correlated and set-operation CHECK result refinements soundly', async () => {
  const root = await createMinimalFixture(
    `create table public.outer_correlation (
  value text check (value in ('outer_only'))
);
create table public.inner_correlation (
  value text not null check (value in ('inner_only'))
);
create table public.check_left (
  value text check (value in ('left_only', 'shared'))
);
create table public.check_right (
  value text check (value in ('right_only', 'shared'))
);
create table public.check_unknown (value text);
`,
    `select lateral_value.value
from public.outer_correlation outer_row
cross join lateral (
  select outer_row.value
  from public.inner_correlation inner_row
) lateral_value
`
  )
  const config = {
    include: ['queries'],
    rootDir: root,
    codecProfile: 'node-postgres' as const,
    schema: 'schema.sql',
  }
  const queryFile = join(root, 'queries/query.typed.sql')
  const outputFile = join(root, 'queries/query.typed-sql.ts')
  const generate = async (sql: string): Promise<string> => {
    await writeFile(queryFile, `${sql}\n`)
    await generateTypedSql(config)
    return readFile(outputFile, 'utf8')
  }

  await generateTypedSql(config)
  let output = await readFile(outputFile, 'utf8')
  assert.match(output, /readonly value: 'outer_only' \| null/u)
  assert.doesNotMatch(output, /readonly value: 'inner_only'/u)

  output = await generate(`select value from public.check_left
union
select value from public.check_right`)
  assert.match(output, /readonly value: \('left_only' \| 'shared'\) \| \('right_only' \| 'shared'\) \| null/u)
  assert.doesNotMatch(output, /import type/u)

  for (const sql of [
    `select value from public.check_left
union all
select value from public.check_unknown`,
    `select value from public.check_unknown
union
select value from public.check_left`,
  ]) {
    output = await generate(sql)
    assert.match(output, /readonly value: string \| null/u)
    assert.doesNotMatch(output, /'left_only' \| 'shared'/u)
  }

  output = await generate(`select value from public.check_left
intersect all
select value from public.check_right`)
  assert.match(output, /readonly value: \('left_only' \| 'shared'\) & \('right_only' \| 'shared'\) \| null/u)

  for (const sql of [
    `select value from public.check_left
intersect
select value from public.check_unknown`,
    `select value from public.check_unknown
intersect all
select value from public.check_left`,
  ]) {
    output = await generate(sql)
    assert.match(output, /readonly value: 'left_only' \| 'shared' \| null/u)
  }

  output = await generate(`select value from public.check_left
except all
select value from public.check_right`)
  assert.match(output, /readonly value: 'left_only' \| 'shared' \| null/u)

  output = await generate(`select left_value.value from public.check_left left_value
union all
select right_value.value from public.check_right right_value`)
  assert.match(output, /readonly value: \('left_only' \| 'shared'\) \| \('right_only' \| 'shared'\) \| null/u)

  output = await generate(`(select value from public.check_left
 union
 select value from public.check_right)
intersect
select value from public.check_left`)
  assert.match(
    output,
    /readonly value: \(\('left_only' \| 'shared'\) \| \('right_only' \| 'shared'\)\) & \('left_only' \| 'shared'\) \| null/u
  )

  output = await generate(`select lateral_value.value, lateral_value.nullable_value, lateral_value.payload
from (
  select
    value,
    null::text as nullable_value,
    jsonb_build_object('outer_left', value) as payload
  from public.check_left
  union all
  select
    value,
    'present'::text as nullable_value,
    jsonb_build_object('outer_right', value) as payload
  from public.check_right
) outer_row
cross join lateral (
  select outer_row.value, outer_row.nullable_value, outer_row.payload
  from (
    select
      value,
      'inner-not-null'::text as nullable_value,
      jsonb_build_object('inner', value) as payload
    from public.inner_correlation
  ) unrelated_inner
) lateral_value`)
  assert.match(output, /readonly value: \('left_only' \| 'shared'\) \| \('right_only' \| 'shared'\) \| null/u)
  assert.doesNotMatch(output, /readonly value: 'inner_only'/u)
  assert.match(output, /readonly nullable_value: string \| null/u)
  assert.match(output, /interface QueryJ7_payloadJsonJ12_alternative1 \{[\s\S]*readonly outer_left:/u)
  assert.match(output, /interface QueryJ7_payloadJsonJ12_alternative2 \{[\s\S]*readonly outer_right:/u)
  assert.doesNotMatch(output, /readonly inner:/u)
})

test('renders every inferable JSON object alternative from set-operation outputs', async () => {
  const root = await createMinimalFixture(
    'select 1;\n',
    `select payload
from (
  select jsonb_build_object('a', 1) as payload
  union all
  select jsonb_build_object('b', 'two'::text)
) source
`
  )
  await generateTypedSql({
    include: ['queries'],
    rootDir: root,
    codecProfile: 'node-postgres',
    schema: 'schema.sql',
  })

  const output = await readFile(join(root, 'queries/query.typed-sql.ts'), 'utf8')
  assert.match(output, /interface QueryJ7_payloadJsonJ12_alternative1 \{[\s\S]*readonly a: number/u)
  assert.match(output, /interface QueryJ7_payloadJsonJ12_alternative2 \{[\s\S]*readonly b: 'two'/u)
  assert.match(output, /readonly payload: QueryJ7_payloadJsonJ12_alternative1 \| QueryJ7_payloadJsonJ12_alternative2/u)
  assert.doesNotMatch(output, /readonly payload: DbJsonSelected/u)
})

test('generates build-object contracts only from proven complete argument lists', async () => {
  const root = await createMinimalFixture(
    'select 1;\n',
    `select jsonb_build_object(variadic array['answer', '42']) as payload
`
  )
  const config = {
    include: ['queries'],
    rootDir: root,
    codecProfile: 'node-postgres' as const,
    schema: 'schema.sql',
  }
  const queryFile = join(root, 'queries/query.typed.sql')
  const outputFile = join(root, 'queries/query.typed-sql.ts')

  await generateTypedSql(config)
  let output = await readFile(outputFile, 'utf8')
  assert.match(output, /interface QueryJ7_payloadJson \{[\s\S]*readonly answer: '42'/u)
  assert.match(output, /readonly payload: QueryJ7_payloadJson/u)
  assert.doesNotMatch(output, /readonly payload: QueryJ7_payloadJson \| null/u)
  assert.doesNotMatch(output, /readonly payload: DbJsonSelected/u)

  await writeFile(
    queryFile,
    `-- @param entries text[]
select jsonb_build_object(variadic :entries) as payload
`
  )
  await generateTypedSql(config)
  output = await readFile(outputFile, 'utf8')
  assert.match(output, /readonly payload: DbJsonSelected \| null/u)
  assert.doesNotMatch(output, /interface QueryJ7_payloadJson/u)

  await writeFile(queryFile, 'select jsonb_build_object(variadic null::text[]) as payload\n')
  await generateTypedSql(config)
  output = await readFile(outputFile, 'utf8')
  assert.match(output, /readonly payload: DbJsonSelected \| null/u)

  await writeFile(queryFile, "select jsonb_build_object('answer', null::text) as payload\n")
  await generateTypedSql(config)
  output = await readFile(outputFile, 'utf8')
  assert.match(output, /interface QueryJ7_payloadJson \{[\s\S]*readonly answer: string \| null/u)
  assert.match(output, /readonly payload: QueryJ7_payloadJson\n/u)
  assert.doesNotMatch(output, /readonly payload: QueryJ7_payloadJson \| null/u)

  await writeFile(queryFile, "select jsonb_build_object('unpaired') as payload\n")
  await generateTypedSql(config)
  output = await readFile(outputFile, 'utf8')
  assert.match(output, /readonly payload: DbJsonSelected/u)
  assert.doesNotMatch(output, /interface QueryJ7_payloadJson/u)
})

test('generates conservative no-result CALL metadata and rejects other utilities', async () => {
  const root = await createMinimalFixture(
    `create procedure public.generator_no_result(value integer)
language plpgsql
as $$ begin null; end $$;
create procedure public.generator_out_result(input_value integer, out output_value integer)
language plpgsql
as $$ begin output_value := input_value * 2; end $$;
`,
    `-- @param value integer
call public.generator_no_result(:value)
`
  )
  const config = {
    include: ['queries'],
    rootDir: root,
    codecProfile: 'node-postgres' as const,
    schema: 'schema.sql',
  }
  const queryFile = join(root, 'queries/query.typed.sql')
  const outputFile = join(root, 'queries/query.typed-sql.ts')

  await generateTypedSql(config)
  const output = await readFile(outputFile, 'utf8')
  assert.match(output, /export type QueryRow = Record<string, never>/u)
  assert.match(output, /access: 'write'/u)
  assert.match(output, /cardinality: 'none'/u)
  assert.match(output, /rowBounds: \{ min: 0, max: 0, proof: 'no_result_columns' \}/u)

  for (const [sql, error] of [
    ['show timezone\n', /PostgreSQL SHOW utility statements are not supported/u],
    ['explain select 1\n', /PostgreSQL EXPLAIN utility statements are not supported/u],
    ['create table public.generator_unsupported (id integer)\n', /PostgreSQL OTHER utility statements/u],
    ['call public.generator_out_result(2, null)\n', /CALL statements with result rows are not supported/u],
    ['fetch all from missing_cursor\n', /PostgreSQL FETCH utility statements are not supported/u],
    ['execute missing_statement\n', /PostgreSQL EXECUTE utility statements are not supported/u],
  ] as const) {
    await writeFile(queryFile, sql)
    await assert.rejects(generateTypedSql(config), error)
  }
})

test('terminates recursive CTE nullability inference from pass-through seed facts', async () => {
  const root = await createMinimalFixture(
    'select 1;\n',
    `with recursive walk(value, depth) as (
  select 1, 1
  union all
  select value, depth + 1
  from walk
  where depth < 3
)
select value from walk
`
  )
  const config = {
    include: ['queries'],
    rootDir: root,
    codecProfile: 'node-postgres' as const,
    schema: 'schema.sql',
  }
  const queryFile = join(root, 'queries/query.typed.sql')
  const outputFile = join(root, 'queries/query.typed-sql.ts')

  await generateTypedSql(config)
  let output = await readFile(outputFile, 'utf8')
  assert.match(output, /readonly value: number\n/u)
  assert.doesNotMatch(output, /readonly value: number \| null/u)

  await writeFile(
    queryFile,
    `with recursive walk(value, depth) as (
  select null::integer, 1
  union all
  select value, depth + 1
  from walk
  where depth < 3
)
select value from walk
`
  )
  await generateTypedSql(config)
  output = await readFile(outputFile, 'utf8')
  assert.match(output, /readonly value: number \| null/u)
})

test('encodes arbitrary JSON result and field names only in generated type bindings', async () => {
  const root = await createMinimalFixture(
    'select 1;\n',
    `select jsonb_build_object('outer-key', jsonb_build_object('inner key', 1, '', 2)) as "payload-data"
`
  )
  await generateTypedSql({
    include: ['queries'],
    rootDir: root,
    codecProfile: 'node-postgres',
    schema: 'schema.sql',
  })

  const output = await readFile(join(root, 'queries/query.typed-sql.ts'), 'utf8')
  assert.match(output, /readonly "payload-data": QueryJ15_payload\$2d\$dataJson/u)
  assert.match(output, /readonly "outer-key": QueryJ15_payload\$2d\$dataJsonJ12_outer\$2d\$key/u)
  assert.match(output, /readonly "inner key": number/u)
  assert.match(output, /readonly "": number/u)
})

test('models the last value for duplicate PostgreSQL JSON object keys', async () => {
  const root = await createMinimalFixture(
    'select 1;\n',
    `select json_build_object('value', 1, 'value', 'last'::text) as payload
`
  )
  await generateTypedSql({
    include: ['queries'],
    rootDir: root,
    codecProfile: 'node-postgres',
    schema: 'schema.sql',
  })

  const output = await readFile(join(root, 'queries/query.typed-sql.ts'), 'utf8')
  assert.match(output, /readonly value: 'last'/u)
  assert.doesNotMatch(output, /readonly value: number/u)
})

test('maps configured result and structured JSON names to camel case', async () => {
  const root = await createMinimalFixture(
    'select 1;\n',
    `select
  1 as account_id,
  jsonb_build_object(
    'display_name', 'Reader'::text,
    'recent_posts', jsonb_agg(jsonb_build_object('post_id', 2, 'published_at', null::text)),
    'webhook_payload', '{"event_type":"account.created"}'::jsonb
  ) as account_details
from (values (1)) source(n)
`
  )
  await generateTypedSql({
    include: ['queries'],
    naming: {
      resultColumns: 'camelCase',
      structuredJsonFields: 'camelCase',
    },
    rootDir: root,
    codecProfile: 'node-postgres',
    schema: 'schema.sql',
  })

  const output = await readFile(join(root, 'queries/query.typed-sql.ts'), 'utf8')
  assert.match(output, /readonly accountId: number/u)
  assert.match(output, /readonly accountDetails: QueryJ15_account_detailsJson/u)
  assert.match(output, /readonly displayName: 'Reader'/u)
  assert.match(output, /readonly recentPosts: readonly/u)
  assert.match(output, /readonly postId: number/u)
  assert.match(output, /readonly publishedAt: string \| null/u)
  assert.match(output, /readonly webhookPayload: DbJsonSelected/u)
  assert.match(output, /name: 'account_id',[\s\S]*?propertyName: 'accountId'/u)
  assert.match(
    output,
    /jsonMapping: \{"fields":\[\{"name":"display_name","propertyName":"displayName"\},\{"mapping":\{"arrayElement":\{"fields":\[\{"name":"post_id","propertyName":"postId"\},\{"name":"published_at","propertyName":"publishedAt"\}\]\}\},"name":"recent_posts","propertyName":"recentPosts"\},\{"name":"webhook_payload","propertyName":"webhookPayload"\}\]\}/u
  )
})

test('maps JSON array-from and object-from derived row shapes to camel case', async () => {
  const root = await createMinimalFixture(
    'select 1;\n',
    `select
  coalesce(
    (
      select jsonb_agg(nested_row)
      from (
        select 1 as account_id, 'Reader'::text as display_name
      ) nested_row
    ),
    '[]'::jsonb
  ) as account_rows,
  (
    select to_jsonb(nested_row)
    from (
      select 2 as account_id, 'Writer'::text as display_name
    ) nested_row
  ) as account_row
`
  )
  await generateTypedSql({
    include: ['queries'],
    naming: {
      resultColumns: 'camelCase',
      structuredJsonFields: 'camelCase',
    },
    rootDir: root,
    codecProfile: 'node-postgres',
    schema: 'schema.sql',
  })

  const output = await readFile(join(root, 'queries/query.typed-sql.ts'), 'utf8')
  assert.match(output, /readonly accountRows: readonly \(QueryJ12_account_rowsJsonJ7_element\)\[\]/u)
  assert.match(output, /readonly accountRow: QueryJ11_account_rowJson \| null/u)
  assert.match(output, /readonly accountId: number/u)
  assert.match(output, /readonly displayName: 'Reader'/u)
  assert.match(output, /readonly displayName: 'Writer'/u)
  assert.match(output, /propertyName: 'accountRows'/u)
  assert.match(output, /propertyName: 'accountRow'/u)
  assert.match(output, /"name":"account_id","propertyName":"accountId"/u)
  assert.match(output, /"name":"display_name","propertyName":"displayName"/u)
})

test('uses exposed aliases and folds whole-row set operations for structured JSON naming', async () => {
  const root = await createMinimalFixture(
    'select 1;\n',
    `select
  to_jsonb(aliased_row) as aliased_payload,
  to_jsonb(union_row) as union_payload
from (select 1 as account_id) aliased_row(user_id)
cross join (
  select jsonb_build_object('left_key', 1) as details
  union all
  select jsonb_build_object('right_key', 2) as details
) union_row
`
  )
  await generateTypedSql({
    include: ['queries'],
    naming: { structuredJsonFields: 'camelCase' },
    rootDir: root,
    codecProfile: 'node-postgres',
    schema: 'schema.sql',
  })

  const output = await readFile(join(root, 'queries/query.typed-sql.ts'), 'utf8')
  assert.match(output, /readonly userId: number/u)
  assert.doesNotMatch(output, /readonly accountId: number/u)
  assert.match(output, /readonly leftKey: number/u)
  assert.match(output, /readonly rightKey: number/u)
  assert.match(output, /"name":"user_id","propertyName":"userId"/u)
  assert.match(output, /"name":"left_key","propertyName":"leftKey"/u)
  assert.match(output, /"name":"right_key","propertyName":"rightKey"/u)
})

test('maps ARRAY sublink elements while preserving opaque union paths', async () => {
  const root = await createMinimalFixture(
    'create table public.json_values (payload jsonb not null);\n',
    `select to_jsonb(array(select jsonb_build_object('item_id', 1))) as items
union all
select jsonb_build_object(
  'payload_data',
  jsonb_build_object('foo_bar', 1, 'fooBar', 2)
)
union all
select jsonb_build_object('payload_data', payload)
from public.json_values
`
  )
  await generateTypedSql({
    include: ['queries'],
    naming: { structuredJsonFields: 'camelCase' },
    rootDir: root,
    codecProfile: 'node-postgres',
    schema: 'schema.sql',
  })

  const output = await readFile(join(root, 'queries/query.typed-sql.ts'), 'utf8')
  assert.match(output, /readonly itemId: number/u)
  assert.match(output, /readonly payloadData: DbJsonSelected/u)
  assert.doesNotMatch(output, /readonly fooBar: number/u)
  assert.match(output, /"name":"item_id","propertyName":"itemId"/u)
  assert.match(output, /"name":"payload_data","propertyName":"payloadData"/u)
  assert.doesNotMatch(output, /"name":"foo_bar","propertyName":"fooBar"/u)
})

test('treats composite JSON alternatives as opaque traversal barriers', async () => {
  const root = await createMinimalFixture(
    'create type public.opaque_payload as (inner_key integer);\n',
    `select jsonb_build_object(
  'payload_data',
  jsonb_build_object('inner_key', 1)
) as payload
union all
select jsonb_build_object(
  'payload_data',
  row(2)::public.opaque_payload
) as payload
`
  )
  await generateTypedSql({
    include: ['queries'],
    naming: { structuredJsonFields: 'camelCase' },
    rootDir: root,
    codecProfile: 'node-postgres',
    schema: 'schema.sql',
  })

  const output = await readFile(join(root, 'queries/query.typed-sql.ts'), 'utf8')
  assert.match(output, /readonly payloadData: DbJsonSelected/u)
  assert.doesNotMatch(output, /readonly innerKey: number/u)
  assert.match(output, /"name":"payload_data","propertyName":"payloadData"/u)
  assert.doesNotMatch(output, /"name":"inner_key","propertyName":"innerKey"/u)
})

test('keeps nested mappings when the other JSON alternative is primitive', async () => {
  const root = await createMinimalFixture(
    'select 1;\n',
    `select jsonb_build_object(
  'payload_data',
  jsonb_build_object('inner_key', 1)
) as payload
union all
select jsonb_build_object('payload_data', 2) as payload
`
  )
  await generateTypedSql({
    include: ['queries'],
    naming: { structuredJsonFields: 'camelCase' },
    rootDir: root,
    codecProfile: 'node-postgres',
    schema: 'schema.sql',
  })

  const output = await readFile(join(root, 'queries/query.typed-sql.ts'), 'utf8')
  assert.match(output, /readonly payloadData:/u)
  assert.match(output, /readonly innerKey: number/u)
  assert.match(output, /"name":"payload_data","propertyName":"payloadData"/u)
  assert.match(output, /"name":"inner_key","propertyName":"innerKey"/u)
})

test('rejects configured output naming collisions at every modeled object level', async () => {
  const topLevelRoot = await createMinimalFixture('select 1;\n', 'select 1 as foo_bar, 2 as "fooBar"\n')
  await assert.rejects(
    generateTypedSql({
      include: ['queries'],
      naming: {
        resultColumns: 'camelCase',
      },
      rootDir: topLevelRoot,
      codecProfile: 'node-postgres',
      schema: 'schema.sql',
    }),
    /duplicate result column name "fooBar"/u
  )

  const nestedRoot = await createMinimalFixture(
    'select 1;\n',
    `select jsonb_build_object('foo_bar', 1, 'fooBar', 2) as payload
`
  )
  await assert.rejects(
    generateTypedSql({
      include: ['queries'],
      naming: {
        structuredJsonFields: 'camelCase',
      },
      rootDir: nestedRoot,
      codecProfile: 'node-postgres',
      schema: 'schema.sql',
    }),
    /duplicate JSON field in result column "payload" name "fooBar"/u
  )
})

test('merges camel-case runtime mappings across structured JSON unions', async () => {
  const root = await createMinimalFixture(
    'select 1;\n',
    `select payload
from (
  select jsonb_build_object('outer_left', 1) as payload
  union all
  select jsonb_build_object('outer_right', 'two'::text)
) alternatives
`
  )
  await generateTypedSql({
    include: ['queries'],
    naming: {
      structuredJsonFields: 'camelCase',
    },
    rootDir: root,
    codecProfile: 'node-postgres',
    schema: 'schema.sql',
  })

  const output = await readFile(join(root, 'queries/query.typed-sql.ts'), 'utf8')
  assert.match(output, /readonly outerLeft: number/u)
  assert.match(output, /readonly outerRight: 'two'/u)
  assert.match(
    output,
    /jsonMapping: \{"fields":\[\{"name":"outer_left","propertyName":"outerLeft"\},\{"name":"outer_right","propertyName":"outerRight"\}\]\}/u
  )
})

test('requires structural JSON decoding when configured JSON field naming is used', async () => {
  const root = await createMinimalFixture(
    'select 1;\n',
    `select jsonb_build_object('display_name', 'Reader') as payload
`
  )
  await assert.rejects(
    generateTypedSql({
      include: ['queries'],
      naming: {
        structuredJsonFields: 'camelCase',
      },
      rootDir: root,
      schema: 'schema.sql',
    }),
    /structured JSON field naming for result column "payload" requires a codec profile that decodes structured JSON/u
  )
})

test('uses collision-free JSON binding paths for arrays and nested keys', async () => {
  const root = await createMinimalFixture(
    'select 1;\n',
    `select jsonb_build_object(
  'item', jsonb_build_object('x', 1),
  'items', jsonb_agg(jsonb_build_object('y', 2)),
  'a', jsonb_build_object('Jb', jsonb_build_object('left', 3)),
  'aJ', jsonb_build_object('b', jsonb_build_object('right', 4))
) as payload
from (values (1)) source(n)
`
  )
  await generateTypedSql({
    include: ['queries'],
    rootDir: root,
    codecProfile: 'node-postgres',
    schema: 'schema.sql',
  })

  const output = await readFile(join(root, 'queries/query.typed-sql.ts'), 'utf8')
  assert.match(output, /readonly item:/u)
  assert.match(output, /readonly items: readonly/u)
  assert.match(output, /readonly left: number/u)
  assert.match(output, /readonly right: number/u)
})

test('does not infer builtin JSON semantics from user-defined function names', async () => {
  const root = await createMinimalFixture(
    `create function public.jsonb_build_object(text, integer)
returns jsonb
language sql immutable
as $$ select 'null'::jsonb $$;
`,
    `select public.jsonb_build_object('key', 1) as payload
`
  )
  await generateTypedSql({
    include: ['queries'],
    rootDir: root,
    codecProfile: 'node-postgres',
    schema: 'schema.sql',
  })

  const output = await readFile(join(root, 'queries/query.typed-sql.ts'), 'utf8')
  assert.match(output, /readonly payload: DbJsonSelected \| null/u)
  assert.doesNotMatch(output, /interface QueryJ7_payloadJson/u)
})

test('falls back to opaque JSON when COALESCE branches have different shapes', async () => {
  const root = await createMinimalFixture(
    'create table public.json_values (value integer);\n',
    `select coalesce(
  jsonb_agg(jsonb_build_object('a', value)) filter (where false),
  jsonb_build_object('b', 2)
) as payload
from public.json_values
`
  )
  await generateTypedSql({
    include: ['queries'],
    rootDir: root,
    codecProfile: 'node-postgres',
    schema: 'schema.sql',
  })

  const output = await readFile(join(root, 'queries/query.typed-sql.ts'), 'utf8')
  assert.match(output, /readonly payload: DbJsonSelected/u)
  assert.doesNotMatch(output, /interface QueryJ7_payloadJson/u)
})

test('resolves column type assertions by PostgreSQL OID instead of display spelling', async () => {
  const root = await createMinimalFixture(
    "create type public.asserted_status as enum ('active');\n",
    `-- @column status public.asserted_status
select 'active'::public.asserted_status as status
`
  )

  await generateTypedSql({
    include: ['queries'],
    rootDir: root,
    codecProfile: 'node-postgres',
    schema: 'schema.sql',
  })
  const output = await readFile(join(root, 'queries/query.typed-sql.ts'), 'utf8')
  assert.match(output, /readonly status: "active"/u)
})

test('rejects nullable column assertions because PostgreSQL determines result nullability', async () => {
  const root = await copyFixture()
  await writeFile(
    join(root, 'queries/invalid-column-nullability.typed.sql'),
    '-- @column id bigint?\nselect id from public.accounts\n'
  )

  await assert.rejects(
    generateTypedSql({
      include: ['queries'],
      rootDir: root,
      codecProfile: 'node-postgres',
      schema: 'schema.sql',
    }),
    /queries\/invalid-column-nullability\.typed\.sql:1: @column does not support \?; PostgreSQL determines result nullability/u
  )
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { getTypeParser, type TypeId } from 'pg-types'

import {
  definePostgresCodecProfile,
  postgresJsonSupportsStringLiteralRefinement as postgresJsonSupportsStringLiteralRefinementBase,
  postgresResultTypesByOid,
  postgresTypeScriptType,
  resolvePostgresCodecProfile,
  resolveTypeScriptJsonScalarTypeForPostgresType as resolveTypeScriptJsonScalarTypeForPostgresTypeBase,
  resolveTypeScriptParameterTypeForPostgresType as resolveTypeScriptParameterTypeForPostgresTypeBase,
  resolveTypeScriptResultTypeForPostgresType as resolveTypeScriptResultTypeForPostgresTypeBase,
  type PostgresCodecProfile,
  type PostgresResultTypeContext,
  type PostgresTypeScriptResolutionFallback,
  type ResolvedPostgresCodecProfile,
} from '../src/postgres-codecs.js'
import { postgresJsonValueMayBeStructured, type PostgresTypeFact } from '../src/postgres-types.js'

const pgCatalog = (
  pgType: string,
  pgTypeName: string,
  pgTypeOid = 0,
  facts: Partial<PostgresTypeFact> = {}
): PostgresTypeFact => ({
  pgType,
  pgTypeName,
  pgTypeOid,
  pgTypeSchema: 'pg_catalog',
  pgTypeKind: 'base',
  ...facts,
})

const arrayFact = (
  pgArrayElementType: PostgresTypeFact,
  pgTypeOid: number,
  pgArrayDelimiter?: string
): PostgresTypeFact => ({
  pgType: `${pgArrayElementType.pgType}[]`,
  pgTypeName: `_${pgArrayElementType.pgTypeName}`,
  pgTypeSchema: pgArrayElementType.pgTypeSchema,
  pgTypeKind: 'array',
  pgTypeOid,
  pgArrayElementType,
  ...(pgArrayDelimiter === undefined ? {} : { pgArrayDelimiter }),
})

const domainOf = (
  pgTypeSchema: string,
  pgTypeName: string,
  pgTypeOid: number,
  pgBaseType: PostgresTypeFact
): PostgresTypeFact => ({
  pgType: `${pgTypeSchema}.${pgTypeName}`,
  pgTypeKind: 'domain',
  pgTypeSchema,
  pgTypeName,
  pgTypeOid,
  pgBaseType,
})

const resolveTypeScriptResultTypeForPostgresType = (
  fact: PostgresTypeFact,
  profile: PostgresCodecProfile = 'node-postgres'
) => resolveTypeScriptResultTypeForPostgresTypeBase(fact, profile)

const resolveTypeScriptParameterTypeForPostgresType = (
  fact: PostgresTypeFact,
  profile: PostgresCodecProfile = 'node-postgres'
) => resolveTypeScriptParameterTypeForPostgresTypeBase(fact, profile)

const resolveTypeScriptJsonScalarTypeForPostgresType = (
  fact: PostgresTypeFact,
  profile: PostgresCodecProfile = 'node-postgres'
) => resolveTypeScriptJsonScalarTypeForPostgresTypeBase(fact, profile)

const postgresJsonSupportsStringLiteralRefinement = (
  fact: PostgresTypeFact,
  profile: PostgresCodecProfile = 'node-postgres'
) => postgresJsonSupportsStringLiteralRefinementBase(fact, profile)

const resultType = (fact: PostgresTypeFact, profile?: PostgresCodecProfile): string =>
  resolveTypeScriptResultTypeForPostgresType(fact, profile).type

const parameterType = (fact: PostgresTypeFact, profile?: PostgresCodecProfile): string =>
  resolveTypeScriptParameterTypeForPostgresType(fact, profile).type

test('custom codec profiles override exact result OIDs without conflating scalar and array parsers', () => {
  const scalarProfile = definePostgresCodecProfile({
    extends: 'node-postgres',
    name: 'custom-int4',
    resultType: postgresResultTypesByOid({
      23: postgresTypeScriptType('CustomInt4', { scalarImports: ['CustomInt4'] }),
    }),
  })
  const integer = pgCatalog('integer', 'int4', 23)
  const integerArray = arrayFact(integer, 1007)

  assert.deepEqual(resolveTypeScriptResultTypeForPostgresType(integer, scalarProfile), {
    ambientBindings: [],
    scalarImports: ['CustomInt4'],
    type: 'CustomInt4',
  })
  assert.equal(resultType(integerArray, scalarProfile), 'PgArray<number>')

  const scalarAndArrayProfile = definePostgresCodecProfile({
    extends: scalarProfile,
    name: 'custom-int4-and-array',
    resultType: postgresResultTypesByOid({
      1007: postgresTypeScriptType('PgArray<CustomInt4>', {
        scalarImports: ['PgArray', 'CustomInt4'],
      }),
    }),
  })
  assert.equal(resultType(integerArray, scalarAndArrayProfile), 'PgArray<CustomInt4>')
})

test('custom codec profiles preserve prototype hooks and their original receiver', () => {
  class ClassCodecProfile {
    readonly #resultTypeName = 'ClassInt4'
    readonly name = 'class-codec-profile'

    get extends(): PostgresCodecProfile {
      return 'node-postgres'
    }

    resultType({ decoderType }: PostgresResultTypeContext, fallback: PostgresTypeScriptResolutionFallback) {
      return decoderType.pgTypeOid === 23
        ? postgresTypeScriptType(this.#resultTypeName, { scalarImports: [this.#resultTypeName] })
        : fallback()
    }
  }

  assert.deepEqual(
    resolveTypeScriptResultTypeForPostgresType(pgCatalog('integer', 'int4', 23), new ClassCodecProfile()),
    {
      ambientBindings: [],
      scalarImports: ['ClassInt4'],
      type: 'ClassInt4',
    }
  )
})

test('custom codec hooks can match portable type identity and model each conversion boundary independently', () => {
  const customProfile = definePostgresCodecProfile({
    extends: 'node-postgres',
    name: 'portable-domain-codecs',
    resultType({ declaredType }, fallback) {
      return declaredType.pgTypeSchema === 'billing' && declaredType.pgTypeName === 'amount'
        ? postgresTypeScriptType('Amount', { scalarImports: ['Amount'] })
        : fallback()
    },
    parameterType({ type }, fallback) {
      return type.pgTypeOid === 23 ? postgresTypeScriptType('Int4Input', { scalarImports: ['Int4Input'] }) : fallback()
    },
    jsonScalarType({ type }, fallback) {
      return type.pgTypeOid === 23 ? postgresTypeScriptType('Int4Json', { scalarImports: ['Int4Json'] }) : fallback()
    },
  })
  const integer = pgCatalog('integer', 'int4', 23)
  const amount: PostgresTypeFact = domainOf('billing', 'amount', 84_001, integer)
  const integerArray = arrayFact(integer, 1007, ',')

  assert.equal(resultType(amount, customProfile), 'Amount')
  assert.equal(parameterType(integer, customProfile), 'Int4Input')
  assert.equal(parameterType(integerArray, customProfile), 'PgArrayParameter<Int4Input> | string')
  assert.equal(resolveTypeScriptJsonScalarTypeForPostgresType(integer, customProfile).type, 'Int4Json')
})

test('custom parameter hooks receive domain array elements before built-in domain fallback', () => {
  const bigint = pgCatalog('bigint', 'int8', 20)
  const money: PostgresTypeFact = domainOf('billing', 'money', 84_001, bigint)
  const moneyArray: PostgresTypeFact = arrayFact(money, 84_002, ',')
  const profile = definePostgresCodecProfile({
    extends: 'node-postgres',
    name: 'money-input',
    parameterType({ type }, fallback) {
      return type.pgTypeSchema === 'billing' && type.pgTypeName === 'money'
        ? postgresTypeScriptType('MoneyInput', { scalarImports: ['MoneyInput'] })
        : fallback()
    },
  })

  assert.deepEqual(resolveTypeScriptParameterTypeForPostgresType(moneyArray, profile), {
    ambientBindings: [],
    scalarImports: ['PgArrayParameter', 'MoneyInput'],
    type: 'PgArrayParameter<MoneyInput> | string',
  })
  assert.equal(parameterType(moneyArray), 'PgArrayParameter<bigint | number | string> | string')
})

test('custom codec profiles expose structured JSON capabilities, opaque types, inheritance, and validation', () => {
  const structuredProfile = definePostgresCodecProfile({
    extends: 'conservative',
    name: 'structured-json-only',
    opaqueJsonType: postgresTypeScriptType('AppJson', { scalarImports: ['AppJson'] }),
    structuredJson: true,
  })
  const resolved = resolvePostgresCodecProfile(structuredProfile)
  assert.equal(resolved.name, 'structured-json-only')
  assert.equal(resolved.structuredJson, true)
  assert.deepEqual(resolved.opaqueJsonType, {
    ambientBindings: [],
    scalarImports: ['AppJson'],
    type: 'AppJson',
  })
  assert.equal(resolved.resolveResultType(pgCatalog('integer', 'int4', 23)).type, 'unknown')

  assert.throws(() => postgresResultTypesByOid({ 0: postgresTypeScriptType('never') }), /positive safe integer/u)

  const cyclicDefinition: { extends: PostgresCodecProfile; name: string } = {
    extends: 'conservative',
    name: 'cycle',
  }
  cyclicDefinition.extends = cyclicDefinition
  assert.throws(() => resolvePostgresCodecProfile(cyclicDefinition), /cyclic extends chain/u)
  for (const lineTerminator of ['\r', '\n', '\u2028', '\u2029']) {
    assert.throws(
      () =>
        resolvePostgresCodecProfile({
          extends: 'conservative',
          name: `invalid${lineTerminator}profile`,
        }),
      /single-line string/u
    )
  }
})

test('structurally resolved codec profiles are normalized, validated, and cached', () => {
  const externalResolvedProfile: ResolvedPostgresCodecProfile = {
    name: 'external-resolved-profile',
    opaqueJsonType: postgresTypeScriptType('ExternalJson', { scalarImports: ['ExternalJson'] }),
    structuredJson: true,
    resolveJsonScalarType: () => postgresTypeScriptType('ExternalJsonScalar'),
    resolveParameterType: () => postgresTypeScriptType('ExternalParameter'),
    resolveResultType: () => postgresTypeScriptType('ExternalResult', { scalarImports: ['ExternalResult'] }),
    supportsStringLiteralRefinement: () => false,
  }

  const normalized = resolvePostgresCodecProfile(externalResolvedProfile)
  assert.notEqual(normalized, externalResolvedProfile)
  assert.equal(resolvePostgresCodecProfile(externalResolvedProfile), normalized)
  assert.equal(resolvePostgresCodecProfile(normalized), normalized)
  assert.deepEqual(normalized.resolveResultType(pgCatalog('integer', 'int4', 23)), {
    ambientBindings: [],
    scalarImports: ['ExternalResult'],
    type: 'ExternalResult',
  })
})

test('codec resolutions reject non-string dependency bindings from JavaScript profiles', () => {
  for (const [dependency, resolution] of [
    ['scalar import', { ambientBindings: [], scalarImports: [false], type: 'BadScalarImport' }],
    ['ambient binding', { ambientBindings: [null], scalarImports: [], type: 'BadAmbientBinding' }],
  ] as const) {
    const profile = definePostgresCodecProfile({
      extends: 'node-postgres',
      name: `invalid-${dependency.replace(' ', '-')}`,
      resultType: () => resolution as unknown as ReturnType<ResolvedPostgresCodecProfile['resolveResultType']>,
    })
    assert.throws(
      () => resolveTypeScriptResultTypeForPostgresType(pgCatalog('integer', 'int4', 23), profile),
      new RegExp(`${dependency}.*is not a legal non-reserved TypeScript binding`, 'u')
    )
  }
})

test('public codec resolution helpers default to the conservative profile', () => {
  const integer = pgCatalog('integer', 'int4', 23)
  assert.equal(resolveTypeScriptResultTypeForPostgresTypeBase(integer).type, 'unknown')
  assert.equal(resolveTypeScriptParameterTypeForPostgresTypeBase(integer).type, 'NonNullable<unknown>')
  assert.equal(resolveTypeScriptJsonScalarTypeForPostgresTypeBase(integer).type, 'unknown')
  assert.equal(postgresJsonSupportsStringLiteralRefinementBase(pgCatalog('text', 'text', 25)), false)
})

test('result resolution follows the exact pg-types 2.2.0 text-decoder registrations', () => {
  assert.equal(resultType(pgCatalog('integer', 'int4', 23)), 'number')
  assert.equal(resultType(pgCatalog('bigint', 'int8', 20)), 'PgInt8String')
  assert.equal(resultType(pgCatalog('numeric', 'numeric', 1700)), 'PgNumericString')
  assert.equal(resultType(pgCatalog('time without time zone', 'time', 1083)), 'PgTimeString')
  assert.equal(resultType(pgCatalog('time with time zone', 'timetz', 1266)), 'PgTimetzString')
  assert.equal(resultType(pgCatalog('uuid', 'uuid', 2950)), 'PgUuidString')
  assert.deepEqual(
    resolveTypeScriptResultTypeForPostgresType(pgCatalog('timestamp with time zone', 'timestamptz', 1184)),
    {
      ambientBindings: ['Date'],
      scalarImports: [],
      type: 'Date | number',
    }
  )
  assert.deepEqual(resolveTypeScriptResultTypeForPostgresType(pgCatalog('bytea', 'bytea', 17)), {
    ambientBindings: ['Uint8Array'],
    scalarImports: [],
    type: 'Uint8Array',
  })
  assert.equal(resultType(pgCatalog('tsquery', 'tsquery', 3615)), 'string')
  assert.equal(resultType(pgCatalog('point', 'point', 600)), 'PgPoint')
  assert.equal(resultType(pgCatalog('circle', 'circle', 718)), 'PgCircle')
  assert.equal(resultType(pgCatalog('interval', 'interval', 1186)), 'PgInterval')

  assert.equal(resultType(arrayFact(pgCatalog('numeric', 'numeric', 1700), 1231)), 'PgArray<number>')
  assert.equal(resultType(arrayFact(pgCatalog('bigint', 'int8', 20), 1016)), 'PgArray<PgInt8String>')
  assert.equal(resultType(arrayFact(pgCatalog('date', 'date', 1082), 1182)), 'PgArray<Date | number>')
  assert.equal(resultType(arrayFact(pgCatalog('point', 'point', 600), 1017)), 'PgArray<PgPoint>')
  assert.equal(resultType(arrayFact(pgCatalog('interval', 'interval', 1186), 1187)), 'PgArray<PgInterval>')
  assert.deepEqual(resolveTypeScriptResultTypeForPostgresType(arrayFact(pgCatalog('date', 'date', 1082), 1182)), {
    ambientBindings: ['Date'],
    scalarImports: ['PgArray'],
    type: 'PgArray<Date | number>',
  })
  assert.equal(resultType(arrayFact(pgCatalog('tsquery', 'tsquery', 3615), 3645)), 'string')
  assert.equal(
    resultType(
      arrayFact(
        {
          pgType: 'audit.account_status',
          pgTypeName: 'account_status',
          pgTypeOid: 16_383,
          pgTypeSchema: 'audit',
          pgTypeKind: 'enum',
        },
        16_384
      )
    ),
    'string'
  )

  assert.equal(resultType(pgCatalog('integer', 'int4')), 'unknown')
  assert.equal(resultType(pgCatalog('integer', 'int4', 23), 'conservative'), 'unknown')
})

test('result resolution peels domains and renders enum facts as self-contained literal unions', () => {
  const enumFact: PostgresTypeFact = {
    pgType: 'audit.account_status',
    pgTypeName: 'account_status',
    pgTypeOid: 16_383,
    pgTypeSchema: 'audit',
    pgTypeKind: 'enum',
    pgEnumLabels: ['queued', 'complete'],
  }
  const domainFact: PostgresTypeFact = domainOf('audit', 'event_id', 16_385, pgCatalog('bigint', 'int8', 20))

  assert.deepEqual(resolveTypeScriptResultTypeForPostgresType(enumFact), {
    ambientBindings: [],
    scalarImports: [],
    type: '"queued" | "complete"',
  })
  assert.deepEqual(resolveTypeScriptResultTypeForPostgresType(domainFact), {
    ambientBindings: [],
    scalarImports: ['PgInt8String'],
    type: 'PgInt8String',
  })
  assert.equal(
    resultType({ ...domainFact, pgBaseType: undefined }),
    'unknown',
    'a domain without a base fact must not fall through to its unregistered domain OID'
  )
})

test('parameter resolution is independent of result decoding and recursively uses type facts', () => {
  const enumFact: PostgresTypeFact = {
    pgType: 'audit.account_status',
    pgTypeName: 'account_status',
    pgTypeOid: 16_383,
    pgTypeSchema: 'audit',
    pgTypeKind: 'enum',
    pgEnumLabels: ['queued', 'complete'],
  }
  const enumArray: PostgresTypeFact = arrayFact(enumFact, 16_384, ',')

  assert.equal(
    parameterType(arrayFact(pgCatalog('jsonb', 'jsonb', 3802), 3807, ',')),
    'PgArrayParameter<DbJsonParameter> | string'
  )
  assert.equal(
    parameterType(arrayFact(pgCatalog('bigint', 'int8', 20), 1016, ',')),
    'PgArrayParameter<bigint | number | string> | string'
  )
  assert.deepEqual(resolveTypeScriptParameterTypeForPostgresType(enumArray), {
    ambientBindings: [],
    scalarImports: ['PgArrayParameter'],
    type: 'PgArrayParameter<"queued" | "complete"> | string',
  })
  assert.equal(
    parameterType(
      arrayFact(
        domainOf('audit', 'int_list', 16_389, arrayFact(pgCatalog('integer', 'int4', 23), 1007, ',')),
        16_390,
        ','
      )
    ),
    'PgArrayParameter<string> | string'
  )
  assert.equal(parameterType(domainOf('audit', 'email_address', 16_386, pgCatalog('text', 'text', 25))), 'string')
  assert.equal(parameterType(pgCatalog('date', 'date', 1082)), 'Date | number | string')
  assert.equal(parameterType(pgCatalog('oid', 'oid', 26)), 'bigint | number | string')
  assert.equal(
    parameterType(domainOf('audit', 'object_id', 16_389, pgCatalog('oid', 'oid', 26))),
    'bigint | number | string'
  )
  assert.equal(
    parameterType(arrayFact(pgCatalog('oid', 'oid', 26), 1028, ',')),
    'PgArrayParameter<bigint | number | string> | string'
  )
  assert.equal(parameterType(pgCatalog('bytea', 'bytea', 17)), 'PgByteaHexString | Uint8Array')
  assert.deepEqual(
    resolveTypeScriptParameterTypeForPostgresType(arrayFact(pgCatalog('bytea', 'bytea', 17), 1001, ',')),
    {
      ambientBindings: [],
      scalarImports: ['PgArrayParameter', 'PgByteaHexString'],
      type: 'PgArrayParameter<PgByteaHexString> | string',
    }
  )
  assert.equal(parameterType(pgCatalog('interval', 'interval', 1186)), 'PgInterval | string')
  assert.equal(
    parameterType(arrayFact(pgCatalog('interval', 'interval', 1186), 1187, ',')),
    'PgArrayParameter<PgInterval | string> | string'
  )
  assert.equal(
    parameterType(arrayFact(pgCatalog('date', 'date', 1082), 1182, ',')),
    'PgArrayParameter<Date | number | string> | string'
  )
  assert.equal(parameterType(arrayFact(pgCatalog('box', 'box', 603), 1020, ';')), 'string')
  assert.deepEqual(resolveTypeScriptParameterTypeForPostgresType(pgCatalog('date', 'date', 1082)), {
    ambientBindings: ['Date'],
    scalarImports: [],
    type: 'Date | number | string',
  })
  assert.equal(parameterType(pgCatalog('circle', 'circle', 718)), 'string')
  assert.equal(
    parameterType({
      pgType: 'audit.event_payload',
      pgTypeName: 'event_payload',
      pgTypeOid: 16_387,
      pgTypeSchema: 'audit',
      pgTypeKind: 'composite',
    }),
    'string'
  )
  assert.equal(
    parameterType({
      pgType: 'audit.event_window',
      pgTypeName: 'event_window',
      pgTypeOid: 16_388,
      pgTypeSchema: 'audit',
      pgTypeKind: 'range',
    }),
    'string'
  )
  assert.deepEqual(resolveTypeScriptParameterTypeForPostgresType(pgCatalog('integer', 'int4', 23), 'conservative'), {
    ambientBindings: ['NonNullable'],
    scalarImports: [],
    type: 'NonNullable<unknown>',
  })
})

test('nested-JSON resolution follows PostgreSQL conversion rather than node-postgres parsers', () => {
  const domainOfNumeric: PostgresTypeFact = domainOf('audit', 'amount', 16_390, pgCatalog('numeric', 'numeric', 1700))

  assert.equal(
    resolveTypeScriptJsonScalarTypeForPostgresType(pgCatalog('numeric', 'numeric', 1700)).type,
    'number | string'
  )
  assert.equal(resolveTypeScriptJsonScalarTypeForPostgresType(domainOfNumeric).type, 'number | string')
  assert.equal(
    resolveTypeScriptJsonScalarTypeForPostgresType(pgCatalog('double precision', 'float8', 701)).type,
    'number | string'
  )
  assert.equal(resolveTypeScriptJsonScalarTypeForPostgresType(pgCatalog('boolean', 'bool', 16)).type, 'boolean')
  assert.equal(resolveTypeScriptResultTypeForPostgresType(pgCatalog('oid', 'oid', 26)).type, 'number')
  assert.equal(resolveTypeScriptJsonScalarTypeForPostgresType(pgCatalog('oid', 'oid', 26)).type, 'string')
  assert.equal(
    resolveTypeScriptJsonScalarTypeForPostgresType(domainOf('audit', 'object_id', 16_389, pgCatalog('oid', 'oid', 26)))
      .type,
    'string'
  )
  assert.equal(resolveTypeScriptJsonScalarTypeForPostgresType(pgCatalog('date', 'date', 1082)).type, 'string')
  assert.equal(
    resolveTypeScriptJsonScalarTypeForPostgresType({
      pgType: 'audit.custom_json_value',
      pgTypeKind: 'enum',
      pgTypeName: 'custom_json_value',
      pgTypeOid: 16_392,
      pgTypeSchema: 'audit',
      pgCastsToJson: true,
    }).type,
    'DbJsonSelected'
  )
  assert.deepEqual(
    resolveTypeScriptJsonScalarTypeForPostgresType({
      pgType: 'audit.account_status',
      pgTypeName: 'account_status',
      pgTypeOid: 16_383,
      pgTypeSchema: 'audit',
      pgTypeKind: 'enum',
      pgEnumLabels: ['queued', 'complete'],
    }),
    {
      ambientBindings: [],
      scalarImports: [],
      type: '"queued" | "complete"',
    }
  )
  assert.equal(resolveTypeScriptJsonScalarTypeForPostgresType(pgCatalog('jsonb', 'jsonb', 3802)).type, 'DbJsonSelected')
  assert.equal(
    resolveTypeScriptJsonScalarTypeForPostgresType(arrayFact(pgCatalog('integer', 'int4', 23), 1007)).type,
    'DbJsonSelected'
  )
  assert.equal(
    resolveTypeScriptJsonScalarTypeForPostgresType({
      pgType: 'audit.event_payload',
      pgTypeName: 'event_payload',
      pgTypeOid: 16_387,
      pgTypeSchema: 'audit',
      pgTypeKind: 'composite',
    }).type,
    'DbJsonSelected'
  )
})

test('classifies every PostgreSQL JSON value that may contain arbitrary structure', () => {
  const integer = pgCatalog('integer', 'int4', 23)
  const array = arrayFact(integer, 1007)
  const composite: PostgresTypeFact = {
    pgType: 'audit.payload',
    pgTypeKind: 'composite',
    pgTypeName: 'payload',
    pgTypeOid: 16_400,
    pgTypeSchema: 'audit',
  }
  const domain = (baseType?: PostgresTypeFact): PostgresTypeFact => ({
    pgType: 'audit.value_domain',
    ...(baseType ? { pgBaseType: baseType } : {}),
    pgTypeKind: 'domain',
    pgTypeName: 'value_domain',
    pgTypeOid: 16_401,
    pgTypeSchema: 'audit',
  })

  for (const fact of [
    array,
    composite,
    domain(),
    domain(array),
    domain(composite),
    domain(pgCatalog('jsonb', 'jsonb', 3802)),
    pgCatalog('json', 'json', 114),
    pgCatalog('jsonb', 'jsonb', 3802),
    {
      ...integer,
      pgCastsToJson: true,
    },
    {
      pgType: 'oid:99999',
      pgTypeKind: 'unknown',
      pgTypeName: 'oid_99999',
      pgTypeOid: 99_999,
      pgTypeSchema: 'unknown',
    } satisfies PostgresTypeFact,
  ]) {
    assert.equal(postgresJsonValueMayBeStructured(fact), true, fact.pgType)
  }

  for (const fact of [
    integer,
    pgCatalog('boolean', 'bool', 16),
    pgCatalog('text', 'text', 25),
    pgCatalog('date', 'date', 1082),
    domain(integer),
    {
      pgType: 'audit.status',
      pgTypeKind: 'enum',
      pgTypeName: 'status',
      pgTypeOid: 16_402,
      pgTypeSchema: 'audit',
    } satisfies PostgresTypeFact,
  ]) {
    assert.equal(postgresJsonValueMayBeStructured(fact), false, fact.pgType)
  }
})

test('recognizes exact unknown constants as JSON string literals', () => {
  assert.equal(
    postgresJsonSupportsStringLiteralRefinement(
      pgCatalog('unknown', 'unknown', 705, {
        pgTypeKind: 'pseudo',
      })
    ),
    true
  )
})

test('pg-types 2.2.0 parser fixtures match arrays, identity fallback, and infinity behavior', () => {
  const parseNumericArray = getTypeParser(1231 as TypeId)
  assert.deepEqual(parseNumericArray('{{1.5,NULL},{-2,3}}'), [
    [1.5, null],
    [-2, 3],
  ])

  const rawDynamicType = getTypeParser(90_000 as TypeId)
  assert.equal(rawDynamicType('{queued,complete}'), '{queued,complete}')
  assert.equal(rawDynamicType('42'), '42')

  const parseOidArray = getTypeParser(1028 as TypeId)
  assert.deepEqual(parseOidArray('{{1,NULL},{42,4294967295}}'), [
    [1, null],
    [42, 4_294_967_295],
  ])
  assert.equal(
    getTypeParser(1006 as TypeId)('{{1 2,NULL},{3 4,5 6}}'),
    '{{1 2,NULL},{3 4,5 6}}',
    'an unregistered built-in array OID uses the identity parser even when PostgreSQL catalogs it as an array'
  )

  assert.deepEqual(getTypeParser(600 as TypeId)('(1.5,-2)'), { x: 1.5, y: -2 })
  assert.deepEqual(getTypeParser(718 as TypeId)('<(1.5,-2),3.25>'), { radius: 3.25, x: 1.5, y: -2 })
  assert.deepEqual(getTypeParser(1017 as TypeId)('{"(1.5,-2)",NULL,"(0,4)"}'), [
    { x: 1.5, y: -2 },
    null,
    { x: 0, y: 4 },
  ])
  const interval = getTypeParser(1186 as TypeId)('1 year 2 mons 3 days 04:05:06.75') as {
    readonly days?: number
    readonly hours?: number
    readonly milliseconds?: number
    readonly minutes?: number
    readonly months?: number
    readonly seconds?: number
    readonly years?: number
    toISO(): string
    toISOString(): string
    toPostgres(): string
  }
  assert.deepEqual(
    {
      days: interval.days,
      hours: interval.hours,
      milliseconds: interval.milliseconds,
      minutes: interval.minutes,
      months: interval.months,
      seconds: interval.seconds,
      years: interval.years,
    },
    { days: 3, hours: 4, milliseconds: 750, minutes: 5, months: 2, seconds: 6, years: 1 }
  )
  assert.equal(interval.toISO(), 'P1Y2M3DT4H5M6.75S')
  assert.equal(interval.toISOString(), 'P1Y2M3DT4H5M6.75S')
  assert.equal(interval.toPostgres(), '6.75 seconds 5 minutes 4 hours 3 days 2 months 1 years')
  const intervalArray = getTypeParser(1187 as TypeId)('{"1 day",NULL,"-02:03:04.5"}') as readonly (null | {
    readonly days?: number
    readonly hours?: number
    readonly minutes?: number
    readonly seconds?: number
  })[]
  assert.equal(intervalArray[0]?.days, 1)
  assert.equal(intervalArray[1], null)
  assert.deepEqual(
    {
      hours: intervalArray[2]?.hours,
      minutes: intervalArray[2]?.minutes,
      seconds: intervalArray[2]?.seconds,
    },
    { hours: -2, minutes: -3, seconds: -4 }
  )

  for (const oid of [1082, 1114, 1184]) {
    const parseTemporal = getTypeParser(oid as TypeId)
    assert.equal(parseTemporal('infinity'), Infinity)
    assert.equal(parseTemporal('-infinity'), -Infinity)
  }
  for (const oid of [1115, 1182, 1185]) {
    const parseTemporalArray = getTypeParser(oid as TypeId)
    assert.deepEqual(parseTemporalArray('{infinity,-infinity}'), [Infinity, -Infinity])
  }
  assert.ok(getTypeParser(1082 as TypeId)('2026-07-15') instanceof Date)
  assert.ok(getTypeParser(1114 as TypeId)('2026-07-15 12:00:00') instanceof Date)
  assert.ok(getTypeParser(1184 as TypeId)('2026-07-15 12:00:00+09:30') instanceof Date)
})

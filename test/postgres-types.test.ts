import assert from 'node:assert/strict'
import test from 'node:test'
import { getTypeParser, type TypeId } from 'pg-types'

import {
  resolveTypeScriptJsonScalarTypeForPostgresType,
  resolveTypeScriptParameterTypeForPostgresType,
  resolveTypeScriptResultTypeForPostgresType,
  type PostgresScalarProfile,
  type PostgresTypeFact,
} from '../src/postgres-types.js'

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

const resultType = (fact: PostgresTypeFact, profile?: PostgresScalarProfile): string =>
  resolveTypeScriptResultTypeForPostgresType(fact, profile).type

const parameterType = (fact: PostgresTypeFact, profile?: PostgresScalarProfile): string =>
  resolveTypeScriptParameterTypeForPostgresType(fact, profile).type

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
      catalogImports: [],
      scalarImports: [],
      type: 'Date | number',
    }
  )
  assert.deepEqual(resolveTypeScriptResultTypeForPostgresType(pgCatalog('bytea', 'bytea', 17)), {
    ambientBindings: ['Uint8Array'],
    catalogImports: [],
    scalarImports: [],
    type: 'Uint8Array',
  })
  assert.equal(resultType(pgCatalog('tsquery', 'tsquery', 3615)), 'string')
  assert.equal(resultType(pgCatalog('point', 'point', 600)), 'PgPoint')
  assert.equal(resultType(pgCatalog('circle', 'circle', 718)), 'PgCircle')
  assert.equal(resultType(pgCatalog('interval', 'interval', 1186)), 'PgInterval')

  assert.equal(
    resultType(
      pgCatalog('numeric[]', '_numeric', 1231, {
        pgTypeKind: 'array',
        pgArrayElementType: pgCatalog('numeric', 'numeric', 1700),
      })
    ),
    'PgArray<number>'
  )
  assert.equal(
    resultType(
      pgCatalog('bigint[]', '_int8', 1016, {
        pgTypeKind: 'array',
        pgArrayElementType: pgCatalog('bigint', 'int8', 20),
      })
    ),
    'PgArray<PgInt8String>'
  )
  assert.equal(
    resultType(
      pgCatalog('date[]', '_date', 1182, {
        pgTypeKind: 'array',
        pgArrayElementType: pgCatalog('date', 'date', 1082),
      })
    ),
    'PgArray<Date | number>'
  )
  assert.equal(
    resultType(
      pgCatalog('point[]', '_point', 1017, {
        pgTypeKind: 'array',
        pgArrayElementType: pgCatalog('point', 'point', 600),
      })
    ),
    'PgArray<PgPoint>'
  )
  assert.equal(
    resultType(
      pgCatalog('interval[]', '_interval', 1187, {
        pgTypeKind: 'array',
        pgArrayElementType: pgCatalog('interval', 'interval', 1186),
      })
    ),
    'PgArray<PgInterval>'
  )
  assert.deepEqual(
    resolveTypeScriptResultTypeForPostgresType(
      pgCatalog('date[]', '_date', 1182, {
        pgTypeKind: 'array',
        pgArrayElementType: pgCatalog('date', 'date', 1082),
      })
    ),
    {
      ambientBindings: ['Date'],
      catalogImports: [],
      scalarImports: ['PgArray'],
      type: 'PgArray<Date | number>',
    }
  )
  assert.equal(
    resultType(
      pgCatalog('tsquery[]', '_tsquery', 3645, {
        pgTypeKind: 'array',
        pgArrayElementType: pgCatalog('tsquery', 'tsquery', 3615),
      })
    ),
    'string'
  )
  assert.equal(
    resultType({
      pgType: 'audit.account_status[]',
      pgTypeName: '_account_status',
      pgTypeOid: 16_384,
      pgTypeSchema: 'audit',
      pgTypeKind: 'array',
      pgArrayElementType: {
        pgType: 'audit.account_status',
        pgTypeName: 'account_status',
        pgTypeOid: 16_383,
        pgTypeSchema: 'audit',
        pgTypeKind: 'enum',
      },
    }),
    'string'
  )

  assert.equal(resultType(pgCatalog('integer', 'int4')), 'unknown')
  assert.equal(resultType(pgCatalog('integer', 'int4', 23), 'conservative'), 'unknown')
})

test('result resolution peels domains and refines enum facts to generated catalog aliases', () => {
  const enumFact: PostgresTypeFact = {
    pgType: 'audit.account_status',
    pgTypeName: 'account_status',
    pgTypeOid: 16_383,
    pgTypeSchema: 'audit',
    pgTypeKind: 'enum',
  }
  const domainFact: PostgresTypeFact = {
    pgType: 'audit.event_id',
    pgTypeName: 'event_id',
    pgTypeOid: 16_385,
    pgTypeSchema: 'audit',
    pgTypeKind: 'domain',
    pgBaseType: pgCatalog('bigint', 'int8', 20),
  }

  assert.deepEqual(resolveTypeScriptResultTypeForPostgresType(enumFact), {
    ambientBindings: [],
    catalogImports: ['Audit_AccountStatus'],
    scalarImports: [],
    type: 'Audit_AccountStatus',
  })
  assert.deepEqual(resolveTypeScriptResultTypeForPostgresType(domainFact), {
    ambientBindings: [],
    catalogImports: [],
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
  }
  const enumArray: PostgresTypeFact = {
    pgType: 'audit.account_status[]',
    pgTypeName: '_account_status',
    pgTypeOid: 16_384,
    pgTypeSchema: 'audit',
    pgTypeKind: 'array',
    pgArrayDelimiter: ',',
    pgArrayElementType: enumFact,
  }

  assert.equal(
    parameterType(
      pgCatalog('jsonb[]', '_jsonb', 3807, {
        pgTypeKind: 'array',
        pgArrayDelimiter: ',',
        pgArrayElementType: pgCatalog('jsonb', 'jsonb', 3802),
      })
    ),
    'PgArrayParameter<DbJsonParameter> | string'
  )
  assert.equal(
    parameterType(
      pgCatalog('bigint[]', '_int8', 1016, {
        pgTypeKind: 'array',
        pgArrayDelimiter: ',',
        pgArrayElementType: pgCatalog('bigint', 'int8', 20),
      })
    ),
    'PgArrayParameter<bigint | number | string> | string'
  )
  assert.deepEqual(resolveTypeScriptParameterTypeForPostgresType(enumArray), {
    ambientBindings: [],
    catalogImports: ['Audit_AccountStatus'],
    scalarImports: ['PgArrayParameter'],
    type: 'PgArrayParameter<Audit_AccountStatus> | string',
  })
  assert.equal(
    parameterType({
      pgType: 'audit.int_list[]',
      pgTypeName: '_int_list',
      pgTypeOid: 16_390,
      pgTypeSchema: 'audit',
      pgTypeKind: 'array',
      pgArrayDelimiter: ',',
      pgArrayElementType: {
        pgType: 'audit.int_list',
        pgTypeName: 'int_list',
        pgTypeOid: 16_389,
        pgTypeSchema: 'audit',
        pgTypeKind: 'domain',
        pgBaseType: pgCatalog('integer[]', '_int4', 1007, {
          pgTypeKind: 'array',
          pgArrayDelimiter: ',',
          pgArrayElementType: pgCatalog('integer', 'int4', 23),
        }),
      },
    }),
    'PgArrayParameter<string> | string'
  )
  assert.equal(
    parameterType({
      pgType: 'audit.email_address',
      pgTypeName: 'email_address',
      pgTypeOid: 16_386,
      pgTypeSchema: 'audit',
      pgTypeKind: 'domain',
      pgBaseType: pgCatalog('text', 'text', 25),
    }),
    'string'
  )
  assert.equal(parameterType(pgCatalog('date', 'date', 1082)), 'Date | number | string')
  assert.equal(parameterType(pgCatalog('oid', 'oid', 26)), 'bigint | number | string')
  assert.equal(
    parameterType({
      pgType: 'audit.object_id',
      pgTypeName: 'object_id',
      pgTypeOid: 16_389,
      pgTypeSchema: 'audit',
      pgTypeKind: 'domain',
      pgBaseType: pgCatalog('oid', 'oid', 26),
    }),
    'bigint | number | string'
  )
  assert.equal(
    parameterType(
      pgCatalog('oid[]', '_oid', 1028, {
        pgTypeKind: 'array',
        pgArrayDelimiter: ',',
        pgArrayElementType: pgCatalog('oid', 'oid', 26),
      })
    ),
    'PgArrayParameter<bigint | number | string> | string'
  )
  assert.equal(parameterType(pgCatalog('bytea', 'bytea', 17)), 'PgByteaHexString | Uint8Array')
  assert.deepEqual(
    resolveTypeScriptParameterTypeForPostgresType(
      pgCatalog('bytea[]', '_bytea', 1001, {
        pgTypeKind: 'array',
        pgArrayDelimiter: ',',
        pgArrayElementType: pgCatalog('bytea', 'bytea', 17),
      })
    ),
    {
      ambientBindings: [],
      catalogImports: [],
      scalarImports: ['PgArrayParameter', 'PgByteaHexString'],
      type: 'PgArrayParameter<PgByteaHexString> | string',
    }
  )
  assert.equal(parameterType(pgCatalog('interval', 'interval', 1186)), 'PgInterval | string')
  assert.equal(
    parameterType(
      pgCatalog('interval[]', '_interval', 1187, {
        pgTypeKind: 'array',
        pgArrayDelimiter: ',',
        pgArrayElementType: pgCatalog('interval', 'interval', 1186),
      })
    ),
    'PgArrayParameter<PgInterval | string> | string'
  )
  assert.equal(
    parameterType(
      pgCatalog('date[]', '_date', 1182, {
        pgTypeKind: 'array',
        pgArrayDelimiter: ',',
        pgArrayElementType: pgCatalog('date', 'date', 1082),
      })
    ),
    'PgArrayParameter<Date | number | string> | string'
  )
  assert.equal(
    parameterType(
      pgCatalog('box[]', '_box', 1020, {
        pgTypeKind: 'array',
        pgArrayDelimiter: ';',
        pgArrayElementType: pgCatalog('box', 'box', 603),
      })
    ),
    'string'
  )
  assert.deepEqual(resolveTypeScriptParameterTypeForPostgresType(pgCatalog('date', 'date', 1082)), {
    ambientBindings: ['Date'],
    catalogImports: [],
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
    catalogImports: [],
    scalarImports: [],
    type: 'NonNullable<unknown>',
  })
})

test('nested-JSON resolution follows PostgreSQL conversion rather than node-postgres parsers', () => {
  const domainOfNumeric: PostgresTypeFact = {
    pgType: 'audit.amount',
    pgTypeName: 'amount',
    pgTypeOid: 16_390,
    pgTypeSchema: 'audit',
    pgTypeKind: 'domain',
    pgBaseType: pgCatalog('numeric', 'numeric', 1700),
  }

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
    resolveTypeScriptJsonScalarTypeForPostgresType({
      pgType: 'audit.object_id',
      pgTypeName: 'object_id',
      pgTypeOid: 16_389,
      pgTypeSchema: 'audit',
      pgTypeKind: 'domain',
      pgBaseType: pgCatalog('oid', 'oid', 26),
    }).type,
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
    }),
    {
      ambientBindings: [],
      catalogImports: ['Audit_AccountStatus'],
      scalarImports: [],
      type: 'Audit_AccountStatus',
    }
  )
  assert.equal(resolveTypeScriptJsonScalarTypeForPostgresType(pgCatalog('jsonb', 'jsonb', 3802)).type, 'DbJsonSelected')
  assert.equal(
    resolveTypeScriptJsonScalarTypeForPostgresType(
      pgCatalog('integer[]', '_int4', 1007, {
        pgTypeKind: 'array',
        pgArrayElementType: pgCatalog('integer', 'int4', 23),
      })
    ).type,
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

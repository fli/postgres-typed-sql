import { schemaQualifiedPascalName } from './typescript-names.js'

export interface PostgresTypeFact {
  readonly pgType: string
  readonly pgTypeName?: string
  readonly pgTypeOid?: number
  readonly pgTypeSchema?: string
}

export interface PostgresTypeScriptResolution {
  readonly catalogImports: readonly string[]
  readonly scalarImports: readonly string[]
  readonly type: string
}

export type PostgresScalarProfile = 'conservative' | 'node-postgres'

export const defaultPostgresScalarProfile: PostgresScalarProfile = 'conservative'

export const postgresTypeScriptScalarImports = new Set([
  'DbJsonInput',
  'DbJsonSelected',
  'PgArray',
  'PgByteaHexString',
  'PgDateString',
  'PgFloat4String',
  'PgFloat8String',
  'PgInt2String',
  'PgInt4String',
  'PgInt8String',
  'PgIntervalString',
  'PgNumericString',
  'PgOidString',
  'PgTimestampString',
  'PgTimestamptzString',
  'PgTimeString',
  'PgTimetzString',
  'PgUuidString',
])

const emptyImports: readonly string[] = []

function resolution(
  type: string,
  options: {
    readonly catalogImports?: readonly string[]
    readonly scalarImports?: readonly string[]
  } = {}
): PostgresTypeScriptResolution {
  return {
    catalogImports: options.catalogImports ?? emptyImports,
    scalarImports: options.scalarImports ?? (postgresTypeScriptScalarImports.has(type) ? [type] : emptyImports),
    type,
  }
}

const unknownResolution = resolution('unknown')

const nodePostgresOutputType = new Map<string, PostgresTypeScriptResolution>([
  ['bigint', resolution('PgInt8String')],
  ['bit', resolution('string')],
  ['bit varying', resolution('string')],
  ['boolean', resolution('boolean')],
  ['box', resolution('string')],
  ['bytea', resolution('Uint8Array')],
  ['char', resolution('string')],
  ['cidr', resolution('string')],
  ['circle', unknownResolution],
  ['date', resolution('Date | number')],
  ['double precision', resolution('number')],
  ['inet', resolution('string')],
  ['integer', resolution('number')],
  ['interval', unknownResolution],
  ['json', resolution('DbJsonSelected')],
  ['jsonb', resolution('DbJsonSelected')],
  ['line', resolution('string')],
  ['lseg', resolution('string')],
  ['macaddr', resolution('string')],
  ['macaddr8', resolution('string')],
  ['money', resolution('string')],
  ['name', resolution('string')],
  ['numeric', resolution('PgNumericString')],
  ['oid', resolution('number')],
  ['path', resolution('string')],
  ['pg_lsn', resolution('string')],
  ['point', unknownResolution],
  ['polygon', resolution('string')],
  ['real', resolution('number')],
  ['smallint', resolution('number')],
  ['text', resolution('string')],
  ['time without time zone', resolution('PgTimeString')],
  ['time with time zone', resolution('PgTimetzString')],
  ['timestamp without time zone', resolution('Date | number')],
  ['timestamp with time zone', resolution('Date | number')],
  ['timestamptz', resolution('Date | number')],
  ['tsquery', resolution('string')],
  ['tsvector', resolution('string')],
  ['unknown', unknownResolution],
  ['uuid', resolution('PgUuidString')],
  ['void', unknownResolution],
  ['xml', resolution('string')],
])

for (const rangeType of ['daterange', 'int4range', 'int8range', 'numrange', 'tsrange', 'tstzrange']) {
  nodePostgresOutputType.set(rangeType, resolution('string'))
}

function pgArrayResolution(elementType: string, scalarImports: readonly string[] = []): PostgresTypeScriptResolution {
  return resolution(`PgArray<${elementType}>`, {
    scalarImports: ['PgArray', ...scalarImports],
  })
}

// node-postgres 8.x pins pg-types 2.2.0. Its text parsers are registered for
// these exact built-in array OIDs; it does not recursively apply a scalar
// parser to arbitrary PostgreSQL array types.
const nodePostgresArrayOutputTypeByOid = new Map<number, PostgresTypeScriptResolution>([
  [199, pgArrayResolution('DbJsonSelected', ['DbJsonSelected'])], // json[]
  [651, pgArrayResolution('string')], // cidr[]
  [791, pgArrayResolution('string')], // money[]
  [1000, pgArrayResolution('boolean')], // bool[]
  [1001, pgArrayResolution('Uint8Array')], // bytea[]
  [1005, pgArrayResolution('number')], // int2[]
  [1007, pgArrayResolution('number')], // int4[]
  [1008, pgArrayResolution('string')], // regproc[]
  [1009, pgArrayResolution('string')], // text[]
  [1014, pgArrayResolution('string')], // bpchar[]
  [1015, pgArrayResolution('string')], // varchar[]
  [1016, pgArrayResolution('PgInt8String', ['PgInt8String'])], // int8[]
  [1017, pgArrayResolution('unknown')], // point[]
  [1021, pgArrayResolution('number')], // float4[]
  [1022, pgArrayResolution('number')], // float8[]
  [1028, pgArrayResolution('number')], // oid[]
  [1040, pgArrayResolution('string')], // macaddr[]
  [1041, pgArrayResolution('string')], // inet[]
  [1115, pgArrayResolution('Date | number')], // timestamp[]
  [1182, pgArrayResolution('Date | number')], // date[]
  [1183, pgArrayResolution('PgTimeString', ['PgTimeString'])], // time[]
  [1185, pgArrayResolution('Date | number')], // timestamptz[]
  [1187, pgArrayResolution('unknown')], // interval[]
  [1231, pgArrayResolution('number')], // numeric[]
  [1270, pgArrayResolution('PgTimetzString', ['PgTimetzString'])], // timetz[]
  [2951, pgArrayResolution('PgUuidString', ['PgUuidString'])], // uuid[]
  [3807, pgArrayResolution('DbJsonSelected', ['DbJsonSelected'])], // jsonb[]
  [3907, pgArrayResolution('string')], // numrange[]
])

const pgCatalogTypeAliases = new Map([
  ['bool', 'boolean'],
  ['bpchar', 'text'],
  ['float4', 'real'],
  ['float8', 'double precision'],
  ['int2', 'smallint'],
  ['int4', 'integer'],
  ['int8', 'bigint'],
  ['time', 'time without time zone'],
  ['timestamp', 'timestamp without time zone'],
  ['timestamptz', 'timestamp with time zone'],
  ['timetz', 'time with time zone'],
  ['varbit', 'bit varying'],
])

export function normalizePostgresTypeName(pgType: string): string {
  if (pgType.startsWith('character varying') || pgType.startsWith('character(') || pgType === 'varchar') {
    return 'text'
  }
  if (pgType.startsWith('numeric(')) {
    return 'numeric'
  }
  if (pgType.startsWith('timestamp(') && pgType.endsWith(' without time zone')) {
    return 'timestamp without time zone'
  }
  if (pgType.startsWith('timestamp(') && pgType.endsWith(' with time zone')) {
    return 'timestamp with time zone'
  }
  if (pgType.startsWith('time(') && pgType.endsWith(' without time zone')) {
    return 'time without time zone'
  }
  if (pgType.startsWith('time(') && pgType.endsWith(' with time zone')) {
    return 'time with time zone'
  }
  return pgCatalogTypeAliases.get(pgType) ?? pgType
}

export function postgresArrayElementType(pgType: string, typeName = ''): string | null {
  const normalizedTypeName = normalizePostgresTypeName(typeName)
  if (normalizedTypeName.startsWith('_') && normalizedTypeName.length > 1) {
    return normalizedTypeName.slice(1)
  }

  const normalizedPgType = normalizePostgresTypeName(pgType)
  if (normalizedPgType.endsWith('[]')) {
    return normalizedPgType.slice(0, -2)
  }

  return null
}

function splitSchemaQualifiedPgType(pgType: string): { readonly schema: string; readonly typeName: string } | null {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)(\[\])?$/u.exec(pgType)
  if (!match?.[1] || !match[2]) {
    return null
  }

  return { schema: match[1], typeName: `${match[2]}${match[3] ?? ''}` }
}

export function resolveTypeScriptTypeForPostgresType(
  typeFact: PostgresTypeFact,
  context?: string,
  scalarProfile: PostgresScalarProfile = 'node-postgres'
): PostgresTypeScriptResolution {
  if (scalarProfile === 'conservative') {
    return unknownResolution
  }

  const typeSchema = typeFact.pgTypeSchema ?? 'pg_catalog'
  const typeName = typeFact.pgTypeName ?? ''
  const schemaQualifiedType =
    typeSchema === 'pg_catalog' && !typeName ? splitSchemaQualifiedPgType(typeFact.pgType) : null
  if (schemaQualifiedType) {
    return resolveTypeScriptTypeForPostgresType(
      {
        pgType: schemaQualifiedType.typeName,
        pgTypeName: schemaQualifiedType.typeName,
        pgTypeSchema: schemaQualifiedType.schema,
      },
      context,
      scalarProfile
    )
  }

  if (postgresArrayElementType(typeFact.pgType, typeName)) {
    return nodePostgresArrayOutputTypeByOid.get(typeFact.pgTypeOid ?? 0) ?? unknownResolution
  }

  if (typeSchema !== 'pg_catalog') {
    const catalogType = schemaQualifiedPascalName(typeSchema, typeName || typeFact.pgType)
    return resolution(catalogType, { catalogImports: [catalogType] })
  }

  const tsType = nodePostgresOutputType.get(normalizePostgresTypeName(typeFact.pgType))
  if (!tsType) {
    throw new Error(
      `${context ? `${context}: ` : ''}No TypeScript mapping configured for PostgreSQL type ${typeFact.pgType}.`
    )
  }
  return tsType
}

export function typeScriptTypeForPostgresType(
  typeFact: PostgresTypeFact,
  context?: string,
  scalarProfile: PostgresScalarProfile = 'node-postgres'
): string {
  return resolveTypeScriptTypeForPostgresType(typeFact, context, scalarProfile).type
}

export function resolveTypeScriptParameterTypeForPostgresType(
  typeFact: PostgresTypeFact,
  context?: string,
  scalarProfile: PostgresScalarProfile = 'node-postgres'
): PostgresTypeScriptResolution {
  if (scalarProfile === 'conservative') {
    return unknownResolution
  }

  const typeSchema = typeFact.pgTypeSchema ?? 'pg_catalog'
  const arrayElementType = postgresArrayElementType(typeFact.pgType, typeFact.pgTypeName)
  if (arrayElementType) {
    const element = resolveTypeScriptParameterTypeForPostgresType(
      {
        pgType: arrayElementType,
        pgTypeName: arrayElementType,
        pgTypeSchema: typeSchema,
      },
      context,
      scalarProfile
    )
    return resolution(`PgArray<${element.type}>`, {
      catalogImports: element.catalogImports,
      scalarImports: ['PgArray', ...element.scalarImports],
    })
  }

  const normalizedTypeName = normalizePostgresTypeName(typeFact.pgTypeName || typeFact.pgType)
  if ((normalizedTypeName === 'json' || normalizedTypeName === 'jsonb') && typeSchema === 'pg_catalog') {
    return resolution('DbJsonInput')
  }
  if (typeSchema !== 'pg_catalog') {
    return resolveTypeScriptTypeForPostgresType(typeFact, context, scalarProfile)
  }

  const normalizedPgType = normalizePostgresTypeName(typeFact.pgType)
  if (['bigint', 'double precision', 'integer', 'numeric', 'oid', 'real', 'smallint'].includes(normalizedPgType)) {
    return resolution('bigint | number | string')
  }
  if (['date', 'timestamp without time zone', 'timestamp with time zone', 'timestamptz'].includes(normalizedPgType)) {
    return resolution('Date | string')
  }
  if (normalizedPgType === 'bytea') {
    return resolution('Uint8Array')
  }
  return resolveTypeScriptTypeForPostgresType(typeFact, context, scalarProfile)
}

export function typeScriptParameterTypeForPostgresType(
  typeFact: PostgresTypeFact,
  context?: string,
  scalarProfile: PostgresScalarProfile = 'node-postgres'
): string {
  return resolveTypeScriptParameterTypeForPostgresType(typeFact, context, scalarProfile).type
}

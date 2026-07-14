import { schemaQualifiedPascalName } from './typescript-names.js'

export interface PostgresTypeFact {
  readonly pgType: string
  readonly pgTypeName?: string
  readonly pgTypeSchema?: string
}

export type PostgresScalarProfile = 'conservative' | 'node-postgres'

export const defaultPostgresScalarProfile: PostgresScalarProfile = 'conservative'

const nodePostgresOutputType = new Map<string, string>([
  ['bigint', 'PgInt8String'],
  ['bit', 'string'],
  ['bit varying', 'string'],
  ['boolean', 'boolean'],
  ['box', 'string'],
  ['bytea', 'Uint8Array'],
  ['char', 'string'],
  ['cidr', 'string'],
  ['circle', 'unknown'],
  ['date', 'Date'],
  ['double precision', 'number'],
  ['inet', 'string'],
  ['integer', 'number'],
  ['interval', 'unknown'],
  ['json', 'DbJsonSelected'],
  ['jsonb', 'DbJsonSelected'],
  ['line', 'string'],
  ['lseg', 'string'],
  ['macaddr', 'string'],
  ['macaddr8', 'string'],
  ['money', 'string'],
  ['name', 'string'],
  ['numeric', 'PgNumericString'],
  ['oid', 'number'],
  ['path', 'string'],
  ['pg_lsn', 'string'],
  ['point', 'unknown'],
  ['polygon', 'string'],
  ['real', 'number'],
  ['smallint', 'number'],
  ['text', 'string'],
  ['time without time zone', 'PgTimeString'],
  ['time with time zone', 'PgTimetzString'],
  ['timestamp without time zone', 'Date'],
  ['timestamp with time zone', 'Date'],
  ['timestamptz', 'Date'],
  ['tsquery', 'string'],
  ['tsvector', 'string'],
  ['unknown', 'unknown'],
  ['uuid', 'PgUuidString'],
  ['void', 'unknown'],
  ['xml', 'string'],
])

for (const rangeType of ['daterange', 'int4range', 'int8range', 'numrange', 'tsrange', 'tstzrange']) {
  nodePostgresOutputType.set(rangeType, 'string')
}

export const postgresTypeScriptScalarImports = new Set([
  'DbJsonInput',
  'DbJsonSelected',
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

export function typeScriptTypeForPostgresType(
  typeFact: PostgresTypeFact,
  context?: string,
  scalarProfile: PostgresScalarProfile = 'node-postgres'
): string {
  if (scalarProfile === 'conservative') {
    return 'unknown'
  }

  const typeSchema = typeFact.pgTypeSchema ?? 'pg_catalog'
  const typeName = typeFact.pgTypeName ?? ''
  const schemaQualifiedType =
    typeSchema === 'pg_catalog' && !typeName ? splitSchemaQualifiedPgType(typeFact.pgType) : null
  if (schemaQualifiedType) {
    return typeScriptTypeForPostgresType(
      {
        pgType: schemaQualifiedType.typeName,
        pgTypeName: schemaQualifiedType.typeName,
        pgTypeSchema: schemaQualifiedType.schema,
      },
      context,
      scalarProfile
    )
  }

  const arrayElementType = postgresArrayElementType(typeFact.pgType, typeName)
  if (arrayElementType) {
    const elementType =
      typeSchema === 'pg_catalog'
        ? typeScriptTypeForPostgresType(
            { pgType: arrayElementType, pgTypeName: arrayElementType, pgTypeSchema: 'pg_catalog' },
            context,
            scalarProfile
          )
        : schemaQualifiedPascalName(typeSchema, arrayElementType)
    return `readonly ${elementType}[]`
  }

  if (typeSchema !== 'pg_catalog') {
    return schemaQualifiedPascalName(typeSchema, typeName || typeFact.pgType)
  }

  const tsType = nodePostgresOutputType.get(normalizePostgresTypeName(typeFact.pgType))
  if (!tsType) {
    throw new Error(
      `${context ? `${context}: ` : ''}No TypeScript mapping configured for PostgreSQL type ${typeFact.pgType}.`
    )
  }
  return tsType
}

export function typeScriptParameterTypeForPostgresType(
  typeFact: PostgresTypeFact,
  context?: string,
  scalarProfile: PostgresScalarProfile = 'node-postgres'
): string {
  if (scalarProfile === 'conservative') {
    return 'unknown'
  }

  const typeSchema = typeFact.pgTypeSchema ?? 'pg_catalog'
  const arrayElementType = postgresArrayElementType(typeFact.pgType, typeFact.pgTypeName)
  if (arrayElementType) {
    const elementType = typeScriptParameterTypeForPostgresType(
      {
        pgType: arrayElementType,
        pgTypeName: arrayElementType,
        pgTypeSchema: typeSchema,
      },
      context,
      scalarProfile
    )
    return `readonly ${elementType.includes(' | ') ? `(${elementType})` : elementType}[]`
  }

  const normalizedTypeName = normalizePostgresTypeName(typeFact.pgTypeName || typeFact.pgType)
  if ((normalizedTypeName === 'json' || normalizedTypeName === 'jsonb') && typeSchema === 'pg_catalog') {
    return 'DbJsonInput'
  }
  if (typeSchema !== 'pg_catalog') {
    return typeScriptTypeForPostgresType(typeFact, context, scalarProfile)
  }

  const normalizedPgType = normalizePostgresTypeName(typeFact.pgType)
  if (['bigint', 'double precision', 'integer', 'numeric', 'oid', 'real', 'smallint'].includes(normalizedPgType)) {
    return 'bigint | number | string'
  }
  if (['date', 'timestamp without time zone', 'timestamp with time zone', 'timestamptz'].includes(normalizedPgType)) {
    return 'Date | string'
  }
  if (normalizedPgType === 'bytea') {
    return 'Uint8Array'
  }
  return typeScriptTypeForPostgresType(typeFact, context, scalarProfile)
}

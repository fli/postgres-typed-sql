/** PostgreSQL type classes exposed to codec profiles and generated-type resolution. */
export type PostgresTypeKind =
  | 'array'
  | 'base'
  | 'composite'
  | 'domain'
  | 'enum'
  | 'multirange'
  | 'pseudo'
  | 'range'
  | 'unknown'

export interface PostgresTypeFact {
  readonly pgType: string
  readonly pgTypeKind: PostgresTypeKind
  readonly pgTypeName: string
  readonly pgTypeOid: number
  readonly pgTypeSchema: string
  /** PostgreSQL's JSON conversion invokes a user-defined function cast from this type to json. */
  readonly pgCastsToJson?: boolean
  /** Ordered labels for a PostgreSQL enum. Present when pgTypeKind is enum. */
  readonly pgEnumLabels?: readonly string[]
  /** The immediate base type of a domain. Nested domains are intentionally recursive. */
  readonly pgBaseType?: PostgresTypeFact
  /** The immediate element type of an array. Nested arrays are intentionally recursive. */
  readonly pgArrayElementType?: PostgresTypeFact
  /** PostgreSQL's delimiter for the array element type. */
  readonly pgArrayDelimiter?: string
}

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

const textualLiteralCompatiblePgCatalogTypes = new Set(['name', 'text', 'uuid', 'varchar'])

export function postgresTypeSupportsTextualLiteralRefinement(type: PostgresTypeFact): boolean {
  if (type.pgTypeKind === 'domain' && type.pgBaseType) {
    return postgresTypeSupportsTextualLiteralRefinement(type.pgBaseType)
  }
  if (type.pgTypeKind === 'enum') {
    return true
  }
  return type.pgTypeSchema === 'pg_catalog' && textualLiteralCompatiblePgCatalogTypes.has(type.pgTypeName)
}

/** Whether a textual literal refinement matches PostgreSQL's nested-JSON representation. */
export function postgresJsonSupportsTextualLiteralRefinement(type: PostgresTypeFact): boolean {
  if (
    type.pgTypeKind === 'array' ||
    type.pgTypeKind === 'composite' ||
    type.pgArrayElementType ||
    type.pgCastsToJson === true
  ) {
    return false
  }
  if (type.pgTypeKind === 'domain' && type.pgBaseType) {
    return postgresJsonSupportsTextualLiteralRefinement(type.pgBaseType)
  }
  if (type.pgTypeSchema === 'pg_catalog' && normalizePostgresTypeName(type.pgTypeName) === 'unknown') {
    return true
  }
  return postgresTypeSupportsTextualLiteralRefinement(type)
}

/** Whether PostgreSQL JSON conversion may produce an object or array for this value. */
export function postgresJsonValueMayBeStructured(type: PostgresTypeFact): boolean {
  if (type.pgTypeKind === 'domain') {
    return type.pgBaseType ? postgresJsonValueMayBeStructured(type.pgBaseType) : true
  }

  const normalizedType = normalizePostgresTypeName(type.pgTypeName)
  return (
    type.pgTypeKind === 'array' ||
    type.pgTypeKind === 'composite' ||
    type.pgTypeKind === 'unknown' ||
    type.pgArrayElementType !== undefined ||
    type.pgCastsToJson === true ||
    normalizedType === 'unknown' ||
    (type.pgTypeSchema === 'pg_catalog' && (normalizedType === 'json' || normalizedType === 'jsonb'))
  )
}

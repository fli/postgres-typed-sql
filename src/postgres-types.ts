/**
 * The PostgreSQL type classes that affect TypeScript resolution.
 *
 * `array` is called out separately even though PostgreSQL represents arrays as
 * base types in pg_type. That distinction is useful here because parameter and
 * nested-JSON conversion recurse through the element type.
 */
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

export interface PostgresTypeScriptResolution {
  readonly ambientBindings: readonly string[]
  readonly scalarImports: readonly string[]
  readonly type: string
}

export type PostgresScalarProfile = 'conservative' | 'node-postgres'

export const defaultPostgresScalarProfile: PostgresScalarProfile = 'conservative'

const scalarImportNames = new Set([
  'DbJsonParameter',
  'DbJsonSelected',
  'PgArrayParameter',
  'PgByteaHexString',
  'PgCircle',
  'PgInt8String',
  'PgInterval',
  'PgNumericString',
  'PgPoint',
  'PgTimeString',
  'PgTimetzString',
  'PgUuidString',
])

const emptyImports: readonly string[] = []

function resolution(
  type: string,
  options: {
    readonly ambientBindings?: readonly string[]
    readonly scalarImports?: readonly string[]
  } = {}
): PostgresTypeScriptResolution {
  return {
    ambientBindings: options.ambientBindings ?? emptyImports,
    scalarImports: options.scalarImports ?? (scalarImportNames.has(type) ? [type] : emptyImports),
    type,
  }
}

const unknownResolution = resolution('unknown')
const unknownParameterResolution = resolution('NonNullable<unknown>', {
  ambientBindings: ['NonNullable'],
})
const stringResolution = resolution('string')

function uniqueImports(imports: readonly string[]): readonly string[] {
  return [...new Set(imports)]
}

function pgResultArrayResolution(element: PostgresTypeScriptResolution): PostgresTypeScriptResolution {
  return resolution(`PgArray<${element.type}>`, {
    ambientBindings: element.ambientBindings,
    scalarImports: uniqueImports(['PgArray', ...element.scalarImports]),
  })
}

function pgParameterArrayResolution(element: PostgresTypeScriptResolution): PostgresTypeScriptResolution {
  return resolution(`PgArrayParameter<${element.type}> | string`, {
    ambientBindings: element.ambientBindings,
    scalarImports: uniqueImports(['PgArrayParameter', ...element.scalarImports]),
  })
}

const byteaResolution = resolution('Uint8Array', { ambientBindings: ['Uint8Array'] })
const byteaParameterResolution = resolution('PgByteaHexString | Uint8Array', {
  ambientBindings: ['Uint8Array'],
  scalarImports: ['PgByteaHexString'],
})
const dateResultResolution = resolution('Date | number', { ambientBindings: ['Date'] })
const dateParameterResolution = resolution('Date | number | string', { ambientBindings: ['Date'] })
const intervalParameterResolution = resolution('PgInterval | string', { scalarImports: ['PgInterval'] })

function resolveArrayElementParameterType(
  typeFact: PostgresTypeFact,
  scalarProfile: PostgresScalarProfile
): PostgresTypeScriptResolution {
  if (typeFact.pgTypeSchema === 'pg_catalog' && typeFact.pgTypeName === 'bytea') {
    return resolution('PgByteaHexString')
  }
  if (typeFact.pgTypeKind !== 'domain') {
    return resolveTypeScriptParameterTypeForPostgresType(typeFact, scalarProfile)
  }
  if (!typeFact.pgBaseType) {
    return unknownParameterResolution
  }

  // A JavaScript array here would be serialized as another dimension of the
  // outer array. A domain whose scalar value is itself an array therefore has
  // to be supplied as one serialized array-literal string per outer element.
  return typeFact.pgBaseType.pgTypeKind === 'array'
    ? stringResolution
    : resolveArrayElementParameterType(typeFact.pgBaseType, scalarProfile)
}

/**
 * Default text-decoder results in pg-types 2.2.0, which is the version pinned
 * by node-postgres 8.x and by this package's parser fixtures.
 *
 * An OID absent from this table uses pg-types' identity text parser. Known
 * identity-decoded built-ins whose wire distinctions are useful retain nominal
 * string types. Point, circle, and interval use the stable structural object
 * contracts returned by pg-types' pinned parser dependencies.
 * Array entries retain PgArray because pg-types preserves dimensions and SQL
 * NULL elements.
 */
const nodePostgresTextResolutionByOid = new Map<number, PostgresTypeScriptResolution>([
  [16, resolution('boolean')], // bool
  [17, byteaResolution], // bytea
  [20, resolution('PgInt8String')], // int8
  [21, resolution('number')], // int2
  [23, resolution('number')], // int4
  [26, resolution('number')], // oid
  [114, resolution('DbJsonSelected')], // json
  [199, pgResultArrayResolution(resolution('DbJsonSelected'))], // json[]
  [600, resolution('PgPoint')], // point
  [651, pgResultArrayResolution(stringResolution)], // cidr[]
  [700, resolution('number')], // float4
  [701, resolution('number')], // float8
  [718, resolution('PgCircle')], // circle
  [791, pgResultArrayResolution(stringResolution)], // money[]
  [1000, pgResultArrayResolution(resolution('boolean'))], // bool[]
  [1001, pgResultArrayResolution(byteaResolution)], // bytea[]
  [1005, pgResultArrayResolution(resolution('number'))], // int2[]
  [1007, pgResultArrayResolution(resolution('number'))], // int4[]
  [1008, pgResultArrayResolution(stringResolution)], // regproc[]
  [1009, pgResultArrayResolution(stringResolution)], // text[]
  [1014, pgResultArrayResolution(stringResolution)], // bpchar[]
  [1015, pgResultArrayResolution(stringResolution)], // varchar[]
  [1016, pgResultArrayResolution(resolution('PgInt8String'))], // int8[]
  [1017, pgResultArrayResolution(resolution('PgPoint'))], // point[]
  [1021, pgResultArrayResolution(resolution('number'))], // float4[]
  [1022, pgResultArrayResolution(resolution('number'))], // float8[]
  [1028, pgResultArrayResolution(resolution('number'))], // oid[]
  [1040, pgResultArrayResolution(stringResolution)], // macaddr[]
  [1041, pgResultArrayResolution(stringResolution)], // inet[]
  [1082, dateResultResolution], // date (number is +/-infinity)
  [1083, resolution('PgTimeString')], // time (identity text parser)
  [1114, dateResultResolution], // timestamp (number is +/-infinity)
  [1115, pgResultArrayResolution(dateResultResolution)], // timestamp[]
  [1182, pgResultArrayResolution(dateResultResolution)], // date[]
  [1183, pgResultArrayResolution(resolution('PgTimeString'))], // time[]
  [1184, dateResultResolution], // timestamptz (number is +/-infinity)
  [1185, pgResultArrayResolution(dateResultResolution)], // timestamptz[]
  [1186, resolution('PgInterval')], // interval
  [1187, pgResultArrayResolution(resolution('PgInterval'))], // interval[]
  [1231, pgResultArrayResolution(resolution('number'))], // numeric[]
  [1266, resolution('PgTimetzString')], // timetz (identity text parser)
  [1270, pgResultArrayResolution(resolution('PgTimetzString'))], // timetz[]
  [1700, resolution('PgNumericString')], // numeric (identity text parser)
  [2950, resolution('PgUuidString')], // uuid (identity text parser)
  [2951, pgResultArrayResolution(resolution('PgUuidString'))], // uuid[]
  [3802, resolution('DbJsonSelected')], // jsonb
  [3807, pgResultArrayResolution(resolution('DbJsonSelected'))], // jsonb[]
  [3907, pgResultArrayResolution(stringResolution)], // numrange[]
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

function enumTypeResolution(typeFact: PostgresTypeFact): PostgresTypeScriptResolution {
  return typeFact.pgEnumLabels && typeFact.pgEnumLabels.length > 0
    ? resolution(typeFact.pgEnumLabels.map((label) => JSON.stringify(label)).join(' | '))
    : stringResolution
}

/** Resolve a query result decoded through node-postgres' text protocol. */
export function resolveTypeScriptResultTypeForPostgresType(
  typeFact: PostgresTypeFact,
  scalarProfile: PostgresScalarProfile = 'node-postgres'
): PostgresTypeScriptResolution {
  if (scalarProfile === 'conservative') {
    return unknownResolution
  }

  if (typeFact.pgTypeKind === 'domain') {
    return typeFact.pgBaseType
      ? resolveTypeScriptResultTypeForPostgresType(typeFact.pgBaseType, scalarProfile)
      : unknownResolution
  }
  if (typeFact.pgTypeKind === 'enum') {
    return enumTypeResolution(typeFact)
  }

  if (typeFact.pgTypeOid === 0) {
    return unknownResolution
  }
  return nodePostgresTextResolutionByOid.get(typeFact.pgTypeOid) ?? stringResolution
}

const numericParameterTypes = new Set(['bigint', 'double precision', 'integer', 'numeric', 'oid', 'real', 'smallint'])
const dateParameterTypes = new Set(['date', 'timestamp without time zone', 'timestamp with time zone', 'timestamptz'])

/** Resolve a value serialized as a node-postgres query parameter. */
export function resolveTypeScriptParameterTypeForPostgresType(
  typeFact: PostgresTypeFact,
  scalarProfile: PostgresScalarProfile = 'node-postgres'
): PostgresTypeScriptResolution {
  if (scalarProfile === 'conservative') {
    return unknownParameterResolution
  }

  if (typeFact.pgTypeKind === 'domain') {
    return typeFact.pgBaseType
      ? resolveTypeScriptParameterTypeForPostgresType(typeFact.pgBaseType, scalarProfile)
      : unknownParameterResolution
  }

  if (typeFact.pgTypeKind === 'array') {
    if (typeFact.pgArrayDelimiter !== ',') {
      return stringResolution
    }
    return typeFact.pgArrayElementType
      ? pgParameterArrayResolution(resolveArrayElementParameterType(typeFact.pgArrayElementType, scalarProfile))
      : unknownParameterResolution
  }

  if (typeFact.pgTypeKind === 'enum') {
    return enumTypeResolution(typeFact)
  }

  const normalizedType = normalizePostgresTypeName(typeFact.pgTypeName)
  if (typeFact.pgTypeSchema === 'pg_catalog' && (normalizedType === 'json' || normalizedType === 'jsonb')) {
    return resolution('DbJsonParameter')
  }
  if (typeFact.pgTypeSchema === 'pg_catalog' && numericParameterTypes.has(normalizedType)) {
    return resolution('bigint | number | string')
  }
  if (typeFact.pgTypeSchema === 'pg_catalog' && dateParameterTypes.has(normalizedType)) {
    return dateParameterResolution
  }
  if (typeFact.pgTypeSchema === 'pg_catalog' && normalizedType === 'interval') {
    return intervalParameterResolution
  }
  if (typeFact.pgTypeSchema === 'pg_catalog' && normalizedType === 'bytea') {
    return byteaParameterResolution
  }
  if (typeFact.pgTypeSchema === 'pg_catalog' && normalizedType === 'boolean') {
    return resolution('boolean')
  }

  // node-postgres' generic parameter path serializes these values as text. In
  // particular, do not reuse result-parser types for composites, ranges,
  // extension types, or other unregistered PostgreSQL types.
  return stringResolution
}

const checkLiteralCompatiblePgCatalogTypes = new Set(['name', 'text', 'uuid', 'varchar'])

function postgresTypeSupportsCheckLiteralRefinement(typeFact: PostgresTypeFact): boolean {
  if (typeFact.pgTypeKind === 'domain' && typeFact.pgBaseType) {
    return postgresTypeSupportsCheckLiteralRefinement(typeFact.pgBaseType)
  }
  if (typeFact.pgTypeKind === 'enum') {
    return true
  }
  return typeFact.pgTypeSchema === 'pg_catalog' && checkLiteralCompatiblePgCatalogTypes.has(typeFact.pgTypeName)
}

/** Whether a CHECK-derived textual literal union can safely refine this decoded result. */
export function postgresResultSupportsStringLiteralRefinement(
  typeFact: PostgresTypeFact,
  scalarProfile: PostgresScalarProfile
): boolean {
  if (scalarProfile !== 'node-postgres') {
    return false
  }
  return postgresTypeSupportsCheckLiteralRefinement(typeFact)
}

/** Whether a CHECK-derived textual literal union can safely refine this serialized parameter. */
export function postgresParameterSupportsStringLiteralRefinement(
  typeFact: PostgresTypeFact,
  scalarProfile: PostgresScalarProfile
): boolean {
  if (scalarProfile !== 'node-postgres') {
    return false
  }
  return postgresTypeSupportsCheckLiteralRefinement(typeFact)
}

const jsonNumberTypes = new Set(['bigint', 'integer', 'smallint'])
const jsonNumberOrSpecialStringTypes = new Set(['double precision', 'numeric', 'real'])

/** Whether PostgreSQL JSON conversion may produce an object or array for this value. */
export function postgresJsonValueMayBeStructured(typeFact: PostgresTypeFact): boolean {
  if (typeFact.pgTypeKind === 'domain') {
    return typeFact.pgBaseType ? postgresJsonValueMayBeStructured(typeFact.pgBaseType) : true
  }

  const normalizedType = normalizePostgresTypeName(typeFact.pgTypeName)
  return (
    typeFact.pgTypeKind === 'array' ||
    typeFact.pgTypeKind === 'composite' ||
    typeFact.pgTypeKind === 'unknown' ||
    typeFact.pgArrayElementType !== undefined ||
    typeFact.pgCastsToJson === true ||
    normalizedType === 'unknown' ||
    (typeFact.pgTypeSchema === 'pg_catalog' && (normalizedType === 'json' || normalizedType === 'jsonb'))
  )
}

/**
 * Resolve a PostgreSQL value after PostgreSQL itself converts it into a nested
 * json/jsonb value (for example inside json_build_object or json_agg).
 */
export function resolveTypeScriptJsonScalarTypeForPostgresType(
  typeFact: PostgresTypeFact
): PostgresTypeScriptResolution {
  if (typeFact.pgTypeKind === 'domain') {
    return typeFact.pgBaseType
      ? resolveTypeScriptJsonScalarTypeForPostgresType(typeFact.pgBaseType)
      : resolution('DbJsonSelected')
  }

  if (postgresJsonValueMayBeStructured(typeFact)) {
    return resolution('DbJsonSelected')
  }
  if (typeFact.pgTypeKind === 'enum') {
    return enumTypeResolution(typeFact)
  }

  const normalizedType = normalizePostgresTypeName(typeFact.pgTypeName)
  if (typeFact.pgTypeSchema === 'pg_catalog' && normalizedType === 'boolean') {
    return resolution('boolean')
  }
  if (typeFact.pgTypeSchema === 'pg_catalog' && jsonNumberTypes.has(normalizedType)) {
    return resolution('number')
  }
  if (typeFact.pgTypeSchema === 'pg_catalog' && jsonNumberOrSpecialStringTypes.has(normalizedType)) {
    return resolution('number | string')
  }

  // PostgreSQL renders textual, temporal, enum, range, and custom scalar
  // output through JSON strings rather than exposing node-postgres parsers.
  return stringResolution
}

/** Whether a CHECK-derived textual literal union matches PostgreSQL's nested-JSON representation. */
export function postgresJsonSupportsStringLiteralRefinement(typeFact: PostgresTypeFact): boolean {
  if (
    typeFact.pgTypeKind === 'array' ||
    typeFact.pgTypeKind === 'composite' ||
    typeFact.pgArrayElementType ||
    typeFact.pgCastsToJson === true
  ) {
    return false
  }
  if (typeFact.pgTypeKind === 'domain' && typeFact.pgBaseType) {
    return postgresJsonSupportsStringLiteralRefinement(typeFact.pgBaseType)
  }
  return postgresTypeSupportsCheckLiteralRefinement(typeFact)
}

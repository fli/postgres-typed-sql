import {
  normalizePostgresTypeName,
  postgresJsonSupportsTextualLiteralRefinement,
  postgresJsonValueMayBeStructured,
  postgresTypeSupportsTextualLiteralRefinement,
  type PostgresTypeFact,
} from './postgres-types.js'
import { supportsRawPgInput } from './scalar-values.js'

export interface PostgresTypeScriptResolution {
  readonly ambientBindings: readonly string[]
  readonly scalarImports: readonly string[]
  readonly type: string
}

export const postgresValueModel = 'postgres-lossless-v1'

function resolution(type: string, scalarImports: readonly string[] = []): PostgresTypeScriptResolution {
  return { type, scalarImports, ambientBindings: type === 'Uint8Array' ? ['Uint8Array'] : [] }
}

const scalarResults: Readonly<Record<string, string>> = {
  boolean: 'boolean',
  smallint: 'number',
  integer: 'number',
  oid: 'number',
  bigint: 'bigint',
  real: 'number',
  'double precision': 'number',
  numeric: 'PgDecimal',
  date: 'PgDate',
  'time without time zone': 'PgTime',
  'time with time zone': 'PgTimeTz',
  'timestamp without time zone': 'PgTimestamp',
  'timestamp with time zone': 'PgTimestampTz',
  interval: 'PgInterval',
  bytea: 'Uint8Array',
  text: 'string',
  name: 'string',
  uuid: 'string',
  char: 'string',
  json: 'PgJson',
  jsonb: 'PgJson',
}
const scalarInputs: Readonly<Record<string, string>> = {
  bigint: 'PgInt8Input',
  numeric: 'PgDecimalInput',
  date: 'PgDateInput',
  'time without time zone': 'PgTimeInput',
  'time with time zone': 'PgTimeTzInput',
  'timestamp without time zone': 'PgTimestampInput',
  'timestamp with time zone': 'PgTimestampTzInput',
  json: 'PgJsonParameter',
  jsonb: 'PgJsonParameter',
  interval: 'PgIntervalInput',
}

function namedResolution(name: string): PostgresTypeScriptResolution {
  return resolution(name, name.startsWith('Pg') ? [name] : [])
}

export function basePostgresType(type: PostgresTypeFact): PostgresTypeFact {
  return type.pgTypeKind === 'domain' && type.pgBaseType ? basePostgresType(type.pgBaseType) : type
}

function enumResolution(type: PostgresTypeFact): PostgresTypeScriptResolution {
  return resolution(
    type.pgEnumLabels?.length ? type.pgEnumLabels.map((label) => JSON.stringify(label)).join(' | ') : 'string'
  )
}

export function resolveTypeScriptResultTypeForPostgresType(type: PostgresTypeFact): PostgresTypeScriptResolution {
  type = basePostgresType(type)
  if (type.pgTypeKind === 'enum') return enumResolution(type)
  if (type.pgTypeKind === 'array' && type.pgArrayElementType) {
    const element = resolveTypeScriptResultTypeForPostgresType(type.pgArrayElementType)
    return resolution(`PgArray<${element.type} | null>`, ['PgArray', ...element.scalarImports])
  }
  const result =
    type.pgTypeSchema === 'pg_catalog' ? scalarResults[normalizePostgresTypeName(type.pgTypeName)] : undefined
  return namedResolution(result ?? 'PgRawValue')
}

export function resolveBuiltinResultArrayElement(type: PostgresTypeFact): PostgresTypeScriptResolution | undefined {
  type = basePostgresType(type)
  return type.pgTypeKind === 'array' && type.pgArrayElementType
    ? resolveTypeScriptResultTypeForPostgresType(type.pgArrayElementType)
    : undefined
}

export function resolveTypeScriptParameterTypeForPostgresType(type: PostgresTypeFact): PostgresTypeScriptResolution {
  type = basePostgresType(type)
  if (type.pgTypeKind === 'enum') return enumResolution(type)
  if (type.pgTypeKind === 'array' && type.pgArrayElementType) {
    const element = resolveTypeScriptParameterTypeForPostgresType(type.pgArrayElementType)
    return resolution(`PgArrayInput<${element.type} | null>`, ['PgArrayInput', ...element.scalarImports])
  }
  if (type.pgTypeSchema !== 'pg_catalog') return resolution('string')
  const name = normalizePostgresTypeName(type.pgTypeName)
  if (!scalarInputs[name] && !scalarResults[name]) {
    return supportsRawPgInput(type) ? resolution('string | PgRawValue', ['PgRawValue']) : resolution('string')
  }
  return namedResolution(scalarInputs[name] ?? scalarResults[name] ?? 'string')
}

export function resolveTypeScriptJsonScalarTypeForPostgresType(type: PostgresTypeFact): PostgresTypeScriptResolution {
  type = basePostgresType(type)
  if (postgresJsonValueMayBeStructured(type)) return namedResolution('PgJsonValue')
  if (type.pgTypeKind === 'enum') return enumResolution(type)
  if (type.pgTypeSchema !== 'pg_catalog') return resolution('string')
  const name = normalizePostgresTypeName(type.pgTypeName)
  if (name === 'bytea') return resolution('string')
  return namedResolution(scalarResults[name] ?? 'string')
}

export function postgresResultSupportsStringLiteralRefinement(type: PostgresTypeFact): boolean {
  return postgresTypeSupportsTextualLiteralRefinement(type)
}
export const postgresParameterSupportsStringLiteralRefinement = postgresResultSupportsStringLiteralRefinement
export function postgresJsonSupportsStringLiteralRefinement(type: PostgresTypeFact): boolean {
  return postgresJsonSupportsTextualLiteralRefinement(type)
}

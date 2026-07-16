/** Nominal PostgreSQL scalar types preserve wire-format distinctions in generated code. */
export type PgScalarString<PgType extends string> = string & {
  readonly __postgresTypedSqlScalar: PgType
}

/** A decoded PostgreSQL array result, including nested dimensions and SQL NULL elements. */
export type PgArray<Element> = readonly (Element | null | PgArray<Element>)[]

/** A one-dimensional PostgreSQL array parameter; use a serialized array-literal string for multiple dimensions. */
export type PgArrayParameter<Element> = readonly (Element | null)[]

/** Object returned by pg-types 2.2.0 for PostgreSQL point values. */
export interface PgPoint {
  readonly x: number
  readonly y: number
}

/** Object returned by pg-types 2.2.0 for PostgreSQL circle values. */
export interface PgCircle extends PgPoint {
  readonly radius: number
}

/** Object returned by postgres-interval 1.2.0 through pg-types 2.2.0. */
export interface PgInterval {
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

export type PgInt2String = PgScalarString<'int2'>
export type PgInt4String = PgScalarString<'int4'>
export type PgInt8String = PgScalarString<'int8'>
export type PgOidString = PgScalarString<'oid'>
export type PgNumericString = PgScalarString<'numeric'>
export type PgFloat4String = PgScalarString<'float4'>
export type PgFloat8String = PgScalarString<'float8'>
export type PgTimestamptzString = PgScalarString<'timestamptz'>
export type PgTimestampString = PgScalarString<'timestamp'>
export type PgDateString = PgScalarString<'date'>
export type PgTimeString = PgScalarString<'time'>
export type PgTimetzString = PgScalarString<'timetz'>
export type PgIntervalString = PgScalarString<'interval'>
export type PgByteaHexString = PgScalarString<'bytea'>
export type PgUuidString = PgScalarString<'uuid'>

export type DbJsonPrimitiveInput = boolean | number | string | null
export type DbJsonObjectInput = {
  readonly [key: string]: DbJsonInput | undefined
}
export type DbJsonArrayInput = readonly DbJsonInput[]
export type DbJsonInput = DbJsonArrayInput | DbJsonObjectInput | DbJsonPrimitiveInput

/**
 * A root json/jsonb parameter serialized by node-postgres.
 *
 * Root objects are JSON-stringified. Root arrays are PostgreSQL arrays, and
 * root null is SQL NULL, so those meanings remain outside this scalar type;
 * pass their serialized JSON text when the JSON value itself is an array or null.
 */
export type DbJsonParameter = DbJsonObjectInput | bigint | boolean | number | string

export type DbJsonPrimitiveSelected = boolean | number | string | null
export type DbJsonObjectSelected = { readonly [key: string]: DbJsonSelected }
export type DbJsonArraySelected = readonly DbJsonSelected[]
export type DbJsonSelected = DbJsonArraySelected | DbJsonObjectSelected | DbJsonPrimitiveSelected

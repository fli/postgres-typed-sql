/** Nominal PostgreSQL scalar types preserve wire-format distinctions in generated code. */
export type PgScalarString<PgType extends string> = string & {
  readonly __postgresTypedSqlScalar: PgType
}

/** PostgreSQL arrays may be multidimensional and may contain SQL NULL elements. */
export type PgArray<Element> = readonly (Element | null | PgArray<Element>)[]

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

export type DbJsonPrimitiveSelected = boolean | number | string | null
export type DbJsonObjectSelected = { readonly [key: string]: DbJsonSelected }
export type DbJsonArraySelected = readonly DbJsonSelected[]
export type DbJsonSelected = DbJsonArraySelected | DbJsonObjectSelected | DbJsonPrimitiveSelected

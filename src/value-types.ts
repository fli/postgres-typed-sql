import type { PostgresTypeFact } from './postgres-types.js'

export interface PgInfinity {
  readonly kind: 'infinity'
  readonly negative: boolean
}

export interface PgFiniteDecimal {
  readonly kind: 'finite'
  readonly negative: boolean
  readonly coefficient: bigint
  readonly exponent: bigint
}
export interface PgNaN {
  readonly kind: 'nan'
}
export type PgDecimal = PgFiniteDecimal | PgInfinity | PgNaN
export type PgDecimalInput = PgDecimal | string | bigint | number
export type PgInt8Input = bigint | number | string

export interface PgCalendarDate {
  readonly year: number
  readonly month: number
  readonly day: number
}
export interface PgFiniteDate extends PgCalendarDate {
  readonly kind: 'finite'
}
export type PgDate = PgFiniteDate | PgInfinity
export interface PgTime {
  readonly hour: number
  readonly minute: number
  readonly second: number
  readonly millisecond: number
  readonly microsecond: number
}
export interface PgTimeTz {
  readonly time: PgTime
  readonly utcOffsetSeconds: number
}
export interface PgFiniteTimestamp {
  readonly kind: 'finite'
  readonly date: PgCalendarDate
  readonly time: PgTime
}
export type PgTimestamp = PgFiniteTimestamp | PgInfinity
export interface PgFiniteTimestampTz {
  readonly kind: 'finite'
  readonly unixMicroseconds: bigint
}
export type PgTimestampTz = PgFiniteTimestampTz | PgInfinity
export interface PgFiniteInterval {
  readonly kind: 'finite'
  readonly months: number
  readonly days: number
  readonly microseconds: bigint
}
export type PgInterval = PgFiniteInterval | PgInfinity
export type PgDateInput = PgDate | string
export type PgTimeInput = PgTime | string
export type PgTimeTzInput = PgTimeTz | string
export type PgTimestampInput = PgTimestamp | string
export type PgTimestampTzInput = PgTimestampTz | string | Date
export type PgIntervalInput = PgInterval | string

export interface PgArrayDimension {
  readonly lowerBound: number
  readonly length: number
}
/** Flat row-major elements. PostgreSQL's last dimension varies fastest. */
export interface PgArray<Element> {
  readonly dimensions: readonly PgArrayDimension[]
  readonly values: readonly Element[]
}
export type PgArrayInput<Element> = readonly Element[] | PgArray<Element>
export interface PgTypeIdentity {
  readonly schema: string
  readonly name: string
}
export interface PgSource {
  readonly format: 'text'
  readonly value: string
}
export interface PgRawValue {
  readonly kind: 'raw'
  readonly type: PgTypeIdentity
  readonly source: PgSource
}

export type JsonReadonly<T> = PgJsonValue extends T
  ? T
  : T extends readonly unknown[]
    ? { readonly [Key in keyof T]: JsonReadonly<T[Key]> }
    : T extends object
      ? { readonly [Key in keyof T]: JsonReadonly<T[Key]> }
      : T
export type PgJsonValue =
  | null
  | boolean
  | string
  | PgFiniteDecimal
  | readonly PgJsonValue[]
  | { readonly [key: string]: PgJsonValue }
export type PgJsonInput =
  | null
  | boolean
  | string
  | number
  | bigint
  | PgFiniteDecimal
  | readonly PgJsonInput[]
  | { readonly [key: string]: PgJsonInput }
export type JsonDecoded<T> = PgJsonInput extends T
  ? PgJsonValue
  : T extends number | bigint | PgFiniteDecimal
    ? PgFiniteDecimal
    : T extends readonly unknown[]
      ? { readonly [Key in keyof T]: JsonDecoded<T[Key]> }
      : T extends object
        ? { readonly [Key in keyof T]: JsonDecoded<T[Key]> }
        : T

declare const jsonCodecType: unique symbol
declare const jsonDocumentType: unique symbol
export interface PgJsonCodec<T> {
  readonly valueModel: 'postgres-lossless-v1'
  readonly [jsonCodecType]: T
}
export interface PgJson<T = PgJsonValue> {
  readonly kind: 'json'
  readonly value: JsonReadonly<T>
  readonly source: string
  readonly codec: PgJsonCodec<T>
  readonly [jsonDocumentType]: true
}
export type PgJsonParameter = PgJson<unknown> | PgJsonInput

/** The generated JSON interpretation; not an application mapping extension point. */
export type PgJsonPlan =
  | { readonly kind: 'generic' }
  | { readonly kind: 'null' }
  | { readonly kind: 'string'; readonly nullable?: boolean }
  | { readonly kind: 'number'; readonly nullable?: boolean }
  | { readonly kind: 'literal'; readonly value: string | boolean; readonly nullable?: boolean }
  | { readonly kind: 'scalar'; readonly type: PostgresTypeFact; readonly nullable?: boolean }
  | { readonly kind: 'array'; readonly element: PgJsonPlan; readonly nullable?: boolean }
  | {
      readonly kind: 'object'
      readonly fields: readonly {
        readonly name: string
        readonly optional?: boolean
        readonly propertyName: string
        readonly plan: PgJsonPlan
      }[]
      readonly nullable?: boolean
    }
  | { readonly kind: 'union'; readonly alternatives: readonly PgJsonPlan[] }

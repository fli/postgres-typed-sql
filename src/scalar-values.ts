import type { PostgresTypeFact } from './postgres-types.js'
import type { PgCalendarDate, PgDecimal, PgFiniteDecimal, PgTime } from './value-types.js'

const atoms = new WeakSet<object>()
const decimalPattern = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/u
const jsonPattern = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/u

type DecimalParts = Pick<PgFiniteDecimal, 'negative' | 'coefficient' | 'exponent'>

export function decimal(source: string): PgDecimal
export function decimal(source: DecimalParts): PgFiniteDecimal
export function decimal(source: string | DecimalParts): PgDecimal {
  if (typeof source === 'string') {
    if (/^[+]?infinity$/iu.test(source)) return decimalValue({ kind: 'infinity', negative: false })
    if (/^-infinity$/iu.test(source)) return decimalValue({ kind: 'infinity', negative: true })
    if (/^nan$/iu.test(source)) return decimalValue({ kind: 'nan' })
    const match = decimalPattern.exec(source)
    if (!match) throw new TypeError('Invalid decimal')
    const fraction = match[3] ?? match[4] ?? ''
    return finiteDecimal(
      match[1] === '-',
      BigInt((match[2] ?? '') + fraction),
      BigInt(match[5] ?? '0') - BigInt(fraction.length)
    )
  }
  const { negative, coefficient, exponent } = object(source)
  if (
    typeof negative !== 'boolean' ||
    typeof coefficient !== 'bigint' ||
    coefficient < 0n ||
    typeof exponent !== 'bigint'
  )
    throw new TypeError('Invalid decimal components')
  return finiteDecimal(negative, coefficient, exponent)
}

function finiteDecimal(negative: boolean, coefficient: bigint, exponent: bigint): PgFiniteDecimal {
  return decimalValue({ kind: 'finite', negative, coefficient, exponent })
}

function decimalValue<T extends PgDecimal>(value: T): T {
  const result = Object.freeze(value)
  atoms.add(result)
  return result
}

export function jsonNumber(source: string | bigint): PgFiniteDecimal {
  const text = String(source)
  if (!jsonPattern.test(text)) throw new TypeError('Invalid JSON number')
  const result = decimal(text)
  if (result.kind !== 'finite') throw new TypeError('Invalid JSON number')
  return result
}

export function isDecimalAtom(value: unknown): value is PgFiniteDecimal {
  return isPgDecimal(value) && value.kind === 'finite'
}

export function isPgDecimal(value: unknown): value is PgDecimal {
  return typeof value === 'object' && value !== null && atoms.has(value)
}

export function formatDecimal(value: PgDecimal): string {
  if (!value || typeof value !== 'object') throw new TypeError('Invalid decimal')
  if (value.kind === 'nan') return 'NaN'
  if (value.kind === 'infinity' && typeof value.negative === 'boolean') return value.negative ? '-Infinity' : 'Infinity'
  if (
    value.kind === 'finite' &&
    typeof value.negative === 'boolean' &&
    typeof value.coefficient === 'bigint' &&
    value.coefficient >= 0n &&
    typeof value.exponent === 'bigint'
  ) {
    return `${value.negative ? '-' : ''}${value.coefficient}e${value.exponent}`
  }
  throw new TypeError('Invalid decimal')
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Expected a value record')
  const prototype: unknown = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError('Expected a plain value record')
  if (Object.values(Object.getOwnPropertyDescriptors(value)).some((descriptor) => !('value' in descriptor))) {
    throw new TypeError('Value records cannot contain accessors')
  }
  return value as Record<string, unknown>
}
function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max)
    throw new RangeError('Integer outside PostgreSQL range')
  return value
}
function int8(value: unknown, min: bigint, max: bigint): bigint {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new RangeError('Unsafe integer')
  if (
    typeof value !== 'bigint' &&
    typeof value !== 'number' &&
    !(typeof value === 'string' && /^[+-]?\d+$/u.test(value))
  )
    throw new TypeError('Invalid integer')
  const result = BigInt(value)
  if (result < min || result > max) throw new RangeError('Integer outside PostgreSQL range')
  return result
}
function infinity(value: unknown): string | undefined {
  if (typeof value === 'object' && value !== null && 'kind' in value && value.kind === 'infinity') {
    if (!('negative' in value) || typeof value.negative !== 'boolean') throw new TypeError('Invalid infinity')
    return value.negative ? '-infinity' : 'infinity'
  }
  return undefined
}
function parseInfinity(source: string): { readonly kind: 'infinity'; readonly negative: boolean } | undefined {
  if (source === 'infinity' || source === '-infinity')
    return Object.freeze({ kind: 'infinity', negative: source[0] === '-' })
  return undefined
}
function dateParts(year: number, month: number, day: number): PgCalendarDate {
  integer(year, -4713, 5874897)
  integer(month, 1, 12)
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const maxDay = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
  integer(day, 1, maxDay ?? 0)
  if (year === -4713 && (month < 11 || (month === 11 && day < 24)))
    throw new RangeError('Date outside PostgreSQL range')
  return Object.freeze({ year, month, day })
}
function parseDate(source: string): PgCalendarDate {
  const match = /^(\d{4,7})-(\d\d)-(\d\d)( BC)?$/u.exec(source)
  if (!match || Number(match[1]) === 0) throw new TypeError('Invalid PostgreSQL date')
  return dateParts(match[4] ? 1 - Number(match[1]) : Number(match[1]), Number(match[2]), Number(match[3]))
}
function dateText(value: PgCalendarDate): string {
  const date = dateParts(value.year, value.month, value.day)
  return `${String(date.year <= 0 ? 1 - date.year : date.year).padStart(4, '0')}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}${date.year <= 0 ? ' BC' : ''}`
}
function readDate(value: unknown): PgCalendarDate {
  const fields = object(value)
  return dateParts(integer(fields.year, -4713, 5874897), integer(fields.month, 1, 12), integer(fields.day, 1, 31))
}
function timeParts(hour: number, minute: number, second: number, millisecond: number, microsecond: number): PgTime {
  integer(hour, 0, 24)
  integer(minute, 0, 59)
  integer(second, 0, 59)
  integer(millisecond, 0, 999)
  integer(microsecond, 0, 999)
  if (hour === 24 && (minute || second || millisecond || microsecond)) throw new RangeError('Invalid 24-hour time')
  return Object.freeze({ hour, minute, second, millisecond, microsecond })
}
function parseTime(source: string): PgTime {
  const match = /^(\d\d):(\d\d):(\d\d)(?:\.(\d{1,6}))?$/u.exec(source)
  if (!match) throw new TypeError('Invalid PostgreSQL time')
  const fraction = (match[4] ?? '').padEnd(6, '0')
  return timeParts(
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
    Number(fraction.slice(0, 3)),
    Number(fraction.slice(3))
  )
}
function readTime(value: unknown): PgTime {
  const t = object(value)
  return timeParts(
    integer(t.hour, 0, 24),
    integer(t.minute, 0, 59),
    integer(t.second, 0, 59),
    integer(t.millisecond, 0, 999),
    integer(t.microsecond, 0, 999)
  )
}
function timeText(value: PgTime): string {
  const t = readTime(value)
  return `${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}:${String(t.second).padStart(2, '0')}.${String(t.millisecond).padStart(3, '0')}${String(t.microsecond).padStart(3, '0')}`
}
function offsetValue(source: string): number {
  const match = /^([+-])(\d\d)(?::?(\d\d))?(?::?(\d\d))?$/u.exec(source)
  if (!match) throw new TypeError('Invalid time zone offset')
  const h = integer(Number(match[2]), 0, 15)
  const m = integer(Number(match[3] ?? 0), 0, 59)
  const s = integer(Number(match[4] ?? 0), 0, 59)
  return (match[1] === '-' ? -1 : 1) * (h * 3600 + m * 60 + s)
}
function offsetText(offset: number): string {
  integer(offset, -57599, 57599)
  const absolute = Math.abs(offset)
  return `${offset < 0 ? '-' : '+'}${String(Math.floor(absolute / 3600)).padStart(2, '0')}:${String(Math.floor((absolute % 3600) / 60)).padStart(2, '0')}:${String(absolute % 60).padStart(2, '0')}`
}
function parseTimeTz(source: string): { time: PgTime; utcOffsetSeconds: number } {
  const match = /^(\d\d:\d\d:\d\d(?:\.\d{1,6})?)([+-].+)$/u.exec(source)
  if (!match) throw new TypeError('Invalid PostgreSQL time with time zone')
  return Object.freeze({ time: parseTime(match[1] ?? ''), utcOffsetSeconds: offsetValue(match[2] ?? '') })
}
function parseTimestamp(source: string): { date: PgCalendarDate; time: PgTime } {
  const match = /^(\d{4,7}-\d\d-\d\d)[ T](\d\d:\d\d:\d\d(?:\.\d{1,6})?)( BC)?$/u.exec(source)
  if (!match) throw new TypeError('Invalid PostgreSQL timestamp')
  return { date: parseDate((match[1] ?? '') + (match[3] ?? '')), time: parseTime(match[2] ?? '') }
}
function timestampText(date: PgCalendarDate, time: PgTime): string {
  const dateString = dateText(date)
  const bc = dateString.endsWith(' BC')
  return `${bc ? dateString.slice(0, -3) : dateString} ${timeText(time)}${bc ? ' BC' : ''}`
}
function floorDiv(a: bigint, b: bigint): bigint {
  const q = a / b
  return a % b < 0n ? q - 1n : q
}
function daysFromCivil(date: PgCalendarDate): bigint {
  let y = BigInt(date.year)
  const m = BigInt(date.month)
  if (m <= 2n) y--
  const era = floorDiv(y, 400n)
  const yoe = y - era * 400n
  const doy = (153n * (m + (m > 2n ? -3n : 9n)) + 2n) / 5n + BigInt(date.day) - 1n
  return era * 146097n + yoe * 365n + yoe / 4n - yoe / 100n + doy - 719468n
}
function civilFromDays(days: bigint): PgCalendarDate {
  const z = days + 719468n
  const era = floorDiv(z, 146097n)
  const doe = z - era * 146097n
  const yoe = (doe - doe / 1460n + doe / 36524n - doe / 146096n) / 365n
  let year = yoe + era * 400n
  const doy = doe - (365n * yoe + yoe / 4n - yoe / 100n)
  const mp = (5n * doy + 2n) / 153n
  const day = doy - (153n * mp + 2n) / 5n + 1n
  const month = mp + (mp < 10n ? 3n : -9n)
  if (month <= 2n) year++
  return dateParts(Number(year), Number(month), Number(day))
}
const dayMicros = 86400000000n
function parseTimestampTz(source: string): bigint {
  const match = /^(\d{4,7}-\d\d-\d\d)[ T](\d\d:\d\d:\d\d(?:\.\d{1,6})?)(Z|[+-]\d\d(?::?\d\d)?(?::?\d\d)?)( BC)?$/u.exec(
    source
  )
  if (!match) throw new TypeError('Timestamp with time zone requires an explicit offset')
  const date = parseDate((match[1] ?? '') + (match[4] ?? ''))
  const time = parseTime(match[2] ?? '')
  const offset = match[3] === 'Z' ? 0 : offsetValue(match[3] ?? '')
  return (
    daysFromCivil(date) * dayMicros +
    BigInt(time.hour * 3600 + time.minute * 60 + time.second - offset) * 1000000n +
    BigInt(time.millisecond * 1000 + time.microsecond)
  )
}
function timestampTzText(micros: bigint): string {
  const days = floorDiv(micros, dayMicros)
  let rest = micros - days * dayMicros
  const date = civilFromDays(days)
  const hour = Number(rest / 3600000000n)
  rest %= 3600000000n
  const minute = Number(rest / 60000000n)
  rest %= 60000000n
  const second = Number(rest / 1000000n)
  rest %= 1000000n
  const text = timestampText(date, timeParts(hour, minute, second, Number(rest / 1000n), Number(rest % 1000n)))
  return text.endsWith(' BC') ? `${text.slice(0, -3)}+00 BC` : `${text}+00`
}
const int64Min = -9223372036854775808n
const int64Max = 9223372036854775807n
const timestampMin = -210866803200000000n
const timestampMax = 9224318015999999999n
function timestampRange(value: bigint): bigint {
  if (value < timestampMin || value > timestampMax) throw new RangeError('Timestamp outside PostgreSQL range')
  return value
}
function parseInterval(source: string): {
  readonly kind: 'finite'
  readonly months: number
  readonly days: number
  readonly microseconds: bigint
} {
  let rest = source.trim()
  let months = 0
  let days = 0
  let microseconds = 0n
  let seen = false
  const units: readonly [RegExp, (value: number) => void][] = [
    [
      /^([+-]?\d+) years?\b\s*/u,
      (value) => {
        months += value * 12
      },
    ],
    [
      /^([+-]?\d+) mons?\b\s*/u,
      (value) => {
        months += value
      },
    ],
    [
      /^([+-]?\d+) days?\b\s*/u,
      (value) => {
        days += value
      },
    ],
  ]
  for (const [pattern, apply] of units) {
    const match = pattern.exec(rest)
    if (match) {
      apply(Number(match[1]))
      rest = rest.slice(match[0].length)
      seen = true
    }
  }
  if (rest) {
    const time = /^([+-]?)(\d+):(\d\d):(\d\d)(?:\.(\d{1,6}))?$/u.exec(rest)
    if (!time) throw new TypeError('Invalid PostgreSQL interval')
    const minutes = integer(Number(time[3]), 0, 59)
    const seconds = integer(Number(time[4]), 0, 59)
    microseconds =
      (BigInt(time[2] ?? '') * 3600n + BigInt(minutes * 60 + seconds)) * 1000000n +
      BigInt((time[5] ?? '').padEnd(6, '0'))
    if (time[1] === '-') microseconds = -microseconds
    seen = true
  }
  if (!seen) throw new TypeError('Invalid PostgreSQL interval')
  integer(months, -2147483648, 2147483647)
  integer(days, -2147483648, 2147483647)
  if (microseconds < int64Min || microseconds > int64Max) throw new RangeError('Interval outside PostgreSQL range')
  return Object.freeze({ kind: 'finite', months, days, microseconds })
}
function finiteInterval(value: unknown): {
  readonly months: number
  readonly days: number
  readonly microseconds: bigint
} {
  const fields = object(value)
  if (
    fields.kind !== 'finite' ||
    typeof fields.microseconds !== 'bigint' ||
    fields.microseconds < int64Min ||
    fields.microseconds > int64Max
  )
    throw new TypeError('Invalid interval')
  return {
    months: integer(fields.months, -2147483648, 2147483647),
    days: integer(fields.days, -2147483648, 2147483647),
    microseconds: fields.microseconds,
  }
}
const stringTypes = new Set(['text', 'varchar', 'bpchar', 'name', 'uuid', 'char'])
const rawTypes = new Set([
  'bit',
  'varbit',
  'inet',
  'cidr',
  'macaddr',
  'macaddr8',
  'point',
  'box',
  'circle',
  'line',
  'lseg',
  'path',
  'polygon',
  'tsvector',
  'tsquery',
  'xml',
])

export function supportsRawPgInput(type: PostgresTypeFact): boolean {
  return type.pgTypeSchema === 'pg_catalog' && rawTypes.has(type.pgTypeName)
}
function rawValue(type: PostgresTypeFact, source: string): unknown {
  return Object.freeze({
    kind: 'raw',
    type: Object.freeze({ schema: type.pgTypeSchema, name: type.pgTypeName }),
    source: Object.freeze({ format: 'text', value: source }),
  })
}
function decimalInput(value: unknown): PgDecimal {
  if (typeof value === 'string' || typeof value === 'bigint') return decimal(String(value))
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))
      throw new RangeError('Invalid numeric input')
    return decimal(Object.is(value, -0) ? '-0' : String(value))
  }
  const record = object(value)
  if (record.kind === 'finite') {
    if (
      typeof record.negative !== 'boolean' ||
      typeof record.coefficient !== 'bigint' ||
      typeof record.exponent !== 'bigint'
    )
      throw new TypeError('Invalid decimal')
    return decimal({ negative: record.negative, coefficient: record.coefficient, exponent: record.exponent })
  }
  if (record.kind === 'infinity' && typeof record.negative === 'boolean')
    return { kind: 'infinity', negative: record.negative }
  if (record.kind === 'nan') return { kind: 'nan' }
  throw new TypeError('Invalid decimal')
}
function floatInput(value: unknown, single: boolean): number {
  let number: number
  if (typeof value === 'number') number = value
  else if (
    typeof value === 'string' &&
    /^(?:[+-]?(?:(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|Infinity)|NaN)$/u.test(value)
  ) {
    number = Number(value)
    const finiteSpelling = !['Infinity', '+Infinity', '-Infinity', 'NaN'].includes(value)
    const nonzeroSpelling = /[1-9]/u.test(value.split(/[eE]/u)[0] ?? '')
    if (finiteSpelling && (!Number.isFinite(number) || (number === 0 && nonzeroSpelling))) {
      throw new RangeError('Floating-point value out of range')
    }
  } else throw new TypeError('Invalid floating-point value')
  const result = single ? Math.fround(number) : number
  if (Number.isFinite(number) && (!Number.isFinite(result) || (number !== 0 && result === 0)))
    throw new RangeError('Floating-point value out of range')
  return result
}
function floatOutput(source: string, single: boolean): number {
  return floatInput(source, single)
}
function baseType(type: PostgresTypeFact): PostgresTypeFact {
  if (type.pgTypeKind !== 'domain') return type
  if (!type.pgBaseType) throw new TypeError('Domain base type is unavailable')
  return baseType(type.pgBaseType)
}
export function decodePgScalar(type: PostgresTypeFact, source: string): unknown {
  type = baseType(type)
  if (type.pgTypeKind === 'enum') {
    if (type.pgEnumLabels && !type.pgEnumLabels.includes(source)) throw new TypeError('Invalid enum label')
    return source
  }
  if (type.pgTypeSchema !== 'pg_catalog') return rawValue(type, source)
  switch (type.pgTypeName) {
    case 'bool':
      if (source === 't') return true
      if (source === 'f') return false
      throw new TypeError('Invalid PostgreSQL boolean')
    case 'int2':
      return Number(int8(source, -32768n, 32767n))
    case 'int4':
      return Number(int8(source, -2147483648n, 2147483647n))
    case 'oid':
      return Number(int8(source, 0n, 4294967295n))
    case 'int8':
      return int8(source, int64Min, int64Max)
    case 'numeric':
      return decimal(source)
    case 'float4':
      return floatOutput(source, true)
    case 'float8':
      return floatOutput(source, false)
    case 'bytea': {
      if (!/^\\x(?:[0-9a-fA-F]{2})*$/u.test(source)) throw new TypeError('Invalid PostgreSQL bytea hex')
      return Uint8Array.from(source.slice(2).match(/../gu) ?? [], (byte) => Number.parseInt(byte, 16))
    }
    case 'date':
      return parseInfinity(source) ?? Object.freeze({ kind: 'finite', ...parseDate(source) })
    case 'time':
      return parseTime(source)
    case 'timetz':
      return parseTimeTz(source)
    case 'timestamp': {
      const inf = parseInfinity(source)
      if (inf) return inf
      const parsed = parseTimestamp(source)
      timestampRange(
        daysFromCivil(parsed.date) * dayMicros +
          BigInt(parsed.time.hour * 3600 + parsed.time.minute * 60 + parsed.time.second) * 1000000n +
          BigInt(parsed.time.millisecond * 1000 + parsed.time.microsecond)
      )
      return Object.freeze({ kind: 'finite', ...parsed })
    }
    case 'timestamptz':
      return (
        parseInfinity(source) ??
        Object.freeze({ kind: 'finite', unixMicroseconds: timestampRange(parseTimestampTz(source)) })
      )
    case 'interval':
      return parseInfinity(source) ?? parseInterval(source)
    default:
      return stringTypes.has(type.pgTypeName) ? source : rawValue(type, source)
  }
}
export function encodePgScalar(type: PostgresTypeFact, value: unknown): string {
  type = baseType(type)
  if (type.pgTypeKind === 'enum') {
    if (typeof value !== 'string' || (type.pgEnumLabels && !type.pgEnumLabels.includes(value)))
      throw new TypeError('Invalid enum label')
    return value
  }
  if (type.pgTypeSchema !== 'pg_catalog') {
    if (typeof value === 'string') return value
    throw new TypeError('Unsupported raw PostgreSQL parameter type')
  }
  switch (type.pgTypeName) {
    case 'bool':
      if (typeof value !== 'boolean') throw new TypeError('Expected boolean')
      return value ? 'true' : 'false'
    case 'int2':
      return String(int8(value, -32768n, 32767n))
    case 'int4':
      return String(int8(value, -2147483648n, 2147483647n))
    case 'oid':
      return String(int8(value, 0n, 4294967295n))
    case 'int8':
      return String(int8(value, int64Min, int64Max))
    case 'numeric': {
      const numeric = decimalInput(value)
      if (
        numeric.kind === 'finite' &&
        (numeric.exponent < -16383n ||
          (numeric.coefficient !== 0n && BigInt(numeric.coefficient.toString().length) + numeric.exponent > 131072n) ||
          numeric.exponent > 2147483647n)
      )
        throw new RangeError('Numeric outside PostgreSQL range')
      return formatDecimal(numeric)
    }
    case 'float4':
    case 'float8': {
      const result = floatInput(value, type.pgTypeName === 'float4')
      return Object.is(result, -0) ? '-0' : String(result)
    }
    case 'bytea': {
      if (!(value instanceof Uint8Array)) throw new TypeError('Expected Uint8Array')
      return `\\x${Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('')}`
    }
    case 'date': {
      if (typeof value === 'string') {
        const inf = parseInfinity(value)
        return inf ? value : dateText(parseDate(value))
      }
      const inf = infinity(value)
      if (inf) return inf
      if (object(value).kind !== 'finite') throw new TypeError('Invalid date')
      return dateText(readDate(value))
    }
    case 'time':
      return timeText(typeof value === 'string' ? parseTime(value) : readTime(value))
    case 'timetz': {
      const parts = typeof value === 'string' ? parseTimeTz(value) : object(value)
      return `${timeText(readTime(parts.time))}${offsetText(integer(parts.utcOffsetSeconds, -57599, 57599))}`
    }
    case 'timestamp': {
      const inf = infinity(value)
      if (inf) return inf
      if (typeof value === 'string') {
        const special = parseInfinity(value)
        if (special) return value
      }
      const fields = typeof value === 'string' ? parseTimestamp(value) : object(value)
      if (typeof value !== 'string' && object(value).kind !== 'finite') throw new TypeError('Invalid timestamp')
      const date = readDate(fields.date)
      const time = readTime(fields.time)
      timestampRange(
        daysFromCivil(date) * dayMicros +
          BigInt(time.hour * 3600 + time.minute * 60 + time.second) * 1000000n +
          BigInt(time.millisecond * 1000 + time.microsecond)
      )
      return timestampText(date, time)
    }
    case 'timestamptz': {
      const inf = infinity(value)
      if (inf) return inf
      if (typeof value === 'string') {
        const special = parseInfinity(value)
        if (special) return value
        return timestampTzText(timestampRange(parseTimestampTz(value)))
      }
      if (value instanceof Date) {
        const millis = value.getTime()
        if (!Number.isFinite(millis)) throw new RangeError('Invalid Date')
        return timestampTzText(timestampRange(BigInt(millis) * 1000n))
      }
      const fields = object(value)
      if (fields.kind !== 'finite' || typeof fields.unixMicroseconds !== 'bigint')
        throw new TypeError('Invalid timestamp with time zone')
      return timestampTzText(timestampRange(fields.unixMicroseconds))
    }
    case 'interval': {
      const inf = infinity(value)
      if (inf) return inf
      if (typeof value === 'string') {
        const special = parseInfinity(value)
        if (special) return value
      }
      const fields = typeof value === 'string' ? parseInterval(value) : finiteInterval(value)
      return `${fields.months} mons ${fields.days} days ${fields.microseconds} microseconds`
    }
    default: {
      if (stringTypes.has(type.pgTypeName)) {
        if (typeof value !== 'string') throw new TypeError('Expected string')
        return value
      }
      if (typeof value === 'string') return value
      if (!rawTypes.has(type.pgTypeName)) throw new TypeError('Unsupported raw PostgreSQL parameter type')
      const raw = object(value)
      const identity = object(raw.type)
      const source = object(raw.source)
      if (
        raw.kind !== 'raw' ||
        identity.schema !== type.pgTypeSchema ||
        identity.name !== type.pgTypeName ||
        source.format !== 'text' ||
        typeof source.value !== 'string'
      )
        throw new TypeError('Invalid raw PostgreSQL parameter')
      return source.value
    }
  }
}

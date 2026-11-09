import type { PgArray, PgArrayDimension } from './value-types.js'

const MIN_BOUND = -2147483648
const MAX_BOUND = 2147483647

function checkDelimiter(delimiter: string): void {
  if (delimiter.length !== 1 || /[{}"\\ \t\n\r\f\v]/u.test(delimiter))
    throw new TypeError('Invalid PostgreSQL array delimiter')
}

function checkDimensions(dimensions: readonly PgArrayDimension[], count: number): void {
  if (dimensions.length > 6) throw new RangeError('PostgreSQL arrays have at most six dimensions')
  let product = dimensions.length === 0 ? 0 : 1
  for (const { lowerBound, length } of dimensions) {
    if (
      !Number.isInteger(lowerBound) ||
      lowerBound < MIN_BOUND ||
      lowerBound > MAX_BOUND ||
      !Number.isSafeInteger(length) ||
      length <= 0 ||
      lowerBound + length - 1 > MAX_BOUND
    ) {
      throw new RangeError('Invalid PostgreSQL array bounds')
    }
    product *= length
    if (!Number.isSafeInteger(product) || product > count) throw new RangeError('Invalid PostgreSQL array dimensions')
  }
  if (product !== count) throw new RangeError('PostgreSQL array dimensions do not match its values')
}

export function parsePgArray(source: string, delimiter = ','): PgArray<string | null> {
  checkDelimiter(delimiter)
  let pos = 0
  const bounds: PgArrayDimension[] = []
  const skip = () => {
    while (/[ \t\n\r\f\v]/u.test(source[pos] ?? '') && pos < source.length) pos++
  }
  skip()
  while (source[pos] === '[') {
    const match = /^\[(-?\d+):(-?\d+)\]/u.exec(source.slice(pos))
    if (!match) throw new SyntaxError('Invalid PostgreSQL array bounds')
    const lowerBound = Number(match[1])
    const upperBound = Number(match[2])
    bounds.push({ lowerBound, length: upperBound - lowerBound + 1 })
    pos += match[0].length
  }
  if (bounds.length) {
    if (source[pos++] !== '=') throw new SyntaxError('Invalid PostgreSQL array bounds')
    skip()
  }
  const values: (string | null)[] = []
  function level(depth: number): number[] {
    if (depth > 6 || source[pos++] !== '{') throw new SyntaxError('Invalid PostgreSQL array')
    skip()
    if (source[pos] === '}') {
      pos++
      return [0]
    }
    let length = 0
    let nestedShape: number[] | undefined
    let nested: boolean | undefined
    while (true) {
      skip()
      const isNested = source[pos] === '{'
      if (nested !== undefined && nested !== isNested) throw new SyntaxError('Non-rectangular PostgreSQL array')
      nested = isNested
      if (isNested) {
        const shape = level(depth + 1)
        if (nestedShape && (shape.length !== nestedShape.length || shape.some((n, i) => n !== nestedShape?.[i]))) {
          throw new SyntaxError('Non-rectangular PostgreSQL array')
        }
        nestedShape = shape
      } else if (source[pos] === '"') {
        pos++
        let value = ''
        let closed = false
        while (pos < source.length) {
          const char = source[pos++]
          if (char === '"') {
            closed = true
            break
          }
          if (char === '\\') {
            if (pos >= source.length) throw new SyntaxError('Invalid PostgreSQL array escape')
            value += source[pos++]
          } else value += char
        }
        if (!closed) throw new SyntaxError('Unclosed PostgreSQL array string')
        values.push(value)
      } else {
        let value = ''
        let pending = ''
        let escaped = false
        while (pos < source.length && source[pos] !== delimiter && source[pos] !== '}') {
          const char = source[pos++]
          if (char === '{' || char === '"') throw new SyntaxError('Invalid PostgreSQL array element')
          if (char === '\\') {
            if (pos >= source.length) throw new SyntaxError('Invalid PostgreSQL array escape')
            value += pending + source[pos++]
            pending = ''
            escaped = true
          } else if (/[ \t\n\r\f\v]/u.test(char ?? '')) pending += char
          else {
            value += pending + char
            pending = ''
          }
        }
        if (!value) throw new SyntaxError('Empty unquoted PostgreSQL array element')
        values.push(!escaped && value.toUpperCase() === 'NULL' ? null : value)
      }
      length++
      skip()
      if (source[pos] === '}') {
        pos++
        break
      }
      if (source[pos++] !== delimiter) throw new SyntaxError('Invalid PostgreSQL array separator')
    }
    return [length, ...(nestedShape ?? [])]
  }
  const shape = level(1)
  skip()
  if (pos !== source.length) throw new SyntaxError('Trailing PostgreSQL array text')
  const dimensions =
    values.length === 0 ? [] : bounds.length ? bounds : shape.map((length) => ({ lowerBound: 1, length }))
  if (
    bounds.length &&
    (bounds.length !== shape.length || bounds.some((dimension, i) => dimension.length !== shape[i]))
  ) {
    throw new RangeError('PostgreSQL array bounds do not match contents')
  }
  if (values.length === 0 && (shape.length !== 1 || bounds.length))
    throw new RangeError('Invalid empty PostgreSQL array')
  checkDimensions(dimensions, values.length)
  return Object.freeze({
    dimensions: Object.freeze(dimensions.map((dimension) => Object.freeze(dimension))),
    values: Object.freeze(values),
  })
}

export function formatPgArray(
  input: readonly unknown[] | PgArray<unknown>,
  encodeElement: (value: unknown) => string,
  delimiter = ','
): string {
  checkDelimiter(delimiter)
  const array: PgArray<unknown> = Array.isArray(input)
    ? { dimensions: input.length ? [{ lowerBound: 1, length: input.length }] : [], values: input }
    : (input as PgArray<unknown>)
  if (!array || !Array.isArray(array.dimensions) || !Array.isArray(array.values))
    throw new TypeError('Invalid PostgreSQL array')
  checkDimensions(array.dimensions, array.values.length)
  if (!array.dimensions.length) return '{}'
  let index = 0
  function level(depth: number): string {
    const dimension = array.dimensions[depth]
    if (!dimension) throw new RangeError('Invalid PostgreSQL array dimensions')
    const elements: string[] = []
    for (let i = 0; i < dimension.length; i++) {
      if (depth + 1 < array.dimensions.length) elements.push(level(depth + 1))
      else {
        const value = array.values[index++]
        if (value === null) elements.push('NULL')
        else {
          const encoded = encodeElement(value)
          if (typeof encoded !== 'string') throw new TypeError('Array element encoder must return a string')
          elements.push(`"${encoded.replace(/["\\]/gu, '\\$&')}"`)
        }
      }
    }
    return `{${elements.join(delimiter)}}`
  }
  const body = level(0)
  const bounds = array.dimensions.some(({ lowerBound }) => lowerBound !== 1)
    ? `${array.dimensions.map(({ lowerBound, length }) => `[${lowerBound}:${lowerBound + length - 1}]`).join('')}=`
    : ''
  return bounds + body
}

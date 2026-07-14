export interface TypedSqlHeaderDirective {
  readonly body: string
  readonly kind: string
  readonly line: number
}

export interface ParsedTypedSqlSource {
  readonly directives: readonly TypedSqlHeaderDirective[]
  readonly sql: string
}

export interface CompiledNamedParameters {
  readonly parameterNames: readonly string[]
  readonly sql: string
}

interface SourceLine {
  readonly content: string
  readonly text: string
}

function sourceLines(source: string): readonly SourceLine[] {
  const lines: SourceLine[] = []
  let start = 0

  while (start < source.length) {
    let end = start
    while (end < source.length && source[end] !== '\r' && source[end] !== '\n') {
      end += 1
    }

    let next = end
    if (source[next] === '\r') {
      next += 1
      if (source[next] === '\n') {
        next += 1
      }
    } else if (source[next] === '\n') {
      next += 1
    }

    lines.push({ content: source.slice(start, end), text: source.slice(start, next) })
    start = next
  }

  return lines
}

export function parseTypedSqlSource(source: string, sourceFile: string): ParsedTypedSqlSource {
  const directives: TypedSqlHeaderDirective[] = []
  const sqlLines: string[] = []
  let inHeader = true

  for (const [index, line] of sourceLines(source).entries()) {
    const lineNumber = index + 1
    const blank = /^\s*$/u.test(line.content)
    const lineComment = /^\s*--/u.test(line.content)

    if (inHeader && !blank && !lineComment) {
      inHeader = false
    }

    if (inHeader && /^\s*--\s*@/u.test(line.content)) {
      const match = /^\s*--\s*@([A-Za-z][A-Za-z0-9_]*)(?:\s+(.*?))?\s*$/u.exec(line.content)
      if (!match?.[1]) {
        throw new Error(`${sourceFile}:${lineNumber}: malformed typed SQL directive.`)
      }

      directives.push({
        body: match[2]?.trim() ?? '',
        kind: match[1],
        line: lineNumber,
      })
      continue
    }

    sqlLines.push(line.text)
  }

  return { directives, sql: sqlLines.join('').trim() }
}

function isNamedParameterStart(character: string | undefined): boolean {
  return character !== undefined && /[A-Za-z_]/u.test(character)
}

function isNamedParameterContinuation(character: string | undefined): boolean {
  return character !== undefined && /[A-Za-z0-9_]/u.test(character)
}

function isPostgresIdentifierContinuation(character: string | undefined): boolean {
  if (!character) {
    return false
  }
  return /[A-Za-z0-9_$]/u.test(character) || (character.codePointAt(0) ?? 0) >= 0x80
}

function isDollarTagStart(character: string | undefined): boolean {
  if (!character) {
    return false
  }
  return /[A-Za-z_]/u.test(character) || (character.codePointAt(0) ?? 0) >= 0x80
}

function isDollarTagContinuation(character: string | undefined): boolean {
  if (!character) {
    return false
  }
  return /[A-Za-z0-9_]/u.test(character) || (character.codePointAt(0) ?? 0) >= 0x80
}

function followsUnquotedIdentifier(sql: string, index: number): boolean {
  let tokenStart = index - 1
  if (!isPostgresIdentifierContinuation(sql[tokenStart])) {
    return false
  }
  while (tokenStart > 0 && isPostgresIdentifierContinuation(sql[tokenStart - 1])) {
    tokenStart -= 1
  }
  return isDollarTagStart(sql[tokenStart])
}

function dollarQuoteDelimiterAt(sql: string, start: number): string | null {
  if (sql[start] !== '$' || followsUnquotedIdentifier(sql, start)) {
    return null
  }

  if (sql[start + 1] === '$') {
    return '$$'
  }

  if (!isDollarTagStart(sql[start + 1])) {
    return null
  }

  let end = start + 2
  while (isDollarTagContinuation(sql[end])) {
    end += 1
  }
  return sql[end] === '$' ? sql.slice(start, end + 1) : null
}

function isEscapeStringQuote(sql: string, quoteIndex: number): boolean {
  const prefix = sql[quoteIndex - 1]
  return (prefix === 'e' || prefix === 'E') && !isPostgresIdentifierContinuation(sql[quoteIndex - 2])
}

function quotedEnd(sql: string, start: number, quote: "'" | '"', backslashEscapes: boolean): number {
  let index = start + 1
  while (index < sql.length) {
    if (backslashEscapes && sql[index] === '\\') {
      index = Math.min(index + 2, sql.length)
      continue
    }
    if (sql[index] !== quote) {
      index += 1
      continue
    }
    if (sql[index + 1] === quote) {
      index += 2
      continue
    }
    return index + 1
  }
  return sql.length
}

function lineCommentEnd(sql: string, start: number): number {
  let index = start + 2
  while (index < sql.length && sql[index] !== '\r' && sql[index] !== '\n') {
    index += 1
  }
  return index
}

function blockCommentEnd(sql: string, start: number): number {
  let depth = 1
  let index = start + 2
  while (index < sql.length && depth > 0) {
    if (sql[index] === '/' && sql[index + 1] === '*') {
      depth += 1
      index += 2
    } else if (sql[index] === '*' && sql[index + 1] === '/') {
      depth -= 1
      index += 2
    } else {
      index += 1
    }
  }
  return index
}

export function compileNamedParameters(sql: string, sourceFile = 'typed SQL'): CompiledNamedParameters {
  const chunks: string[] = []
  const parameterNames: string[] = []
  const placeholderByName = new Map<string, number>()
  let chunkStart = 0
  let index = 0

  while (index < sql.length) {
    const character = sql[index]
    let protectedEnd: number | null = null

    if (character === "'") {
      protectedEnd = quotedEnd(sql, index, "'", isEscapeStringQuote(sql, index))
    } else if (character === '"') {
      protectedEnd = quotedEnd(sql, index, '"', false)
    } else if (character === '-' && sql[index + 1] === '-') {
      protectedEnd = lineCommentEnd(sql, index)
    } else if (character === '/' && sql[index + 1] === '*') {
      protectedEnd = blockCommentEnd(sql, index)
    } else if (character === '$') {
      const delimiter = dollarQuoteDelimiterAt(sql, index)
      if (delimiter) {
        const closingIndex = sql.indexOf(delimiter, index + delimiter.length)
        protectedEnd = closingIndex === -1 ? sql.length : closingIndex + delimiter.length
      }
    }

    if (protectedEnd !== null) {
      index = protectedEnd
      continue
    }

    if (character === '$' && !isPostgresIdentifierContinuation(sql[index - 1]) && /[0-9]/u.test(sql[index + 1] ?? '')) {
      let parameterEnd = index + 2
      while (/[0-9]/u.test(sql[parameterEnd] ?? '')) {
        parameterEnd += 1
      }
      throw new Error(
        `${sourceFile}: positional parameter ${sql.slice(index, parameterEnd)} is not supported; use a named parameter.`
      )
    }

    if (character !== ':' || sql[index - 1] === ':' || !isNamedParameterStart(sql[index + 1])) {
      index += 1
      continue
    }

    let nameEnd = index + 2
    while (isNamedParameterContinuation(sql[nameEnd])) {
      nameEnd += 1
    }
    const name = sql.slice(index + 1, nameEnd)
    let placeholder = placeholderByName.get(name)
    if (placeholder === undefined) {
      parameterNames.push(name)
      placeholder = parameterNames.length
      placeholderByName.set(name, placeholder)
    }

    chunks.push(sql.slice(chunkStart, index), `$${placeholder}`)
    chunkStart = nameEnd
    index = nameEnd
  }

  chunks.push(sql.slice(chunkStart))
  return { parameterNames, sql: chunks.join('') }
}

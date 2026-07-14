import type { PostgresQueryable } from './database.js'

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

export interface CheckConstraintLiteralUnionFact {
  readonly attname: string
  readonly attnum: number
  readonly constraintNames: readonly string[]
  readonly labels: readonly string[]
  readonly relid: number
  readonly relname: string
  readonly schema: string
  readonly typeName: string
}

interface CheckConstraintCatalogRow {
  readonly attname: string
  readonly attnum: number
  readonly constraint_name: string
  readonly expression: string
  readonly relid: number
  readonly relname: string
  readonly schema: string
}

interface LoadCheckConstraintLiteralUnionFactsOptions {
  readonly relids?: readonly number[]
  readonly schemas?: readonly string[]
}

interface MutableCheckConstraintLiteralUnionFact {
  attname: string
  attnum: number
  constraintNames: string[]
  labels: string[]
  relid: number
  relname: string
  schema: string
  typeName: string
}

const defaultSchemas = ['public']

function camelCaseIdentifier(identifier: string): string {
  return identifier.replaceAll(/_([a-z0-9])/gu, (_match, letter: string) => letter.toUpperCase())
}

function pascalCaseIdentifier(identifier: string): string {
  const camel = camelCaseIdentifier(identifier)
  return `${camel.slice(0, 1).toUpperCase()}${camel.slice(1)}`
}

function relationTypeName(schema: string, relname: string): string {
  const name = pascalCaseIdentifier(relname)
  return schema === 'public' ? name : `${pascalCaseIdentifier(schema)}${name}`
}

export function checkConstraintLiteralUnionTypeName(row: {
  readonly attname: string
  readonly relname: string
  readonly schema: string
}): string {
  return `${relationTypeName(row.schema, row.relname)}${pascalCaseIdentifier(row.attname)}`
}

export function checkConstraintLiteralUnionCatalogKey(row: {
  readonly attname: string
  readonly relname: string
  readonly schema: string
}): string {
  return `${row.schema}.${row.relname}.${row.attname}`
}

export function checkConstraintLiteralUnionColumnKey(row: { readonly attnum: number; readonly relid: number }): string {
  return `${row.relid}:${row.attnum}`
}

function quotedIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`
}

function columnPattern(attname: string): string {
  return `(?:${escapeRegExp(attname)}|${escapeRegExp(quotedIdentifier(attname))})`
}

function stripOuterParens(input: string): string {
  let current = input.trim()

  while (current.startsWith('(') && current.endsWith(')')) {
    let depth = 0
    let quote: "'" | null = null
    let wrapsWholeExpression = true

    for (let index = 0; index < current.length; index += 1) {
      const char = current[index]
      const next = current[index + 1]
      if (!char) {
        continue
      }

      if (quote) {
        if (char === quote) {
          if (next === quote) {
            index += 1
          } else {
            quote = null
          }
        }
        continue
      }

      if (char === "'") {
        quote = "'"
        continue
      }

      if (char === '(') {
        depth += 1
      } else if (char === ')') {
        depth -= 1
        if (depth === 0 && index < current.length - 1) {
          wrapsWholeExpression = false
          break
        }
      }

      if (depth < 0) {
        wrapsWholeExpression = false
        break
      }
    }

    if (!wrapsWholeExpression || depth !== 0) {
      break
    }

    current = current.slice(1, -1).trim()
  }

  return current
}

function splitTopLevel(input: string, separator: string): string[] {
  const values: string[] = []
  let current = ''
  let depth = 0
  let quote: "'" | null = null

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]
    const next = input[index + 1]
    if (!char) {
      continue
    }

    if (quote) {
      current += char
      if (char === quote) {
        if (next === quote) {
          current += next
          index += 1
        } else {
          quote = null
        }
      }
      continue
    }

    if (char === "'") {
      quote = "'"
      current += char
      continue
    }

    if (char === '(') {
      depth += 1
      current += char
      continue
    }

    if (char === ')') {
      depth = Math.max(0, depth - 1)
      current += char
      continue
    }

    if (depth === 0 && input.slice(index, index + separator.length).toUpperCase() === separator.toUpperCase()) {
      values.push(current.trim())
      current = ''
      index += separator.length - 1
      continue
    }

    current += char
  }

  const trimmed = current.trim()
  if (trimmed.length > 0) {
    values.push(trimmed)
  }
  return values
}

function splitTopLevelSqlList(input: string): string[] {
  return splitTopLevel(input, ',')
}

function castableSqlLiteralPattern(): RegExp {
  return /^'((?:''|[^'])*)'(?:\s*::\s*(?:(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_]*)\.)?(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_]*)(?:\[\])?)?$/u
}

function parseSqlStringLiteral(input: string): string | null {
  const match = castableSqlLiteralPattern().exec(stripOuterParens(input))
  return match?.[1] === undefined ? null : match[1].replaceAll("''", "'")
}

function parseAnyArrayLiteralUnion(expression: string, attname: string): readonly string[] | null {
  const match = new RegExp(`^${columnPattern(attname)}\\s*=\\s*ANY\\s*\\(\\s*ARRAY\\[(.*)\\]\\s*\\)$`, 'u').exec(
    expression
  )
  const body = match?.[1]
  if (!body) {
    return null
  }

  const labels = splitTopLevelSqlList(body).map(parseSqlStringLiteral)
  return labels.every((label): label is string => label !== null) && labels.length > 0 ? labels : null
}

function parseEqualityLiteralUnion(expression: string, attname: string): readonly string[] | null {
  const match = new RegExp(`^${columnPattern(attname)}\\s*=\\s*(.+)$`, 'u').exec(expression)
  const label = match?.[1] ? parseSqlStringLiteral(match[1]) : null
  return label === null ? null : [label]
}

function isColumnIsNullExpression(expression: string, attname: string): boolean {
  return new RegExp(`^${columnPattern(attname)}\\s+IS\\s+NULL$`, 'iu').test(stripOuterParens(expression))
}

function parseDirectLiteralUnion(expression: string, attname: string): readonly string[] | null {
  return parseAnyArrayLiteralUnion(expression, attname) ?? parseEqualityLiteralUnion(expression, attname)
}

function parseOrLiteralUnion(expression: string, attname: string): readonly string[] | null {
  const parts = splitTopLevel(expression, ' OR ')
  if (parts.length <= 1) {
    return null
  }

  const labels: string[] = []
  for (const part of parts) {
    const strippedPart = stripOuterParens(part)
    if (isColumnIsNullExpression(strippedPart, attname)) {
      continue
    }

    const partLabels = parseDirectLiteralUnion(strippedPart, attname)
    if (!partLabels) {
      return null
    }
    labels.push(...partLabels)
  }

  return labels.length > 0 ? labels : null
}

function parseLiteralUnionConstraintExpression(expression: string, attname: string): readonly string[] | null {
  const stripped = stripOuterParens(expression)
  return parseDirectLiteralUnion(stripped, attname) ?? parseOrLiteralUnion(stripped, attname)
}

function uniqueLabels(labels: readonly string[]): readonly string[] {
  const seen = new Set<string>()
  const unique: string[] = []
  for (const label of labels) {
    if (!seen.has(label)) {
      seen.add(label)
      unique.push(label)
    }
  }
  return unique
}

function intersectLabels(left: readonly string[], right: readonly string[]): readonly string[] {
  const rightLabels = new Set(right)
  return left.filter((label) => rightLabels.has(label))
}

function mergeFact(
  facts: Map<string, MutableCheckConstraintLiteralUnionFact>,
  row: CheckConstraintCatalogRow,
  labels: readonly string[]
): void {
  const key = checkConstraintLiteralUnionCatalogKey(row)
  const existing = facts.get(key)
  if (!existing) {
    facts.set(key, {
      attname: row.attname,
      attnum: row.attnum,
      constraintNames: [row.constraint_name],
      labels: [...uniqueLabels(labels)],
      relid: row.relid,
      relname: row.relname,
      schema: row.schema,
      typeName: checkConstraintLiteralUnionTypeName(row),
    })
    return
  }

  existing.constraintNames.push(row.constraint_name)
  existing.labels = [...intersectLabels(existing.labels, uniqueLabels(labels))]
}

export async function loadCheckConstraintLiteralUnionFacts(
  client: PostgresQueryable,
  options: LoadCheckConstraintLiteralUnionFactsOptions = {}
): Promise<readonly CheckConstraintLiteralUnionFact[]> {
  const relids = options.relids
  const schemas = options.schemas ?? defaultSchemas
  const relationFilter =
    relids && relids.length > 0 ? 'con.conrelid = any($1::oid[])' : 'namespace.nspname = any($1::text[])'
  const params: unknown[] = [relids && relids.length > 0 ? [...relids] : [...schemas]]
  const result = await client.query<CheckConstraintCatalogRow>(
    `
      select
        namespace.nspname as schema,
        class.oid::int as relid,
        class.relname,
        attribute.attnum::int as attnum,
        attribute.attname,
        con.conname as constraint_name,
        pg_get_expr(con.conbin, con.conrelid) as expression
      from pg_constraint con
      join pg_class class
        on class.oid = con.conrelid
      join pg_namespace namespace
        on namespace.oid = class.relnamespace
      join pg_attribute attribute
        on attribute.attrelid = con.conrelid
        and attribute.attnum = con.conkey[1]
      where ${relationFilter}
        and con.contype = 'c'
        and con.convalidated
        and array_length(con.conkey, 1) = 1
        and attribute.attnum > 0
        and not attribute.attisdropped
      order by namespace.nspname, class.relname, attribute.attnum, con.conname
    `,
    params
  )

  const facts = new Map<string, MutableCheckConstraintLiteralUnionFact>()
  for (const row of result.rows) {
    const labels = parseLiteralUnionConstraintExpression(row.expression, row.attname)
    if (!labels || labels.length === 0) {
      continue
    }
    mergeFact(facts, row, labels)
  }

  return [...facts.values()]
    .filter((fact) => fact.labels.length > 0)
    .map((fact) => ({
      attname: fact.attname,
      attnum: fact.attnum,
      constraintNames: fact.constraintNames.toSorted(),
      labels: fact.labels,
      relid: fact.relid,
      relname: fact.relname,
      schema: fact.schema,
      typeName: fact.typeName,
    }))
}

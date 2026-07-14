import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import {
  checkConstraintLiteralUnionCatalogKey,
  loadCheckConstraintLiteralUnionFacts,
  type CheckConstraintLiteralUnionFact,
} from './check-constraint-type-facts.js'
import type { ResolvedPostgresTypedSqlConfig } from './config.js'
import type { PostgresQueryable } from './database.js'

interface EnumCatalogRow {
  readonly labels: readonly string[]
  readonly schema: string
  readonly type_name: string
}

interface DomainCatalogRow {
  readonly base_formatted_type: string
  readonly base_type_name: string
  readonly base_type_schema: string
  readonly schema: string
  readonly type_name: string
}

interface ColumnCatalogRow {
  readonly attname: string
  readonly attnotnull: boolean
  readonly formatted_type: string
  readonly relkind: string
  readonly relname: string
  readonly schema: string
  readonly type_name: string
  readonly type_schema: string
}

const pgTypeToTsType = new Map<string, string>([
  ['bigint', 'PgInt8String'],
  ['bit', 'string'],
  ['bit varying', 'string'],
  ['boolean', 'boolean'],
  ['box', 'string'],
  ['bytea', 'PgByteaHexString'],
  ['char', 'string'],
  ['cidr', 'string'],
  ['circle', 'string'],
  ['date', 'PgDateString'],
  ['double precision', 'PgFloat8String'],
  ['integer', 'PgInt4String'],
  ['inet', 'string'],
  ['int8range', 'string'],
  ['interval', 'PgIntervalString'],
  ['json', 'DbJsonSelected'],
  ['json[]', 'readonly DbJsonSelected[]'],
  ['jsonb', 'DbJsonSelected'],
  ['line', 'string'],
  ['lseg', 'string'],
  ['macaddr', 'string'],
  ['macaddr8', 'string'],
  ['money', 'string'],
  ['name', 'string'],
  ['numeric', 'PgNumericString'],
  ['oid', 'PgOidString'],
  ['path', 'string'],
  ['pg_lsn', 'string'],
  ['point', 'string'],
  ['polygon', 'string'],
  ['real', 'PgFloat4String'],
  ['smallint', 'PgInt2String'],
  ['text', 'string'],
  ['text[]', 'readonly string[]'],
  ['time without time zone', 'PgTimeString'],
  ['time with time zone', 'PgTimetzString'],
  ['timestamp without time zone', 'PgTimestampString'],
  ['timestamp with time zone', 'PgTimestamptzString'],
  ['tsvector', 'string'],
  ['uuid', 'PgUuidString'],
  ['xml', 'string'],
])

for (const rangeType of ['daterange', 'int4range', 'numrange', 'tsrange', 'tstzrange']) {
  pgTypeToTsType.set(rangeType, 'string')
}

const dbScalarTypes = new Set(
  [
    'DbJsonSelected',
    'PgByteaHexString',
    'PgDateString',
    'PgFloat4String',
    'PgFloat8String',
    'PgInt2String',
    'PgInt4String',
    'PgInt8String',
    'PgIntervalString',
    'PgNumericString',
    'PgOidString',
    'PgTimestampString',
    'PgTimestamptzString',
    'PgTimeString',
    'PgTimetzString',
    'PgUuidString',
  ].toSorted()
)

function camelCaseIdentifier(identifier: string): string {
  return identifier.replaceAll(/_([a-z0-9])/gu, (_match, letter: string) => letter.toUpperCase())
}

function pascalCaseIdentifier(identifier: string): string {
  const camelCase = camelCaseIdentifier(identifier)
  return `${camelCase.slice(0, 1).toUpperCase()}${camelCase.slice(1)}`
}

function quotePropertyName(propertyName: string): string {
  return /^[A-Za-z_$][\w$]*$/u.test(propertyName) ? propertyName : JSON.stringify(propertyName)
}

function quoteString(value: string): string {
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`
}

function normalizePgTypeName(pgType: string): string {
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
  return pgType
}

function tsTypeForPgType(pgType: string, typeSchema: string, typeName: string): string {
  const normalized = normalizePgTypeName(pgType)
  const arrayMatch = /^(.*)\[\]$/u.exec(normalized)
  if (arrayMatch?.[1]) {
    return `readonly ${tsTypeForPgType(arrayMatch[1], typeSchema, typeName.replace(/^_/u, ''))}[]`
  }

  if (typeSchema !== 'pg_catalog') {
    return pascalCaseIdentifier(typeName)
  }

  const tsType = pgTypeToTsType.get(normalized)
  if (!tsType) {
    throw new Error(`No TypeScript mapping configured for PostgreSQL type ${pgType}.`)
  }
  return tsType
}

function relationTypeName(row: Pick<ColumnCatalogRow, 'relname' | 'schema'>): string {
  const name = pascalCaseIdentifier(row.relname)
  return row.schema === 'public' ? name : `${pascalCaseIdentifier(row.schema)}${name}`
}

async function loadEnums(client: PostgresQueryable): Promise<EnumCatalogRow[]> {
  const result = await client.query<EnumCatalogRow>(`
    select
      n.nspname as schema,
      t.typname as type_name,
      jsonb_agg(e.enumlabel order by e.enumsortorder) as labels
    from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    join pg_enum e on e.enumtypid = t.oid
    where n.nspname <> 'information_schema'
      and n.nspname !~ '^pg_'
    group by n.nspname, t.typname
    order by n.nspname, t.typname
  `)
  return result.rows
}

async function loadDomains(client: PostgresQueryable): Promise<DomainCatalogRow[]> {
  const result = await client.query<DomainCatalogRow>(`
    select
      namespace.nspname as schema,
      type.typname as type_name,
      format_type(type.typbasetype, type.typtypmod) as base_formatted_type,
      base_namespace.nspname as base_type_schema,
      base_type.typname as base_type_name
    from pg_type type
    join pg_namespace namespace on namespace.oid = type.typnamespace
    join pg_type base_type on base_type.oid = type.typbasetype
    join pg_namespace base_namespace on base_namespace.oid = base_type.typnamespace
    where type.typtype = 'd'
      and namespace.nspname <> 'information_schema'
      and namespace.nspname !~ '^pg_'
    order by namespace.nspname, type.typname
  `)
  return result.rows
}

async function loadColumns(client: PostgresQueryable): Promise<ColumnCatalogRow[]> {
  const result = await client.query<ColumnCatalogRow>(`
    select
      n.nspname as schema,
      c.relname,
      c.relkind::text as relkind,
      a.attname,
      a.attnotnull,
      format_type(a.atttypid, a.atttypmod) as formatted_type,
      tn.nspname as type_schema,
      t.typname as type_name
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid
    join pg_type t on t.oid = a.atttypid
    join pg_namespace tn on tn.oid = t.typnamespace
    where n.nspname <> 'information_schema'
      and n.nspname !~ '^pg_'
      and c.relkind in ('r', 'p', 'v', 'm', 'c')
      and a.attnum > 0
      and not a.attisdropped
    order by n.nspname, c.relname, a.attnum
  `)
  return result.rows
}

function renderEnums(enums: readonly EnumCatalogRow[]): string {
  return enums
    .map((row) => {
      const name = pascalCaseIdentifier(row.type_name)
      return `export type ${name} = ${row.labels.map(quoteString).join(' | ')}`
    })
    .join('\n\n')
}

function renderDomains(domains: readonly DomainCatalogRow[]): string {
  return domains
    .map(
      (row) =>
        `export type ${pascalCaseIdentifier(row.type_name)} = ${tsTypeForPgType(
          row.base_formatted_type,
          row.base_type_schema,
          row.base_type_name
        )}`
    )
    .join('\n\n')
}

function renderCheckConstraintLiteralUnions(facts: readonly CheckConstraintLiteralUnionFact[]): string {
  return facts.map((fact) => `export type ${fact.typeName} = ${fact.labels.map(quoteString).join(' | ')}`).join('\n\n')
}

function groupColumnsByRelation(columns: readonly ColumnCatalogRow[]): Map<string, ColumnCatalogRow[]> {
  const byRelation = new Map<string, ColumnCatalogRow[]>()
  for (const row of columns) {
    const key = `${row.schema}.${row.relname}`
    byRelation.set(key, [...(byRelation.get(key) ?? []), row])
  }
  return byRelation
}

function checkConstraintLiteralUnionByCatalogKey(
  facts: readonly CheckConstraintLiteralUnionFact[]
): ReadonlyMap<string, CheckConstraintLiteralUnionFact> {
  return new Map(facts.map((fact) => [checkConstraintLiteralUnionCatalogKey(fact), fact]))
}

function tsTypeForColumn(
  row: ColumnCatalogRow,
  checkConstraintTypes: ReadonlyMap<string, CheckConstraintLiteralUnionFact>
): string {
  return (
    checkConstraintTypes.get(checkConstraintLiteralUnionCatalogKey(row))?.typeName ??
    tsTypeForPgType(row.formatted_type, row.type_schema, row.type_name)
  )
}

function renderRelations(
  columns: readonly ColumnCatalogRow[],
  checkConstraintTypes: ReadonlyMap<string, CheckConstraintLiteralUnionFact>
): string {
  return [...groupColumnsByRelation(columns).values()]
    .map((rows) => {
      const first = rows[0]
      if (!first) {
        throw new Error('Cannot render an empty relation.')
      }
      const name = relationTypeName(first)
      return [
        `export interface ${name} {`,
        ...rows.map((row) => {
          const tsType = tsTypeForColumn(row, checkConstraintTypes)
          return `  readonly ${quotePropertyName(camelCaseIdentifier(row.attname))}: ${tsType}${row.attnotnull ? '' : ' | null'}`
        }),
        '}',
      ].join('\n')
    })
    .join('\n\n')
}

function catalogDbPropertyName(row: Pick<ColumnCatalogRow, 'relname' | 'schema'>): string {
  const relationName = camelCaseIdentifier(row.relname)
  return row.schema === 'public' ? relationName : `${row.schema}.${relationName}`
}

function renderCatalogDb(columns: readonly ColumnCatalogRow[]): string {
  const lines = [...groupColumnsByRelation(columns).values()].map((rows) => {
    const first = rows[0]
    if (!first) {
      throw new Error('Cannot render an empty relation.')
    }
    return `  readonly ${quotePropertyName(catalogDbPropertyName(first))}: ${relationTypeName(first)}`
  })

  return ['export interface CatalogDb {', ...lines, '}'].join('\n')
}

function renderCatalogTypes(
  enums: readonly EnumCatalogRow[],
  domains: readonly DomainCatalogRow[],
  columns: readonly ColumnCatalogRow[],
  checkConstraintLiteralUnions: readonly CheckConstraintLiteralUnionFact[],
  packageImport: string
): string {
  const scalarImports = new Set<string>()
  const checkConstraintTypes = checkConstraintLiteralUnionByCatalogKey(checkConstraintLiteralUnions)
  for (const domain of domains) {
    const tsType = tsTypeForPgType(domain.base_formatted_type, domain.base_type_schema, domain.base_type_name)
    const baseType = tsType.replace(/^readonly /u, '').replace(/\[\]$/u, '')
    if (dbScalarTypes.has(baseType)) {
      scalarImports.add(baseType)
    }
  }
  for (const row of columns) {
    const tsType = tsTypeForColumn(row, checkConstraintTypes)
    const baseType = tsType.replace(/^readonly /u, '').replace(/\[\]$/u, '')
    if (dbScalarTypes.has(baseType)) {
      scalarImports.add(baseType)
    }
  }

  const importBlock =
    scalarImports.size > 0
      ? `import type { ${[...scalarImports].toSorted().join(', ')} } from '${packageImport}/scalars'\n\n`
      : ''

  return `// This file is auto-generated by postgres-typed-sql
// DO NOT EDIT MANUALLY

${importBlock}
${renderEnums(enums)}

${renderDomains(domains)}

${renderCheckConstraintLiteralUnions(checkConstraintLiteralUnions)}

${renderRelations(columns, checkConstraintTypes)}

${renderCatalogDb(columns)}
`
}

export async function generateCatalogTypes(
  client: PostgresQueryable,
  config: ResolvedPostgresTypedSqlConfig
): Promise<void> {
  const enums = await loadEnums(client)
  const domains = await loadDomains(client)
  const columns = await loadColumns(client)
  const schemas = [...new Set(columns.map((row) => row.schema))]
  const checkConstraintLiteralUnions = await loadCheckConstraintLiteralUnionFacts(client, { schemas })
  await mkdir(dirname(config.typesOutput), { recursive: true })
  await writeFile(
    config.typesOutput,
    renderCatalogTypes(enums, domains, columns, checkConstraintLiteralUnions, config.packageImport)
  )
}

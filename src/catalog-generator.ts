import {
  checkConstraintLiteralUnionCatalogKey,
  loadCheckConstraintLiteralUnionFacts,
  type CheckConstraintLiteralUnionFact,
} from './check-constraint-type-facts.js'
import type { ResolvedPostgresTypedSqlConfig } from './config.js'
import type { PostgresQueryable } from './database.js'
import {
  postgresTypeScriptScalarImports as dbScalarTypes,
  resolveTypeScriptTypeForPostgresType,
  type PostgresScalarProfile,
  type PostgresTypeScriptResolution,
} from './postgres-types.js'
import {
  assertUniqueTypeScriptBindings,
  quotePropertyName,
  schemaQualifiedPascalName,
  type TypeScriptBinding,
} from './typescript-names.js'

interface EnumCatalogRow {
  readonly labels: readonly string[]
  readonly schema: string
  readonly type_name: string
}

interface DomainCatalogRow {
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
  readonly type_oid: number
  readonly type_schema: string
}

function quoteString(value: string): string {
  return JSON.stringify(value)
}

function resolveTsTypeForPgType(
  pgType: string,
  typeSchema: string,
  typeName: string,
  typeOid: number,
  scalarProfile: PostgresScalarProfile
): PostgresTypeScriptResolution {
  return resolveTypeScriptTypeForPostgresType(
    { pgType, pgTypeName: typeName, pgTypeOid: typeOid, pgTypeSchema: typeSchema },
    undefined,
    scalarProfile
  )
}

function relationTypeName(row: Pick<ColumnCatalogRow, 'relname' | 'schema'>): string {
  return schemaQualifiedPascalName(row.schema, row.relname)
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
      type.typname as type_name
    from pg_type type
    join pg_namespace namespace on namespace.oid = type.typnamespace
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
      a.atttypid::int as type_oid,
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
      const name = schemaQualifiedPascalName(row.schema, row.type_name)
      return `export type ${name} = ${row.labels.map(quoteString).join(' | ')}`
    })
    .join('\n\n')
}

function renderDomains(domains: readonly DomainCatalogRow[]): string {
  return domains
    .map((row) => `export type ${schemaQualifiedPascalName(row.schema, row.type_name)} = unknown`)
    .join('\n\n')
}

function renderCheckConstraintLiteralUnions(facts: readonly CheckConstraintLiteralUnionFact[]): string {
  return facts.map((fact) => `export type ${fact.typeName} = ${fact.labels.map(quoteString).join(' | ')}`).join('\n\n')
}

function groupColumnsByRelation(columns: readonly ColumnCatalogRow[]): Map<string, ColumnCatalogRow[]> {
  const byRelation = new Map<string, ColumnCatalogRow[]>()
  for (const row of columns) {
    const key = `${row.schema}.${row.relname}`
    const rows = byRelation.get(key) ?? []
    rows.push(row)
    byRelation.set(key, rows)
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
  checkConstraintTypes: ReadonlyMap<string, CheckConstraintLiteralUnionFact>,
  scalarProfile: PostgresScalarProfile
): PostgresTypeScriptResolution {
  const checkConstraintType =
    scalarProfile === 'node-postgres'
      ? checkConstraintTypes.get(checkConstraintLiteralUnionCatalogKey(row))?.typeName
      : undefined
  return checkConstraintType
    ? { catalogImports: [], scalarImports: [], type: checkConstraintType }
    : resolveTsTypeForPgType(row.formatted_type, row.type_schema, row.type_name, row.type_oid, scalarProfile)
}

function renderRelations(
  columns: readonly ColumnCatalogRow[],
  checkConstraintTypes: ReadonlyMap<string, CheckConstraintLiteralUnionFact>,
  scalarProfile: PostgresScalarProfile
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
          const tsType = tsTypeForColumn(row, checkConstraintTypes, scalarProfile).type
          return `  readonly ${quotePropertyName(row.attname)}: ${tsType}${row.attnotnull ? '' : ' | null'}`
        }),
        '}',
      ].join('\n')
    })
    .join('\n\n')
}

function catalogDbPropertyName(row: Pick<ColumnCatalogRow, 'relname' | 'schema'>): string {
  return row.schema === 'public' ? row.relname : `${row.schema}.${row.relname}`
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

function validateCatalogBindings(
  enums: readonly EnumCatalogRow[],
  domains: readonly DomainCatalogRow[],
  columns: readonly ColumnCatalogRow[],
  checkConstraintLiteralUnions: readonly CheckConstraintLiteralUnionFact[]
): void {
  const bindings: TypeScriptBinding[] = [
    { name: 'CatalogDb', source: 'generated catalog root interface' },
    { name: 'Record', source: 'reserved TypeScript utility type' },
    ...[...dbScalarTypes].map((name) => ({ name, source: 'reserved postgres-typed-sql scalar type' })),
    ...enums.map((row) => ({
      name: schemaQualifiedPascalName(row.schema, row.type_name),
      source: `enum ${row.schema}.${row.type_name}`,
    })),
    ...domains.map((row) => ({
      name: schemaQualifiedPascalName(row.schema, row.type_name),
      source: `domain ${row.schema}.${row.type_name}`,
    })),
    ...checkConstraintLiteralUnions.map((fact) => ({
      name: fact.typeName,
      source: `check-constrained column ${fact.schema}.${fact.relname}.${fact.attname}`,
    })),
    ...[...groupColumnsByRelation(columns).values()].flatMap((rows) => {
      const first = rows[0]
      return first
        ? [
            {
              name: relationTypeName(first),
              source: `relation ${first.schema}.${first.relname}`,
            },
          ]
        : []
    }),
  ]
  assertUniqueTypeScriptBindings(bindings, 'catalog generation')
}

function renderCatalogTypes(
  enums: readonly EnumCatalogRow[],
  domains: readonly DomainCatalogRow[],
  columns: readonly ColumnCatalogRow[],
  checkConstraintLiteralUnions: readonly CheckConstraintLiteralUnionFact[],
  packageImport: string,
  scalarProfile: PostgresScalarProfile
): string {
  validateCatalogBindings(enums, domains, columns, checkConstraintLiteralUnions)
  const scalarImports = new Set<string>()
  const checkConstraintTypes = checkConstraintLiteralUnionByCatalogKey(checkConstraintLiteralUnions)
  for (const row of columns) {
    const resolved = tsTypeForColumn(row, checkConstraintTypes, scalarProfile)
    for (const scalarImport of resolved.scalarImports) {
      scalarImports.add(scalarImport)
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

${renderRelations(columns, checkConstraintTypes, scalarProfile)}

${renderCatalogDb(columns)}
`
}

export async function buildCatalogTypes(
  client: PostgresQueryable,
  config: ResolvedPostgresTypedSqlConfig
): Promise<string> {
  const enums = await loadEnums(client)
  const domains = await loadDomains(client)
  const columns = await loadColumns(client)
  const schemas = [...new Set(columns.map((row) => row.schema))]
  const checkConstraintLiteralUnions = await loadCheckConstraintLiteralUnionFacts(client, { schemas })
  return renderCatalogTypes(
    enums,
    domains,
    columns,
    checkConstraintLiteralUnions,
    config.packageImport,
    config.scalarProfile
  )
}

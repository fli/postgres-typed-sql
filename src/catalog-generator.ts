import {
  checkConstraintLiteralUnionColumnKey,
  loadCheckConstraintLiteralUnionFacts,
  type CheckConstraintLiteralUnionFact,
} from './check-constraint-type-facts.js'
import type { ResolvedPostgresTypedSqlConfig } from './config.js'
import type { PostgresQueryable } from './database.js'
import { loadPostgresTypeFacts } from './postgres-type-facts.js'
import {
  postgresResultSupportsStringLiteralRefinement,
  resolveTypeScriptResultTypeForPostgresType,
  type ResolvedPostgresCodecProfile,
  type PostgresTypeScriptResolution,
} from './postgres-codecs.js'
import type { PostgresTypeFact } from './postgres-types.js'
import {
  assertUniqueTypeScriptBindings,
  postgresNamedTypeBinding,
  quotePropertyName,
  renderTypeScriptLineCommentValue,
  type TypeScriptBinding,
} from './typescript-names.js'

interface EnumCatalogRow {
  readonly labels: readonly string[]
  readonly oid: number
  readonly schema: string
  readonly type_name: string
}

interface ColumnCatalogRow {
  readonly attname: string
  readonly attnotnull: boolean
  readonly attnum: number
  readonly relid: number
  readonly type_oid: number
}

interface RelationCatalogRow {
  readonly relname: string
  readonly relid: number
  readonly relkind: string
  readonly schema: string
}

interface ResolvedColumnCatalogRow {
  readonly resolution: PostgresTypeScriptResolution
  readonly row: ColumnCatalogRow
}

function quoteString(value: string): string {
  return JSON.stringify(value)
}

function relationTypeName(row: Pick<RelationCatalogRow, 'relname' | 'schema'>): string {
  return postgresNamedTypeBinding(row.schema, row.relname)
}

async function loadEnums(client: PostgresQueryable): Promise<EnumCatalogRow[]> {
  const result = await client.query<EnumCatalogRow>(`
    select
      t.oid::int as oid,
      n.nspname as schema,
      t.typname as type_name,
      jsonb_agg(e.enumlabel order by e.enumsortorder) as labels
    from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    join pg_enum e on e.enumtypid = t.oid
    where n.nspname <> 'information_schema'
      and n.nspname !~ '^pg_'
    group by t.oid, n.nspname, t.typname
    order by n.nspname, t.typname
  `)
  return result.rows
}

async function loadRelations(client: PostgresQueryable): Promise<RelationCatalogRow[]> {
  const result = await client.query<RelationCatalogRow>(`
    select
      c.oid::int as relid,
      n.nspname as schema,
      c.relname,
      c.relkind::text as relkind
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname <> 'information_schema'
      and n.nspname !~ '^pg_'
      and c.relkind in ('r', 'p', 'v', 'm', 'c')
    order by n.nspname, c.relname
  `)
  return result.rows
}

async function loadColumns(client: PostgresQueryable): Promise<ColumnCatalogRow[]> {
  const result = await client.query<ColumnCatalogRow>(`
    select
      c.oid::int as relid,
      a.attnum::int as attnum,
      a.attname,
      a.attnotnull,
      a.atttypid::int as type_oid
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid
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
      const name = postgresNamedTypeBinding(row.schema, row.type_name)
      return `export type ${name} = ${row.labels.map(quoteString).join(' | ')}`
    })
    .join('\n\n')
}

function renderCheckConstraintLiteralUnions(facts: readonly CheckConstraintLiteralUnionFact[]): string {
  return facts.map((fact) => `export type ${fact.typeName} = ${fact.labels.map(quoteString).join(' | ')}`).join('\n\n')
}

function checkConstraintLiteralUnionByColumn(
  facts: readonly CheckConstraintLiteralUnionFact[]
): ReadonlyMap<string, CheckConstraintLiteralUnionFact> {
  return new Map(facts.map((fact) => [checkConstraintLiteralUnionColumnKey(fact), fact]))
}

function catalogDecoderType(type: PostgresTypeFact): PostgresTypeFact {
  return type.pgTypeKind === 'domain' && type.pgBaseType ? catalogDecoderType(type.pgBaseType) : type
}

function catalogResultTypeResolution(
  type: PostgresTypeFact,
  codecProfile: ResolvedPostgresCodecProfile,
  renderedEnumOids: ReadonlySet<number>
): PostgresTypeScriptResolution {
  const resolution = resolveTypeScriptResultTypeForPostgresType(type, codecProfile)
  const decoderType = catalogDecoderType(type)
  const enumLiteralType =
    decoderType.pgTypeKind === 'enum' && decoderType.pgEnumLabels
      ? decoderType.pgEnumLabels.map(quoteString).join(' | ')
      : undefined
  if (
    enumLiteralType &&
    resolution.type === enumLiteralType &&
    resolution.ambientBindings.length === 0 &&
    resolution.scalarImports.length === 0 &&
    renderedEnumOids.has(decoderType.pgTypeOid) &&
    postgresResultSupportsStringLiteralRefinement(type, codecProfile)
  ) {
    return {
      ambientBindings: [],
      scalarImports: [],
      type: postgresNamedTypeBinding(decoderType.pgTypeSchema, decoderType.pgTypeName),
    }
  }
  return resolution
}

function tsTypeForColumn(
  row: ColumnCatalogRow,
  type: PostgresTypeFact,
  checkConstraintTypes: ReadonlyMap<string, CheckConstraintLiteralUnionFact>,
  codecProfile: ResolvedPostgresCodecProfile,
  renderedEnumOids: ReadonlySet<number>
): PostgresTypeScriptResolution {
  const resolution = catalogResultTypeResolution(type, codecProfile, renderedEnumOids)
  const checkConstraintType = postgresResultSupportsStringLiteralRefinement(type, codecProfile)
    ? checkConstraintTypes.get(checkConstraintLiteralUnionColumnKey(row))?.typeName
    : undefined
  return checkConstraintType ? { ambientBindings: [], scalarImports: [], type: checkConstraintType } : resolution
}

function renderRelations(
  relations: readonly RelationCatalogRow[],
  columns: readonly ResolvedColumnCatalogRow[]
): string {
  const rowsByRelation = new Map<number, ResolvedColumnCatalogRow[]>()
  for (const column of columns) {
    const rows = rowsByRelation.get(column.row.relid) ?? []
    rows.push(column)
    rowsByRelation.set(column.row.relid, rows)
  }

  return relations
    .map((relation) => {
      const name = relationTypeName(relation)
      const rows = rowsByRelation.get(relation.relid) ?? []
      return rows.length === 0
        ? `export type ${name} = { readonly [key: string]: never }`
        : [
            `export interface ${name} {`,
            ...rows.map(
              ({ resolution, row }) =>
                `  readonly ${quotePropertyName(row.attname)}: ${resolution.type}${row.attnotnull ? '' : ' | null'}`
            ),
            '}',
          ].join('\n')
    })
    .join('\n\n')
}

function catalogIdentifierComponent(identifier: string): string {
  return /^[a-z_][a-z0-9_$]*$/u.test(identifier) ? identifier : `"${identifier.replaceAll('"', '""')}"`
}

function catalogDbPropertyName(row: Pick<RelationCatalogRow, 'relname' | 'schema'>): string {
  const relation = catalogIdentifierComponent(row.relname)
  return row.schema === 'public' ? relation : `${catalogIdentifierComponent(row.schema)}.${relation}`
}

function renderCatalogDb(relations: readonly RelationCatalogRow[]): string {
  const lines = relations.map(
    (relation) => `  readonly ${quotePropertyName(catalogDbPropertyName(relation))}: ${relationTypeName(relation)}`
  )

  return ['export interface CatalogDb {', ...lines, '}'].join('\n')
}

function validateCatalogBindings(
  enums: readonly EnumCatalogRow[],
  relations: readonly RelationCatalogRow[],
  checkConstraintLiteralUnions: readonly CheckConstraintLiteralUnionFact[],
  ambientBindings: ReadonlySet<string>,
  scalarImports: ReadonlySet<string>
): void {
  const bindings: TypeScriptBinding[] = [
    { name: 'CatalogDb', source: 'generated catalog root interface' },
    ...[...ambientBindings].map((name) => ({ name, source: 'ambient TypeScript type' })),
    ...[...scalarImports].map((name) => ({
      name,
      source: 'postgres-typed-sql scalar type import',
    })),
    ...enums.map((row) => ({
      name: postgresNamedTypeBinding(row.schema, row.type_name),
      source: `enum ${row.schema}.${row.type_name}`,
    })),
    ...checkConstraintLiteralUnions.map((fact) => ({
      name: fact.typeName,
      source: `check-constrained column ${fact.schema}.${fact.relname}.${fact.attname}`,
    })),
    ...relations.map((relation) => ({
      name: relationTypeName(relation),
      source: `relation ${relation.schema}.${relation.relname}`,
    })),
  ]
  assertUniqueTypeScriptBindings(bindings, 'catalog generation')
}

function renderCatalogTypes(
  enums: readonly EnumCatalogRow[],
  relations: readonly RelationCatalogRow[],
  columns: readonly ColumnCatalogRow[],
  types: ReadonlyMap<number, PostgresTypeFact>,
  checkConstraintLiteralUnions: readonly CheckConstraintLiteralUnionFact[],
  scalarModuleSpecifier: string,
  codecProfile: ResolvedPostgresCodecProfile
): string {
  const ambientBindings = new Set<string>()
  const scalarImports = new Set<string>()
  const checkConstraintTypes = checkConstraintLiteralUnionByColumn(checkConstraintLiteralUnions)
  const renderedEnumOids = new Set(enums.map((row) => row.oid))
  const resolvedColumns = columns.map((row): ResolvedColumnCatalogRow => {
    const type = types.get(row.type_oid) ?? {
      pgType: `oid:${row.type_oid}`,
      pgTypeKind: 'unknown' as const,
      pgTypeName: `oid_${row.type_oid}`,
      pgTypeOid: row.type_oid,
      pgTypeSchema: 'unknown',
    }
    const resolution = tsTypeForColumn(row, type, checkConstraintTypes, codecProfile, renderedEnumOids)
    return { resolution, row }
  })
  for (const { resolution } of resolvedColumns) {
    for (const ambientBinding of resolution.ambientBindings) {
      ambientBindings.add(ambientBinding)
    }
    for (const scalarImport of resolution.scalarImports) {
      scalarImports.add(scalarImport)
    }
  }
  validateCatalogBindings(enums, relations, checkConstraintLiteralUnions, ambientBindings, scalarImports)

  const importBlock =
    scalarImports.size > 0
      ? `import type { ${[...scalarImports].toSorted().join(', ')} } from ${quoteString(scalarModuleSpecifier)}\n\n`
      : ''

  return `// This file is auto-generated by postgres-typed-sql
// Codec profile: ${renderTypeScriptLineCommentValue(codecProfile.name)}
// DO NOT EDIT MANUALLY

${importBlock}
${renderEnums(enums)}

${renderCheckConstraintLiteralUnions(checkConstraintLiteralUnions)}

${renderRelations(relations, resolvedColumns)}

${renderCatalogDb(relations)}
`
}

export async function buildCatalogTypes(
  client: PostgresQueryable,
  config: ResolvedPostgresTypedSqlConfig
): Promise<string> {
  const enums = await loadEnums(client)
  const relations = await loadRelations(client)
  const columns = await loadColumns(client)
  const types = await loadPostgresTypeFacts(client, [...new Set(columns.map((row) => row.type_oid))])
  const schemas = [...new Set(relations.map((row) => row.schema))]
  const checkConstraintLiteralUnions = await loadCheckConstraintLiteralUnionFacts(client, { schemas })
  return renderCatalogTypes(
    enums,
    relations,
    columns,
    types,
    checkConstraintLiteralUnions,
    config.imports.scalars,
    config.codecProfile
  )
}

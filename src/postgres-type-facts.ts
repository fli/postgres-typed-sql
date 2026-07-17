import type { PostgresQueryable } from './database.js'
import type { PostgresTypeFact, PostgresTypeKind } from './postgres-types.js'

interface TypeCatalogRow {
  readonly array_delimiter: string | null
  readonly base_type_oid: number
  readonly element_type_oid: number
  readonly enum_labels: readonly string[] | null
  readonly formatted_type: string
  readonly is_array: boolean
  readonly casts_to_json: boolean
  readonly oid: number
  readonly type_schema: string
  readonly typname: string
  readonly typtype: string
}

function postgresTypeKind(type: TypeCatalogRow): PostgresTypeKind {
  if (type.is_array) {
    return 'array'
  }

  switch (type.typtype) {
    case 'b':
      return 'base'
    case 'c':
      return 'composite'
    case 'd':
      return 'domain'
    case 'e':
      return 'enum'
    case 'm':
      return 'multirange'
    case 'p':
      return 'pseudo'
    case 'r':
      return 'range'
    default:
      return 'unknown'
  }
}

function postgresTypeFact(
  oid: number,
  rows: ReadonlyMap<number, TypeCatalogRow>,
  resolving: ReadonlySet<number> = new Set()
): PostgresTypeFact | undefined {
  const row = rows.get(oid)
  if (!row || resolving.has(oid)) {
    return undefined
  }

  const nextResolving = new Set(resolving).add(oid)
  const baseType = postgresTypeFact(row.base_type_oid, rows, nextResolving)
  const arrayElementType = row.is_array ? postgresTypeFact(row.element_type_oid, rows, nextResolving) : undefined
  return {
    pgType: row.formatted_type,
    pgTypeKind: postgresTypeKind(row),
    pgTypeName: row.typname,
    pgTypeOid: row.oid,
    pgTypeSchema: row.type_schema,
    ...(row.casts_to_json ? { pgCastsToJson: true } : {}),
    ...(row.enum_labels ? { pgEnumLabels: row.enum_labels } : {}),
    ...(baseType ? { pgBaseType: baseType } : {}),
    ...(arrayElementType ? { pgArrayElementType: arrayElementType } : {}),
    ...(row.array_delimiter ? { pgArrayDelimiter: row.array_delimiter } : {}),
  }
}

export async function loadPostgresTypeFacts(
  client: PostgresQueryable,
  rootOids: readonly number[]
): Promise<ReadonlyMap<number, PostgresTypeFact>> {
  if (rootOids.length === 0) {
    return new Map()
  }

  const result = await client.query<TypeCatalogRow>(
    `
      with recursive referenced_types(oid) as (
        select requested.oid
        from unnest($1::oid[]) as requested(oid)

        union

        select dependency.oid
        from referenced_types referenced
        inner join pg_type referenced_type
          on referenced_type.oid = referenced.oid
        cross join lateral (
          values
            (referenced_type.typbasetype),
            (
              case
                when referenced_type.typelem <> 0
                  and exists (
                    select 1
                    from pg_type element_type
                    where element_type.oid = referenced_type.typelem
                      and element_type.typarray = referenced_type.oid
                  )
                  then referenced_type.typelem
                else 0
              end
            )
        ) as dependency(oid)
        where dependency.oid <> 0
      )
      select
        type.oid::int as oid,
        format_type(type.oid, null) as formatted_type,
        namespace.nspname as type_schema,
        type.typname,
        type.typtype,
        case
          when type.typtype = 'e' then (
            select jsonb_agg(enum_entry.enumlabel order by enum_entry.enumsortorder)
            from pg_enum enum_entry
            where enum_entry.enumtypid = type.oid
          )
          else null
        end as enum_labels,
        exists (
          select 1
          from pg_cast cast_entry
          where type.oid >= 16384
            and cast_entry.castsource = type.oid
            and cast_entry.casttarget = 114
            and cast_entry.castfunc <> 0
        ) as casts_to_json,
        type.typelem <> 0 and element_type.typarray = type.oid as is_array,
        case
          when type.typelem <> 0 and element_type.typarray = type.oid
            then element_type.typdelim::text
          else null
        end as array_delimiter,
        type.typbasetype::int as base_type_oid,
        type.typelem::int as element_type_oid
      from referenced_types referenced
      inner join pg_type type
        on type.oid = referenced.oid
      inner join pg_namespace namespace
        on namespace.oid = type.typnamespace
      left join pg_type element_type
        on element_type.oid = type.typelem
    `,
    [rootOids]
  )

  const rows = new Map(result.rows.map((row) => [row.oid, row]))
  const facts = new Map<number, PostgresTypeFact>()
  for (const oid of new Set(rootOids)) {
    const fact = postgresTypeFact(oid, rows)
    if (fact) {
      facts.set(oid, fact)
    }
  }
  return facts
}

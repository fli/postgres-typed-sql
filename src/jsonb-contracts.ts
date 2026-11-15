import type { JsonbContractField, JsonbContractShape, JsonbFunctionContract } from './config.js'
import type { PostgresQueryable } from './database.js'
import type { TypedSqlPostgresIrJsonShape } from './analyzer-ir-model.js'

const nonNull = { kind: 'nonNull', basis: 'jsonb_contract' } as const
const nullable = { kind: 'nullable', evidence: 'jsonb_contract' } as const
const type = (name: string, oid: number) => ({
  pgType: name,
  pgTypeKind: 'base' as const,
  pgTypeName: name,
  pgTypeOid: oid,
  pgTypeSchema: 'pg_catalog',
})

function objectFields(
  fields: Readonly<Record<string, JsonbContractField>>,
  projection: (path: string) => TypedSqlPostgresIrJsonShape
) {
  return Object.entries(fields).map(([name, item]) =>
    typeof item === 'object' && 'optional' in item
      ? { name, shape: shape(item.optional, projection), optional: true }
      : { name, shape: shape(item, projection) }
  )
}

function shape(
  value: JsonbContractShape,
  projection: (path: string) => TypedSqlPostgresIrJsonShape
): TypedSqlPostgresIrJsonShape {
  if (typeof value === 'string') {
    switch (value) {
      case 'json':
        return { kind: 'opaque', nullability: nonNull }
      case 'null':
        return { kind: 'null', nullability: nonNull }
      case 'number':
        return { kind: 'jsonNumber', nullability: nonNull }
      case 'string':
        return { kind: 'scalar', ...type('text', 25), nullability: nonNull }
      case 'boolean':
        return { kind: 'scalar', ...type('bool', 16), nullability: nonNull }
      case 'int4':
        return { kind: 'scalar', ...type('int4', 23), nullability: nonNull }
    }
  }
  if ('nullable' in value) return { ...shape(value.nullable, projection), nullability: nullable }
  if ('array' in value) return { kind: 'array', element: shape(value.array, projection), nullability: nonNull }
  if ('projection' in value) return projection(value.projection)
  return {
    kind: 'object',
    fields: objectFields(value.object, projection),
    nullability: nonNull,
  }
}

function contractShape(
  contract: JsonbFunctionContract,
  projection: (path: string) => TypedSqlPostgresIrJsonShape
): TypedSqlPostgresIrJsonShape {
  if (contract.returns !== undefined) {
    const result = shape(contract.returns, projection)
    return contract.allowJsonNull || result.nullability.kind !== 'nonNull'
      ? {
          kind: 'union',
          alternatives: [
            { ...result, nullability: nonNull },
            { kind: 'null', nullability: nonNull },
          ],
          nullability: nonNull,
        }
      : result
  }
  const alternatives: TypedSqlPostgresIrJsonShape[] = Object.entries(contract.variants).map(([variant, fields]) => ({
    kind: 'object',
    nullability: nonNull,
    fields: [
      { name: 'kind', shape: { kind: 'stringLiteral', ...type('text', 25), value: variant, nullability: nonNull } },
      ...objectFields(fields, projection),
    ],
  }))
  if (contract.allowJsonNull) alternatives.push({ kind: 'null', nullability: nonNull })
  return { kind: 'union', alternatives, nullability: nonNull }
}

export async function resolveJsonbContracts(
  client: PostgresQueryable,
  contracts: readonly JsonbFunctionContract[],
  projection: (
    path: string,
    contract: (oid: number) => TypedSqlPostgresIrJsonShape | undefined
  ) => TypedSqlPostgresIrJsonShape
): Promise<Map<number, TypedSqlPostgresIrJsonShape>> {
  const definitions = new Map<number, JsonbFunctionContract>()
  for (const contract of contracts) {
    const args = contract.argumentTypes.map((arg) =>
      typeof arg === 'string' ? { schema: 'pg_catalog', name: arg } : arg
    )
    const rows = await client.query<{ oid: number; valid: boolean }>(
      `
      SELECT p.oid::int AS oid,
        (p.prokind = 'f' AND p.prorettype = 'pg_catalog.jsonb'::regtype) AS valid
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname::text = $1 AND p.proname::text = $2
        AND ARRAY(SELECT unnest(p.proargtypes::oid[])) = ARRAY(
          SELECT t.oid FROM jsonb_array_elements($3::jsonb) WITH ORDINALITY AS a(value, ord)
          JOIN pg_catalog.pg_namespace tn ON tn.nspname::text = a.value->>'schema'
          JOIN pg_catalog.pg_type t ON t.typnamespace = tn.oid AND t.typname::text = a.value->>'name'
          ORDER BY a.ord
        )
        AND p.pronargs = jsonb_array_length($3::jsonb)
    `,
      [contract.schema, contract.name, JSON.stringify(args)]
    )
    const signature = `${contract.schema}.${contract.name}(${args.map((arg) => `${arg.schema}.${arg.name}`).join(', ')})`
    const row = rows.rows[0]
    if (!row || rows.rows.length !== 1) throw new Error(`JSONB function contract overload not found: ${signature}.`)
    if (!row.valid) throw new Error(`JSONB function contract requires a function returning jsonb: ${signature}.`)
    if (definitions.has(row.oid)) throw new Error(`Duplicate JSONB function contract: ${signature}.`)
    definitions.set(row.oid, contract)
  }
  const result = new Map<number, TypedSqlPostgresIrJsonShape>()
  const resolving = new Set<number>()
  const resolve = (oid: number): TypedSqlPostgresIrJsonShape | undefined => {
    const existing = result.get(oid)
    if (existing) return existing
    const definition = definitions.get(oid)
    if (!definition) return undefined
    if (resolving.has(oid)) throw new Error('Cyclic JSONB contract projections are not supported.')
    resolving.add(oid)
    const resolved = contractShape(definition, (path) => projection(path, resolve))
    resolving.delete(oid)
    result.set(oid, resolved)
    return resolved
  }
  for (const oid of definitions.keys()) resolve(oid)
  return result
}

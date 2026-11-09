import {
  createPostgresExecutor,
  PgExecutionError,
  type PostgresExecutionRequest,
  type PostgresExecutionResponse,
  type PostgresExecutor,
} from '../runtime.js'
import type { PostgresTypeFact, PostgresTypeKind } from '../postgres-types.js'
import type { PgJsonPlan } from '../value-types.js'

export * from '../runtime.js'

export interface NodePostgresTypedSqlQueryConfig {
  readonly name?: string
  readonly text: string
  readonly values: (string | null)[]
  readonly rowMode: 'array'
  readonly binary: false
  readonly types: { getTypeParser(oid: number, format?: string): (value: string) => string }
}

export interface NodePostgresTypedSqlQueryResult {
  readonly rows: readonly unknown[]
  readonly fields: readonly { readonly name: string; readonly dataTypeID: number; readonly format: string }[]
  readonly rowCount: number | null
}

export interface NodePostgresTypedSqlClient {
  query(config: NodePostgresTypedSqlQueryConfig): Promise<NodePostgresTypedSqlQueryResult>
}
export interface NodePostgresTypedSqlPool {
  connect(): Promise<NodePostgresTypedSqlClient & { release(error?: Error | boolean): void }>
}

const rawTypes = Object.freeze({
  getTypeParser: (_oid: number, format?: string) => {
    if (format !== undefined && format !== 'text') throw new Error('Binary result parsing is unsupported.')
    return (value: string) => value
  },
})

const settingsSql = `select pg_catalog.current_setting('server_version_num'), pg_catalog.current_setting('client_encoding'),
  pg_catalog.current_setting('DateStyle'), pg_catalog.current_setting('IntervalStyle'), pg_catalog.current_setting('TimeZone'),
  pg_catalog.current_setting('bytea_output'), pg_catalog.current_setting('extra_float_digits')`

const catalogSql = `select t.oid::pg_catalog.text, n.nspname, t.typname, t.typtype,
  t.typbasetype::pg_catalog.text, t.typelem::pg_catalog.text,
  (t.typelem <> 0 and e.typarray = t.oid)::pg_catalog.text,
  case when t.typelem <> 0 and e.typarray = t.oid then e.typdelim::pg_catalog.text else null end,
  case when t.typtype = 'e' then coalesce((select pg_catalog.json_agg(x.enumlabel order by x.enumsortorder)::pg_catalog.text
    from pg_catalog.pg_enum x where x.enumtypid = t.oid), '[]') else null end,
  exists(select 1 from pg_catalog.pg_cast c where t.oid >= 16384 and c.castsource = t.oid
    and c.casttarget = 114 and c.castfunc <> 0)::pg_catalog.text
  from pg_catalog.pg_type t join pg_catalog.pg_namespace n on n.oid = t.typnamespace
  left join pg_catalog.pg_type e on e.oid = t.typelem`

function queryConfig(
  text: string,
  values: readonly (string | null)[] = [],
  name?: string
): NodePostgresTypedSqlQueryConfig {
  return {
    text,
    values: [...values],
    rowMode: 'array',
    binary: false,
    types: rawTypes,
    ...(name === undefined ? {} : { name }),
  }
}

function jsonPlanTypes(plan: PgJsonPlan): readonly PostgresTypeFact[] {
  switch (plan.kind) {
    case 'scalar':
      return [plan.type]
    case 'array':
      return jsonPlanTypes(plan.element)
    case 'object':
      return plan.fields.flatMap((field) => jsonPlanTypes(field.plan))
    case 'union':
      return plan.alternatives.flatMap(jsonPlanTypes)
    default:
      return []
  }
}

function rawRows(result: NodePostgresTypedSqlQueryResult): readonly (readonly (string | null)[])[] {
  if (
    !result ||
    !Array.isArray(result.rows) ||
    !Array.isArray(result.fields) ||
    result.fields.some((field) => field.format !== 'text')
  ) {
    throw new Error('Expected a single node-postgres text query result.')
  }
  return result.rows.map((row) => {
    if (!Array.isArray(row) || row.some((value: unknown) => value !== null && typeof value !== 'string')) {
      throw new Error('Expected positional rows containing only raw text and SQL NULL.')
    }
    return row
  })
}

function verifySettings(result: NodePostgresTypedSqlQueryResult): void {
  const rows = rawRows(result)
  const row = rows[0]
  if (rows.length !== 1 || !row || row.length !== 7) throw new Error('Could not verify PostgreSQL session settings.')
  const [version, encoding, dateStyle, intervalStyle, timezone, bytea, floatDigits] = row
  const versionNumber = Number(version)
  if (!Number.isInteger(versionNumber) || versionNumber < 120000 || versionNumber >= 190000)
    throw new Error('Unsupported PostgreSQL server version.')
  if (
    encoding !== 'UTF8' ||
    dateStyle?.replace(/\s/g, '').toUpperCase() !== 'ISO,YMD' ||
    intervalStyle !== 'postgres' ||
    timezone?.toUpperCase() !== 'UTC' ||
    bytea !== 'hex' ||
    floatDigits !== '3'
  ) {
    throw new Error(
      'PostgreSQL session must use UTF8, ISO/YMD, postgres intervals, UTC, hex bytea, and extra_float_digits=3.'
    )
  }
}

interface CatalogEntry {
  readonly oid: number
  readonly schema: string
  readonly name: string
  readonly kind: PostgresTypeKind
  readonly base: number
  readonly element: number
  readonly delimiter: string | null
  readonly labels: readonly string[] | undefined
  readonly castsToJson: boolean
}

function catalogEntries(result: NodePostgresTypedSqlQueryResult): Map<number, CatalogEntry> {
  const entries = new Map<number, CatalogEntry>()
  for (const row of rawRows(result)) {
    const [oidText, schema, name, typtype, baseText, elementText, isArray, delimiter, labelsText, casts] = row
    const oid = Number(oidText),
      base = Number(baseText),
      element = Number(elementText)
    if (
      row.length !== 10 ||
      !Number.isInteger(oid) ||
      oid <= 0 ||
      !schema ||
      !name ||
      !typtype ||
      !Number.isInteger(base) ||
      !Number.isInteger(element) ||
      (isArray !== 'true' && isArray !== 'false') ||
      (casts !== 'true' && casts !== 'false')
    )
      throw new Error('Malformed PostgreSQL type catalog response.')
    let labels: readonly string[] | undefined
    if (labelsText !== null && labelsText !== undefined) {
      const parsed: unknown = JSON.parse(labelsText)
      if (!Array.isArray(parsed) || parsed.some((label: unknown) => typeof label !== 'string'))
        throw new Error('Malformed enum labels.')
      labels = parsed
    }
    const kinds: Record<string, PostgresTypeKind> = {
      b: 'base',
      c: 'composite',
      d: 'domain',
      e: 'enum',
      m: 'multirange',
      p: 'pseudo',
      r: 'range',
    }
    const kind = isArray === 'true' ? 'array' : (kinds[typtype] ?? 'unknown')
    if (entries.has(oid)) throw new Error('Duplicate PostgreSQL type OID.')
    entries.set(oid, {
      oid,
      schema,
      name,
      kind,
      base,
      element,
      delimiter: delimiter ?? null,
      labels,
      castsToJson: casts === 'true',
    })
  }
  return entries
}

function catalogType(
  oid: number,
  entries: ReadonlyMap<number, CatalogEntry>,
  seen = new Set<number>()
): PostgresTypeFact {
  const entry = entries.get(oid)
  if (!entry || seen.has(oid)) throw new Error(`Cannot resolve PostgreSQL type OID ${oid}.`)
  const next = new Set(seen).add(oid)
  return {
    pgType: `${entry.schema}.${entry.name}`,
    pgTypeSchema: entry.schema,
    pgTypeName: entry.name,
    pgTypeOid: entry.oid,
    pgTypeKind: entry.kind,
    ...(entry.labels ? { pgEnumLabels: entry.labels } : {}),
    ...(entry.castsToJson ? { pgCastsToJson: true } : {}),
    ...(entry.kind === 'domain' ? { pgBaseType: catalogType(entry.base, entries, next) } : {}),
    ...(entry.kind === 'array' ? { pgArrayElementType: catalogType(entry.element, entries, next) } : {}),
    ...(entry.delimiter ? { pgArrayDelimiter: entry.delimiter } : {}),
  }
}

function sameType(expected: PostgresTypeFact, actual: PostgresTypeFact): boolean {
  if (
    expected.pgTypeSchema !== actual.pgTypeSchema ||
    expected.pgTypeName !== actual.pgTypeName ||
    expected.pgTypeKind !== actual.pgTypeKind ||
    Boolean(expected.pgCastsToJson) !== Boolean(actual.pgCastsToJson) ||
    expected.pgArrayDelimiter !== actual.pgArrayDelimiter
  )
    return false
  if (expected.pgTypeKind === 'enum' && JSON.stringify(expected.pgEnumLabels) !== JSON.stringify(actual.pgEnumLabels))
    return false
  if (expected.pgTypeKind === 'domain')
    return !!expected.pgBaseType && !!actual.pgBaseType && sameType(expected.pgBaseType, actual.pgBaseType)
  if (expected.pgTypeKind === 'array')
    return (
      !!expected.pgArrayElementType &&
      !!actual.pgArrayElementType &&
      sameType(expected.pgArrayElementType, actual.pgArrayElementType)
    )
  return true
}

const activeClients = new WeakSet<object>()

async function preflightQuery(
  client: NodePostgresTypedSqlClient,
  text: string
): Promise<NodePostgresTypedSqlQueryResult> {
  try {
    return await client.query(queryConfig(text))
  } catch (error) {
    throw new PgExecutionError('PostgreSQL preflight query failed.', 'transport', 'notExecuted', error)
  }
}

async function executeOnClient(
  client: NodePostgresTypedSqlClient,
  request: PostgresExecutionRequest
): Promise<PostgresExecutionResponse> {
  if (activeClients.has(client))
    throw new PgExecutionError('The node-postgres client is already in use by this adapter.', 'contract', 'notExecuted')
  activeClients.add(client)
  try {
    let entries: Map<number, CatalogEntry>
    try {
      verifySettings(await preflightQuery(client, settingsSql))
      entries = catalogEntries(await preflightQuery(client, catalogSql))
      const byName = new Map([...entries.values()].map((entry) => [`${entry.schema}\0${entry.name}`, entry.oid]))
      for (const expected of [
        ...request.parameters,
        ...request.columns.flatMap((column) => [
          column.type,
          ...(column.jsonPlan ? jsonPlanTypes(column.jsonPlan) : []),
        ]),
      ]) {
        const oid = byName.get(`${expected.pgTypeSchema}\0${expected.pgTypeName}`)
        if (oid === undefined || !sameType(expected, catalogType(oid, entries)))
          throw new Error(
            `Declared type ${expected.pgTypeSchema}.${expected.pgTypeName} does not match the executing database.`
          )
      }
    } catch (error) {
      if (error instanceof PgExecutionError) throw error
      throw new PgExecutionError('PostgreSQL transport verification failed.', 'contract', 'notExecuted', error)
    }
    let result: NodePostgresTypedSqlQueryResult
    try {
      result = await client.query(queryConfig(request.text, request.values, request.name))
    } catch (error) {
      throw new PgExecutionError('PostgreSQL query failed.', 'transport', 'mayHaveExecuted', error)
    }
    try {
      const rows = rawRows(result)
      if (!Array.isArray(result.fields) || result.fields.length !== request.columns.length)
        throw new Error('PostgreSQL result field count does not match metadata.')
      const columnTypes = result.fields.map((field, index) => {
        const expected = request.columns[index]
        if (!expected || field.format !== 'text' || field.name !== expected.name || !Number.isInteger(field.dataTypeID))
          throw new Error('PostgreSQL result field metadata does not match the text contract.')
        const actual = catalogType(field.dataTypeID, entries)
        let wireType = expected.type
        while (wireType.pgTypeKind === 'domain' && wireType.pgBaseType) wireType = wireType.pgBaseType
        if (!sameType(wireType, actual))
          throw new Error(`Result type for ${field.name} does not match the executing database.`)
        return actual
      })
      return { rows, columnTypes, rowCount: result.rowCount }
    } catch (error) {
      throw new PgExecutionError(
        'PostgreSQL result violated the transport contract.',
        'contract',
        'mayHaveExecuted',
        error
      )
    }
  } finally {
    activeClients.delete(client)
  }
}

/** The caller owns transactions, deadlines, connection lifetime, and exclusive access to a supplied client. */
export function nodePostgres(
  connection: { readonly client: NodePostgresTypedSqlClient } | { readonly pool: NodePostgresTypedSqlPool }
): PostgresExecutor {
  return createPostgresExecutor(async (request) => {
    if ('client' in connection) return executeOnClient(connection.client, request)
    let client: Awaited<ReturnType<NodePostgresTypedSqlPool['connect']>>
    try {
      client = await connection.pool.connect()
    } catch (error) {
      throw new PgExecutionError('Could not acquire a PostgreSQL pool client.', 'transport', 'notExecuted', error)
    }
    try {
      return await executeOnClient(client, request)
    } finally {
      client.release()
    }
  })
}

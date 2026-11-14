import {
  createPostgresExecutor,
  PgExecutionError,
  type PostgresExecutionRequest,
  type PostgresExecutionResponse,
  type PostgresExecutor,
} from '../runtime.js'

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
  readonly fields: readonly { readonly name: string; readonly format: string }[]
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

function queryConfig(text: string, values: readonly (string | null)[], name?: string): NodePostgresTypedSqlQueryConfig {
  return {
    text,
    values: [...values],
    rowMode: 'array',
    binary: false,
    types: rawTypes,
    ...(name === undefined ? {} : { name }),
  }
}

function rawRows(result: NodePostgresTypedSqlQueryResult): readonly (readonly (string | null)[])[] {
  if (!result || !Array.isArray(result.rows) || !Array.isArray(result.fields)) {
    throw new Error('Expected a single node-postgres text query result.')
  }
  return result.rows.map((row) => {
    if (!Array.isArray(row) || row.some((value: unknown) => value !== null && typeof value !== 'string')) {
      throw new Error('Expected positional rows containing only raw text and SQL NULL.')
    }
    return row
  })
}

const activeClients = new WeakSet<object>()

async function executeOnClient(
  client: NodePostgresTypedSqlClient,
  request: PostgresExecutionRequest
): Promise<PostgresExecutionResponse> {
  if (activeClients.has(client))
    throw new PgExecutionError('The node-postgres client is already in use by this adapter.', 'contract', 'notExecuted')
  activeClients.add(client)
  try {
    let result: NodePostgresTypedSqlQueryResult
    try {
      result = await client.query(queryConfig(request.text, request.values, request.name))
    } catch (error) {
      throw new PgExecutionError('PostgreSQL query failed.', 'transport', 'mayHaveExecuted', error)
    }
    try {
      const rows = rawRows(result)
      if (
        result.fields.length !== request.columnNames.length ||
        result.fields.some((field, index) => field.format !== 'text' || field.name !== request.columnNames[index])
      )
        throw new Error('PostgreSQL result field metadata does not match the text contract.')
      return { rows, rowCount: result.rowCount }
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

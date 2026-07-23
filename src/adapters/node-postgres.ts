import {
  mapTypedSqlRows,
  typedSqlRowCount,
  type TypedSqlArrayRow,
  type TypedSqlParams,
  type TypedSqlQueryConfig,
  type TypedSqlRawRow,
  type TypedSqlStatement,
} from '../runtime.js'

/** The query-config subset consumed by node-postgres's `client.query(config)` API. */
export interface NodePostgresTypedSqlQueryConfig extends TypedSqlQueryConfig {
  readonly rowMode?: 'array'
}

export interface NodePostgresTypedSqlQueryResult {
  readonly rowCount?: number | null
  readonly rows: readonly unknown[]
}

/** A structural node-postgres client type; importing `pg` is not required. */
export interface NodePostgresTypedSqlClient {
  query(config: NodePostgresTypedSqlQueryConfig): Promise<NodePostgresTypedSqlQueryResult>
}

function positionalRows(statementName: string, rows: readonly unknown[]): TypedSqlArrayRow[] {
  return rows.map((row, index) => {
    if (!Array.isArray(row)) {
      throw new Error(
        `Typed SQL statement ${statementName} expected node-postgres row ${index + 1} to use rowMode: 'array'.`
      )
    }
    return row
  })
}

function objectRows(statementName: string, rows: readonly unknown[]): TypedSqlRawRow[] {
  return rows.map((row, index) => {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) {
      throw new Error(`Typed SQL statement ${statementName} expected node-postgres row ${index + 1} to be an object.`)
    }
    return row as TypedSqlRawRow
  })
}

export async function executeTypedSql<Params extends TypedSqlParams, Row>(
  client: NodePostgresTypedSqlClient,
  statement: TypedSqlStatement<Params, Row>,
  params: Params
): Promise<Row[]> {
  const query = statement.query(params)
  if (statement.resultRowMapping === 'positional') {
    const result = await client.query({
      ...query,
      rowMode: 'array',
    })
    return mapTypedSqlRows(statement, positionalRows(statement.name, result.rows))
  }

  const result = await client.query(query)
  return mapTypedSqlRows(statement, objectRows(statement.name, result.rows))
}

export async function executeTypedSqlOptional<Params extends TypedSqlParams, Row>(
  client: NodePostgresTypedSqlClient,
  statement: TypedSqlStatement<Params, Row>,
  params: Params
): Promise<Row | null> {
  const rows = await executeTypedSql(client, statement, params)
  if (rows.length > 1) {
    throw new Error(`Typed SQL statement ${statement.name} returned ${rows.length} rows; expected zero or one.`)
  }
  return rows[0] ?? null
}

export async function executeTypedSqlOne<Params extends TypedSqlParams, Row>(
  client: NodePostgresTypedSqlClient,
  statement: TypedSqlStatement<Params, Row>,
  params: Params
): Promise<Row> {
  const row = await executeTypedSqlOptional(client, statement, params)
  if (row === null) {
    throw new Error(`Typed SQL statement ${statement.name} returned no rows; expected exactly one.`)
  }
  return row
}

export async function executeTypedSqlCommand<Params extends TypedSqlParams, Row>(
  client: NodePostgresTypedSqlClient,
  statement: TypedSqlStatement<Params, Row>,
  params: Params
): Promise<number> {
  const result = await client.query(statement.query(params))
  return typedSqlRowCount(result.rowCount)
}

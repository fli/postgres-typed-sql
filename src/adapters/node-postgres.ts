import {
  mapTypedSqlRows,
  typedSqlRowCount,
  validateTypedSqlResultMetadata,
  type TypedSqlAccessKind,
  type TypedSqlResultKind,
  type TypedSqlExecutionResult,
  type TypedSqlParameterArgs,
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

export { createTypedSqlStatement } from '../runtime.js'
export type * from '../runtime.js'

export async function executeTypedSql<
  Params extends TypedSqlParams,
  Row,
  Access extends TypedSqlAccessKind,
  Kind extends TypedSqlResultKind,
>(
  client: NodePostgresTypedSqlClient,
  statement: TypedSqlStatement<Params, Row, Access, Kind>,
  params: NoInfer<Params>
): Promise<TypedSqlExecutionResult<Row, Kind>> {
  validateTypedSqlResultMetadata(statement)
  const resultKind = statement.resultKind
  const bounds = { ...statement.rowBounds }
  const query = statement.query(params)
  const result = await client.query(
    statement.resultRowMapping === 'positional' ? { ...query, rowMode: 'array' } : query
  )
  let value: Row | Row[] | number | null | undefined
  switch (resultKind) {
    case 'command':
    case 'void':
      if (result.rows.length !== 0) {
        throw new Error(`Typed SQL statement ${statement.name} returned unexpected rows for ${resultKind}.`)
      }
      value = resultKind === 'command' ? typedSqlRowCount(result.rowCount) : undefined
      break
    case 'one':
    case 'optional':
    case 'many': {
      const { min, max } = bounds
      if (result.rows.length < min || (max !== null && result.rows.length > max)) {
        throw new Error(
          `Typed SQL statement ${statement.name} returned ${result.rows.length} rows; expected rowBounds [${min}, ${max ?? 'unbounded'}]. SQL may already have executed; do not retry automatically.`
        )
      }
      const rows = mapTypedSqlRows(
        statement,
        statement.resultRowMapping === 'positional'
          ? positionalRows(statement.name, result.rows)
          : objectRows(statement.name, result.rows)
      )
      value = resultKind === 'many' ? rows : (rows[0] ?? null)
      break
    }
    default: {
      const exhaustive: never = resultKind
      throw new Error(`Unsupported Typed SQL result kind ${String(exhaustive)}.`)
    }
  }
  return value as TypedSqlExecutionResult<Row, Kind>
}

export function createTypedSqlExecutor<
  Params extends TypedSqlParams,
  Row,
  Access extends TypedSqlAccessKind,
  Kind extends TypedSqlResultKind,
>(
  statement: TypedSqlStatement<Params, Row, Access, Kind>
): (
  client: NodePostgresTypedSqlClient,
  ...args: TypedSqlParameterArgs<Params>
) => Promise<TypedSqlExecutionResult<Row, Kind>> {
  validateTypedSqlResultMetadata(statement)
  return (client, ...args) => {
    const params = args[0]
    if (params === undefined) {
      if (statement.parameterNames.length !== 0) {
        throw new Error(`Typed SQL statement ${statement.name} requires a parameter object.`)
      }
      return executeTypedSql(client, statement, {} as Params)
    }
    return executeTypedSql(client, statement, params)
  }
}

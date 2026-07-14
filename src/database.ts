export interface PostgresQueryResult<Row> {
  readonly rows: Row[]
}

export interface PostgresQueryable {
  query<Row = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<PostgresQueryResult<Row>>
}

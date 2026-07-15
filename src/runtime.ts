export type TypedSqlParams = object

export type TypedSqlCardinality = 'many' | 'none' | 'one' | 'optional'

export type TypedSqlCommandKind = 'delete' | 'insert' | 'merge' | 'select' | 'unknown' | 'update'
export type TypedSqlAccessKind = 'read' | 'write'

export interface TypedSqlRowBounds {
  readonly max: number | null
  readonly min: number
  readonly proof: string
}

export interface TypedSqlQueryConfig<Row = unknown> {
  readonly name?: string
  readonly rowMode?: 'array'
  readonly text: string
  readonly type?: Row
  readonly values: readonly unknown[]
}

export type TypedSqlRawRow = Readonly<Record<string, unknown>>
export type TypedSqlArrayRow = readonly unknown[]

function isTypedSqlArrayRow(row: TypedSqlArrayRow | TypedSqlRawRow): row is TypedSqlArrayRow {
  return Array.isArray(row)
}

export type TypedSqlRowNameSource = 'property' | 'sql'

export type TypedSqlColumnSourceMetadata =
  | {
      readonly kind: 'derivedVar'
      readonly relname?: string | null
      readonly varattno: number
      readonly varlevelsup: number
      readonly varno: number
      readonly varnullingrels: readonly number[]
    }
  | {
      readonly attname?: string
      readonly kind: 'tableColumn'
      readonly relname?: string | null
      readonly varattno?: number
      readonly varlevelsup: number
      readonly varno: number
      readonly varnullingrels: readonly number[]
    }
  | {
      readonly kind: 'expression'
      readonly tag: string
    }

export interface TypedSqlColumnMetadata {
  readonly name: string
  readonly nullable: boolean
  readonly pgType: string
  readonly pgTypeName: string
  readonly pgTypeSchema: string
  readonly propertyName: string
  readonly source?: TypedSqlColumnSourceMetadata
}

export interface TypedSqlParameterMetadata {
  readonly name: string
  readonly nullable?: boolean
  readonly pgType: string
  readonly pgTypeName: string
  readonly pgTypeSchema: string
  readonly propertyName: string
}

export interface TypedSqlStatement<
  Params extends TypedSqlParams,
  Row,
  Access extends TypedSqlAccessKind = TypedSqlAccessKind,
  Cardinality extends TypedSqlCardinality = TypedSqlCardinality,
> {
  readonly access: Access
  readonly cardinality: Cardinality
  readonly columns: readonly TypedSqlColumnMetadata[]
  readonly command: TypedSqlCommandKind
  readonly name: string
  readonly parameterNames: readonly (keyof Params & string)[]
  readonly parameters: readonly TypedSqlParameterMetadata[]
  readonly resultRowMode?: 'array'
  readonly rowBounds: TypedSqlRowBounds
  readonly text: string
  readonly type?: Row
  query(params: Params): TypedSqlQueryConfig<TypedSqlRawRow>
  values(params: Params): readonly unknown[]
}

export interface TypedSqlClient {
  query<Row>(config: TypedSqlQueryConfig<Row>): Promise<{ readonly rowCount?: number | null; readonly rows: Row[] }>
}

export interface TypedSqlDefinition<
  Params extends TypedSqlParams,
  Row,
  Access extends TypedSqlAccessKind = TypedSqlAccessKind,
  Cardinality extends TypedSqlCardinality = TypedSqlCardinality,
> {
  readonly access?: Access
  readonly cardinality?: Cardinality
  readonly columns?: readonly TypedSqlColumnMetadata[]
  readonly command?: TypedSqlCommandKind
  readonly name: string
  readonly parameterNames: readonly (keyof Params & string)[]
  readonly parameters?: readonly TypedSqlParameterMetadata[]
  readonly rowBounds?: TypedSqlRowBounds
  readonly text: string
  readonly type?: Row
}

export function typedSqlAccessForCommand(command: TypedSqlCommandKind): TypedSqlAccessKind {
  switch (command) {
    case 'select':
      return 'read'
    case 'delete':
    case 'insert':
    case 'merge':
    case 'update':
      return 'write'
    case 'unknown':
      return 'write'
  }
}

export function createTypedSqlStatement<
  Params extends TypedSqlParams,
  Row,
  Access extends TypedSqlAccessKind = TypedSqlAccessKind,
  Cardinality extends TypedSqlCardinality = TypedSqlCardinality,
>(
  definition: TypedSqlDefinition<Params, Row, Access, Cardinality>
): TypedSqlStatement<Params, Row, Access, Cardinality> {
  return {
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- The generated statement declaration pins Access to this metadata value.
    access: (definition.access ?? typedSqlAccessForCommand(definition.command ?? 'unknown')) as Access,
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- The generated statement declaration pins Cardinality to this metadata value.
    cardinality: (definition.cardinality ?? 'many') as Cardinality,
    columns: definition.columns ?? [],
    command: definition.command ?? 'unknown',
    name: definition.name,
    parameterNames: definition.parameterNames,
    parameters: definition.parameters ?? [],
    resultRowMode: definition.columns !== undefined ? 'array' : undefined,
    rowBounds: definition.rowBounds ?? {
      max: null,
      min: 0,
      proof: 'unspecified',
    },
    text: definition.text,
    type: definition.type,
    query(params) {
      return {
        name: definition.name,
        text: definition.text,
        values: this.values(params),
      }
    },
    values(params) {
      return definition.parameterNames.map((parameterName) => {
        if (!Object.hasOwn(params, parameterName)) {
          throw new Error(
            `Typed SQL statement ${definition.name} expected an own parameter property ${JSON.stringify(parameterName)}.`
          )
        }
        return params[parameterName]
      })
    },
  }
}

export function mapTypedSqlRow<Params extends TypedSqlParams, Row>(
  statement: TypedSqlStatement<Params, Row>,
  row: TypedSqlArrayRow | TypedSqlRawRow,
  rowNameSource: TypedSqlRowNameSource = 'sql'
): Row {
  if (statement.columns.length === 0) {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- A generated zero-column SELECT row is represented by an empty array and maps to the generated empty-record row type. Custom object-row statements retain their raw row.
    return (isTypedSqlArrayRow(row) ? {} : row) as Row
  }

  const mapped: Record<string, unknown> = {}
  for (const [columnIndex, column] of statement.columns.entries()) {
    const rowKey = rowNameSource === 'sql' ? column.name : column.propertyName
    if (!isTypedSqlArrayRow(row) && !Object.hasOwn(row, rowKey)) {
      throw new Error(
        `Typed SQL statement ${statement.name} expected result column ${JSON.stringify(rowKey)} from ${rowNameSource} row names.`
      )
    }
    if (isTypedSqlArrayRow(row) && columnIndex >= row.length) {
      throw new Error(
        `Typed SQL statement ${statement.name} expected result column ${columnIndex + 1} from an array row.`
      )
    }
    Object.defineProperty(mapped, column.propertyName, {
      configurable: true,
      enumerable: true,
      value: isTypedSqlArrayRow(row) ? row[columnIndex] : row[rowKey],
      writable: true,
    })
  }

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Generated statement metadata maps each SQL result column to the generated Row property.
  return mapped as Row
}

export function mapTypedSqlRows<Params extends TypedSqlParams, Row>(
  statement: TypedSqlStatement<Params, Row>,
  rows: readonly (TypedSqlArrayRow | TypedSqlRawRow)[],
  rowNameSource: TypedSqlRowNameSource = 'sql'
): Row[] {
  return rows.map((row) => mapTypedSqlRow(statement, row, rowNameSource))
}

export function typedSqlRowCount(rowCount: bigint | number | null | undefined): number {
  if (typeof rowCount === 'bigint') {
    if (rowCount < 0n) {
      throw new Error(`Typed SQL affected row count ${rowCount.toString()} must be nonnegative.`)
    }
    if (rowCount > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(`Typed SQL affected row count ${rowCount.toString()} exceeds Number.MAX_SAFE_INTEGER.`)
    }
    return Number(rowCount)
  }

  if (typeof rowCount !== 'number') {
    throw new TypeError('Typed SQL expected the driver to expose an affected row count.')
  }
  if (!Number.isSafeInteger(rowCount) || rowCount < 0) {
    throw new Error(`Typed SQL affected row count ${String(rowCount)} must be a nonnegative safe integer.`)
  }

  return rowCount
}

function isObjectRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }

  return Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null
}

function numericProperty(value: Readonly<Record<string, unknown>>, propertyName: string): bigint | number | undefined {
  const property = value[propertyName]
  return typeof property === 'number' || typeof property === 'bigint' ? property : undefined
}

export function typedSqlAffectedRowCount(result: unknown): number {
  if (typeof result === 'number' || typeof result === 'bigint') {
    return typedSqlRowCount(result)
  }

  if (!isObjectRecord(result)) {
    throw new Error('Typed SQL expected the driver command result to expose an affected row count.')
  }

  return typedSqlRowCount(
    numericProperty(result, 'rowCount') ??
      numericProperty(result, 'numAffectedRows') ??
      numericProperty(result, 'count')
  )
}

export async function executeTypedSql<Params extends TypedSqlParams, Row>(
  client: TypedSqlClient,
  statement: TypedSqlStatement<Params, Row>,
  params: Params
): Promise<Row[]> {
  if (statement.resultRowMode === 'array') {
    const result = await client.query<TypedSqlArrayRow>({
      name: statement.name,
      rowMode: 'array',
      text: statement.text,
      values: statement.values(params),
    })
    return mapTypedSqlRows(statement, result.rows)
  }

  const result = await client.query<TypedSqlRawRow>({
    name: statement.name,
    text: statement.text,
    values: statement.values(params),
  })
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- A custom statement without result-column metadata retains the driver's object-row shape as its declared Row type.
  return result.rows as Row[]
}

export async function executeTypedSqlOptional<Params extends TypedSqlParams, Row>(
  client: TypedSqlClient,
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
  client: TypedSqlClient,
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
  client: TypedSqlClient,
  statement: TypedSqlStatement<Params, Row>,
  params: Params
): Promise<number> {
  const result = await client.query<TypedSqlRawRow>(statement.query(params))
  return typedSqlRowCount(result.rowCount)
}

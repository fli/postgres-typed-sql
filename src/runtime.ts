import type { PostgresTypeFact } from './postgres-types.js'
import type { PgJsonPlan } from './value-types.js'
import { decodePgValue, encodePgValue } from './value-codecs.js'

export type TypedSqlParams = object

export type TypedSqlResultKind = 'one' | 'optional' | 'many' | 'command' | 'void'

export type TypedSqlExecutionResult<Row, Kind extends TypedSqlResultKind> = {
  readonly one: Row
  readonly optional: Row | null
  readonly many: Row[]
  readonly command: number
  readonly void: void
}[Kind]

export type TypedSqlParameterArgs<Params extends TypedSqlParams> = string extends keyof Params
  ? [Params[keyof Params]] extends [never]
    ? Record<string, never> extends Params
      ? [params?: Params]
      : [params: Params]
    : [params: Params]
  : [params: Params]

export type TypedSqlCommandKind = 'delete' | 'insert' | 'merge' | 'select' | 'unknown' | 'update'
export type TypedSqlAccessKind = 'read' | 'write'

export interface TypedSqlRowBounds {
  /** A finite upper bound proved by analysis, or null when no finite upper bound was proved. */
  readonly max: number | null
  readonly min: number
  readonly proof: string
}

export interface TypedSqlQueryConfig {
  readonly name?: string
  readonly text: string
  readonly values: unknown[]
}

declare const typedSqlStatementRow: unique symbol

/** Immediate analyzed expression metadata; this is not ultimate column lineage. */
export type TypedSqlColumnExpressionSourceMetadata =
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
      readonly varattno: number
      readonly varlevelsup: number
      readonly varno: number
      readonly varnullingrels: readonly number[]
    }
  | {
      readonly kind: 'expression'
      readonly tag: string
    }

export interface TypedSqlColumnMetadata {
  readonly type?: PostgresTypeFact
  readonly jsonPlan?: PgJsonPlan
  /** The immediate analyzed expression source, not all underlying contributing columns. */
  readonly expressionSource: TypedSqlColumnExpressionSourceMetadata
  readonly name: string
  readonly nullable: boolean
  readonly pgType: string
  readonly pgTypeName: string
  readonly pgTypeSchema: string
  readonly propertyName: string
}

export interface TypedSqlParameterMetadata {
  readonly type?: PostgresTypeFact
  readonly name: string
  readonly nullable: boolean
  readonly pgType: string
  readonly pgTypeName: string
  readonly pgTypeSchema: string
  readonly propertyName: string
}

export interface TypedSqlStatement<
  Params extends TypedSqlParams,
  Row,
  Access extends TypedSqlAccessKind = TypedSqlAccessKind,
  Kind extends TypedSqlResultKind = TypedSqlResultKind,
> {
  readonly valueModel?: PgValueModel
  readonly access: Access
  readonly resultKind: Kind
  readonly columns: readonly TypedSqlColumnMetadata[]
  readonly command: TypedSqlCommandKind
  readonly name: string
  readonly parameterNames: readonly (keyof Params & string)[]
  readonly parameters: readonly TypedSqlParameterMetadata[]
  /** Positional rows are required when generated column metadata is present. */
  readonly resultRowMapping?: 'positional'
  readonly rowBounds: TypedSqlRowBounds
  readonly text: string
  readonly [typedSqlStatementRow]?: Row
  query(params: Params): TypedSqlQueryConfig
  values(params: Params): readonly unknown[]
}

export interface TypedSqlDefinition<
  Params extends TypedSqlParams,
  Row,
  Access extends TypedSqlAccessKind = TypedSqlAccessKind,
  Kind extends TypedSqlResultKind = TypedSqlResultKind,
> {
  readonly valueModel?: PgValueModel
  readonly access?: Access
  readonly resultKind: Kind
  readonly columns?: readonly TypedSqlColumnMetadata[]
  readonly command?: TypedSqlCommandKind
  readonly name: string
  readonly parameterNames: readonly (keyof Params & string)[]
  readonly parameters?: readonly TypedSqlParameterMetadata[]
  readonly rowBounds: TypedSqlRowBounds
  readonly text: string
  readonly [typedSqlStatementRow]?: Row
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

export function validateTypedSqlResultMetadata(metadata: {
  readonly name: string
  readonly resultKind: TypedSqlResultKind
  readonly command?: TypedSqlCommandKind
  readonly columns?: readonly TypedSqlColumnMetadata[]
  readonly resultRowMapping?: 'positional'
  readonly rowBounds: TypedSqlRowBounds
}): void {
  const bounds = metadata.rowBounds
  const dmlWithoutOutput =
    (metadata.command === 'delete' ||
      metadata.command === 'insert' ||
      metadata.command === 'update' ||
      metadata.command === 'merge') &&
    metadata.columns?.length === 0 &&
    metadata.resultRowMapping === 'positional'
  if (
    (dmlWithoutOutput &&
      (metadata.resultKind === 'one' || metadata.resultKind === 'optional' || metadata.resultKind === 'many')) ||
    (metadata.resultKind === 'command' && (metadata.command === 'select' || (metadata.columns?.length ?? 0) > 0)) ||
    (metadata.resultKind === 'void' &&
      ((metadata.command !== undefined && metadata.command !== 'unknown') || (metadata.columns?.length ?? 0) > 0))
  ) {
    throw new Error(
      `Typed SQL statement ${metadata.name} has contradictory command/result metadata; regenerate stale statements.`
    )
  }
  if (
    !bounds ||
    !Number.isSafeInteger(bounds.min) ||
    bounds.min < 0 ||
    (bounds.max !== null && (!Number.isSafeInteger(bounds.max) || bounds.max < bounds.min)) ||
    typeof bounds.proof !== 'string' ||
    bounds.proof.length === 0
  ) {
    throw new Error(`Typed SQL statement ${metadata.name} requires valid rowBounds; regenerate stale statements.`)
  }
  const expected =
    bounds.min === 1 && bounds.max === 1 ? 'one' : bounds.min === 0 && bounds.max === 1 ? 'optional' : 'many'
  if (metadata.resultKind === 'command' || metadata.resultKind === 'void') {
    if (bounds.min === 0 && bounds.max === 0) return
  } else if (metadata.resultKind === expected) {
    return
  }
  throw new Error(
    `Typed SQL statement ${metadata.name} has missing or mismatched resultKind; regenerate stale statements.`
  )
}

function freezeMetadata<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) freezeMetadata(item)
    Object.freeze(value)
  }
  return value
}

export function createTypedSqlStatement<
  Params extends TypedSqlParams,
  Row,
  Access extends TypedSqlAccessKind = TypedSqlAccessKind,
  Kind extends TypedSqlResultKind = TypedSqlResultKind,
>(definition: TypedSqlDefinition<Params, Row, Access, Kind>): TypedSqlStatement<Params, Row, Access, Kind> {
  const resultRowMapping = definition.columns !== undefined ? 'positional' : undefined
  validateTypedSqlResultMetadata({ ...definition, resultRowMapping })
  const { name, text } = definition
  const parameterNames = Object.freeze([...definition.parameterNames])
  const columns = freezeMetadata(structuredClone(definition.columns ?? []))
  const parameters = freezeMetadata(structuredClone(definition.parameters ?? []))
  return Object.freeze({
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- The generated statement declaration pins Access to this metadata value.
    valueModel: definition.valueModel,
    access: (definition.access ?? typedSqlAccessForCommand(definition.command ?? 'unknown')) as Access,
    resultKind: definition.resultKind,
    columns,
    command: definition.command ?? 'unknown',
    name: definition.name,
    parameterNames,
    parameters,
    resultRowMapping,
    rowBounds: Object.freeze({ ...definition.rowBounds }),
    text,
    query(params: Params) {
      return {
        text,
        values: [...this.values(params)],
      }
    },
    values(params: Params) {
      return parameterNames.map((parameterName) => {
        if (!Object.hasOwn(params, parameterName)) {
          throw new Error(
            `Typed SQL statement ${name} expected an own parameter property ${JSON.stringify(parameterName)}.`
          )
        }
        return params[parameterName]
      })
    },
  })
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

export type PgValueModel = 'postgres-lossless-v1'
export type PgExecutionPhase = 'encode' | 'transport' | 'decode' | 'contract'
export type PgExecutionState = 'notExecuted' | 'mayHaveExecuted'

export class PgExecutionError extends Error {
  readonly code?: string
  readonly phase: PgExecutionPhase
  readonly executionState: PgExecutionState

  constructor(message: string, phase: PgExecutionPhase, executionState: PgExecutionState, cause?: unknown) {
    super(message, { cause })
    this.name = 'PgExecutionError'
    this.phase = phase
    this.executionState = executionState
    if (cause !== null && typeof cause === 'object' && 'code' in cause && typeof cause.code === 'string') {
      this.code = cause.code
    }
  }
}

export interface PostgresExecutionRequest {
  readonly name?: string
  readonly text: string
  readonly values: readonly (string | null)[]
  readonly columnNames: readonly string[]
}

export interface PostgresExecutionResponse {
  readonly rows: readonly (readonly (string | null)[])[]
  readonly rowCount: number | null | undefined
}

declare const postgresExecutorBrand: unique symbol
export interface PostgresExecutor {
  readonly valueModel: PgValueModel
  readonly [postgresExecutorBrand]: true
  execute(request: PostgresExecutionRequest): Promise<PostgresExecutionResponse>
}

const verifiedExecutors = new WeakSet<object>()

/**
 * Register a transport that validates the result field names, order, and text format
 * against the request and returns positional rows of raw text or SQL NULL.
 */
export function createPostgresExecutor(
  execute: (request: PostgresExecutionRequest) => Promise<PostgresExecutionResponse>
): PostgresExecutor {
  const executor = Object.freeze({ valueModel: 'postgres-lossless-v1' as const, execute })
  verifiedExecutors.add(executor)
  return executor as PostgresExecutor
}

function executionError(
  error: unknown,
  phase: PgExecutionPhase,
  state: PgExecutionState,
  message: string
): PgExecutionError {
  return error instanceof PgExecutionError ? error : new PgExecutionError(message, phase, state, error)
}

export async function executeTypedSql<
  Params extends TypedSqlParams,
  Row,
  Access extends TypedSqlAccessKind,
  Kind extends TypedSqlResultKind,
>(
  executor: PostgresExecutor,
  statement: TypedSqlStatement<Params, Row, Access, Kind>,
  params: NoInfer<Params>
): Promise<TypedSqlExecutionResult<Row, Kind>> {
  let parameterTypes: PostgresTypeFact[]
  try {
    if (!executor || !verifiedExecutors.has(executor) || executor.valueModel !== 'postgres-lossless-v1') {
      throw new Error('A verified postgres-lossless-v1 executor is required.')
    }
    if (statement.valueModel !== 'postgres-lossless-v1') {
      throw new Error(`Typed SQL statement ${statement.name} has a stale value model; regenerate it.`)
    }
    validateTypedSqlResultMetadata(statement)
    if (
      statement.parameterNames.length !== statement.parameters.length ||
      statement.resultRowMapping !== 'positional'
    ) {
      throw new Error(`Typed SQL statement ${statement.name} has incomplete metadata; regenerate it.`)
    }
    parameterTypes = statement.parameters.map((parameter, index) => {
      if (!parameter.type || parameter.propertyName !== statement.parameterNames[index]) {
        throw new Error(`Typed SQL statement ${statement.name} has incomplete parameter metadata; regenerate it.`)
      }
      return parameter.type
    })
    if (statement.columns.some((column) => !column.type))
      throw new Error(`Typed SQL statement ${statement.name} has incomplete column metadata; regenerate it.`)
  } catch (error) {
    throw executionError(error, 'contract', 'notExecuted', 'Typed SQL metadata or executor contract failed.')
  }

  let values: (string | null)[]
  let queryName: string | undefined
  try {
    const query = statement.query(params)
    if (query.text !== statement.text || query.values.length !== statement.parameters.length) {
      throw new TypeError('A statement query must preserve its SQL text and parameter count.')
    }
    queryName = query.name
    values = query.values.map((value, index) => {
      const parameter = statement.parameters[index]
      const type = parameterTypes[index]
      if (!parameter || !type) throw new Error('Missing parameter metadata.')
      if (value === null && !parameter.nullable)
        throw new TypeError(`Parameter ${parameter.propertyName} does not accept SQL NULL.`)
      return encodePgValue(type, value)
    })
  } catch (error) {
    throw executionError(error, 'encode', 'notExecuted', `Could not encode parameters for ${statement.name}.`)
  }

  let result: PostgresExecutionResponse
  try {
    result = await executor.execute({
      ...(queryName === undefined ? {} : { name: queryName }),
      text: statement.text,
      values,
      columnNames: statement.columns.map((column) => column.name),
    })
  } catch (error) {
    throw executionError(error, 'transport', 'mayHaveExecuted', `Execution of ${statement.name} failed.`)
  }

  try {
    const { min, max } = statement.rowBounds
    if (statement.resultKind === 'command' || statement.resultKind === 'void') {
      if (result.rows.length !== 0)
        throw new PgExecutionError('A command returned unexpected rows.', 'contract', 'mayHaveExecuted')
      try {
        return (
          statement.resultKind === 'command' ? typedSqlRowCount(result.rowCount) : undefined
        ) as TypedSqlExecutionResult<Row, Kind>
      } catch (error) {
        throw new PgExecutionError('Invalid command row count.', 'contract', 'mayHaveExecuted', error)
      }
    }
    if (result.rows.length < min || (max !== null && result.rows.length > max)) {
      throw new PgExecutionError(
        `Typed SQL statement ${statement.name} returned ${result.rows.length} rows; expected rowBounds [${min}, ${max ?? 'unbounded'}].`,
        'contract',
        'mayHaveExecuted'
      )
    }
    const rows = result.rows.map((row) => {
      if (row.length !== statement.columns.length)
        throw new PgExecutionError('Result row width does not match metadata.', 'contract', 'mayHaveExecuted')
      const mapped: Record<string, unknown> = {}
      for (const [index, column] of statement.columns.entries()) {
        const type = column.type
        const source = row[index]
        if (!type || (source !== null && typeof source !== 'string'))
          throw new PgExecutionError('Result field is not text or SQL NULL.', 'contract', 'mayHaveExecuted')
        if (source === null && !column.nullable)
          throw new PgExecutionError(
            `Column ${column.name} unexpectedly returned SQL NULL.`,
            'contract',
            'mayHaveExecuted'
          )
        Object.defineProperty(mapped, column.propertyName, {
          configurable: true,
          enumerable: true,
          writable: true,
          value: source === null ? null : decodePgValue(type, source, column.jsonPlan),
        })
      }
      return mapped as Row
    })
    return (statement.resultKind === 'many' ? rows : (rows[0] ?? null)) as TypedSqlExecutionResult<Row, Kind>
  } catch (error) {
    throw executionError(error, 'decode', 'mayHaveExecuted', `Could not decode result for ${statement.name}.`)
  }
}

export function createTypedSqlExecutor<
  Params extends TypedSqlParams,
  Row,
  Access extends TypedSqlAccessKind,
  Kind extends TypedSqlResultKind,
>(
  statement: TypedSqlStatement<Params, Row, Access, Kind>
): (executor: PostgresExecutor, ...args: TypedSqlParameterArgs<Params>) => Promise<TypedSqlExecutionResult<Row, Kind>> {
  return (executor, ...args) => executeTypedSql(executor, statement, (args[0] ?? {}) as Params)
}

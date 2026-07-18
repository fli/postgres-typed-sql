import type { PostgresTypeFact } from './postgres-types.js'

export interface TypedSqlPostgresIr {
  readonly analyzerSchemaVersion: number
  readonly command: string
  readonly hasDataModifyingCte: boolean
  readonly isWrite: boolean
  readonly name: string
  readonly params: readonly TypedSqlPostgresIrParam[]
  readonly postgresVersionNum: number
  readonly resultColumns: readonly TypedSqlPostgresIrColumn[]
  readonly rowBounds: TypedSqlPostgresIrRowBounds
  readonly rowCardinality: TypedSqlPostgresIrRowCardinality
  readonly sourceFile: string
}

export type TypedSqlPostgresIrRowCardinality = 'many' | 'none' | 'one' | 'optional'

export interface TypedSqlPostgresIrRowBounds {
  readonly max: number | null
  readonly min: number
  readonly proof: string
}

export interface TypedSqlPostgresIrParam extends PostgresTypeFact {
  readonly checkConstraintType?: TypedSqlPostgresIrCheckConstraintTypeExpression
  readonly name: string
  readonly nullAdmission: TypedSqlPostgresIrParamNullAdmission
  readonly nullable: boolean
  readonly propertyName: string
}

export type TypedSqlPostgresIrParamNullAdmission = 'accepts' | 'rejects' | 'unknown'

export interface TypedSqlPostgresIrColumn extends PostgresTypeFact {
  readonly checkConstraintType?: TypedSqlPostgresIrCheckConstraintTypeExpression
  readonly jsonShape?: TypedSqlPostgresIrJsonShape
  readonly name: string | null
  readonly nullable: boolean
  readonly source: TypedSqlPostgresIrColumnSource
}

export type TypedSqlPostgresIrCheckConstraintTypeExpression =
  | {
      readonly kind: 'literalUnion'
      readonly labels: readonly string[]
    }
  | {
      readonly kind: 'intersection' | 'union'
      readonly members: readonly TypedSqlPostgresIrCheckConstraintTypeExpression[]
    }

export type TypedSqlPostgresIrJsonShape =
  | {
      readonly kind: 'array'
      readonly element: TypedSqlPostgresIrJsonShape
      readonly nullable: boolean
    }
  | {
      readonly fields: readonly TypedSqlPostgresIrJsonField[]
      readonly kind: 'object'
      readonly nullable: boolean
    }
  | {
      readonly kind: 'opaque'
      readonly nullable: boolean
    }
  | {
      readonly alternatives: readonly TypedSqlPostgresIrJsonShape[]
      readonly kind: 'union'
      readonly nullable: boolean
    }
  | (PostgresTypeFact & {
      readonly kind: 'stringLiteral'
      readonly nullable: boolean
      readonly value: string
    })
  | (PostgresTypeFact & {
      readonly checkConstraintType?: TypedSqlPostgresIrCheckConstraintTypeExpression
      readonly kind: 'scalar'
      readonly nullable: boolean
    })

export interface TypedSqlPostgresIrJsonField {
  readonly name: string
  readonly shape: TypedSqlPostgresIrJsonShape
}

export type TypedSqlPostgresIrColumnSource =
  | {
      readonly attname?: string
      readonly kind: 'derivedVar' | 'tableColumn'
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

export interface TypedSqlPostgresIrCompiledConfig {
  readonly name: string
  readonly parameterNames: readonly string[]
  readonly parameterTypes?: readonly (string | undefined)[]
  readonly sourceFile: string
  readonly sql: string
}

export function checkConstraintTypeKey(type: TypedSqlPostgresIrCheckConstraintTypeExpression): string {
  return type.kind === 'literalUnion'
    ? `literalUnion:${JSON.stringify(type.labels.toSorted())}`
    : `${type.kind}(${type.members.map(checkConstraintTypeKey).toSorted().join(',')})`
}

export function jsonShapeWithNullability(
  shape: TypedSqlPostgresIrJsonShape,
  nullable: boolean
): TypedSqlPostgresIrJsonShape {
  return { ...shape, nullable }
}

export function flattenJsonShapeAlternatives(
  shape: TypedSqlPostgresIrJsonShape
): readonly TypedSqlPostgresIrJsonShape[] {
  return shape.kind === 'union' ? shape.alternatives.flatMap(flattenJsonShapeAlternatives) : [shape]
}

function jsonShapeKey(shape: TypedSqlPostgresIrJsonShape): string {
  switch (shape.kind) {
    case 'array':
      return JSON.stringify({ element: jsonShapeKey(shape.element), kind: shape.kind, nullable: shape.nullable })
    case 'object':
      return JSON.stringify({
        fields: shape.fields
          .map((field) => [field.name, jsonShapeKey(field.shape)] as const)
          .toSorted(([left], [right]) => left.localeCompare(right)),
        kind: shape.kind,
        nullable: shape.nullable,
      })
    case 'opaque':
      return JSON.stringify({ kind: shape.kind, nullable: shape.nullable })
    case 'scalar':
      return JSON.stringify({
        checkConstraintType: shape.checkConstraintType ? checkConstraintTypeKey(shape.checkConstraintType) : undefined,
        kind: shape.kind,
        nullable: shape.nullable,
        pgType: shape.pgType,
        pgTypeKind: shape.pgTypeKind,
        pgTypeOid: shape.pgTypeOid,
      })
    case 'stringLiteral':
      return JSON.stringify({
        kind: shape.kind,
        nullable: shape.nullable,
        pgType: shape.pgType,
        pgTypeKind: shape.pgTypeKind,
        pgTypeOid: shape.pgTypeOid,
        value: shape.value,
      })
    case 'union':
      return JSON.stringify({
        alternatives: shape.alternatives.map(jsonShapeKey).toSorted(),
        kind: shape.kind,
        nullable: shape.nullable,
      })
  }
}

function uniqueJsonShapes(shapes: readonly TypedSqlPostgresIrJsonShape[]): readonly TypedSqlPostgresIrJsonShape[] {
  const seen = new Set<string>()
  return shapes.filter((shape) => {
    const key = jsonShapeKey(shape)
    if (seen.has(key)) {
      return false
    }
    seen.add(key)
    return true
  })
}

/** A null candidate represents an arm whose only possible value is SQL NULL. */
export function joinJsonShapes(
  candidates: readonly (TypedSqlPostgresIrJsonShape | null)[],
  allNullFallback: TypedSqlPostgresIrJsonShape
): TypedSqlPostgresIrJsonShape {
  const nullable = candidates.length === 0 || candidates.some((candidate) => candidate === null || candidate.nullable)
  const alternatives = uniqueJsonShapes(
    candidates.flatMap((candidate) =>
      candidate ? flattenJsonShapeAlternatives(candidate).map((shape) => jsonShapeWithNullability(shape, false)) : []
    )
  )
  if (alternatives.some((shape) => shape.kind === 'opaque')) {
    return { kind: 'opaque', nullable }
  }

  const onlyAlternative = alternatives.length === 1 ? alternatives[0] : undefined
  if (onlyAlternative) {
    return jsonShapeWithNullability(onlyAlternative, nullable)
  }
  return alternatives.length === 0
    ? jsonShapeWithNullability(allNullFallback, nullable)
    : { alternatives, kind: 'union', nullable }
}

export function unionJsonShapes(
  left: TypedSqlPostgresIrJsonShape,
  right: TypedSqlPostgresIrJsonShape
): TypedSqlPostgresIrJsonShape {
  return joinJsonShapes([left, right], left)
}

export function intersectJsonShapes(
  left: TypedSqlPostgresIrJsonShape,
  right: TypedSqlPostgresIrJsonShape
): TypedSqlPostgresIrJsonShape {
  const nullable = left.nullable && right.nullable
  if (left.kind === 'opaque') {
    return jsonShapeWithNullability(right, nullable)
  }
  if (right.kind === 'opaque') {
    return jsonShapeWithNullability(left, nullable)
  }

  const alternatives = uniqueJsonShapes(
    [...flattenJsonShapeAlternatives(left), ...flattenJsonShapeAlternatives(right)].map((shape) =>
      jsonShapeWithNullability(shape, false)
    )
  )
  const onlyAlternative = alternatives.length === 1 ? alternatives[0] : undefined
  return onlyAlternative
    ? jsonShapeWithNullability(onlyAlternative, nullable)
    : { alternatives, kind: 'union', nullable }
}

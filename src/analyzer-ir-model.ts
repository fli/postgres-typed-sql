import type { PostgresTypeFact } from './postgres-types.js'

export interface TypedSqlPostgresIr {
  readonly accessEvidence: TypedSqlPostgresIrAccessEvidence
  readonly analyzerSchemaVersion: number
  readonly command: string
  readonly name: string
  readonly params: readonly TypedSqlPostgresIrParam[]
  readonly postgresVersionNum: number
  readonly resultColumns: readonly TypedSqlPostgresIrColumn[]
  readonly rowBounds: TypedSqlPostgresIrRowBounds
  readonly sourceFile: string
}

export type TypedSqlPostgresIrAccessConcern =
  | {
      readonly command: 'DELETE' | 'INSERT' | 'MERGE' | 'UPDATE'
      readonly kind: 'definiteDml'
    }
  | {
      readonly kind: 'dataModifyingCte'
    }
  | {
      readonly kind: 'rowLock'
    }
  | {
      readonly kind: 'volatileExecution'
    }
  | {
      readonly kind: 'procedureCall'
    }

export type TypedSqlPostgresIrAccessEvidence =
  | {
      readonly kind: 'provenReadOnly'
    }
  | {
      readonly kind: 'notProvenReadOnly'
      readonly reasons: readonly [TypedSqlPostgresIrAccessConcern, ...TypedSqlPostgresIrAccessConcern[]]
    }

export interface TypedSqlPostgresIrRowBounds {
  /** A finite upper bound proved by analysis, or null when no finite upper bound was proved. */
  readonly max: number | null
  readonly min: number
  readonly proof: string
}

export interface TypedSqlPostgresIrParam extends PostgresTypeFact {
  readonly checkConstraintType?: TypedSqlPostgresIrCheckConstraintTypeExpression
  readonly name: string
  readonly nullAdmission: TypedSqlPostgresIrParamNullAdmission
}

export type TypedSqlPostgresIrParamNullAdmission = 'accepts' | 'rejects' | 'unknown'

export interface TypedSqlPostgresIrColumn extends PostgresTypeFact {
  readonly checkConstraintType?: TypedSqlPostgresIrCheckConstraintTypeExpression
  readonly jsonShape?: TypedSqlPostgresIrJsonShape
  readonly name: string | null
  readonly nullability: TypedSqlPostgresIrResultNullability
  readonly source: TypedSqlPostgresIrColumnSource
}

export type TypedSqlPostgresIrResultNullability =
  | {
      readonly basis: string
      readonly kind: 'nonNull'
    }
  | {
      readonly evidence: string
      readonly kind: 'nullable'
    }
  | {
      readonly kind: 'unknown'
      readonly reason: string
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
      readonly nullability: TypedSqlPostgresIrResultNullability
    }
  | {
      readonly fields: readonly TypedSqlPostgresIrJsonField[]
      readonly kind: 'object'
      readonly nullability: TypedSqlPostgresIrResultNullability
    }
  | {
      readonly kind: 'opaque'
      readonly nullability: TypedSqlPostgresIrResultNullability
    }
  | {
      readonly alternatives: readonly TypedSqlPostgresIrJsonShape[]
      readonly kind: 'union'
      readonly nullability: TypedSqlPostgresIrResultNullability
    }
  | (PostgresTypeFact & {
      readonly kind: 'stringLiteral'
      readonly nullability: TypedSqlPostgresIrResultNullability
      readonly value: string
    })
  | (PostgresTypeFact & {
      readonly checkConstraintType?: TypedSqlPostgresIrCheckConstraintTypeExpression
      readonly kind: 'scalar'
      readonly nullability: TypedSqlPostgresIrResultNullability
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

export function resultNullabilityAllowsNull(nullability: TypedSqlPostgresIrResultNullability): boolean {
  return nullability.kind !== 'nonNull'
}

export function unionResultNullabilities(
  nullabilities: readonly TypedSqlPostgresIrResultNullability[],
  basis: string
): TypedSqlPostgresIrResultNullability {
  if (nullabilities.length === 0) {
    return { kind: 'unknown', reason: `${basis}:no_inputs` }
  }
  const nullable = nullabilities.find((candidate) => candidate.kind === 'nullable')
  if (nullable?.kind === 'nullable') {
    return { evidence: `${basis}:${nullable.evidence}`, kind: 'nullable' }
  }
  const unknown = nullabilities.find((candidate) => candidate.kind === 'unknown')
  if (unknown?.kind === 'unknown') {
    return { kind: 'unknown', reason: `${basis}:${unknown.reason}` }
  }
  return { basis, kind: 'nonNull' }
}

export function intersectResultNullabilities(
  left: TypedSqlPostgresIrResultNullability,
  right: TypedSqlPostgresIrResultNullability,
  basis: string
): TypedSqlPostgresIrResultNullability {
  if (left.kind === 'nonNull' || right.kind === 'nonNull') {
    return { basis, kind: 'nonNull' }
  }
  if (left.kind === 'nullable' && right.kind === 'nullable') {
    return { evidence: `${basis}:${left.evidence}+${right.evidence}`, kind: 'nullable' }
  }
  const reason = left.kind === 'unknown' ? left.reason : right.kind === 'unknown' ? right.reason : 'incomplete'
  return { kind: 'unknown', reason: `${basis}:${reason}` }
}

export function jsonShapeWithNullability(
  shape: TypedSqlPostgresIrJsonShape,
  nullability: TypedSqlPostgresIrResultNullability
): TypedSqlPostgresIrJsonShape {
  return { ...shape, nullability }
}

export function flattenJsonShapeAlternatives(
  shape: TypedSqlPostgresIrJsonShape
): readonly TypedSqlPostgresIrJsonShape[] {
  return shape.kind === 'union' ? shape.alternatives.flatMap(flattenJsonShapeAlternatives) : [shape]
}

function jsonShapeKey(shape: TypedSqlPostgresIrJsonShape): string {
  switch (shape.kind) {
    case 'array':
      return JSON.stringify({
        element: jsonShapeKey(shape.element),
        kind: shape.kind,
        nullability: shape.nullability.kind,
      })
    case 'object':
      return JSON.stringify({
        fields: shape.fields
          .map((field) => [field.name, jsonShapeKey(field.shape)] as const)
          .toSorted(([left], [right]) => left.localeCompare(right)),
        kind: shape.kind,
        nullability: shape.nullability.kind,
      })
    case 'opaque':
      return JSON.stringify({ kind: shape.kind, nullability: shape.nullability.kind })
    case 'scalar':
      return JSON.stringify({
        checkConstraintType: shape.checkConstraintType ? checkConstraintTypeKey(shape.checkConstraintType) : undefined,
        kind: shape.kind,
        nullability: shape.nullability.kind,
        pgType: shape.pgType,
        pgTypeKind: shape.pgTypeKind,
        pgTypeOid: shape.pgTypeOid,
      })
    case 'stringLiteral':
      return JSON.stringify({
        kind: shape.kind,
        nullability: shape.nullability.kind,
        pgType: shape.pgType,
        pgTypeKind: shape.pgTypeKind,
        pgTypeOid: shape.pgTypeOid,
        value: shape.value,
      })
    case 'union':
      return JSON.stringify({
        alternatives: shape.alternatives.map(jsonShapeKey).toSorted(),
        kind: shape.kind,
        nullability: shape.nullability.kind,
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
  const nullability = unionResultNullabilities(
    candidates.length === 0
      ? [{ kind: 'unknown', reason: 'no_json_candidates' }]
      : candidates.map((candidate) =>
          candidate ? candidate.nullability : { evidence: 'null_json_arm', kind: 'nullable' }
        ),
    'json_join'
  )
  const alternatives = uniqueJsonShapes(
    candidates.flatMap((candidate) =>
      candidate
        ? flattenJsonShapeAlternatives(candidate).map((shape) =>
            jsonShapeWithNullability(shape, { basis: 'json_alternative', kind: 'nonNull' })
          )
        : []
    )
  )
  if (alternatives.some((shape) => shape.kind === 'opaque')) {
    return { kind: 'opaque', nullability }
  }

  const onlyAlternative = alternatives.length === 1 ? alternatives[0] : undefined
  if (onlyAlternative) {
    return jsonShapeWithNullability(onlyAlternative, nullability)
  }
  return alternatives.length === 0
    ? jsonShapeWithNullability(allNullFallback, nullability)
    : { alternatives, kind: 'union', nullability }
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
  const nullability = intersectResultNullabilities(left.nullability, right.nullability, 'json_intersection')
  if (left.kind === 'opaque') {
    return jsonShapeWithNullability(right, nullability)
  }
  if (right.kind === 'opaque') {
    return jsonShapeWithNullability(left, nullability)
  }

  const alternatives = uniqueJsonShapes(
    [...flattenJsonShapeAlternatives(left), ...flattenJsonShapeAlternatives(right)].map((shape) =>
      jsonShapeWithNullability(shape, { basis: 'json_alternative', kind: 'nonNull' })
    )
  )
  const onlyAlternative = alternatives.length === 1 ? alternatives[0] : undefined
  return onlyAlternative
    ? jsonShapeWithNullability(onlyAlternative, nullability)
    : { alternatives, kind: 'union', nullability }
}

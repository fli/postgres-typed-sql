import { resultNullabilityAllowsNull, type TypedSqlPostgresIrJsonShape } from './analyzer-ir-model.js'
import { isJsonPlanSupported } from './json-values.js'
import { basePostgresType, resolveTypeScriptJsonScalarTypeForPostgresType } from './postgres-codecs.js'
import { postgresTypeFact, type PostgresTypeFact } from './postgres-types.js'
import { camelCasePropertyName } from './typescript-names.js'
import type { PostgresTypedSqlPropertyNaming } from './config.js'
import type { PgJsonPlan } from './value-types.js'

function embeddedPlanForShape(shape: TypedSqlPostgresIrJsonShape, naming: PostgresTypedSqlPropertyNaming): PgJsonPlan {
  switch (shape.kind) {
    case 'opaque':
      return { kind: 'generic' }
    case 'null':
    case 'sqlNull':
      return { kind: 'null' }
    case 'stringLiteral':
      return { kind: 'literal', value: shape.value, nullable: resultNullabilityAllowsNull(shape.nullability) }
    case 'jsonScalar':
      return typeof shape.value === 'number'
        ? { kind: 'number', nullable: resultNullabilityAllowsNull(shape.nullability) }
        : { kind: 'literal', value: shape.value, nullable: resultNullabilityAllowsNull(shape.nullability) }
    case 'jsonNumber':
      return { kind: 'number', nullable: resultNullabilityAllowsNull(shape.nullability) }
    case 'array':
      return {
        kind: 'array',
        element: embeddedPlanForShape(shape.element, naming),
        nullable: resultNullabilityAllowsNull(shape.nullability),
      }
    case 'object':
      return {
        kind: 'object',
        nullable: resultNullabilityAllowsNull(shape.nullability),
        fields: shape.fields.map((field) => ({
          name: field.name,
          propertyName: naming === 'camelCase' ? camelCasePropertyName(field.name) : field.name,
          plan: embeddedPlanForShape(field.shape, naming),
        })),
      }
    case 'union':
      return {
        kind: 'union',
        alternatives: shape.alternatives.map((alternative) => embeddedPlanForShape(alternative, naming)),
      }
    case 'scalar': {
      const type = basePostgresType(shape)
      const resolved = resolveTypeScriptJsonScalarTypeForPostgresType(type)
      if (resolved.type === 'PgJsonValue') return { kind: 'generic' }
      if (resolved.type === 'string')
        return { kind: 'string', nullable: resultNullabilityAllowsNull(shape.nullability) }
      return { kind: 'scalar', type: postgresTypeFact(shape), nullable: resultNullabilityAllowsNull(shape.nullability) }
    }
  }
}

function withoutSqlNullability(plan: PgJsonPlan): PgJsonPlan {
  if (plan.kind === 'union') return { ...plan, alternatives: plan.alternatives.map(withoutSqlNullability) }
  return 'nullable' in plan ? { ...plan, nullable: false } : plan
}

export function jsonPlanForShape(
  shape: TypedSqlPostgresIrJsonShape,
  naming: PostgresTypedSqlPropertyNaming
): PgJsonPlan {
  // A SQL-null root is handled by the row decoder, outside the JSON document.
  return withoutSqlNullability(embeddedPlanForShape(shape, naming))
}

const jsonStringType: PostgresTypeFact = {
  pgType: 'text',
  pgTypeKind: 'base',
  pgTypeName: 'text',
  pgTypeOid: 25,
  pgTypeSchema: 'pg_catalog',
}

/** Merge only interpretations that SQL's JSON representation cannot distinguish. */
export function safeJsonCodecShape(
  shape: TypedSqlPostgresIrJsonShape,
  naming: PostgresTypedSqlPropertyNaming
): TypedSqlPostgresIrJsonShape {
  if (shape.kind === 'object')
    return {
      ...shape,
      fields: shape.fields.map((field) => ({ ...field, shape: safeJsonCodecShape(field.shape, naming) })),
    }
  if (shape.kind === 'array') return { ...shape, element: safeJsonCodecShape(shape.element, naming) }
  if (shape.kind !== 'union') return shape
  const safeAlternatives = shape.alternatives.map((alternative) => safeJsonCodecShape(alternative, naming))
  const nullability =
    resultNullabilityAllowsNull(shape.nullability) ||
    safeAlternatives.some((alternative) => resultNullabilityAllowsNull(alternative.nullability))
      ? { kind: 'nullable' as const, evidence: 'json_codec_alternatives' }
      : shape.nullability
  const alternatives = [
    ...new Map(
      safeAlternatives.map((safe) => {
        return [JSON.stringify(jsonPlanForShape(safe, naming)), safe] as const
      })
    ).values(),
  ]
  if (alternatives.length === 1 && alternatives[0]) return { ...alternatives[0], nullability }
  const union = { ...shape, alternatives, nullability }
  if (isJsonPlanSupported(jsonPlanForShape(union, naming))) return union
  if (
    alternatives.every((alternative) => {
      if (alternative.kind === 'stringLiteral') return true
      return (
        alternative.kind === 'scalar' &&
        !['PgJsonValue', 'boolean', 'number', 'bigint', 'PgDecimal'].includes(
          resolveTypeScriptJsonScalarTypeForPostgresType(alternative).type
        )
      )
    })
  )
    return { ...jsonStringType, kind: 'scalar', nullability }
  const first = alternatives[0]
  if (
    first?.kind === 'object' &&
    alternatives.every(
      (alternative) =>
        alternative.kind === 'object' &&
        alternative.fields.length === first.fields.length &&
        first.fields.every((field) => alternative.fields.some((candidate) => candidate.name === field.name))
    )
  ) {
    return {
      ...first,
      nullability,
      fields: first.fields.map((field) => ({
        name: field.name,
        shape: safeJsonCodecShape(
          {
            kind: 'union',
            nullability: field.shape.nullability,
            alternatives: alternatives.flatMap((alternative) =>
              alternative.kind === 'object'
                ? alternative.fields
                    .filter((candidate) => candidate.name === field.name)
                    .map((candidate) => candidate.shape)
                : []
            ),
          },
          naming
        ),
      })),
    }
  }
  if (alternatives.every((alternative) => alternative.kind === 'array')) {
    return {
      kind: 'array',
      nullability,
      element: safeJsonCodecShape(
        {
          kind: 'union',
          nullability,
          alternatives: alternatives.flatMap((alternative) =>
            alternative.kind === 'array' ? [alternative.element] : []
          ),
        },
        naming
      ),
    }
  }
  return { kind: 'opaque', nullability }
}

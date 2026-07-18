import {
  normalizePostgresTypeName,
  postgresJsonSupportsTextualLiteralRefinement,
  postgresJsonValueMayBeStructured,
  postgresTypeSupportsTextualLiteralRefinement,
  type PostgresTypeFact,
} from './postgres-types.js'
import { assertTypeScriptBindingIdentifier } from './typescript-names.js'

export interface PostgresTypeScriptResolution {
  readonly ambientBindings: readonly string[]
  readonly scalarImports: readonly string[]
  readonly type: string
}

export type BuiltInPostgresCodecProfile = 'conservative' | 'node-postgres'
export type PostgresCodecTypePosition = 'json' | 'parameter' | 'result'

export interface PostgresResultTypeContext {
  /** PostgreSQL type inferred for the SQL expression before protocol-level domain flattening. */
  readonly declaredType: PostgresTypeFact
  /** Type OID presented to a text result decoder. Scalar domains recursively expose their base type. */
  readonly decoderType: PostgresTypeFact
}

export interface PostgresParameterTypeContext {
  readonly type: PostgresTypeFact
}

export interface PostgresJsonScalarTypeContext {
  readonly type: PostgresTypeFact
}

export interface PostgresStringLiteralRefinementContext {
  readonly position: PostgresCodecTypePosition
  readonly type: PostgresTypeFact
}

export type PostgresTypeScriptResolutionFallback = () => PostgresTypeScriptResolution
export type PostgresBooleanFallback = () => boolean

export interface PostgresCodecProfileDefinition {
  /** Profile inherited by every behavior not overridden here. */
  readonly extends: PostgresCodecProfile
  /** Stable diagnostic name written into generated artifacts. */
  readonly name: string
  /** Type used when static JSON analysis reaches an opaque object, array, or scalar boundary. */
  readonly opaqueJsonType?: PostgresTypeScriptResolution
  /** Whether json/jsonb results decode into traversable JavaScript objects and arrays. */
  readonly structuredJson?: boolean
  readonly resultType?: (
    context: PostgresResultTypeContext,
    fallback: PostgresTypeScriptResolutionFallback
  ) => PostgresTypeScriptResolution
  /** Resolves top-level parameters and each array element before built-in domain fallback. */
  readonly parameterType?: (
    context: PostgresParameterTypeContext,
    fallback: PostgresTypeScriptResolutionFallback
  ) => PostgresTypeScriptResolution
  readonly jsonScalarType?: (
    context: PostgresJsonScalarTypeContext,
    fallback: PostgresTypeScriptResolutionFallback
  ) => PostgresTypeScriptResolution
  readonly supportsStringLiteralRefinement?: (
    context: PostgresStringLiteralRefinementContext,
    fallback: PostgresBooleanFallback
  ) => boolean
}

export type PostgresCodecProfile = BuiltInPostgresCodecProfile | PostgresCodecProfileDefinition

export interface ResolvedPostgresCodecProfile {
  readonly name: string
  readonly opaqueJsonType: PostgresTypeScriptResolution
  readonly structuredJson: boolean
  resolveJsonScalarType(type: PostgresTypeFact): PostgresTypeScriptResolution
  resolveParameterType(type: PostgresTypeFact): PostgresTypeScriptResolution
  resolveResultType(type: PostgresTypeFact): PostgresTypeScriptResolution
  supportsStringLiteralRefinement(position: PostgresCodecTypePosition, type: PostgresTypeFact): boolean
}

const resolvedProfileCache = new WeakMap<object, ResolvedPostgresCodecProfile>()

type ResolvedProfileHooks = Pick<
  PostgresCodecProfileDefinition,
  'jsonScalarType' | 'parameterType' | 'resultType' | 'supportsStringLiteralRefinement'
>

interface ResolvedProfileNode {
  readonly builtIn?: BuiltInPostgresCodecProfile
  readonly hooks?: ResolvedProfileHooks
  readonly base?: ResolvedProfileNode
  readonly name: string
  readonly opaqueJsonType: PostgresTypeScriptResolution
  readonly structuredJson: boolean
}

const emptyBindings: readonly string[] = []

export function postgresTypeScriptType(
  type: string,
  options: {
    readonly ambientBindings?: readonly string[]
    readonly scalarImports?: readonly string[]
  } = {}
): PostgresTypeScriptResolution {
  return {
    ambientBindings: options.ambientBindings ?? emptyBindings,
    scalarImports: options.scalarImports ?? emptyBindings,
    type,
  }
}

export function definePostgresCodecProfile(definition: PostgresCodecProfileDefinition): PostgresCodecProfileDefinition {
  return definition
}

export function postgresResultTypesByOid(
  entries: ReadonlyMap<number, PostgresTypeScriptResolution> | Readonly<Record<number, PostgresTypeScriptResolution>>
): NonNullable<PostgresCodecProfileDefinition['resultType']> {
  const resolutions =
    typeof (entries as ReadonlyMap<number, PostgresTypeScriptResolution>).entries === 'function'
      ? new Map((entries as ReadonlyMap<number, PostgresTypeScriptResolution>).entries())
      : new Map(Object.entries(entries).map(([oid, value]) => [Number(oid), value] as const))

  for (const oid of resolutions.keys()) {
    if (!Number.isSafeInteger(oid) || oid <= 0) {
      throw new Error(`PostgreSQL result type override OID ${JSON.stringify(oid)} must be a positive safe integer.`)
    }
  }

  return ({ decoderType }, fallback) => resolutions.get(decoderType.pgTypeOid) ?? fallback()
}

const scalarImportNames = new Set([
  'DbJsonParameter',
  'DbJsonSelected',
  'PgArrayParameter',
  'PgByteaHexString',
  'PgCircle',
  'PgInt8String',
  'PgInterval',
  'PgNumericString',
  'PgPoint',
  'PgTimeString',
  'PgTimetzString',
  'PgUuidString',
])

function builtInType(type: string): PostgresTypeScriptResolution {
  return postgresTypeScriptType(type, {
    scalarImports: scalarImportNames.has(type) ? [type] : emptyBindings,
  })
}

const unknownResolution = builtInType('unknown')
const unknownParameterResolution = postgresTypeScriptType('NonNullable<unknown>', {
  ambientBindings: ['NonNullable'],
})
const stringResolution = builtInType('string')
const opaqueJsonResolution = builtInType('DbJsonSelected')

function uniqueBindings(bindings: readonly string[]): readonly string[] {
  return [...new Set(bindings)]
}

function pgResultArrayResolution(element: PostgresTypeScriptResolution): PostgresTypeScriptResolution {
  return postgresTypeScriptType(`PgArray<${element.type}>`, {
    ambientBindings: element.ambientBindings,
    scalarImports: uniqueBindings(['PgArray', ...element.scalarImports]),
  })
}

function pgParameterArrayResolution(element: PostgresTypeScriptResolution): PostgresTypeScriptResolution {
  return postgresTypeScriptType(`PgArrayParameter<${element.type}> | string`, {
    ambientBindings: element.ambientBindings,
    scalarImports: uniqueBindings(['PgArrayParameter', ...element.scalarImports]),
  })
}

const byteaResolution = postgresTypeScriptType('Uint8Array', { ambientBindings: ['Uint8Array'] })
const byteaParameterResolution = postgresTypeScriptType('PgByteaHexString | Uint8Array', {
  ambientBindings: ['Uint8Array'],
  scalarImports: ['PgByteaHexString'],
})
const dateResultResolution = postgresTypeScriptType('Date | number', { ambientBindings: ['Date'] })
const dateParameterResolution = postgresTypeScriptType('Date | number | string', { ambientBindings: ['Date'] })
const intervalParameterResolution = postgresTypeScriptType('PgInterval | string', {
  scalarImports: ['PgInterval'],
})

/** Default pg-types 2.2.0 text decoders used by supported node-postgres 8.x releases. */
const nodePostgresTextResolutionByOid = new Map<number, PostgresTypeScriptResolution>([
  [16, builtInType('boolean')],
  [17, byteaResolution],
  [20, builtInType('PgInt8String')],
  [21, builtInType('number')],
  [23, builtInType('number')],
  [26, builtInType('number')],
  [114, opaqueJsonResolution],
  [199, pgResultArrayResolution(opaqueJsonResolution)],
  [600, builtInType('PgPoint')],
  [651, pgResultArrayResolution(stringResolution)],
  [700, builtInType('number')],
  [701, builtInType('number')],
  [718, builtInType('PgCircle')],
  [791, pgResultArrayResolution(stringResolution)],
  [1000, pgResultArrayResolution(builtInType('boolean'))],
  [1001, pgResultArrayResolution(byteaResolution)],
  [1005, pgResultArrayResolution(builtInType('number'))],
  [1007, pgResultArrayResolution(builtInType('number'))],
  [1008, pgResultArrayResolution(stringResolution)],
  [1009, pgResultArrayResolution(stringResolution)],
  [1014, pgResultArrayResolution(stringResolution)],
  [1015, pgResultArrayResolution(stringResolution)],
  [1016, pgResultArrayResolution(builtInType('PgInt8String'))],
  [1017, pgResultArrayResolution(builtInType('PgPoint'))],
  [1021, pgResultArrayResolution(builtInType('number'))],
  [1022, pgResultArrayResolution(builtInType('number'))],
  [1028, pgResultArrayResolution(builtInType('number'))],
  [1040, pgResultArrayResolution(stringResolution)],
  [1041, pgResultArrayResolution(stringResolution)],
  [1082, dateResultResolution],
  [1083, builtInType('PgTimeString')],
  [1114, dateResultResolution],
  [1115, pgResultArrayResolution(dateResultResolution)],
  [1182, pgResultArrayResolution(dateResultResolution)],
  [1183, pgResultArrayResolution(builtInType('PgTimeString'))],
  [1184, dateResultResolution],
  [1185, pgResultArrayResolution(dateResultResolution)],
  [1186, builtInType('PgInterval')],
  [1187, pgResultArrayResolution(builtInType('PgInterval'))],
  [1231, pgResultArrayResolution(builtInType('number'))],
  [1266, builtInType('PgTimetzString')],
  [1270, pgResultArrayResolution(builtInType('PgTimetzString'))],
  [1700, builtInType('PgNumericString')],
  [2950, builtInType('PgUuidString')],
  [2951, pgResultArrayResolution(builtInType('PgUuidString'))],
  [3802, opaqueJsonResolution],
  [3807, pgResultArrayResolution(opaqueJsonResolution)],
  [3907, pgResultArrayResolution(stringResolution)],
])

function enumTypeResolution(type: PostgresTypeFact): PostgresTypeScriptResolution {
  return type.pgEnumLabels && type.pgEnumLabels.length > 0
    ? builtInType(type.pgEnumLabels.map((label) => JSON.stringify(label)).join(' | '))
    : stringResolution
}

function resultDecoderType(type: PostgresTypeFact): PostgresTypeFact {
  return type.pgTypeKind === 'domain' && type.pgBaseType ? resultDecoderType(type.pgBaseType) : type
}

function resolveNodePostgresResultType(
  type: PostgresTypeFact,
  recurse: (type: PostgresTypeFact) => PostgresTypeScriptResolution
): PostgresTypeScriptResolution {
  if (type.pgTypeKind === 'domain') {
    return type.pgBaseType ? recurse(type.pgBaseType) : unknownResolution
  }
  if (type.pgTypeKind === 'enum') {
    return enumTypeResolution(type)
  }
  if (type.pgTypeOid === 0) {
    return unknownResolution
  }
  return nodePostgresTextResolutionByOid.get(type.pgTypeOid) ?? stringResolution
}

const numericParameterTypes = new Set(['bigint', 'double precision', 'integer', 'numeric', 'oid', 'real', 'smallint'])
const dateParameterTypes = new Set(['date', 'timestamp without time zone', 'timestamp with time zone', 'timestamptz'])

function resolveNodePostgresParameterType(
  type: PostgresTypeFact,
  recurse: (type: PostgresTypeFact) => PostgresTypeScriptResolution,
  resolveArrayElement: (type: PostgresTypeFact) => PostgresTypeScriptResolution
): PostgresTypeScriptResolution {
  if (type.pgTypeKind === 'domain') {
    return type.pgBaseType ? recurse(type.pgBaseType) : unknownParameterResolution
  }
  if (type.pgTypeKind === 'array') {
    if (type.pgArrayDelimiter !== ',') {
      return stringResolution
    }
    return type.pgArrayElementType
      ? pgParameterArrayResolution(resolveArrayElement(type.pgArrayElementType))
      : unknownParameterResolution
  }
  if (type.pgTypeKind === 'enum') {
    return enumTypeResolution(type)
  }

  const normalizedType = normalizePostgresTypeName(type.pgTypeName)
  if (type.pgTypeSchema === 'pg_catalog' && (normalizedType === 'json' || normalizedType === 'jsonb')) {
    return builtInType('DbJsonParameter')
  }
  if (type.pgTypeSchema === 'pg_catalog' && numericParameterTypes.has(normalizedType)) {
    return builtInType('bigint | number | string')
  }
  if (type.pgTypeSchema === 'pg_catalog' && dateParameterTypes.has(normalizedType)) {
    return dateParameterResolution
  }
  if (type.pgTypeSchema === 'pg_catalog' && normalizedType === 'interval') {
    return intervalParameterResolution
  }
  if (type.pgTypeSchema === 'pg_catalog' && normalizedType === 'bytea') {
    return byteaParameterResolution
  }
  if (type.pgTypeSchema === 'pg_catalog' && normalizedType === 'boolean') {
    return builtInType('boolean')
  }
  return stringResolution
}

const jsonNumberTypes = new Set(['bigint', 'integer', 'smallint'])
const jsonNumberOrSpecialStringTypes = new Set(['double precision', 'numeric', 'real'])

function resolveNodePostgresJsonScalarType(
  type: PostgresTypeFact,
  recurse: (type: PostgresTypeFact) => PostgresTypeScriptResolution
): PostgresTypeScriptResolution {
  if (type.pgTypeKind === 'domain') {
    return type.pgBaseType ? recurse(type.pgBaseType) : opaqueJsonResolution
  }
  if (postgresJsonValueMayBeStructured(type)) {
    return opaqueJsonResolution
  }
  if (type.pgTypeKind === 'enum') {
    return enumTypeResolution(type)
  }

  const normalizedType = normalizePostgresTypeName(type.pgTypeName)
  if (type.pgTypeSchema === 'pg_catalog' && normalizedType === 'boolean') {
    return builtInType('boolean')
  }
  if (type.pgTypeSchema === 'pg_catalog' && jsonNumberTypes.has(normalizedType)) {
    return builtInType('number')
  }
  if (type.pgTypeSchema === 'pg_catalog' && jsonNumberOrSpecialStringTypes.has(normalizedType)) {
    return builtInType('number | string')
  }
  return stringResolution
}

function supportsNodePostgresStringLiteralRefinement(
  position: PostgresCodecTypePosition,
  type: PostgresTypeFact,
  recurse: (type: PostgresTypeFact) => boolean
): boolean {
  if (type.pgTypeKind === 'domain' && type.pgBaseType) {
    return recurse(type.pgBaseType)
  }
  if (position === 'json') {
    return postgresJsonSupportsTextualLiteralRefinement(type)
  }
  return postgresTypeSupportsTextualLiteralRefinement(type)
}

function validateResolution(value: unknown, profileName: string, position: string): PostgresTypeScriptResolution {
  if (!value || typeof value !== 'object') {
    throw new Error(`PostgreSQL codec profile ${JSON.stringify(profileName)} returned an invalid ${position} type.`)
  }
  const candidate = value as {
    readonly ambientBindings?: unknown
    readonly scalarImports?: unknown
    readonly type?: unknown
  }
  if (typeof candidate.type !== 'string' || candidate.type.trim().length === 0) {
    throw new Error(`PostgreSQL codec profile ${JSON.stringify(profileName)} returned an invalid ${position} type.`)
  }
  if (!Array.isArray(candidate.ambientBindings) || !Array.isArray(candidate.scalarImports)) {
    throw new Error(
      `PostgreSQL codec profile ${JSON.stringify(profileName)} must return ambientBindings and scalarImports arrays for ${position}.`
    )
  }
  const ambientBindings = candidate.ambientBindings.map((binding: unknown) => {
    assertTypeScriptBindingIdentifier(
      binding,
      `PostgreSQL codec profile ${JSON.stringify(profileName)} ambient binding`
    )
    return binding
  })
  const scalarImports = candidate.scalarImports.map((binding: unknown) => {
    assertTypeScriptBindingIdentifier(binding, `PostgreSQL codec profile ${JSON.stringify(profileName)} scalar import`)
    return binding
  })
  return {
    ambientBindings: uniqueBindings(ambientBindings),
    scalarImports: uniqueBindings(scalarImports),
    type: candidate.type,
  }
}

function validateProfileName(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value !== value.trim() ||
    /[\r\n\u2028\u2029]/u.test(value)
  ) {
    throw new Error(
      'Custom PostgreSQL codec profile name must be a non-empty, single-line string without surrounding whitespace.'
    )
  }
  return value
}

function builtInNode(profile: BuiltInPostgresCodecProfile): ResolvedProfileNode {
  return {
    builtIn: profile,
    name: profile,
    opaqueJsonType: profile === 'node-postgres' ? opaqueJsonResolution : unknownResolution,
    structuredJson: profile === 'node-postgres',
  }
}

function resolveProfileNode(
  profile: PostgresCodecProfile,
  seen: Set<PostgresCodecProfileDefinition>
): ResolvedProfileNode {
  if (typeof profile === 'string') {
    if (profile !== 'conservative' && profile !== 'node-postgres') {
      throw new Error(`Unsupported PostgreSQL codec profile ${JSON.stringify(profile)}.`)
    }
    return builtInNode(profile)
  }
  if (!profile || typeof profile !== 'object') {
    throw new Error('PostgreSQL codec profile must be a built-in name or a profile definition.')
  }
  const name = validateProfileName(profile.name)
  if (seen.has(profile)) {
    throw new Error(`PostgreSQL codec profile ${JSON.stringify(name)} has a cyclic extends chain.`)
  }
  const baseProfile = profile.extends
  if (baseProfile === undefined) {
    throw new Error(`PostgreSQL codec profile ${JSON.stringify(name)} must declare extends.`)
  }
  const jsonScalarType = profile.jsonScalarType
  const parameterType = profile.parameterType
  const resultType = profile.resultType
  const supportsStringLiteralRefinement = profile.supportsStringLiteralRefinement
  for (const [hookName, hook] of [
    ['jsonScalarType', jsonScalarType],
    ['parameterType', parameterType],
    ['resultType', resultType],
    ['supportsStringLiteralRefinement', supportsStringLiteralRefinement],
  ] as const) {
    if (hook !== undefined && typeof hook !== 'function') {
      throw new Error(`PostgreSQL codec profile ${JSON.stringify(name)} ${hookName} must be a function.`)
    }
  }
  const structuredJson = profile.structuredJson
  if (structuredJson !== undefined && typeof structuredJson !== 'boolean') {
    throw new Error(`PostgreSQL codec profile ${JSON.stringify(name)} structuredJson must be boolean.`)
  }
  const opaqueJsonType = profile.opaqueJsonType

  seen.add(profile)
  const base = resolveProfileNode(baseProfile, seen)
  seen.delete(profile)
  const hooks: ResolvedProfileHooks = {
    ...(jsonScalarType ? { jsonScalarType: jsonScalarType.bind(profile) } : {}),
    ...(parameterType ? { parameterType: parameterType.bind(profile) } : {}),
    ...(resultType ? { resultType: resultType.bind(profile) } : {}),
    ...(supportsStringLiteralRefinement
      ? { supportsStringLiteralRefinement: supportsStringLiteralRefinement.bind(profile) }
      : {}),
  }
  return {
    base,
    hooks,
    name,
    opaqueJsonType: opaqueJsonType ? validateResolution(opaqueJsonType, name, 'opaque JSON') : base.opaqueJsonType,
    structuredJson: structuredJson ?? base.structuredJson,
  }
}

function resolveResultAt(
  node: ResolvedProfileNode,
  type: PostgresTypeFact,
  root: ResolvedProfileNode
): PostgresTypeScriptResolution {
  if (node.hooks?.resultType) {
    return validateResolution(
      node.hooks.resultType({ declaredType: type, decoderType: resultDecoderType(type) }, () =>
        resolveResultAt(node.base as ResolvedProfileNode, type, root)
      ),
      node.name,
      'result'
    )
  }
  if (node.builtIn === 'conservative') {
    return unknownResolution
  }
  if (node.builtIn === 'node-postgres') {
    return resolveNodePostgresResultType(type, (nested) => resolveResultAt(root, nested, root))
  }
  return resolveResultAt(node.base as ResolvedProfileNode, type, root)
}

function resolveParameterAt(
  node: ResolvedProfileNode,
  type: PostgresTypeFact,
  root: ResolvedProfileNode
): PostgresTypeScriptResolution {
  if (node.hooks?.parameterType) {
    return validateResolution(
      node.hooks.parameterType({ type }, () => resolveParameterAt(node.base as ResolvedProfileNode, type, root)),
      node.name,
      'parameter'
    )
  }
  if (node.builtIn === 'conservative') {
    return unknownParameterResolution
  }
  if (node.builtIn === 'node-postgres') {
    return resolveNodePostgresParameterType(
      type,
      (nested) => resolveParameterAt(root, nested, root),
      (element) => resolveParameterArrayElementAt(root, element, root)
    )
  }
  return resolveParameterAt(node.base as ResolvedProfileNode, type, root)
}

function resolveParameterArrayElementAt(
  node: ResolvedProfileNode,
  type: PostgresTypeFact,
  root: ResolvedProfileNode
): PostgresTypeScriptResolution {
  if (node.hooks?.parameterType) {
    return validateResolution(
      node.hooks.parameterType({ type }, () =>
        resolveParameterArrayElementAt(node.base as ResolvedProfileNode, type, root)
      ),
      node.name,
      'array element parameter'
    )
  }
  if (node.builtIn === 'conservative') {
    return unknownParameterResolution
  }
  if (node.builtIn === 'node-postgres') {
    if (type.pgTypeSchema === 'pg_catalog' && type.pgTypeName === 'bytea') {
      return builtInType('PgByteaHexString')
    }
    if (type.pgTypeKind === 'domain') {
      if (!type.pgBaseType) {
        return unknownParameterResolution
      }
      return type.pgBaseType.pgTypeKind === 'array'
        ? stringResolution
        : resolveParameterArrayElementAt(root, type.pgBaseType, root)
    }
    return resolveNodePostgresParameterType(
      type,
      (nested) => resolveParameterAt(root, nested, root),
      (element) => resolveParameterArrayElementAt(root, element, root)
    )
  }
  return resolveParameterArrayElementAt(node.base as ResolvedProfileNode, type, root)
}

function resolveJsonAt(
  node: ResolvedProfileNode,
  type: PostgresTypeFact,
  root: ResolvedProfileNode
): PostgresTypeScriptResolution {
  if (node.hooks?.jsonScalarType) {
    return validateResolution(
      node.hooks.jsonScalarType({ type }, () => resolveJsonAt(node.base as ResolvedProfileNode, type, root)),
      node.name,
      'JSON scalar'
    )
  }
  if (node.builtIn === 'conservative') {
    return unknownResolution
  }
  if (node.builtIn === 'node-postgres') {
    return resolveNodePostgresJsonScalarType(type, (nested) => resolveJsonAt(root, nested, root))
  }
  return resolveJsonAt(node.base as ResolvedProfileNode, type, root)
}

function supportsLiteralAt(
  node: ResolvedProfileNode,
  position: PostgresCodecTypePosition,
  type: PostgresTypeFact,
  root: ResolvedProfileNode
): boolean {
  if (node.hooks?.supportsStringLiteralRefinement) {
    const supported = node.hooks.supportsStringLiteralRefinement({ position, type }, () =>
      supportsLiteralAt(node.base as ResolvedProfileNode, position, type, root)
    )
    if (typeof supported !== 'boolean') {
      throw new Error(
        `PostgreSQL codec profile ${JSON.stringify(node.name)} returned a non-boolean string-literal refinement capability.`
      )
    }
    return supported
  }
  if (node.builtIn === 'conservative') {
    return false
  }
  if (node.builtIn === 'node-postgres') {
    return supportsNodePostgresStringLiteralRefinement(position, type, (nested) =>
      supportsLiteralAt(root, position, nested, root)
    )
  }
  return supportsLiteralAt(node.base as ResolvedProfileNode, position, type, root)
}

function hasResolvedProfileShape(profile: unknown): profile is ResolvedPostgresCodecProfile {
  return (
    typeof profile === 'object' &&
    profile !== null &&
    typeof (profile as Partial<ResolvedPostgresCodecProfile>).name === 'string' &&
    typeof (profile as Partial<ResolvedPostgresCodecProfile>).structuredJson === 'boolean' &&
    typeof (profile as Partial<ResolvedPostgresCodecProfile>).resolveJsonScalarType === 'function' &&
    typeof (profile as Partial<ResolvedPostgresCodecProfile>).resolveParameterType === 'function' &&
    typeof (profile as Partial<ResolvedPostgresCodecProfile>).resolveResultType === 'function' &&
    typeof (profile as Partial<ResolvedPostgresCodecProfile>).supportsStringLiteralRefinement === 'function'
  )
}

function normalizeExternalResolvedProfile(profile: ResolvedPostgresCodecProfile): ResolvedPostgresCodecProfile {
  const name = validateProfileName(profile.name)
  const opaqueJsonType = validateResolution(profile.opaqueJsonType, name, 'opaque JSON')
  const resolveJsonScalarType = profile.resolveJsonScalarType.bind(profile)
  const resolveParameterType = profile.resolveParameterType.bind(profile)
  const resolveResultType = profile.resolveResultType.bind(profile)
  const supportsStringLiteralRefinement = profile.supportsStringLiteralRefinement.bind(profile)
  const resolved: ResolvedPostgresCodecProfile = {
    name,
    opaqueJsonType,
    structuredJson: profile.structuredJson,
    resolveJsonScalarType: (type) => validateResolution(resolveJsonScalarType(type), name, 'JSON scalar'),
    resolveParameterType: (type) => validateResolution(resolveParameterType(type), name, 'parameter'),
    resolveResultType: (type) => validateResolution(resolveResultType(type), name, 'result'),
    supportsStringLiteralRefinement: (position, type) => {
      const supported = supportsStringLiteralRefinement(position, type)
      if (typeof supported !== 'boolean') {
        throw new Error(
          `PostgreSQL codec profile ${JSON.stringify(name)} returned a non-boolean string-literal refinement capability.`
        )
      }
      return supported
    },
  }
  resolvedProfileCache.set(profile, resolved)
  resolvedProfileCache.set(resolved, resolved)
  return resolved
}

export function resolvePostgresCodecProfile(
  profile: PostgresCodecProfile | ResolvedPostgresCodecProfile
): ResolvedPostgresCodecProfile {
  if (typeof profile === 'object' && profile !== null) {
    const cached = resolvedProfileCache.get(profile)
    if (cached) {
      return cached
    }
    if (hasResolvedProfileShape(profile)) {
      return normalizeExternalResolvedProfile(profile)
    }
  }
  const root = resolveProfileNode(profile as PostgresCodecProfile, new Set())
  const resolved: ResolvedPostgresCodecProfile = {
    name: root.name,
    opaqueJsonType: root.opaqueJsonType,
    structuredJson: root.structuredJson,
    resolveJsonScalarType: (type) => resolveJsonAt(root, type, root),
    resolveParameterType: (type) => resolveParameterAt(root, type, root),
    resolveResultType: (type) => resolveResultAt(root, type, root),
    supportsStringLiteralRefinement: (position, type) => supportsLiteralAt(root, position, type, root),
  }
  resolvedProfileCache.set(resolved, resolved)
  return resolved
}

export const defaultPostgresCodecProfile: BuiltInPostgresCodecProfile = 'conservative'

export function resolveTypeScriptResultTypeForPostgresType(
  type: PostgresTypeFact,
  profile: PostgresCodecProfile | ResolvedPostgresCodecProfile = defaultPostgresCodecProfile
): PostgresTypeScriptResolution {
  return resolvePostgresCodecProfile(profile).resolveResultType(type)
}

export function resolveTypeScriptParameterTypeForPostgresType(
  type: PostgresTypeFact,
  profile: PostgresCodecProfile | ResolvedPostgresCodecProfile = defaultPostgresCodecProfile
): PostgresTypeScriptResolution {
  return resolvePostgresCodecProfile(profile).resolveParameterType(type)
}

export function resolveTypeScriptJsonScalarTypeForPostgresType(
  type: PostgresTypeFact,
  profile: PostgresCodecProfile | ResolvedPostgresCodecProfile = defaultPostgresCodecProfile
): PostgresTypeScriptResolution {
  return resolvePostgresCodecProfile(profile).resolveJsonScalarType(type)
}

export function postgresResultSupportsStringLiteralRefinement(
  type: PostgresTypeFact,
  profile: PostgresCodecProfile | ResolvedPostgresCodecProfile = defaultPostgresCodecProfile
): boolean {
  return resolvePostgresCodecProfile(profile).supportsStringLiteralRefinement('result', type)
}

export function postgresParameterSupportsStringLiteralRefinement(
  type: PostgresTypeFact,
  profile: PostgresCodecProfile | ResolvedPostgresCodecProfile = defaultPostgresCodecProfile
): boolean {
  return resolvePostgresCodecProfile(profile).supportsStringLiteralRefinement('parameter', type)
}

export function postgresJsonSupportsStringLiteralRefinement(
  type: PostgresTypeFact,
  profile: PostgresCodecProfile | ResolvedPostgresCodecProfile = defaultPostgresCodecProfile
): boolean {
  return resolvePostgresCodecProfile(profile).supportsStringLiteralRefinement('json', type)
}

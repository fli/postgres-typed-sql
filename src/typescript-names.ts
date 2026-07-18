const reservedBindingIdentifiers = new Set([
  'arguments',
  'await',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'eval',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'function',
  'if',
  'implements',
  'import',
  'in',
  'instanceof',
  'interface',
  'let',
  'new',
  'null',
  'package',
  'private',
  'protected',
  'public',
  'return',
  'static',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'typeof',
  'var',
  'void',
  'while',
  'with',
  'yield',
])

export function camelCaseIdentifier(identifier: string): string {
  return identifier.replaceAll(/_([a-z0-9])/gu, (_match, letter: string) => letter.toUpperCase())
}

const conventionalPropertyIdentifier = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/u

export function camelCasePropertyName(identifier: string): string {
  return conventionalPropertyIdentifier.test(identifier) ? camelCaseIdentifier(identifier) : identifier
}

export function pascalCaseIdentifier(identifier: string): string {
  const camel = camelCaseIdentifier(identifier)
  return `${camel.slice(0, 1).toUpperCase()}${camel.slice(1)}`
}

export function schemaQualifiedPascalName(schema: string, identifier: string): string {
  const name = pascalCaseIdentifier(identifier)
  return schema === 'public' ? name : `${pascalCaseIdentifier(schema)}${name}`
}

const conventionalPostgresIdentifier = /^[a-z][a-z0-9]*(?:_[a-z][a-z0-9]*)*$/u

export function postgresIdentifierTypeSegment(identifier: string): string {
  if (conventionalPostgresIdentifier.test(identifier)) {
    return identifier
      .split('_')
      .map((word) => `${word[0]?.toUpperCase()}${word.slice(1)}`)
      .join('')
  }

  let encoded = '$Q'
  for (const character of identifier) {
    encoded += /^[A-Za-z0-9]$/u.test(character) ? character : `$${character.codePointAt(0)?.toString(16)}$`
  }
  return encoded
}

export function postgresNamedTypeBinding(schema: string, identifier: string): string {
  const encodedIdentifier = postgresIdentifierTypeSegment(identifier)
  return schema === 'public' ? encodedIdentifier : `${postgresIdentifierTypeSegment(schema)}_${encodedIdentifier}`
}

export function postgresCheckConstraintTypeBinding(schema: string, relation: string, column: string): string {
  return `${postgresNamedTypeBinding(schema, relation)}__${postgresIdentifierTypeSegment(column)}`
}

export function quotePropertyName(propertyName: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(propertyName) ? propertyName : JSON.stringify(propertyName)
}

export function renderTypeScriptLineCommentValue(value: string): string {
  return value
    .replaceAll('\r', '\\r')
    .replaceAll('\n', '\\n')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029')
}

export function assertTypeScriptBindingIdentifier(identifier: unknown, context: string): asserts identifier is string {
  if (
    typeof identifier !== 'string' ||
    !/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(identifier) ||
    reservedBindingIdentifiers.has(identifier)
  ) {
    throw new Error(`${context}: ${JSON.stringify(identifier)} is not a legal non-reserved TypeScript binding.`)
  }
}

export interface TypeScriptBinding {
  readonly name: string
  readonly source: string
}

export function assertUniqueTypeScriptBindings(bindings: readonly TypeScriptBinding[], context: string): void {
  const firstSourceByName = new Map<string, string>()
  for (const binding of bindings) {
    assertTypeScriptBindingIdentifier(binding.name, `${context}: generated binding for ${binding.source}`)
    const firstSource = firstSourceByName.get(binding.name)
    if (firstSource) {
      throw new Error(
        `${context}: generated TypeScript binding ${binding.name} for ${binding.source} collides with ${firstSource}.`
      )
    }
    firstSourceByName.set(binding.name, binding.source)
  }
}

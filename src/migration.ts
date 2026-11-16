import type TypeScript from 'typescript'

/** Finds statically visible PgJson values flowing into unknown parser inputs. */
export function findPgJsonUnknownFlows(
  ts: typeof TypeScript,
  program: TypeScript.Program
): readonly TypeScript.Diagnostic[] {
  const checker = program.getTypeChecker()
  const brands = new Set<TypeScript.Declaration>()
  function discover(node: TypeScript.Node): void {
    const specifier =
      ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
        ? node.moduleSpecifier
        : ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)
          ? node.argument.literal
          : undefined
    if (specifier && ts.isStringLiteral(specifier)) {
      if (!['postgres-typed-sql', 'postgres-typed-sql/values', 'postgres-typed-sql/scalars'].includes(specifier.text))
        return
      const module = checker.getSymbolAtLocation(specifier)
      if (!module) return
      let exported = checker.getExportsOfModule(module).find((symbol) => symbol.name === 'PgJson')
      if (exported && exported.flags & ts.SymbolFlags.Alias) exported = checker.getAliasedSymbol(exported)
      const declaration = exported?.declarations?.find(ts.isInterfaceDeclaration)
      if (!declaration) return
      for (const member of declaration.members) {
        if (!ts.isPropertySignature(member) || !member.name || !ts.isComputedPropertyName(member.name)) continue
        const key = checker.getSymbolAtLocation(member.name.expression)
        if (key && checker.getTypeOfSymbolAtLocation(key, member).flags & ts.TypeFlags.UniqueESSymbol) {
          brands.add(member)
        }
      }
    }
    ts.forEachChild(node, discover)
  }
  for (const file of program.getSourceFiles()) discover(file)
  const diagnostics: TypeScript.Diagnostic[] = []
  const constituents = (type: TypeScript.Type): readonly TypeScript.Type[] => (type.isUnion() ? type.types : [type])
  const branded = (type: TypeScript.Type): boolean =>
    constituents(type).some((part) =>
      checker
        .getPropertiesOfType(part)
        .some((property) => property.declarations?.some((declaration) => brands.has(declaration)))
    )
  const isUnknown = (type: TypeScript.Type): boolean => (type.flags & ts.TypeFlags.Unknown) !== 0
  function inspect(
    source: TypeScript.Type,
    target: TypeScript.Type,
    node: TypeScript.Expression,
    path: string,
    depth: number,
    seen: readonly (readonly [TypeScript.Type, TypeScript.Type])[]
  ): void {
    if (depth > 5) return
    if (isUnknown(target)) {
      if (branded(source))
        diagnostics.push({
          file: node.getSourceFile(),
          start: node.getStart(),
          length: node.getWidth(),
          category: ts.DiagnosticCategory.Warning,
          code: 95001,
          messageText: `PgJson flows into unknown at ${path}. Review whether to pass .value instead.`,
        })
      return
    }
    if (branded(source) || source.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown) || target.flags & ts.TypeFlags.Any)
      return
    for (const part of constituents(source)) {
      if (!(part.flags & ts.TypeFlags.Object)) continue
      if (seen.some(([from, to]) => from === part && to === target)) continue
      const nextSeen: typeof seen = [...seen, [part, target]]
      if (checker.isArrayType(part) && checker.isArrayType(target)) {
        const from = checker.getIndexTypeOfType(part, ts.IndexKind.Number)
        const to = checker.getIndexTypeOfType(target, ts.IndexKind.Number)
        if (from && to) inspect(from, to, node, `${path}[]`, depth + 1, nextSeen)
        continue
      }
      for (const property of checker.getPropertiesOfType(part)) {
        if (property.name.startsWith('__@')) continue
        const destination = checker.getPropertyOfType(target, property.name)
        if (!destination) continue
        const from = checker.getTypeOfSymbolAtLocation(property, node)
        const to = checker.getTypeOfSymbolAtLocation(destination, node)
        inspect(from, to, node, `${path}.${property.name}`, depth + 1, nextSeen)
      }
    }
  }
  function visit(node: TypeScript.Node): void {
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const signature = checker.getResolvedSignature(node)
      const args = node.arguments ?? []
      if (signature)
        for (const [index, argument] of args.entries()) {
          if (ts.isSpreadElement(argument)) continue
          const parameter = signature.parameters[index]
          if (!parameter) continue
          inspect(
            checker.getTypeAtLocation(argument),
            checker.getTypeOfSymbolAtLocation(parameter, argument),
            argument,
            `argument ${index + 1}`,
            0,
            []
          )
        }
    }
    ts.forEachChild(node, visit)
  }
  for (const file of program.getSourceFiles())
    if (!file.isDeclarationFile && !file.fileName.includes('/node_modules/')) visit(file)
  return diagnostics
}

/** Current-source import parsing and graph rules; no frozen paths or exception list. */
import ts from 'typescript';
import path from 'node:path';

export type ModuleReference = {
  specifier: string | null;
  line: number;
  typeOnly: boolean;
};

export function readModuleReferences(
  file: string,
  text: string,
): ModuleReference[] {
  const filename = path.resolve(file);
  const source = ts.createSourceFile(
    filename,
    text,
    ts.ScriptTarget.Latest,
    true,
  );
  const options: ts.CompilerOptions = {
    noLib: true,
    noResolve: true,
    allowJs: true,
  };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (requested) =>
    requested === filename ? source : undefined;
  const checker = ts.createProgram([filename], options, host).getTypeChecker();
  type LoaderKind =
    'require' | 'create-require' | 'module-global' | 'module-namespace';
  const bindings = new Map<ts.Symbol, LoaderKind>();
  const bind = (node: ts.Node, kind: LoaderKind): boolean => {
    const symbol = checker.getSymbolAtLocation(node);
    if (!symbol || bindings.has(symbol)) return false;
    bindings.set(symbol, kind);
    return true;
  };
  for (const node of source.statements) {
    if (
      ts.isImportEqualsDeclaration(node) &&
      !node.isTypeOnly &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteralLike(node.moduleReference.expression) &&
      ['module', 'node:module'].includes(node.moduleReference.expression.text)
    )
      bind(node.name, 'module-namespace');
    if (
      !ts.isImportDeclaration(node) ||
      !ts.isStringLiteral(node.moduleSpecifier) ||
      !['module', 'node:module'].includes(node.moduleSpecifier.text) ||
      node.importClause?.isTypeOnly
    )
      continue;
    const clause = node.importClause;
    if (clause?.name) bind(clause.name, 'module-namespace');
    const named = clause?.namedBindings;
    if (named && ts.isNamespaceImport(named))
      bind(named.name, 'module-namespace');
    if (named && ts.isNamedImports(named))
      for (const item of named.elements) {
        if (
          !item.isTypeOnly &&
          (item.propertyName ?? item.name).text === 'createRequire'
        )
          bind(item.name, 'create-require');
      }
  }
  const loaderKind = (node: ts.Node): LoaderKind | undefined => {
    if (ts.isIdentifier(node)) {
      const symbol = checker.getSymbolAtLocation(node);
      if (symbol) return bindings.get(symbol);
      if (node.text === 'require') return 'require';
      if (node.text === 'module') return 'module-global';
    }
    if (ts.isParenthesizedExpression(node)) return loaderKind(node.expression);
    if (
      ts.isPropertyAccessExpression(node) ||
      ts.isElementAccessExpression(node)
    ) {
      const name = ts.isPropertyAccessExpression(node)
        ? node.name.text
        : ts.isStringLiteralLike(node.argumentExpression)
          ? node.argumentExpression.text
          : undefined;
      const receiver = loaderKind(node.expression);
      if (name === 'require' && receiver === 'module-global') return 'require';
      if (name === 'createRequire' && receiver === 'module-namespace')
        return 'create-require';
    }
    if (ts.isCallExpression(node)) {
      const called = loaderKind(node.expression);
      if (called === 'create-require') return 'require';
      if (
        called === 'require' &&
        node.arguments[0] &&
        ts.isStringLiteralLike(node.arguments[0]) &&
        ['module', 'node:module'].includes(node.arguments[0].text)
      )
        return 'module-namespace';
    }
    return undefined;
  };
  const declarations: ts.VariableDeclaration[] = [];
  const collectDeclarations = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node)) declarations.push(node);
    ts.forEachChild(node, collectDeclarations);
  };
  collectDeclarations(source);
  let changed = true;
  while (changed) {
    changed = false;
    for (const declaration of declarations) {
      if (!declaration.initializer) continue;
      const kind = loaderKind(declaration.initializer);
      if (!kind) continue;
      if (ts.isIdentifier(declaration.name))
        changed = bind(declaration.name, kind) || changed;
      else if (ts.isObjectBindingPattern(declaration.name))
        for (const element of declaration.name.elements) {
          const key = (element.propertyName ?? element.name).getText(source);
          if (key === 'createRequire' && kind === 'module-namespace')
            changed = bind(element.name, 'create-require') || changed;
          if (key === 'require' && kind === 'module-global')
            changed = bind(element.name, 'require') || changed;
        }
    }
  }
  const result: ModuleReference[] = [];
  const record = (
    node: ts.Node,
    value: ts.Node | undefined,
    typeOnly = false,
  ): void => {
    result.push({
      specifier: value && ts.isStringLiteralLike(value) ? value.text : null,
      line:
        source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      typeOnly,
    });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const named = clause?.namedBindings;
      const typeOnly =
        clause?.isTypeOnly ||
        (!clause?.name &&
          named &&
          ts.isNamedImports(named) &&
          named.elements.length > 0 &&
          named.elements.every((item) => item.isTypeOnly));
      record(node, node.moduleSpecifier, Boolean(typeOnly));
    } else if (ts.isExportDeclaration(node)) {
      const named = node.exportClause;
      const typeOnly =
        node.isTypeOnly ||
        (named &&
          ts.isNamedExports(named) &&
          named.elements.length > 0 &&
          named.elements.every((item) => item.isTypeOnly));
      if (node.moduleSpecifier)
        record(node, node.moduleSpecifier, Boolean(typeOnly));
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      record(node, node.moduleReference.expression, node.isTypeOnly);
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument)
    ) {
      record(node, node.argument.literal, true);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        loaderKind(node.expression) === 'require')
    ) {
      record(node, node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return result;
}

const ENGINE_SOURCE = 'packages/workflow-engine/src/';
const ALLOWED_LAYERS: Record<string, readonly string[]> = {
  entrypoints: ['composition-root', 'foundation'],
  'composition-root': [
    'application',
    'runtime',
    'adapters',
    'modules',
    'foundation',
  ],
  application: ['modules', 'foundation'],
  runtime: ['modules', 'foundation'],
  adapters: ['modules', 'foundation'],
  modules: ['foundation'],
  foundation: [],
};

export function classifyLayerDependency(
  from: string,
  to: string,
): string | null {
  if (!from.startsWith(ENGINE_SOURCE)) return null;
  const [fromLayer, fromDomain] = from.slice(ENGINE_SOURCE.length).split('/');
  if (!Object.hasOwn(ALLOWED_LAYERS, fromLayer))
    return 'unclassified-source-layer';
  if (to.startsWith('packages/workflow-engine/bootstrap/'))
    return 'src-to-bootstrap';
  if (!to.startsWith(ENGINE_SOURCE)) return null;
  const [toLayer, toDomain] = to.slice(ENGINE_SOURCE.length).split('/');
  if (!Object.hasOwn(ALLOWED_LAYERS, toLayer))
    return 'unclassified-source-layer';
  if (fromLayer === toLayer) {
    if (fromLayer === 'adapters' && fromDomain !== toDomain)
      return 'cross-adapter';
    if (
      fromLayer === 'modules' &&
      fromDomain === 'why-knowledge' &&
      toDomain === 'investigation'
    )
      return 'why-to-investigation';
    return null;
  }
  if (ALLOWED_LAYERS[fromLayer].includes(toLayer)) return null;
  if (fromLayer === 'entrypoints') return 'entrypoint-bypass-composition-root';
  if (fromLayer === 'foundation') return 'foundation-outward';
  const label =
    fromLayer === 'modules'
      ? 'module'
      : fromLayer === 'adapters'
        ? 'adapter'
        : fromLayer;
  return `${label}-to-${toLayer}`;
}

/** Returns strongly connected components with at least two distinct owners. */
export function findDependencyCycles(
  edges: readonly (readonly [string, string])[],
): string[][] {
  const graph = new Map<string, Set<string>>();
  for (const [from, to] of edges) {
    if (!graph.has(from)) graph.set(from, new Set());
    if (!graph.has(to)) graph.set(to, new Set());
    graph.get(from)!.add(to);
  }
  const indices = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const active = new Set<string>();
  const cycles: string[][] = [];
  let nextIndex = 0;
  const visit = (node: string): void => {
    indices.set(node, nextIndex);
    low.set(node, nextIndex++);
    stack.push(node);
    active.add(node);
    for (const target of graph.get(node)!) {
      if (!indices.has(target)) {
        visit(target);
        low.set(node, Math.min(low.get(node)!, low.get(target)!));
      } else if (active.has(target)) {
        low.set(node, Math.min(low.get(node)!, indices.get(target)!));
      }
    }
    if (low.get(node) !== indices.get(node)) return;
    const component: string[] = [];
    let member: string;
    do {
      member = stack.pop()!;
      active.delete(member);
      component.push(member);
    } while (member !== node);
    if (component.length > 1) cycles.push(component.sort());
  };
  for (const node of graph.keys()) if (!indices.has(node)) visit(node);
  return cycles.sort((left, right) => left[0].localeCompare(right[0]));
}

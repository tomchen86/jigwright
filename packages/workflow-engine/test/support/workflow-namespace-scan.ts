/** Lexically inspects package source for consumer-branded workflow identities. */
import type * as TypeScript from 'typescript';
type TypeScriptApi = Omit<typeof TypeScript, 'default'>;
type WorkflowNamespaceFinding = {
  path: string;
  start: number;
  length: number;
  normalizedValue: string;
  syntaxForm:
    | 'exact-string'
    | 'embedded-string'
    | 'template-static'
    | 'folded'
    | 'namespace-fragment';
};
type Binding =
  { kind: 'const'; initializer: TypeScript.Expression } | { kind: 'opaque' };
type BindingIndex = {
  resolve(identifier: TypeScript.Identifier): Binding | null;
};
type ScanContext = {
  ts: TypeScriptApi;
  file: string;
  sourceFile: TypeScript.SourceFile;
  bindings: BindingIndex;
  legacyNamespacePrefix: string;
};
export function scanWorkflowNamespaces(
  ts: TypeScriptApi,
  file: string,
  source: string,
  extension: string,
): { namespace: WorkflowNamespaceFinding[] } {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    extension === '.js' ? ts.ScriptKind.JS : ts.ScriptKind.TS,
  );
  const context: ScanContext = {
    ts,
    file,
    sourceFile,
    bindings: createBindingIndex(ts, sourceFile),
    legacyNamespacePrefix: 'expense-app.workflow.',
  };
  const namespace: WorkflowNamespaceFinding[] = [];
  const visit = (node: TypeScript.Node): void => {
    collectNamespaceFindings(node, context, namespace);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  namespace.sort(compareFindings);
  return { namespace };
}

function collectNamespaceFindings(
  node: TypeScript.Node,
  context: ScanContext,
  findings: WorkflowNamespaceFinding[],
): void {
  const { ts, sourceFile, file } = context;
  if (
    (ts.isBinaryExpression(node) || ts.isTemplateExpression(node)) &&
    isOutermostStaticComposition(node, context)
  ) {
    const folded = foldStaticString(node, context, new Set());
    if (folded !== null) {
      recordNamespaceMatches(
        findings,
        file,
        node.getStart(sourceFile),
        node.getWidth(sourceFile),
        folded,
        'folded',
        context.legacyNamespacePrefix,
      );
    }
    return;
  }
  if (ts.isStringLiteral(node)) {
    if (hasFoldableNamespaceAncestor(node, context)) return;
    recordNamespaceMatches(
      findings,
      file,
      node.getStart(sourceFile),
      node.getWidth(sourceFile),
      node.text,
      'string',
      context.legacyNamespacePrefix,
    );
    return;
  }
  if (ts.isNoSubstitutionTemplateLiteral(node)) {
    if (hasFoldableNamespaceAncestor(node, context)) return;
    recordNamespaceMatches(
      findings,
      file,
      node.getStart(sourceFile),
      node.getWidth(sourceFile),
      node.text,
      'template',
      context.legacyNamespacePrefix,
    );
    return;
  }
  if (ts.isTemplateExpression(node)) {
    for (const fragment of [
      node.head,
      ...node.templateSpans.map((span) => span.literal),
    ]) {
      recordNamespaceMatches(
        findings,
        file,
        fragment.getStart(sourceFile),
        fragment.getWidth(sourceFile),
        fragment.text,
        'template',
        context.legacyNamespacePrefix,
      );
    }
  }
}

function recordNamespaceMatches(
  findings: WorkflowNamespaceFinding[],
  file: string,
  start: number,
  length: number,
  text: string,
  sourceKind: 'string' | 'template' | 'folded',
  legacyNamespacePrefix: string,
): void {
  let matched = false;
  const namespacePattern = new RegExp(
    `${escapeRegex(legacyNamespacePrefix)}[A-Za-z0-9._-]+`,
    'gu',
  );
  for (const match of text.matchAll(namespacePattern)) {
    matched = true;
    findings.push({
      path: file,
      start: start + (match.index ?? 0),
      length: match[0].length,
      normalizedValue: match[0],
      syntaxForm:
        sourceKind === 'folded'
          ? 'folded'
          : sourceKind === 'template'
            ? 'template-static'
            : text === match[0]
              ? 'exact-string'
              : 'embedded-string',
    });
  }
  if (!matched && text.includes(legacyNamespacePrefix)) {
    findings.push({
      path: file,
      start: start + text.indexOf(legacyNamespacePrefix),
      length: legacyNamespacePrefix.length,
      normalizedValue: legacyNamespacePrefix,
      syntaxForm: 'namespace-fragment',
    });
  }
}

function hasFoldableNamespaceAncestor(
  node: TypeScript.Node,
  context: ScanContext,
): boolean {
  const { ts } = context;
  let current: TypeScript.Node | undefined = node.parent;
  while (current !== undefined) {
    if (ts.isTemplateSpan(current)) {
      current = current.parent;
      continue;
    }
    if (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isNonNullExpression(current)
    ) {
      current = current.parent;
      continue;
    }
    if (
      !ts.isBinaryExpression(current) &&
      !ts.isTemplateExpression(current) &&
      !ts.isParenthesizedExpression(current)
    ) {
      return false;
    }
    const folded = foldStaticString(current, context, new Set());
    if (folded?.includes(context.legacyNamespacePrefix)) return true;
    current = current.parent;
  }
  return false;
}

function isOutermostStaticComposition(
  node: TypeScript.Expression,
  context: ScanContext,
): boolean {
  if (foldStaticString(node, context, new Set()) === null) return false;
  const parent = node.parent;
  return !(
    (context.ts.isBinaryExpression(parent) ||
      context.ts.isTemplateExpression(parent) ||
      context.ts.isParenthesizedExpression(parent)) &&
    foldStaticString(parent, context, new Set()) !== null
  );
}

function foldStaticString(
  expression: TypeScript.Expression,
  context: ScanContext,
  seen: Set<TypeScript.Node>,
): string | null {
  const { ts } = context;
  const current = unwrapExpression(expression, ts);
  if (seen.has(current)) return null;
  seen.add(current);
  if (
    ts.isStringLiteral(current) ||
    ts.isNoSubstitutionTemplateLiteral(current)
  ) {
    return current.text;
  }
  if (
    ts.isBinaryExpression(current) &&
    current.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = foldStaticString(current.left, context, new Set(seen));
    const right = foldStaticString(current.right, context, new Set(seen));
    return left === null || right === null ? null : `${left}${right}`;
  }
  if (ts.isTemplateExpression(current)) {
    let result = current.head.text;
    for (const span of current.templateSpans) {
      const value = foldStaticString(span.expression, context, new Set(seen));
      if (value === null) return null;
      result += value + span.literal.text;
    }
    return result;
  }
  if (ts.isIdentifier(current)) {
    const binding = context.bindings.resolve(current);
    return binding?.kind === 'const'
      ? foldStaticString(binding.initializer, context, seen)
      : null;
  }
  return null;
}

function unwrapExpression(
  expression: TypeScript.Expression,
  ts: TypeScriptApi,
): TypeScript.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function createBindingIndex(
  ts: TypeScriptApi,
  sourceFile: TypeScript.SourceFile,
): BindingIndex {
  const scopes = new Map<TypeScript.Node, Map<string, Binding>>();
  const ensureScope = (owner: TypeScript.Node): Map<string, Binding> => {
    const existing = scopes.get(owner);
    if (existing) return existing;
    const created = new Map<string, Binding>();
    scopes.set(owner, created);
    return created;
  };
  const scopeFor = (node: TypeScript.Node): Map<string, Binding> => {
    let current: TypeScript.Node | undefined = node;
    while (current !== undefined && !isScopeNode(current, ts)) {
      current = current.parent;
    }
    const owner = current ?? sourceFile;
    return ensureScope(owner);
  };
  const functionScopeFor = (node: TypeScript.Node): Map<string, Binding> => {
    let current: TypeScript.Node | undefined = node;
    while (
      current !== undefined &&
      !ts.isSourceFile(current) &&
      !ts.isFunctionLike(current)
    ) {
      current = current.parent;
    }
    return ensureScope(current ?? sourceFile);
  };
  const register = (
    scope: Map<string, Binding>,
    name: string,
    binding: Binding,
  ): void => {
    scope.set(name, scope.has(name) ? { kind: 'opaque' } : binding);
  };

  const visit = (node: TypeScript.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.importClause !== undefined
    ) {
      const scope = scopeFor(node);
      if (node.importClause.name) {
        register(scope, node.importClause.name.text, { kind: 'opaque' });
      }
      const named = node.importClause.namedBindings;
      if (named && ts.isNamespaceImport(named)) {
        register(scope, named.name.text, { kind: 'opaque' });
      } else if (named && ts.isNamedImports(named)) {
        for (const element of named.elements) {
          register(scope, element.name.text, { kind: 'opaque' });
        }
      }
    } else if (ts.isVariableDeclaration(node)) {
      const declarationList = node.parent;
      const immutable =
        ts.isVariableDeclarationList(declarationList) &&
        (declarationList.flags & ts.NodeFlags.Const) !== 0 &&
        node.initializer !== undefined;
      const blockScoped =
        ts.isVariableDeclarationList(declarationList) &&
        (declarationList.flags & ts.NodeFlags.BlockScoped) !== 0;
      const scope = blockScoped ? scopeFor(node) : functionScopeFor(node);
      for (const name of bindingNames(node.name, ts)) {
        register(
          scope,
          name,
          immutable && ts.isIdentifier(node.name)
            ? { kind: 'const', initializer: node.initializer! }
            : { kind: 'opaque' },
        );
      }
    } else if (ts.isParameter(node)) {
      for (const name of bindingNames(node.name, ts)) {
        register(scopeFor(node), name, { kind: 'opaque' });
      }
    } else if (
      (ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node) ||
        ts.isEnumDeclaration(node)) &&
      node.name !== undefined
    ) {
      register(scopeFor(node.parent), node.name.text, { kind: 'opaque' });
    }
    ts.forEachChild(node, visit);
  };
  scopes.set(sourceFile, new Map());
  visit(sourceFile);

  return {
    resolve(identifier): Binding | null {
      let current: TypeScript.Node | undefined = identifier.parent;
      while (current !== undefined) {
        const binding = scopes.get(current)?.get(identifier.text);
        if (binding !== undefined) return binding;
        current = current.parent;
      }
      return null;
    },
  };
}

function bindingNames(
  name: TypeScript.BindingName,
  ts: TypeScriptApi,
): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((element) =>
    ts.isOmittedExpression(element) ? [] : bindingNames(element.name, ts),
  );
}

function isScopeNode(node: TypeScript.Node, ts: TypeScriptApi): boolean {
  return (
    ts.isSourceFile(node) ||
    ts.isBlock(node) ||
    ts.isModuleBlock(node) ||
    ts.isCatchClause(node) ||
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isSwitchStatement(node) ||
    ts.isFunctionLike(node)
  );
}

function compareFindings(
  left: WorkflowNamespaceFinding,
  right: WorkflowNamespaceFinding,
): number {
  return (
    compareText(left.path, right.path) ||
    left.start - right.start ||
    compareText(left.normalizedValue, right.normalizedValue) ||
    compareText(left.syntaxForm, right.syntaxForm)
  );
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

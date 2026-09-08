/**
 * Derives file dependency bindings from literal JavaScript and TypeScript imports.
 *
 * Invariants:
 * - Resolution and digests use one supplied snapshot, including absent local targets.
 * - Dependency bindings use source bytes, so import cycles need no recursive entry hashes.
 */

import crypto from 'node:crypto';
import path from 'node:path';
import type { SystemDescriptionSnapshot } from './spec-ownership.ts';
import {
  semanticFileSubjectId,
  type SemanticDependency,
} from '../why-knowledge/semantic-ledger.ts';

export function sourceDigest(source: string): string {
  return `sha256:${crypto.createHash('sha256').update(source).digest('hex')}`;
}

export function readImportDependencies(
  snapshot: SystemDescriptionSnapshot,
  subjectPath: string,
): readonly SemanticDependency[] {
  const source = snapshot.readText(subjectPath);
  if (source === undefined || !/\.[cm]?[jt]sx?$/.test(subjectPath)) return [];
  const paths = new Set(snapshot.listPaths());
  const targets = new Set<string>();
  for (const specifier of literalImports(source)) {
    const target = resolveImport(snapshot, paths, subjectPath, specifier);
    if (target !== null && target !== subjectPath) targets.add(target);
  }
  return [...targets].sort().map((target) => {
    const content = snapshot.readText(target);
    return {
      relation: 'imports',
      subjectId: semanticFileSubjectId(target),
      path: target,
      sourceDigest: content === undefined ? null : sourceDigest(content),
    };
  });
}

function literalImports(source: string): string[] {
  // ponytail: literal imports, re-exports and require calls only; computed
  // module loading needs a language adapter before it can supply static edges.
  const lexer =
    /\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`|[A-Za-z_$][\w$]*|\d+(?:\.\d+)?|[^\s]/g;
  const tokens: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = lexer.exec(source)) !== null) {
    const value = match[0];
    if (value.startsWith('//') || value.startsWith('/*')) continue;
    if (
      value === '/' &&
      [
        undefined,
        '=',
        '(',
        '[',
        '{',
        ',',
        ':',
        ';',
        '!',
        '?',
        'return',
        '=>',
      ].includes(tokens.at(-1))
    ) {
      const expression =
        /^\/(?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\\r\n])+\/[a-z]*/.exec(
          source.slice(match.index),
        );
      if (expression !== null) {
        lexer.lastIndex = match.index + expression[0].length;
        tokens.push('<regular-expression>');
        continue;
      }
    }
    tokens.push(value);
  }
  const imports: string[] = [];
  const literal = (value: string | undefined): string | null => {
    if (value === undefined || !/^['"`]/.test(value)) return null;
    if (value.startsWith('`') && value.includes('${')) return null;
    return value.slice(1, -1).replace(/\\(['"`\\])/g, '$1');
  };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token !== 'import' && token !== 'export' && token !== 'require')
      continue;
    if (tokens[index - 1] === '.') continue;
    let target: string | null = null;
    if (token !== 'export' && tokens[index + 1] === '(') {
      if ([')', ','].includes(tokens[index + 3] ?? ''))
        target = literal(tokens[index + 2]);
    } else if (token === 'import' && literal(tokens[index + 1]) !== null) {
      target = literal(tokens[index + 1]);
    } else if (token !== 'require' && tokens[index + 1] !== '.') {
      if (
        token === 'export' &&
        !['{', '*', 'type'].includes(tokens[index + 1] ?? '')
      )
        continue;
      for (let next = index + 1; next < tokens.length; next += 1) {
        if ([';', 'import', 'export', '='].includes(tokens[next]!)) break;
        if (tokens[next] === 'from') {
          target = literal(tokens[next + 1]);
          break;
        }
      }
    }
    if (target !== null) imports.push(target);
  }
  return imports;
}

function resolveImport(
  snapshot: SystemDescriptionSnapshot,
  paths: ReadonlySet<string>,
  subject: string,
  specifier: string,
): string | null {
  let candidate: string | null = null;
  if (specifier.startsWith('.')) {
    candidate = path.posix.normalize(
      path.posix.join(path.posix.dirname(subject), specifier),
    );
  } else {
    for (const packagePath of paths) {
      if (!packagePath.endsWith('package.json')) continue;
      let manifest: { name?: string; exports?: unknown; main?: string };
      try {
        manifest = JSON.parse(snapshot.readText(packagePath) ?? 'null');
      } catch {
        continue;
      }
      if (!manifest || typeof manifest.name !== 'string') continue;
      if (
        specifier !== manifest.name &&
        !specifier.startsWith(`${manifest.name}/`)
      )
        continue;
      const subpath =
        specifier === manifest.name
          ? '.'
          : `.${specifier.slice(manifest.name.length)}`;
      const exports = manifest.exports;
      const target = exportTarget(
        typeof exports === 'object' && exports !== null && subpath in exports
          ? (exports as Record<string, unknown>)[subpath]
          : subpath === '.'
            ? (exports ?? manifest.main)
            : undefined,
      );
      candidate = path.posix.join(
        path.posix.dirname(packagePath),
        target ?? subpath,
      );
      break;
    }
  }
  if (
    candidate === null ||
    candidate === '..' ||
    candidate.startsWith('../') ||
    path.posix.isAbsolute(candidate)
  )
    return null;
  const stem = candidate.replace(/\.[cm]?js$/, '');
  return (
    [
      candidate,
      ...[
        '.ts',
        '.tsx',
        '.mts',
        '.cts',
        '.js',
        '.jsx',
        '.mjs',
        '.cjs',
        '/index.ts',
        '/index.js',
      ].map((suffix) => stem + suffix),
    ].find((file) => paths.has(file)) ?? candidate
  );
}

function exportTarget(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return null;
  for (const [condition, entry] of Object.entries(value)) {
    if (!['import', 'node', 'default', 'require', 'types'].includes(condition))
      continue;
    const target = exportTarget(entry);
    if (target !== null) return target;
  }
  return null;
}

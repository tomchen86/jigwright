import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';

import { assertInteractiveSignerContext } from '../src/adapters/signing/ssh/maintainer-signer.ts';

const require = createRequire(import.meta.url);
const ts = require('typescript') as typeof import('typescript');
const SOURCE_ROOT = path.resolve(import.meta.dirname, '../src');
const SIGNER_ADAPTER_SUFFIX = 'adapters/signing/ssh/maintainer-signer.ts';

test('maintainer signer contract is authority-owned and adapters only implement it', () => {
  const portPath = path.join(
    SOURCE_ROOT,
    'modules/authority/maintainer-signer-port.ts',
  );
  const portSource = fs.readFileSync(portPath, 'utf8');
  assert.match(portSource, /export type MaintainerSignerProvider =/);
  assert.doesNotMatch(portSource, /(?:node:|\/adapters\/|\/runtime\/)/);

  const adapterSource = fs.readFileSync(
    path.join(SOURCE_ROOT, SIGNER_ADAPTER_SUFFIX),
    'utf8',
  );
  assert.match(
    adapterSource,
    /export type \{ MaintainerSignerProvider \} from '.+modules\/authority\/maintainer-signer-port\.ts';/,
  );
  assert.match(
    fs.readFileSync(
      path.join(SOURCE_ROOT, 'composition-root/maintainer-signer.ts'),
      'utf8',
    ),
    /export type \{ MaintainerSignerProvider \} from '.+modules\/authority\/maintainer-signer-port\.ts';/,
  );
});

test('production code has no type-only dependency on the SSH signer adapter', () => {
  const offenders: string[] = [];
  visit(SOURCE_ROOT);
  assert.deepEqual(offenders, []);

  function visit(directory: string): void {
    for (const entry of fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
      const sourceFile = ts.createSourceFile(
        entryPath,
        fs.readFileSync(entryPath, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
      );
      for (const statement of sourceFile.statements) {
        if (
          !ts.isImportDeclaration(statement) ||
          !ts.isStringLiteral(statement.moduleSpecifier) ||
          !statement.moduleSpecifier.text.endsWith(SIGNER_ADAPTER_SUFFIX)
        ) {
          continue;
        }
        const clause = statement.importClause;
        if (
          clause &&
          (!hasRuntimeBinding(clause) ||
            entryPath.startsWith(
              path.join(SOURCE_ROOT, 'runtime') + path.sep,
            ) ||
            entryPath.startsWith(
              path.join(SOURCE_ROOT, 'application') + path.sep,
            ))
        ) {
          offenders.push(path.relative(SOURCE_ROOT, entryPath));
        }
      }
    }
  }
});

test('current signer admission requires every controlling terminal', () => {
  assert.doesNotThrow(() =>
    assertInteractiveSignerContext({
      stdinIsTty: true,
      stdoutIsTty: true,
      stderrIsTty: true,
    }),
  );

  for (const redirected of [
    'stdinIsTty',
    'stdoutIsTty',
    'stderrIsTty',
  ] as const) {
    const context = {
      stdinIsTty: true,
      stdoutIsTty: true,
      stderrIsTty: true,
      [redirected]: false,
    };
    assert.throws(
      () => assertInteractiveSignerContext(context),
      (error) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'MAINTAINER_INTERACTIVE_REQUIRED',
      redirected,
    );
  }
});

function hasRuntimeBinding(clause: import('typescript').ImportClause): boolean {
  if (clause.isTypeOnly) return false;
  if (clause.name) return true;
  if (!clause.namedBindings) return false;
  if (ts.isNamespaceImport(clause.namedBindings)) return true;
  return clause.namedBindings.elements.some((element) => !element.isTypeOnly);
}

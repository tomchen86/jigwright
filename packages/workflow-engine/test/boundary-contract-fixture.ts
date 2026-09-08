/** Shared repository/asset discovery and canonical assertion helpers for architecture contracts. */
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

export const repositoryRoot = resolveRepositoryRoot(
  process.env.WORKFLOW_ENGINE_REPOSITORY_ROOT,
);

const repositoryRequire = createRequire(
  path.join(repositoryRoot, 'package.json'),
);

export const ts = repositoryRequire(
  'typescript',
) as typeof import('typescript');

function resolveRepositoryRoot(explicit: string | undefined): string {
  if (explicit) {
    const resolved = fs.realpathSync(explicit);
    assertRepositoryRoot(resolved);
    return resolved;
  }
  let cursor = fs.realpathSync(import.meta.dirname);
  while (true) {
    if (
      fs.existsSync(path.join(cursor, 'package.json')) &&
      fs.existsSync(path.join(cursor, 'packages/workflow-engine/package.json'))
    ) {
      return cursor;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      throw new Error(
        'Set WORKFLOW_ENGINE_REPOSITORY_ROOT when the prototype is outside the repository.',
      );
    }
    cursor = parent;
  }
}

function assertRepositoryRoot(root: string): void {
  if (
    !fs.statSync(path.join(root, 'package.json')).isFile() ||
    !fs
      .statSync(path.join(root, 'packages/workflow-engine/package.json'))
      .isFile()
  ) {
    throw new Error(`Not a workflow-engine repository root: ${root}`);
  }
}

export function resolveAssetPath(
  explicit: string | undefined,
  name: string,
): string {
  if (explicit) {
    return fs.realpathSync(explicit);
  }
  const candidates = [
    path.join(import.meta.dirname, name),
    path.join(import.meta.dirname, 'fixtures', name),
  ];
  const observed = candidates.find((candidate) => fs.existsSync(candidate));
  if (!observed) {
    throw new Error(`Missing module-boundary asset: ${name}`);
  }
  return fs.realpathSync(observed);
}

export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function listRegularFiles(root: string, relativeRoot: string): string[] {
  const absoluteRoot = path.join(root, relativeRoot);
  const rootStats = fs.lstatSync(absoluteRoot, { throwIfNoEntry: false });
  if (!rootStats?.isDirectory() || rootStats.isSymbolicLink()) {
    throw new Error(`T3 inventory scan root is unavailable: ${relativeRoot}`);
  }
  const result: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`T3 inventory scan refuses symlink: ${absolute}`);
      }
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) {
        result.push(path.relative(root, absolute).split(path.sep).join('/'));
      }
    }
  };
  visit(absoluteRoot);
  return result.sort(compareText);
}

export function assertPlainObject(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new Error(`${label} must be an object.`);
  }
}

export function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): void {
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort());
}

export function digestText(value: string): string {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

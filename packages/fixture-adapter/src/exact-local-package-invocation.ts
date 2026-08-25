import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { normalizeExactRepositoryPath } from '@jigwright/core/repository-path';

export type ExactLocalPackageInvocationV1 = Readonly<{
  contractVersion: 'jigwright.exact-local-package-invocation.v1';
  packageName: string;
  packageRoot: string;
  executable: string;
  args: readonly string[];
  cwd: string;
}>;

export function createExactLocalPackageInvocation(input: {
  packageRoot: string;
  entrypoint: string;
  args: readonly string[];
  cwd: string;
}): ExactLocalPackageInvocationV1 {
  const packageRoot = fs.realpathSync(input.packageRoot);
  const packageStats = fs.lstatSync(packageRoot);
  if (!packageStats.isDirectory() || packageStats.isSymbolicLink()) {
    throw localInvocationInvalid();
  }
  const manifestPath = path.join(packageRoot, 'package.json');
  const manifestStats = fs.lstatSync(manifestPath);
  if (!manifestStats.isFile() || manifestStats.isSymbolicLink()) {
    throw localInvocationInvalid();
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as unknown;
  if (
    !isRecord(manifest) ||
    typeof manifest.name !== 'string' ||
    manifest.name.length === 0
  ) {
    throw localInvocationInvalid();
  }
  let entrypoint: string;
  try {
    entrypoint = normalizeExactRepositoryPath(input.entrypoint);
  } catch {
    throw localInvocationInvalid();
  }
  const entrypointPath = path.join(packageRoot, ...entrypoint.split('/'));
  const entrypointStats = fs.lstatSync(entrypointPath);
  if (
    !entrypointStats.isFile() ||
    entrypointStats.isSymbolicLink() ||
    fs.realpathSync(entrypointPath) !== entrypointPath
  ) {
    throw localInvocationInvalid();
  }
  if (
    !Array.isArray(input.args) ||
    input.args.some(
      (argument) =>
        typeof argument !== 'string' ||
        argument.includes('\0') ||
        argument.includes('\n'),
    )
  ) {
    throw localInvocationInvalid();
  }
  const cwd = fs.realpathSync(input.cwd);
  if (!fs.statSync(cwd).isDirectory()) throw localInvocationInvalid();
  return Object.freeze({
    contractVersion: 'jigwright.exact-local-package-invocation.v1' as const,
    packageName: manifest.name,
    packageRoot,
    executable: process.execPath,
    args: Object.freeze([
      '--experimental-strip-types',
      entrypointPath,
      ...input.args,
    ]),
    cwd,
  });
}

export function runExactLocalPackageInvocation(
  invocation: ExactLocalPackageInvocationV1,
): string {
  const result = spawnSync(invocation.executable, invocation.args, {
    cwd: invocation.cwd,
    env: process.env,
    shell: false,
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (
    result.error !== undefined ||
    result.signal !== null ||
    result.status !== 0
  ) {
    throw new Error(
      `Exact local package invocation failed: ${result.error?.message ?? result.stderr}`,
    );
  }
  return result.stdout;
}

function localInvocationInvalid(): TypeError {
  return new TypeError('Exact local package invocation is invalid.');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

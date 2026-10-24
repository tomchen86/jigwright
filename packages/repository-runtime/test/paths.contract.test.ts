import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RepositoryBoundaryError } from '@jigwright/core/runtime-path-kernel';
import {
  assertPolicyPathInsideRepository,
  investigationRuntimePaths,
} from '../src/paths.ts';

test('runtime path kernel preserves canonical investigation layout bytes', () => {
  const container = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), 'core-runtime-paths-'),
  );
  try {
    const common = path.join(container, 'git-common');
    fs.mkdirSync(common);
    const canonicalCommon = fs.realpathSync(common);
    assert.deepEqual(investigationRuntimePaths(common, 'workflow-engine'), {
      base: canonicalCommon,
      root: path.join(canonicalCommon, 'workflow-engine', 'investigations'),
      objects: path.join(
        canonicalCommon,
        'workflow-engine',
        'investigations',
        'objects',
        'sha256',
      ),
      refs: path.join(
        canonicalCommon,
        'workflow-engine',
        'investigations',
        'refs',
      ),
      sessions: path.join(
        canonicalCommon,
        'workflow-engine',
        'investigations',
        'sessions',
      ),
      invocations: path.join(
        canonicalCommon,
        'workflow-engine',
        'investigations',
        'invocations',
      ),
      locks: path.join(
        canonicalCommon,
        'workflow-engine',
        'investigations',
        'locks',
      ),
    });
  } finally {
    fs.rmSync(container, { recursive: true, force: true });
  }
});

test('repository boundary facts distinguish escapes from symlink aliases', () => {
  const container = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), 'core-repository-boundary-'),
  );
  const repository = path.join(container, 'repository');
  const outside = path.join(container, 'outside');
  fs.mkdirSync(repository);
  fs.mkdirSync(path.join(repository, 'source'));
  fs.mkdirSync(outside);
  try {
    fs.symlinkSync(outside, path.join(repository, 'escape'));
    assert.throws(
      () => assertPolicyPathInsideRepository(repository, 'escape/**'),
      isBoundaryError('PATH_ESCAPES_REPOSITORY', 'escape/**'),
    );

    fs.symlinkSync(
      path.join(repository, 'source'),
      path.join(repository, 'alias'),
    );
    assert.throws(
      () => assertPolicyPathInsideRepository(repository, 'alias/file.ts'),
      (error) => {
        assert.equal(
          isBoundaryError('SYMLINK_POLICY_PATH', 'alias/file.ts')(error),
          true,
        );
        assert.equal((error as RepositoryBoundaryError).symlinkPath, 'alias');
        return true;
      },
    );
  } finally {
    fs.rmSync(container, { recursive: true, force: true });
  }
});

test('repository runtime stays consumer-neutral and owns no session state', () => {
  const source = fs.readFileSync(
    new URL('../src/paths.ts', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(
    source,
    /expense-app|openspec|workflowError|ExitCode|provider|grant/i,
  );
  assert.doesNotMatch(
    source,
    /writeFile|renameSync|state transition|class .*Store|function .*reduc/i,
  );
});

function isBoundaryError(code: string, policyPath: string) {
  return (error: unknown): boolean =>
    error instanceof RepositoryBoundaryError &&
    error.code === code &&
    error.policyPath === policyPath;
}

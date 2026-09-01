import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { ExitCode, WorkflowError } from '../src/foundation/errors/errors.ts';
import {
  assertSpecDeltaPreconditions,
  verifyProjectedSpecDeltaOutcome,
} from '../src/runtime/repository-transaction/archive-delta-verifier.ts';

const repositoryRoot = path.resolve(import.meta.dirname, '../../..');

test('OpenSpec archive projection is public and the workflow verifier is an active thin facade', () => {
  const manifest = readJson('packages/openspec-adapter/package.json') as {
    exports?: Record<string, string>;
  };
  assert.equal(
    manifest.exports?.['./archive-projection'],
    './src/archive-projection.ts',
  );

  const facade = readSource(
    'packages/workflow-engine/src/runtime/repository-transaction/archive-delta-verifier.ts',
  );
  assert.match(facade, /@jigwright\/openspec-adapter\/archive-projection/);
  assert.doesNotMatch(
    facade,
    /function (?:parseDelta|splitSections|parseRequirements|requirementBlocks|scenarioIdentities|digest)\b/,
  );
  assert.doesNotMatch(facade, /node:crypto/);

  for (const file of [
    'packages/workflow-engine/src/application/archive/archive-transition.ts',
    'packages/workflow-engine/src/application/archive/archive-transformation.ts',
    'packages/workflow-engine/src/entrypoints/ci/ci-archive.ts',
  ]) {
    assert.match(
      readSource(file),
      /runtime\/repository-transaction\/archive-delta-verifier\.ts/,
      file,
    );
  }

  for (const file of [
    'packages/workflow-engine/src/application/archive/archive-eligibility.ts',
    'packages/workflow-engine/src/application/archive/archive-transformation.ts',
  ]) {
    const archiveApplication = readSource(file);
    assert.match(
      archiveApplication,
      /runtime\/repository-transaction\/git\.ts/,
      file,
    );
    assert.doesNotMatch(
      archiveApplication,
      /entrypoints\/ci\/ci-git\.ts/,
      file,
    );
  }
});

test('workflow archive facade preserves exact applicability and outcome errors', () => {
  const base = ['### Requirement: Existing', '', '#### Scenario: Kept'].join(
    '\n',
  );
  const inapplicable = [
    '## MODIFIED Requirements',
    '',
    '### Requirement: Missing',
  ].join('\n');
  assert.throws(
    () => assertSpecDeltaPreconditions('demo', base, inapplicable),
    (error) => {
      assertWorkflowError(error, {
        code: 'SPEC_DELTA_NOT_APPLICABLE',
        message:
          'Delta for demo declares operations the current base cannot accept: modified "Missing" — Requirement is not present in the base specification.',
        exitCode: ExitCode.verification,
        details: {
          capability: 'demo',
          faults: [
            {
              operation: 'modified',
              requirement: 'Missing',
              reason: 'Requirement is not present in the base specification.',
            },
          ],
        },
      });
      return true;
    },
  );

  const delta = [
    '## MODIFIED Requirements',
    '',
    '### Requirement: Existing',
    '',
    '#### Scenario: Kept',
  ].join('\n');
  assert.throws(
    () => verifyProjectedSpecDeltaOutcome('demo', base, delta, ''),
    (error) => {
      assertWorkflowError(error, {
        code: 'ARCHIVE_DELTA_OUTCOME_INVALID',
        message:
          'Archive base-spec output does not realize every declared delta operation.',
        exitCode: ExitCode.verification,
      });
      return true;
    },
  );
});

function assertWorkflowError(
  error: unknown,
  expected: Readonly<{
    code: string;
    message: string;
    exitCode: number;
    details?: Record<string, unknown>;
  }>,
): void {
  assert.equal(error instanceof WorkflowError, true);
  const workflow = error as WorkflowError;
  assert.equal(workflow.code, expected.code);
  assert.equal(workflow.message, expected.message);
  assert.equal(workflow.exitCode, expected.exitCode);
  assert.deepEqual(workflow.details, expected.details);
  assert.equal(workflow.recovery, undefined);
}

function readJson(file: string): unknown {
  return JSON.parse(readSource(file)) as unknown;
}

function readSource(file: string): string {
  return fs.readFileSync(path.join(repositoryRoot, file), 'utf8');
}

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import type { CentralGrantRequestPortV1 } from '@jigwright/core/central-grant-port';
import { createSystemDocumentFailGrantResult } from '../src/entrypoints/cli/system-document-fail-grant-cli.ts';
import {
  createFixtureRepository,
  configureChecks,
  git,
  runtimeRoot,
  writeReadyV3ExemptChange,
} from './fixture.ts';
import {
  hasCode,
  workRegistryGrantPolicy,
} from './governance-intake-fixture.ts';
import { satisfyCurrentTaskDiffReview } from './support/task-diff-review-fixture.ts';
import { startSession } from '../src/application/execute-task/session.ts';
import { commitPlanningTransition } from '../src/application/propose/planning-transition.ts';
import {
  finalizeTask,
  finalizeSession,
} from '../src/application/finalize/lifecycle.ts';
import {
  inspectSystemDocumentDispositions,
  recordSystemDocumentDispositions,
  assertSystemDocumentDispositions,
} from '../src/application/finalize/system-document-dispositions.ts';
import {
  createSystemDocumentGrantRequest,
  systemDocumentGrantTransitionDefinitions,
  SYSTEM_DOCUMENT_GRANT_REASON,
} from '../src/application/finalize/system-document-grant.ts';
import { createGrantCoordinatorKernel } from '../src/modules/authority/grant-coordinator.ts';
import { createTransitionRegistry } from '../src/modules/authority/grant-transition-registry.ts';
import {
  grantStorePaths,
  readGrantRecord,
} from '../src/runtime/storage-journal/grant-store.ts';
import {
  readSystemDocumentReviewRecord,
  writeSystemDocumentReviewRecord,
} from '../src/runtime/storage-journal/system-document-review-store.ts';

test('finalize requires exact document decisions before checks and recovers the admitted projection', async () => {
  const fixture = prepare();
  const { repository, sessionId, counter } = fixture;
  try {
    const review = inspectSystemDocumentDispositions(repository, sessionId);
    assert.deepEqual(
      review.documents.map(({ path }) => path),
      ['src/README.md', 'src/spec.md'],
    );
    assert.equal(
      review.documents.find(({ kind }) => kind === 'spec')!
        .deltaChangesContract,
      true,
    );
    let failure: unknown;
    assert.throws(
      () => finalizeTask(repository, sessionId),
      (error) => {
        failure = error;
        return hasCode('SYSTEM_DOCUMENT_DISPOSITION_REQUIRED')(error);
      },
    );
    assert.equal(fs.existsSync(counter), false);
    const args = [
      'finalize',
      sessionId,
      '--message',
      'Complete documented task',
    ];
    const requestPort: CentralGrantRequestPortV1 = {
      contractVersion: 'central-grant-request-port.v1',
      async requestGrant(request) {
        assert.equal(request.stateBinding.digest, review.candidateDigest);
        return {
          challengeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          challengeDigest: `sha256:${'b'.repeat(64)}`,
        };
      },
    };
    const mapped = await createSystemDocumentFailGrantResult(
      args,
      repository,
      failure,
      requestPort,
    );
    assert.match(JSON.stringify(mapped), /workflow-fail-grant-required\.v1/);
    assert.match(JSON.stringify(mapped), /retryAfterDecision/);
    const input = {
      ...review.inputTemplate,
      dispositions: [
        { path: 'src/spec.md', disposition: 'updated' },
        {
          path: 'src/README.md',
          disposition: 'later',
          reason: 'Reassess this explanation in the follow-up.',
        },
      ],
    };
    assert.equal(
      recordSystemDocumentDispositions(repository, sessionId, input).status,
      'reviewed',
    );
    fs.appendFileSync(
      path.join(repository, 'src/feature.ts'),
      '// Changed candidate\n',
    );
    await assert.rejects(
      createSystemDocumentFailGrantResult(
        args,
        repository,
        failure,
        requestPort,
      ),
      hasCode('SYSTEM_DOCUMENT_REVIEW_STALE'),
    );
    assert.throws(
      () => recordSystemDocumentDispositions(repository, sessionId, input),
      hasCode('SYSTEM_DOCUMENT_REVIEW_STALE'),
    );
    assert.throws(
      () => finalizeTask(repository, sessionId),
      hasCode('SYSTEM_DOCUMENT_DISPOSITION_REQUIRED'),
    );
    const current = inspectSystemDocumentDispositions(repository, sessionId);
    recordSystemDocumentDispositions(repository, sessionId, {
      ...input,
      candidateDigest: current.candidateDigest,
    });
    assert.throws(
      () => finalizeTask(repository, sessionId),
      hasCode('TASK_DIFF_REVIEW_REQUIRED'),
    );
    assert.equal(fs.readFileSync(counter, 'utf8'), '1');
    satisfyCurrentTaskDiffReview(repository, sessionId);
    const result = finalizeSession(
      repository,
      sessionId,
      'Complete documented task',
    );
    assert.equal(result.session.state, 'committed');
    assert.equal(fs.readFileSync(counter, 'utf8'), '1');
    assert.equal(git(repository, ['status', '--porcelain']), '');
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('Central Grant document exception recovers its exact receipt and never marks review passed', async () => {
  const { repository, sessionId, counter } = prepare();
  try {
    const challengeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const operationId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const crash = new Error('after durable document exception');
    let crashOnce = true;
    const ids = [challengeId, operationId];
    const coordinator = createGrantCoordinatorKernel({
      paths: grantStorePaths(runtimeRoot(repository)),
      registry: createTransitionRegistry(
        systemDocumentGrantTransitionDefinitions(repository, {
          afterExceptionRecorded() {
            if (crashOnce) {
              crashOnce = false;
              throw crash;
            }
          },
        }),
      ),
      policy: workRegistryGrantPolicy(),
      now: () => new Date('2026-09-08T00:00:00.000Z'),
      randomUUID: () => ids.shift()!,
      openApprovalSession(presentation) {
        return {
          async collectDecision() {
            return {
              choiceId: presentation.choices[0]!.choiceId,
              approvalMethod: 'human-presence' as const,
              reasonCode: SYSTEM_DOCUMENT_GRANT_REASON,
              reason: 'Defer these exact document decisions.',
              sessionNonce: 'nonce-77777777777777777777777777777777',
            };
          },
          async authenticate({ approvalSubjectDigest }) {
            return [
              {
                moduleId: 'human-gate-macos',
                version: '1',
                claims: ['fresh-local-device-owner'] as const,
                approvalSubjectDigest,
                proofDigest: `sha256:${'7'.repeat(64)}` as const,
                verifiedAt: '2026-09-08T00:00:00.000Z',
                identity: null,
                portableEvidence: null,
              },
            ];
          },
          async close() {},
        };
      },
      async withLifecycleOperation(_challengeId, operation) {
        return operation(() => {});
      },
    });
    const request = createSystemDocumentGrantRequest(repository, sessionId);
    await coordinator.requestGrant(request);
    await assert.rejects(
      coordinator.resolveChallenge(challengeId),
      (error) => error === crash,
    );
    assert.equal(
      readGrantRecord(grantStorePaths(runtimeRoot(repository)), challengeId)
        .state,
      'prepared',
    );
    const partial = inspectSystemDocumentDispositions(repository, sessionId);
    assert.equal(partial.status, 'required');
    assert.deepEqual(partial.dispositions, []);
    const receipt = readSystemDocumentReviewRecord(
      runtimeRoot(repository),
      partial.candidateDigest,
    )!;
    await coordinator.recoverChallenge(challengeId);
    const completed = inspectSystemDocumentDispositions(repository, sessionId);
    assert.equal(completed.status, 'skipped-by-grant');
    assert.equal(completed.reportId, receipt.reportId);
    assert.deepEqual(completed.dispositions, []);
    writeSystemDocumentReviewRecord(runtimeRoot(repository), {
      ...receipt.record,
      candidateDigest: completed.candidateDigest,
      createdAt: '2026-09-08T01:00:00.000Z',
    });
    assert.throws(
      () => assertSystemDocumentDispositions(repository, sessionId),
      hasCode('SYSTEM_DOCUMENT_DISPOSITION_REQUIRED'),
    );
    writeSystemDocumentReviewRecord(runtimeRoot(repository), {
      ...receipt.record,
      candidateDigest: completed.candidateDigest,
    });
    assert.doesNotThrow(() =>
      assertSystemDocumentDispositions(repository, sessionId),
    );
    assert.equal(fs.existsSync(counter), false);
    assert.throws(
      () => finalizeTask(repository, sessionId),
      hasCode('TASK_DIFF_REVIEW_REQUIRED'),
    );
    assert.equal(fs.readFileSync(counter, 'utf8'), '1');
    fs.appendFileSync(
      path.join(repository, 'src/feature.ts'),
      '// New implementation\n',
    );
    assert.throws(
      () => assertSystemDocumentDispositions(repository, sessionId),
      hasCode('SYSTEM_DOCUMENT_DISPOSITION_REQUIRED'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

function prepare() {
  const repository = createFixtureRepository();
  fs.writeFileSync(
    path.join(repository, 'src/spec.md'),
    '# Feature contracts\ncapabilities: [demo]\n## Purpose\nKeep existing behavior.\n## Requirements\n### Requirement: Existing\nThe system SHALL keep existing behavior.\n',
  );
  fs.writeFileSync(
    path.join(repository, 'src/README.md'),
    `# Feature\n<!-- jigwright:module-why -->\nKeep the existing design rationale.\nConfirmed at commit: \`${'a'.repeat(40)}\`\n<!-- /jigwright:module-why -->\n`,
  );
  const counter = path.join(repository, '.git', 'document-check-count');
  fs.writeFileSync(
    path.join(repository, 'scripts/document-count.mjs'),
    "import fs from 'node:fs';\nconst p=process.argv[2];\nfs.writeFileSync(p,String((fs.existsSync(p)?Number(fs.readFileSync(p,'utf8')):0)+1));\n",
  );
  configureChecks(
    repository,
    {
      counted: {
        command: ['node', 'scripts/document-count.mjs', counter],
        destructiveDatabase: false,
      },
    },
    ['counted'],
  );
  git(repository, ['checkout', '-b', 'work/demo-change']);
  writeReadyV3ExemptChange(repository);
  commitPlanningTransition(repository, 'demo-change');
  const session = startSession(repository, 'demo-change', '1.1');
  fs.writeFileSync(path.join(repository, 'src/feature.ts'), 'export {};\n');
  return { repository, sessionId: session.sessionId, counter };
}

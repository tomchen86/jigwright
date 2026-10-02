import { maintainerManifestOperations } from '../src/composition-root/maintainer-manifest-production.ts';
import { productionTaskStrategyExecutionGate } from '../src/composition-root/task-strategy-gate-production.ts';
import { productionChangeContract } from '../src/composition-root/change-routing-observation-production.ts';
import test from 'node:test';
import { startSession } from '../src/application/execute-task/session.ts';
import fs from 'node:fs';
import path from 'node:path';
import { sealTaskStrategyRed } from '../src/composition-root/task-strategy-execution-production.ts';
import {
  beginTaskStrategyImplementation,
  inspectTaskStrategyImplementation,
} from '../src/composition-root/task-strategy-production.ts';
import assert from 'node:assert/strict';
import { type CollaborationGrantRequest } from '../src/modules/authority/collaboration-grant-codec.ts';
import { issueCollaborationGrant } from '../src/composition-root/collaboration-grant-issuance-production.ts';
import {
  authoritativeCollaborationGrantVerifierForTest,
  runtimeRoot,
} from './fixture.ts';
import { readTaskStrategyPatchRecord } from '../src/runtime/storage-journal/task-strategy-patch-store.ts';
import { loadInvestigationRuntimeContext } from '../src/composition-root/lifecycle-context.ts';
import { inspectCollaborationGrants } from '../src/runtime/storage-journal/collaboration-grant-records.ts';
import { checkSession } from './support/local-engine-selection-host.ts';
import {
  createCrossAgentFixture,
  collaborationSigner,
  diffAgainstTree,
  sha256Buffer,
  hasCode,
  callerImplementationGrantRequest,
} from './support/task-strategy-execution-fixture.ts';

test('zero callable implementers expose only caller-supplied collaboration recovery', () => {
  const { repository } = createCrossAgentFixture(
    'assertion',
    'cross-agent-tdd',
    { codex: false, claude: false },
  );
  try {
    const session = startSession(
      productionChangeContract,
      repository,
      'demo-change',
      '1.1',
    );
    fs.mkdirSync(path.join(repository, 'test'), { recursive: true });
    fs.writeFileSync(
      path.join(repository, 'test/feature.test.mjs'),
      "throw new Error('feature behavior is not implemented');\n",
    );
    sealTaskStrategyRed(repository, session.sessionId, {
      explicitActor: 'codex',
      environment: {},
    });

    const paused = beginTaskStrategyImplementation(
      repository,
      session.sessionId,
    );
    assert.equal(paused.state, 'collaboration-grant-required');
    if (paused.state !== 'collaboration-grant-required') return;
    assert.equal(paused.inputSchema.grantRequest, null);
    assert.deepEqual(paused.inputSchema.allowedDegradedForms, [
      'caller-supplied',
    ]);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('zero-provider caller patch imports only through an exact consumed collaboration grant', () => {
  const { repository, counterPath } = createCrossAgentFixture(
    'assertion',
    'cross-agent-tdd',
    { codex: false, claude: false },
    true,
  );
  const policy = JSON.parse(
    fs.readFileSync(
      path.join(repository, 'workflow/maintainer-policy.json'),
      'utf8',
    ),
  ) as { trustedSigners: Array<{ identity: string }> };
  const signer = collaborationSigner(policy.trustedSigners[0]!.identity);
  try {
    const session = startSession(
      productionChangeContract,
      repository,
      'demo-change',
      '1.1',
    );
    fs.mkdirSync(path.join(repository, 'test'), { recursive: true });
    fs.writeFileSync(
      path.join(repository, 'test/feature.test.mjs'),
      "throw new Error('feature behavior is not implemented');\n",
    );
    const red = sealTaskStrategyRed(repository, session.sessionId, {
      explicitActor: 'codex',
      environment: {},
    });
    const paused = beginTaskStrategyImplementation(
      repository,
      session.sessionId,
    );
    assert.equal(paused.state, 'collaboration-grant-required');
    if (paused.state !== 'collaboration-grant-required') return;
    const callerId = 'external-implementation-caller';
    const request: CollaborationGrantRequest = {
      changeId: 'demo-change',
      taskId: '1.1',
      baselineCommit: session.baseline.head,
      baselineTree: session.baseline.tree,
      targetDigest: paused.subject.subjectDigest,
      lifecyclePhase: 'task-implementation',
      rolePair: {
        authorRole: 'red-author',
        conflictingRole: 'task-implementer',
      },
      availableActor: {
        kind: 'caller',
        callerId,
        assurance: 'self-declared',
      },
      degradedForm: 'caller-supplied',
      reason:
        'No callable task implementation provider is enabled for this exact sealed RED subject.',
      ttlMinutes: 30,
      maxUses: 1,
    };
    const issued = issueCollaborationGrant(repository, request, { signer });
    const implementationPath = path.join(repository, 'src/feature.ts');
    fs.mkdirSync(path.dirname(implementationPath), { recursive: true });
    fs.writeFileSync(implementationPath, 'export const feature = true;\n');
    const patch = diffAgainstTree(repository, red.red.candidateTree, [
      'src/feature.ts',
    ]);
    fs.rmSync(implementationPath);

    const imported = beginTaskStrategyImplementation(
      repository,
      session.sessionId,
      {
        collaborationGrant: {
          grantId: issued.grantId,
          verifier: authoritativeCollaborationGrantVerifierForTest(signer),
          callerSupplied: {
            callerId,
            assurance: 'self-declared',
            patch,
          },
        },
      },
    );
    assert.equal(imported.state, 'patch-imported');
    const patchRecord = readTaskStrategyPatchRecord(
      loadInvestigationRuntimeContext(repository).runtime,
      session.sessionId,
      sha256Buffer(patch),
      red.red.candidateTree,
    );
    assert.ok(patchRecord);
    assert.equal(patchRecord.implementer.providerId, null);
    assert.equal(patchRecord.implementer.principalId, callerId);
    assert.equal(
      inspectCollaborationGrants(
        fs.realpathSync(path.join(repository, '.git')),
        issued.grantId,
      )[0]?.state,
      'consumed',
    );
    assert.equal(
      fs.readFileSync(implementationPath, 'utf8'),
      'export const feature = true;\n',
    );
    const callerResultPath = path.join(
      runtimeRoot(repository),
      'investigations/refs/task-strategy-implementations',
      session.sessionId,
      'subjects',
      paused.subject.subjectDigest,
      'caller-result.json',
    );
    const heldCallerResultPath = `${callerResultPath}.held`;
    fs.renameSync(callerResultPath, heldCallerResultPath);
    assert.throws(
      () =>
        checkSession(
          maintainerManifestOperations,
          productionTaskStrategyExecutionGate,
          productionChangeContract,
          repository,
          session.sessionId,
          { environment: {} },
        ),
      hasCode('TASK_STRATEGY_CORRECTION_STATE_STALE'),
    );
    assert.equal(fs.readFileSync(counterPath, 'utf8'), '1');
    fs.renameSync(heldCallerResultPath, callerResultPath);
    assert.equal(
      checkSession(
        maintainerManifestOperations,
        productionTaskStrategyExecutionGate,
        productionChangeContract,
        repository,
        session.sessionId,
        { environment: {} },
      ).passed,
      true,
    );
    assert.equal(fs.readFileSync(counterPath, 'utf8'), '2');
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('zero-provider caller patch validates frozen RED bytes before reserving its grant', () => {
  const { repository } = createCrossAgentFixture(
    'assertion',
    'cross-agent-tdd',
    { codex: false, claude: false },
    true,
  );
  const policy = JSON.parse(
    fs.readFileSync(
      path.join(repository, 'workflow/maintainer-policy.json'),
      'utf8',
    ),
  ) as { trustedSigners: Array<{ identity: string }> };
  const signer = collaborationSigner(policy.trustedSigners[0]!.identity);
  try {
    const session = startSession(
      productionChangeContract,
      repository,
      'demo-change',
      '1.1',
    );
    const testPath = path.join(repository, 'test/feature.test.mjs');
    const originalTest =
      "throw new Error('feature behavior is not implemented');\n";
    fs.mkdirSync(path.dirname(testPath), { recursive: true });
    fs.writeFileSync(testPath, originalTest);
    const red = sealTaskStrategyRed(repository, session.sessionId, {
      explicitActor: 'codex',
      environment: {},
    });
    const paused = beginTaskStrategyImplementation(
      repository,
      session.sessionId,
    );
    assert.equal(paused.state, 'collaboration-grant-required');
    if (paused.state !== 'collaboration-grant-required') return;
    const callerId = 'external-implementation-caller';
    const issued = issueCollaborationGrant(
      repository,
      callerImplementationGrantRequest(
        session,
        paused.subject.subjectDigest,
        callerId,
      ),
      { signer },
    );
    fs.writeFileSync(testPath, "throw new Error('weakened RED');\n");
    const patch = diffAgainstTree(repository, red.red.candidateTree, [
      'test/feature.test.mjs',
    ]);
    fs.writeFileSync(testPath, originalTest);

    assert.throws(
      () =>
        beginTaskStrategyImplementation(repository, session.sessionId, {
          collaborationGrant: {
            grantId: issued.grantId,
            verifier: authoritativeCollaborationGrantVerifierForTest(signer),
            callerSupplied: {
              callerId,
              assurance: 'self-declared',
              patch,
            },
          },
        }),
      hasCode('TASK_STRATEGY_PATCH_FROZEN_PATH'),
    );
    assert.equal(
      inspectCollaborationGrants(
        fs.realpathSync(path.join(repository, '.git')),
        issued.grantId,
      )[0]?.state,
      'available',
    );
    assert.equal(fs.readFileSync(testPath, 'utf8'), originalTest);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('durable consumed caller grant resumes the exact patch after interruption', () => {
  const { repository } = createCrossAgentFixture(
    'assertion',
    'cross-agent-tdd',
    { codex: false, claude: false },
    true,
  );
  const policy = JSON.parse(
    fs.readFileSync(
      path.join(repository, 'workflow/maintainer-policy.json'),
      'utf8',
    ),
  ) as { trustedSigners: Array<{ identity: string }> };
  const signer = collaborationSigner(policy.trustedSigners[0]!.identity);
  try {
    const session = startSession(
      productionChangeContract,
      repository,
      'demo-change',
      '1.1',
    );
    fs.mkdirSync(path.join(repository, 'test'), { recursive: true });
    fs.writeFileSync(
      path.join(repository, 'test/feature.test.mjs'),
      "throw new Error('feature behavior is not implemented');\n",
    );
    const red = sealTaskStrategyRed(repository, session.sessionId, {
      explicitActor: 'codex',
      environment: {},
    });
    const paused = beginTaskStrategyImplementation(
      repository,
      session.sessionId,
    );
    assert.equal(paused.state, 'collaboration-grant-required');
    if (paused.state !== 'collaboration-grant-required') return;
    const callerId = 'external-implementation-caller';
    const issued = issueCollaborationGrant(
      repository,
      callerImplementationGrantRequest(
        session,
        paused.subject.subjectDigest,
        callerId,
      ),
      { signer },
    );
    const implementationPath = path.join(repository, 'src/feature.ts');
    fs.mkdirSync(path.dirname(implementationPath), { recursive: true });
    fs.writeFileSync(implementationPath, 'export const feature = true;\n');
    const patch = diffAgainstTree(repository, red.red.candidateTree, [
      'src/feature.ts',
    ]);
    fs.rmSync(implementationPath);
    const exactInput = {
      collaborationGrant: {
        grantId: issued.grantId,
        verifier: authoritativeCollaborationGrantVerifierForTest(signer),
        callerSupplied: {
          callerId,
          assurance: 'self-declared' as const,
          patch,
        },
      },
    };

    assert.throws(
      () =>
        beginTaskStrategyImplementation(repository, session.sessionId, {
          ...exactInput,
          testCrashAfter: 'provider-result-persisted',
        }),
      /caller result persistence/,
    );
    assert.equal(fs.existsSync(implementationPath), false);
    assert.equal(
      inspectCollaborationGrants(
        fs.realpathSync(path.join(repository, '.git')),
        issued.grantId,
      )[0]?.state,
      'consumed',
    );
    assert.equal(
      inspectTaskStrategyImplementation(repository, session.sessionId).state,
      'caller-supplied-awaiting-import',
    );

    const resumed = beginTaskStrategyImplementation(
      repository,
      session.sessionId,
      exactInput,
    );
    assert.equal(resumed.state, 'patch-imported');
    assert.equal(
      fs.readFileSync(implementationPath, 'utf8'),
      'export const feature = true;\n',
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

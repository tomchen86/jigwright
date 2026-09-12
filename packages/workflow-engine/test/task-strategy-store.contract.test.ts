import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import { COLLABORATION_GRANT_AUTHORIZED_EFFECT } from '../src/modules/authority/collaboration-grant-codec.ts';
import {
  COLLABORATION_GRANT_REPLAY_SCOPE,
  COLLABORATION_GRANT_RESIDUALS,
  COLLABORATION_GRANT_RETAINED_OBLIGATIONS,
  COLLABORATION_GRANT_V2_SIGNATURE_NAMESPACE,
} from '../src/modules/authority/collaboration-grant-codec.ts';
import type { InvestigationRuntimePaths } from '../src/runtime/session-workspace/paths.ts';
import { createProviderInvocationRequest } from '../src/modules/provider-orchestration/provider-contracts.ts';
import { admitRoleResult } from '../src/composition-root/role-admission-production.ts';
import { scheduleOrdinaryRole } from '../src/modules/provider-orchestration/role-assignment.ts';
import {
  createTaskStrategyPatchCurrentBinding,
  createTaskStrategyPatchImportReceipt,
  createTaskStrategyPatchRecord,
  createTaskStrategyPatchReservation,
  readTaskStrategyPatchCurrentBinding,
  readTaskStrategyPatchImportReceipt,
  readTaskStrategyPatchRecord,
  readTaskStrategyPatchReservation,
} from '../src/runtime/storage-journal/task-strategy-patch-store.ts';
import {
  TASK_STRATEGY_IMPLEMENTATION_OUTPUT_SCHEMA,
  TASK_STRATEGY_IMPLEMENTATION_POLICY_DIGEST,
  createTaskStrategyImplementationManifest,
  createTaskStrategyImplementationSubject,
} from '../src/modules/provider-orchestration/task-strategy-provider-contract.ts';
import type { TaskStrategyImplementationSubject } from '../src/modules/provider-orchestration/task-strategy-implementation-manifest.ts';
import {
  createTaskStrategyCallerImplementationBinding,
  createTaskStrategyCallerImplementationReservation,
  createTaskStrategyImplementationReservation,
  createTaskStrategyImplementationResultBinding,
  readTaskStrategyCallerImplementationBinding,
  readTaskStrategyCallerImplementationReservation,
  readTaskStrategyImplementationReservation,
  readTaskStrategyImplementationResultBinding,
  type TaskStrategyCallerImplementationReservation,
  type TaskStrategyImplementationReservation,
} from '../src/runtime/storage-journal/task-strategy-provider-store.ts';

const SESSION_ID = 'session-repeated-red';
const SOURCE_A = '1'.repeat(40);
const SOURCE_B = '2'.repeat(40);
const SOURCE_UNKNOWN = '3'.repeat(40);

test('provider strategy stores persist every record under its exact subject', () => {
  const fixture = createRuntimeFixture();
  try {
    const first = createProviderFixture(fixture, 'a');
    const second = createProviderFixture(fixture, 'b');

    const firstReservation = createTaskStrategyImplementationReservation(
      fixture.paths,
      first.reservation,
    );
    const secondReservation = createTaskStrategyImplementationReservation(
      fixture.paths,
      second.reservation,
    );
    const firstResult = createTaskStrategyImplementationResultBinding(
      fixture.paths,
      first.result,
    );
    const secondResult = createTaskStrategyImplementationResultBinding(
      fixture.paths,
      second.result,
    );
    const firstCallerReservation =
      createTaskStrategyCallerImplementationReservation(
        fixture.paths,
        first.callerReservation,
      );
    const secondCallerReservation =
      createTaskStrategyCallerImplementationReservation(
        fixture.paths,
        second.callerReservation,
      );
    const firstCaller = createTaskStrategyCallerImplementationBinding(
      fixture.paths,
      first.caller,
    );
    const secondCaller = createTaskStrategyCallerImplementationBinding(
      fixture.paths,
      second.caller,
    );

    assert.equal(
      readTaskStrategyImplementationReservation(
        fixture.paths,
        SESSION_ID,
        first.subject.subjectDigest,
      )?.recordDigest,
      firstReservation.recordDigest,
    );
    assert.equal(
      readTaskStrategyImplementationReservation(
        fixture.paths,
        SESSION_ID,
        second.subject.subjectDigest,
      )?.recordDigest,
      secondReservation.recordDigest,
    );
    assert.equal(
      readTaskStrategyImplementationResultBinding(
        fixture.paths,
        SESSION_ID,
        first.subject.subjectDigest,
      )?.bindingDigest,
      firstResult.bindingDigest,
    );
    assert.equal(
      readTaskStrategyImplementationResultBinding(
        fixture.paths,
        SESSION_ID,
        second.subject.subjectDigest,
      )?.bindingDigest,
      secondResult.bindingDigest,
    );
    assert.equal(
      readTaskStrategyCallerImplementationReservation(
        fixture.paths,
        SESSION_ID,
        first.subject.subjectDigest,
      )?.reservationDigest,
      firstCallerReservation.reservationDigest,
    );
    assert.equal(
      readTaskStrategyCallerImplementationReservation(
        fixture.paths,
        SESSION_ID,
        second.subject.subjectDigest,
      )?.reservationDigest,
      secondCallerReservation.reservationDigest,
    );
    assert.equal(
      readTaskStrategyCallerImplementationBinding(
        fixture.paths,
        SESSION_ID,
        first.subject.subjectDigest,
      )?.bindingDigest,
      firstCaller.bindingDigest,
    );
    assert.equal(
      readTaskStrategyCallerImplementationBinding(
        fixture.paths,
        SESSION_ID,
        second.subject.subjectDigest,
      )?.bindingDigest,
      secondCaller.bindingDigest,
    );
    assert.equal(
      readTaskStrategyImplementationReservation(
        fixture.paths,
        SESSION_ID,
        digest('unknown-subject'),
      ),
      null,
    );

    for (const filename of [
      'reservation.json',
      'result.json',
      'caller-reservation.json',
      'caller-result.json',
    ]) {
      assert.equal(
        fs.existsSync(
          path.join(
            fixture.paths.refs,
            'task-strategy-implementations',
            SESSION_ID,
            filename,
          ),
        ),
        false,
        `retired session singleton remains absent: ${filename}`,
      );
      for (const subject of [first.subject, second.subject]) {
        assert.equal(
          fs.existsSync(
            path.join(
              fixture.paths.refs,
              'task-strategy-implementations',
              SESSION_ID,
              'subjects',
              subject.subjectDigest,
              filename,
            ),
          ),
          true,
          `exact subject record is durable: ${subject.subjectDigest}/${filename}`,
        );
      }
    }

    assert.throws(
      () =>
        createTaskStrategyImplementationReservation(fixture.paths, {
          ...first.reservation,
          createdAt: '2026-08-13T01:00:00.000Z',
        }),
      hasCode('TASK_STRATEGY_IMPLEMENTATION_RESERVATION_CONFLICT'),
    );
  } finally {
    fs.rmSync(fixture.base, { recursive: true, force: true });
  }
});

test('provider strategy readers ignore a retired session singleton', () => {
  const fixture = createRuntimeFixture();
  try {
    const current = createProviderFixture(fixture, 'a');
    createTaskStrategyImplementationReservation(
      fixture.paths,
      current.reservation,
    );
    const directory = path.join(
      fixture.paths.refs,
      'task-strategy-implementations',
      SESSION_ID,
    );
    fs.renameSync(
      path.join(
        directory,
        'subjects',
        current.subject.subjectDigest,
        'reservation.json',
      ),
      path.join(directory, 'reservation.json'),
    );

    assert.equal(
      readTaskStrategyImplementationReservation(
        fixture.paths,
        SESSION_ID,
        current.subject.subjectDigest,
      ),
      null,
    );
  } finally {
    fs.rmSync(fixture.base, { recursive: true, force: true });
  }
});

test('provider strategy stores reject the superseded output schema identity', () => {
  const fixture = createRuntimeFixture();
  try {
    const current = createProviderFixture(fixture, 'a');
    const currentRequest = current.reservation.request;
    const legacyOutputSchema = {
      ...TASK_STRATEGY_IMPLEMENTATION_OUTPUT_SCHEMA,
      id: 'expense-app.workflow.task-strategy-implementation-output',
    };
    const legacyRequest = createProviderInvocationRequest({
      invocationId: currentRequest.invocationId,
      nonce: currentRequest.nonce,
      purpose: currentRequest.purpose,
      providerId: currentRequest.providerId,
      roleAssignment: currentRequest.roleAssignment,
      capabilityProfile: currentRequest.capabilityProfile,
      repositoryId: currentRequest.repositoryId,
      baseCommit: currentRequest.baseCommit,
      baseTree: currentRequest.baseTree,
      targetDigest: currentRequest.targetDigest,
      inputManifestDigest: currentRequest.inputManifestDigest,
      authorizationNodeId: currentRequest.authorizationNodeId,
      writeAllowedPaths: [],
      outputSchema: legacyOutputSchema,
      evaluatorVersion: currentRequest.evaluatorVersion,
      policyDigest: currentRequest.policyDigest,
      limits: currentRequest.limits,
    });

    assert.throws(
      () =>
        createTaskStrategyImplementationReservation(fixture.paths, {
          ...current.reservation,
          request: legacyRequest,
        }),
      hasCode('TASK_STRATEGY_IMPLEMENTATION_STATE_CORRUPT'),
    );

    const { resultDigest: _resultDigest, ...currentRoleResultBody } =
      current.result.roleResult;
    const legacyRoleResultBody = {
      ...currentRoleResultBody,
      content: {
        ...currentRoleResultBody.content,
        outputSchema: legacyOutputSchema,
      },
    };
    const legacyRoleResult = {
      ...legacyRoleResultBody,
      resultDigest: digest(
        canonicalJson({
          schema: 'admitted-role-result.v1',
          ...legacyRoleResultBody,
        }),
      ),
    };
    assert.throws(
      () =>
        createTaskStrategyImplementationResultBinding(fixture.paths, {
          ...current.result,
          roleResult: legacyRoleResult,
        }),
      hasCode('TASK_STRATEGY_IMPLEMENTATION_STATE_CORRUPT'),
    );
  } finally {
    fs.rmSync(fixture.base, { recursive: true, force: true });
  }
});

test('patch strategy stores persist every record under its exact source tree', () => {
  const fixture = createRuntimeFixture();
  try {
    const first = createPatchFixture(fixture.paths, 'a', SOURCE_A, '4');
    const second = createPatchFixture(fixture.paths, 'b', SOURCE_B, '5');

    const firstReservation = createTaskStrategyPatchReservation(
      fixture.paths,
      first.reservation,
    );
    const secondReservation = createTaskStrategyPatchReservation(
      fixture.paths,
      second.reservation,
    );
    const firstCurrent = createTaskStrategyPatchCurrentBinding(
      fixture.paths,
      first.current,
      SOURCE_A,
    );
    const secondCurrent = createTaskStrategyPatchCurrentBinding(
      fixture.paths,
      second.current,
      SOURCE_B,
    );

    assert.equal(
      readTaskStrategyPatchReservation(fixture.paths, SESSION_ID, SOURCE_A)
        ?.reservationDigest,
      firstReservation.reservationDigest,
    );
    assert.equal(
      readTaskStrategyPatchReservation(fixture.paths, SESSION_ID, SOURCE_B)
        ?.reservationDigest,
      secondReservation.reservationDigest,
    );
    assert.equal(
      readTaskStrategyPatchCurrentBinding(fixture.paths, SESSION_ID, SOURCE_A)
        ?.bindingDigest,
      firstCurrent.bindingDigest,
    );
    assert.equal(
      readTaskStrategyPatchCurrentBinding(fixture.paths, SESSION_ID, SOURCE_B)
        ?.bindingDigest,
      secondCurrent.bindingDigest,
    );
    assert.equal(
      readTaskStrategyPatchReservation(
        fixture.paths,
        SESSION_ID,
        SOURCE_UNKNOWN,
      ),
      null,
    );
    assert.equal(
      readTaskStrategyPatchCurrentBinding(
        fixture.paths,
        SESSION_ID,
        SOURCE_UNKNOWN,
      ),
      null,
    );

    assert.equal(
      fs.existsSync(
        path.join(
          fixture.paths.refs,
          'task-strategy-patches',
          SESSION_ID,
          'reservation.json',
        ),
      ),
      false,
    );
    assert.equal(
      fs.existsSync(
        path.join(
          fixture.paths.refs,
          'task-strategy-patches',
          SESSION_ID,
          'current.json',
        ),
      ),
      false,
    );
    assert.equal(
      fs.existsSync(
        path.join(
          fixture.paths.refs,
          'task-strategy-patches',
          SESSION_ID,
          `${first.reservation.patchDigest}.json`,
        ),
      ),
      false,
    );
    assert.equal(
      fs.existsSync(
        path.join(
          fixture.paths.refs,
          'task-strategy-patches',
          SESSION_ID,
          'sources',
          SOURCE_A,
          'reservation.json',
        ),
      ),
      true,
    );
    assert.equal(
      fs.existsSync(
        path.join(
          fixture.paths.refs,
          'task-strategy-patches',
          SESSION_ID,
          'sources',
          SOURCE_B,
          'current.json',
        ),
      ),
      true,
    );

    assert.throws(
      () =>
        createTaskStrategyPatchReservation(fixture.paths, {
          ...first.reservation,
          createdAt: '2026-08-13T01:00:00.000Z',
        }),
      hasCode('TASK_STRATEGY_PATCH_RESERVATION_CONFLICT'),
    );
  } finally {
    fs.rmSync(fixture.base, { recursive: true, force: true });
  }
});

test('identical correction patch bytes remain distinct across source trees', () => {
  const fixture = createRuntimeFixture();
  try {
    const patchBytes = Buffer.from('same-delta-bytes');
    const patchDigest = digestBytes(patchBytes);
    const createRecord = (sourceTree: string, candidateTree: string) =>
      createTaskStrategyPatchRecord(fixture.paths, {
        sessionId: SESSION_ID,
        changeId: 'demo-change',
        taskId: '1.1',
        strategy: 'tdd-single-agent',
        sourceTree,
        candidateTree,
        taskContractDigest: digest('task-contract'),
        patchDigest,
        patchBase64: patchBytes.toString('base64'),
        changedPaths: ['src/feature.ts'],
        changes: [
          {
            path: 'src/feature.ts',
            before: { mode: '100644', objectId: sourceTree },
            after: { mode: '100644', objectId: candidateTree },
          },
        ],
        implementer: {
          providerId: 'codex',
          assurance: 'adapter-assigned',
        },
        createdAt: '2026-08-13T00:07:00.000Z',
      });
    const first = createRecord(SOURCE_A, '6'.repeat(40));
    const second = createRecord(SOURCE_B, '7'.repeat(40));
    const firstReceipt = createTaskStrategyPatchImportReceipt(
      fixture.paths,
      {
        recordDigest: first.recordDigest,
        sessionId: SESSION_ID,
        patchDigest,
        candidateTree: first.candidateTree,
        importedAt: '2026-08-13T00:08:00.000Z',
      },
      SOURCE_A,
    );
    const secondReceipt = createTaskStrategyPatchImportReceipt(
      fixture.paths,
      {
        recordDigest: second.recordDigest,
        sessionId: SESSION_ID,
        patchDigest,
        candidateTree: second.candidateTree,
        importedAt: '2026-08-13T00:09:00.000Z',
      },
      SOURCE_B,
    );

    assert.equal(
      fs.existsSync(
        path.join(
          fixture.paths.refs,
          'task-strategy-patches',
          SESSION_ID,
          `${patchDigest}.imported.json`,
        ),
      ),
      false,
    );
    assert.equal(
      fs.existsSync(
        path.join(
          fixture.paths.refs,
          'task-strategy-patches',
          SESSION_ID,
          'sources',
          SOURCE_A,
          `${patchDigest}.imported.json`,
        ),
      ),
      true,
    );
    assert.equal(
      fs.existsSync(
        path.join(
          fixture.paths.refs,
          'task-strategy-patches',
          SESSION_ID,
          'sources',
          SOURCE_B,
          `${patchDigest}.imported.json`,
        ),
      ),
      true,
    );

    assert.equal(
      readTaskStrategyPatchRecord(
        fixture.paths,
        SESSION_ID,
        patchDigest,
        SOURCE_A,
      )?.recordDigest,
      first.recordDigest,
    );
    assert.equal(
      readTaskStrategyPatchRecord(
        fixture.paths,
        SESSION_ID,
        patchDigest,
        SOURCE_B,
      )?.recordDigest,
      second.recordDigest,
    );
    assert.equal(
      readTaskStrategyPatchImportReceipt(
        fixture.paths,
        SESSION_ID,
        patchDigest,
        SOURCE_A,
      )?.receiptDigest,
      firstReceipt.receiptDigest,
    );
    assert.equal(
      readTaskStrategyPatchImportReceipt(
        fixture.paths,
        SESSION_ID,
        patchDigest,
        SOURCE_B,
      )?.receiptDigest,
      secondReceipt.receiptDigest,
    );
  } finally {
    fs.rmSync(fixture.base, { recursive: true, force: true });
  }
});

function createProviderFixture(
  fixture: ReturnType<typeof createRuntimeFixture>,
  label: 'a' | 'b',
) {
  const sourceTree = label === 'a' ? SOURCE_A : SOURCE_B;
  const subject = createSubject(label, sourceTree);
  const redAuthor = {
    providerId: 'codex' as const,
    sessionId: 'author-session',
    principalId: 'codex',
    identityAssurance: 'self-declared' as const,
    engineSpawned: false as const,
  };
  const scheduled = scheduleOrdinaryRole({
    role: 'task-implementer',
    author: redAuthor,
    targetDigest: subject.subjectDigest,
    candidates: [
      {
        providerId: 'claude',
        sessionId: `provider-session-${label}`,
        enabled: true,
        available: true,
      },
    ],
  });
  assert.equal(scheduled.outcome, 'assigned');
  if (scheduled.outcome !== 'assigned') throw new Error('unreachable');
  const assignment = scheduled.assignment;
  const manifest = createTaskStrategyImplementationManifest({
    repositoryId: 'expense-app',
    baseCommit: '6'.repeat(40),
    baseTree: '7'.repeat(40),
    subject,
    behaviorContractRefs: [
      {
        specPath: 'specs/demo/spec.md',
        requirement: 'Repeated RED subjects remain independently addressable',
        scenario: null,
      },
    ],
    implementationPathScopes: ['src/**'],
  });
  const authorizationNodeId = digest(`authorization-${label}`);
  const request = createProviderInvocationRequest({
    invocationId: `invocation-task-implementation-${label}`,
    nonce: `task-implementation-${label}-nonce`,
    purpose: 'task-implementation',
    providerId: assignment.providerId,
    roleAssignment: assignment,
    capabilityProfile: 'repository-read-only',
    repositoryId: 'expense-app',
    baseCommit: manifest.baseCommit,
    baseTree: manifest.baseTree,
    targetDigest: subject.subjectDigest,
    inputManifestDigest: digest(canonicalJson(manifest)),
    authorizationNodeId,
    writeAllowedPaths: [],
    outputSchema: TASK_STRATEGY_IMPLEMENTATION_OUTPUT_SCHEMA,
    evaluatorVersion: 'task-strategy-implementation.v1',
    policyDigest: TASK_STRATEGY_IMPLEMENTATION_POLICY_DIGEST,
    limits: { timeoutMs: 10_000, aggregateOutputBytes: 100_000 },
  });
  const outputBytes = Buffer.from(`patch-${label}`);
  const output = {
    schemaVersion: 1 as const,
    kind: 'task-strategy-patch-output.v1' as const,
    sessionId: SESSION_ID,
    sourceTree,
    patchBase64: outputBytes.toString('base64'),
    patchDigest: digestBytes(outputBytes),
  };
  const providerObservationNodeId = digest(`observation-node-${label}`);
  const providerObservationDigest = digest(`observation-result-${label}`);
  const outputDigest = digest(canonicalJson(output));
  const roleResult = admitRoleResult({
    assignment,
    author: redAuthor,
    participant: {
      providerId: assignment.providerId,
      sessionId: assignment.sessionId,
      principalId: `provider:${assignment.providerId}`,
      identityAssurance: 'adapter-assigned',
      engineSpawned: true,
    },
    content: {
      kind: 'task-implementation',
      nodeId: providerObservationNodeId,
      resultDigest: providerObservationDigest,
      outputSchema: TASK_STRATEGY_IMPLEMENTATION_OUTPUT_SCHEMA,
      evaluator: 'task-strategy-implementation.v1',
      policyDigest: TASK_STRATEGY_IMPLEMENTATION_POLICY_DIGEST,
      contentDigest: providerObservationDigest,
      current: true,
    },
    providerInvocation: {
      invocationId: request.invocationId,
      requestDigest: request.requestDigest,
      outputDigest,
      providerId: assignment.providerId,
      sessionId: assignment.sessionId,
      targetDigest: subject.subjectDigest,
      engineSpawned: true,
    },
    grantUse: null,
    grantValidation: null,
  });
  const callerReservation = createCallerReservation(subject, output, label);
  return {
    subject,
    reservation: {
      ownerInvestigationId: `investigation-task-implementation-${label}`,
      sessionId: SESSION_ID,
      changeId: 'demo-change',
      taskId: '1.1',
      repositoryRoot: fixture.base,
      gitCommonDirectory: fixture.base,
      branch: 'work/demo-change',
      baseline: { head: manifest.baseCommit, tree: manifest.baseTree },
      mandateBinding: null,
      subject,
      redAuthor,
      assignment,
      manifest,
      request,
      authorizationNodeId,
      reservationNodeId: digest(`reservation-node-${label}`),
      createdAt: `2026-08-13T00:00:0${label === 'a' ? '1' : '2'}.000Z`,
    } satisfies Parameters<
      typeof createTaskStrategyImplementationReservation
    >[1],
    result: {
      ownerInvestigationId: `investigation-task-implementation-${label}`,
      sessionId: SESSION_ID,
      subjectDigest: subject.subjectDigest,
      invocationId: request.invocationId,
      requestDigest: request.requestDigest,
      outputDigest,
      runtimeObservationDigest: digest(`runtime-observation-${label}`),
      providerObservationNodeId,
      providerObservationDigest,
      providerResultNodeId: digest(`provider-result-node-${label}`),
      providerResultDigest: digest(`provider-result-${label}`),
      roleResult,
      output,
      createdAt: `2026-08-13T00:01:0${label === 'a' ? '1' : '2'}.000Z`,
    } satisfies Parameters<
      typeof createTaskStrategyImplementationResultBinding
    >[1],
    callerReservation,
    caller: createCallerBinding(callerReservation, label),
  };
}

function createCallerReservation(
  subject: TaskStrategyImplementationSubject,
  output: {
    schemaVersion: 1;
    kind: 'task-strategy-patch-output.v1';
    sessionId: string;
    sourceTree: string;
    patchBase64: string;
    patchDigest: string;
  },
  label: 'a' | 'b',
): Parameters<typeof createTaskStrategyCallerImplementationReservation>[1] {
  const grantId = `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa${label === 'a' ? '1' : '2'}`;
  const transitionDigest = digest(`transition-${label}`);
  const assignment = {
    role: 'task-implementer' as const,
    providerId: null,
    sessionId: null,
    targetDigest: subject.subjectDigest,
    requiredIndependence: 'provider-independent' as const,
    achievedIndependence: 'none' as const,
    providerIndependent: false as const,
    sessionIndependent: false,
    engineSpawned: false,
    orchestration: 'caller-supplied' as const,
    grantId,
    degradedForm: 'caller-supplied' as const,
    authorizedEffect: COLLABORATION_GRANT_AUTHORIZED_EFFECT,
    author: {
      providerId: 'codex' as const,
      sessionId: 'author-session',
      principalId: 'codex',
      identityAssurance: 'self-declared' as const,
      engineSpawned: false as const,
    },
    participant: {
      providerId: null,
      sessionId: null,
      principalId: `caller-${label}`,
      identityAssurance: 'self-declared' as const,
      engineSpawned: false as const,
    },
    callableProviderIds: [],
    directHumanReviewAttestationDigest: null,
  };
  return {
    sessionId: SESSION_ID,
    subjectDigest: subject.subjectDigest,
    grantId,
    transitionDigest,
    assignment,
    submissionNodeId: digest(`caller-submission-node-${label}`),
    submissionResultDigest: digest(`caller-submission-result-${label}`),
    output,
    createdAt: `2026-08-13T00:02:0${label === 'a' ? '1' : '2'}.000Z`,
  };
}

function createCallerBinding(
  reservation: Parameters<
    typeof createTaskStrategyCallerImplementationReservation
  >[1],
  label: 'a' | 'b',
): Parameters<typeof createTaskStrategyCallerImplementationBinding>[1] {
  const callerId = reservation.assignment.participant.principalId;
  const callerAssurance = reservation.assignment.participant.identityAssurance;
  if (callerId === null || callerAssurance === 'maintainer-signed') {
    throw new Error('caller reservation fixture is invalid');
  }
  const envelope = {
    payload: {
      version: 2 as const,
      signatureNamespace: COLLABORATION_GRANT_V2_SIGNATURE_NAMESPACE,
      grantId: reservation.grantId,
      repositoryId: 'expense-app',
      repositoryOrigin: 'git@example.invalid:expense-app.git',
      policyBlob: '0'.repeat(40),
      collaborationPolicyDigest: digest('collaboration-policy'),
      changeId: 'demo-change',
      taskId: '1.1',
      baselineCommit: '6'.repeat(40),
      baselineTree: '7'.repeat(40),
      targetDigest: reservation.subjectDigest,
      lifecyclePhase: 'task-implementation' as const,
      rolePair: {
        authorRole: 'red-author' as const,
        conflictingRole: 'task-implementer' as const,
      },
      availableActor: {
        kind: 'caller' as const,
        callerId,
        assurance: callerAssurance,
      },
      degradedForm: 'caller-supplied' as const,
      authorizedEffect: COLLABORATION_GRANT_AUTHORIZED_EFFECT,
      reason: 'No independent implementation provider is callable.',
      issuedAt: reservation.createdAt,
      expiresAt: '2026-08-13T00:30:00.000Z',
      maxUses: 1 as const,
      signer: 'test-maintainer',
    },
    signature: 'test-signature',
  };
  const roleResultBody = {
    schemaVersion: 1 as const,
    form: 'granted-caller-supplied' as const,
    role: 'task-implementer' as const,
    targetDigest: reservation.subjectDigest,
    assignment: reservation.assignment,
    author: reservation.assignment.author,
    participant: reservation.assignment.participant,
    orchestration: 'caller-supplied' as const,
    requiredIndependence: 'provider-independent' as const,
    achievedIndependence: 'none' as const,
    content: {
      kind: 'task-implementation' as const,
      nodeId: reservation.submissionNodeId,
      resultDigest: reservation.submissionResultDigest,
      outputSchema: TASK_STRATEGY_IMPLEMENTATION_OUTPUT_SCHEMA,
      evaluator: 'task-strategy-implementation.v1',
      policyDigest: TASK_STRATEGY_IMPLEMENTATION_POLICY_DIGEST,
      contentDigest: reservation.submissionResultDigest,
      current: true as const,
    },
    providerInvocation: null,
    grantUse: {
      schemaVersion: 1 as const,
      degradedForm: 'caller-supplied' as const,
      grantId: reservation.grantId,
      signedEnvelopeDigest: digest(canonicalJson(envelope)),
      targetDigest: reservation.subjectDigest,
      transitionDigest: reservation.transitionDigest,
      reservedAt: reservation.createdAt,
      lifecyclePhase: 'task-implementation' as const,
      authorizedEffect: COLLABORATION_GRANT_AUTHORIZED_EFFECT,
      assignment: reservation.assignment,
      structuredContent: {
        kind: 'task-implementation' as const,
        nodeId: reservation.submissionNodeId,
        resultDigest: reservation.submissionResultDigest,
      },
      contentAuthority: 'reference-only-requires-governing-validator' as const,
      directHumanReviewAttestation: null,
      retainedObligations: COLLABORATION_GRANT_RETAINED_OBLIGATIONS,
      replayScope: COLLABORATION_GRANT_REPLAY_SCOPE,
      residuals: COLLABORATION_GRANT_RESIDUALS,
      envelope,
    },
    directHumanReviewAttestation: null,
  };
  return {
    sessionId: SESSION_ID,
    subjectDigest: reservation.subjectDigest,
    transitionDigest: reservation.transitionDigest,
    submissionNodeId: reservation.submissionNodeId,
    submissionResultDigest: reservation.submissionResultDigest,
    resultNodeId: digest(`caller-result-node-${label}`),
    resultDigest: digest(`caller-result-${label}`),
    roleResult: {
      ...roleResultBody,
      resultDigest: digest(
        canonicalJson({ schema: 'admitted-role-result.v1', ...roleResultBody }),
      ),
    },
    output: reservation.output,
    createdAt: `2026-08-13T00:03:0${label === 'a' ? '1' : '2'}.000Z`,
  };
}

function createSubject(
  label: 'a' | 'b',
  sourceTree: string,
): TaskStrategyImplementationSubject {
  return createTaskStrategyImplementationSubject({
    sessionId: SESSION_ID,
    changeId: 'demo-change',
    taskId: '1.1',
    strategy: 'cross-agent-tdd',
    transactionDigest: digest(`transaction-${label}`),
    taskContractDigest: digest('task-contract'),
    sourceTree,
    failureFingerprint: digest(`failure-${label}`),
    redEvidenceNodeId: digest(`red-node-${label}`),
    redEvidenceResultDigest: digest(`red-result-${label}`),
    testPaths: ['test/feature.test.ts'],
    fixturePaths: [],
    frozenFiles: [
      {
        path: 'test/feature.test.ts',
        mode: '100644',
        objectId: label === 'a' ? '8'.repeat(40) : '9'.repeat(40),
      },
    ],
  });
}

function createPatchFixture(
  paths: InvestigationRuntimePaths,
  label: 'a' | 'b',
  sourceTree: string,
  candidateNibble: string,
) {
  const patchBytes = Buffer.from(`patch-${label}`);
  const record = createTaskStrategyPatchRecord(paths, {
    sessionId: SESSION_ID,
    changeId: 'demo-change',
    taskId: '1.1',
    strategy: 'cross-agent-tdd',
    sourceTree,
    candidateTree: candidateNibble.repeat(40),
    taskContractDigest: digest('task-contract'),
    patchDigest: digestBytes(patchBytes),
    patchBase64: patchBytes.toString('base64'),
    changedPaths: ['src/feature.ts'],
    changes: [
      {
        path: 'src/feature.ts',
        before: null,
        after: { mode: '100644', objectId: candidateNibble.repeat(40) },
      },
    ],
    implementer: {
      providerId: 'claude',
      assurance: 'adapter-assigned',
    },
    createdAt: `2026-08-13T00:04:0${label === 'a' ? '1' : '2'}.000Z`,
  });
  return {
    reservation: {
      sessionId: SESSION_ID,
      patchDigest: record.patchDigest,
      recordDigest: record.recordDigest,
      sourceTree: record.sourceTree,
      candidateTree: record.candidateTree,
      createdAt: record.createdAt,
    },
    current: {
      sessionId: SESSION_ID,
      patchDigest: record.patchDigest,
      recordDigest: record.recordDigest,
      receiptDigest: digest(`receipt-${label}`),
      candidateTree: record.candidateTree,
      createdAt: `2026-08-13T00:05:0${label === 'a' ? '1' : '2'}.000Z`,
    },
  };
}

function createRuntimeFixture(): {
  base: string;
  paths: InvestigationRuntimePaths;
} {
  const base = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'task-strategy-store-')),
  );
  const root = path.join(base, 'workflow-engine', 'investigations');
  return {
    base,
    paths: {
      base,
      root,
      objects: path.join(root, 'objects', 'sha256'),
      refs: path.join(root, 'refs'),
      sessions: path.join(root, 'sessions'),
      invocations: path.join(root, 'invocations'),
      locks: path.join(root, 'locks'),
    },
  };
}

function digest(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function digestBytes(value: Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hasCode(expected: string): (error: unknown) => boolean {
  return (error: unknown) =>
    error instanceof Error &&
    'code' in error &&
    (error as Error & { code: string }).code === expected;
}

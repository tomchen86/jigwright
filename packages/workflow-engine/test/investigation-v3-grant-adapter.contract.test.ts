import { investigationFailureObservations } from '../src/composition-root/investigation-failure-production.ts';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from '../src/foundation/errors/errors.ts';
import { discoverRepository } from '../src/runtime/repository-transaction/git.ts';
import {
  createApprovalSubject,
  createGrantChallenge,
  approvalSubjectDigest,
} from '../src/modules/authority/grant-core.ts';
import {
  createProductionCentralGrantRequestPort,
  createProductionWorkflowGrantCoordinator,
  requestInvestigationV3Grant,
} from '../bootstrap/session-lifecycle-production.ts';
import { HUMAN_GATE_MACOS_V1_CONFIGURATION_DIGEST } from '../src/modules/authority/grant-policy.ts';
import { GLOBAL_PLAN_REVIEW_COVERAGE_POLICY_DIGEST } from '../src/modules/investigation/manifest/plan-review-coverage-policy.ts';
import {
  grantStorePaths,
  createFileGrantRecordStore,
} from '../src/runtime/storage-journal/grant-store.ts';
import { createTransitionRegistry } from '../src/modules/authority/grant-transition-registry.ts';
import {
  createInvestigationV3Blocker,
  createInvestigationV3BlockerFromError,
  sealInvestigationManifestDraft,
} from '../src/modules/investigation/manifest/investigation-manifest.ts';
import { buildInvestigationManifestDraft } from '../src/composition-root/investigation-production.ts';
import {
  INVESTIGATION_V3_ATTEMPTED_TRANSITIONS,
  INVESTIGATION_V3_KNOWN_FAILURE_CODES,
} from '../src/modules/investigation/domain/investigation-schema.ts';
import { type ExemptionInvestigationAuthoringState } from '../src/modules/investigation/manifest/investigation-manifest-types.ts';
import { captureInvestigationV3DirectFailureEmission } from '../src/composition-root/investigation-failure-production.ts';
import {
  createInvestigationV3GrantRequest,
  investigationV3CentralFailureCode,
  investigationV3GrantTransitionDefinitions,
} from '../src/modules/investigation/seal/investigation-v3-grant.ts';
import {
  clearInvestigationV3FailureObservation,
  readCurrentInvestigationV3FailureObservation,
  readInvestigationV3FailureObservation,
  writeInvestigationV3PublicationFailureObservation,
  writeInvestigationV3FailureObservation,
} from '../src/runtime/storage-journal/investigation-v3-failure-store.ts';
import {
  publishInvestigationManifestV3,
  readInvestigationPublicationRefState,
} from '../src/runtime/managed-documents/transaction/investigation-publication.ts';
import { investigationManifestPublicationNamespace } from '../src/modules/investigation/manifest/investigation-publication-contracts.ts';
import {
  compareAndSwapCurrentInvestigationRef,
  compareAndSwapInvestigationSession,
  createCurrentInvestigationRef,
  createInvestigationSessionRecord,
  readInvestigationSession,
} from '../src/runtime/storage-journal/investigation-session-records.ts';
import { investigationRuntimePaths } from '../src/runtime/paths/runtime-paths.ts';
import { runtimePaths } from '../src/runtime/session-workspace/session-store.ts';
import { git } from './fixture.ts';

const PROPOSED_REASON =
  'The v3 transition failed and a human must choose the bounded continuation.';

test('central adapter covers every v3 transition and non-exhaustive failure code', () => {
  const codes = [
    ...INVESTIGATION_V3_KNOWN_FAILURE_CODES,
    'FUTURE_ENGINE_FAILURE',
  ];
  for (const attemptedTransition of INVESTIGATION_V3_ATTEMPTED_TRANSITIONS) {
    for (const failureCode of codes) {
      const blocker = createInvestigationV3Blocker({
        attemptedTransition,
        candidate: { attemptedTransition, failureCode },
        failureCode,
        message: `Failure ${failureCode}`,
      });
      assert.equal(
        investigationV3CentralFailureCode(blocker.failureCode),
        investigationV3CentralFailureCode(failureCode),
      );
    }
  }
  assert.equal(
    investigationV3CentralFailureCode('FUTURE_ENGINE_FAILURE'),
    'investigation.v3.future-engine-failure',
  );

  const repository = createGrantFixtureRepository();
  try {
    assert.equal(
      createProductionCentralGrantRequestPort(repository).contractVersion,
      'central-grant-request-port.v1',
    );
    const blocker = directBlocker(3, 'Exercise the central request shape.');
    const persisted = persistCurrentDirectFailure(repository, blocker);
    const request = createInvestigationV3GrantRequest(
      investigationFailureObservations,
      {
        cwd: repository,
        failure: persisted.identity,
        emission: persisted.emission,
        proposedReason: PROPOSED_REASON,
      },
    );
    assert.equal(request.sourceModuleId, 'investigation.v3');
    assert.equal(request.failureCode, 'investigation.v3.future-engine-failure');
    assert.equal(request.stateBinding.kind, 'investigation.v3.failure');
    assert.deepEqual(request.facts, {
      schemaVersion: 1,
      workflowKind: 'investigation-v3',
      ...persisted.identity,
    });
    assert.equal(request.candidates.length, 1);
    assert.equal(
      request.candidates[0]!.transitionId,
      'investigation.v3.stop-transition.v3',
    );
    assert.equal(
      (request.candidates[0]!.parameters as { schemaVersion?: unknown })
        .schemaVersion,
      3,
    );
    assert.equal(request.candidates[0]!.proposedReason, PROPOSED_REASON);
    assert.equal('title' in request.candidates[0]!, false);
    assert.equal('consequences' in request.candidates[0]!, false);
    assert.equal('execute' in request.candidates[0]!, false);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('a future engine failure survives the real v3 emitter path into central mapping', () => {
  const blocker = createInvestigationV3BlockerFromError({
    attemptedTransition: 'authority-validation',
    candidate: { revision: 4 },
    error: workflowError(
      'FUTURE_ENGINE_FAILURE',
      'A future engine failure must retain its stable identity.',
      ExitCode.guard,
    ),
  });

  assert.equal(blocker.failureCode, 'FUTURE_ENGINE_FAILURE');
  const repository = createGrantFixtureRepository();
  try {
    const persisted = persistCurrentDirectFailure(repository, blocker);
    const request = createInvestigationV3GrantRequest(
      investigationFailureObservations,
      {
        cwd: repository,
        failure: persisted.identity,
        emission: persisted.emission,
        proposedReason: PROPOSED_REASON,
      },
    );
    assert.equal(request.failureCode, 'investigation.v3.future-engine-failure');
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('central registry owns the safe stop transition without relabelling assurance', async () => {
  const blocker = createInvestigationV3Blocker({
    attemptedTransition: 'publication',
    candidate: { manifestDigest: 'a'.repeat(64) },
    failureCode: 'REVIEW_TARGET_STALE',
    message: 'The publication target changed.',
  });
  const repository = createGrantFixtureRepository();
  try {
    const persisted = persistCurrentDirectFailure(repository, blocker);
    const request = createInvestigationV3GrantRequest(
      investigationFailureObservations,
      {
        cwd: repository,
        failure: persisted.identity,
        emission: persisted.emission,
        proposedReason: PROPOSED_REASON,
      },
    );
    const registry = createTransitionRegistry(
      investigationV3GrantTransitionDefinitions(
        investigationFailureObservations,
        repository,
      ),
    );
    assert.equal(
      registry.contractVersion,
      'central-grant-transition-registry-port.v1',
    );
    const challenge = createGrantChallenge(request, registry, {
      challengeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      now: new Date('2026-08-18T05:00:00.000Z'),
      expiresAt: '2026-08-18T05:10:00.000Z',
    });
    const choice = challenge.choices[0]!;
    assert.deepEqual(registry.renderTrustedChoice(choice), {
      title: 'Stop this Investigation v3 transition',
      consequences: [
        'Preserves the failed assurance and keeps the current authority unchanged.',
      ],
    });
    assert.equal(
      registry.resolve(choice.transitionId).resolutionKind,
      'non-retry',
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('the direct-v3 transition registry no longer carries the unused shadow-era v2 definition', () => {
  const registry = createTransitionRegistry(
    investigationV3GrantTransitionDefinitions(
      investigationFailureObservations,
      '/repo',
    ),
  );
  assert.throws(
    () => registry.resolve('investigation.v3.stop-transition.v2'),
    (error) =>
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'GRANT_TRANSITION_UNKNOWN',
  );
  assert.equal(
    registry.resolve('investigation.v3.stop-transition.v3').resolutionKind,
    'non-retry',
  );
  const blocker = directBlocker(
    3,
    'Reject the pre-currentness source grammar.',
  );
  assert.throws(
    () =>
      registry
        .resolve('investigation.v3.stop-transition.v3')
        .validateParameters({
          schemaVersion: 3,
          ...failureContext(blocker),
          source: {
            schemaVersion: 1,
            observerId: 'investigation-v3.direct-failure.v1',
          },
          stateBindingDigest: `sha256:${'a'.repeat(64)}`,
        }),
    hasCode('INVESTIGATION_V3_GRANT_PARAMETERS_INVALID'),
  );
});

test('v3 adapter remains central and introduces no local grant substrate', () => {
  const source = fs.readFileSync(
    new URL(
      '../src/modules/investigation/seal/investigation-v3-grant.ts',
      import.meta.url,
    ),
    'utf8',
  );
  for (const forbidden of [
    'grant-store',
    'human-gate-macos',
    'grant-proof-ssh',
    'writeFile',
    'callback',
  ]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
});

test('a successful direct-v3 rebuild clears the stale failure source', () => {
  const repository = createGrantFixtureRepository();
  try {
    const git = discoverRepository(repository);
    const runtime = investigationRuntimePaths(
      git.gitCommonDirectory,
      'workflow-engine',
    );
    const blocker = createInvestigationV3Blocker({
      attemptedTransition: 'build-draft',
      candidate: { revision: 3 },
      failureCode: 'RECONSTRUCTION_MISMATCH',
      message: 'The first direct build failed.',
    });
    const identity = currentFailureIdentity(repository, blocker);
    const emission = captureInvestigationV3DirectFailureEmission({
      cwd: repository,
      identity,
    });
    writeInvestigationV3FailureObservation({
      runtime,
      ...identity,
      emission,
    });
    clearInvestigationV3FailureObservation({
      runtime,
      ...identity,
      manifestDigest: 'd'.repeat(64),
    });
    assert.throws(
      () =>
        readInvestigationV3FailureObservation(runtime, 'investigation-demo'),
      (error) =>
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'INVESTIGATION_V3_FAILURE_OBSERVATION_INVALID',
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('the shared durable failure slot preserves a publication envelope for the v3 Grant CLI and the success tombstone clears it', async () => {
  const repository = createGrantFixtureRepository();
  try {
    const gitState = discoverRepository(repository);
    const runtime = investigationRuntimePaths(
      gitState.gitCommonDirectory,
      'workflow-engine',
    );
    const manifest = currentExemptionManifest(repository);
    const lifecycle = {
      repositoryId: manifest.repositoryId,
      changeId: manifest.changeId,
      investigationId: manifest.investigationId,
      sessionRevision: manifest.authoring.sessionRevision,
      sessionSnapshotDigest: manifest.authoring.sessionSnapshotDigest,
    };
    const namespace = investigationManifestPublicationNamespace(lifecycle);
    const paths = {
      manifestPath: 'openspec/changes/demo-change/investigation.json',
      currentRefPath: `workflow-engine/${namespace}/current.json`,
      journalPath: `workflow-engine/${namespace}/journal.json`,
    };
    const failure = publishInvestigationManifestV3({
      repositoryRoot: repository,
      privateRoot: gitState.gitCommonDirectory,
      paths,
      manifest,
      expected: { ...lifecycle, currentRefDigest: '0'.repeat(64) },
      withTransitionLock: (operation) =>
        operation({ ...lifecycle, currentRefDigest: '0'.repeat(64) }),
    });
    assert.equal(failure.outcome, 'blocked');
    if (failure.outcome !== 'blocked')
      assert.fail('expected publication block');

    writeInvestigationV3PublicationFailureObservation({
      runtime,
      failure: failure.failure,
    });
    const stored = readCurrentInvestigationV3FailureObservation(
      runtime,
      manifest.investigationId,
    );
    assert.equal(
      stored.kind,
      'investigation-v3-publication-failure-observation',
    );
    if (stored.kind !== 'investigation-v3-publication-failure-observation') {
      assert.fail('publication failure was not stored in the shared slot');
    }
    assert.equal(canonicalJson(stored.failure), canonicalJson(failure.failure));

    const requested = await requestInvestigationV3Grant(
      repository,
      manifest.investigationId,
      PROPOSED_REASON,
    );
    assert.equal(
      createFileGrantRecordStore(
        grantStorePaths(
          runtimePaths(gitState.gitCommonDirectory, 'workflow-engine').root,
        ),
      ).readGrantRecord(requested.challengeId).state,
      'pending',
    );

    clearInvestigationV3FailureObservation({
      runtime,
      ...lifecycle,
      manifestDigest: manifest.manifestDigest,
    });
    assert.throws(
      () =>
        readCurrentInvestigationV3FailureObservation(
          runtime,
          manifest.investigationId,
        ),
      hasCode('INVESTIGATION_V3_FAILURE_OBSERVATION_INVALID'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('the v3 Grant CLI rejects durable publication source drift', async () => {
  const repository = createGrantFixtureRepository();
  try {
    const gitState = discoverRepository(repository);
    const runtime = investigationRuntimePaths(
      gitState.gitCommonDirectory,
      'workflow-engine',
    );
    const manifest = currentExemptionManifest(repository);
    const lifecycle = {
      repositoryId: manifest.repositoryId,
      changeId: manifest.changeId,
      investigationId: manifest.investigationId,
      sessionRevision: manifest.authoring.sessionRevision,
      sessionSnapshotDigest: manifest.authoring.sessionSnapshotDigest,
    };
    const namespace = investigationManifestPublicationNamespace(lifecycle);
    const paths = {
      manifestPath: 'openspec/changes/demo-change/investigation.json',
      currentRefPath: `workflow-engine/${namespace}/current.json`,
      journalPath: `workflow-engine/${namespace}/journal.json`,
    };
    const failure = publishInvestigationManifestV3({
      repositoryRoot: repository,
      privateRoot: gitState.gitCommonDirectory,
      paths,
      manifest,
      expected: { ...lifecycle, currentRefDigest: '0'.repeat(64) },
      withTransitionLock: (operation) =>
        operation({ ...lifecycle, currentRefDigest: '0'.repeat(64) }),
    });
    assert.equal(failure.outcome, 'blocked');
    if (failure.outcome !== 'blocked')
      assert.fail('expected publication block');
    writeInvestigationV3PublicationFailureObservation({
      runtime,
      failure: failure.failure,
    });

    const journal = path.join(gitState.gitCommonDirectory, paths.journalPath);
    fs.mkdirSync(path.dirname(journal), { recursive: true });
    fs.writeFileSync(journal, `${canonicalJson({ drifted: true })}\n`);
    await assert.rejects(
      requestInvestigationV3Grant(
        repository,
        manifest.investigationId,
        PROPOSED_REASON,
      ),
      hasCode('INVESTIGATION_V3_FAILURE_SOURCE_CHANGED'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('a direct-v3 Grant rejects a durable failure without its lifecycle session', async () => {
  const repository = createGrantFixtureRepository({ installSession: false });
  try {
    const gitState = discoverRepository(repository);
    const runtime = investigationRuntimePaths(
      gitState.gitCommonDirectory,
      'workflow-engine',
    );
    const blocker = directBlocker(3, 'The lifecycle session is absent.');
    writeInvestigationV3FailureObservation({
      runtime,
      ...failureContext(blocker),
      emission: forgedDirectEmission(),
    });

    await assert.rejects(
      requestInvestigationV3Grant(
        repository,
        'investigation-demo',
        PROPOSED_REASON,
      ),
      hasCode('INVESTIGATION_V3_FAILURE_SOURCE_CHANGED'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('a direct-v3 Grant rejects session revision and current pointer drift', async () => {
  for (const drift of ['revision', 'current-ref'] as const) {
    const repository = createGrantFixtureRepository();
    try {
      const gitState = discoverRepository(repository);
      const runtime = investigationRuntimePaths(
        gitState.gitCommonDirectory,
        'workflow-engine',
      );
      const persisted = persistCurrentDirectFailure(
        repository,
        directBlocker(3, `The ${drift} will drift.`),
      );
      const initial = createInvestigationV3GrantRequest(
        investigationFailureObservations,
        {
          cwd: repository,
          failure: persisted.identity,
          emission: persisted.emission,
          proposedReason: PROPOSED_REASON,
        },
      );
      const registry = createTransitionRegistry(
        investigationV3GrantTransitionDefinitions(
          investigationFailureObservations,
          repository,
        ),
      );
      const challenge = createGrantChallenge(initial, registry, {
        challengeId:
          drift === 'revision'
            ? 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
            : 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        now: new Date('2026-08-22T00:01:00.000Z'),
        expiresAt: '2026-08-22T00:11:00.000Z',
      });
      const choice = challenge.choices[0]!;
      if (drift === 'revision') {
        compareAndSwapInvestigationSession(
          runtime,
          'investigation-demo',
          3,
          (session) => ({
            ...session,
            revision: 4,
            updatedAt: '2026-08-22T00:00:01.000Z',
          }),
        );
      } else {
        compareAndSwapCurrentInvestigationRef(
          runtime,
          'demo-change',
          'investigation-demo',
          null,
        );
      }

      await assert.rejects(
        requestInvestigationV3Grant(
          repository,
          'investigation-demo',
          PROPOSED_REASON,
        ),
        hasCode('INVESTIGATION_V3_FAILURE_SOURCE_CHANGED'),
        drift,
      );
      assert.notDeepEqual(
        await registry
          .resolve(choice.transitionId)
          .observeState(choice.parameters),
        challenge.stateBinding,
        `${drift} replay`,
      );
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  }
});

test('a direct-v3 failure is bound to its emitting linked worktree', async () => {
  const repository = createGrantFixtureRepository();
  const linkedParent = fs.mkdtempSync(
    path.join(os.tmpdir(), 'investigation-v3-linked-parent-'),
  );
  const linked = path.join(linkedParent, 'linked');
  try {
    const blocker = directBlocker(
      3,
      'The emitting worktree must remain exact.',
    );
    const persisted = persistCurrentDirectFailure(repository, blocker);
    git(repository, ['worktree', 'add', '-b', 'linked-currentness', linked]);
    const linkedEmission = captureInvestigationV3DirectFailureEmission({
      cwd: linked,
      identity: persisted.identity,
    });
    assert.notEqual(
      linkedEmission.gitStateDigest,
      persisted.emission.gitStateDigest,
    );

    await assert.rejects(
      requestInvestigationV3Grant(
        linked,
        'investigation-demo',
        PROPOSED_REASON,
      ),
      hasCode('INVESTIGATION_V3_FAILURE_SOURCE_CHANGED'),
    );
  } finally {
    fs.rmSync(linkedParent, { recursive: true, force: true });
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('a successful current Manifest makes an uncleared direct-v3 failure stale', async () => {
  const repository = createGrantFixtureRepository();
  try {
    const persisted = persistCurrentDirectFailure(
      repository,
      directBlocker(3, 'The direct build failed before publication.'),
    );
    publishCurrentManifest(repository, currentExemptionManifest(repository));

    await assert.rejects(
      requestInvestigationV3Grant(
        repository,
        persisted.identity.investigationId,
        PROPOSED_REASON,
      ),
      (error) =>
        hasCode('INVESTIGATION_V3_FAILURE_SOURCE_CHANGED')(error) &&
        error instanceof Error &&
        error.message.includes('Manifest is already current'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('an engine-produced v3 blocker becomes a durable central challenge and state drift is re-observed', async () => {
  const repository = createGrantFixtureRepository();
  try {
    const git = discoverRepository(repository);
    const investigationRuntime = investigationRuntimePaths(
      git.gitCommonDirectory,
      'workflow-engine',
    );
    const lifecycleRuntime = runtimePaths(
      git.gitCommonDirectory,
      'workflow-engine',
    );
    const blocker = createInvestigationV3Blocker({
      attemptedTransition: 'authority-validation',
      candidate: { revision: 3 },
      failureCode: 'FUTURE_ENGINE_FAILURE',
      message: 'A future engine failure remains centrally consumable.',
    });
    const persisted = persistCurrentDirectFailure(repository, blocker);
    const failurePath = persisted.filePath;

    const requested = await requestInvestigationV3Grant(
      repository,
      'investigation-demo',
      PROPOSED_REASON,
    );
    const stored = createFileGrantRecordStore(
      grantStorePaths(lifecycleRuntime.root),
    ).readGrantRecord(requested.challengeId);
    assert.equal(stored.state, 'pending');
    assert.equal(stored.challenge.sourceModuleId, 'investigation.v3');
    assert.deepEqual(stored.challenge.facts, {
      schemaVersion: 1,
      workflowKind: 'investigation-v3',
      ...persisted.identity,
    });
    const failureBytes = fs.readFileSync(failurePath, 'utf8');
    assert.equal(failureBytes.includes(requested.challengeId), false);
    assert.equal(failureBytes.includes('grantChallenge'), false);

    const registry = createTransitionRegistry(
      investigationV3GrantTransitionDefinitions(
        investigationFailureObservations,
        repository,
      ),
    );
    const choice = stored.challenge.choices[0]!;
    const definition = registry.resolve(choice.transitionId);
    assert.deepEqual(
      await definition.observeState(choice.parameters),
      stored.challenge.stateBinding,
    );
    const approvalSubject = createApprovalSubject(
      stored.challenge,
      {
        choiceId: choice.choiceId,
        approvalMethod: 'human-presence',
        reasonCode: 'preserve-current-authority',
        reason: 'Keep the current authority and stop this failed transition.',
        sessionNonce: 'nonce-55555555555555555555555555555555',
      },
      { now: new Date(stored.challenge.issuedAt) },
    );
    const transitionContext = {
      parameters: choice.parameters,
      approvalSubject,
      approvalSubjectDigest: approvalSubjectDigest(approvalSubject),
      challengeId: stored.challenge.challengeId,
      operationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      recovered: false,
      assertLifecycleOwned() {},
    };
    const outcome = await definition.execute(transitionContext);
    assert.deepEqual(outcome, {
      outcome: 'completed',
      details: {
        continuation: 'stop-transition',
        failureIdentity: blocker.failureIdentity,
        failurePreserved: true,
        authorityAdvanced: false,
      },
    });
    assert.equal(canonicalJson(outcome).includes('verified'), false);
    const storePaths = grantStorePaths(lifecycleRuntime.root);
    createFileGrantRecordStore(storePaths).prepareGrantTransition({
      operationId: transitionContext.operationId,
      challenge: stored.challenge,
      subject: approvalSubject,
      proofModules: [
        {
          moduleId: 'human-gate-macos',
          version: '1',
          claim: 'fresh-local-device-owner',
          proofDigest: `sha256:${'4'.repeat(64)}`,
          identity: null,
          portableEvidence: null,
        },
      ],
      createdAt: stored.challenge.issuedAt,
    });

    const changedBlocker = createInvestigationV3Blocker({
      attemptedTransition: 'authority-validation',
      candidate: { revision: 4 },
      failureCode: 'FUTURE_ENGINE_FAILURE',
      message: 'The engine failure changed after challenge creation.',
    });
    writeInvestigationV3FailureObservation({
      runtime: investigationRuntime,
      ...persisted.identity,
      blocker: changedBlocker,
      emission: persisted.emission,
    });
    assert.notDeepEqual(
      await definition.observeState(choice.parameters),
      stored.challenge.stateBinding,
    );
    await assert.rejects(
      definition.execute({ ...transitionContext, recovered: true }),
      (error) =>
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'INVESTIGATION_V3_GRANT_STATE_CHANGED',
    );
    const recovered = await createProductionWorkflowGrantCoordinator(
      repository,
    ).recoverChallenge(stored.challenge.challengeId);
    assert.equal(recovered.outcome, 'failed');
    const terminal = createFileGrantRecordStore(storePaths).readGrantRecord(
      stored.challenge.challengeId,
    );
    assert.equal(terminal.state, 'failed');
    if (terminal.state !== 'failed') assert.fail('expected terminal failure');
    assert.equal(
      (terminal.outcome.details as { failureCode?: unknown }).failureCode,
      'GRANT_STATE_CHANGED',
    );
    assert.equal(
      createFileGrantRecordStore(storePaths).readGrantRecord(
        stored.challenge.challengeId,
      ).state,
      'failed',
      'stale recovery must record a terminal failure without completing the transition',
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

function failureContext(
  blocker: ReturnType<typeof createInvestigationV3Blocker>,
) {
  return {
    repositoryId: 'fixture',
    changeId: 'demo-change',
    investigationId: 'investigation-demo',
    sessionRevision: 3,
    sessionSnapshotDigest: 'c'.repeat(64),
    blocker,
  };
}

function installGrantPolicy(repository: string): void {
  fs.writeFileSync(
    path.join(repository, 'workflow/grant-policy.json'),
    `${canonicalJson({
      schemaVersion: 2,
      defaultProfile: 'local-presence',
      profiles: {
        'local-presence': {
          requiredClaims: ['fresh-local-device-owner'],
        },
      },
      approvalModules: [
        {
          moduleId: 'human-gate-macos',
          version: '1',
          allowedClaims: ['fresh-local-device-owner'],
          configurationDigest: HUMAN_GATE_MACOS_V1_CONFIGURATION_DIGEST,
        },
      ],
    })}\n`,
  );
}

function createGrantFixtureRepository(
  options: { installSession?: boolean } = {},
): string {
  const repository = fs.mkdtempSync(
    path.join(os.tmpdir(), 'investigation-v3-grant-'),
  );
  git(repository, ['init', '-b', 'main']);
  git(repository, ['config', 'user.email', 'v3-grant@example.test']);
  git(repository, ['config', 'user.name', 'V3 Grant Test']);
  fs.mkdirSync(path.join(repository, 'workflow'), { recursive: true });
  fs.writeFileSync(
    path.join(repository, 'workflow/config.json'),
    `${canonicalJson({
      schemaVersion: 1,
      repositoryName: 'fixture',
      changeRoot: 'openspec/changes',
      runtimeDirectory: 'workflow-engine',
      protectedBranches: ['main', 'master'],
      branchTemplate: 'work/{changeId}',
      taskAuthorization: {
        pathRoleRegistry: 'workflow/path-roles.json',
        mandateRequiredRoles: ['control-plane'],
      },
    })}\n`,
  );
  installGrantPolicy(repository);
  fs.mkdirSync(path.join(repository, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(repository, 'docs/example.md'), '# Fixture\n');
  git(repository, [
    'add',
    '--',
    'workflow/config.json',
    'workflow/grant-policy.json',
    'docs/example.md',
  ]);
  git(repository, ['commit', '-m', 'Create v3 Grant fixture']);
  if (options.installSession !== false) {
    installGrantInvestigationSession(repository);
  }
  return repository;
}

function installGrantInvestigationSession(repository: string): void {
  const gitState = discoverRepository(repository);
  const runtime = investigationRuntimePaths(
    gitState.gitCommonDirectory,
    'workflow-engine',
  );
  const now = '2026-08-22T00:00:00.000Z';
  createInvestigationSessionRecord(runtime, {
    schemaVersion: 1,
    investigationId: 'investigation-demo',
    revision: 3,
    semanticRevision: 0,
    lifecycleRevision: 3,
    state: 'awaiting-main-terms',
    changeId: 'demo-change',
    repositoryRoot: gitState.repositoryRealPath,
    gitCommonDirectory: gitState.gitCommonDirectory,
    branch: gitState.branch,
    baseline: { head: gitState.head, tree: gitState.tree },
    intentDigest: rawDigest('v3-grant-intent'),
    planReviewCoveragePolicyDigest: GLOBAL_PLAN_REVIEW_COVERAGE_POLICY_DIGEST,
    blindManifestDigest: rawDigest('v3-grant-blind-manifest'),
    blindRequestDigest: rawDigest('v3-grant-blind-request'),
    blindInvocationIds: ['invocation-v3-grant'],
    currentBlindInvocationId: 'invocation-v3-grant',
    milestones: {
      mainTerms: null,
      blindResult: null,
      reviewerTermSourceNodeId: null,
      groupDispositions: null,
      whyAnswers: null,
    },
    blocker: null,
    createdAt: now,
    updatedAt: now,
  });
  createCurrentInvestigationRef(runtime, 'demo-change', 'investigation-demo');
}

function directBlocker(revision: number, message: string) {
  return createInvestigationV3Blocker({
    attemptedTransition: 'authority-validation',
    candidate: { revision },
    failureCode: 'FUTURE_ENGINE_FAILURE',
    message,
  });
}

function currentFailureIdentity(
  repository: string,
  blocker: ReturnType<typeof createInvestigationV3Blocker>,
) {
  const gitState = discoverRepository(repository);
  const session = readInvestigationSession(
    investigationRuntimePaths(gitState.gitCommonDirectory, 'workflow-engine'),
    'investigation-demo',
  );
  return {
    repositoryId: 'fixture',
    changeId: session.changeId,
    investigationId: session.investigationId,
    sessionRevision: session.revision,
    sessionSnapshotDigest: rawDigest(`${canonicalJson(session)}\n`),
    blocker,
  };
}

function persistCurrentDirectFailure(
  repository: string,
  blocker: ReturnType<typeof createInvestigationV3Blocker>,
) {
  const gitState = discoverRepository(repository);
  const runtime = investigationRuntimePaths(
    gitState.gitCommonDirectory,
    'workflow-engine',
  );
  const identity = currentFailureIdentity(repository, blocker);
  const emission = captureInvestigationV3DirectFailureEmission({
    cwd: repository,
    identity,
  });
  const filePath = writeInvestigationV3FailureObservation({
    runtime,
    ...identity,
    emission,
  });
  return { identity, emission, filePath };
}

function forgedDirectEmission() {
  return {
    schemaVersion: 1 as const,
    sessionSnapshotDigest: 'c'.repeat(64),
    currentRefDigest: `sha256:${'d'.repeat(64)}` as const,
    effectiveState: 'awaiting-main-terms' as const,
    lifecycleStateDigest: `sha256:${'e'.repeat(64)}` as const,
    gitStateDigest: `sha256:${'f'.repeat(64)}` as const,
  };
}

function currentExemptionManifest(repository: string) {
  const gitState = discoverRepository(repository);
  const session = readInvestigationSession(
    investigationRuntimePaths(gitState.gitCommonDirectory, 'workflow-engine'),
    'investigation-demo',
  );
  const state: ExemptionInvestigationAuthoringState = {
    schemaVersion: 1,
    applicabilityKind: 'exemption',
    repositoryId: 'fixture',
    changeId: 'demo-change',
    investigationId: 'investigation-demo',
    normalizedIntent: {
      schemaVersion: 1,
      summary: 'Exercise direct-v3 Grant currentness.',
      sourceRefs: [],
      explicitPaths: ['docs/example.md'],
      explicitSymbols: [],
      explicitConfigKeys: [],
      renamePairs: [],
    },
    authoring: {
      sessionRevision: session.revision,
      sessionSnapshotDigest: rawDigest(`${canonicalJson(session)}\n`),
    },
    exemption: {
      category: 'documentation-only',
      baseline: {
        commitOid: git(repository, ['rev-parse', 'HEAD']).trim(),
        treeOid: git(repository, ['rev-parse', 'HEAD^{tree}']).trim(),
      },
      declaredPaths: ['docs/example.md'],
      declaredChangeClasses: ['documentation-only'],
      rationale: 'Exercise direct-v3 Grant currentness.',
      semanticAuthor: {
        id: 'maintainer',
        provenance: 'checkpoint:v3-grant-currentness',
      },
      nonTrivialBehaviorReliance: 'none-declared',
      researchBudgetMinutes: null,
    },
  };
  const built = buildInvestigationManifestDraft({
    repositoryRoot: repository,
    state,
  });
  assert.equal(built.outcome, 'built');
  if (built.outcome !== 'built') assert.fail('draft blocked');
  const sealed = sealInvestigationManifestDraft({
    draft: built.draft,
    approval: {
      semanticAuthor: {
        id: 'maintainer',
        provenance: 'checkpoint:v3-grant-currentness-approval',
      },
      approvalProvenanceDigest: rawDigest('v3-grant-currentness-approval'),
    },
  });
  assert.equal(sealed.outcome, 'sealed');
  if (sealed.outcome !== 'sealed') assert.fail('seal blocked');
  return sealed.manifest;
}

function publishCurrentManifest(
  repository: string,
  manifest: ReturnType<typeof currentExemptionManifest>,
): void {
  const gitState = discoverRepository(repository);
  const lifecycle = {
    repositoryId: manifest.repositoryId,
    changeId: manifest.changeId,
    investigationId: manifest.investigationId,
    sessionRevision: manifest.authoring.sessionRevision,
    sessionSnapshotDigest: manifest.authoring.sessionSnapshotDigest,
  };
  const namespace = investigationManifestPublicationNamespace(lifecycle);
  const paths = {
    manifestPath: 'openspec/changes/demo-change/investigation.json',
    currentRefPath: `workflow-engine/${namespace}/current.json`,
    journalPath: `workflow-engine/${namespace}/journal.json`,
  };
  const observed = readInvestigationPublicationRefState({
    repositoryRoot: repository,
    privateRoot: gitState.gitCommonDirectory,
    currentRefPath: paths.currentRefPath,
    lifecycle,
  });
  assert.equal(observed.outcome, 'read');
  if (observed.outcome !== 'read') assert.fail('ref read blocked');
  const published = publishInvestigationManifestV3({
    repositoryRoot: repository,
    privateRoot: gitState.gitCommonDirectory,
    paths,
    manifest,
    expected: {
      ...lifecycle,
      currentRefDigest: observed.currentRefDigest,
    },
    withTransitionLock: (operation) =>
      operation({
        ...lifecycle,
        currentRefDigest: observed.currentRefDigest,
      }),
  });
  assert.equal(published.outcome, 'published');
}

function rawDigest(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hasCode(expected: string) {
  return (error: unknown) =>
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === expected;
}

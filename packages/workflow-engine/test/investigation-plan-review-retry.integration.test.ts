import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import {
  compareAndSwapEvidenceRefsDocument,
  readEvidenceNode,
  readInvestigationEvidenceRefsClosure,
  writeEvidenceNode,
} from '../src/runtime/storage-journal/evidence-object-store.ts';
import { createEvidenceNode } from '../src/adapters/planning/investigation/evidence-node.ts';
import { discoverRepository } from '../src/runtime/repository-transaction/git.ts';
import {
  createPlanReviewRetryEnvelope,
  getProposeStatus,
  resumePropose,
} from '../src/application/propose/propose-orchestrator.ts';
import { investigationRuntimePaths } from '../src/runtime/session-workspace/paths.ts';
import {
  createProviderInvocationRequest,
  type ProviderInvocationRequest,
} from '../src/modules/provider-orchestration/provider-contracts.ts';
import {
  claimProviderInvocation,
  failProviderInvocation,
  readPlanReviewSnapshotRuntime,
  readProviderInvocation,
  readProviderInvocationRequest,
} from '../src/runtime/storage-journal/provider-invocation-store.ts';
import { isWorkflowError } from './fixture.ts';
import { setFixtureProviderTimeout } from './investigation-session-fixture.ts';
import { createMaterializedProposeFixture } from './investigation-propose-flow-fixture.ts';

test('retries PlanReview with intact invocation and snapshot lineage', async (t) => {
  let { repository, changeId, materialized } =
    createMaterializedProposeFixture();
  try {
    const reviewerRuntime = investigationRuntimePaths(
      discoverRepository(repository).gitCommonDirectory,
      'workflow-engine',
    );

    const initialReviewOutput = getProposeStatus(
      repository,
      materialized.investigation!.investigationId,
    );

    const planReviewInvocationId = initialReviewOutput.planReview!.invocationId;

    const planReviewRequest = readProviderInvocationRequest(
      reviewerRuntime,
      planReviewInvocationId,
    );

    const planReviewClaim = claimProviderInvocation(
      reviewerRuntime,
      planReviewInvocationId,
      {
        workerId: 'worker-first-plan-review-failure',
        leaseDurationMs: 1_000,
      },
    );

    failProviderInvocation(reviewerRuntime, planReviewInvocationId, {
      expectedRevision: planReviewClaim.record.revision,
      leaseGeneration: planReviewClaim.record.leaseGeneration,
      leaseToken: planReviewClaim.leaseToken,
      failure: {
        kind: 'retryable',
        code: 'PROVIDER_PROCESS_FAILED',
        message: 'PlanReview provider timed out.',
      },
    });

    const failedPlanReviewBytes = fs.readFileSync(
      path.join(
        reviewerRuntime.invocations,
        planReviewInvocationId,
        'state.json',
      ),
      'utf8',
    );

    const failedPlanReview = getProposeStatus(
      repository,
      materialized.investigation!.investigationId,
    );

    assert.equal(failedPlanReview.state, 'waiting-for-plan-review');

    assert.equal(failedPlanReview.nextAction, 'retry-plan-review');

    const retryEnvelope = createPlanReviewRetryEnvelope(
      repository,
      failedPlanReview,
      { acknowledgeProviderCost: true },
    );

    setFixtureProviderTimeout(repository, 600_000);

    const {
      schemaVersion: _retrySchemaVersion,
      kind: _retryKind,
      acknowledgeProviderCost: _retryAcknowledgement,
      ...retryBinding
    } = retryEnvelope;

    assert.deepEqual(failedPlanReview.inputSchema, {
      schemaVersion: 1,
      kind: 'plan-review-retry',
      binding: retryBinding,
      requiredAcknowledgement: {
        acknowledgeProviderCost: true,
      },
      template: {
        schemaVersion: 1,
        kind: 'plan-review-retry',
        ...retryBinding,
        acknowledgeProviderCost: true,
      },
    });

    assert.throws(
      () =>
        resumePropose(repository, changeId, {
          ...retryEnvelope,
          failedInvocation: {
            ...retryEnvelope.failedInvocation,
            failureDigest: 'f'.repeat(64),
          },
        }),
      (error) => isWorkflowError(error, 'PLAN_REVIEW_RETRY_INPUT_STALE'),
    );

    const initialSnapshot = readPlanReviewSnapshotRuntime(
      reviewerRuntime,
      planReviewInvocationId,
    );

    assert.ok(initialSnapshot);

    const displacedSnapshotFile = `${initialSnapshot.files[0]!.path}.missing`;

    const reservationBeforeSnapshotFailure =
      readInvestigationEvidenceRefsClosure(reviewerRuntime, changeId).snapshot;

    const invocationCountBeforeSnapshotFailure = fs
      .readdirSync(reviewerRuntime.invocations)
      .filter((entry) => entry.startsWith('invocation-')).length;

    fs.renameSync(initialSnapshot.files[0]!.path, displacedSnapshotFile);

    assert.throws(
      () => resumePropose(repository, changeId, retryEnvelope),
      (error) => isWorkflowError(error, 'PROVIDER_INVOCATION_INVALID'),
    );

    assert.deepEqual(
      readInvestigationEvidenceRefsClosure(reviewerRuntime, changeId).snapshot,
      reservationBeforeSnapshotFailure,
    );

    assert.equal(
      fs
        .readdirSync(reviewerRuntime.invocations)
        .filter((entry) => entry.startsWith('invocation-')).length,
      invocationCountBeforeSnapshotFailure,
    );

    fs.renameSync(displacedSnapshotFile, initialSnapshot.files[0]!.path);

    const retriedInvocations: string[] = [];

    const retriedReview = resumePropose(repository, changeId, retryEnvelope, {
      providerDriver({ request }) {
        retriedInvocations.push(request.invocationId);
      },
    });

    const replacementInvocationId = retriedReview.planReview!.invocationId;

    assert.notEqual(replacementInvocationId, planReviewInvocationId);

    assert.deepEqual(retriedInvocations, [replacementInvocationId]);

    assert.equal(
      fs.readFileSync(
        path.join(
          reviewerRuntime.invocations,
          planReviewInvocationId,
          'state.json',
        ),
        'utf8',
      ),
      failedPlanReviewBytes,
    );

    const replacement = readProviderInvocation(
      reviewerRuntime,
      replacementInvocationId,
    );

    assert.equal(replacement.attempt, 2);

    const replacementRequest = readProviderInvocationRequest(
      reviewerRuntime,
      replacementInvocationId,
    );

    const {
      invocationId: _priorInvocationId,
      nonce: _priorNonce,
      requestDigest: _priorRequestDigest,
      policyDigest: _priorPolicyDigest,
      limits: _priorLimits,
      ...priorRequestBinding
    } = planReviewRequest;

    const {
      invocationId: _replacementInvocationId,
      nonce: _replacementNonce,
      requestDigest: _replacementRequestDigest,
      policyDigest: _replacementPolicyDigest,
      limits: _replacementLimits,
      ...replacementRequestBinding
    } = replacementRequest;

    assert.deepEqual(replacementRequestBinding, priorRequestBinding);

    assert.equal(planReviewRequest.limits.timeoutMs, 300_000);

    assert.equal(replacementRequest.limits.timeoutMs, 600_000);

    assert.notEqual(
      replacementRequest.policyDigest,
      planReviewRequest.policyDigest,
    );

    assert.notEqual(replacementRequest.nonce, planReviewRequest.nonce);

    const priorSnapshot = readPlanReviewSnapshotRuntime(
      reviewerRuntime,
      planReviewInvocationId,
    );

    const replacementSnapshot = readPlanReviewSnapshotRuntime(
      reviewerRuntime,
      replacementInvocationId,
    );

    assert.ok(priorSnapshot);

    assert.ok(replacementSnapshot);

    assert.deepEqual(
      priorSnapshot.files.map(({ id, path: filePath }) => ({
        id,
        content: fs.readFileSync(filePath),
      })),
      replacementSnapshot.files.map(({ id, path: filePath }) => ({
        id,
        content: fs.readFileSync(filePath),
      })),
    );

    const retryClosure = readInvestigationEvidenceRefsClosure(
      reviewerRuntime,
      changeId,
    );

    const retryRequestClosure = retryClosure.entries.find(
      (entry) => entry.refName === 'propose/plan-review-request',
    );

    assert.ok(retryRequestClosure);

    assert.equal(
      retryRequestClosure.ownerInvestigationId,
      materialized.investigation!.investigationId,
    );

    assert.ok(
      retryRequestClosure.dependencies.some(
        (dependency) => dependency.role === 'previous-request',
      ),
    );

    assert.ok(
      retryRequestClosure.dependencies.some(
        (dependency) => dependency.role === 'previous-request/materialization',
      ),
    );

    const genuineRetryNode = readEvidenceNode(
      reviewerRuntime,
      retryClosure.snapshot.refs!['propose/plan-review-request']!,
    );

    const forgedReplacementRequest = createProviderInvocationRequest({
      invocationId: `${replacementInvocationId}-forged`,
      nonce: `forged-plan-review-${'a'.repeat(32)}`,
      purpose: replacementRequest.purpose,
      providerId: replacementRequest.providerId,
      roleAssignment: replacementRequest.roleAssignment,
      capabilityProfile: replacementRequest.capabilityProfile,
      repositoryId: replacementRequest.repositoryId,
      baseCommit: replacementRequest.baseCommit,
      baseTree: replacementRequest.baseTree,
      targetDigest: replacementRequest.targetDigest,
      inputManifestDigest: replacementRequest.inputManifestDigest,
      authorizationNodeId: replacementRequest.authorizationNodeId,
      writeAllowedPaths: [...replacementRequest.writeAllowedPaths],
      outputSchema: replacementRequest.outputSchema,
      evaluatorVersion: replacementRequest.evaluatorVersion,
      policyDigest: replacementRequest.policyDigest,
      limits: replacementRequest.limits,
    });

    const forgedRetryNode = createEvidenceNode({
      type: genuineRetryNode.type,
      nodeSchema: genuineRetryNode.nodeSchema,
      evaluator: genuineRetryNode.evaluator,
      policyDigest: genuineRetryNode.policyDigest,
      exactInputDigests: {
        ...genuineRetryNode.exactInputDigests,
        request: forgedReplacementRequest.requestDigest,
      },
      semanticParentResultDigests: {
        ...genuineRetryNode.semanticParentResultDigests,
      },
      provenanceParentNodeIds: {
        ...genuineRetryNode.provenanceParentNodeIds,
      },
      outputSchema: genuineRetryNode.outputSchema,
      output: {
        ...(genuineRetryNode.output as Record<string, unknown>),
        request: forgedReplacementRequest,
      },
      runtimeMetadata: genuineRetryNode.runtimeMetadata,
    });

    writeEvidenceNode(reviewerRuntime, forgedRetryNode);

    const forgedRetryRefs = {
      ...retryClosure.snapshot.refs!,
      'propose/plan-review-request': forgedRetryNode.nodeId,
    };

    const forgedRetrySnapshot = compareAndSwapEvidenceRefsDocument(
      reviewerRuntime,
      {
        changeId,
        expectedDigest: retryClosure.snapshot.digest!,
        nextRefs: forgedRetryRefs,
      },
    );

    assert.throws(
      () => resumePropose(repository, changeId, retryEnvelope),
      (error) => isWorkflowError(error, 'PLAN_REVIEW_RETRY_INPUT_STALE'),
    );

    assert.equal(
      fs.existsSync(
        path.join(
          reviewerRuntime.invocations,
          forgedReplacementRequest.invocationId,
        ),
      ),
      false,
    );

    compareAndSwapEvidenceRefsDocument(reviewerRuntime, {
      changeId,
      expectedDigest: forgedRetrySnapshot.digest,
      nextRefs: retryClosure.snapshot.refs!,
    });

    const displacedInvocationRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'plan-review-retry-crash-'),
    );

    fs.renameSync(
      path.join(reviewerRuntime.invocations, replacementInvocationId),
      path.join(displacedInvocationRoot, replacementInvocationId),
    );

    const replayedRetry = resumePropose(repository, changeId, retryEnvelope);

    assert.equal(
      replayedRetry.planReview?.invocationId,
      replacementInvocationId,
    );

    assert.ok(
      fs.existsSync(
        path.join(reviewerRuntime.invocations, replacementInvocationId),
      ),
    );

    fs.rmSync(displacedInvocationRoot, { recursive: true });

    assert.equal(
      fs
        .readdirSync(reviewerRuntime.invocations)
        .filter((entry) => entry.startsWith('invocation-')).length,
      3,
    );

    const replacementClaim = claimProviderInvocation(
      reviewerRuntime,
      replacementInvocationId,
      {
        workerId: 'worker-second-plan-review-failure',
        leaseDurationMs: 1_000,
      },
    );

    failProviderInvocation(reviewerRuntime, replacementInvocationId, {
      expectedRevision: replacementClaim.record.revision,
      leaseGeneration: replacementClaim.record.leaseGeneration,
      leaseToken: replacementClaim.leaseToken,
      failure: {
        kind: 'retryable',
        code: 'PROVIDER_PROCESS_FAILED',
        message: 'Replacement PlanReview provider timed out.',
      },
    });

    const replacementFailedBytes = fs.readFileSync(
      path.join(
        reviewerRuntime.invocations,
        replacementInvocationId,
        'state.json',
      ),
      'utf8',
    );

    const replacementStatePath = path.join(
      reviewerRuntime.invocations,
      replacementInvocationId,
      'state.json',
    );

    const driftedReplacementState = JSON.parse(replacementFailedBytes) as {
      attempt: number;
    } & Record<string, unknown>;

    fs.writeFileSync(
      replacementStatePath,
      `${canonicalJson({
        ...driftedReplacementState,
        attempt: driftedReplacementState.attempt + 1,
      })}\n`,
    );

    assert.throws(
      () =>
        getProposeStatus(
          repository,
          materialized.investigation!.investigationId,
        ),
      (error) =>
        isWorkflowError(error, 'PROVIDER_INVOCATION_SUPERSESSION_UNSAFE'),
    );

    fs.writeFileSync(replacementStatePath, replacementFailedBytes);

    const secondFailure = getProposeStatus(
      repository,
      materialized.investigation!.investigationId,
    );

    const secondRetryEnvelope = createPlanReviewRetryEnvelope(
      repository,
      secondFailure,
      { acknowledgeProviderCost: true },
    );

    const secondRetriedInvocations: string[] = [];

    const secondRetry = resumePropose(
      repository,
      changeId,
      secondRetryEnvelope,
      {
        providerDriver({ request }) {
          secondRetriedInvocations.push(request.invocationId);
        },
      },
    );

    const secondReplacementInvocationId = secondRetry.planReview!.invocationId;

    assert.deepEqual(secondRetriedInvocations, [secondReplacementInvocationId]);

    assert.equal(
      readProviderInvocation(reviewerRuntime, secondReplacementInvocationId)
        .attempt,
      3,
    );

    assert.equal(
      fs.readFileSync(
        path.join(
          reviewerRuntime.invocations,
          replacementInvocationId,
          'state.json',
        ),
        'utf8',
      ),
      replacementFailedBytes,
    );

    const secondRetryClosure = readInvestigationEvidenceRefsClosure(
      reviewerRuntime,
      changeId,
    );

    const secondRetryRequestClosure = secondRetryClosure.entries.find(
      (entry) => entry.refName === 'propose/plan-review-request',
    );

    assert.ok(
      secondRetryRequestClosure?.dependencies.some(
        (dependency) => dependency.role === 'previous-request/previous-request',
      ),
    );

    const genuineSecondRetryNode = readEvidenceNode(
      reviewerRuntime,
      secondRetryClosure.snapshot.refs!['propose/plan-review-request']!,
    );

    const genuineSecondRetryOutput = genuineSecondRetryNode.output as Record<
      string,
      unknown
    >;

    const genuineSecondRetryMetadata = genuineSecondRetryOutput.retry as Record<
      string,
      unknown
    >;

    const genuineSecondRetryRequest =
      genuineSecondRetryOutput.request as ProviderInvocationRequest;

    const skippedAttemptRequest = createProviderInvocationRequest({
      invocationId: `${genuineSecondRetryRequest.invocationId}-skipped`,
      nonce: `skipped-plan-review-${'b'.repeat(32)}`,
      purpose: genuineSecondRetryRequest.purpose,
      providerId: genuineSecondRetryRequest.providerId,
      roleAssignment: genuineSecondRetryRequest.roleAssignment,
      capabilityProfile: genuineSecondRetryRequest.capabilityProfile,
      repositoryId: genuineSecondRetryRequest.repositoryId,
      baseCommit: genuineSecondRetryRequest.baseCommit,
      baseTree: genuineSecondRetryRequest.baseTree,
      targetDigest: genuineSecondRetryRequest.targetDigest,
      inputManifestDigest: genuineSecondRetryRequest.inputManifestDigest,
      authorizationNodeId: genuineSecondRetryRequest.authorizationNodeId,
      writeAllowedPaths: [...genuineSecondRetryRequest.writeAllowedPaths],
      outputSchema: genuineSecondRetryRequest.outputSchema,
      evaluatorVersion: genuineSecondRetryRequest.evaluatorVersion,
      policyDigest: genuineSecondRetryRequest.policyDigest,
      limits: genuineSecondRetryRequest.limits,
    });

    const skippedAttemptNode = createEvidenceNode({
      type: genuineSecondRetryNode.type,
      nodeSchema: genuineSecondRetryNode.nodeSchema,
      evaluator: genuineSecondRetryNode.evaluator,
      policyDigest: genuineSecondRetryNode.policyDigest,
      exactInputDigests: {
        ...genuineSecondRetryNode.exactInputDigests,
        request: skippedAttemptRequest.requestDigest,
      },
      semanticParentResultDigests: {
        ...genuineSecondRetryNode.semanticParentResultDigests,
      },
      provenanceParentNodeIds: {
        ...genuineSecondRetryNode.provenanceParentNodeIds,
      },
      outputSchema: genuineSecondRetryNode.outputSchema,
      output: {
        ...genuineSecondRetryOutput,
        request: skippedAttemptRequest,
        retry: {
          ...genuineSecondRetryMetadata,
          attempt: Number(genuineSecondRetryMetadata.attempt) + 1,
        },
      },
      runtimeMetadata: genuineSecondRetryNode.runtimeMetadata,
    });

    writeEvidenceNode(reviewerRuntime, skippedAttemptNode);

    const skippedAttemptSnapshot = compareAndSwapEvidenceRefsDocument(
      reviewerRuntime,
      {
        changeId,
        expectedDigest: secondRetryClosure.snapshot.digest!,
        nextRefs: {
          ...secondRetryClosure.snapshot.refs!,
          'propose/plan-review-request': skippedAttemptNode.nodeId,
        },
      },
    );

    assert.throws(
      () =>
        getProposeStatus(
          repository,
          materialized.investigation!.investigationId,
        ),
      (error) => isWorkflowError(error, 'PLAN_REVIEW_REQUEST_STALE'),
    );

    compareAndSwapEvidenceRefsDocument(reviewerRuntime, {
      changeId,
      expectedDigest: skippedAttemptSnapshot.digest,
      nextRefs: secondRetryClosure.snapshot.refs!,
    });

    assert.equal(
      fs
        .readdirSync(reviewerRuntime.invocations)
        .filter((entry) => entry.startsWith('invocation-')).length,
      4,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

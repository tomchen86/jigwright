/** Observe pinned candidates and durably mint or verify mechanical transformation evidence. */
import type { ReviewedGeneratedAssetInventory } from '../../modules/source/mutation-class-policy.ts';
import path from 'node:path';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { createEvidenceNode } from '../../foundation/evidence-node/evidence-node.ts';
import {
  readEvidenceNode,
  writeEvidenceNode,
} from '../storage-journal/evidence-object-store.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import { previewExactStaging } from '../repository-transaction/git-transitions.ts';
import {
  createPrivateCanonicalJson,
  privatePathExists,
  readPrivateCanonicalJson,
} from '../journal-primitives/investigation-private-files.ts';
import { investigationRuntimePaths } from '../paths/runtime-paths.ts';
import { deriveReviewedMutationClassPolicy } from '../../modules/source/reviewed-mutation-policy.ts';
import { readPinnedTrackedTree } from '../repository-transaction/tracked-tree-reader.ts';
import type { SessionInspection } from '../../modules/lifecycle/session-inspection.ts';
import {
  GIT_OBJECT,
  TASK_MECHANICAL_TRANSFORM_POLICY_DIGEST,
  type TaskMechanicalTransformationEvidenceRecord,
  type MechanicalEvidenceOutput,
  evaluateMechanicalClosure,
  assertDeterministicMechanicalProjection,
  assertChangedPathsInMechanicalScope,
  assertEvidenceNodeCurrent,
  parseEvidenceRecord,
  mechanicalTask,
  sha256,
  evidenceCorrupt,
  evidenceStale,
} from '../../modules/lifecycle/mechanical-transformation-evidence.ts';

/**
 * Evaluate one mechanical-transform task against the prospective tracked tree
 * and durably mint the engine-owned evidence node consumed by check/finalize.
 * The task contract is only input: it cannot claim that the closure succeeded.
 */
export function ensureTaskMechanicalTransformationEvidence(
  reviewedAssets: ReviewedGeneratedAssetInventory,
  inspection: SessionInspection,
): TaskMechanicalTransformationEvidenceRecord | null {
  const task = mechanicalTask(inspection);
  if (task === null) return null;
  const candidate = currentCandidate(inspection);
  const runtime = investigationRuntimePaths(
    inspection.git.gitCommonDirectory,
    inspection.contract.config.runtimeDirectory,
  );
  const existing = readTaskMechanicalTransformationEvidence(
    inspection,
    candidate.tree,
  );
  if (existing !== null) return existing;

  assertChangedPathsInMechanicalScope(inspection, task);
  const baselineSnapshot = readPinnedTrackedTree({
    repositoryRoot: inspection.git.repositoryRoot,
    treeOid: inspection.session.baseline.tree,
  });
  const mutationPolicy = deriveReviewedMutationClassPolicy(
    reviewedAssets,
    baselineSnapshot,
  );
  const candidateSnapshot = readPinnedTrackedTree({
    repositoryRoot: inspection.git.repositoryRoot,
    treeOid: candidate.tree,
  });
  const output = evaluateMechanicalClosure(
    candidateSnapshot.entries,
    candidate.tree,
    candidateSnapshot.treeDigest,
    inspection.changedPaths,
    task,
    mutationPolicy,
  );
  const projectionDigest = assertDeterministicMechanicalProjection(
    baselineSnapshot.entries,
    candidateSnapshot.entries,
    task,
    mutationPolicy,
  );
  const completeOutput: MechanicalEvidenceOutput = {
    ...output,
    projectionDigest,
  };
  const taskContractDigest = sha256(canonicalJson(task));
  const transformationContractDigest = sha256(
    canonicalJson(task.transformationContract),
  );
  const node = createEvidenceNode({
    type: 'task-mechanical-transformation-closure',
    nodeSchema: 'workflow.task-mechanical-transformation-closure.v1',
    evaluator: 'workflow-task-mechanical-transform.v1',
    policyDigest: TASK_MECHANICAL_TRANSFORM_POLICY_DIGEST,
    exactInputDigests: {
      baseline: sha256(canonicalJson(inspection.session.baseline)),
      candidateTree: sha256(candidate.tree),
      candidateTreeDigest: candidateSnapshot.treeDigest,
      changedPaths: sha256(canonicalJson(inspection.changedPaths)),
      taskContract: taskContractDigest,
      transformationContract: transformationContractDigest,
      mutationPolicy: mutationPolicy.policyDigest,
    },
    semanticParentResultDigests: {},
    provenanceParentNodeIds: {},
    outputSchema: 'workflow.task-mechanical-transformation-output.v1',
    output: completeOutput,
    runtimeMetadata: {},
  });
  writeEvidenceNode(runtime, node);
  const body = {
    schemaVersion: 1 as const,
    kind: 'task-mechanical-transformation-evidence.v1' as const,
    sessionId: inspection.session.sessionId,
    changeId: inspection.session.changeId,
    taskId: inspection.session.taskId,
    baseline: inspection.session.baseline,
    candidateTree: candidate.tree,
    candidateTreeDigest: candidateSnapshot.treeDigest,
    changedPaths: [...inspection.changedPaths],
    taskContractDigest,
    transformationContractDigest,
    mutationPolicyDigest: mutationPolicy.policyDigest,
    evidenceNodeId: node.nodeId,
    evidenceResultDigest: node.resultDigest,
  };
  const record = parseEvidenceRecord({
    ...body,
    recordDigest: sha256(canonicalJson(body)),
  });
  createPrivateCanonicalJson(
    runtime,
    evidenceRecordPath(runtime.sessions, record.sessionId, candidate.tree),
    record,
    evidenceCorrupt,
    'TASK_MECHANICAL_TRANSFORMATION_EVIDENCE_CONFLICT',
  );
  return readTaskMechanicalTransformationEvidence(inspection, candidate.tree)!;
}

/** Shared read-only check/finalize predicate for the exact current candidate. */
export function assertTaskMechanicalTransformationEvidence(
  inspection: SessionInspection,
): void {
  const task = mechanicalTask(inspection);
  if (task === null) return;
  const candidate = currentCandidate(inspection);
  const record = readTaskMechanicalTransformationEvidence(
    inspection,
    candidate.tree,
  );
  if (record === null) {
    throw workflowError(
      'TASK_MECHANICAL_TRANSFORMATION_EVIDENCE_REQUIRED',
      'Mechanical-transform checks require current engine-minted full-tree closure evidence.',
      ExitCode.verification,
      {
        recovery:
          'Rerun the managed check or finalize command so the engine can scan the exact current candidate tree.',
      },
    );
  }
}

export function readTaskMechanicalTransformationEvidence(
  inspection: SessionInspection,
  candidateTree: string,
): TaskMechanicalTransformationEvidenceRecord | null {
  const task = mechanicalTask(inspection);
  if (task === null) return null;
  if (!GIT_OBJECT.test(candidateTree)) throw evidenceCorrupt();
  const runtime = investigationRuntimePaths(
    inspection.git.gitCommonDirectory,
    inspection.contract.config.runtimeDirectory,
  );
  const target = evidenceRecordPath(
    runtime.sessions,
    inspection.session.sessionId,
    candidateTree,
  );
  if (!privatePathExists(runtime, target, evidenceCorrupt)) return null;
  const record = parseEvidenceRecord(
    readPrivateCanonicalJson(runtime, target, evidenceCorrupt),
  );
  const taskContractDigest = sha256(canonicalJson(task));
  const transformationContractDigest = sha256(
    canonicalJson(task.transformationContract),
  );
  if (
    record.sessionId !== inspection.session.sessionId ||
    record.changeId !== inspection.session.changeId ||
    record.taskId !== inspection.session.taskId ||
    canonicalJson(record.baseline) !==
      canonicalJson(inspection.session.baseline) ||
    record.candidateTree !== candidateTree ||
    canonicalJson(record.changedPaths) !==
      canonicalJson(inspection.changedPaths) ||
    record.taskContractDigest !== taskContractDigest ||
    record.transformationContractDigest !== transformationContractDigest
  ) {
    throw evidenceStale();
  }
  const node = readEvidenceNode(runtime, record.evidenceNodeId);
  assertEvidenceNodeCurrent(node, record, task);
  return record;
}

function currentCandidate(inspection: SessionInspection): { tree: string } {
  if (inspection.changedPaths.length === 0) {
    throw workflowError(
      'TASK_MECHANICAL_TRANSFORMATION_SCOPE_INVALID',
      'Mechanical-transform closure requires at least one implementation path.',
      ExitCode.verification,
    );
  }
  return previewExactStaging(
    inspection.git.repositoryRoot,
    inspection.session.baseline.head,
    [...inspection.changedPaths],
  );
}

function evidenceRecordPath(
  sessionsRoot: string,
  sessionId: string,
  candidateTree: string,
): string {
  return path.join(
    sessionsRoot,
    sessionId,
    'mechanical-transform',
    `${candidateTree}.json`,
  );
}

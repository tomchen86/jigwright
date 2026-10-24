/**
 * Creates and validates immutable planning target snapshots and migration
 * contracts.
 *
 * Invariants:
 * - Snapshots require planning or exemption planning materialization
 *   evidence.
 */
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import {
  ExitCode,
  workflowError,
  type WorkflowError,
} from '../../foundation/errors/errors.ts';
import {
  assertStoredEvidenceNode,
  createEvidenceNode,
  type EvidenceNode,
} from '../../foundation/evidence-node/evidence-node.ts';
import { normalizeExactRepositoryPath } from '../../foundation/repository-path/repository-path.ts';
import type { PlanReviewSubject } from './plan-review-subject.ts';
import {
  deepFreeze,
  hasExactKeys,
  isDigest,
  isRecord,
  sha256,
} from './plan-review-values.ts';

const TARGET_SNAPSHOT_TYPE = 'plan-review-target-snapshot';
const TARGET_SNAPSHOT_SCHEMA = 'workflow.plan-review-target-snapshot.v1';
const TARGET_SNAPSHOT_OUTPUT_SCHEMA =
  'workflow.plan-review-target-snapshot-output.v1';
const TARGET_SNAPSHOT_FILE = /^\d{4}\.artifact$/;
const MAX_TARGET_SNAPSHOT_ARTIFACTS = 4_096;

export function createPlanReviewTargetSnapshotForSubject(
  input: CreatePlanReviewTargetSnapshotInput,
  subject: PlanReviewSubject,
): EvidenceNode {
  const materializationNode = assertStoredEvidenceNode(
    input.materializationNode,
    targetSnapshotInvalid,
  );
  if (
    materializationNode.type !== 'propose-planning-materialization' &&
    materializationNode.type !== 'propose-exemption-planning-materialization'
  ) {
    throw targetSnapshotInvalid();
  }
  const relativePaths = [...input.artifacts.keys()].sort(compareUtf8);
  if (
    relativePaths.length === 0 ||
    relativePaths.length > MAX_TARGET_SNAPSHOT_ARTIFACTS ||
    new Set(relativePaths).size !== relativePaths.length
  ) {
    throw targetSnapshotInvalid();
  }
  const artifacts = relativePaths.map((relativePath, index) => {
    const content = input.artifacts.get(relativePath);
    if (!content) throw targetSnapshotInvalid();
    const path = normalizeExactRepositoryPath(
      `${input.changePrefix}/${relativePath}`,
    );
    return {
      path,
      sha256: sha256(content),
      byteLength: content.byteLength,
      lineCount: targetSnapshotLineCount(content),
      mode: '100644' as const,
      snapshotFile: `${String(index).padStart(4, '0')}.artifact`,
      mutability: targetSnapshotMutabilityFor(relativePath),
    };
  });
  const migration = createTargetSnapshotMigrationContract(artifacts);
  const fields = {
    changeId: input.changeId,
    subjectDigest: subject.subjectDigest,
    planningGenerationId: subject.planningGenerationId,
    planTargetDigest: subject.planTargetDigest,
    materializationNodeId: materializationNode.nodeId,
    materializationResultDigest: materializationNode.resultDigest,
    artifacts,
    migration,
  };
  const snapshot: PlanReviewTargetSnapshot = {
    schemaVersion: 1,
    snapshotDigest: createTargetSnapshotDigest(fields),
    ...fields,
  };
  return createEvidenceNode({
    type: TARGET_SNAPSHOT_TYPE,
    nodeSchema: TARGET_SNAPSHOT_SCHEMA,
    evaluator: TARGET_SNAPSHOT_SCHEMA,
    policyDigest: subject.reviewPolicyDigest,
    exactInputDigests: {
      subject: subject.subjectDigest,
      artifacts: sha256(canonicalJson(artifacts)),
      migration: sha256(canonicalJson(migration)),
      materialization: materializationNode.nodeId,
      materializationResult: materializationNode.resultDigest,
    },
    semanticParentResultDigests: {},
    provenanceParentNodeIds: {},
    outputSchema: TARGET_SNAPSHOT_OUTPUT_SCHEMA,
    output: snapshot,
    runtimeMetadata: {},
  });
}

export function readPlanReviewTargetSnapshotNode(
  node: EvidenceNode,
): PlanReviewTargetSnapshot {
  const stored = assertStoredEvidenceNode(node, targetSnapshotInvalid);
  if (
    stored.type !== TARGET_SNAPSHOT_TYPE ||
    stored.nodeSchema !== TARGET_SNAPSHOT_SCHEMA ||
    stored.evaluator !== TARGET_SNAPSHOT_SCHEMA ||
    stored.outputSchema !== TARGET_SNAPSHOT_OUTPUT_SCHEMA ||
    Object.keys(stored.runtimeMetadata).length !== 0
  ) {
    throw targetSnapshotInvalid();
  }
  const snapshot = assertPlanReviewTargetSnapshot(stored.output);
  if (
    stored.exactInputDigests.subject !== snapshot.subjectDigest ||
    stored.exactInputDigests.artifacts !==
      sha256(canonicalJson(snapshot.artifacts)) ||
    stored.exactInputDigests.migration !==
      sha256(canonicalJson(snapshot.migration)) ||
    stored.exactInputDigests.materialization !==
      snapshot.materializationNodeId ||
    stored.exactInputDigests.materializationResult !==
      snapshot.materializationResultDigest ||
    Object.keys(stored.semanticParentResultDigests).length !== 0 ||
    Object.keys(stored.provenanceParentNodeIds).length !== 0
  ) {
    throw targetSnapshotInvalid();
  }
  return snapshot;
}

export function assertPlanReviewTargetSnapshot(
  value: unknown,
): PlanReviewTargetSnapshot {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'snapshotDigest',
      'changeId',
      'subjectDigest',
      'planningGenerationId',
      'planTargetDigest',
      'materializationNodeId',
      'materializationResultDigest',
      'artifacts',
      'migration',
    ]) ||
    value.schemaVersion !== 1 ||
    typeof value.changeId !== 'string' ||
    !isDigest(value.snapshotDigest) ||
    !isDigest(value.subjectDigest) ||
    !isDigest(value.planningGenerationId) ||
    !isDigest(value.planTargetDigest) ||
    !isDigest(value.materializationNodeId) ||
    !isDigest(value.materializationResultDigest) ||
    !Array.isArray(value.artifacts) ||
    value.artifacts.length === 0 ||
    value.artifacts.length > MAX_TARGET_SNAPSHOT_ARTIFACTS
  ) {
    throw targetSnapshotInvalid();
  }
  const artifacts = value.artifacts.map(assertTargetSnapshotArtifact);
  for (let index = 0; index < artifacts.length; index += 1) {
    if (
      artifacts[index]!.snapshotFile !==
        `${String(index).padStart(4, '0')}.artifact` ||
      (index > 0 &&
        compareUtf8(artifacts[index - 1]!.path, artifacts[index]!.path) >= 0)
    ) {
      throw targetSnapshotInvalid();
    }
  }
  const migration = assertTargetSnapshotMigrationContract(
    value.migration,
    artifacts,
  );
  const fields = {
    changeId: value.changeId,
    subjectDigest: value.subjectDigest,
    planningGenerationId: value.planningGenerationId,
    planTargetDigest: value.planTargetDigest,
    materializationNodeId: value.materializationNodeId,
    materializationResultDigest: value.materializationResultDigest,
    artifacts,
    migration,
  };
  if (createTargetSnapshotDigest(fields) !== value.snapshotDigest) {
    throw targetSnapshotInvalid();
  }
  return deepFreeze({
    schemaVersion: 1,
    snapshotDigest: value.snapshotDigest,
    ...fields,
  }) as PlanReviewTargetSnapshot;
}

function assertTargetSnapshotArtifact(
  value: unknown,
): PlanReviewTargetSnapshotArtifact {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'path',
      'sha256',
      'byteLength',
      'lineCount',
      'mode',
      'snapshotFile',
      'mutability',
    ]) ||
    typeof value.path !== 'string' ||
    normalizeExactRepositoryPath(value.path) !== value.path ||
    !isDigest(value.sha256) ||
    !Number.isSafeInteger(value.byteLength) ||
    Number(value.byteLength) < 0 ||
    !Number.isSafeInteger(value.lineCount) ||
    Number(value.lineCount) < 0 ||
    value.mode !== '100644' ||
    typeof value.snapshotFile !== 'string' ||
    !TARGET_SNAPSHOT_FILE.test(value.snapshotFile) ||
    ![
      'preserved-byte-identical',
      'replaceable-on-replanning',
      'engine-managed',
    ].includes(String(value.mutability))
  ) {
    throw targetSnapshotInvalid();
  }
  return {
    path: value.path,
    sha256: value.sha256,
    byteLength: value.byteLength as number,
    lineCount: value.lineCount as number,
    mode: '100644',
    snapshotFile: value.snapshotFile,
    mutability: value.mutability as PlanningArtifactMutability,
  };
}

function createTargetSnapshotMigrationContract(
  artifacts: PlanReviewTargetSnapshotArtifact[],
): PlanReviewMigrationContract {
  const byMutability = (kind: PlanningArtifactMutability) =>
    artifacts
      .filter(({ mutability }) => mutability === kind)
      .map(({ path }) => path);
  return {
    legacyMigration: false,
    preservedPaths: byMutability('preserved-byte-identical'),
    replaceablePaths: byMutability('replaceable-on-replanning'),
    engineManagedPaths: byMutability('engine-managed'),
    guardSemanticDigest: null,
  };
}

function assertTargetSnapshotMigrationContract(
  value: unknown,
  artifacts: PlanReviewTargetSnapshotArtifact[],
): PlanReviewMigrationContract {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'legacyMigration',
      'preservedPaths',
      'replaceablePaths',
      'engineManagedPaths',
      'guardSemanticDigest',
    ]) ||
    value.legacyMigration !== false ||
    value.guardSemanticDigest !== null
  ) {
    throw targetSnapshotInvalid();
  }
  const expected: PlanReviewMigrationContract = {
    legacyMigration: false,
    preservedPaths: artifacts
      .filter(({ mutability }) => mutability === 'preserved-byte-identical')
      .map(({ path }) => path),
    replaceablePaths: artifacts
      .filter(({ mutability }) => mutability === 'replaceable-on-replanning')
      .map(({ path }) => path),
    engineManagedPaths: artifacts
      .filter(({ mutability }) => mutability === 'engine-managed')
      .map(({ path }) => path),
    guardSemanticDigest: null,
  };
  if (
    canonicalJson(value.preservedPaths) !==
      canonicalJson(expected.preservedPaths) ||
    canonicalJson(value.replaceablePaths) !==
      canonicalJson(expected.replaceablePaths) ||
    canonicalJson(value.engineManagedPaths) !==
      canonicalJson(expected.engineManagedPaths) ||
    expected.preservedPaths.length > 0
  ) {
    throw targetSnapshotInvalid();
  }
  return expected;
}

function targetSnapshotMutabilityFor(
  relativePath: string,
): PlanningArtifactMutability {
  if (
    relativePath === '.openspec.yaml' ||
    relativePath === 'investigation.json'
  ) {
    return 'engine-managed';
  }
  return 'replaceable-on-replanning';
}

function createTargetSnapshotDigest(
  fields: Omit<PlanReviewTargetSnapshot, 'schemaVersion' | 'snapshotDigest'>,
): string {
  return sha256(
    canonicalJson({
      schema: TARGET_SNAPSHOT_SCHEMA,
      ...fields,
    }),
  );
}

export function planReviewSnapshotLineCount(content: Buffer): number {
  return targetSnapshotLineCount(content);
}

function targetSnapshotLineCount(content: Buffer): number {
  if (content.byteLength === 0) return 0;
  let count = 1;
  for (const byte of content) {
    if (byte === 0x0a) count += 1;
  }
  return content.at(-1) === 0x0a ? count - 1 : count;
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function targetSnapshotInvalid(): WorkflowError {
  return workflowError(
    'PLAN_REVIEW_TARGET_SNAPSHOT_INVALID',
    'PlanReview target snapshot is malformed or no longer bound.',
    ExitCode.verification,
  );
}

import type {
  PlanningArtifactMutability,
  PlanReviewTargetSnapshotArtifact,
  PlanReviewMigrationContract,
  PlanReviewTargetSnapshot,
  CreatePlanReviewTargetSnapshotInput,
} from './plan-review-target-snapshot-record.ts';
export type {
  PlanningArtifactMutability,
  PlanReviewTargetSnapshotArtifact,
  PlanReviewMigrationContract,
  PlanReviewTargetSnapshot,
  CreatePlanReviewTargetSnapshotInput,
} from './plan-review-target-snapshot-record.ts';

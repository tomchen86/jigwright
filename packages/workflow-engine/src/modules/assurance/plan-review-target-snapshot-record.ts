/** Canonical plan review target snapshot record data; parsing and effects stay with their existing implementation. */
import type { EvidenceNode } from '@jigwright/core/evidence-node';
import type { PlanReviewSubject } from './plan-review-subject.ts';

export type PlanningArtifactMutability =
  'preserved-byte-identical' | 'replaceable-on-replanning' | 'engine-managed';

export type PlanReviewTargetSnapshotArtifact = {
  path: string;
  sha256: string;
  byteLength: number;
  lineCount: number;
  mode: '100644';
  snapshotFile: string;
  mutability: PlanningArtifactMutability;
};

export type PlanReviewMigrationContract = {
  legacyMigration: false;
  preservedPaths: string[];
  replaceablePaths: string[];
  engineManagedPaths: string[];
  guardSemanticDigest: null;
};

export type PlanReviewTargetSnapshot = {
  schemaVersion: 1;
  snapshotDigest: string;
  changeId: string;
  subjectDigest: string;
  planningGenerationId: string;
  planTargetDigest: string;
  materializationNodeId: string;
  materializationResultDigest: string;
  artifacts: PlanReviewTargetSnapshotArtifact[];
  migration: PlanReviewMigrationContract;
};

export type CreatePlanReviewTargetSnapshotInput = {
  changeId: string;
  changePrefix: string;
  subject: PlanReviewSubject;
  materializationNode: EvidenceNode;
  artifacts: Map<string, Buffer>;
};

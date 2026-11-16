/** Canonical task strategy implementation manifest data; parsing and effects stay with their existing implementation. */
import type { BehaviorContractRef } from '../planning-provider/planning-artifact-types.ts';
import type {
  TaskStrategyGreenFailureRecord,
  TaskStrategyPatchHead,
} from './task-strategy-correction-record.ts';

export type TaskStrategyImplementationFrozenFile = Readonly<{
  path: string;
  mode: '100644' | '100755';
  objectId: string;
}>;

export type TaskStrategyImplementationCorrection = Readonly<{
  round: number;
  greenFailureRecordDigest: string;
  greenFailureSubjectDigest: string;
  candidateTree: string;
  failingCheckFingerprint: string;
  currentPatchHead: TaskStrategyPatchHead;
}>;

export type TaskStrategyImplementationSubject = Readonly<{
  schemaVersion: 1;
  kind: 'task-strategy-implementation-subject.v1';
  subjectDigest: string;
  sessionId: string;
  changeId: string;
  taskId: string;
  strategy: 'cross-agent-tdd' | 'tdd-single-agent';
  transactionDigest: string;
  taskContractDigest: string;
  sourceTree: string;
  failureFingerprint: string;
  redEvidenceNodeId: string;
  redEvidenceResultDigest: string;
  testPaths: readonly string[];
  fixturePaths: readonly string[];
  frozenFiles: readonly TaskStrategyImplementationFrozenFile[];
  correction?: TaskStrategyImplementationCorrection;
}>;

export type TaskStrategyImplementationManifest = Readonly<{
  schemaVersion: 1;
  kind: 'task-strategy-implementation-manifest';
  repositoryId: string;
  baseCommit: string;
  baseTree: string;
  subject: TaskStrategyImplementationSubject;
  behaviorContractRefs: readonly BehaviorContractRef[];
  implementationPathScopes: readonly string[];
  capabilityProfile: 'repository-read-only';
  greenFailureRecord?: TaskStrategyGreenFailureRecord;
}>;

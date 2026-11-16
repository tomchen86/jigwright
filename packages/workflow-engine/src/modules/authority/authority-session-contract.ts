/** Durable state of an authority session and its pinned checks. */
import type { CheckDefinition } from '../source/check-command.ts';
import type { PinnedCheckRunner } from '../source/check-command.ts';
import type { TaskMandateBinding } from './task-mandate-contract.ts';
export type AuthorityPinnedCheck = {
  checkId: string;
  definition: CheckDefinition;
  runner: PinnedCheckRunner;
};

export type AuthoritySession = {
  schemaVersion: 1;
  sessionId: string;
  state: 'active' | 'failed' | 'aborted' | 'committed';
  grantVersion: 2;
  grantId: string;
  changeId: string;
  repositoryRoot: string;
  gitCommonDirectory: string;
  branch: string;
  baseCommit: string;
  baselineTree: string;
  policyBlob: string;
  policyDigest: string;
  grantDigest: string;
  signer: string;
  contractDigest: string;
  contractArtifacts: Record<string, string>;
  allowedPaths: string[];
  requiredChecks: string[];
  pinnedChecks: AuthorityPinnedCheck[];
  candidateCommit: string | null;
  resultTree: string | null;
  candidateBundleDigest: string | null;
  mandateBinding: TaskMandateBinding | null;
  expectedRefGeneration: number | null;
  createdAt: string;
  latestCheckReportId?: string;
  failedAt?: string;
  failureReason?: string;
  abortedAt?: string;
  abortReason?: string;
  committedAt?: string;
  commitHash?: string;
};

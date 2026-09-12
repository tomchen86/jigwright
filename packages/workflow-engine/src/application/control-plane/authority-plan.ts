import type { CandidateExternalEffect } from '../../modules/authority/maintainer-candidate-contracts.ts';
import type { AuthorityApplicationReceiptOperations } from '../../modules/authority/authority-application-receipt.ts';
import type { MaintainerManifestOperations } from '../../modules/authority/maintainer-manifest.ts';
/**
 * Coordinates authority plan preparation, approval, application, resumption
 * and attestation.
 *
 * Invariants:
 * - Preparation requires a clean worktree on the configured branch for the
 *   named change.
 */
import { createAuthorityPlanRecords } from './authority-plan-records.ts';
import { createAuthorityPlanWorktree } from './authority-plan-worktree.ts';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { isRecord } from '../../foundation/canonical-json/contract-values.ts';
import { loadWorkflowConfig } from '../../runtime/repository-observation/workflow-configuration.ts';
import { authorityTagPublishCommand } from '../../adapters/remote/github/authority-relay-command.ts';
import {
  ExitCode,
  workflowError,
  type WorkflowError,
} from '../../foundation/errors/errors.ts';
import {
  discoverRepository,
  runGit,
} from '../../runtime/repository-transaction/git.ts';
import {
  createPrivateCanonicalJson,
  readPrivateCanonicalJson,
  assertPrivateInvestigationDirectory,
  withPrivateRuntimeLock,
} from '../../runtime/storage-journal/investigation-private-files.ts';
import {
  type AuthorityAttestationOperations,
  type AuthorityAttestationRelayProjection,
  type AuthorityAttestationRequest,
} from './maintainer-attestation.ts';
import {
  approveAndApplyMaintainerGrantV2,
  type ApproveAndApplyMaintainerGrantV2Request,
} from './maintainer-approve.ts';

import type { MaintainerEvidenceWaiver } from '../../modules/authority/maintainer-grant-v2-codec.ts';
import { parseMaintainerPolicy } from '../../modules/authority/maintainer-policy.ts';

import { classifyFileRole } from '../../modules/authority/maintainer-manifest-contracts.ts';
import { parseManagedTrailers } from '@jigwright/core/managed-transition-trailers';
import {
  isManagedAuthorityPlanState,
  type ManagedAuthorityPlanState,
} from '../../modules/lifecycle/managed-workflow-state-contract.ts';
import {
  assertPolicyPathInsideRepository,
  investigationRuntimePaths,
} from '../../runtime/session-workspace/paths.ts';
import {
  assertChangeId,
  assertTaskId,
  normalizeExactRepositoryPath,
} from '../../foundation/repository-path/repository-path.ts';

const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const PLAN_ID = /^authority-plan-[0-9a-f]{64}$/;
const REVISION_FILE = /^(\d{6})\.json$/;
const MAX_MUTATIONS = 64;
const MAX_CONTENT_BYTES = 4 * 1024 * 1024;
const MAX_REVISIONS = 32;

export type AuthorityPlanMutation = Readonly<{
  path: string;
  expectedBeforeSha256: string | null;
  content: string | null;
}>;

export type AuthorityPlanIntent = Readonly<{
  schemaVersion: 1;
  kind: 'authority-plan-intent.v1';
  changeId: string;
  taskId: string;
  profileId: string;
  reason: string;
  message: string;
  mutations: readonly AuthorityPlanMutation[];
  externalEffects: readonly CandidateExternalEffect[];
  evidenceWaivers: readonly MaintainerEvidenceWaiver[];
}>;

export type AuthorityPlanPreviewEntry = Readonly<{
  path: string;
  beforeSha256: string | null;
  afterSha256: string | null;
  unifiedDiff: string;
}>;

export type AuthorityPlanLocalApplication = Readonly<{
  grantId: string;
  sessionId: string | null;
  commitHash: string;
  resultTree: string;
  tagRef: string;
  publishCommand: string;
  attestationRelayCommand: string;
  applicationReceiptTagRef: string;
}>;

export type AuthorityPlanAttestation = Readonly<{
  grantId: string;
  originalCommit: string;
  mainCommit: string;
  tagRef: string;
  publishCommand: string;
  envelopeDigest: string;
}>;

export type AuthorityPlanState = ManagedAuthorityPlanState;

export type AuthorityPlanRecord = Readonly<{
  schemaVersion: 1;
  kind: 'authority-plan-record.v1';
  planId: string;
  revision: number;
  previousRecordDigest: string | null;
  recordDigest: string;
  createdAt: string;
  updatedAt: string;
  state: AuthorityPlanState;
  branch: string;
  baseCommit: string;
  baseTree: string;
  intentDigest: string;
  intent: AuthorityPlanIntent;
  preview: readonly AuthorityPlanPreviewEntry[];
  localApplication: AuthorityPlanLocalApplication | null;
  relay: AuthorityAttestationRelayProjection | null;
  attestation: AuthorityPlanAttestation | null;
  friction: Readonly<{
    operatorSigningCeremonies: 0 | 1 | 2;
    publishedTagHandoffs: 0 | 1 | 2;
    remoteMergeObserved: boolean;
  }>;
}>;

type ApprovalResult = Readonly<{
  grantId: string;
  sessionId?: string | null;
  commitHash: string;
  resultTree: string;
  tagRef: string;
  publishCommand: string;
  attestationRelayCommand: string;
  applicationReceiptTagRef: string;
}>;

type AttestationResult = Readonly<{
  grantId: string;
  tagRef: string;
  publishCommand: string;
  envelope?: unknown;
  envelopeDigest?: string;
  originalCommit?: string;
  mainCommit?: string;
}>;

export type AuthorityPlanCreateOptions = Readonly<{ now?: Date }>;

export type AuthorityPlanApproveOptions = Readonly<{
  now?: Date;
  approveAndApply?: (
    cwd: string,
    request: ApproveAndApplyMaintainerGrantV2Request,
  ) => ApprovalResult;
  testCrashAfter?: 'local-apply-result';
}>;

export type AuthorityPlanResumeOptions = Readonly<{
  now?: Date;
  refreshRemote?: (cwd: string) => void;
  observePublishedRef?: (ref: string) => string | null;
  projectAttestationRelay?: (
    cwd: string,
    originalCommit: string,
  ) => AuthorityAttestationRelayProjection;
}>;

export type AuthorityPlanAttestOptions = Readonly<{
  now?: Date;
  issueAttestation?: (
    cwd: string,
    request: AuthorityAttestationRequest,
  ) => AttestationResult;
}>;

export function createAuthorityPlan(
  manifestOperations: MaintainerManifestOperations,
  cwd: string,
  candidateIntent: AuthorityPlanIntent,
  options: AuthorityPlanCreateOptions = {},
): AuthorityPlanRecord {
  const repository = discoverRepository(cwd);
  if (!repository.branch || repository.statusEntries.length !== 0) {
    throw planError(
      'AUTHORITY_PLAN_WORKTREE_CHANGED',
      'An authority plan requires a clean named worktree.',
      ExitCode.conflict,
    );
  }
  const config = loadWorkflowConfig(repository.repositoryRoot);
  const intent = parseIntent(candidateIntent);
  const expectedBranch = config.branchTemplate.replace(
    '{changeId}',
    intent.changeId,
  );
  if (repository.branch !== expectedBranch) {
    throw planError(
      'AUTHORITY_PLAN_BRANCH_INVALID',
      `Authority plan ${intent.changeId} requires branch ${expectedBranch}.`,
      ExitCode.staleState,
    );
  }
  const profile = manifestOperations.loadCapabilityProfileFromTrustBase(
    repository.repositoryRoot,
    repository.head,
    intent.profileId,
  );
  if (intent.mutations.length > profile.constraints.maximumFiles) {
    throw planInvalid('Authority plan exceeds its profile file limit.');
  }
  const preview = intent.mutations.map((mutation) => {
    const role = classifyFileRole(profile, mutation.path);
    if (role === undefined || role === 'forbidden') {
      throw planInvalid(
        `Authority plan path is not allowed by ${intent.profileId}: ${mutation.path}`,
      );
    }
    return previewMutation(repository.repositoryRoot, mutation);
  });
  const intentDigest = digest(intent);
  const planId = `authority-plan-${digest({
    schema: 'authority-plan.v1',
    branch: repository.branch,
    baseCommit: repository.head,
    baseTree: repository.tree,
    intentDigest,
    preview,
  })}`;
  const runtime = authorityPlanRuntime(repository);
  const existing = readLatest(runtime, planId, true);
  if (existing !== null) return existing;
  const createdAt = exactTime(options.now);
  return withPlanLock(runtime, planId, () => {
    const raced = readLatest(runtime, planId, true);
    if (raced !== null) return raced;
    return appendRecord(runtime, {
      schemaVersion: 1,
      kind: 'authority-plan-record.v1',
      planId,
      revision: 1,
      previousRecordDigest: null,
      createdAt,
      updatedAt: createdAt,
      state: 'prepared',
      branch: repository.branch!,
      baseCommit: repository.head,
      baseTree: repository.tree,
      intentDigest,
      intent,
      preview,
      localApplication: null,
      relay: null,
      attestation: null,
      friction: {
        operatorSigningCeremonies: 0,
        publishedTagHandoffs: 0,
        remoteMergeObserved: false,
      },
    });
  });
}

/** Strict read-only inspection. It never creates runtime directories. */
export function inspectAuthorityPlan(
  cwd: string,
  requestedPlanId: string,
): AuthorityPlanRecord {
  const planId = assertPlanId(requestedPlanId);
  const repository = discoverRepository(cwd);
  const record = readLatest(authorityPlanRuntime(repository), planId, false);
  if (record === null) {
    throw planError(
      'AUTHORITY_PLAN_NOT_FOUND',
      `Authority plan ${planId} does not exist.`,
      ExitCode.usage,
    );
  }
  return record;
}

export function approveAndApplyAuthorityPlan(
  withAuthorityRefusalAudit: WithAuthorityRefusalAudit,
  grantServices: MaintainerGrantExecutionServices,
  authorityApplicationReceipts: AuthorityApplicationReceiptOperations,
  manifestOperations: MaintainerManifestOperations,
  taskMandate: MaintainerTaskMandateOperations,
  cwd: string,
  requestedPlanId: string,
  options: AuthorityPlanApproveOptions = {},
): AuthorityPlanRecord {
  const planId = assertPlanId(requestedPlanId);
  const repository = discoverRepository(cwd);
  const runtime = authorityPlanRuntime(repository);
  return withPlanLock(runtime, planId, () => {
    let record = requireLatest(runtime, planId);
    if (
      record.state === 'local-applied' ||
      record.state === 'awaiting-attestation' ||
      record.state === 'attestation-issued' ||
      record.state === 'completed'
    ) {
      return record;
    }
    if (record.state === 'prepared') {
      assertPreparedWorktree(repository.repositoryRoot, record);
      record = transition(runtime, record, {
        state: 'applying-local',
        updatedAt: exactTime(options.now),
      });
    }
    const current = discoverRepository(repository.repositoryRoot);
    if (current.head !== record.baseCommit) {
      const recovered = recoverLocalApplication(current.repositoryRoot, record);
      return transition(runtime, record, {
        state: 'local-applied',
        updatedAt: exactTime(options.now),
        localApplication: recovered,
        friction: {
          operatorSigningCeremonies: 1,
          publishedTagHandoffs: 0,
          remoteMergeObserved: false,
        },
      });
    }
    assertApplyingWorktree(current.repositoryRoot, record);
    if (discoverRepository(current.repositoryRoot).statusEntries.length === 0) {
      applyMutations(current.repositoryRoot, record.intent.mutations);
    }
    const approve =
      options.approveAndApply ??
      ((root: string, request: ApproveAndApplyMaintainerGrantV2Request) =>
        approveAndApplyMaintainerGrantV2(
          withAuthorityRefusalAudit,
          grantServices,
          authorityApplicationReceipts,
          manifestOperations,
          taskMandate,
          root,
          request,
          {
            now: options.now,
          },
        ));
    let applied: ApprovalResult;
    try {
      applied = approve(current.repositoryRoot, approvalRequest(record.intent));
    } catch (error) {
      const afterFailure = discoverRepository(current.repositoryRoot);
      if (afterFailure.head === record.baseCommit) {
        restoreMutations(current.repositoryRoot, record);
      }
      throw error;
    }
    const normalized = normalizeApplication(
      current.repositoryRoot,
      record,
      applied,
    );
    if (options.testCrashAfter === 'local-apply-result') {
      throw new Error(
        'Simulated authority-plan interruption after local apply result.',
      );
    }
    return transition(runtime, record, {
      state: 'local-applied',
      updatedAt: exactTime(options.now),
      localApplication: normalized,
      friction: {
        operatorSigningCeremonies: 1,
        publishedTagHandoffs: 0,
        remoteMergeObserved: false,
      },
    });
  });
}

export function resumeAuthorityPlan(
  authorityAttestation: AuthorityAttestationOperations,
  authorityApplicationReceipts: AuthorityApplicationReceiptOperations,
  cwd: string,
  requestedPlanId: string,
  options: AuthorityPlanResumeOptions = {},
): AuthorityPlanRecord {
  const planId = assertPlanId(requestedPlanId);
  const repository = discoverRepository(cwd);
  const runtime = authorityPlanRuntime(repository);
  return withPlanLock(runtime, planId, () => {
    let record = requireLatest(runtime, planId);
    if (record.state === 'completed' || record.state === 'prepared') {
      return record;
    }
    if (record.state === 'applying-local') {
      const current = discoverRepository(repository.repositoryRoot);
      if (current.head === record.baseCommit) return record;
      record = transition(runtime, record, {
        state: 'local-applied',
        updatedAt: exactTime(options.now),
        localApplication: recoverLocalApplication(
          repository.repositoryRoot,
          record,
        ),
        friction: {
          operatorSigningCeremonies: 1,
          publishedTagHandoffs: 0,
          remoteMergeObserved: false,
        },
      });
    }
    const refresh =
      options.refreshRemote ??
      ((root: string) => {
        runGit(root, ['fetch', '--prune', 'origin']);
      });
    const observe =
      options.observePublishedRef ??
      ((ref: string) => observeRemoteRef(repository.repositoryRoot, ref));
    if (record.state === 'local-applied') {
      refresh(repository.repositoryRoot);
      if (observe(record.localApplication!.tagRef) === null) return record;
      const project =
        options.projectAttestationRelay ??
        authorityAttestation.projectAuthorityAttestationRelay.bind(
          undefined,
          authorityApplicationReceipts,
        );
      const relay = project(
        repository.repositoryRoot,
        record.localApplication!.commitHash,
      );
      assertRelay(record, relay);
      return transition(runtime, record, {
        state: 'awaiting-attestation',
        updatedAt: exactTime(options.now),
        relay,
        friction: {
          operatorSigningCeremonies: 1,
          publishedTagHandoffs: 1,
          remoteMergeObserved: true,
        },
      });
    }
    if (record.state === 'awaiting-attestation') return record;
    if (record.state === 'attestation-issued') {
      refresh(repository.repositoryRoot);
      if (observe(record.attestation!.tagRef) === null) return record;
      return transition(runtime, record, {
        state: 'completed',
        updatedAt: exactTime(options.now),
        friction: {
          operatorSigningCeremonies: 2,
          publishedTagHandoffs: 2,
          remoteMergeObserved: true,
        },
      });
    }
    return record;
  });
}

export function attestAuthorityPlan(
  authorityAttestation: AuthorityAttestationOperations,
  authorityApplicationReceipts: AuthorityApplicationReceiptOperations,
  cwd: string,
  requestedPlanId: string,
  options: AuthorityPlanAttestOptions = {},
): AuthorityPlanRecord {
  const planId = assertPlanId(requestedPlanId);
  const repository = discoverRepository(cwd);
  const runtime = authorityPlanRuntime(repository);
  return withPlanLock(runtime, planId, () => {
    const record = requireLatest(runtime, planId);
    if (record.state === 'attestation-issued' || record.state === 'completed') {
      return record;
    }
    if (record.state !== 'awaiting-attestation' || record.relay === null) {
      throw planError(
        'AUTHORITY_PLAN_ATTESTATION_NOT_READY',
        'Authority plan attestation requires an observed protected-branch merge.',
        ExitCode.conflict,
      );
    }
    const request: AuthorityAttestationRequest = {
      originalCommit: record.relay.originalCommit,
      mainCommit: record.relay.mainCommit,
      grantBasePairs: record.relay.grantBasePairs,
    };
    const issue =
      options.issueAttestation ??
      ((root: string, value: AuthorityAttestationRequest) =>
        authorityAttestation.issueAuthorityAttestation(
          authorityApplicationReceipts,
          root,
          value,
          {
            now: options.now,
          },
        ));
    const issued = issue(
      repository.repositoryRoot,
      request,
    ) as AttestationResult;
    const envelopeDigest =
      issued.envelopeDigest ?? digest(assertJsonValue(issued.envelope));
    const attestation: AuthorityPlanAttestation = {
      grantId: issued.grantId,
      originalCommit: issued.originalCommit ?? request.originalCommit,
      mainCommit: issued.mainCommit ?? request.mainCommit,
      tagRef: issued.tagRef,
      publishCommand: issued.publishCommand,
      envelopeDigest,
    };
    if (
      attestation.grantId !== record.relay.grantId ||
      attestation.originalCommit !== record.relay.originalCommit ||
      attestation.mainCommit !== record.relay.mainCommit ||
      attestation.tagRef !== record.relay.tagRef ||
      !SHA256.test(attestation.envelopeDigest)
    ) {
      throw planUnsafe('Issued attestation does not match the durable relay.');
    }
    return transition(runtime, record, {
      state: 'attestation-issued',
      updatedAt: exactTime(options.now),
      attestation,
      friction: {
        operatorSigningCeremonies: 2,
        publishedTagHandoffs: 1,
        remoteMergeObserved: true,
      },
    });
  });
}

function approvalRequest(
  intent: AuthorityPlanIntent,
): ApproveAndApplyMaintainerGrantV2Request {
  return {
    changeId: intent.changeId,
    taskId: intent.taskId,
    profileId: intent.profileId,
    reason: intent.reason,
    message: intent.message,
    externalEffects: [...structuredClone(intent.externalEffects)],
    evidenceWaivers: [...structuredClone(intent.evidenceWaivers)],
  };
}

/** Validate and normalize an authority-plan intent without preparing a plan. */
export function parseAuthorityPlanIntent(value: unknown): AuthorityPlanIntent {
  return parseIntent(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return (
    canonicalJson(Object.keys(value).sort()) === canonicalJson([...keys].sort())
  );
}

function assertJsonValue(value: unknown): unknown {
  canonicalJson(value);
  return value;
}

function digest(value: unknown): string {
  return digestBytes(canonicalJson(value));
}

function digestBytes(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function exactTime(now: Date | undefined): string {
  const value = now === undefined ? new Date() : new Date(now);
  if (!Number.isFinite(value.getTime()))
    throw planInvalid('Authority plan time is invalid.');
  return value.toISOString();
}

function isExactTime(value: string): boolean {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function planInvalid(message: string): WorkflowError {
  return planError('AUTHORITY_PLAN_INVALID', message, ExitCode.guard);
}

function planUnsafe(
  message = 'Authority plan durable state is unsafe.',
): WorkflowError {
  return planError(
    'AUTHORITY_PLAN_STORE_UNSAFE',
    message,
    ExitCode.unsafeEnvironment,
  );
}

function planError(
  code: string,
  message: string,
  exitCode: (typeof ExitCode)[keyof typeof ExitCode],
): WorkflowError {
  return workflowError(code, message, exitCode);
}

export type AuthorityPlanRecordsBindings = {
  loadWorkflowConfig: typeof loadWorkflowConfig;
  investigationRuntimePaths: typeof investigationRuntimePaths;
  withPrivateRuntimeLock: typeof withPrivateRuntimeLock;
  path: typeof path;
  planUnsafe: typeof planUnsafe;
  digest: typeof digest;
  createPrivateCanonicalJson: typeof createPrivateCanonicalJson;
  readPrivateCanonicalJson: typeof readPrivateCanonicalJson;
  fs: typeof fs;
  assertPrivateInvestigationDirectory: typeof assertPrivateInvestigationDirectory;
  MAX_REVISIONS: typeof MAX_REVISIONS;
  REVISION_FILE: typeof REVISION_FILE;
  canonicalJson: typeof canonicalJson;
  planError: typeof planError;
  ExitCode: typeof ExitCode;
  isRecord: typeof isRecord;
  hasExactKeys: typeof hasExactKeys;
  PLAN_ID: typeof PLAN_ID;
  SHA256: typeof SHA256;
  isExactTime: typeof isExactTime;
  isManagedAuthorityPlanState: typeof isManagedAuthorityPlanState;
  COMMIT_OID: typeof COMMIT_OID;
  parseIntent: typeof parseIntent;
};
export type AuthorityPlanRecordsBindingsTypes = {
  AuthorityPlanRecord: AuthorityPlanRecord;
  discoverRepository: typeof discoverRepository;
  investigationRuntimePaths: typeof investigationRuntimePaths;
};

const {
  authorityPlanRuntime,
  withPlanLock,
  appendRecord,
  transition,
  readLatest,
  requireLatest,
  assertPlanId,
} = createAuthorityPlanRecords(() => ({
  loadWorkflowConfig,
  investigationRuntimePaths,
  withPrivateRuntimeLock,
  path,
  planUnsafe,
  digest,
  createPrivateCanonicalJson,
  readPrivateCanonicalJson,
  fs,
  assertPrivateInvestigationDirectory,
  MAX_REVISIONS,
  REVISION_FILE,
  canonicalJson,
  planError,
  ExitCode,
  isRecord,
  hasExactKeys,
  PLAN_ID,
  SHA256,
  isExactTime,
  isManagedAuthorityPlanState,
  COMMIT_OID,
  parseIntent,
}));

export type AuthorityPlanWorktreeBindings = {
  isRecord: typeof isRecord;
  hasExactKeys: typeof hasExactKeys;
  MAX_MUTATIONS: typeof MAX_MUTATIONS;
  planInvalid: typeof planInvalid;
  assertChangeId: typeof assertChangeId;
  assertTaskId: typeof assertTaskId;
  canonicalJson: typeof canonicalJson;
  SHA256: typeof SHA256;
  MAX_CONTENT_BYTES: typeof MAX_CONTENT_BYTES;
  normalizeExactRepositoryPath: typeof normalizeExactRepositoryPath;
  assertPolicyPathInsideRepository: typeof assertPolicyPathInsideRepository;
  path: typeof path;
  fs: typeof fs;
  digestBytes: typeof digestBytes;
  planError: typeof planError;
  ExitCode: typeof ExitCode;
  discoverRepository: typeof discoverRepository;
  planUnsafe: typeof planUnsafe;
  runGit: typeof runGit;
  COMMIT_OID: typeof COMMIT_OID;
  parseManagedTrailers: typeof parseManagedTrailers;
  parseMaintainerPolicy: typeof parseMaintainerPolicy;
  authorityTagPublishCommand: typeof authorityTagPublishCommand;
};
export type AuthorityPlanWorktreeBindingsTypes = {
  AuthorityPlanIntent: AuthorityPlanIntent;
  AuthorityPlanMutation: AuthorityPlanMutation;
  CandidateExternalEffect: CandidateExternalEffect;
  MaintainerEvidenceWaiver: MaintainerEvidenceWaiver;
  AuthorityPlanPreviewEntry: AuthorityPlanPreviewEntry;
  AuthorityPlanRecord: AuthorityPlanRecord;
  ApprovalResult: ApprovalResult;
  AuthorityPlanLocalApplication: AuthorityPlanLocalApplication;
  AuthorityAttestationRelayProjection: AuthorityAttestationRelayProjection;
};

const {
  parseIntent,
  previewMutation,
  assertPreparedWorktree,
  assertApplyingWorktree,
  applyMutations,
  restoreMutations,
  normalizeApplication,
  recoverLocalApplication,
  assertRelay,
  observeRemoteRef,
} = createAuthorityPlanWorktree(() => ({
  isRecord,
  hasExactKeys,
  MAX_MUTATIONS,
  planInvalid,
  assertChangeId,
  assertTaskId,
  canonicalJson,
  SHA256,
  MAX_CONTENT_BYTES,
  normalizeExactRepositoryPath,
  assertPolicyPathInsideRepository,
  path,
  fs,
  digestBytes,
  planError,
  ExitCode,
  discoverRepository,
  planUnsafe,
  runGit,
  COMMIT_OID,
  parseManagedTrailers,
  parseMaintainerPolicy,
  authorityTagPublishCommand,
}));

import type { MaintainerTaskMandateOperations } from '../../modules/authority/maintainer-grant-v2.ts';

import type { MaintainerGrantExecutionServices } from './maintainer-grant-v2.ts';

import type { WithAuthorityRefusalAudit } from '../../modules/authority/authority-audit-contract.ts';

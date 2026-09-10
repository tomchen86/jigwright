/**
 * Initializes and publishes protected bases through bound Grant and Git
 * observations.
 *
 * Invariants:
 * - Fetch and push remote identities must match the canonical repository
 *   origin.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { CentralGrantCompletedAuthorityRefV1 } from '@jigwright/core/central-grant-port';

import { loadWorkflowConfig } from '../adapters/consumer/repository/work-registry/contracts.ts';
import { canonicalJson } from '../foundation/canonical-json/canonical-json.ts';
import { isRecord } from '../foundation/canonical-json/contract-values.ts';
import { ExitCode, workflowError } from '../foundation/errors/errors.ts';
import type { GrantExecutionResult } from '../modules/authority/grant-coordinator.ts';
import {
  PROTECTED_BASE_INITIALIZATION_TRANSITION_ID,
  assertProtectedBaseInitializationParameters,
  protectedBaseInitializationStateBinding,
  type ProtectedBaseInitializationParametersV1,
} from '../modules/authority/protected-base-initialization-grant.ts';
import { loadMaintainerPolicy } from '../modules/authority/maintainer-policy.ts';
import type {
  ProtectedBaseInitializationObservationV1,
  ProtectedBaseInitializationPort,
} from '../modules/authority/protected-base-initialization-grant.ts';
import { ensurePlainDirectory } from '../runtime/repository-transaction/filesystem-safety.ts';
import {
  discoverRepository,
  protectedBranchRef,
  runGit,
} from '../runtime/repository-transaction/git.ts';
import {
  grantStorePaths,
  readGrantRecord,
} from '../runtime/storage-journal/grant-store.ts';
import { loadInvestigationRuntimeContext } from './lifecycle-context.ts';

const COMMIT_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SIMPLE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const BRANCH_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/;
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;
const COMPLETED_GRANT_MAX_AGE_MS = 10 * 60_000;

export type CompletedProtectedBaseInitializationGrantReferenceV1 =
  CentralGrantCompletedAuthorityRefV1 &
    Readonly<{
      transitionId: typeof PROTECTED_BASE_INITIALIZATION_TRANSITION_ID;
    }>;

export type ProtectedBaseInitializationPublicationReceiptV1 = Readonly<{
  schemaVersion: 1;
  kind: 'protected-base-initialization-publication-receipt.v1';
  authority: CompletedProtectedBaseInitializationGrantReferenceV1;
  repositoryId: string;
  canonicalOrigin: string;
  remoteName: string;
  protectedBranch: string;
  sourceCommit: string;
  sourceTree: string;
  remoteRef: string;
  remoteCommit: string;
  trackingRef: string;
  trackingCommit: string;
  leaseExpectation: 'remote-ref-absent';
  overwrite: false;
  disposition: 'created' | 'recovered';
  publishedAt: string;
  receiptDigest: `sha256:${string}`;
}>;

export type PublishCompletedProtectedBaseInitializationInput = Readonly<{
  repositoryRoot: string;
  runtimeRoot: string;
  challengeId: string;
  port: ProtectedBaseInitializationPort;
  now?: Date;
}>;

export function createProductionProtectedBaseInitializationPort(
  cwd: string,
): ProtectedBaseInitializationPort {
  const repositoryRoot = discoverRepository(cwd).repositoryRoot;
  return Object.freeze({
    observe() {
      const config = loadWorkflowConfig(repositoryRoot);
      const policy = loadMaintainerPolicy(repositoryRoot);
      const protectedBranch = config.protectedBranches[0];
      if (protectedBranch === undefined) {
        throw workflowError(
          'PROTECTED_BASE_CONFIGURATION_REQUIRED',
          'Repository policy must configure one primary protected branch.',
          ExitCode.guard,
        );
      }
      return createGitProtectedBaseInitializationPort({
        repositoryRoot,
        repositoryId: policy.repository.id,
        canonicalOrigin: policy.repository.origin,
        remoteName: 'origin',
        protectedBranch,
      }).observe();
    },
  });
}

export function createGitProtectedBaseInitializationPort(input: {
  repositoryRoot: string;
  repositoryId: string;
  canonicalOrigin: string;
  remoteName: string;
  protectedBranch: string;
}): ProtectedBaseInitializationPort {
  const repositoryRoot = discoverRepository(
    input.repositoryRoot,
  ).repositoryRoot;
  const repositoryId = assertBoundedText(input.repositoryId, 'repository ID');
  const canonicalOrigin = assertBoundedText(
    input.canonicalOrigin,
    'canonical origin',
  );
  const remoteName = assertSimpleName(input.remoteName, 'remote name');
  const protectedBranch = assertBranchName(input.protectedBranch);

  return Object.freeze({
    observe(): ProtectedBaseInitializationObservationV1 {
      const repository = discoverRepository(repositoryRoot);
      const fetchUrl = readRemoteUrl(repositoryRoot, remoteName, false);
      const pushUrl = readRemoteUrl(repositoryRoot, remoteName, true);
      if (
        canonicalRemoteIdentity(fetchUrl) !== canonicalOrigin ||
        canonicalRemoteIdentity(pushUrl) !== canonicalOrigin
      ) {
        throw workflowError(
          'PROTECTED_BASE_REMOTE_IDENTITY_MISMATCH',
          'The configured fetch and push remotes do not match the canonical repository origin.',
          ExitCode.guard,
        );
      }
      const remoteRefs = readRemoteRefs(repositoryRoot, remoteName);
      const targetRef = `refs/heads/${protectedBranch}`;
      return Object.freeze({
        schemaVersion: 1,
        kind: 'protected-base-initialization-observation.v1',
        repositoryId,
        canonicalOrigin,
        remoteName,
        fetchUrl,
        pushUrl,
        protectedBranch,
        sourceCommit: repository.head,
        sourceTree: repository.tree,
        remoteRefCount: remoteRefs.length,
        remoteRefsDigest: digest(canonicalJson(remoteRefs)),
        remoteCommit:
          remoteRefs.find(({ ref }) => ref === targetRef)?.oid ?? null,
        trackingCommit: readOptionalCommit(
          repositoryRoot,
          protectedBranchRef(protectedBranch),
        ),
      });
    },
  });
}

/**
 * Execute only the exact create-only publication authorized by one completed
 * Central Grant. The remote target ref is fenced with an absent-value lease;
 * retries confirm the same remote state and never overwrite another commit.
 */
export function publishCompletedProtectedBaseInitialization(
  input: PublishCompletedProtectedBaseInitializationInput,
): ProtectedBaseInitializationPublicationReceiptV1 {
  const repository = discoverRepository(input.repositoryRoot);
  const runtimeRoot = fs.realpathSync(input.runtimeRoot);
  const now = exactDate(input.now ?? new Date());
  const authorized = authenticateCompletedProtectedBaseInitializationGrant(
    runtimeRoot,
    input.challengeId,
  );
  const parameters = authorized.parameters;
  const remoteRef = `refs/heads/${parameters.protectedBranch}`;
  const trackingRef = protectedBranchRef(parameters.protectedBranch);
  let observation = input.port.observe();
  assertCurrentIdentity(observation, parameters);

  const existingReceipt = readOptionalPublicationReceipt(
    runtimeRoot,
    input.challengeId,
    authorized.authority,
    parameters,
  );
  if (existingReceipt !== null) {
    assertPublishedState(observation, parameters);
    return existingReceipt;
  }

  let disposition: 'created' | 'recovered';
  if (isUnpublishedState(observation)) {
    assertFreshCompletedGrant(authorized.completedAt, now);
    try {
      runGit(repository.repositoryRoot, [
        'push',
        '--porcelain',
        `--force-with-lease=${remoteRef}:`,
        parameters.pushUrl,
        `${parameters.sourceCommit}:${remoteRef}`,
      ]);
    } catch (cause) {
      throw workflowError(
        'PROTECTED_BASE_PUBLICATION_CONFLICT',
        'The create-only protected-base publication lost its absent-ref lease or could not reach the canonical remote.',
        ExitCode.staleState,
        { details: { cause: safeErrorCode(cause) } },
      );
    }
    disposition = 'created';
    observation = input.port.observe();
  } else if (isExactPublishedState(observation, parameters)) {
    disposition = 'recovered';
  } else {
    throw publicationStateChanged();
  }

  if (observation.trackingCommit === null) {
    runGit(repository.repositoryRoot, [
      'fetch',
      '--no-tags',
      '--no-write-fetch-head',
      parameters.fetchUrl,
      `${remoteRef}:${trackingRef}`,
    ]);
    observation = input.port.observe();
  }
  assertPublishedState(observation, parameters);

  const body = Object.freeze({
    schemaVersion: 1 as const,
    kind: 'protected-base-initialization-publication-receipt.v1' as const,
    authority: authorized.authority,
    repositoryId: parameters.repositoryId,
    canonicalOrigin: parameters.canonicalOrigin,
    remoteName: parameters.remoteName,
    protectedBranch: parameters.protectedBranch,
    sourceCommit: parameters.sourceCommit,
    sourceTree: parameters.sourceTree,
    remoteRef,
    remoteCommit: parameters.sourceCommit,
    trackingRef,
    trackingCommit: parameters.sourceCommit,
    leaseExpectation: 'remote-ref-absent' as const,
    overwrite: false as const,
    disposition,
    publishedAt: now.toISOString(),
  });
  const receipt = Object.freeze({
    ...body,
    receiptDigest: digest(canonicalJson(body)),
  });
  persistPublicationReceipt(runtimeRoot, receipt);
  return receipt;
}

export function publishCompletedProtectedBaseInitializationProduction(
  cwd: string,
  challengeId: string,
): ProtectedBaseInitializationPublicationReceiptV1 {
  const repository = discoverRepository(cwd);
  const runtimeRoot = loadInvestigationRuntimeContext(repository.repositoryRoot)
    .lifecycleRuntime.root;
  return publishCompletedProtectedBaseInitialization({
    repositoryRoot: repository.repositoryRoot,
    runtimeRoot,
    challengeId,
    port: createProductionProtectedBaseInitializationPort(
      repository.repositoryRoot,
    ),
  });
}

export function publishProtectedBaseInitializationAfterGrant(
  cwd: string,
  grant: GrantExecutionResult,
): ProtectedBaseInitializationPublicationReceiptV1 | null {
  if (
    grant.transitionId !== PROTECTED_BASE_INITIALIZATION_TRANSITION_ID ||
    grant.outcome !== 'completed'
  ) {
    return null;
  }
  return publishCompletedProtectedBaseInitializationProduction(
    cwd,
    grant.challengeId,
  );
}

function authenticateCompletedProtectedBaseInitializationGrant(
  runtimeRoot: string,
  challengeId: string,
): Readonly<{
  authority: CompletedProtectedBaseInitializationGrantReferenceV1;
  parameters: ProtectedBaseInitializationParametersV1;
  completedAt: Date;
}> {
  try {
    const record = readGrantRecord(grantStorePaths(runtimeRoot), challengeId);
    if (record.state !== 'completed') throw completedGrantInvalid();
    const choice = record.challenge.choices.find(
      ({ choiceId }) => choiceId === record.approvalSubject.choiceId,
    );
    if (choice === undefined) throw completedGrantInvalid();
    const parameters = assertProtectedBaseInitializationParameters(
      choice.parameters,
    );
    const expectedObservation = emptyObservation(parameters);
    const expectedState =
      protectedBaseInitializationStateBinding(expectedObservation);
    const expectedOutcome = {
      outcome: 'completed' as const,
      details: {
        schemaVersion: 1 as const,
        kind: 'protected-base-initialization-authorized.v1' as const,
        protectedBranch: parameters.protectedBranch,
        sourceCommit: parameters.sourceCommit,
        remoteEffectApplied: false as const,
      },
    };
    const completedAt = exactTimestamp(record.completedAt);
    if (
      record.challenge.challengeId !== challengeId ||
      record.challenge.sourceModuleId !== 'git-protected-base' ||
      record.challenge.failureCode !== 'protected-base-unavailable' ||
      canonicalJson(record.challenge.facts) !==
        canonicalJson(expectedObservation) ||
      choice.transitionId !== PROTECTED_BASE_INITIALIZATION_TRANSITION_ID ||
      record.challenge.stateBinding.kind !== expectedState.kind ||
      record.challenge.stateBinding.digest !== expectedState.digest ||
      record.approvalSubject.stateDigest !== expectedState.digest ||
      record.poststateDigest !== expectedState.digest ||
      canonicalJson(record.outcome) !== canonicalJson(expectedOutcome) ||
      completedAt === null
    ) {
      throw completedGrantInvalid();
    }
    return Object.freeze({
      authority: Object.freeze({
        contractVersion: 'central-grant-completed-authority-ref.v1' as const,
        challengeId,
        challengeDigest: record.challenge.challengeDigest,
        transitionId: PROTECTED_BASE_INITIALIZATION_TRANSITION_ID,
        operationId: record.operationId,
        terminalOutcomeDigest: digest(canonicalJson(record.outcome)),
      }),
      parameters,
      completedAt,
    });
  } catch (error) {
    if (
      isRecord(error) &&
      error.code === 'PROTECTED_BASE_COMPLETED_GRANT_INVALID'
    ) {
      throw error;
    }
    throw completedGrantInvalid();
  }
}

function emptyObservation(
  parameters: ProtectedBaseInitializationParametersV1,
): ProtectedBaseInitializationObservationV1 {
  return Object.freeze({
    schemaVersion: 1,
    kind: 'protected-base-initialization-observation.v1',
    repositoryId: parameters.repositoryId,
    canonicalOrigin: parameters.canonicalOrigin,
    remoteName: parameters.remoteName,
    fetchUrl: parameters.fetchUrl,
    pushUrl: parameters.pushUrl,
    protectedBranch: parameters.protectedBranch,
    sourceCommit: parameters.sourceCommit,
    sourceTree: parameters.sourceTree,
    remoteRefCount: 0,
    remoteRefsDigest: digest(canonicalJson([])),
    remoteCommit: null,
    trackingCommit: null,
  });
}

function assertCurrentIdentity(
  observation: ProtectedBaseInitializationObservationV1,
  parameters: ProtectedBaseInitializationParametersV1,
): void {
  if (
    observation.repositoryId !== parameters.repositoryId ||
    observation.canonicalOrigin !== parameters.canonicalOrigin ||
    observation.remoteName !== parameters.remoteName ||
    observation.fetchUrl !== parameters.fetchUrl ||
    observation.pushUrl !== parameters.pushUrl ||
    observation.protectedBranch !== parameters.protectedBranch ||
    observation.sourceCommit !== parameters.sourceCommit ||
    observation.sourceTree !== parameters.sourceTree
  ) {
    throw publicationStateChanged();
  }
}

function isUnpublishedState(
  observation: ProtectedBaseInitializationObservationV1,
): boolean {
  return (
    observation.remoteRefCount === 0 &&
    observation.remoteRefsDigest === digest(canonicalJson([])) &&
    observation.remoteCommit === null &&
    observation.trackingCommit === null
  );
}

function isExactPublishedState(
  observation: ProtectedBaseInitializationObservationV1,
  parameters: ProtectedBaseInitializationParametersV1,
): boolean {
  return (
    observation.remoteRefCount === 1 &&
    observation.remoteRefsDigest ===
      digest(
        canonicalJson([
          {
            oid: parameters.sourceCommit,
            ref: `refs/heads/${parameters.protectedBranch}`,
          },
        ]),
      ) &&
    observation.remoteCommit === parameters.sourceCommit &&
    (observation.trackingCommit === null ||
      observation.trackingCommit === parameters.sourceCommit)
  );
}

function assertPublishedState(
  observation: ProtectedBaseInitializationObservationV1,
  parameters: ProtectedBaseInitializationParametersV1,
): void {
  assertCurrentIdentity(observation, parameters);
  if (
    !isExactPublishedState(observation, parameters) ||
    observation.trackingCommit !== parameters.sourceCommit
  ) {
    throw publicationStateChanged();
  }
}

function publicationReceiptPath(
  runtimeRoot: string,
  challengeId: string,
): string {
  const directory = path.join(runtimeRoot, 'protected-base-publications');
  ensurePlainDirectory(directory);
  return path.join(directory, `${challengeId}.json`);
}

function persistPublicationReceipt(
  runtimeRoot: string,
  receipt: ProtectedBaseInitializationPublicationReceiptV1,
): void {
  const filePath = publicationReceiptPath(
    runtimeRoot,
    receipt.authority.challengeId,
  );
  const content = `${canonicalJson(receipt)}\n`;
  try {
    fs.writeFileSync(filePath, content, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
  } catch (error) {
    if (
      !isNodeError(error) ||
      error.code !== 'EEXIST' ||
      readSafeReceiptFile(filePath) !== content
    ) {
      throw workflowError(
        'PROTECTED_BASE_PUBLICATION_RECEIPT_CONFLICT',
        'The protected-base publication receipt conflicts with its exact idempotency identity.',
        ExitCode.staleState,
      );
    }
  }
}

function readOptionalPublicationReceipt(
  runtimeRoot: string,
  challengeId: string,
  authority: CompletedProtectedBaseInitializationGrantReferenceV1,
  parameters: ProtectedBaseInitializationParametersV1,
): ProtectedBaseInitializationPublicationReceiptV1 | null {
  const filePath = publicationReceiptPath(runtimeRoot, challengeId);
  const stats = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (stats === undefined) return null;
  const source = readSafeReceiptFile(filePath);
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw publicationReceiptInvalid();
  }
  const receipt = assertPublicationReceipt(value);
  if (
    source !== `${canonicalJson(receipt)}\n` ||
    canonicalJson(receipt.authority) !== canonicalJson(authority) ||
    receipt.repositoryId !== parameters.repositoryId ||
    receipt.canonicalOrigin !== parameters.canonicalOrigin ||
    receipt.remoteName !== parameters.remoteName ||
    receipt.protectedBranch !== parameters.protectedBranch ||
    receipt.sourceCommit !== parameters.sourceCommit ||
    receipt.sourceTree !== parameters.sourceTree
  ) {
    throw publicationReceiptInvalid();
  }
  return receipt;
}

function assertPublicationReceipt(
  value: unknown,
): ProtectedBaseInitializationPublicationReceiptV1 {
  if (
    !isRecord(value) ||
    canonicalJson(Object.keys(value).sort()) !==
      canonicalJson(
        [
          'schemaVersion',
          'kind',
          'authority',
          'repositoryId',
          'canonicalOrigin',
          'remoteName',
          'protectedBranch',
          'sourceCommit',
          'sourceTree',
          'remoteRef',
          'remoteCommit',
          'trackingRef',
          'trackingCommit',
          'leaseExpectation',
          'overwrite',
          'disposition',
          'publishedAt',
          'receiptDigest',
        ].sort(),
      ) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'protected-base-initialization-publication-receipt.v1' ||
    !isRecord(value.authority) ||
    typeof value.repositoryId !== 'string' ||
    typeof value.canonicalOrigin !== 'string' ||
    typeof value.remoteName !== 'string' ||
    typeof value.protectedBranch !== 'string' ||
    typeof value.sourceCommit !== 'string' ||
    !COMMIT_OID.test(value.sourceCommit) ||
    typeof value.sourceTree !== 'string' ||
    !COMMIT_OID.test(value.sourceTree) ||
    value.remoteRef !== `refs/heads/${value.protectedBranch}` ||
    value.remoteCommit !== value.sourceCommit ||
    value.trackingRef !== protectedBranchRef(value.protectedBranch) ||
    value.trackingCommit !== value.sourceCommit ||
    value.leaseExpectation !== 'remote-ref-absent' ||
    value.overwrite !== false ||
    !['created', 'recovered'].includes(String(value.disposition)) ||
    exactTimestamp(value.publishedAt) === null ||
    typeof value.receiptDigest !== 'string' ||
    !SHA256_DIGEST.test(value.receiptDigest)
  ) {
    throw publicationReceiptInvalid();
  }
  const { receiptDigest, ...body } = value;
  if (receiptDigest !== digest(canonicalJson(body))) {
    throw publicationReceiptInvalid();
  }
  return Object.freeze(
    value,
  ) as ProtectedBaseInitializationPublicationReceiptV1;
}

function readSafeReceiptFile(filePath: string): string {
  const stats = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (
    !stats?.isFile() ||
    stats.isSymbolicLink() ||
    stats.nlink !== 1 ||
    (stats.mode & 0o777) !== 0o600 ||
    fs.realpathSync(filePath) !== filePath ||
    stats.size > 1_048_576
  ) {
    throw publicationReceiptInvalid();
  }
  return fs.readFileSync(filePath, 'utf8');
}

function assertFreshCompletedGrant(completedAt: Date, now: Date): void {
  if (
    completedAt.getTime() > now.getTime() + 30_000 ||
    completedAt.getTime() < now.getTime() - COMPLETED_GRANT_MAX_AGE_MS
  ) {
    throw workflowError(
      'PROTECTED_BASE_COMPLETED_GRANT_EXPIRED',
      'The completed protected-base Grant is too old to create a remote ref; request fresh Human Gate approval.',
      ExitCode.staleState,
    );
  }
}

function exactDate(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw completedGrantInvalid();
  }
  return new Date(value.getTime());
}

function exactTimestamp(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) &&
    new Date(timestamp).toISOString() === value
    ? new Date(timestamp)
    : null;
}

function safeErrorCode(error: unknown): string {
  return isRecord(error) && typeof error.code === 'string'
    ? error.code
    : 'UNKNOWN';
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function completedGrantInvalid() {
  return workflowError(
    'PROTECTED_BASE_COMPLETED_GRANT_INVALID',
    'Protected-base publication requires the exact completed Central Grant record.',
    ExitCode.staleState,
  );
}

function publicationStateChanged() {
  return workflowError(
    'PROTECTED_BASE_PUBLICATION_STATE_CHANGED',
    'Protected-base publication state changed; the executor will not overwrite or publish a different ref.',
    ExitCode.staleState,
  );
}

function publicationReceiptInvalid() {
  return workflowError(
    'PROTECTED_BASE_PUBLICATION_RECEIPT_INVALID',
    'Protected-base publication receipt is missing, unsafe, or malformed.',
    ExitCode.verification,
  );
}

function readRemoteUrl(
  repositoryRoot: string,
  remoteName: string,
  push: boolean,
): string {
  const value = runGit(repositoryRoot, [
    'remote',
    'get-url',
    ...(push ? ['--push'] : []),
    remoteName,
  ]).trim();
  return assertBoundedText(value, push ? 'push URL' : 'fetch URL');
}

function readRemoteRefs(
  repositoryRoot: string,
  remoteName: string,
): readonly Readonly<{ oid: string; ref: string }>[] {
  const output = runGit(repositoryRoot, ['ls-remote', '--refs', remoteName]);
  const refs = output
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const fields = line.split('\t');
      if (
        fields.length !== 2 ||
        !COMMIT_OID.test(fields[0]!) ||
        !/^refs\/[A-Za-z0-9][A-Za-z0-9._/-]{0,500}$/.test(fields[1]!) ||
        fields[1]!.includes('..')
      ) {
        throw workflowError(
          'PROTECTED_BASE_REMOTE_OBSERVATION_INVALID',
          'The remote ref observation is malformed or ambiguous.',
          ExitCode.verification,
        );
      }
      return Object.freeze({ oid: fields[0]!, ref: fields[1]! });
    })
    .sort((left, right) => left.ref.localeCompare(right.ref));
  if (new Set(refs.map(({ ref }) => ref)).size !== refs.length) {
    throw workflowError(
      'PROTECTED_BASE_REMOTE_OBSERVATION_INVALID',
      'The remote ref observation contains duplicate identities.',
      ExitCode.verification,
    );
  }
  return Object.freeze(refs);
}

function readOptionalCommit(
  repositoryRoot: string,
  ref: string,
): string | null {
  const value = runGit(
    repositoryRoot,
    ['rev-parse', '--verify', `${ref}^{commit}`],
    true,
  ).trim();
  if (value.length === 0) return null;
  if (!COMMIT_OID.test(value)) {
    throw workflowError(
      'PROTECTED_BASE_TRACKING_REF_INVALID',
      'The protected remote-tracking ref is not an exact commit.',
      ExitCode.verification,
    );
  }
  return value;
}

function canonicalRemoteIdentity(value: string): string {
  const ssh =
    /^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+\.git)$/.exec(value);
  return ssh === null ? value : `https://github.com/${ssh[1]}/${ssh[2]}`;
}

function assertSimpleName(value: string, label: string): string {
  if (!SIMPLE_NAME.test(value)) {
    throw workflowError(
      'PROTECTED_BASE_CONFIGURATION_INVALID',
      `Protected-base ${label} is invalid.`,
      ExitCode.guard,
    );
  }
  return value;
}

function assertBranchName(value: string): string {
  if (!BRANCH_NAME.test(value) || value.includes('..')) {
    throw workflowError(
      'PROTECTED_BASE_CONFIGURATION_INVALID',
      'Protected-base branch name is invalid.',
      ExitCode.guard,
    );
  }
  return value;
}

function assertBoundedText(value: string, label: string): string {
  const normalized = value.trim();
  if (
    normalized !== value ||
    normalized.length < 1 ||
    normalized.length > 1024 ||
    /[\0\r\n]/.test(normalized)
  ) {
    throw workflowError(
      'PROTECTED_BASE_CONFIGURATION_INVALID',
      `Protected-base ${label} is invalid.`,
      ExitCode.guard,
    );
  }
  return normalized;
}

function digest(value: string): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

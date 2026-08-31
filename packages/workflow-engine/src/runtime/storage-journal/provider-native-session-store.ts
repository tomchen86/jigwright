import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';

import type { ProviderWrapperSessionProtocolBinding } from '@jigwright/agent-runtime';

import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import {
  assertProviderNativeSessionContinuationAuthorityEnvelopeV1,
  assertProviderNativeSessionContinuationAuthorityV1,
  assertProviderNativeSessionClaimRefV1 as assertDurableClaimRef,
  assertProviderNativeSessionCompletionRefV1 as assertDurableCompletionRef,
  createProviderNativeSessionContinuationAuthorityV1,
  createProviderNativeSessionClaimRefV1 as createDurableClaimRef,
  createProviderNativeSessionCompletionRefV1 as createDurableCompletionRef,
  type ProviderNativeSessionContinuationAuthorityV1,
  type ProviderNativeSessionClaimRefV1,
  type ProviderNativeSessionCompletionRefV1,
} from '../../modules/provider-orchestration/agent-runtime-durable-authority.ts';
import type { AgentRolePlanV2SnapshotVerifierPort } from '../../modules/provider-orchestration/agent-role-plan.ts';
import type {
  ChangeRoleAssignmentDataAuthorizationVerifierPort,
  ChangeRoleAssignmentProtectedContextVerifierPort,
} from '../../modules/provider-orchestration/change-role-assignment.ts';
import type {
  ChangeRoleAssignmentHostConfigurationVerifierPort,
  ChangeRoleAssignmentProviderRegistryVerifierPort,
  ChangeRoleAssignmentRecordV1,
  ChangeRoleAssignmentSessionCapabilityVerifierPort,
} from '../../modules/provider-orchestration/change-role-assignment-record.ts';
import type { CentralRoleProviderDefaultSnapshotVerifierPort } from '../../modules/provider-orchestration/central-role-provider-default.ts';
import {
  type ProviderNativeSessionClaimV1,
  type ProviderNativeSessionCompletionTerminalV1,
  type ProviderNativeSessionCompletionV1,
  type ProviderNativeSessionHandleV1,
  type ProviderNativeSessionScopeV1,
  type ProviderNativeSessionAssignmentAuthorityVerifierPort,
  assertProviderNativeSessionClaimV1,
  assertProviderNativeSessionCompletionV1,
  assertProviderNativeSessionHandleV1,
  createProviderNativeSessionClaimV1,
  createProviderNativeSessionCompletionV1,
  deriveProviderNativeSessionScopeV1,
} from '../../modules/provider-orchestration/provider-native-session.ts';
import { readChangeRoleAssignmentRecordV1 } from './change-role-assignment-store.ts';
import {
  assertPrivateInvestigationDirectory,
  ensurePrivateInvestigationDirectory,
  readAcceptedProviderInvocationRuntimeReceiptAuthority,
  readPrivateCanonicalJson,
  withPrivateRuntimeLock,
} from './investigation-session-store.ts';
import {
  MAX_PROVIDER_EXECUTION_ADMISSION_AUTHORITY_BYTES,
  assertProviderExecutionAdmissionAuthority,
  providerExecutionAdmissionAuthorityPath,
} from './provider-execution-admission-authority.ts';
import type { InvestigationRuntimePaths } from '../session-workspace/paths.ts';
import {
  providerNativeSessionChainDirectoryV1 as chainDirectory,
  providerNativeSessionClaimObjectPathV1 as claimObjectPath,
  providerNativeSessionClaimRefPathV1 as claimRefPath,
  providerNativeSessionCompletionObjectPathV1 as completionObjectPath,
  providerNativeSessionCompletionRefPathV1 as completionRefPath,
  providerNativeSessionContinuationAuthorityObjectPathV1 as continuationAuthorityObjectPath,
  providerNativeSessionHandleObjectPathV1 as handleObjectPath,
  providerNativeSessionStorePathsV1 as storePaths,
} from '../session-workspace/provider-runtime-authority-paths.ts';

const CHANGE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const SESSION_SLOT_ID = /^role-assignment-session-[0-9a-f]{64}$/u;
const BINDING_IDENTIFIER = /^[a-z0-9][a-z0-9._:-]{0,255}$/u;
const TURN_REF = /^(\d{5})\.(claim|completion)-ref\.json$/u;
const PUBLICATION_TEMP =
  /^v1\.([A-Za-z0-9_-]+)\.([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.publish\.tmp$/u;
const MAX_TURN = 10_000;
const MAX_OBJECT_BYTES = 512 * 1024;
const MAX_HANDLE_BYTES = 8 * 1024;
const MAX_CONTINUATION_AUTHORITY_BYTES = 8 * 1024;
const MAX_REF_BYTES = 2 * 1024;
const UTF8 = new TextDecoder('utf-8', { fatal: true });
const NO_FOLLOW_CREATE =
  fs.constants.O_RDWR |
  fs.constants.O_CREAT |
  fs.constants.O_EXCL |
  fs.constants.O_NOFOLLOW;

export type ClaimProviderNativeSessionTurnInputV1 = Readonly<{
  changeId: string;
  planningGeneration: string;
  assignmentRecordDigest: string;
  sessionSlotId: string;
  predecessorCompletionDigest: string | null;
  invocationId: string;
  requestDigest: string;
  attemptId: string;
}>;

export type ClaimProviderNativeSessionTurnResultV1 = Readonly<{
  outcome: 'claimed' | 'already-claimed';
  claim: ProviderNativeSessionClaimV1;
  binding: ProviderWrapperSessionProtocolBinding | null;
}>;

export type CompleteProviderNativeSessionTurnInputV1 = Readonly<{
  changeId: string;
  planningGeneration: string;
  assignmentRecordDigest: string;
  sessionSlotId: string;
  claimDigest: string;
  terminal: ProviderNativeSessionCompletionTerminalV1;
}>;

export type RecoverProviderNativeSessionTurnInputV1 = Readonly<{
  scopeKey: string;
  sessionSlotId: string;
  claimDigest: string;
  invocationId: string;
  requestDigest: string;
  attemptId: string;
  expectedProtocolReceiptDigest: string | null;
}>;

export type RecoverProviderNativeSessionTurnResultV1 = Readonly<{
  outcome: 'unchanged' | 'abandoned';
  completion: ProviderNativeSessionCompletionV1;
}>;

export type PublishProviderNativeSessionContinuationAuthorityInputV1 =
  Readonly<{
    changeId: string;
    planningGeneration: string;
    assignmentRecordDigest: string;
    sessionSlotId: string;
    completionDigest: string;
  }>;

export type ProviderNativeSessionChainV1 = Readonly<{
  schemaVersion: 1;
  kind: 'provider-native-session-chain.v1';
  scope: ProviderNativeSessionScopeV1;
  state:
    | 'empty'
    | 'claimed'
    | 'continuation-pending'
    | 'resumable'
    | 'terminal-unusable';
  turns: readonly Readonly<{
    claim: ProviderNativeSessionClaimV1;
    completion: ProviderNativeSessionCompletionV1 | null;
    continuationAuthority: ProviderNativeSessionContinuationAuthorityV1 | null;
  }>[];
}>;

type PublicationRecoveryTarget = Readonly<{
  filePath: string;
  relativePath: string;
  maxBytes: number;
  kind:
    | 'claim'
    | 'completion'
    | 'handle'
    | 'continuation-authority'
    | 'claim-ref'
    | 'completion-ref';
  digest: string | null;
  turn: number | null;
}>;

/**
 * Claim one exact start/resume turn. A published claim is launch evidence: an
 * exact retry observes it but never receives a second launch binding.
 */
export function claimProviderNativeSessionTurnV1(
  paths: InvestigationRuntimePaths,
  candidate: ClaimProviderNativeSessionTurnInputV1,
  verifyCentralSnapshot: CentralRoleProviderDefaultSnapshotVerifierPort,
  verifyChangeOverrideSnapshot: AgentRolePlanV2SnapshotVerifierPort,
  verifyHostConfiguration: ChangeRoleAssignmentHostConfigurationVerifierPort,
  verifyProviderRegistry: ChangeRoleAssignmentProviderRegistryVerifierPort,
  verifyDataAuthorization: ChangeRoleAssignmentDataAuthorizationVerifierPort,
  verifySessionCapability: ChangeRoleAssignmentSessionCapabilityVerifierPort,
  verifyProtectedContext: ChangeRoleAssignmentProtectedContextVerifierPort,
  verifyAssignmentAuthority?: ProviderNativeSessionAssignmentAuthorityVerifierPort,
): ClaimProviderNativeSessionTurnResultV1 {
  const input = assertClaimInput(candidate);
  const scope = loadScope(
    paths,
    input,
    verifyCentralSnapshot,
    verifyChangeOverrideSnapshot,
    verifyHostConfiguration,
    verifyProviderRegistry,
    verifyDataAuthorization,
    verifySessionCapability,
    verifyProtectedContext,
    verifyAssignmentAuthority,
  );
  return withScopeLock(paths, scope, () => {
    const currentScope = assertCurrentScope(
      paths,
      input,
      scope,
      verifyCentralSnapshot,
      verifyChangeOverrideSnapshot,
      verifyHostConfiguration,
      verifyProviderRegistry,
      verifyDataAuthorization,
      verifySessionCapability,
      verifyProtectedContext,
      verifyAssignmentAuthority,
    );
    const chain = readChainForScope(paths, currentScope);
    if (chain.state === 'terminal-unusable') throw terminalUnusable();
    if (chain.state === 'continuation-pending') {
      throw continuationNotAuthorized();
    }
    if (chain.state === 'claimed') {
      const current = chain.turns.at(-1)!.claim;
      if (!claimMatchesInput(current, input)) throw storeConflict();
      return deepFreeze({
        outcome: 'already-claimed' as const,
        claim: current,
        binding: null,
      });
    }

    const predecessor = chain.turns.at(-1)?.completion ?? null;
    if (
      (predecessor === null && input.predecessorCompletionDigest !== null) ||
      (predecessor !== null &&
        input.predecessorCompletionDigest !== predecessor.completionDigest)
    ) {
      throw storeConflict();
    }
    const turn = chain.turns.length + 1;
    const binding =
      predecessor === null
        ? createStartBinding(input)
        : createResumeBinding(
            input,
            readHandleForCompletion(paths, predecessor),
          );
    const claim = createProviderNativeSessionClaimV1({
      scope: currentScope,
      turn,
      predecessorCompletion: predecessor,
      binding,
    });
    const locations = storePaths(paths);
    publishCanonicalCreateOnly(
      paths,
      currentScope.scopeKey,
      claimObjectPath(locations, claim.claimDigest),
      claim,
      MAX_OBJECT_BYTES,
    );
    publishCanonicalCreateOnly(
      paths,
      currentScope.scopeKey,
      claimRefPath(locations, currentScope.scopeKey, turn),
      createClaimRef(claim),
      MAX_REF_BYTES,
    );
    const published = readChainForScope(paths, currentScope);
    const publishedTurn = published.turns.at(-1);
    if (
      published.state !== 'claimed' ||
      publishedTurn?.completion !== null ||
      publishedTurn?.claim.claimDigest !== claim.claimDigest
    ) {
      throw storeInvalid();
    }
    return deepFreeze({ outcome: 'claimed' as const, claim, binding });
  });
}

/**
 * Complete a claimed turn. Raw native identity is written only to a private
 * handle object; immutable public completion records contain its digest.
 */
export function completeProviderNativeSessionTurnV1(
  paths: InvestigationRuntimePaths,
  candidate: CompleteProviderNativeSessionTurnInputV1,
  verifyCentralSnapshot: CentralRoleProviderDefaultSnapshotVerifierPort,
  verifyChangeOverrideSnapshot: AgentRolePlanV2SnapshotVerifierPort,
  verifyHostConfiguration: ChangeRoleAssignmentHostConfigurationVerifierPort,
  verifyProviderRegistry: ChangeRoleAssignmentProviderRegistryVerifierPort,
  verifyDataAuthorization: ChangeRoleAssignmentDataAuthorizationVerifierPort,
  verifySessionCapability: ChangeRoleAssignmentSessionCapabilityVerifierPort,
  verifyProtectedContext: ChangeRoleAssignmentProtectedContextVerifierPort,
  verifyAssignmentAuthority?: ProviderNativeSessionAssignmentAuthorityVerifierPort,
): ProviderNativeSessionCompletionV1 {
  const input = assertCompletionInput(candidate);
  const scope = loadScope(
    paths,
    input,
    verifyCentralSnapshot,
    verifyChangeOverrideSnapshot,
    verifyHostConfiguration,
    verifyProviderRegistry,
    verifyDataAuthorization,
    verifySessionCapability,
    verifyProtectedContext,
    verifyAssignmentAuthority,
  );
  return withScopeLock(paths, scope, () => {
    const currentScope = assertCurrentScope(
      paths,
      input,
      scope,
      verifyCentralSnapshot,
      verifyChangeOverrideSnapshot,
      verifyHostConfiguration,
      verifyProviderRegistry,
      verifyDataAuthorization,
      verifySessionCapability,
      verifyProtectedContext,
      verifyAssignmentAuthority,
    );
    const chain = readChainForScope(paths, currentScope);
    const turnIndex = chain.turns.findIndex(
      ({ claim }) => claim.claimDigest === input.claimDigest,
    );
    if (turnIndex < 0) throw storeConflict();
    const turn = chain.turns[turnIndex]!;
    const binding = bindingForClaim(paths, chain, turnIndex);
    const materialized = createProviderNativeSessionCompletionV1({
      claim: turn.claim,
      binding,
      terminal: input.terminal,
    });
    if (turn.completion !== null) {
      if (
        turn.completion.completionDigest !==
        materialized.completion.completionDigest
      ) {
        throw storeConflict();
      }
      return turn.completion;
    }
    if (turnIndex !== chain.turns.length - 1 || chain.state !== 'claimed') {
      throw storeConflict();
    }

    const locations = storePaths(paths);
    if (materialized.handle !== null) {
      publishCanonicalCreateOnly(
        paths,
        currentScope.scopeKey,
        handleObjectPath(locations, materialized.handle.handleDigest),
        materialized.handle,
        MAX_HANDLE_BYTES,
      );
    }
    publishCanonicalCreateOnly(
      paths,
      currentScope.scopeKey,
      completionObjectPath(locations, materialized.completion.completionDigest),
      materialized.completion,
      MAX_OBJECT_BYTES,
    );
    publishCanonicalCreateOnly(
      paths,
      currentScope.scopeKey,
      completionRefPath(locations, currentScope.scopeKey, turn.claim.turn),
      createCompletionRef(materialized.completion),
      MAX_REF_BYTES,
    );
    const published = readChainForScope(paths, currentScope);
    const publishedCompletion = published.turns[turnIndex]?.completion;
    if (
      publishedCompletion?.completionDigest !==
      materialized.completion.completionDigest
    ) {
      throw storeInvalid();
    }
    return publishedCompletion;
  });
}

/**
 * Persist a terminal fact for one already-published launch claim without
 * re-running mutable admission policy. Claim creation remains the authority
 * boundary; completion is exact, immutable execution evidence.
 */
export function completeClaimedProviderNativeSessionTurnV1(
  paths: InvestigationRuntimePaths,
  candidate: CompleteProviderNativeSessionTurnInputV1,
): ProviderNativeSessionCompletionV1 {
  const input = assertCompletionInput(candidate);
  const claim = assertProviderNativeSessionClaimV1(
    readBoundedCanonicalJson(
      paths,
      claimObjectPath(storePaths(paths), input.claimDigest),
      MAX_OBJECT_BYTES,
    ),
  );
  const scope = claim.scope;
  if (
    claim.claimDigest !== input.claimDigest ||
    scope.changeId !== input.changeId ||
    scope.planningGeneration !== input.planningGeneration ||
    scope.assignmentRecordDigest !== input.assignmentRecordDigest ||
    scope.sessionSlotId !== input.sessionSlotId
  ) {
    throw storeConflict();
  }
  return withScopeLock(paths, scope, () => {
    const chain = readChainForScope(paths, scope);
    const turnIndex = chain.turns.findIndex(
      ({ claim: current }) => current.claimDigest === input.claimDigest,
    );
    if (turnIndex < 0) throw storeConflict();
    const turn = chain.turns[turnIndex]!;
    const binding = bindingForClaim(paths, chain, turnIndex);
    const materialized = createProviderNativeSessionCompletionV1({
      claim: turn.claim,
      binding,
      terminal: input.terminal,
    });
    if (turn.completion !== null) {
      if (
        turn.completion.completionDigest !==
        materialized.completion.completionDigest
      ) {
        throw storeConflict();
      }
      return turn.completion;
    }
    if (turnIndex !== chain.turns.length - 1 || chain.state !== 'claimed') {
      throw storeConflict();
    }

    const locations = storePaths(paths);
    if (materialized.handle !== null) {
      publishCanonicalCreateOnly(
        paths,
        scope.scopeKey,
        handleObjectPath(locations, materialized.handle.handleDigest),
        materialized.handle,
        MAX_HANDLE_BYTES,
      );
    }
    publishCanonicalCreateOnly(
      paths,
      scope.scopeKey,
      completionObjectPath(locations, materialized.completion.completionDigest),
      materialized.completion,
      MAX_OBJECT_BYTES,
    );
    publishCanonicalCreateOnly(
      paths,
      scope.scopeKey,
      completionRefPath(locations, scope.scopeKey, turn.claim.turn),
      createCompletionRef(materialized.completion),
      MAX_REF_BYTES,
    );
    const published = readChainForScope(paths, scope);
    const publishedCompletion = published.turns[turnIndex]?.completion;
    if (
      publishedCompletion?.completionDigest !==
      materialized.completion.completionDigest
    ) {
      throw storeInvalid();
    }
    return publishedCompletion;
  });
}

/**
 * Authorize continuation only after the outer invocation has durably committed
 * one exact success receipt. Native completion alone never publishes this
 * marker and therefore cannot authorize resume.
 */
export function publishProviderNativeSessionContinuationAuthorityV1(
  paths: InvestigationRuntimePaths,
  candidate: PublishProviderNativeSessionContinuationAuthorityInputV1,
): ProviderNativeSessionContinuationAuthorityV1 {
  const input = assertContinuationAuthorityInput(candidate);
  const locations = storePaths(paths);
  const completion = assertProviderNativeSessionCompletionV1(
    readBoundedCanonicalJson(
      paths,
      completionObjectPath(locations, input.completionDigest),
      MAX_OBJECT_BYTES,
    ),
  );
  if (
    completion.scope.changeId !== input.changeId ||
    completion.scope.planningGeneration !== input.planningGeneration ||
    completion.scope.assignmentRecordDigest !== input.assignmentRecordDigest ||
    completion.scope.sessionSlotId !== input.sessionSlotId ||
    completion.completionDigest !== input.completionDigest
  ) {
    throw storeConflict();
  }
  const scope = completion.scope;
  const preflightRuntimeReceipt = readAcceptedOuterSuccessAuthority(
    paths,
    completion,
  );
  return withScopeLock(paths, scope, () => {
    const runtimeReceipt = readAcceptedOuterSuccessAuthority(paths, completion);
    if (
      canonicalJson(runtimeReceipt) !== canonicalJson(preflightRuntimeReceipt)
    ) {
      throw storeInvalid();
    }
    const chain = readChainForScope(paths, scope);
    const turn = chain.turns.find(
      ({ completion: candidateCompletion }) =>
        candidateCompletion?.completionDigest === completion.completionDigest,
    );
    if (
      turn?.completion === null ||
      turn?.completion === undefined ||
      canonicalJson(turn.completion) !== canonicalJson(completion)
    ) {
      throw storeConflict();
    }
    const authority = createProviderNativeSessionContinuationAuthorityV1(
      completion,
      runtimeReceipt,
      storeInvalid,
    );
    const authorityPath = continuationAuthorityObjectPath(
      locations,
      completion.completionDigest,
    );
    publishCanonicalCreateOnly(
      paths,
      scope.scopeKey,
      authorityPath,
      authority,
      MAX_CONTINUATION_AUTHORITY_BYTES,
    );
    const published = assertProviderNativeSessionContinuationAuthorityV1(
      readBoundedCanonicalJson(
        paths,
        authorityPath,
        MAX_CONTINUATION_AUTHORITY_BYTES,
      ),
      completion,
      runtimeReceipt,
      storeInvalid,
    );
    if (canonicalJson(published) !== canonicalJson(authority)) {
      throw storeInvalid();
    }
    return published;
  });
}

/**
 * Recover one exact public completion binding without accepting raw native
 * identity. A still-claimed launch is abandoned because recovery cannot safely
 * reconstruct the private handle required to make that session resumable.
 */
export function recoverProviderNativeSessionTurnV1(
  paths: InvestigationRuntimePaths,
  candidate: RecoverProviderNativeSessionTurnInputV1,
): RecoverProviderNativeSessionTurnResultV1 {
  const input = assertRecoveryInput(candidate);
  const locations = storePaths(paths);
  const claim = assertProviderNativeSessionClaimV1(
    readBoundedCanonicalJson(
      paths,
      claimObjectPath(locations, input.claimDigest),
      MAX_OBJECT_BYTES,
    ),
  );
  if (!claimMatchesRecoveryInput(claim, input)) throw storeConflict();

  const scope = claim.scope;
  return withScopeLock(paths, scope, () => {
    const chain = readChainForScope(paths, scope);
    const turnIndex = chain.turns.findIndex(
      ({ claim: current }) => current.claimDigest === input.claimDigest,
    );
    if (turnIndex < 0) throw storeConflict();
    const turn = chain.turns[turnIndex]!;
    if (!claimMatchesRecoveryInput(turn.claim, input)) throw storeConflict();

    if (turn.completion !== null) {
      const receiptDigest =
        turn.completion.protocolReceipt?.receiptDigest ?? null;
      if (
        turn.completion.disposition !== 'indeterminate' &&
        receiptDigest !== input.expectedProtocolReceiptDigest
      ) {
        throw storeConflict();
      }
      return deepFreeze({
        outcome: 'unchanged' as const,
        completion: turn.completion,
      });
    }
    if (turnIndex !== chain.turns.length - 1 || chain.state !== 'claimed') {
      throw storeConflict();
    }

    const materialized = createProviderNativeSessionCompletionV1({
      claim: turn.claim,
      binding: bindingForClaim(paths, chain, turnIndex),
      terminal: { kind: 'claim-crash' },
    });
    if (
      materialized.handle !== null ||
      materialized.completion.disposition !== 'indeterminate' ||
      materialized.completion.usable !== false ||
      materialized.completion.handleDigest !== null
    ) {
      throw storeInvalid();
    }
    publishCanonicalCreateOnly(
      paths,
      scope.scopeKey,
      completionObjectPath(locations, materialized.completion.completionDigest),
      materialized.completion,
      MAX_OBJECT_BYTES,
    );
    publishCanonicalCreateOnly(
      paths,
      scope.scopeKey,
      completionRefPath(locations, scope.scopeKey, turn.claim.turn),
      createCompletionRef(materialized.completion),
      MAX_REF_BYTES,
    );
    const published = readChainForScope(paths, scope);
    const publishedCompletion = published.turns[turnIndex]?.completion;
    if (
      publishedCompletion?.completionDigest !==
      materialized.completion.completionDigest
    ) {
      throw storeInvalid();
    }
    return deepFreeze({
      outcome: 'abandoned' as const,
      completion: publishedCompletion,
    });
  });
}

/** Read and revalidate the complete immutable chain without exposing handles. */
export function readProviderNativeSessionChainV1(
  paths: InvestigationRuntimePaths,
  requestedChangeId: string,
  requestedPlanningGeneration: string,
  requestedAssignmentRecordDigest: string,
  requestedSessionSlotId: string,
  verifyCentralSnapshot: CentralRoleProviderDefaultSnapshotVerifierPort,
  verifyChangeOverrideSnapshot: AgentRolePlanV2SnapshotVerifierPort,
  verifyHostConfiguration: ChangeRoleAssignmentHostConfigurationVerifierPort,
  verifyProviderRegistry: ChangeRoleAssignmentProviderRegistryVerifierPort,
  verifyDataAuthorization: ChangeRoleAssignmentDataAuthorizationVerifierPort,
  verifySessionCapability: ChangeRoleAssignmentSessionCapabilityVerifierPort,
  verifyProtectedContext: ChangeRoleAssignmentProtectedContextVerifierPort,
  verifyAssignmentAuthority?: ProviderNativeSessionAssignmentAuthorityVerifierPort,
): ProviderNativeSessionChainV1 {
  const identity = assertChainIdentity({
    changeId: requestedChangeId,
    planningGeneration: requestedPlanningGeneration,
    assignmentRecordDigest: requestedAssignmentRecordDigest,
    sessionSlotId: requestedSessionSlotId,
  });
  const scope = loadScope(
    paths,
    identity,
    verifyCentralSnapshot,
    verifyChangeOverrideSnapshot,
    verifyHostConfiguration,
    verifyProviderRegistry,
    verifyDataAuthorization,
    verifySessionCapability,
    verifyProtectedContext,
    verifyAssignmentAuthority,
  );
  return withScopeLock(paths, scope, () => {
    const currentScope = assertCurrentScope(
      paths,
      identity,
      scope,
      verifyCentralSnapshot,
      verifyChangeOverrideSnapshot,
      verifyHostConfiguration,
      verifyProviderRegistry,
      verifyDataAuthorization,
      verifySessionCapability,
      verifyProtectedContext,
      verifyAssignmentAuthority,
    );
    return readChainForScope(paths, currentScope);
  });
}

function normalizePublicationOperationError(error: unknown): Error {
  if (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code.startsWith('PROVIDER_NATIVE_SESSION_')
  ) {
    return error;
  }
  return storeInvalid();
}

function cleanupPublicationTemporary(
  descriptor: number | undefined,
  temporaryCreated: boolean,
  temporaryPath: string,
  recoveryDirectory: string,
): Error | null {
  let cleanupFailed = false;
  if (descriptor !== undefined) {
    try {
      fs.closeSync(descriptor);
    } catch {
      cleanupFailed = true;
    }
  }
  if (temporaryCreated) {
    try {
      fs.unlinkSync(temporaryPath);
      fsyncDirectory(recoveryDirectory);
    } catch {
      cleanupFailed = true;
    }
  }
  return cleanupFailed ? storeInvalid() : null;
}

function readChainForScope(
  paths: InvestigationRuntimePaths,
  scope: ProviderNativeSessionScopeV1,
): ProviderNativeSessionChainV1 {
  const locations = storePaths(paths);
  recoverScopePublication(paths, locations, scope.scopeKey);
  const beforeNames = readRefNames(paths, locations, scope.scopeKey);
  if (beforeNames.length === 0) return createChain(scope, []);

  const claims = new Set<number>();
  const completions = new Set<number>();
  for (const name of beforeNames) {
    const match = TURN_REF.exec(name);
    if (match === null) throw storeInvalid();
    const turn = Number(match[1]);
    if (turn < 1 || turn > MAX_TURN) throw storeInvalid();
    (match[2] === 'claim' ? claims : completions).add(turn);
  }
  const lastTurn = Math.max(...claims);
  if (
    claims.size !== lastTurn ||
    [...Array(lastTurn)].some((_, index) => !claims.has(index + 1)) ||
    [...completions].some((turn) => !claims.has(turn))
  ) {
    throw storeInvalid();
  }

  const turns: Array<{
    claim: ProviderNativeSessionClaimV1;
    completion: ProviderNativeSessionCompletionV1 | null;
    continuationAuthority: ProviderNativeSessionContinuationAuthorityV1 | null;
  }> = [];
  for (let turn = 1; turn <= lastTurn; turn += 1) {
    const claim = readClaim(paths, locations, scope, turn);
    const prior = turns.at(-1)?.completion ?? null;
    if (
      (turn === 1 &&
        (claim.action !== 'start' ||
          claim.predecessorCompletionDigest !== null)) ||
      (turn > 1 &&
        (prior?.usable !== true ||
          turns.at(-1)?.continuationAuthority === null ||
          claim.action !== 'resume' ||
          claim.predecessorCompletionDigest !== prior.completionDigest ||
          claim.expectedNativeSessionIdDigest !== prior.nativeSessionIdDigest))
    ) {
      throw storeInvalid();
    }
    const completion = completions.has(turn)
      ? readCompletion(paths, locations, scope, claim)
      : null;
    const continuationAuthority =
      completion === null
        ? null
        : readContinuationAuthority(paths, locations, completion);
    if (
      (completion === null && turn !== lastTurn) ||
      (completion?.usable === false && turn !== lastTurn) ||
      (completion?.usable === true &&
        continuationAuthority === null &&
        turn !== lastTurn)
    ) {
      throw storeInvalid();
    }
    if (completion?.usable === true && continuationAuthority !== null) {
      readHandleForCompletion(paths, completion);
    }
    turns.push({ claim, completion, continuationAuthority });
  }

  const afterNames = readRefNames(paths, locations, scope.scopeKey);
  if (canonicalJson(beforeNames) !== canonicalJson(afterNames)) {
    throw storeOperationConflict();
  }
  return createChain(scope, turns);
}

function readClaim(
  paths: InvestigationRuntimePaths,
  locations: ReturnType<typeof storePaths>,
  scope: ProviderNativeSessionScopeV1,
  turn: number,
): ProviderNativeSessionClaimV1 {
  const refPath = claimRefPath(locations, scope.scopeKey, turn);
  const before = readBoundedCanonicalSnapshot(paths, refPath, MAX_REF_BYTES);
  const ref = assertClaimRef(before.value, scope.scopeKey, turn);
  const claim = assertProviderNativeSessionClaimV1(
    readBoundedCanonicalJson(
      paths,
      claimObjectPath(locations, ref.claimDigest),
      MAX_OBJECT_BYTES,
    ),
  );
  if (
    claim.scope.scopeKey !== scope.scopeKey ||
    canonicalJson(claim.scope) !== canonicalJson(scope) ||
    claim.turn !== turn ||
    claim.claimDigest !== ref.claimDigest
  ) {
    throw storeInvalid();
  }
  assertRefUnchanged(paths, refPath, before);
  return claim;
}

function readCompletion(
  paths: InvestigationRuntimePaths,
  locations: ReturnType<typeof storePaths>,
  scope: ProviderNativeSessionScopeV1,
  claim: ProviderNativeSessionClaimV1,
): ProviderNativeSessionCompletionV1 {
  const refPath = completionRefPath(locations, scope.scopeKey, claim.turn);
  const before = readBoundedCanonicalSnapshot(paths, refPath, MAX_REF_BYTES);
  const ref = assertCompletionRef(
    before.value,
    scope.scopeKey,
    claim.turn,
    claim.claimDigest,
  );
  const completion = assertProviderNativeSessionCompletionV1(
    readBoundedCanonicalJson(
      paths,
      completionObjectPath(locations, ref.completionDigest),
      MAX_OBJECT_BYTES,
    ),
  );
  if (
    completion.scope.scopeKey !== scope.scopeKey ||
    canonicalJson(completion.scope) !== canonicalJson(scope) ||
    completion.turn !== claim.turn ||
    completion.claimDigest !== claim.claimDigest ||
    completion.action !== claim.action ||
    completion.predecessorCompletionDigest !==
      claim.predecessorCompletionDigest ||
    completion.expectedNativeSessionIdDigest !==
      claim.expectedNativeSessionIdDigest ||
    completion.invocationId !== claim.invocationId ||
    completion.requestDigest !== claim.requestDigest ||
    completion.attemptId !== claim.attemptId ||
    completion.completionDigest !== ref.completionDigest
  ) {
    throw storeInvalid();
  }
  assertRefUnchanged(paths, refPath, before);
  return completion;
}

function readContinuationAuthority(
  paths: InvestigationRuntimePaths,
  locations: ReturnType<typeof storePaths>,
  completion: ProviderNativeSessionCompletionV1,
): ProviderNativeSessionContinuationAuthorityV1 | null {
  const authorityPath = continuationAuthorityObjectPath(
    locations,
    completion.completionDigest,
  );
  if (fs.lstatSync(authorityPath, { throwIfNoEntry: false }) === undefined) {
    return null;
  }
  const runtimeReceipt = readAcceptedOuterSuccessAuthority(paths, completion);
  return assertProviderNativeSessionContinuationAuthorityV1(
    readBoundedCanonicalJson(
      paths,
      authorityPath,
      MAX_CONTINUATION_AUTHORITY_BYTES,
    ),
    completion,
    runtimeReceipt,
    storeInvalid,
  );
}

function readAcceptedOuterSuccessAuthority(
  paths: InvestigationRuntimePaths,
  completion: ProviderNativeSessionCompletionV1,
) {
  const runtimeReceipt = readAcceptedProviderInvocationRuntimeReceiptAuthority(
    paths,
    completion.invocationId,
    storeInvalid,
  );
  const admissionAuthority = assertProviderExecutionAdmissionAuthority(
    readPrivateCanonicalJson(
      paths,
      providerExecutionAdmissionAuthorityPath(
        paths,
        runtimeReceipt.acceptanceBinding,
      ),
      storeInvalid,
      MAX_PROVIDER_EXECUTION_ADMISSION_AUTHORITY_BYTES,
    ),
    storeInvalid,
  );
  if (
    admissionAuthority.receiptRequirement !== 'schema-v4' ||
    canonicalJson(admissionAuthority.acceptanceBinding) !==
      canonicalJson(runtimeReceipt.acceptanceBinding) ||
    admissionAuthority.acceptanceBindingDigest !==
      runtimeReceipt.acceptanceBindingDigest ||
    admissionAuthority.executionStateDigest !==
      runtimeReceipt.executionStateDigest
  ) {
    throw storeInvalid();
  }
  return runtimeReceipt;
}

function readHandleForCompletion(
  paths: InvestigationRuntimePaths,
  completion: ProviderNativeSessionCompletionV1,
): ProviderNativeSessionHandleV1 {
  if (
    completion.usable !== true ||
    completion.handleDigest === null ||
    completion.nativeSessionIdDigest === null
  ) {
    throw storeInvalid();
  }
  return assertProviderNativeSessionHandleV1(
    readBoundedCanonicalJson(
      paths,
      handleObjectPath(storePaths(paths), completion.handleDigest),
      MAX_HANDLE_BYTES,
    ),
    { completion, handleDigest: completion.handleDigest },
  );
}

function bindingForClaim(
  paths: InvestigationRuntimePaths,
  chain: ProviderNativeSessionChainV1,
  turnIndex: number,
): ProviderWrapperSessionProtocolBinding {
  const claim = chain.turns[turnIndex]!.claim;
  if (claim.action === 'start') {
    return createStartBinding(claim);
  }
  const predecessor = chain.turns[turnIndex - 1]?.completion;
  const continuationAuthority =
    chain.turns[turnIndex - 1]?.continuationAuthority;
  if (
    predecessor?.usable !== true ||
    continuationAuthority === null ||
    continuationAuthority === undefined ||
    predecessor.completionDigest !== claim.predecessorCompletionDigest
  ) {
    throw storeInvalid();
  }
  return createResumeBinding(
    claim,
    readHandleForCompletion(paths, predecessor),
  );
}

function createStartBinding(
  input: Pick<
    ClaimProviderNativeSessionTurnInputV1 | ProviderNativeSessionClaimV1,
    'invocationId' | 'requestDigest' | 'attemptId'
  >,
): ProviderWrapperSessionProtocolBinding {
  return deepFreeze({
    invocationId: input.invocationId,
    requestDigest: input.requestDigest,
    attemptId: input.attemptId,
    sessionControl: {
      action: 'start' as const,
      nativeSessionIdentityMode: 'provider-observed' as const,
      expectedNativeSessionId: null,
    },
  });
}

function createResumeBinding(
  input: Pick<
    ClaimProviderNativeSessionTurnInputV1 | ProviderNativeSessionClaimV1,
    'invocationId' | 'requestDigest' | 'attemptId'
  >,
  handle: ProviderNativeSessionHandleV1,
): ProviderWrapperSessionProtocolBinding {
  return deepFreeze({
    invocationId: input.invocationId,
    requestDigest: input.requestDigest,
    attemptId: input.attemptId,
    sessionControl: {
      action: 'resume' as const,
      nativeSessionIdentityMode: 'engine-supplied' as const,
      expectedNativeSessionId: handle.nativeSessionId,
    },
  });
}

function assertCurrentScope(
  paths: InvestigationRuntimePaths,
  input: Readonly<{
    changeId: string;
    planningGeneration: string;
    assignmentRecordDigest: string;
    sessionSlotId: string;
  }>,
  expected: ProviderNativeSessionScopeV1,
  verifyCentralSnapshot: CentralRoleProviderDefaultSnapshotVerifierPort,
  verifyChangeOverrideSnapshot: AgentRolePlanV2SnapshotVerifierPort,
  verifyHostConfiguration: ChangeRoleAssignmentHostConfigurationVerifierPort,
  verifyProviderRegistry: ChangeRoleAssignmentProviderRegistryVerifierPort,
  verifyDataAuthorization: ChangeRoleAssignmentDataAuthorizationVerifierPort,
  verifySessionCapability: ChangeRoleAssignmentSessionCapabilityVerifierPort,
  verifyProtectedContext: ChangeRoleAssignmentProtectedContextVerifierPort,
  verifyAssignmentAuthority?: ProviderNativeSessionAssignmentAuthorityVerifierPort,
): ProviderNativeSessionScopeV1 {
  const current = loadScope(
    paths,
    input,
    verifyCentralSnapshot,
    verifyChangeOverrideSnapshot,
    verifyHostConfiguration,
    verifyProviderRegistry,
    verifyDataAuthorization,
    verifySessionCapability,
    verifyProtectedContext,
    verifyAssignmentAuthority,
  );
  if (
    current.scopeKey !== expected.scopeKey ||
    canonicalJson(current) !== canonicalJson(expected)
  ) {
    throw storeInvalid();
  }
  return current;
}

function loadScope(
  paths: InvestigationRuntimePaths,
  input: Readonly<{
    changeId: string;
    planningGeneration: string;
    assignmentRecordDigest: string;
    sessionSlotId: string;
  }>,
  verifyCentralSnapshot: CentralRoleProviderDefaultSnapshotVerifierPort,
  verifyChangeOverrideSnapshot: AgentRolePlanV2SnapshotVerifierPort,
  verifyHostConfiguration: ChangeRoleAssignmentHostConfigurationVerifierPort,
  verifyProviderRegistry: ChangeRoleAssignmentProviderRegistryVerifierPort,
  verifyDataAuthorization: ChangeRoleAssignmentDataAuthorizationVerifierPort,
  verifySessionCapability: ChangeRoleAssignmentSessionCapabilityVerifierPort,
  verifyProtectedContext: ChangeRoleAssignmentProtectedContextVerifierPort,
  verifyAssignmentAuthority?: ProviderNativeSessionAssignmentAuthorityVerifierPort,
): ProviderNativeSessionScopeV1 {
  const assignment = readChangeRoleAssignmentRecordV1(
    paths,
    input.changeId,
    input.planningGeneration,
    verifyCentralSnapshot,
    verifyChangeOverrideSnapshot,
    verifyHostConfiguration,
    verifyProviderRegistry,
    verifyDataAuthorization,
    verifySessionCapability,
    verifyProtectedContext,
  );
  if (assignment === null) throw storeInvalid();
  if (assignment.recordDigest !== input.assignmentRecordDigest) {
    throw storeConflict();
  }
  return deriveProviderNativeSessionScopeV1(
    assignment,
    input.sessionSlotId,
    verifyAssignmentAuthority,
  );
}

function withScopeLock<T>(
  paths: InvestigationRuntimePaths,
  scope: ProviderNativeSessionScopeV1,
  operation: () => T,
): T {
  return withPrivateRuntimeLock(
    paths,
    path.join(
      paths.locks,
      'provider-native-sessions',
      `${scope.scopeKey}.lock`,
    ),
    operation,
    'PROVIDER_NATIVE_SESSION_STORE_OPERATION_CONFLICT',
    storeInvalid,
  );
}

function createChain(
  scope: ProviderNativeSessionScopeV1,
  turns: readonly Readonly<{
    claim: ProviderNativeSessionClaimV1;
    completion: ProviderNativeSessionCompletionV1 | null;
    continuationAuthority: ProviderNativeSessionContinuationAuthorityV1 | null;
  }>[],
): ProviderNativeSessionChainV1 {
  const lastTurn = turns.at(-1);
  const last = lastTurn?.completion;
  const state =
    turns.length === 0
      ? ('empty' as const)
      : last === undefined || last === null
        ? ('claimed' as const)
        : last.usable
          ? lastTurn!.continuationAuthority === null
            ? ('continuation-pending' as const)
            : ('resumable' as const)
          : ('terminal-unusable' as const);
  return deepFreeze({
    schemaVersion: 1 as const,
    kind: 'provider-native-session-chain.v1' as const,
    scope,
    state,
    turns: turns.map(({ claim, completion, continuationAuthority }) => ({
      claim,
      completion,
      continuationAuthority,
    })),
  });
}

function publicationRecoveryDirectory(
  locations: ReturnType<typeof storePaths>,
  scopeKey: string,
): string {
  return path.join(locations.recovery, assertDigest(scopeKey));
}

function publicationTemporaryPath(
  locations: ReturnType<typeof storePaths>,
  scopeKey: string,
  filePath: string,
): string {
  const target = publicationRecoveryTarget(locations, scopeKey, filePath);
  const encodedTarget = Buffer.from(target.relativePath, 'utf8').toString(
    'base64url',
  );
  return path.join(
    publicationRecoveryDirectory(locations, scopeKey),
    `v1.${encodedTarget}.${crypto.randomUUID()}.publish.tmp`,
  );
}

function publicationRecoveryTarget(
  locations: ReturnType<typeof storePaths>,
  scopeKey: string,
  requestedFilePath: string,
): PublicationRecoveryTarget {
  const expectedScopeKey = assertDigest(scopeKey);
  const filePath = path.resolve(requestedFilePath);
  if (filePath !== requestedFilePath) throw storeInvalid();
  const nativeRelativePath = path.relative(locations.root, filePath);
  if (
    nativeRelativePath.length === 0 ||
    path.isAbsolute(nativeRelativePath) ||
    nativeRelativePath === '..' ||
    nativeRelativePath.startsWith(`..${path.sep}`)
  ) {
    throw storeInvalid();
  }
  const relativePath = nativeRelativePath.split(path.sep).join('/');
  const parts = relativePath.split('/');
  const objectKinds = Object.freeze({
    claims: Object.freeze({
      suffix: '.claim.json',
      kind: 'claim' as const,
      maxBytes: MAX_OBJECT_BYTES,
    }),
    completions: Object.freeze({
      suffix: '.completion.json',
      kind: 'completion' as const,
      maxBytes: MAX_OBJECT_BYTES,
    }),
    handles: Object.freeze({
      suffix: '.handle.json',
      kind: 'handle' as const,
      maxBytes: MAX_HANDLE_BYTES,
    }),
    'continuation-authorities': Object.freeze({
      suffix: '.continuation-authority.json',
      kind: 'continuation-authority' as const,
      maxBytes: MAX_CONTINUATION_AUTHORITY_BYTES,
    }),
  });
  if (
    parts.length === 3 &&
    parts[1] === 'sha256' &&
    Object.hasOwn(objectKinds, parts[0]!)
  ) {
    const definition = objectKinds[parts[0] as keyof typeof objectKinds];
    const fileName = parts[2]!;
    if (!fileName.endsWith(definition.suffix)) throw storeInvalid();
    const digest = fileName.slice(0, -definition.suffix.length);
    if (!isDigest(digest)) throw storeInvalid();
    return Object.freeze({
      filePath,
      relativePath,
      maxBytes: definition.maxBytes,
      kind: definition.kind,
      digest,
      turn: null,
    });
  }
  if (
    parts.length === 4 &&
    parts[0] === 'chains' &&
    parts[1] === 'sha256' &&
    parts[2] === expectedScopeKey
  ) {
    const match = TURN_REF.exec(parts[3]!);
    if (match === null) throw storeInvalid();
    const turn = Number(match[1]);
    if (turn < 1 || turn > MAX_TURN) throw storeInvalid();
    return Object.freeze({
      filePath,
      relativePath,
      maxBytes: MAX_REF_BYTES,
      kind: match[2] === 'claim' ? 'claim-ref' : 'completion-ref',
      digest: null,
      turn,
    });
  }
  throw storeInvalid();
}

function recoveryTargetFromName(
  locations: ReturnType<typeof storePaths>,
  scopeKey: string,
  name: string,
): PublicationRecoveryTarget {
  const match = PUBLICATION_TEMP.exec(name);
  if (match === null) throw storeInvalid();
  let relativePath: string;
  try {
    const bytes = Buffer.from(match[1]!, 'base64url');
    if (bytes.toString('base64url') !== match[1]) throw storeInvalid();
    relativePath = UTF8.decode(bytes);
  } catch {
    throw storeInvalid();
  }
  if (
    relativePath.length === 0 ||
    relativePath.includes('\\') ||
    relativePath.startsWith('/')
  ) {
    throw storeInvalid();
  }
  const filePath = path.join(locations.root, ...relativePath.split('/'));
  const target = publicationRecoveryTarget(locations, scopeKey, filePath);
  if (target.relativePath !== relativePath) throw storeInvalid();
  return target;
}

function recoverScopePublication(
  paths: InvestigationRuntimePaths,
  locations: ReturnType<typeof storePaths>,
  scopeKey: string,
): void {
  const directory = publicationRecoveryDirectory(locations, scopeKey);
  const before = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (before === undefined) return;
  assertPrivateInvestigationDirectory(paths, directory, storeInvalid);
  const names = fs.readdirSync(directory).sort(compareCodeUnits);
  const after = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (
    after === undefined ||
    !before.isDirectory() ||
    before.isSymbolicLink() ||
    (before.mode & 0o777) !== 0o700 ||
    !sameStableFile(before, after) ||
    names.length > 1
  ) {
    throw storeInvalid();
  }
  if (names.length === 0) return;

  const name = names[0]!;
  const target = recoveryTargetFromName(locations, scopeKey, name);
  const temporaryPath = path.join(directory, name);
  const targetBefore = fs.lstatSync(target.filePath, {
    throwIfNoEntry: false,
  });
  if (targetBefore === undefined) {
    assertDiscardableRecoveryTemporary(paths, temporaryPath, target.maxBytes);
    if (
      fs.lstatSync(target.filePath, { throwIfNoEntry: false }) !== undefined
    ) {
      throw storeInvalid();
    }
  } else {
    const temporary = readBoundedCanonicalSnapshotWithLinkCount(
      paths,
      temporaryPath,
      target.maxBytes,
      2,
    );
    assertPublicationRecoveryValue(temporary.value, target, scopeKey);
    assertPrivateFileStats(targetBefore, target.maxBytes, 2);
    const targetAfter = fs.lstatSync(target.filePath, {
      throwIfNoEntry: false,
    });
    if (
      targetAfter === undefined ||
      !sameStableFile(targetBefore, targetAfter) ||
      !sameFile(targetAfter, temporary.identity)
    ) {
      throw storeInvalid();
    }
  }

  try {
    fs.unlinkSync(temporaryPath);
    fsyncDirectory(directory);
  } catch {
    throw storeInvalid();
  }
  if (fs.readdirSync(directory).length !== 0) throw storeInvalid();
  if (targetBefore !== undefined) {
    const recovered = readBoundedCanonicalSnapshot(
      paths,
      target.filePath,
      target.maxBytes,
    );
    assertPublicationRecoveryValue(recovered.value, target, scopeKey);
  }
}

function assertDiscardableRecoveryTemporary(
  paths: InvestigationRuntimePaths,
  temporaryPath: string,
  maxBytes: number,
): void {
  assertPrivateInvestigationDirectory(
    paths,
    path.dirname(temporaryPath),
    storeInvalid,
  );
  const absolute = path.resolve(temporaryPath);
  if (absolute !== temporaryPath) throw storeInvalid();
  const before = fs.lstatSync(absolute, { throwIfNoEntry: false });
  if (before === undefined) throw storeInvalid();
  assertDiscardableRecoveryTemporaryStats(before, maxBytes);
  let descriptor: number | undefined;
  try {
    const noFollow = fs.constants.O_NOFOLLOW;
    const nonBlock = fs.constants.O_NONBLOCK;
    if (typeof noFollow !== 'number' || typeof nonBlock !== 'number') {
      throw storeInvalid();
    }
    descriptor = fs.openSync(
      absolute,
      fs.constants.O_RDONLY | noFollow | nonBlock,
    );
    const opened = fs.fstatSync(descriptor);
    assertDiscardableRecoveryTemporaryStats(opened, maxBytes);
    const current = fs.lstatSync(absolute, { throwIfNoEntry: false });
    if (
      current === undefined ||
      !sameStableFile(before, opened) ||
      !sameStableFile(opened, current) ||
      fs.realpathSync(absolute) !== absolute
    ) {
      throw storeInvalid();
    }
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      error.code === 'PROVIDER_NATIVE_SESSION_STORE_INVALID'
    ) {
      throw error;
    }
    throw storeInvalid();
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function assertDiscardableRecoveryTemporaryStats(
  stats: fs.Stats,
  maxBytes: number,
): void {
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.nlink !== 1 ||
    (stats.mode & 0o777) !== 0o600 ||
    stats.size < 0 ||
    stats.size > maxBytes
  ) {
    throw storeInvalid();
  }
}

function assertPublicationRecoveryValue(
  value: unknown,
  target: PublicationRecoveryTarget,
  scopeKey: string,
): void {
  try {
    if (target.kind === 'claim') {
      const claim = assertProviderNativeSessionClaimV1(value);
      if (
        claim.scope.scopeKey !== scopeKey ||
        claim.claimDigest !== target.digest
      ) {
        throw storeInvalid();
      }
      return;
    }
    if (target.kind === 'completion') {
      const completion = assertProviderNativeSessionCompletionV1(value);
      if (
        completion.scope.scopeKey !== scopeKey ||
        completion.completionDigest !== target.digest
      ) {
        throw storeInvalid();
      }
      return;
    }
    if (target.kind === 'handle') {
      const handle = assertProviderNativeSessionHandleV1(value, {
        handleDigest: target.digest ?? undefined,
      });
      if (handle.scopeKey !== scopeKey) throw storeInvalid();
      return;
    }
    if (target.kind === 'continuation-authority') {
      const authority =
        assertProviderNativeSessionContinuationAuthorityEnvelopeV1(
          value,
          storeInvalid,
        );
      if (
        authority.scopeKey !== scopeKey ||
        authority.completionDigest !== target.digest
      ) {
        throw storeInvalid();
      }
      return;
    }
    if (target.turn === null) throw storeInvalid();
    if (target.kind === 'claim-ref') {
      assertClaimRef(value, scopeKey, target.turn);
      return;
    }
    if (!isRecord(value) || !isDigest(value.claimDigest)) {
      throw storeInvalid();
    }
    assertCompletionRef(value, scopeKey, target.turn, value.claimDigest);
  } catch {
    throw storeInvalid();
  }
}

function readRefNames(
  paths: InvestigationRuntimePaths,
  locations: ReturnType<typeof storePaths>,
  scopeKey: string,
): readonly string[] {
  const directory = chainDirectory(locations, scopeKey);
  const before = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (before === undefined) return Object.freeze([]);
  assertPrivateInvestigationDirectory(paths, directory, storeInvalid);
  const names = fs.readdirSync(directory).sort(compareCodeUnits);
  const after = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (
    after === undefined ||
    !before.isDirectory() ||
    before.isSymbolicLink() ||
    (before.mode & 0o777) !== 0o700 ||
    !sameStableFile(before, after) ||
    names.length > MAX_TURN * 2
  ) {
    throw storeInvalid();
  }
  return Object.freeze(names);
}

function createClaimRef(
  claim: ProviderNativeSessionClaimV1,
): ProviderNativeSessionClaimRefV1 {
  return createDurableClaimRef(claim, storeInvalid);
}

function createCompletionRef(
  completion: ProviderNativeSessionCompletionV1,
): ProviderNativeSessionCompletionRefV1 {
  return createDurableCompletionRef(completion, storeInvalid);
}

function assertClaimRef(
  value: unknown,
  scopeKey: string,
  turn: number,
): ProviderNativeSessionClaimRefV1 {
  return assertDurableClaimRef(value, scopeKey, turn, storeInvalid);
}

function assertCompletionRef(
  value: unknown,
  scopeKey: string,
  turn: number,
  claimDigest: string,
): ProviderNativeSessionCompletionRefV1 {
  return assertDurableCompletionRef(
    value,
    scopeKey,
    turn,
    claimDigest,
    storeInvalid,
  );
}

function assertRefUnchanged(
  paths: InvestigationRuntimePaths,
  filePath: string,
  before: Readonly<{ value: unknown; bytes: Buffer; identity: fs.Stats }>,
  maxBytes = MAX_REF_BYTES,
): void {
  const after = readBoundedCanonicalSnapshot(paths, filePath, maxBytes);
  if (
    !sameStableFile(before.identity, after.identity) ||
    !before.bytes.equals(after.bytes) ||
    canonicalJson(before.value) !== canonicalJson(after.value)
  ) {
    throw storeInvalid();
  }
}

function assertClaimInput(
  value: unknown,
): ClaimProviderNativeSessionTurnInputV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'changeId',
      'planningGeneration',
      'assignmentRecordDigest',
      'sessionSlotId',
      'predecessorCompletionDigest',
      'invocationId',
      'requestDigest',
      'attemptId',
    ]) ||
    !isChangeId(value.changeId) ||
    !isDigest(value.planningGeneration) ||
    !isDigest(value.assignmentRecordDigest) ||
    !isSessionSlotId(value.sessionSlotId) ||
    !isNullableDigest(value.predecessorCompletionDigest) ||
    !isBindingIdentifier(value.invocationId) ||
    !isDigest(value.requestDigest) ||
    !isBindingIdentifier(value.attemptId)
  ) {
    throw storeInvalid();
  }
  return deepFreeze(
    structuredClone(value) as unknown as ClaimProviderNativeSessionTurnInputV1,
  );
}

function assertCompletionInput(
  value: unknown,
): CompleteProviderNativeSessionTurnInputV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'changeId',
      'planningGeneration',
      'assignmentRecordDigest',
      'sessionSlotId',
      'claimDigest',
      'terminal',
    ]) ||
    !isChangeId(value.changeId) ||
    !isDigest(value.planningGeneration) ||
    !isDigest(value.assignmentRecordDigest) ||
    !isSessionSlotId(value.sessionSlotId) ||
    !isDigest(value.claimDigest)
  ) {
    throw storeInvalid();
  }
  return deepFreeze(
    structuredClone(
      value,
    ) as unknown as CompleteProviderNativeSessionTurnInputV1,
  );
}

function assertRecoveryInput(
  value: unknown,
): RecoverProviderNativeSessionTurnInputV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'scopeKey',
      'sessionSlotId',
      'claimDigest',
      'invocationId',
      'requestDigest',
      'attemptId',
      'expectedProtocolReceiptDigest',
    ]) ||
    !isDigest(value.scopeKey) ||
    !isSessionSlotId(value.sessionSlotId) ||
    !isDigest(value.claimDigest) ||
    !isBindingIdentifier(value.invocationId) ||
    !isDigest(value.requestDigest) ||
    !isBindingIdentifier(value.attemptId) ||
    !isNullableDigest(value.expectedProtocolReceiptDigest)
  ) {
    throw storeInvalid();
  }
  return deepFreeze(
    structuredClone(
      value,
    ) as unknown as RecoverProviderNativeSessionTurnInputV1,
  );
}

function assertContinuationAuthorityInput(
  value: unknown,
): PublishProviderNativeSessionContinuationAuthorityInputV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'changeId',
      'planningGeneration',
      'assignmentRecordDigest',
      'sessionSlotId',
      'completionDigest',
    ]) ||
    !isChangeId(value.changeId) ||
    !isDigest(value.planningGeneration) ||
    !isDigest(value.assignmentRecordDigest) ||
    !isSessionSlotId(value.sessionSlotId) ||
    !isDigest(value.completionDigest)
  ) {
    throw storeInvalid();
  }
  return deepFreeze(
    structuredClone(
      value,
    ) as PublishProviderNativeSessionContinuationAuthorityInputV1,
  );
}

function assertChainIdentity(value: unknown): Readonly<{
  changeId: string;
  planningGeneration: string;
  assignmentRecordDigest: string;
  sessionSlotId: string;
}> {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'changeId',
      'planningGeneration',
      'assignmentRecordDigest',
      'sessionSlotId',
    ]) ||
    !isChangeId(value.changeId) ||
    !isDigest(value.planningGeneration) ||
    !isDigest(value.assignmentRecordDigest) ||
    !isSessionSlotId(value.sessionSlotId)
  ) {
    throw storeInvalid();
  }
  return Object.freeze({
    changeId: value.changeId,
    planningGeneration: value.planningGeneration,
    assignmentRecordDigest: value.assignmentRecordDigest,
    sessionSlotId: value.sessionSlotId,
  });
}

function claimMatchesInput(
  claim: ProviderNativeSessionClaimV1,
  input: ClaimProviderNativeSessionTurnInputV1,
): boolean {
  return (
    claim.predecessorCompletionDigest === input.predecessorCompletionDigest &&
    claim.invocationId === input.invocationId &&
    claim.requestDigest === input.requestDigest &&
    claim.attemptId === input.attemptId
  );
}

function claimMatchesRecoveryInput(
  claim: ProviderNativeSessionClaimV1,
  input: RecoverProviderNativeSessionTurnInputV1,
): boolean {
  return (
    claim.scope.scopeKey === input.scopeKey &&
    claim.scope.sessionSlotId === input.sessionSlotId &&
    claim.claimDigest === input.claimDigest &&
    claim.invocationId === input.invocationId &&
    claim.requestDigest === input.requestDigest &&
    claim.attemptId === input.attemptId
  );
}

function publishCanonicalCreateOnly(
  paths: InvestigationRuntimePaths,
  scopeKey: string,
  filePath: string,
  value: unknown,
  maxBytes: number,
): void {
  const content = Buffer.from(`${canonicalJson(value)}\n`, 'utf8');
  if (content.length === 0 || content.length > maxBytes) throw storeInvalid();
  const locations = storePaths(paths);
  const recoveryTarget = publicationRecoveryTarget(
    locations,
    scopeKey,
    filePath,
  );
  if (recoveryTarget.maxBytes !== maxBytes) throw storeInvalid();
  assertPublicationRecoveryValue(value, recoveryTarget, scopeKey);
  const recoveryDirectory = publicationRecoveryDirectory(locations, scopeKey);
  ensurePrivateInvestigationDirectory(
    paths,
    path.dirname(filePath),
    storeInvalid,
  );
  ensurePrivateInvestigationDirectory(paths, recoveryDirectory, storeInvalid);
  recoverScopePublication(paths, locations, scopeKey);
  if (fs.lstatSync(filePath, { throwIfNoEntry: false }) !== undefined) {
    if (!readBoundedCanonicalBytes(paths, filePath, maxBytes).equals(content)) {
      throw storeConflict();
    }
    return;
  }

  const temporaryPath = publicationTemporaryPath(locations, scopeKey, filePath);
  let descriptor: number | undefined;
  let temporaryCreated = false;
  let operationError: Error | null = null;
  try {
    descriptor = fs.openSync(temporaryPath, NO_FOLLOW_CREATE, 0o600);
    temporaryCreated = true;
    fs.fchmodSync(descriptor, 0o600);
    fs.writeFileSync(descriptor, content);
    fs.fsyncSync(descriptor);
    assertPrivateFileStats(fs.fstatSync(descriptor), content.length);
    fsyncDirectory(recoveryDirectory);
    try {
      fs.linkSync(temporaryPath, filePath);
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'EEXIST') throw error;
      if (
        !readBoundedCanonicalBytes(paths, filePath, maxBytes).equals(content)
      ) {
        throw storeConflict();
      }
    }
    fsyncDirectory(path.dirname(filePath));
  } catch (error) {
    operationError = normalizePublicationOperationError(error);
  }
  const cleanupError = cleanupPublicationTemporary(
    descriptor,
    temporaryCreated,
    temporaryPath,
    recoveryDirectory,
  );
  if (operationError !== null) throw operationError;
  if (cleanupError !== null) throw cleanupError;
  if (!readBoundedCanonicalBytes(paths, filePath, maxBytes).equals(content)) {
    throw storeInvalid();
  }
}

function readBoundedCanonicalJson(
  paths: InvestigationRuntimePaths,
  filePath: string,
  maxBytes: number,
): unknown {
  return readBoundedCanonicalSnapshot(paths, filePath, maxBytes).value;
}

function readBoundedCanonicalSnapshot(
  paths: InvestigationRuntimePaths,
  filePath: string,
  maxBytes: number,
): Readonly<{ value: unknown; bytes: Buffer; identity: fs.Stats }> {
  return readBoundedCanonicalSnapshotWithLinkCount(
    paths,
    filePath,
    maxBytes,
    1,
  );
}

function readBoundedCanonicalSnapshotWithLinkCount(
  paths: InvestigationRuntimePaths,
  filePath: string,
  maxBytes: number,
  expectedLinks: 1 | 2,
): Readonly<{ value: unknown; bytes: Buffer; identity: fs.Stats }> {
  const snapshot = readBoundedFileSnapshotWithLinkCount(
    paths,
    filePath,
    maxBytes,
    expectedLinks,
  );
  let source: string;
  let value: unknown;
  try {
    source = UTF8.decode(snapshot.bytes);
    value = JSON.parse(source) as unknown;
  } catch {
    throw storeInvalid();
  }
  if (`${canonicalJson(value)}\n` !== source) throw storeInvalid();
  return Object.freeze({
    value,
    bytes: snapshot.bytes,
    identity: snapshot.identity,
  });
}

function readBoundedCanonicalBytes(
  paths: InvestigationRuntimePaths,
  filePath: string,
  maxBytes: number,
): Buffer {
  return readBoundedFileSnapshot(paths, filePath, maxBytes).bytes;
}

function readBoundedFileSnapshot(
  paths: InvestigationRuntimePaths,
  filePath: string,
  maxBytes: number,
): Readonly<{ bytes: Buffer; identity: fs.Stats }> {
  return readBoundedFileSnapshotWithLinkCount(paths, filePath, maxBytes, 1);
}

function readBoundedFileSnapshotWithLinkCount(
  paths: InvestigationRuntimePaths,
  filePath: string,
  maxBytes: number,
  expectedLinks: 1 | 2,
): Readonly<{ bytes: Buffer; identity: fs.Stats }> {
  assertPrivateInvestigationDirectory(
    paths,
    path.dirname(filePath),
    storeInvalid,
  );
  const absolute = path.resolve(filePath);
  if (absolute !== filePath) throw storeInvalid();
  const before = fs.lstatSync(absolute, { throwIfNoEntry: false });
  if (before === undefined) throw storeInvalid();
  assertPrivateFileStats(before, maxBytes, expectedLinks);
  let descriptor: number | undefined;
  try {
    const noFollow = fs.constants.O_NOFOLLOW;
    const nonBlock = fs.constants.O_NONBLOCK;
    if (typeof noFollow !== 'number' || typeof nonBlock !== 'number') {
      throw storeInvalid();
    }
    descriptor = fs.openSync(
      absolute,
      fs.constants.O_RDONLY | noFollow | nonBlock,
    );
    const opened = fs.fstatSync(descriptor);
    assertPrivateFileStats(opened, maxBytes, expectedLinks);
    if (!sameFile(before, opened)) throw storeInvalid();

    const expectedBytes = opened.size;
    const buffer = Buffer.alloc(expectedBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const count = fs.readSync(
        descriptor,
        buffer,
        offset,
        buffer.length - offset,
        offset,
      );
      if (count === 0) break;
      offset += count;
    }
    const afterRead = fs.fstatSync(descriptor);
    const current = fs.lstatSync(absolute, { throwIfNoEntry: false });
    if (
      offset !== expectedBytes ||
      current === undefined ||
      !sameStableFile(opened, afterRead) ||
      !sameStableFile(opened, current) ||
      fs.realpathSync(absolute) !== absolute
    ) {
      throw storeInvalid();
    }
    return Object.freeze({
      bytes: buffer.subarray(0, offset),
      identity: opened,
    });
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      error.code === 'PROVIDER_NATIVE_SESSION_STORE_INVALID'
    ) {
      throw error;
    }
    throw storeInvalid();
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function assertPrivateFileStats(
  stats: fs.Stats,
  maxBytes: number,
  expectedLinks: 1 | 2 = 1,
): void {
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.nlink !== expectedLinks ||
    (stats.mode & 0o777) !== 0o600 ||
    stats.size < 1 ||
    stats.size > maxBytes
  ) {
    throw storeInvalid();
  }
}

function fsyncDirectory(directory: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      directory,
      fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0),
    );
    fs.fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function assertDigest(value: unknown): string {
  if (!isDigest(value)) throw storeInvalid();
  return value;
}

function isChangeId(value: unknown): value is string {
  return (
    typeof value === 'string' && CHANGE_ID.test(value) && value !== 'archive'
  );
}

function isSessionSlotId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_SLOT_ID.test(value);
}

function isBindingIdentifier(value: unknown): value is string {
  return typeof value === 'string' && BINDING_IDENTIFIER.test(value);
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST.test(value);
}

function isNullableDigest(value: unknown): value is string | null {
  return value === null || isDigest(value);
}

function sameFile(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameStableFile(left: fs.Stats, right: fs.Stats): boolean {
  return (
    sameFile(left, right) &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function storeInvalid() {
  return workflowError(
    'PROVIDER_NATIVE_SESSION_STORE_INVALID',
    'Durable provider-native session state is unsafe, malformed, or stale.',
    ExitCode.staleState,
  );
}

function storeConflict() {
  return workflowError(
    'PROVIDER_NATIVE_SESSION_STORE_CONFLICT',
    'A different provider-native session transition already owns this scope.',
    ExitCode.conflict,
  );
}

function storeOperationConflict() {
  return workflowError(
    'PROVIDER_NATIVE_SESSION_STORE_OPERATION_CONFLICT',
    'Provider-native session state changed during observation.',
    ExitCode.conflict,
  );
}

function terminalUnusable() {
  return workflowError(
    'PROVIDER_NATIVE_SESSION_TERMINAL_UNUSABLE',
    'The provider-native session chain is terminal and cannot be relaunched.',
    ExitCode.conflict,
  );
}

function continuationNotAuthorized() {
  return workflowError(
    'PROVIDER_NATIVE_SESSION_CONTINUATION_NOT_AUTHORIZED',
    'The provider-native session result is not authorized for continuation.',
    ExitCode.conflict,
  );
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const expected = new Set(keys);
  const actual = Object.keys(value);
  return (
    actual.length === expected.size && actual.every((key) => expected.has(key))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function isPromiseLike(value: unknown): boolean {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

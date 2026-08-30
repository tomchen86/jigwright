import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';

import type { ProviderWrapperSessionProtocolBinding } from '@jigwright/agent-runtime';

import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
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
  type ProviderNativeSessionClaimV2,
  type ProviderNativeSessionCompletionTerminalV1,
  type ProviderNativeSessionCompletionTerminalV2,
  type ProviderNativeSessionCompletionV1,
  type ProviderNativeSessionCompletionV2,
  type ProviderNativeSessionHandleV1,
  type ProviderNativeSessionHandleV2,
  type ProviderNativeSessionScopeV1,
  type ProviderNativeSessionAssignmentAuthorityVerifierPort,
  type ProviderNativeTurnBindingV1,
  assertProviderNativeSessionClaimV1,
  assertProviderNativeSessionClaimV2,
  assertProviderNativeSessionCompletionV1,
  assertProviderNativeSessionCompletionV2,
  assertProviderNativeSessionHandleV1,
  assertProviderNativeSessionHandleV2,
  assertProviderNativeTurnBindingContinuationV1,
  assertProviderNativeTurnBindingV1,
  createProviderNativeSessionClaimV1,
  createProviderNativeSessionClaimV2,
  createProviderNativeSessionCompletionV1,
  createProviderNativeSessionCompletionV2,
  deriveProviderNativeSessionScopeV1,
  providerNativeSessionProtocolBindingV2,
} from '../../modules/provider-orchestration/provider-native-session.ts';
import {
  inspectHistoricalChangeRoleAssignmentRecordV1,
  readChangeRoleAssignmentRecordV1,
} from './change-role-assignment-store.ts';
import {
  assertPrivateInvestigationDirectory,
  ensurePrivateInvestigationDirectory,
  withPrivateRuntimeLock,
} from './investigation-session-store.ts';
import type { InvestigationRuntimePaths } from '../session-workspace/paths.ts';

const CHANGE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const SESSION_SLOT_ID = /^role-assignment-session-[0-9a-f]{64}$/u;
const BINDING_IDENTIFIER = /^[a-z0-9][a-z0-9._:-]{0,255}$/u;
const TURN_REF = /^(\d{5})\.(claim|completion)-ref\.json$/u;
const V2_TURN_REF = /^(\d{5})\.(claim|completion)-ref\.json$/u;
const PUBLICATION_TEMP =
  /^v1\.([A-Za-z0-9_-]+)\.([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.publish\.tmp$/u;
const MAX_TURN = 10_000;
const MAX_OBJECT_BYTES = 512 * 1024;
const MAX_HANDLE_BYTES = 8 * 1024;
const MAX_REF_BYTES = 2 * 1024;
const MAX_V2_OBJECT_BYTES = 768 * 1024;
const MAX_V2_HANDLE_BYTES = 16 * 1024;
const MAX_V2_REF_BYTES = 4 * 1024;
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

export type ProviderNativeSessionChainV1 = Readonly<{
  schemaVersion: 1;
  kind: 'provider-native-session-chain.v1';
  scope: ProviderNativeSessionScopeV1;
  state: 'empty' | 'claimed' | 'resumable' | 'terminal-unusable';
  turns: readonly Readonly<{
    claim: ProviderNativeSessionClaimV1;
    completion: ProviderNativeSessionCompletionV1 | null;
  }>[];
}>;

type ProviderNativeSessionClaimRefV1 = Readonly<{
  schemaVersion: 1;
  kind: 'provider-native-session-claim-ref.v1';
  scopeKey: string;
  turn: number;
  claimDigest: string;
}>;

type ProviderNativeSessionCompletionRefV1 = Readonly<{
  schemaVersion: 1;
  kind: 'provider-native-session-completion-ref.v1';
  scopeKey: string;
  turn: number;
  claimDigest: string;
  completionDigest: string;
}>;

export type ProviderNativeTurnCurrentnessQueryV1 = Readonly<{
  schemaVersion: 1;
  kind: 'provider-native-turn-currentness-query.v1';
  changeId: string;
  planningGeneration: string;
  assignmentRecordDigest: string;
  sessionSlotId: string;
  invocationId: string;
  workflowId: string;
  jobId: string;
  attemptId: string;
  leaseGeneration: number;
  /** Transient fencing secret. The store never serializes or returns it. */
  leaseToken: string;
}>;

/**
 * The production adapter will hold the engine-owned execution/context fence
 * for the complete callback. This inactive foundation deliberately provides no
 * adapter: a caller cannot substitute a binding or claim launch authority.
 */
export type ProviderNativeTurnCurrentnessVerifierPort = Readonly<{
  withCurrentFence<T>(
    query: ProviderNativeTurnCurrentnessQueryV1,
    operation: (binding: ProviderNativeTurnBindingV1) => T,
  ): T;
}>;

export type ClaimProviderNativeSessionTurnInputV2 = Readonly<{
  changeId: string;
  planningGeneration: string;
  assignmentRecordDigest: string;
  sessionSlotId: string;
  predecessorCompletionDigest: string | null;
  invocationId: string;
  workflowId: string;
  jobId: string;
  attemptId: string;
  leaseGeneration: number;
  leaseToken: string;
}>;

export type ClaimProviderNativeSessionTurnResultV2 = Readonly<{
  outcome: 'claimed' | 'already-claimed';
  claim: ProviderNativeSessionClaimV2;
  binding: ProviderWrapperSessionProtocolBinding | null;
}>;

export type CompleteProviderNativeSessionTurnInputV2 = Readonly<{
  changeId: string;
  planningGeneration: string;
  assignmentRecordDigest: string;
  sessionSlotId: string;
  claimDigest: string;
  invocationId: string;
  workflowId: string;
  jobId: string;
  attemptId: string;
  leaseGeneration: number;
  leaseToken: string;
  terminal: ProviderNativeSessionCompletionTerminalV2;
}>;

export type ProviderNativeSessionChainV2 = Readonly<{
  schemaVersion: 2;
  kind: 'provider-native-session-chain.v2';
  scope: ProviderNativeSessionScopeV1;
  state: 'empty' | 'claimed' | 'resumable' | 'terminal-unusable';
  turns: readonly Readonly<{
    claim: ProviderNativeSessionClaimV2;
    completion: ProviderNativeSessionCompletionV2 | null;
  }>[];
}>;

export type ProviderNativeSessionHistoricalDiagnosticV2 = Readonly<{
  schemaVersion: 2;
  kind: 'provider-native-session-historical-diagnostic.v2';
  outcome: 'absent' | 'inspected';
  authorityEligible: false;
  transitionEligible: false;
  operationalWrites: false;
  recoveryPerformed: false;
  assignmentAssurance: 'store-owned-structural-record';
  attemptCurrentness: 'not-observed';
  publicationRecovery: 'not-applied';
  chain: ProviderNativeSessionChainV2;
}>;

type ProviderNativeSessionClaimRefV2 = Readonly<{
  schemaVersion: 2;
  kind: 'provider-native-session-claim-ref.v2';
  scopeKey: string;
  turn: number;
  claimDigest: string;
}>;

type ProviderNativeSessionCompletionRefV2 = Readonly<{
  schemaVersion: 2;
  kind: 'provider-native-session-completion-ref.v2';
  scopeKey: string;
  turn: number;
  claimDigest: string;
  completionDigest: string;
}>;

type ProviderNativeSessionAttemptClaimRefV2 = Readonly<{
  schemaVersion: 2;
  kind: 'provider-native-session-attempt-claim-ref.v2';
  attemptIdentityDigest: string;
  scopeKey: string;
  turn: number;
  claimDigest: string;
  turnBindingDigest: string;
}>;

type V2PublicationRecoveryTarget = Readonly<{
  filePath: string;
  relativePath: string;
  maxBytes: number;
  kind:
    | 'claim'
    | 'completion'
    | 'handle'
    | 'claim-ref'
    | 'completion-ref'
    | 'attempt-claim-ref';
  digest: string | null;
  scopeKey: string | null;
  turn: number | null;
}>;

type V2RecoveryDirectorySnapshot = Readonly<{
  identity: fs.Stats | null;
  names: readonly string[];
}>;

type PublicationRecoveryTarget = Readonly<{
  filePath: string;
  relativePath: string;
  maxBytes: number;
  kind: 'claim' | 'completion' | 'handle' | 'claim-ref' | 'completion-ref';
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

/**
 * Persist an inactive V2 current-turn claim. The transient selector and raw
 * lease token are used only by `withCurrentFence`; all durable facts come from
 * the engine-observed binding returned while that fence remains held.
 */
export function claimProviderNativeSessionTurnV2(
  paths: InvestigationRuntimePaths,
  candidate: ClaimProviderNativeSessionTurnInputV2,
  verifyCentralSnapshot: CentralRoleProviderDefaultSnapshotVerifierPort,
  verifyChangeOverrideSnapshot: AgentRolePlanV2SnapshotVerifierPort,
  verifyHostConfiguration: ChangeRoleAssignmentHostConfigurationVerifierPort,
  verifyProviderRegistry: ChangeRoleAssignmentProviderRegistryVerifierPort,
  verifyDataAuthorization: ChangeRoleAssignmentDataAuthorizationVerifierPort,
  verifySessionCapability: ChangeRoleAssignmentSessionCapabilityVerifierPort,
  verifyProtectedContext: ChangeRoleAssignmentProtectedContextVerifierPort,
  verifyNativeTurnCurrentness: ProviderNativeTurnCurrentnessVerifierPort,
): ClaimProviderNativeSessionTurnResultV2 {
  const input = assertClaimInputV2(candidate);
  const query = createCurrentnessQueryV2(input);
  return withNativeTurnCurrentFence(
    verifyNativeTurnCurrentness,
    query,
    (turnBinding) =>
      withAttemptIdentityLock(paths, turnBinding.attemptIdentityDigest, () => {
        const observed = loadScopeWithRoles(
          paths,
          input,
          verifyCentralSnapshot,
          verifyChangeOverrideSnapshot,
          verifyHostConfiguration,
          verifyProviderRegistry,
          verifyDataAuthorization,
          verifySessionCapability,
          verifyProtectedContext,
        );
        assertTurnBindingMatchesObservedScope(turnBinding, observed);
        return withScopeLock(paths, observed.scope, () => {
          const current = assertCurrentScopeWithRoles(
            paths,
            input,
            observed,
            verifyCentralSnapshot,
            verifyChangeOverrideSnapshot,
            verifyHostConfiguration,
            verifyProviderRegistry,
            verifyDataAuthorization,
            verifySessionCapability,
            verifyProtectedContext,
          );
          assertTurnBindingMatchesObservedScope(turnBinding, current);
          const chain = readChainForScopeV2(paths, current);
          if (chain.state === 'terminal-unusable') throw terminalUnusable();
          if (chain.state === 'claimed') {
            const claimed = chain.turns.at(-1)!.claim;
            if (
              claimed.predecessorCompletionDigest !==
                input.predecessorCompletionDigest ||
              !isBindingContinuation(claimed.turnBinding, turnBinding)
            ) {
              throw storeConflict();
            }
            assertAttemptClaimIndexV2(paths, claimed);
            return deepFreeze({
              outcome: 'already-claimed' as const,
              claim: claimed,
              binding: null,
            });
          }
          if (chain.turns.length !== 0) {
            // V2 is a single fresh current-Attempt turn. Resume/rollover is a
            // later protocol slice and cannot be inferred from a completion.
            throw storeConflict();
          }

          const predecessor = chain.turns.at(-1)?.completion ?? null;
          if (
            (predecessor === null &&
              input.predecessorCompletionDigest !== null) ||
            (predecessor !== null &&
              input.predecessorCompletionDigest !==
                predecessor.completionDigest)
          ) {
            throw storeConflict();
          }
          const turn = chain.turns.length + 1;
          const claim = createProviderNativeSessionClaimV2({
            scope: current.scope,
            turn,
            predecessorCompletion: predecessor,
            turnBinding,
          });
          const existingIndex = readAttemptClaimIndexV2(
            paths,
            turnBinding.attemptIdentityDigest,
          );
          if (existingIndex !== null) {
            const indexedClaim = readIndexedClaimV2(paths, existingIndex);
            if (
              indexedClaim.scope.scopeKey !== current.scope.scopeKey ||
              indexedClaim.turn !== turn ||
              indexedClaim.predecessorCompletionDigest !==
                input.predecessorCompletionDigest ||
              !isBindingContinuation(indexedClaim.turnBinding, turnBinding)
            ) {
              throw storeConflict();
            }
            publishCanonicalCreateOnlyV2(
              paths,
              claimRefPathV2(storePathsV2(paths), current.scope.scopeKey, turn),
              createClaimRefV2(indexedClaim),
              MAX_V2_REF_BYTES,
            );
            const recovered = readChainForScopeV2(paths, current);
            const recoveredClaim = recovered.turns.at(-1)?.claim;
            if (
              recovered.state !== 'claimed' ||
              recoveredClaim === undefined ||
              recoveredClaim.claimDigest !== indexedClaim.claimDigest
            ) {
              throw storeInvalid();
            }
            return deepFreeze({
              outcome: 'already-claimed' as const,
              claim: recoveredClaim,
              binding: null,
            });
          }

          const locations = storePathsV2(paths);
          publishCanonicalCreateOnlyV2(
            paths,
            claimObjectPathV2(locations, claim.claimDigest),
            claim,
            MAX_V2_OBJECT_BYTES,
          );
          publishCanonicalCreateOnlyV2(
            paths,
            attemptClaimRefPathV2(
              locations,
              claim.turnBinding.attemptIdentityDigest,
            ),
            createAttemptClaimRefV2(claim),
            MAX_V2_REF_BYTES,
          );
          publishCanonicalCreateOnlyV2(
            paths,
            claimRefPathV2(locations, current.scope.scopeKey, turn),
            createClaimRefV2(claim),
            MAX_V2_REF_BYTES,
          );
          const published = readChainForScopeV2(paths, current);
          const publishedClaim = published.turns.at(-1)?.claim;
          if (
            published.state !== 'claimed' ||
            publishedClaim?.claimDigest !== claim.claimDigest
          ) {
            throw storeInvalid();
          }
          return deepFreeze({
            outcome: 'claimed' as const,
            claim: publishedClaim,
            binding: providerNativeSessionProtocolBindingV2(publishedClaim),
          });
        });
      }),
  );
}

/** Complete a V2 claim while the same stable Attempt/lease fence is current. */
export function completeProviderNativeSessionTurnV2(
  paths: InvestigationRuntimePaths,
  candidate: CompleteProviderNativeSessionTurnInputV2,
  verifyCentralSnapshot: CentralRoleProviderDefaultSnapshotVerifierPort,
  verifyChangeOverrideSnapshot: AgentRolePlanV2SnapshotVerifierPort,
  verifyHostConfiguration: ChangeRoleAssignmentHostConfigurationVerifierPort,
  verifyProviderRegistry: ChangeRoleAssignmentProviderRegistryVerifierPort,
  verifyDataAuthorization: ChangeRoleAssignmentDataAuthorizationVerifierPort,
  verifySessionCapability: ChangeRoleAssignmentSessionCapabilityVerifierPort,
  verifyProtectedContext: ChangeRoleAssignmentProtectedContextVerifierPort,
  verifyNativeTurnCurrentness: ProviderNativeTurnCurrentnessVerifierPort,
): ProviderNativeSessionCompletionV2 {
  const input = assertCompletionInputV2(candidate);
  const query = createCurrentnessQueryV2(input);
  return withNativeTurnCurrentFence(
    verifyNativeTurnCurrentness,
    query,
    (turnBinding) =>
      withAttemptIdentityLock(paths, turnBinding.attemptIdentityDigest, () => {
        const observed = loadScopeWithRoles(
          paths,
          input,
          verifyCentralSnapshot,
          verifyChangeOverrideSnapshot,
          verifyHostConfiguration,
          verifyProviderRegistry,
          verifyDataAuthorization,
          verifySessionCapability,
          verifyProtectedContext,
        );
        assertTurnBindingMatchesObservedScope(turnBinding, observed);
        return withScopeLock(paths, observed.scope, () => {
          const current = assertCurrentScopeWithRoles(
            paths,
            input,
            observed,
            verifyCentralSnapshot,
            verifyChangeOverrideSnapshot,
            verifyHostConfiguration,
            verifyProviderRegistry,
            verifyDataAuthorization,
            verifySessionCapability,
            verifyProtectedContext,
          );
          assertTurnBindingMatchesObservedScope(turnBinding, current);
          const chain = readChainForScopeV2(paths, current);
          const turnIndex = chain.turns.findIndex(
            ({ claim }) => claim.claimDigest === input.claimDigest,
          );
          if (turnIndex < 0) throw storeConflict();
          const turn = chain.turns[turnIndex]!;
          if (!isBindingContinuation(turn.claim.turnBinding, turnBinding)) {
            throw storeConflict();
          }
          assertAttemptClaimIndexV2(paths, turn.claim);
          if (turn.completion !== null) {
            if (
              !isBindingContinuation(turn.completion.turnBinding, turnBinding)
            ) {
              throw storeConflict();
            }
            const replay = createProviderNativeSessionCompletionV2({
              claim: turn.claim,
              currentTurnBinding: turn.completion.turnBinding,
              terminal: input.terminal,
            });
            if (
              replay.completion.completionDigest !==
              turn.completion.completionDigest
            ) {
              throw storeConflict();
            }
            return turn.completion;
          }
          if (turnIndex !== chain.turns.length - 1) {
            throw storeConflict();
          }

          const materialized = createProviderNativeSessionCompletionV2({
            claim: turn.claim,
            currentTurnBinding: turnBinding,
            terminal: input.terminal,
          });
          const locations = storePathsV2(paths);
          if (materialized.handle !== null) {
            publishCanonicalCreateOnlyV2(
              paths,
              handleObjectPathV2(locations, materialized.handle.handleDigest),
              materialized.handle,
              MAX_V2_HANDLE_BYTES,
            );
          }
          publishCanonicalCreateOnlyV2(
            paths,
            completionObjectPathV2(
              locations,
              materialized.completion.completionDigest,
            ),
            materialized.completion,
            MAX_V2_OBJECT_BYTES,
          );
          publishCanonicalCreateOnlyV2(
            paths,
            completionRefPathV2(
              locations,
              current.scope.scopeKey,
              turn.claim.turn,
            ),
            createCompletionRefV2(materialized.completion),
            MAX_V2_REF_BYTES,
          );
          const published = readChainForScopeV2(paths, current);
          const completion = published.turns[turnIndex]?.completion;
          if (
            completion?.completionDigest !==
            materialized.completion.completionDigest
          ) {
            throw storeInvalid();
          }
          return completion;
        });
      }),
  );
}

/**
 * Recovery-aware internal V2 read. It acquires the scope lock, revalidates all
 * live assignment sources, and may repair an exact publication window. Use the
 * explicitly non-authorizing diagnostic below for operationally zero-write
 * historical observation.
 */
export function readProviderNativeSessionChainV2(
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
): ProviderNativeSessionChainV2 {
  const identity = assertChainIdentity({
    changeId: requestedChangeId,
    planningGeneration: requestedPlanningGeneration,
    assignmentRecordDigest: requestedAssignmentRecordDigest,
    sessionSlotId: requestedSessionSlotId,
  });
  const observed = loadScopeWithRoles(
    paths,
    identity,
    verifyCentralSnapshot,
    verifyChangeOverrideSnapshot,
    verifyHostConfiguration,
    verifyProviderRegistry,
    verifyDataAuthorization,
    verifySessionCapability,
    verifyProtectedContext,
  );
  return withScopeLock(paths, observed.scope, () => {
    const current = assertCurrentScopeWithRoles(
      paths,
      identity,
      observed,
      verifyCentralSnapshot,
      verifyChangeOverrideSnapshot,
      verifyHostConfiguration,
      verifyProviderRegistry,
      verifyDataAuthorization,
      verifySessionCapability,
      verifyProtectedContext,
    );
    return readChainForScopeV2(paths, current);
  });
}

/**
 * Observe immutable historical V2 evidence from a store-owned structurally
 * validated assignment. It performs no locks, recovery, verifier callbacks,
 * or writes and cannot authorize any transition.
 */
export function inspectProviderNativeSessionChainV2(
  paths: InvestigationRuntimePaths,
  requestedChangeId: string,
  requestedPlanningGeneration: string,
  requestedAssignmentRecordDigest: string,
  requestedSessionSlotId: string,
): ProviderNativeSessionHistoricalDiagnosticV2 {
  const identity = assertChainIdentity({
    changeId: requestedChangeId,
    planningGeneration: requestedPlanningGeneration,
    assignmentRecordDigest: requestedAssignmentRecordDigest,
    sessionSlotId: requestedSessionSlotId,
  });
  const assignmentObservation = inspectHistoricalChangeRoleAssignmentRecordV1(
    paths,
    identity.changeId,
    identity.planningGeneration,
  );
  if (assignmentObservation === null) throw storeInvalid();
  if (
    assignmentObservation.record.recordDigest !==
    identity.assignmentRecordDigest
  ) {
    throw storeConflict();
  }
  const observed = projectScopeWithRoles(
    assignmentObservation.record,
    identity.sessionSlotId,
  );
  const locations = storePathsV2(paths);
  const recoveryBefore = readV2RecoveryDirectorySnapshot(paths, locations);
  const chain = readChainForScopeV2(paths, observed, false);
  const recoveryAfter = readV2RecoveryDirectorySnapshot(paths, locations);
  assertSameV2RecoveryDirectorySnapshot(recoveryBefore, recoveryAfter);
  return deepFreeze({
    schemaVersion: 2 as const,
    kind: 'provider-native-session-historical-diagnostic.v2' as const,
    outcome:
      chain.state === 'empty' ? ('absent' as const) : ('inspected' as const),
    authorityEligible: false as const,
    transitionEligible: false as const,
    operationalWrites: false as const,
    recoveryPerformed: false as const,
    assignmentAssurance: 'store-owned-structural-record' as const,
    attemptCurrentness: 'not-observed' as const,
    publicationRecovery: 'not-applied' as const,
    chain,
  });
}

type ProviderNativeSessionObservedScopeV2 = Readonly<{
  scope: ProviderNativeSessionScopeV1;
  roleLanes: readonly ('author' | 'builder' | 'reviewer')[];
  assignmentProjection: Readonly<{
    assignmentDigest: string;
    dataAuthorizationPolicyDigest: string;
    inputManifestDigest: string;
    relevantTargetDigest: string;
    providerFamily: string;
  }>;
}>;

function withNativeTurnCurrentFence<T>(
  port: ProviderNativeTurnCurrentnessVerifierPort,
  query: ProviderNativeTurnCurrentnessQueryV1,
  operation: (binding: ProviderNativeTurnBindingV1) => T,
): T {
  if (
    !isRecord(port) ||
    typeof port.withCurrentFence !== 'function' ||
    typeof operation !== 'function'
  ) {
    throw storeInvalid();
  }
  let callbackCount = 0;
  const result = port.withCurrentFence(query, (candidate) => {
    callbackCount += 1;
    if (callbackCount !== 1) throw storeInvalid();
    let binding: ProviderNativeTurnBindingV1;
    try {
      binding = assertProviderNativeTurnBindingV1(candidate);
    } catch {
      throw storeInvalid();
    }
    assertTurnBindingMatchesCurrentnessQuery(binding, query);
    return operation(binding);
  });
  if (callbackCount !== 1 || isPromiseLike(result)) throw storeInvalid();
  return result;
}

function createCurrentnessQueryV2(
  input:
    | ClaimProviderNativeSessionTurnInputV2
    | CompleteProviderNativeSessionTurnInputV2,
): ProviderNativeTurnCurrentnessQueryV1 {
  return deepFreeze({
    schemaVersion: 1 as const,
    kind: 'provider-native-turn-currentness-query.v1' as const,
    changeId: input.changeId,
    planningGeneration: input.planningGeneration,
    assignmentRecordDigest: input.assignmentRecordDigest,
    sessionSlotId: input.sessionSlotId,
    invocationId: input.invocationId,
    workflowId: input.workflowId,
    jobId: input.jobId,
    attemptId: input.attemptId,
    leaseGeneration: input.leaseGeneration,
    leaseToken: input.leaseToken,
  });
}

function assertTurnBindingMatchesCurrentnessQuery(
  binding: ProviderNativeTurnBindingV1,
  query: ProviderNativeTurnCurrentnessQueryV1,
): void {
  if (
    binding.assignment.changeId !== query.changeId ||
    binding.assignment.planningGeneration !== query.planningGeneration ||
    binding.assignment.assignmentRecordDigest !==
      query.assignmentRecordDigest ||
    binding.assignment.sessionSlotId !== query.sessionSlotId ||
    binding.invocation.invocationId !== query.invocationId ||
    binding.invocation.ownerWorkflowId !== query.workflowId ||
    binding.execution.workflowId !== query.workflowId ||
    binding.execution.jobId !== query.jobId ||
    binding.execution.attemptId !== query.attemptId ||
    binding.execution.leaseGeneration !== query.leaseGeneration ||
    binding.execution.leaseTokenDigest !== `sha256:${sha256(query.leaseToken)}`
  ) {
    throw storeConflict();
  }
}

function withAttemptIdentityLock<T>(
  paths: InvestigationRuntimePaths,
  requestedAttemptIdentityDigest: string,
  operation: () => T,
): T {
  return withPrivateRuntimeLock(
    paths,
    path.join(
      paths.locks,
      'provider-native-sessions',
      'v2',
      'attempts',
      `${assertDigest(requestedAttemptIdentityDigest)}.lock`,
    ),
    operation,
    'PROVIDER_NATIVE_SESSION_STORE_OPERATION_CONFLICT',
    storeInvalid,
  );
}

function loadScopeWithRoles(
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
): ProviderNativeSessionObservedScopeV2 {
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
  return projectScopeWithRoles(assignment, input.sessionSlotId);
}

function projectScopeWithRoles(
  assignment: ChangeRoleAssignmentRecordV1,
  sessionSlotId: string,
): ProviderNativeSessionObservedScopeV2 {
  const scope = deriveProviderNativeSessionScopeV1(assignment, sessionSlotId);
  const slot = assignment.sessionSlots.find(
    ({ sessionSlotId }) => sessionSlotId === scope.sessionSlotId,
  );
  if (slot === undefined) throw storeInvalid();
  const selectedProfile = assignment.host.configuration.providers.find(
    ({ id }) => id === scope.profileId,
  );
  const inputManifestDigest =
    assignment.dataAuthorization.snapshot.inputManifestDigest;
  const relevantTargetDigest =
    assignment.dataAuthorization.snapshot.relevantTargetDigest;
  if (
    selectedProfile === undefined ||
    inputManifestDigest === null ||
    relevantTargetDigest === null
  ) {
    throw storeInvalid();
  }
  return deepFreeze({
    scope,
    roleLanes: [...slot.roles],
    assignmentProjection: {
      assignmentDigest: assignment.assignmentDigest,
      dataAuthorizationPolicyDigest:
        assignment.dataAuthorization.snapshot.policyDigest,
      inputManifestDigest,
      relevantTargetDigest,
      providerFamily: selectedProfile.family,
    },
  });
}

function assertCurrentScopeWithRoles(
  paths: InvestigationRuntimePaths,
  input: Readonly<{
    changeId: string;
    planningGeneration: string;
    assignmentRecordDigest: string;
    sessionSlotId: string;
  }>,
  expected: ProviderNativeSessionObservedScopeV2,
  verifyCentralSnapshot: CentralRoleProviderDefaultSnapshotVerifierPort,
  verifyChangeOverrideSnapshot: AgentRolePlanV2SnapshotVerifierPort,
  verifyHostConfiguration: ChangeRoleAssignmentHostConfigurationVerifierPort,
  verifyProviderRegistry: ChangeRoleAssignmentProviderRegistryVerifierPort,
  verifyDataAuthorization: ChangeRoleAssignmentDataAuthorizationVerifierPort,
  verifySessionCapability: ChangeRoleAssignmentSessionCapabilityVerifierPort,
  verifyProtectedContext: ChangeRoleAssignmentProtectedContextVerifierPort,
): ProviderNativeSessionObservedScopeV2 {
  const current = loadScopeWithRoles(
    paths,
    input,
    verifyCentralSnapshot,
    verifyChangeOverrideSnapshot,
    verifyHostConfiguration,
    verifyProviderRegistry,
    verifyDataAuthorization,
    verifySessionCapability,
    verifyProtectedContext,
  );
  if (canonicalJson(current) !== canonicalJson(expected)) {
    throw storeInvalid();
  }
  return current;
}

function assertTurnBindingMatchesObservedScope(
  binding: ProviderNativeTurnBindingV1,
  observed: ProviderNativeSessionObservedScopeV2,
): void {
  const scope = observed.scope;
  const assignmentProjection = observed.assignmentProjection;
  if (
    binding.assignment.changeId !== scope.changeId ||
    binding.assignment.planningGeneration !== scope.planningGeneration ||
    binding.assignment.assignmentRecordDigest !==
      scope.assignmentRecordDigest ||
    binding.assignment.assignmentDigest !==
      assignmentProjection.assignmentDigest ||
    binding.assignment.resolutionDigest !== scope.resolutionDigest ||
    binding.assignment.dataAuthorizationPolicyDigest !==
      assignmentProjection.dataAuthorizationPolicyDigest ||
    binding.assignment.inputManifestDigest !==
      assignmentProjection.inputManifestDigest ||
    binding.assignment.relevantTargetDigest !==
      assignmentProjection.relevantTargetDigest ||
    binding.assignment.sessionSlotId !== scope.sessionSlotId ||
    !observed.roleLanes.includes(binding.assignment.roleLane) ||
    binding.assignment.logicalProviderId !== scope.logicalProviderId ||
    binding.assignment.profileId !== scope.profileId ||
    binding.assignment.profileDigest !== scope.profileDigest ||
    binding.assignment.providerFamily !== assignmentProjection.providerFamily ||
    binding.assignment.providerDefinitionDigest !==
      scope.providerDefinitionDigest
  ) {
    throw storeConflict();
  }
}

function isBindingContinuation(
  claimed: ProviderNativeTurnBindingV1,
  current: ProviderNativeTurnBindingV1,
): boolean {
  try {
    assertProviderNativeTurnBindingContinuationV1(claimed, current);
    return true;
  } catch {
    return false;
  }
}

function readChainForScopeV2(
  paths: InvestigationRuntimePaths,
  observed: ProviderNativeSessionObservedScopeV2,
  recoverPublication = true,
): ProviderNativeSessionChainV2 {
  const locations = storePathsV2(paths);
  const scope = observed.scope;
  const beforeNames = readRefNamesV2(paths, locations, scope.scopeKey);
  if (beforeNames.length === 0) return createChainV2(scope, []);

  const claims = new Set<number>();
  const completions = new Set<number>();
  for (const name of beforeNames) {
    const match = V2_TURN_REF.exec(name);
    if (match === null) throw storeInvalid();
    const turn = Number(match[1]);
    if (turn !== 1) throw storeInvalid();
    (match[2] === 'claim' ? claims : completions).add(turn);
  }
  if (!claims.has(1) || claims.size !== 1 || completions.size > 1) {
    throw storeInvalid();
  }
  const claim = readClaimV2(paths, locations, observed, 1, recoverPublication);
  assertAttemptClaimIndexV2(paths, claim, recoverPublication);
  const completion = completions.has(1)
    ? readCompletionV2(paths, locations, observed, claim, recoverPublication)
    : null;
  if (completion?.usable === true) {
    readHandleForCompletionV2(paths, completion, recoverPublication);
  }
  const turns = [{ claim, completion }];
  const afterNames = readRefNamesV2(paths, locations, scope.scopeKey);
  if (canonicalJson(beforeNames) !== canonicalJson(afterNames)) {
    throw storeOperationConflict();
  }
  return createChainV2(scope, turns);
}

function createChainV2(
  scope: ProviderNativeSessionScopeV1,
  turns: readonly Readonly<{
    claim: ProviderNativeSessionClaimV2;
    completion: ProviderNativeSessionCompletionV2 | null;
  }>[],
): ProviderNativeSessionChainV2 {
  const last = turns.at(-1)?.completion;
  const state =
    turns.length === 0
      ? ('empty' as const)
      : last === undefined || last === null
        ? ('claimed' as const)
        : last.usable
          ? ('resumable' as const)
          : ('terminal-unusable' as const);
  return deepFreeze({
    schemaVersion: 2 as const,
    kind: 'provider-native-session-chain.v2' as const,
    scope,
    state,
    turns: turns.map(({ claim, completion }) => ({ claim, completion })),
  });
}

function readClaimV2(
  paths: InvestigationRuntimePaths,
  locations: ReturnType<typeof storePathsV2>,
  observed: ProviderNativeSessionObservedScopeV2,
  turn: number,
  recoverPublication: boolean,
): ProviderNativeSessionClaimV2 {
  const refPath = claimRefPathV2(locations, observed.scope.scopeKey, turn);
  if (recoverPublication) {
    recoverV2PublicationTarget(paths, refPath, MAX_V2_REF_BYTES);
  }
  const before = readBoundedCanonicalSnapshot(paths, refPath, MAX_V2_REF_BYTES);
  const ref = assertClaimRefV2(before.value, observed.scope.scopeKey, turn);
  const objectPath = claimObjectPathV2(locations, ref.claimDigest);
  if (recoverPublication) {
    recoverV2PublicationTarget(paths, objectPath, MAX_V2_OBJECT_BYTES);
  }
  const claim = assertProviderNativeSessionClaimV2(
    readBoundedCanonicalJson(paths, objectPath, MAX_V2_OBJECT_BYTES),
  );
  if (
    claim.scope.scopeKey !== observed.scope.scopeKey ||
    canonicalJson(claim.scope) !== canonicalJson(observed.scope) ||
    claim.turn !== turn ||
    claim.claimDigest !== ref.claimDigest
  ) {
    throw storeInvalid();
  }
  assertTurnBindingMatchesObservedScope(claim.turnBinding, observed);
  assertRefUnchanged(paths, refPath, before, MAX_V2_REF_BYTES);
  return claim;
}

function readCompletionV2(
  paths: InvestigationRuntimePaths,
  locations: ReturnType<typeof storePathsV2>,
  observed: ProviderNativeSessionObservedScopeV2,
  claim: ProviderNativeSessionClaimV2,
  recoverPublication: boolean,
): ProviderNativeSessionCompletionV2 {
  const refPath = completionRefPathV2(
    locations,
    observed.scope.scopeKey,
    claim.turn,
  );
  if (recoverPublication) {
    recoverV2PublicationTarget(paths, refPath, MAX_V2_REF_BYTES);
  }
  const before = readBoundedCanonicalSnapshot(paths, refPath, MAX_V2_REF_BYTES);
  const ref = assertCompletionRefV2(
    before.value,
    observed.scope.scopeKey,
    claim.turn,
    claim.claimDigest,
  );
  const objectPath = completionObjectPathV2(locations, ref.completionDigest);
  if (recoverPublication) {
    recoverV2PublicationTarget(paths, objectPath, MAX_V2_OBJECT_BYTES);
  }
  const completion = assertProviderNativeSessionCompletionV2(
    readBoundedCanonicalJson(paths, objectPath, MAX_V2_OBJECT_BYTES),
  );
  if (
    completion.scope.scopeKey !== observed.scope.scopeKey ||
    canonicalJson(completion.scope) !== canonicalJson(observed.scope) ||
    completion.turn !== claim.turn ||
    completion.claimDigest !== claim.claimDigest ||
    completion.action !== claim.action ||
    completion.predecessorCompletionDigest !==
      claim.predecessorCompletionDigest ||
    !isBindingContinuation(claim.turnBinding, completion.turnBinding) ||
    completion.completionDigest !== ref.completionDigest
  ) {
    throw storeInvalid();
  }
  assertTurnBindingMatchesObservedScope(completion.turnBinding, observed);
  assertRefUnchanged(paths, refPath, before, MAX_V2_REF_BYTES);
  return completion;
}

function readHandleForCompletionV2(
  paths: InvestigationRuntimePaths,
  completion: ProviderNativeSessionCompletionV2,
  recoverPublication: boolean,
): ProviderNativeSessionHandleV2 {
  if (
    completion.usable !== true ||
    completion.handleDigest === null ||
    completion.nativeSessionIdDigest === null
  ) {
    throw storeInvalid();
  }
  const filePath = handleObjectPathV2(
    storePathsV2(paths),
    completion.handleDigest,
  );
  if (recoverPublication) {
    recoverV2PublicationTarget(paths, filePath, MAX_V2_HANDLE_BYTES);
  }
  return assertProviderNativeSessionHandleV2(
    readBoundedCanonicalJson(paths, filePath, MAX_V2_HANDLE_BYTES),
    { completion, handleDigest: completion.handleDigest },
  );
}

function storePathsV2(paths: InvestigationRuntimePaths) {
  const root = path.join(paths.root, 'provider-native-sessions', 'v2');
  return Object.freeze({
    root,
    claims: path.join(root, 'claims', 'sha256'),
    completions: path.join(root, 'completions', 'sha256'),
    handles: path.join(root, 'handles', 'sha256'),
    chains: path.join(root, 'chains', 'sha256'),
    attempts: path.join(root, 'attempts', 'sha256'),
    recovery: path.join(root, 'recovery', 'sha256'),
  });
}

function readV2RecoveryDirectorySnapshot(
  paths: InvestigationRuntimePaths,
  locations: ReturnType<typeof storePathsV2>,
): V2RecoveryDirectorySnapshot {
  const directory = locations.recovery;
  const before = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (before === undefined) {
    // This is an optimistic ordinary-writer observation, not a hostile
    // namespace fence. The result remains explicitly non-authorizing.
    assertPrivateInvestigationDirectory(
      paths,
      path.dirname(directory),
      storeInvalid,
    );
    if (fs.lstatSync(directory, { throwIfNoEntry: false }) !== undefined) {
      throw storeOperationConflict();
    }
    return Object.freeze({ identity: null, names: Object.freeze([]) });
  }
  assertPrivateInvestigationDirectory(paths, directory, storeInvalid);
  const firstName = readFirstDirectoryName(directory);
  if (firstName !== null) {
    if (/^[0-9a-f]{64}\.publish\.tmp$/u.test(firstName)) {
      throw storeOperationConflict();
    }
    throw storeInvalid();
  }
  const after = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (after === undefined || !sameStableFile(before, after)) {
    throw storeOperationConflict();
  }
  return Object.freeze({ identity: before, names: Object.freeze([]) });
}

function assertSameV2RecoveryDirectorySnapshot(
  before: V2RecoveryDirectorySnapshot,
  after: V2RecoveryDirectorySnapshot,
): void {
  if (
    (before.identity === null) !== (after.identity === null) ||
    (before.identity !== null &&
      after.identity !== null &&
      !sameStableFile(before.identity, after.identity)) ||
    canonicalJson(before.names) !== canonicalJson(after.names)
  ) {
    throw storeOperationConflict();
  }
}

function readFirstDirectoryName(directory: string): string | null {
  let handle: fs.Dir | undefined;
  let operationError: Error | null = null;
  let name: string | null = null;
  try {
    handle = fs.opendirSync(directory);
    name = handle.readSync()?.name ?? null;
  } catch (error) {
    operationError = normalizePublicationOperationError(error);
  }
  let cleanupError: Error | null = null;
  if (handle !== undefined) {
    try {
      handle.closeSync();
    } catch {
      cleanupError = storeInvalid();
    }
  }
  if (operationError !== null) throw operationError;
  if (cleanupError !== null) throw cleanupError;
  return name;
}

function claimObjectPathV2(
  locations: ReturnType<typeof storePathsV2>,
  digest: string,
): string {
  return path.join(locations.claims, `${assertDigest(digest)}.claim.json`);
}

function completionObjectPathV2(
  locations: ReturnType<typeof storePathsV2>,
  digest: string,
): string {
  return path.join(
    locations.completions,
    `${assertDigest(digest)}.completion.json`,
  );
}

function handleObjectPathV2(
  locations: ReturnType<typeof storePathsV2>,
  digest: string,
): string {
  return path.join(locations.handles, `${assertDigest(digest)}.handle.json`);
}

function chainDirectoryV2(
  locations: ReturnType<typeof storePathsV2>,
  scopeKey: string,
): string {
  return path.join(locations.chains, assertDigest(scopeKey));
}

function claimRefPathV2(
  locations: ReturnType<typeof storePathsV2>,
  scopeKey: string,
  turn: number,
): string {
  return path.join(
    chainDirectoryV2(locations, scopeKey),
    `${turnName(turn)}.claim-ref.json`,
  );
}

function completionRefPathV2(
  locations: ReturnType<typeof storePathsV2>,
  scopeKey: string,
  turn: number,
): string {
  return path.join(
    chainDirectoryV2(locations, scopeKey),
    `${turnName(turn)}.completion-ref.json`,
  );
}

function attemptClaimRefPathV2(
  locations: ReturnType<typeof storePathsV2>,
  attemptIdentityDigest: string,
): string {
  return path.join(
    locations.attempts,
    `${assertDigest(attemptIdentityDigest)}.claim-ref.json`,
  );
}

function createClaimRefV2(
  claim: ProviderNativeSessionClaimV2,
): ProviderNativeSessionClaimRefV2 {
  return Object.freeze({
    schemaVersion: 2,
    kind: 'provider-native-session-claim-ref.v2',
    scopeKey: claim.scope.scopeKey,
    turn: claim.turn,
    claimDigest: claim.claimDigest,
  });
}

function createCompletionRefV2(
  completion: ProviderNativeSessionCompletionV2,
): ProviderNativeSessionCompletionRefV2 {
  return Object.freeze({
    schemaVersion: 2,
    kind: 'provider-native-session-completion-ref.v2',
    scopeKey: completion.scope.scopeKey,
    turn: completion.turn,
    claimDigest: completion.claimDigest,
    completionDigest: completion.completionDigest,
  });
}

function createAttemptClaimRefV2(
  claim: ProviderNativeSessionClaimV2,
): ProviderNativeSessionAttemptClaimRefV2 {
  return Object.freeze({
    schemaVersion: 2,
    kind: 'provider-native-session-attempt-claim-ref.v2',
    attemptIdentityDigest: claim.turnBinding.attemptIdentityDigest,
    scopeKey: claim.scope.scopeKey,
    turn: claim.turn,
    claimDigest: claim.claimDigest,
    turnBindingDigest: claim.turnBinding.turnBindingDigest,
  });
}

function assertClaimRefV2(
  value: unknown,
  scopeKey: string,
  turn: number,
): ProviderNativeSessionClaimRefV2 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'scopeKey',
      'turn',
      'claimDigest',
    ]) ||
    value.schemaVersion !== 2 ||
    value.kind !== 'provider-native-session-claim-ref.v2' ||
    value.scopeKey !== scopeKey ||
    value.turn !== turn ||
    !isDigest(value.claimDigest)
  ) {
    throw storeInvalid();
  }
  return Object.freeze({
    schemaVersion: 2,
    kind: 'provider-native-session-claim-ref.v2',
    scopeKey,
    turn,
    claimDigest: value.claimDigest,
  });
}

function assertCompletionRefV2(
  value: unknown,
  scopeKey: string,
  turn: number,
  claimDigest: string,
): ProviderNativeSessionCompletionRefV2 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'scopeKey',
      'turn',
      'claimDigest',
      'completionDigest',
    ]) ||
    value.schemaVersion !== 2 ||
    value.kind !== 'provider-native-session-completion-ref.v2' ||
    value.scopeKey !== scopeKey ||
    value.turn !== turn ||
    value.claimDigest !== claimDigest ||
    !isDigest(value.completionDigest)
  ) {
    throw storeInvalid();
  }
  return Object.freeze({
    schemaVersion: 2,
    kind: 'provider-native-session-completion-ref.v2',
    scopeKey,
    turn,
    claimDigest,
    completionDigest: value.completionDigest,
  });
}

function assertAttemptClaimRefV2(
  value: unknown,
  attemptIdentityDigest: string,
): ProviderNativeSessionAttemptClaimRefV2 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'attemptIdentityDigest',
      'scopeKey',
      'turn',
      'claimDigest',
      'turnBindingDigest',
    ]) ||
    value.schemaVersion !== 2 ||
    value.kind !== 'provider-native-session-attempt-claim-ref.v2' ||
    value.attemptIdentityDigest !== attemptIdentityDigest ||
    !isDigest(value.scopeKey) ||
    value.turn !== 1 ||
    !isDigest(value.claimDigest) ||
    !isDigest(value.turnBindingDigest)
  ) {
    throw storeInvalid();
  }
  return Object.freeze({
    schemaVersion: 2,
    kind: 'provider-native-session-attempt-claim-ref.v2',
    attemptIdentityDigest,
    scopeKey: value.scopeKey,
    turn: 1,
    claimDigest: value.claimDigest,
    turnBindingDigest: value.turnBindingDigest,
  });
}

function readAttemptClaimIndexV2(
  paths: InvestigationRuntimePaths,
  attemptIdentityDigest: string,
  recoverPublication = true,
): ProviderNativeSessionAttemptClaimRefV2 | null {
  const filePath = attemptClaimRefPathV2(
    storePathsV2(paths),
    attemptIdentityDigest,
  );
  if (recoverPublication) {
    recoverV2PublicationTarget(paths, filePath, MAX_V2_REF_BYTES);
  }
  if (fs.lstatSync(filePath, { throwIfNoEntry: false }) === undefined) {
    return null;
  }
  const before = readBoundedCanonicalSnapshot(
    paths,
    filePath,
    MAX_V2_REF_BYTES,
  );
  const ref = assertAttemptClaimRefV2(before.value, attemptIdentityDigest);
  assertRefUnchanged(paths, filePath, before, MAX_V2_REF_BYTES);
  return ref;
}

function readIndexedClaimV2(
  paths: InvestigationRuntimePaths,
  ref: ProviderNativeSessionAttemptClaimRefV2,
): ProviderNativeSessionClaimV2 {
  const filePath = claimObjectPathV2(storePathsV2(paths), ref.claimDigest);
  recoverV2PublicationTarget(paths, filePath, MAX_V2_OBJECT_BYTES);
  const claim = assertProviderNativeSessionClaimV2(
    readBoundedCanonicalJson(paths, filePath, MAX_V2_OBJECT_BYTES),
  );
  if (
    claim.claimDigest !== ref.claimDigest ||
    claim.scope.scopeKey !== ref.scopeKey ||
    claim.turn !== ref.turn ||
    claim.turnBinding.attemptIdentityDigest !== ref.attemptIdentityDigest ||
    claim.turnBinding.turnBindingDigest !== ref.turnBindingDigest
  ) {
    throw storeInvalid();
  }
  return claim;
}

function assertAttemptClaimIndexV2(
  paths: InvestigationRuntimePaths,
  claim: ProviderNativeSessionClaimV2,
  recoverPublication = true,
): void {
  const ref = readAttemptClaimIndexV2(
    paths,
    claim.turnBinding.attemptIdentityDigest,
    recoverPublication,
  );
  if (
    ref === null ||
    canonicalJson(ref) !== canonicalJson(createAttemptClaimRefV2(claim))
  ) {
    throw storeInvalid();
  }
}

function readRefNamesV2(
  paths: InvestigationRuntimePaths,
  locations: ReturnType<typeof storePathsV2>,
  scopeKey: string,
): readonly string[] {
  const directory = chainDirectoryV2(locations, scopeKey);
  const before = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (before === undefined) return Object.freeze([]);
  assertPrivateInvestigationDirectory(paths, directory, storeInvalid);
  const names = readBoundedProviderDirectoryNames(directory, 2);
  const after = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (
    after === undefined ||
    !before.isDirectory() ||
    before.isSymbolicLink() ||
    (before.mode & 0o777) !== 0o700 ||
    !sameStableFile(before, after) ||
    names.length > 2
  ) {
    throw storeInvalid();
  }
  return Object.freeze(names);
}

function readBoundedProviderDirectoryNames(
  directory: string,
  maximumEntries: number,
): string[] {
  let handle: fs.Dir | undefined;
  let operationError: Error | null = null;
  const names: string[] = [];
  try {
    handle = fs.opendirSync(directory);
    for (;;) {
      const entry = handle.readSync();
      if (entry === null) break;
      names.push(entry.name);
      if (names.length > maximumEntries) throw storeInvalid();
    }
  } catch (error) {
    operationError = normalizePublicationOperationError(error);
  }
  let cleanupError: Error | null = null;
  if (handle !== undefined) {
    try {
      handle.closeSync();
    } catch {
      cleanupError = storeInvalid();
    }
  }
  if (operationError !== null) throw operationError;
  if (cleanupError !== null) throw cleanupError;
  return names.sort(compareCodeUnits);
}

function v2PublicationRecoveryTarget(
  locations: ReturnType<typeof storePathsV2>,
  requestedFilePath: string,
): V2PublicationRecoveryTarget {
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
  const objectDefinitions = {
    claims: {
      suffix: '.claim.json',
      kind: 'claim' as const,
      maxBytes: MAX_V2_OBJECT_BYTES,
    },
    completions: {
      suffix: '.completion.json',
      kind: 'completion' as const,
      maxBytes: MAX_V2_OBJECT_BYTES,
    },
    handles: {
      suffix: '.handle.json',
      kind: 'handle' as const,
      maxBytes: MAX_V2_HANDLE_BYTES,
    },
  };
  if (
    parts.length === 3 &&
    parts[1] === 'sha256' &&
    Object.hasOwn(objectDefinitions, parts[0]!)
  ) {
    const definition =
      objectDefinitions[parts[0] as keyof typeof objectDefinitions];
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
      scopeKey: null,
      turn: null,
    });
  }
  if (
    parts.length === 4 &&
    parts[0] === 'chains' &&
    parts[1] === 'sha256' &&
    isDigest(parts[2])
  ) {
    const match = V2_TURN_REF.exec(parts[3]!);
    if (match === null || Number(match[1]) !== 1) throw storeInvalid();
    return Object.freeze({
      filePath,
      relativePath,
      maxBytes: MAX_V2_REF_BYTES,
      kind: match[2] === 'claim' ? 'claim-ref' : 'completion-ref',
      digest: null,
      scopeKey: parts[2]!,
      turn: 1,
    });
  }
  if (
    parts.length === 3 &&
    parts[0] === 'attempts' &&
    parts[1] === 'sha256' &&
    parts[2]!.endsWith('.claim-ref.json')
  ) {
    const digest = parts[2]!.slice(0, -'.claim-ref.json'.length);
    if (!isDigest(digest)) throw storeInvalid();
    return Object.freeze({
      filePath,
      relativePath,
      maxBytes: MAX_V2_REF_BYTES,
      kind: 'attempt-claim-ref',
      digest,
      scopeKey: null,
      turn: null,
    });
  }
  throw storeInvalid();
}

function v2PublicationTemporaryPath(
  locations: ReturnType<typeof storePathsV2>,
  target: V2PublicationRecoveryTarget,
): string {
  return path.join(
    locations.recovery,
    `${sha256(target.relativePath)}.publish.tmp`,
  );
}

function assertV2PublicationRecoveryValue(
  value: unknown,
  target: V2PublicationRecoveryTarget,
): void {
  try {
    if (target.kind === 'claim') {
      const claim = assertProviderNativeSessionClaimV2(value);
      if (claim.claimDigest !== target.digest) throw storeInvalid();
      return;
    }
    if (target.kind === 'completion') {
      const completion = assertProviderNativeSessionCompletionV2(value);
      if (completion.completionDigest !== target.digest) throw storeInvalid();
      return;
    }
    if (target.kind === 'handle') {
      assertProviderNativeSessionHandleV2(value, {
        handleDigest: target.digest ?? undefined,
      });
      return;
    }
    if (target.kind === 'attempt-claim-ref') {
      assertAttemptClaimRefV2(value, target.digest!);
      return;
    }
    if (target.scopeKey === null || target.turn === null) throw storeInvalid();
    if (target.kind === 'claim-ref') {
      assertClaimRefV2(value, target.scopeKey, target.turn);
      return;
    }
    if (!isRecord(value) || !isDigest(value.claimDigest)) {
      throw storeInvalid();
    }
    assertCompletionRefV2(
      value,
      target.scopeKey,
      target.turn,
      value.claimDigest,
    );
  } catch {
    throw storeInvalid();
  }
}

function recoverV2PublicationTarget(
  paths: InvestigationRuntimePaths,
  filePath: string,
  maxBytes: number,
): void {
  const locations = storePathsV2(paths);
  const target = v2PublicationRecoveryTarget(locations, filePath);
  if (target.maxBytes !== maxBytes) throw storeInvalid();
  const recoveryDirectory = locations.recovery;
  if (
    fs.lstatSync(recoveryDirectory, { throwIfNoEntry: false }) === undefined
  ) {
    return;
  }
  assertPrivateInvestigationDirectory(paths, recoveryDirectory, storeInvalid);
  const temporaryPath = v2PublicationTemporaryPath(locations, target);
  if (fs.lstatSync(temporaryPath, { throwIfNoEntry: false }) === undefined) {
    return;
  }

  const targetBefore = fs.lstatSync(target.filePath, {
    throwIfNoEntry: false,
  });
  if (targetBefore === undefined) {
    assertDiscardableRecoveryTemporary(paths, temporaryPath, maxBytes);
    if (
      fs.lstatSync(target.filePath, { throwIfNoEntry: false }) !== undefined
    ) {
      throw storeInvalid();
    }
  } else {
    const temporary = readBoundedCanonicalSnapshotWithLinkCount(
      paths,
      temporaryPath,
      maxBytes,
      2,
    );
    assertV2PublicationRecoveryValue(temporary.value, target);
    assertPrivateFileStats(targetBefore, maxBytes, 2);
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
    fsyncDirectory(recoveryDirectory);
  } catch {
    throw storeInvalid();
  }
  if (targetBefore !== undefined) {
    const recovered = readBoundedCanonicalSnapshot(
      paths,
      target.filePath,
      maxBytes,
    );
    assertV2PublicationRecoveryValue(recovered.value, target);
  }
}

function publishCanonicalCreateOnlyV2(
  paths: InvestigationRuntimePaths,
  filePath: string,
  value: unknown,
  maxBytes: number,
): void {
  const content = Buffer.from(`${canonicalJson(value)}\n`, 'utf8');
  if (content.length === 0 || content.length > maxBytes) throw storeInvalid();
  const locations = storePathsV2(paths);
  const target = v2PublicationRecoveryTarget(locations, filePath);
  if (target.maxBytes !== maxBytes) throw storeInvalid();
  assertV2PublicationRecoveryValue(value, target);
  ensurePrivateInvestigationDirectory(
    paths,
    path.dirname(filePath),
    storeInvalid,
  );
  ensurePrivateInvestigationDirectory(paths, locations.recovery, storeInvalid);
  recoverV2PublicationTarget(paths, filePath, maxBytes);
  if (fs.lstatSync(filePath, { throwIfNoEntry: false }) !== undefined) {
    if (!readBoundedCanonicalBytes(paths, filePath, maxBytes).equals(content)) {
      throw storeConflict();
    }
    return;
  }

  const temporaryPath = v2PublicationTemporaryPath(locations, target);
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
    fsyncDirectory(locations.recovery);
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
    locations.recovery,
  );
  if (operationError !== null) throw operationError;
  if (cleanupError !== null) throw cleanupError;
  if (!readBoundedCanonicalBytes(paths, filePath, maxBytes).equals(content)) {
    throw storeInvalid();
  }
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
          claim.action !== 'resume' ||
          claim.predecessorCompletionDigest !== prior.completionDigest ||
          claim.expectedNativeSessionIdDigest !== prior.nativeSessionIdDigest))
    ) {
      throw storeInvalid();
    }
    const completion = completions.has(turn)
      ? readCompletion(paths, locations, scope, claim)
      : null;
    if (
      (completion === null && turn !== lastTurn) ||
      (completion?.usable === false && turn !== lastTurn)
    ) {
      throw storeInvalid();
    }
    if (completion?.usable === true) {
      readHandleForCompletion(paths, completion);
    }
    turns.push({ claim, completion });
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
  if (
    predecessor?.usable !== true ||
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
  }>[],
): ProviderNativeSessionChainV1 {
  const last = turns.at(-1)?.completion;
  const state =
    turns.length === 0
      ? ('empty' as const)
      : last === undefined || last === null
        ? ('claimed' as const)
        : last.usable
          ? ('resumable' as const)
          : ('terminal-unusable' as const);
  return deepFreeze({
    schemaVersion: 1 as const,
    kind: 'provider-native-session-chain.v1' as const,
    scope,
    state,
    turns: turns.map(({ claim, completion }) => ({ claim, completion })),
  });
}

function storePaths(paths: InvestigationRuntimePaths) {
  const root = path.join(paths.root, 'provider-native-sessions', 'v1');
  return Object.freeze({
    root,
    claims: path.join(root, 'claims', 'sha256'),
    completions: path.join(root, 'completions', 'sha256'),
    handles: path.join(root, 'handles', 'sha256'),
    chains: path.join(root, 'chains', 'sha256'),
    recovery: path.join(root, 'recovery', 'sha256'),
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

function claimObjectPath(
  locations: ReturnType<typeof storePaths>,
  digest: string,
): string {
  return path.join(locations.claims, `${assertDigest(digest)}.claim.json`);
}

function completionObjectPath(
  locations: ReturnType<typeof storePaths>,
  digest: string,
): string {
  return path.join(
    locations.completions,
    `${assertDigest(digest)}.completion.json`,
  );
}

function handleObjectPath(
  locations: ReturnType<typeof storePaths>,
  digest: string,
): string {
  return path.join(locations.handles, `${assertDigest(digest)}.handle.json`);
}

function chainDirectory(
  locations: ReturnType<typeof storePaths>,
  scopeKey: string,
): string {
  return path.join(locations.chains, assertDigest(scopeKey));
}

function claimRefPath(
  locations: ReturnType<typeof storePaths>,
  scopeKey: string,
  turn: number,
): string {
  return path.join(
    chainDirectory(locations, scopeKey),
    `${turnName(turn)}.claim-ref.json`,
  );
}

function completionRefPath(
  locations: ReturnType<typeof storePaths>,
  scopeKey: string,
  turn: number,
): string {
  return path.join(
    chainDirectory(locations, scopeKey),
    `${turnName(turn)}.completion-ref.json`,
  );
}

function turnName(turn: number): string {
  if (!Number.isSafeInteger(turn) || turn < 1 || turn > MAX_TURN) {
    throw storeInvalid();
  }
  return String(turn).padStart(5, '0');
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
  return Object.freeze({
    schemaVersion: 1,
    kind: 'provider-native-session-claim-ref.v1',
    scopeKey: claim.scope.scopeKey,
    turn: claim.turn,
    claimDigest: claim.claimDigest,
  });
}

function createCompletionRef(
  completion: ProviderNativeSessionCompletionV1,
): ProviderNativeSessionCompletionRefV1 {
  return Object.freeze({
    schemaVersion: 1,
    kind: 'provider-native-session-completion-ref.v1',
    scopeKey: completion.scope.scopeKey,
    turn: completion.turn,
    claimDigest: completion.claimDigest,
    completionDigest: completion.completionDigest,
  });
}

function assertClaimRef(
  value: unknown,
  scopeKey: string,
  turn: number,
): ProviderNativeSessionClaimRefV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'scopeKey',
      'turn',
      'claimDigest',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'provider-native-session-claim-ref.v1' ||
    value.scopeKey !== scopeKey ||
    value.turn !== turn ||
    !isDigest(value.claimDigest)
  ) {
    throw storeInvalid();
  }
  return createClaimRef({
    scope: { scopeKey } as ProviderNativeSessionScopeV1,
    turn,
    claimDigest: value.claimDigest,
  } as ProviderNativeSessionClaimV1);
}

function assertCompletionRef(
  value: unknown,
  scopeKey: string,
  turn: number,
  claimDigest: string,
): ProviderNativeSessionCompletionRefV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'scopeKey',
      'turn',
      'claimDigest',
      'completionDigest',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'provider-native-session-completion-ref.v1' ||
    value.scopeKey !== scopeKey ||
    value.turn !== turn ||
    value.claimDigest !== claimDigest ||
    !isDigest(value.completionDigest)
  ) {
    throw storeInvalid();
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: 'provider-native-session-completion-ref.v1',
    scopeKey,
    turn,
    claimDigest,
    completionDigest: value.completionDigest,
  });
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

function assertClaimInputV2(
  value: unknown,
): ClaimProviderNativeSessionTurnInputV2 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'changeId',
      'planningGeneration',
      'assignmentRecordDigest',
      'sessionSlotId',
      'predecessorCompletionDigest',
      'invocationId',
      'workflowId',
      'jobId',
      'attemptId',
      'leaseGeneration',
      'leaseToken',
    ]) ||
    !isChangeId(value.changeId) ||
    !isDigest(value.planningGeneration) ||
    !isDigest(value.assignmentRecordDigest) ||
    !isSessionSlotId(value.sessionSlotId) ||
    value.predecessorCompletionDigest !== null ||
    !isBindingIdentifier(value.invocationId) ||
    !isBindingIdentifier(value.workflowId) ||
    !isBindingIdentifier(value.jobId) ||
    !isBindingIdentifier(value.attemptId) ||
    !Number.isSafeInteger(value.leaseGeneration) ||
    (value.leaseGeneration as number) < 1 ||
    !isLeaseToken(value.leaseToken)
  ) {
    throw storeInvalid();
  }
  return deepFreeze(
    structuredClone(value) as unknown as ClaimProviderNativeSessionTurnInputV2,
  );
}

function assertCompletionInputV2(
  value: unknown,
): CompleteProviderNativeSessionTurnInputV2 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'changeId',
      'planningGeneration',
      'assignmentRecordDigest',
      'sessionSlotId',
      'claimDigest',
      'invocationId',
      'workflowId',
      'jobId',
      'attemptId',
      'leaseGeneration',
      'leaseToken',
      'terminal',
    ]) ||
    !isChangeId(value.changeId) ||
    !isDigest(value.planningGeneration) ||
    !isDigest(value.assignmentRecordDigest) ||
    !isSessionSlotId(value.sessionSlotId) ||
    !isDigest(value.claimDigest) ||
    !isBindingIdentifier(value.invocationId) ||
    !isBindingIdentifier(value.workflowId) ||
    !isBindingIdentifier(value.jobId) ||
    !isBindingIdentifier(value.attemptId) ||
    !Number.isSafeInteger(value.leaseGeneration) ||
    (value.leaseGeneration as number) < 1 ||
    !isLeaseToken(value.leaseToken) ||
    !isRecord(value.terminal)
  ) {
    throw storeInvalid();
  }
  return deepFreeze(
    structuredClone(
      value,
    ) as unknown as CompleteProviderNativeSessionTurnInputV2,
  );
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

function isLeaseToken(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 8 &&
    Buffer.byteLength(value, 'utf8') <= 512
  );
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

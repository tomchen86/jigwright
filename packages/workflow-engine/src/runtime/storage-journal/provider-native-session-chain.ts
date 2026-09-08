/**
 * Rebuilds native session chains under current assignment and runtime receipt authority.
 *
 * Invariants:
 * - Turns remain contiguous and every continuation matches its predecessor.
 * - Scope verification and the scope lock preserve their original boundaries.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { ProviderWrapperSessionProtocolBinding } from '@jigwright/agent-runtime';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import {
  type ProviderNativeSessionContinuationAuthorityV1,
  assertProviderNativeSessionContinuationAuthorityV1,
} from '../../modules/provider-orchestration/agent-runtime-durable-authority.ts';
import type { AgentRolePlanV2SnapshotVerifierPort } from '../../modules/provider-orchestration/agent-role-plan.ts';
import type {
  ChangeRoleAssignmentDataAuthorizationVerifierPort,
  ChangeRoleAssignmentProtectedContextVerifierPort,
} from '../../modules/provider-orchestration/change-role-assignment.ts';
import type {
  ChangeRoleAssignmentHostConfigurationVerifierPort,
  ChangeRoleAssignmentProviderRegistryVerifierPort,
  ChangeRoleAssignmentSessionCapabilityVerifierPort,
} from '../../modules/provider-orchestration/change-role-assignment-record.ts';
import type { CentralRoleProviderDefaultSnapshotVerifierPort } from '../../modules/provider-orchestration/central-role-provider-default.ts';
import {
  type ProviderNativeSessionScopeV1,
  type ProviderNativeSessionClaimV1,
  type ProviderNativeSessionCompletionV1,
  assertProviderNativeSessionClaimV1,
  assertProviderNativeSessionCompletionV1,
  type ProviderNativeSessionHandleV1,
  assertProviderNativeSessionHandleV1,
  type ProviderNativeSessionAssignmentAuthorityVerifierPort,
  deriveProviderNativeSessionScopeV1,
} from '../../modules/provider-orchestration/provider-native-session.ts';
import { readChangeRoleAssignmentRecordV1 } from './change-role-assignment-store.ts';
import { readAcceptedProviderInvocationRuntimeReceiptAuthority } from './provider-runtime-authority.ts';
import {
  readPrivateCanonicalJson,
  withPrivateRuntimeLock,
  assertPrivateInvestigationDirectory,
} from './investigation-private-files.ts';
import {
  assertProviderExecutionAdmissionAuthority,
  providerExecutionAdmissionAuthorityPath,
  MAX_PROVIDER_EXECUTION_ADMISSION_AUTHORITY_BYTES,
} from './provider-execution-admission-authority.ts';
import type { InvestigationRuntimePaths } from '../session-workspace/paths.ts';
import {
  providerNativeSessionStorePathsV1 as storePaths,
  providerNativeSessionClaimRefPathV1 as claimRefPath,
  providerNativeSessionClaimObjectPathV1 as claimObjectPath,
  providerNativeSessionCompletionRefPathV1 as completionRefPath,
  providerNativeSessionCompletionObjectPathV1 as completionObjectPath,
  providerNativeSessionContinuationAuthorityObjectPathV1 as continuationAuthorityObjectPath,
  providerNativeSessionHandleObjectPathV1 as handleObjectPath,
  providerNativeSessionChainDirectoryV1 as chainDirectory,
} from '../session-workspace/provider-runtime-authority-paths.ts';
import {
  type ProviderNativeSessionChainV1,
  createChain,
  TURN_REF,
  MAX_TURN,
  MAX_REF_BYTES,
  assertClaimRef,
  MAX_OBJECT_BYTES,
  assertCompletionRef,
  MAX_CONTINUATION_AUTHORITY_BYTES,
  MAX_HANDLE_BYTES,
  createStartBinding,
  createResumeBinding,
} from './provider-native-session-contracts.ts';
import { recoverScopePublication } from './provider-native-session-publication-recovery.ts';
import {
  storeInvalid,
  storeOperationConflict,
  storeConflict,
  compareCodeUnits,
} from './provider-native-session-values.ts';
import {
  readBoundedCanonicalSnapshot,
  readBoundedCanonicalJson,
  assertRefUnchanged,
  sameStableFile,
} from './provider-native-session-files.ts';

export function readChainForScope(
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

export function readAcceptedOuterSuccessAuthority(
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

export function readHandleForCompletion(
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

export function bindingForClaim(
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

export function assertCurrentScope(
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

export function loadScope(
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

export function withScopeLock<T>(
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

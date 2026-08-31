import path from 'node:path';

import type { InvestigationRuntimePaths } from './paths.ts';

const CHANGE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const MAX_NATIVE_SESSION_TURN = 10_000;

export type ChangeRoleAssignmentStorePathsV1 = Readonly<{
  root: string;
  objects: string;
  refs: string;
}>;

export type ProviderNativeSessionStorePathsV1 = Readonly<{
  root: string;
  claims: string;
  completions: string;
  handles: string;
  continuationAuthorities: string;
  chains: string;
  recovery: string;
}>;

/** Exact no-I/O paths for current content-addressed role assignments. */
export function changeRoleAssignmentStorePathsV1(
  paths: Pick<InvestigationRuntimePaths, 'root'>,
): ChangeRoleAssignmentStorePathsV1 {
  const root = path.join(paths.root, 'change-role-assignments', 'v1');
  return Object.freeze({
    root,
    objects: path.join(root, 'objects', 'sha256'),
    refs: path.join(root, 'refs'),
  });
}

export function changeRoleAssignmentObjectPathV1(
  paths: ChangeRoleAssignmentStorePathsV1,
  recordDigest: string,
): string {
  return path.join(paths.objects, `${assertDigest(recordDigest)}.json`);
}

export function changeRoleAssignmentRefPathV1(
  paths: ChangeRoleAssignmentStorePathsV1,
  changeId: string,
  planningGeneration: string,
): string {
  return path.join(
    paths.refs,
    assertChangeId(changeId),
    `${assertDigest(planningGeneration)}.json`,
  );
}

/** Exact no-I/O paths for current provider-native session authority. */
export function providerNativeSessionStorePathsV1(
  paths: Pick<InvestigationRuntimePaths, 'root'>,
): ProviderNativeSessionStorePathsV1 {
  const root = path.join(paths.root, 'provider-native-sessions', 'v1');
  return Object.freeze({
    root,
    claims: path.join(root, 'claims', 'sha256'),
    completions: path.join(root, 'completions', 'sha256'),
    handles: path.join(root, 'handles', 'sha256'),
    continuationAuthorities: path.join(
      root,
      'continuation-authorities',
      'sha256',
    ),
    chains: path.join(root, 'chains', 'sha256'),
    recovery: path.join(root, 'recovery', 'sha256'),
  });
}

export function providerNativeSessionClaimObjectPathV1(
  paths: ProviderNativeSessionStorePathsV1,
  claimDigest: string,
): string {
  return path.join(paths.claims, `${assertDigest(claimDigest)}.claim.json`);
}

export function providerNativeSessionCompletionObjectPathV1(
  paths: ProviderNativeSessionStorePathsV1,
  completionDigest: string,
): string {
  return path.join(
    paths.completions,
    `${assertDigest(completionDigest)}.completion.json`,
  );
}

export function providerNativeSessionHandleObjectPathV1(
  paths: ProviderNativeSessionStorePathsV1,
  handleDigest: string,
): string {
  return path.join(paths.handles, `${assertDigest(handleDigest)}.handle.json`);
}

export function providerNativeSessionContinuationAuthorityObjectPathV1(
  paths: ProviderNativeSessionStorePathsV1,
  completionDigest: string,
): string {
  return path.join(
    paths.continuationAuthorities,
    `${assertDigest(completionDigest)}.continuation-authority.json`,
  );
}

export function providerNativeSessionChainDirectoryV1(
  paths: ProviderNativeSessionStorePathsV1,
  scopeKey: string,
): string {
  return path.join(paths.chains, assertDigest(scopeKey));
}

export function providerNativeSessionClaimRefPathV1(
  paths: ProviderNativeSessionStorePathsV1,
  scopeKey: string,
  turn: number,
): string {
  return path.join(
    providerNativeSessionChainDirectoryV1(paths, scopeKey),
    `${providerNativeSessionTurnNameV1(turn)}.claim-ref.json`,
  );
}

export function providerNativeSessionCompletionRefPathV1(
  paths: ProviderNativeSessionStorePathsV1,
  scopeKey: string,
  turn: number,
): string {
  return path.join(
    providerNativeSessionChainDirectoryV1(paths, scopeKey),
    `${providerNativeSessionTurnNameV1(turn)}.completion-ref.json`,
  );
}

export function providerNativeSessionTurnNameV1(turn: number): string {
  if (
    !Number.isSafeInteger(turn) ||
    turn < 1 ||
    turn > MAX_NATIVE_SESSION_TURN
  ) {
    throw invalidPathIdentity();
  }
  return String(turn).padStart(5, '0');
}

function assertChangeId(value: string): string {
  if (!CHANGE_ID.test(value) || value === 'archive') {
    throw invalidPathIdentity();
  }
  return value;
}

function assertDigest(value: string): string {
  if (!DIGEST.test(value)) throw invalidPathIdentity();
  return value;
}

function invalidPathIdentity(): TypeError {
  return new TypeError('Provider runtime authority path identity is invalid.');
}

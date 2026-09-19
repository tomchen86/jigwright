/**
 * Stores and reserves collaboration grants against one pinned repository and policy baseline.
 *
 * Invariants:
 * - Reservation uses one clock value and verifies repository, envelope, and exact transition facts.
 * - Replay revalidates the signed reservation without imposing a second expiration boundary.
 */
import {
  type CollaborationGrantEnvelope,
  assertCollaborationGrantId,
  validateCollaborationGrantPayload,
  bindingFromPayload,
  type CollaborationGrantExpectedBinding,
} from '../../modules/authority/collaboration-grant-codec.ts';
import {
  parseCollaborationGrantEnvelope,
  canonicalCollaborationGrantEnvelope,
  verifyCollaborationGrantCapability,
  validateCollaborationGrantEnvelope,
} from '../grants/grant-services.ts';
import { withRepositoryLifecycleOperation } from '../session-workspace/repository-lifecycle-lock.ts';
import {
  collaborationGrantStorePaths,
  ensureStoreDirectories,
  assertNoState,
  statePath,
  createPrivateFileAtomic,
  assertExistingStoreReadOnlySafe,
  assertNonterminalUnambiguous,
  fsyncDirectory,
  replacePrivateFileAtomic,
} from './collaboration-grant-private-files.ts';
import { discoverRepository, runGit } from '../repository-transaction/git.ts';
import type {
  CollaborationReservationRequest,
  CollaborationReservationRecord,
  CollaborationTerminalRecord,
  CollaborationGrantSelectionRequest,
  CollaborationGrantSelection,
  CollaborationGrantSelectableDegradedForm,
  CollaborationGrantSelectionCoreBinding,
} from '../../modules/authority/collaboration-grant-records.ts';
import fs from 'node:fs';
import { assertAuthoritativeCollaborationGrantVerifier } from '../../modules/authority/grant-verifier-port.ts';
import { executeGrantLifecycleTransitionV1 } from '../grants/optional-grants-package.ts';
import { isGrantLifecycleTransitionError } from '../../modules/authority/grant-errors.ts';
import { GRANT_LIFECYCLE_CONTRACT_VERSION_V1 } from '@jigwright/core/grant-lifecycle-contracts';
import { workflowError, ExitCode } from '../../foundation/errors/errors.ts';
import {
  exactDigest,
  bindingMismatch,
  exactDate,
  unavailableGrant,
  serialize,
  deepFreeze,
  isRecord,
  hasExactKeys,
} from '../../modules/authority/collaboration-grant-values.ts';
import {
  readTerminal,
  cleanupNonterminal,
  readAvailable,
  readReservation,
} from './collaboration-grant-records.ts';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import {
  type MaintainerPolicy,
  parseMaintainerPolicy,
} from '../../modules/authority/maintainer-policy.ts';
import crypto from 'node:crypto';
import {
  resolveBlobOid,
  resolveCommitOid,
  resolveTreeOid,
} from '../repository-transaction/git-object-ids.ts';

export function storeAvailableCollaborationGrant(
  gitCommonDirectory: string,
  envelope: CollaborationGrantEnvelope,
): string {
  const paths = collaborationGrantStorePaths(gitCommonDirectory);
  return withRepositoryLifecycleOperation(paths.runtime, (assertOwned) =>
    storeAvailableCollaborationGrantUnderLifecycleLock(
      gitCommonDirectory,
      envelope,
      assertOwned,
    ),
  );
}

export function storeAvailableCollaborationGrantUnderLifecycleLock(
  gitCommonDirectory: string,
  envelope: CollaborationGrantEnvelope,
  assertOwned: () => void,
): string {
  const paths = collaborationGrantStorePaths(gitCommonDirectory);
  const parsed = parseCollaborationGrantEnvelope(
    canonicalCollaborationGrantEnvelope(envelope),
  );
  const grantId = assertCollaborationGrantId(parsed.payload.grantId);
  assertOwned();
  ensureStoreDirectories(paths);
  assertOwned();
  assertNoState(paths, grantId);
  const target = statePath(paths.available, grantId);
  createPrivateFileAtomic(target, canonicalCollaborationGrantEnvelope(parsed));
  assertOwned();
  return target;
}

/**
 * Verify and atomically reserve one exact grant against repository facts.
 * Validation and `reservedAt` share the same engine-owned clock value; callers
 * cannot substitute a no-op validation callback or a second timestamp.
 */
export function reserveCollaborationGrant(
  cwd: string,
  requestedGrantId: string,
  request: CollaborationReservationRequest,
): CollaborationReservationRecord {
  const repository = discoverRepository(cwd);
  const paths = collaborationGrantStorePaths(repository.gitCommonDirectory);
  return withRepositoryLifecycleOperation(paths.runtime, (assertOwned) =>
    reserveCollaborationGrantUnderLifecycleLock(
      cwd,
      requestedGrantId,
      request,
      assertOwned,
    ),
  );
}

export function reserveCollaborationGrantUnderLifecycleLock(
  cwd: string,
  requestedGrantId: string,
  request: CollaborationReservationRequest,
  assertOwned: () => void,
): CollaborationReservationRecord {
  assertOwned();
  const grantId = assertCollaborationGrantId(requestedGrantId);
  const transitionDigest = exactDigest(
    request.transitionDigest,
    'transition digest',
  );
  const repository = discoverRepository(cwd);
  const baselineCommit = exactRepositoryCommit(
    repository.repositoryRoot,
    request.expected.baselineCommit,
  );
  const baselineTree = resolveTreeOid(
    repository.repositoryRoot,
    baselineCommit,
  );
  const mergeBase = runGit(repository.repositoryRoot, [
    'merge-base',
    baselineCommit,
    repository.head,
  ]).trim();
  if (mergeBase !== baselineCommit) {
    throw bindingMismatch();
  }
  const policy = loadPolicyAtCommit(repository.repositoryRoot, baselineCommit);
  const policyBlob = resolveBlobOid(
    repository.repositoryRoot,
    baselineCommit,
    'workflow/maintainer-policy.json',
  );
  const origin = runGit(repository.repositoryRoot, [
    'remote',
    'get-url',
    'origin',
  ]).trim();
  if (
    request.expected.baselineTree !== baselineTree ||
    request.expected.policyBlob !== policyBlob ||
    request.expected.repositoryId !== policy.repository.id ||
    request.expected.repositoryOrigin !== policy.repository.origin ||
    origin !== policy.repository.origin
  ) {
    throw bindingMismatch();
  }
  const now = exactDate(request.now ?? new Date());
  const paths = collaborationGrantStorePaths(repository.gitCommonDirectory);
  if (!assertExistingStoreReadOnlySafe(paths)) {
    throw unavailableGrant(grantId);
  }
  assertOwned();
  const terminalPath = statePath(paths.terminal, grantId);
  if (fs.existsSync(terminalPath)) {
    const terminal = readTerminal(terminalPath, grantId);
    cleanupNonterminal(
      paths,
      grantId,
      terminal.envelope,
      terminal.transitionDigest,
    );
    throw unavailableGrant(grantId);
  }
  assertNonterminalUnambiguous(paths, grantId);
  if (fs.existsSync(statePath(paths.reserved, grantId))) {
    throw unavailableGrant(grantId);
  }
  const availablePath = statePath(paths.available, grantId);
  if (!fs.existsSync(availablePath)) {
    throw unavailableGrant(grantId);
  }
  const availableEnvelope = readAvailable(availablePath, grantId);
  const verifier = request.verifier;
  assertAuthoritativeCollaborationGrantVerifier(verifier);
  verifier.assertCurrent();
  validateCollaborationGrantPayload(availableEnvelope.payload, policy, {
    now,
    expectedPolicyBlob: request.expected.policyBlob,
    allowExpired: true,
  });
  try {
    const transition = executeGrantLifecycleTransitionV1(
      {
        contractVersion: GRANT_LIFECYCLE_CONTRACT_VERSION_V1,
        grantId,
        transitionDigest,
        maxUses: availableEnvelope.payload.maxUses,
        event: {
          kind: 'reserve',
          expiresAt: availableEnvelope.payload.expiresAt,
          reason: 'Grant reserved for exact collaboration transition',
          expirationReason: 'Grant expired before reservation',
        },
        validate: () =>
          verifyCollaborationGrantCapability(availableEnvelope, policy, {
            now,
            expected: request.expected,
            verifier,
            allowExpired: true,
          }),
      },
      {
        clock: { now: () => now },
        storage: {
          readState: () => 'available',
          applyTransition(input) {
            if (input.receipt.toState === 'expired') {
              const terminal: CollaborationTerminalRecord = {
                schemaVersion: 1,
                state: 'expired',
                grantId,
                transitionDigest,
                reason: input.receipt.reason,
                recordedAt: input.receipt.occurredAt,
                envelope: availableEnvelope,
                use: null,
              };
              assertOwned();
              ensureStoreDirectories(paths);
              assertOwned();
              createPrivateFileAtomic(terminalPath, serialize(terminal));
              cleanupNonterminal(
                paths,
                grantId,
                availableEnvelope,
                transitionDigest,
              );
              return terminal;
            }
            if (
              input.receipt.toState !== 'reserved' ||
              input.validation === undefined
            ) {
              throw unavailableGrant(grantId);
            }
            const envelope = input.validation.envelope;
            const record: CollaborationReservationRecord = {
              schemaVersion: 1,
              state: 'reserved',
              grantId,
              transitionDigest,
              repositoryRoot: repository.repositoryRoot,
              reservedAt: input.receipt.occurredAt,
              envelope,
            };
            assertOwned();
            ensureStoreDirectories(paths);
            assertOwned();
            const reservedPath = statePath(paths.reserved, grantId);
            fs.renameSync(availablePath, reservedPath);
            fsyncDirectory(paths.available);
            fsyncDirectory(paths.reserved);
            replacePrivateFileAtomic(reservedPath, serialize(record));
            assertOwned();
            return deepFreeze(record);
          },
        },
      },
    );
    if (transition.value.state !== 'reserved') {
      throw unavailableGrant(grantId);
    }
    return transition.value;
  } catch (error) {
    if (
      isGrantLifecycleTransitionError(error) &&
      error.code === 'GRANT_LIFECYCLE_EXPIRED'
    ) {
      throw workflowError(
        'COLLABORATION_GRANT_EXPIRED',
        'Collaboration grant has expired.',
        ExitCode.staleState,
      );
    }
    throw error;
  }
}

/**
 * Select and reserve a signed caller-supplied or direct-human grant without
 * asking the lifecycle caller to trust actor or reason fields from an
 * unverified local envelope. The caller supplies only immutable transition
 * facts and the forms it is prepared to admit. The complete binding and its
 * transition digest are derived from the signed payload after those facts
 * match.
 *
 * Repeating the exact selection reuses an existing durable reservation. That
 * replay verifies the signed envelope again but does not add a second
 * wall-clock freshness rule after the grant was reserved while valid.
 */
export function selectAndReserveCollaborationGrantUnderLifecycleLock(
  cwd: string,
  requestedGrantId: string,
  request: CollaborationGrantSelectionRequest,
  assertOwned: () => void,
): CollaborationGrantSelection {
  assertOwned();
  const grantId = assertCollaborationGrantId(requestedGrantId);
  const allowedDegradedForms = assertSelectableDegradedForms(
    request.allowedDegradedForms,
  );
  const repository = discoverRepository(cwd);
  const paths = collaborationGrantStorePaths(repository.gitCommonDirectory);
  if (!assertExistingStoreReadOnlySafe(paths)) {
    throw unavailableGrant(grantId);
  }
  assertOwned();

  const terminalPath = statePath(paths.terminal, grantId);
  if (fs.existsSync(terminalPath)) {
    const terminal = readTerminal(terminalPath, grantId);
    cleanupNonterminal(
      paths,
      grantId,
      terminal.envelope,
      terminal.transitionDigest,
    );
    throw unavailableGrant(grantId);
  }
  assertNonterminalUnambiguous(paths, grantId);

  const reservedPath = statePath(paths.reserved, grantId);
  if (fs.existsSync(reservedPath)) {
    const reservation = readReservation(reservedPath, grantId);
    const expectedBinding = assertSelectedGrantBinding(
      reservation.envelope,
      request.expectedCore,
      allowedDegradedForms,
    );
    const transitionDigest = collaborationRoleTransitionDigest(expectedBinding);
    if (
      reservation.repositoryRoot !== repository.repositoryRoot ||
      reservation.transitionDigest !== transitionDigest
    ) {
      throw bindingMismatch();
    }
    const context = loadSelectionValidationContext(
      repository.repositoryRoot,
      request.expectedCore,
      request.now,
    );
    const verifier = request.verifier;
    assertAuthoritativeCollaborationGrantVerifier(verifier);
    verifier.assertCurrent();
    validateCollaborationGrantEnvelope(reservation.envelope, context.policy, {
      now: context.now,
      expected: expectedBinding,
      verifier,
      allowExpired: true,
    });
    assertOwned();
    return deepFreeze({ reservation, expectedBinding });
  }

  const availablePath = statePath(paths.available, grantId);
  if (!fs.existsSync(availablePath)) {
    throw unavailableGrant(grantId);
  }
  const available = readAvailable(availablePath, grantId);
  const expectedBinding = assertSelectedGrantBinding(
    available,
    request.expectedCore,
    allowedDegradedForms,
  );
  const reservation = reserveCollaborationGrantUnderLifecycleLock(
    repository.repositoryRoot,
    grantId,
    {
      transitionDigest: collaborationRoleTransitionDigest(expectedBinding),
      expected: expectedBinding,
      ...(request.now === undefined ? {} : { now: request.now }),
      ...(request.verifier === undefined ? {} : { verifier: request.verifier }),
    },
    assertOwned,
  );
  return deepFreeze({
    reservation,
    expectedBinding: bindingFromPayload(reservation.envelope.payload),
  });
}

export function readReservedCollaborationGrant(
  gitCommonDirectory: string,
  requestedGrantId: string,
): CollaborationReservationRecord {
  const paths = collaborationGrantStorePaths(gitCommonDirectory);
  return withRepositoryLifecycleOperation(paths.runtime, (assertOwned) =>
    readReservedCollaborationGrantUnderLifecycleLock(
      gitCommonDirectory,
      requestedGrantId,
      assertOwned,
    ),
  );
}

export function readReservedCollaborationGrantUnderLifecycleLock(
  gitCommonDirectory: string,
  requestedGrantId: string,
  assertOwned: () => void,
): CollaborationReservationRecord {
  assertOwned();
  const grantId = assertCollaborationGrantId(requestedGrantId);
  const paths = collaborationGrantStorePaths(gitCommonDirectory);
  if (!assertExistingStoreReadOnlySafe(paths)) {
    throw unavailableGrant(grantId);
  }
  assertOwned();
  const terminalPath = statePath(paths.terminal, grantId);
  if (fs.existsSync(terminalPath)) {
    const terminal = readTerminal(terminalPath, grantId);
    cleanupNonterminal(
      paths,
      grantId,
      terminal.envelope,
      terminal.transitionDigest,
    );
    throw unavailableGrant(grantId);
  }
  assertNonterminalUnambiguous(paths, grantId);
  const reservation = readReservation(
    statePath(paths.reserved, grantId),
    grantId,
  );
  assertOwned();
  return reservation;
}

function assertSelectableDegradedForms(
  value: readonly CollaborationGrantSelectableDegradedForm[],
): readonly CollaborationGrantSelectableDegradedForm[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some(
      (entry) => entry !== 'caller-supplied' && entry !== 'direct-human-review',
    ) ||
    new Set(value).size !== value.length
  ) {
    throw bindingMismatch();
  }
  return Object.freeze([...value].sort());
}

function assertSelectedGrantBinding(
  envelope: CollaborationGrantEnvelope,
  expectedCore: CollaborationGrantSelectionCoreBinding,
  allowedDegradedForms: readonly CollaborationGrantSelectableDegradedForm[],
): CollaborationGrantExpectedBinding {
  if (
    !isRecord(expectedCore) ||
    !hasExactKeys(expectedCore, [
      'repositoryId',
      'repositoryOrigin',
      'policyBlob',
      'collaborationPolicyDigest',
      'changeId',
      'taskId',
      'baselineCommit',
      'baselineTree',
      'targetDigest',
      'lifecyclePhase',
      'rolePair',
    ])
  ) {
    throw bindingMismatch();
  }
  const expectedBinding = bindingFromPayload(envelope.payload);
  const observedCore: CollaborationGrantSelectionCoreBinding = {
    repositoryId: expectedBinding.repositoryId,
    repositoryOrigin: expectedBinding.repositoryOrigin,
    policyBlob: expectedBinding.policyBlob,
    collaborationPolicyDigest: expectedBinding.collaborationPolicyDigest,
    changeId: expectedBinding.changeId,
    taskId: expectedBinding.taskId,
    baselineCommit: expectedBinding.baselineCommit,
    baselineTree: expectedBinding.baselineTree,
    targetDigest: expectedBinding.targetDigest,
    lifecyclePhase: expectedBinding.lifecyclePhase,
    rolePair: expectedBinding.rolePair,
  };
  let coreMatches = false;
  try {
    coreMatches =
      canonicalJson(observedCore) === canonicalJson(expectedCore) &&
      allowedDegradedForms.includes(
        expectedBinding.degradedForm as CollaborationGrantSelectableDegradedForm,
      );
  } catch {
    throw bindingMismatch();
  }
  const actorMatchesForm =
    (expectedBinding.degradedForm === 'caller-supplied' &&
      expectedBinding.availableActor.kind === 'caller') ||
    (expectedBinding.degradedForm === 'direct-human-review' &&
      expectedBinding.availableActor.kind === 'direct-human');
  if (!coreMatches || !actorMatchesForm) {
    throw bindingMismatch();
  }
  return deepFreeze(expectedBinding);
}

function loadSelectionValidationContext(
  repositoryRoot: string,
  expectedCore: CollaborationGrantSelectionCoreBinding,
  requestedNow: Date | undefined,
): {
  now: Date;
  policy: MaintainerPolicy;
} {
  const baselineCommit = exactRepositoryCommit(
    repositoryRoot,
    expectedCore.baselineCommit,
  );
  const baselineTree = resolveTreeOid(repositoryRoot, baselineCommit);
  const head = runGit(repositoryRoot, ['rev-parse', 'HEAD']).trim();
  const mergeBase = runGit(repositoryRoot, [
    'merge-base',
    baselineCommit,
    head,
  ]).trim();
  const policy = loadPolicyAtCommit(repositoryRoot, baselineCommit);
  const policyBlob = resolveBlobOid(
    repositoryRoot,
    baselineCommit,
    'workflow/maintainer-policy.json',
  );
  const origin = runGit(repositoryRoot, ['remote', 'get-url', 'origin']).trim();
  if (
    mergeBase !== baselineCommit ||
    expectedCore.baselineTree !== baselineTree ||
    expectedCore.policyBlob !== policyBlob ||
    expectedCore.repositoryId !== policy.repository.id ||
    expectedCore.repositoryOrigin !== policy.repository.origin ||
    origin !== policy.repository.origin
  ) {
    throw bindingMismatch();
  }
  return {
    now: exactDate(requestedNow ?? new Date()),
    policy,
  };
}

export function collaborationRoleTransitionDigest(
  expectedBinding: CollaborationGrantExpectedBinding,
): string {
  return crypto
    .createHash('sha256')
    .update(
      canonicalJson({
        schemaVersion: 1,
        kind: 'collaboration-role-transition',
        expectedBinding,
      }),
    )
    .digest('hex');
}

export function loadPolicyAtCommit(
  repositoryRoot: string,
  commit: string,
): MaintainerPolicy {
  try {
    return parseMaintainerPolicy(
      JSON.parse(
        runGit(repositoryRoot, [
          'show',
          `${commit}:workflow/maintainer-policy.json`,
        ]),
      ),
    );
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error) {
      throw error;
    }
    throw workflowError(
      'COLLABORATION_GRANT_INVALID',
      'The exact baseline does not contain a valid maintainer policy.',
      ExitCode.guard,
    );
  }
}

export function exactRepositoryCommit(
  repositoryRoot: string,
  requested: string,
): string {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(requested)) {
    throw bindingMismatch();
  }
  const resolved = resolveCommitOid(repositoryRoot, requested);
  if (resolved !== requested) {
    throw bindingMismatch();
  }
  return resolved;
}

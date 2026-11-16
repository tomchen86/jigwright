/**
 * Requests, inspects, resolves and recovers durable Grant challenges under
 * the supplied lifecycle lock.
 *
 * Invariants:
 * - The kernel refuses to construct unless `challengeTtlMs` is an integer
 *   of at least 1 ms and at most 30 minutes.
 * - `resolveChallenge` re-reads the record under the lifecycle lock after
 *   collecting the human decision and aborts unless it is still pending
 *   with the same challenge digest.
 */
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import type {
  CentralGrantChallengePortV1,
  CentralGrantRequestPortV1,
} from '@jigwright/core/central-grant-port';
import { isRecord } from '../../foundation/canonical-json/contract-values.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import {
  evaluateApprovalProfile,
  type VerifiedApprovalProof,
} from './grant-approval.ts';
import {
  approvalSubjectDigest,
  createApprovalSubject,
  createGrantChallenge,
  type ApprovalSubject,
  type GrantApprovalMethod,
  type GrantChallenge,
  type GrantChallengeRef,
  type GrantRequestInput,
  type StateBinding,
} from './grant-core.ts';
import {
  approvalMethodsForPolicy,
  approvalProfileForMethod,
  type GrantPolicyV2,
} from './grant-policy.ts';
import {
  copyGrantDate,
  freezeGrantCanonical as freezeCanonical,
  grantSha256,
  GRANT_SHA256_DIGEST as SHA256_DIGEST,
  GRANT_UUID_V4 as UUID_V4,
  grantHasExactKeys as hasExactKeys,
} from './grant-primitives.ts';
import type { GrantRecordStore } from './grant-record-store.ts';
import {
  grantRecordDigest,
  type GrantAuditRecord,
  type PreparedGrantRecord,
  type TerminalGrantRecord,
} from './grant-records.ts';
import {
  assertPreparedGrantDescendantNodeV1,
  assertPreparedGrantDescendantTreeV1,
  type PreparedGrantDescendantNodeV1,
  type PreparedGrantDescendantTreeV1,
} from './grant-parent-binding.ts';
import type {
  RegisteredTransitionDefinition,
  TransitionOutcome,
  TransitionRegistry,
} from './grant-transition-registry.ts';
import { GrantTransitionPreconditionError } from './grant-transition-registry.ts';

const DEFAULT_CHALLENGE_TTL_MS = 10 * 60_000;

export type TrustedGrantChoicePresentation = Readonly<{
  choiceId: `sha256:${string}`;
  transitionId: string;
  title: string;
  consequences: readonly string[];
  allowedApprovalMethods: readonly GrantApprovalMethod[];
  allowedReasonCodes: readonly string[];
  reasonRequired: boolean;
  proposedReason: string;
}>;

export type TrustedGrantPresentation = Readonly<{
  challenge: GrantChallenge;
  failureCode: string;
  facts: unknown;
  expiresAt: string;
  approvalMethods: readonly GrantApprovalMethod[];
  choices: readonly TrustedGrantChoicePresentation[];
}>;

export type GrantHumanDecision = Readonly<{
  choiceId: string;
  approvalMethod: GrantApprovalMethod;
  reasonCode: string;
  reason: string;
  sessionNonce: string;
}>;

export type GrantAuthenticationRequest = Readonly<{
  approvalSubject: ApprovalSubject;
  approvalSubjectDigest: `sha256:${string}`;
}>;

export type GrantApprovalSession = Readonly<{
  collectDecision(): Promise<GrantHumanDecision>;
  authenticate(
    request: GrantAuthenticationRequest,
  ): Promise<readonly VerifiedApprovalProof[]>;
  close(): Promise<void>;
}>;

export type GrantExecutionResult = Readonly<{
  challengeId: string;
  operationId: string;
  transitionId: string;
  outcome: 'completed' | 'failed';
  poststateDigest: `sha256:${string}`;
  recovered: boolean;
}>;

export type GrantCoordinator = CentralGrantRequestPortV1 &
  CentralGrantChallengePortV1<TrustedGrantPresentation, GrantExecutionResult> &
  Readonly<{
    inspectChallenge(challengeId: string): TrustedGrantPresentation;
    resolveChallenge(challengeId: string): Promise<GrantExecutionResult>;
    recoverChallenge(challengeId: string): Promise<GrantExecutionResult>;
  }>;

/**
 * Read-only authority preflight for application recovery routing. Keeping the
 * store traversal beside the coordinator avoids teaching application modules
 * about the runtime Grant representation.
 */
export function inspectPreparedGrantDescendants(
  store: Pick<
    GrantRecordStore,
    'readGrantRecord' | 'inspectPreparedGrantDescendantTree'
  >,
  challengeId: string,
): PreparedGrantDescendantTreeV1 | null {
  const record = store.readGrantRecord(challengeId);
  return record.state === 'prepared'
    ? store.inspectPreparedGrantDescendantTree(record)
    : null;
}

type LifecycleOperation = <T>(
  challengeId: string,
  operation: (assertOwned: () => void) => Promise<T>,
) => Promise<T>;

/**
 * Testable Grant Core kernel. Production composition must bind this to the
 * code-owned Human Gate and repository lifecycle lock; no CLI or domain module
 * receives these dependencies.
 */
export function createGrantCoordinatorKernel(
  options: Readonly<{
    store: GrantRecordStore;
    registry: TransitionRegistry;
    policy: GrantPolicyV2;
    now: () => Date;
    randomUUID: () => string;
    challengeTtlMs?: number;
    openApprovalSession(
      presentation: TrustedGrantPresentation,
    ): GrantApprovalSession | Promise<GrantApprovalSession>;
    withLifecycleOperation: LifecycleOperation;
  }>,
): GrantCoordinator {
  const now = options.now;
  const randomUUID = options.randomUUID;
  const challengeTtlMs = options.challengeTtlMs ?? DEFAULT_CHALLENGE_TTL_MS;
  if (
    !Number.isInteger(challengeTtlMs) ||
    challengeTtlMs < 1 ||
    challengeTtlMs > 30 * 60_000
  ) {
    throw workflowError(
      'GRANT_COORDINATOR_INVALID',
      'Grant coordinator challenge bounds are invalid.',
      ExitCode.guard,
    );
  }

  return Object.freeze({
    contractVersion: 'central-grant-request-port.v1' as const,
    challengeContractVersion: 'central-grant-challenge-port.v1' as const,
    async requestGrant(input) {
      const issuedAt = exactDate(now());
      const challenge = createGrantChallenge(input, options.registry, {
        challengeId: exactUuid(randomUUID()),
        now: issuedAt,
        expiresAt: new Date(issuedAt.getTime() + challengeTtlMs).toISOString(),
      });
      options.store.persistGrantChallenge(challenge);
      return Object.freeze({
        challengeId: challenge.challengeId,
        challengeDigest: challenge.challengeDigest,
      });
    },

    inspectChallenge(challengeId) {
      const stored = options.store.readGrantRecord(challengeId);
      return trustedPresentation(
        stored.challenge,
        options.registry,
        options.policy,
      );
    },

    async resolveChallenge(challengeId) {
      const stored = options.store.readGrantRecord(challengeId);
      if (stored.state !== 'pending') throw challengeUnavailable(challengeId);
      const challenge = stored.challenge;
      const presentation = trustedPresentation(
        challenge,
        options.registry,
        options.policy,
      );
      const session = await options.openApprovalSession(presentation);
      let subject: ApprovalSubject;
      let subjectDigest: `sha256:${string}`;
      let proofs: readonly VerifiedApprovalProof[];
      try {
        const decision = assertHumanDecision(await session.collectDecision());
        assertDecisionApprovalMethodAllowed(challenge, decision);
        subject = createApprovalSubject(challenge, decision, {
          now: exactDate(now()),
        });
        subjectDigest = approvalSubjectDigest(subject);
        proofs = await session.authenticate({
          approvalSubject: subject,
          approvalSubjectDigest: subjectDigest,
        });
      } finally {
        await session.close();
      }
      const evaluated = evaluateApprovalProfile(
        options.policy,
        approvalProfileForMethod(options.policy, subject.approvalMethod),
        subjectDigest,
        proofs,
      );

      return options.withLifecycleOperation(
        challengeId,
        async (assertOwned) => {
          assertOwned();
          const current = options.store.readGrantRecord(challengeId);
          if (
            current.state !== 'pending' ||
            current.challenge.challengeDigest !== challenge.challengeDigest
          ) {
            throw challengeUnavailable(challengeId);
          }
          const selected = selectedTransition(
            challenge,
            subject,
            options.registry,
          );
          assertTransitionApprovalMethodAllowed(
            selected.definition,
            subject.approvalMethod,
          );
          await assertExpectedState(
            selected.definition,
            selected.parameters,
            challenge.stateBinding,
            challenge.challengeId,
          );
          assertOwned();
          const prepared = options.store.prepareGrantTransition({
            operationId: exactUuid(randomUUID()),
            challenge,
            subject,
            proofModules: evaluated.proofModules,
            createdAt: exactDate(now()).toISOString(),
          });
          assertOwned();
          return executePreparedTransition(
            options.store,
            options.registry,
            challenge,
            prepared,
            assertOwned,
            now,
            false,
          );
        },
      );
    },

    async recoverChallenge(challengeId) {
      const observed = options.store.readGrantRecord(challengeId);
      if (observed.state === 'pending') {
        throw workflowError(
          'GRANT_TRANSITION_RECORD_MISSING',
          'Grant transition recovery requires a prepared record.',
          ExitCode.staleState,
        );
      }
      if (observed.state === 'completed' || observed.state === 'failed') {
        return executionResult(observed, true);
      }
      return options.withLifecycleOperation(
        challengeId,
        async (assertOwned) => {
          assertOwned();
          const current = options.store.readGrantRecord(challengeId);
          if (
            current.state === 'pending' ||
            current.operationId !== observed.operationId
          ) {
            throw workflowError(
              'GRANT_TRANSITION_RECOVERY_AMBIGUOUS',
              'Grant transition record changed during recovery.',
              ExitCode.staleState,
            );
          }
          if (current.state === 'completed' || current.state === 'failed') {
            return executionResult(current, true);
          }
          if (current.state !== 'prepared') {
            throw workflowError(
              'GRANT_TRANSITION_RECOVERY_AMBIGUOUS',
              'Grant transition record is not recoverable.',
              ExitCode.staleState,
            );
          }
          return executePreparedTransition(
            options.store,
            options.registry,
            current.challenge,
            current,
            assertOwned,
            now,
            true,
          );
        },
      );
    },
  });
}

async function executePreparedTransition(
  store: GrantRecordStore,
  registry: TransitionRegistry,
  challenge: GrantChallenge,
  record: PreparedGrantRecord,
  assertOwned: () => void,
  now: () => Date,
  recovered: boolean,
): Promise<GrantExecutionResult> {
  const selected = selectedTransition(
    challenge,
    record.approvalSubject,
    registry,
  );
  const descendantTree =
    selected.definition.preparedDescendantTree === undefined
      ? null
      : assertPreparedGrantDescendantTreeV1(
          selected.definition.preparedDescendantTree(selected.parameters),
        );
  assertOwned();
  let outcome: TransitionOutcome;
  try {
    outcome = await selected.definition.execute({
      parameters: selected.parameters,
      approvalSubject: record.approvalSubject,
      approvalSubjectDigest: approvalSubjectDigest(record.approvalSubject),
      challengeId: challenge.challengeId,
      operationId: record.operationId,
      recovered,
      assertLifecycleOwned: assertOwned,
      ...(descendantTree === null
        ? {}
        : {
            settlePreparedDescendant: (node: PreparedGrantDescendantNodeV1) =>
              terminalizeAuthorizedPreparedDescendant({
                store,
                registry,
                outerRecord: record,
                descendantTree,
                node,
                assertOwned,
                now,
              }),
          }),
    });
  } catch (error) {
    if (!(error instanceof GrantTransitionPreconditionError)) {
      throw error;
    }
    assertOwned();
    const observed = assertStateBinding(
      await selected.definition.observeState(selected.parameters, {
        challengeId: challenge.challengeId,
        operationId: record.operationId,
      }),
    );
    assertOwned();
    if (
      observed.kind === challenge.stateBinding.kind &&
      observed.digest === challenge.stateBinding.digest
    ) {
      throw error;
    }
    const failed = store.recordGrantTransitionOutcome({
      challengeId: challenge.challengeId,
      operationId: record.operationId,
      poststateDigest: observed.digest,
      outcome: {
        outcome: 'failed',
        details: {
          schemaVersion: 1,
          kind: 'grant-transition-state-drift.v1',
          failureCode: 'GRANT_STATE_CHANGED',
          transitionCompleted: false,
          transitionErrorCode: safeTransitionErrorCode(error.code),
          expectedStateBinding: challenge.stateBinding,
          observedStateBinding: observed,
        },
      },
      completedAt: exactDate(now()).toISOString(),
      audit: grantAudit(record),
    });
    return executionResult(failed, recovered);
  }
  assertOwned();
  const poststate = await selected.definition.observeState(
    selected.parameters,
    {
      challengeId: challenge.challengeId,
      operationId: record.operationId,
    },
  );
  const normalizedPoststate = assertStateBinding(poststate);
  const completed = store.recordGrantTransitionOutcome({
    challengeId: challenge.challengeId,
    operationId: record.operationId,
    poststateDigest: normalizedPoststate.digest,
    outcome,
    completedAt: exactDate(now()).toISOString(),
    audit: grantAudit(record),
  });
  return executionResult(completed, recovered);
}

async function terminalizeAuthorizedPreparedDescendant(
  input: Readonly<{
    store: GrantRecordStore;
    registry: TransitionRegistry;
    outerRecord: PreparedGrantRecord;
    descendantTree: PreparedGrantDescendantTreeV1;
    node: PreparedGrantDescendantNodeV1;
    assertOwned(): void;
    now(): Date;
  }>,
): Promise<Readonly<{ challengeId: string; outcome: 'failed' }>> {
  const node = assertPreparedGrantDescendantNodeV1(input.node);
  const authorizedNode = input.descendantTree.nodes.find(
    ({ challengeId }) => challengeId === node.challengeId,
  );
  if (
    authorizedNode === undefined ||
    canonicalJson(authorizedNode) !== canonicalJson(node)
  ) {
    throw workflowError(
      'GRANT_DESCENDANT_SETTLEMENT_UNAUTHORIZED',
      'The outer Grant does not authorize this prepared descendant.',
      ExitCode.guard,
    );
  }
  input.assertOwned();
  const current = input.store.readGrantRecord(node.challengeId);
  if (current.state === 'completed' || current.state === 'failed') {
    if (
      current.state !== 'failed' ||
      current.operationId !== node.operationId ||
      current.challenge.challengeDigest !== node.challengeDigest ||
      approvalSubjectDigest(current.approvalSubject) !==
        node.approvalSubjectDigest ||
      !isMatchingAncestorCancellationOutcome(
        current.outcome.details,
        input.outerRecord,
        input.descendantTree,
        node,
      )
    ) {
      throw workflowError(
        'GRANT_DESCENDANT_SETTLEMENT_CHANGED',
        'Prepared Grant descendant was terminalized by another operation.',
        ExitCode.staleState,
      );
    }
    return Object.freeze({ challengeId: node.challengeId, outcome: 'failed' });
  }
  if (
    current.state !== 'prepared' ||
    current.operationId !== node.operationId ||
    current.challenge.challengeDigest !== node.challengeDigest ||
    current.challenge.stateBinding.digest !== node.stateBindingDigest ||
    approvalSubjectDigest(current.approvalSubject) !==
      node.approvalSubjectDigest ||
    grantRecordDigest(current) !== node.preparedRecordDigest
  ) {
    throw workflowError(
      'GRANT_DESCENDANT_SETTLEMENT_CHANGED',
      'Prepared Grant descendant changed before settlement.',
      ExitCode.staleState,
    );
  }
  const selected = selectedTransition(
    current.challenge,
    current.approvalSubject,
    input.registry,
  );
  let observed: StateBinding | null = null;
  let observationErrorCode: string | null = null;
  try {
    observed = assertStateBinding(
      await selected.definition.observeState(selected.parameters, {
        challengeId: current.challenge.challengeId,
        operationId: current.operationId,
      }),
    );
  } catch (error) {
    observationErrorCode =
      error instanceof Error && 'code' in error
        ? safeTransitionErrorCode(String(error.code))
        : 'OBSERVATION_UNAVAILABLE';
  }
  input.assertOwned();
  const unchanged =
    observed !== null &&
    observed.kind === current.challenge.stateBinding.kind &&
    observed.digest === current.challenge.stateBinding.digest;
  const details = freezeCanonical({
    schemaVersion: 1,
    kind: 'grant-transition-cancelled-by-ancestor-recovery.v1',
    outerChallengeId: input.outerRecord.challenge.challengeId,
    outerOperationId: input.outerRecord.operationId,
    outerApprovalSubjectDigest: approvalSubjectDigest(
      input.outerRecord.approvalSubject,
    ),
    rootChallengeId: input.descendantTree.rootChallengeId,
    descendantTreeDigest: input.descendantTree.treeDigest,
    preparedRecordDigest: node.preparedRecordDigest,
    expectedStateBinding: current.challenge.stateBinding,
    transitionCompleted: unchanged ? false : null,
    effectState: unchanged
      ? 'not-applied'
      : observed === null
        ? 'observation-unavailable-authorized'
        : 'state-changed-authorized',
    observedStateBinding: observed,
    observationErrorCode,
  });
  const poststateDigest =
    observed?.digest ??
    grantSha256(
      `workflow.grant-descendant-observation-unavailable.v1\n${canonicalJson({
        node,
        observationErrorCode,
      })}`,
    );
  input.store.recordGrantTransitionOutcome({
    challengeId: current.challenge.challengeId,
    operationId: current.operationId,
    poststateDigest,
    outcome: Object.freeze({ outcome: 'failed' as const, details }),
    completedAt: exactDate(input.now()).toISOString(),
    audit: grantAudit(current),
  });
  return Object.freeze({ challengeId: node.challengeId, outcome: 'failed' });
}

function isMatchingAncestorCancellationOutcome(
  value: unknown,
  outerRecord: PreparedGrantRecord,
  tree: PreparedGrantDescendantTreeV1,
  node: PreparedGrantDescendantNodeV1,
): boolean {
  return (
    isRecord(value) &&
    value.kind === 'grant-transition-cancelled-by-ancestor-recovery.v1' &&
    value.outerChallengeId === outerRecord.challenge.challengeId &&
    value.outerOperationId === outerRecord.operationId &&
    value.outerApprovalSubjectDigest ===
      approvalSubjectDigest(outerRecord.approvalSubject) &&
    value.rootChallengeId === tree.rootChallengeId &&
    value.descendantTreeDigest === tree.treeDigest &&
    value.preparedRecordDigest === node.preparedRecordDigest
  );
}

function safeTransitionErrorCode(value: string): string {
  return /^[A-Z][A-Z0-9_]{0,255}$/.test(value)
    ? value
    : 'UNCLASSIFIED_STALE_STATE';
}

function grantAudit(record: PreparedGrantRecord): GrantAuditRecord {
  const approvalMethod = record.approvalSubject.approvalMethod;
  const sshIdentity = record.proofModules.find(
    ({ claim }) => claim === 'ssh-signature',
  )?.identity;
  return freezeCanonical({
    approvalMethod,
    authorityClass:
      approvalMethod === 'human-presence'
        ? 'local-device-owner'
        : 'ssh-credential',
    identity:
      approvalMethod === 'human-presence' ? null : (sshIdentity ?? null),
    identityAssurance:
      approvalMethod === 'human-presence'
        ? 'not-asserted'
        : 'policy-trusted-ssh-key',
    presenceAssurance:
      approvalMethod === 'human-presence'
        ? 'fresh-os-authentication'
        : 'not-asserted',
    proofModules: record.proofModules.map(
      ({ moduleId, version }) => `${moduleId}@${version}`,
    ),
  });
}

function selectedTransition(
  challenge: GrantChallenge,
  subject: ApprovalSubject,
  registry: TransitionRegistry,
): Readonly<{
  choice: GrantChallenge['choices'][number];
  definition: RegisteredTransitionDefinition;
  parameters: unknown;
}> {
  const choice = challenge.choices.find(
    ({ choiceId }) => choiceId === subject.choiceId,
  );
  if (choice === undefined) throw challengeUnavailable(challenge.challengeId);
  registry.renderTrustedChoice(choice);
  const normalized = registry.normalizeParameters(
    choice.transitionId,
    choice.parameters,
  );
  if (
    canonicalJson(normalized.parameters) !== canonicalJson(choice.parameters) ||
    normalized.definition.parameterSchemaDigest !==
      choice.parameterSchemaDigest ||
    normalized.definition.consequenceDigest !== choice.consequenceDigest ||
    normalized.definition.resolutionKind !== choice.resolutionKind
  ) {
    throw workflowError(
      'GRANT_TRANSITION_DEFINITION_CHANGED',
      `Transition ${choice.transitionId} no longer matches the challenge.`,
      ExitCode.staleState,
    );
  }
  return {
    choice,
    definition: normalized.definition,
    parameters: normalized.parameters,
  };
}

async function assertExpectedState(
  definition: RegisteredTransitionDefinition,
  parameters: unknown,
  expected: StateBinding,
  challengeId: string,
): Promise<void> {
  const observed = assertStateBinding(
    await definition.observeState(parameters, {
      challengeId,
      operationId: null,
    }),
  );
  if (observed.kind !== expected.kind || observed.digest !== expected.digest) {
    throw workflowError(
      'GRANT_STATE_CHANGED',
      'Protected state changed after the human decision; fresh approval is required.',
      ExitCode.staleState,
    );
  }
}

function trustedPresentation(
  challenge: GrantChallenge,
  registry: TransitionRegistry,
  policy: GrantPolicyV2,
): TrustedGrantPresentation {
  return freezeCanonical({
    challenge,
    failureCode: challenge.failureCode,
    facts: challenge.facts,
    expiresAt: challenge.expiresAt,
    approvalMethods: approvalMethodsForPolicy(policy),
    choices: challenge.choices.map((choice) => {
      const presentation = registry.renderTrustedChoice(choice);
      return {
        choiceId: choice.choiceId,
        transitionId: choice.transitionId,
        title: presentation.title,
        consequences: presentation.consequences,
        allowedApprovalMethods: choice.allowedApprovalMethods,
        allowedReasonCodes: choice.allowedReasonCodes,
        reasonRequired: choice.reasonRequired,
        proposedReason: choice.proposedReason,
      };
    }),
  });
}

function assertDecisionApprovalMethodAllowed(
  challenge: GrantChallenge,
  decision: GrantHumanDecision,
): void {
  const choice = challenge.choices.find(
    ({ choiceId }) => choiceId === decision.choiceId,
  );
  if (
    choice === undefined ||
    !choice.allowedApprovalMethods.includes(decision.approvalMethod)
  ) {
    throw workflowError(
      'GRANT_APPROVAL_METHOD_NOT_ALLOWED',
      'Selected grant approval method is not allowed for this transition.',
      ExitCode.guard,
    );
  }
}

function assertTransitionApprovalMethodAllowed(
  definition: RegisteredTransitionDefinition,
  method: GrantApprovalMethod,
): void {
  if (!definition.allowedApprovalMethods.includes(method)) {
    throw workflowError(
      'GRANT_APPROVAL_METHOD_NOT_ALLOWED',
      'Selected grant approval method is not allowed for this transition.',
      ExitCode.guard,
    );
  }
}

function assertHumanDecision(value: unknown): GrantHumanDecision {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'choiceId',
      'approvalMethod',
      'reasonCode',
      'reason',
      'sessionNonce',
    ]) ||
    typeof value.choiceId !== 'string' ||
    !SHA256_DIGEST.test(value.choiceId) ||
    !['human-presence', 'ssh'].includes(String(value.approvalMethod)) ||
    typeof value.reasonCode !== 'string' ||
    typeof value.reason !== 'string' ||
    typeof value.sessionNonce !== 'string'
  ) {
    throw workflowError(
      'GRANT_HUMAN_DECISION_INVALID',
      'Trusted Human Gate returned a malformed decision.',
      ExitCode.guard,
    );
  }
  return freezeCanonical(value) as unknown as GrantHumanDecision;
}

function assertStateBinding(value: unknown): StateBinding {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['kind', 'digest']) ||
    typeof value.kind !== 'string' ||
    !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(value.kind) ||
    typeof value.digest !== 'string' ||
    !SHA256_DIGEST.test(value.digest)
  ) {
    throw workflowError(
      'GRANT_STATE_BINDING_INVALID',
      'A registered transition returned an invalid state binding.',
      ExitCode.guard,
    );
  }
  return freezeCanonical(value) as unknown as StateBinding;
}

function executionResult(
  record: TerminalGrantRecord,
  recovered: boolean,
): GrantExecutionResult {
  const choice = record.challenge.choices.find(
    ({ choiceId }) => choiceId === record.approvalSubject.choiceId,
  );
  if (choice === undefined)
    throw challengeUnavailable(record.challenge.challengeId);
  return Object.freeze({
    challengeId: record.challenge.challengeId,
    operationId: record.operationId,
    transitionId: choice.transitionId,
    outcome: record.outcome.outcome,
    poststateDigest: record.poststateDigest,
    recovered,
  });
}

function exactUuid(value: string): string {
  if (!UUID_V4.test(value)) {
    throw workflowError(
      'GRANT_COORDINATOR_INVALID',
      'Grant coordinator generated an invalid identifier.',
      ExitCode.guard,
    );
  }
  return value;
}

function exactDate(value: Date): Date {
  const copy = copyGrantDate(value);
  if (copy === null) {
    throw workflowError(
      'GRANT_TIME_INVALID',
      'Grant coordinator time is invalid.',
      ExitCode.guard,
    );
  }
  return copy;
}

function challengeUnavailable(challengeId: string) {
  return workflowError(
    'GRANT_CHALLENGE_UNAVAILABLE',
    `Grant challenge ${challengeId} is not available.`,
    ExitCode.staleState,
  );
}

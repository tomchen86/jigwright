/**
 * Offers exact local or remote protected-base initialization through Grant Core.
 *
 * Invariants:
 * - Local approval binds the repository, source commit, and absent canonical ref.
 * - Only the selected remote transition observes the remote before authorization.
 * - Local execution and recovery use the existing durable Grant transaction.
 */
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { isRecord } from '../../foundation/canonical-json/contract-values.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import type { GrantRequestInput, StateBinding } from './grant-core.ts';
import {
  freezeGrantCanonical,
  grantHasExactKeys,
  grantSha256,
} from './grant-primitives.ts';
import {
  assertProtectedBaseInitializationParameters,
  expectedEmptyProtectedBaseObservation,
  protectedBaseInitializationGrantCandidate,
  protectedBaseInitializationGrantTransitionDefinitions,
  type ProtectedBaseInitializationObservationV1,
  type ProtectedBaseInitializationParametersV1,
} from './protected-base-initialization-grant.ts';
import type { TransitionDefinition } from './grant-transition-registry.ts';

export const LOCAL_PROTECTED_BASE_INITIALIZATION_TRANSITION_ID =
  'git.protected-base.local-initialize.v1' as const;

type LocalProtectedBaseIdentity = Readonly<{
  repositoryId: string;
  canonicalOrigin: string;
  ref: 'refs/jigwright/protected-base';
  sourceCommit: string;
  sourceTree: string;
}>;

export type LocalProtectedBaseParametersV1 = LocalProtectedBaseIdentity &
  Readonly<{
    schemaVersion: 1;
    kind: 'local-protected-base-initialization.v1';
  }>;

export type LocalProtectedBaseObservationV1 = LocalProtectedBaseIdentity &
  Readonly<{
    schemaVersion: 1;
    kind: 'local-protected-base-observation.v1';
    localCommit: string | null;
  }>;

export type ProtectedBaseSelectionObservationV1 = Readonly<{
  schemaVersion: 1;
  kind: 'protected-base-selection-observation.v1';
  local: LocalProtectedBaseObservationV1;
  remote: ProtectedBaseInitializationParametersV1 | null;
}>;

export type ProtectedBaseSelectionPort = Readonly<{
  observeLocal(): LocalProtectedBaseObservationV1;
  remoteParameters(): ProtectedBaseInitializationParametersV1 | null;
  observeRemote(): ProtectedBaseInitializationObservationV1;
  initializeLocal(
    parameters: LocalProtectedBaseParametersV1,
    recovered: boolean,
    assertOwned: () => void,
  ): 'created' | 'recovered';
}>;

const IDENTITY_KEYS = [
  'repositoryId',
  'canonicalOrigin',
  'ref',
  'sourceCommit',
  'sourceTree',
] as const;
const COMMIT_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

export function initialLocalProtectedBaseObservation(
  identity: Pick<
    LocalProtectedBaseIdentity,
    'repositoryId' | 'canonicalOrigin' | 'sourceCommit' | 'sourceTree'
  >,
): LocalProtectedBaseObservationV1 {
  return Object.freeze({
    schemaVersion: 1,
    kind: 'local-protected-base-observation.v1',
    repositoryId: identity.repositoryId,
    canonicalOrigin: identity.canonicalOrigin,
    ref: 'refs/jigwright/protected-base',
    sourceCommit: identity.sourceCommit,
    sourceTree: identity.sourceTree,
    localCommit: null,
  });
}

export function protectedBaseSelectionStateBinding(
  local: LocalProtectedBaseObservationV1,
): StateBinding {
  return Object.freeze({
    kind: 'protected-base-selection',
    digest: grantSha256(canonicalJson(assertLocalObservation(local))),
  });
}

export function createProtectedBaseSelectionGrantRequest(
  port: ProtectedBaseSelectionPort,
  proposedReason: string,
): GrantRequestInput {
  const local = assertLocalObservation(port.observeLocal());
  if (local.localCommit !== null) {
    throw workflowError(
      'PROTECTED_BASE_INITIALIZATION_NOT_APPLICABLE',
      'The local protected base already exists.',
      ExitCode.staleState,
    );
  }
  const remote = port.remoteParameters();
  const facts = assertProtectedBaseSelectionObservation({
    schemaVersion: 1,
    kind: 'protected-base-selection-observation.v1',
    local,
    remote,
  });
  const { localCommit: _localCommit, ...identity } = local;
  const parameters = assertLocalProtectedBaseParameters({
    ...identity,
    kind: 'local-protected-base-initialization.v1',
  });
  if (!boundedText(proposedReason)) {
    throw invalidSelection();
  }
  return freezeGrantCanonical({
    sourceModuleId: 'git-protected-base',
    failureCode: 'protected-base-unavailable',
    facts,
    stateBinding: protectedBaseSelectionStateBinding(local),
    candidates: [
      {
        transitionId: LOCAL_PROTECTED_BASE_INITIALIZATION_TRANSITION_ID,
        parameters,
        allowedReasonCodes: ['initialize-local-protected-base'],
        reasonRequired: true,
        proposedReason,
      },
      ...(remote === null
        ? []
        : [protectedBaseInitializationGrantCandidate(remote, proposedReason)]),
    ],
  });
}

export function protectedBaseSelectionGrantTransitionDefinitions(
  port: ProtectedBaseSelectionPort,
) {
  const local: TransitionDefinition<LocalProtectedBaseParametersV1> = {
    transitionId: LOCAL_PROTECTED_BASE_INITIALIZATION_TRANSITION_ID,
    parameterSchemaDigest: grantSha256(
      canonicalJson({
        kind: 'local-protected-base-initialization.schema.v1',
        required: ['schemaVersion', 'kind', ...IDENTITY_KEYS],
      }),
    ),
    consequenceDigest: grantSha256(
      'Create the exact absent local protected ref; managed archive atomically advances it with the work branch. No remote publication.',
    ),
    resolutionKind: 'non-retry',
    allowedApprovalMethods: ['human-presence', 'ssh'],
    validateParameters: assertLocalProtectedBaseParameters,
    renderTrustedChoice(parameters) {
      return {
        title: `Use ${parameters.ref} as the local protected base`,
        consequences: [
          `Create ${parameters.ref} at exact commit ${parameters.sourceCommit}; do not overwrite an existing ref.`,
          'Use this local ref for planning and advance it atomically when a verified managed change is archived.',
          'Do not push, fetch, create a pull request, or claim remote publication.',
        ],
      };
    },
    observeState() {
      return protectedBaseSelectionStateBinding(port.observeLocal());
    },
    async execute(context) {
      context.assertLifecycleOwned();
      if (context.recovered) {
        const observed = port.observeLocal();
        if (
          observed.localCommit !== context.parameters.sourceCommit &&
          (observed.localCommit !== null ||
            observed.sourceCommit !== context.parameters.sourceCommit ||
            observed.sourceTree !== context.parameters.sourceTree)
        ) {
          return {
            outcome: 'failed',
            details: {
              schemaVersion: 1,
              kind: 'local-protected-base-recovery-conflict.v1',
              ref: context.parameters.ref,
              requestedCommit: context.parameters.sourceCommit,
              observedCommit: observed.localCommit,
              priorInitializationEffect: 'unknown',
              recoveryEffectApplied: false,
            },
          };
        }
      }
      const disposition = port.initializeLocal(
        context.parameters,
        context.recovered,
        context.assertLifecycleOwned,
      );
      context.assertLifecycleOwned();
      return {
        outcome: 'completed',
        details: {
          schemaVersion: 1,
          kind: 'local-protected-base-initialized.v1',
          ref: context.parameters.ref,
          commit: context.parameters.sourceCommit,
          tree: context.parameters.sourceTree,
          disposition,
          remoteEffectApplied: false,
        },
      };
    },
  };
  const [remote] = protectedBaseInitializationGrantTransitionDefinitions({
    observe: () => port.observeRemote(),
  });
  return Object.freeze([
    Object.freeze(local),
    Object.freeze({
      ...remote!,
      observeState(parameters: ProtectedBaseInitializationParametersV1) {
        if (
          canonicalJson(port.observeRemote()) !==
          canonicalJson(expectedEmptyProtectedBaseObservation(parameters))
        ) {
          throw workflowError(
            'PROTECTED_BASE_INITIALIZATION_STATE_CHANGED',
            'The selected remote is no longer the exact empty protected-base target.',
            ExitCode.staleState,
          );
        }
        return protectedBaseSelectionStateBinding(port.observeLocal());
      },
    }),
  ]);
}

export function assertLocalProtectedBaseParameters(
  value: unknown,
): LocalProtectedBaseParametersV1 {
  if (
    !isRecord(value) ||
    !grantHasExactKeys(value, ['schemaVersion', 'kind', ...IDENTITY_KEYS]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'local-protected-base-initialization.v1' ||
    !boundedText(value.repositoryId) ||
    !boundedText(value.canonicalOrigin) ||
    value.ref !== 'refs/jigwright/protected-base' ||
    typeof value.sourceCommit !== 'string' ||
    !COMMIT_OID.test(value.sourceCommit) ||
    typeof value.sourceTree !== 'string' ||
    !COMMIT_OID.test(value.sourceTree)
  ) {
    throw invalidSelection();
  }
  return Object.freeze(value) as LocalProtectedBaseParametersV1;
}

export function assertProtectedBaseSelectionObservation(
  value: unknown,
): ProtectedBaseSelectionObservationV1 {
  if (
    !isRecord(value) ||
    !grantHasExactKeys(value, ['schemaVersion', 'kind', 'local', 'remote']) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'protected-base-selection-observation.v1'
  ) {
    throw invalidSelection();
  }
  const local = assertLocalObservation(value.local);
  const remote =
    value.remote === null
      ? null
      : assertProtectedBaseInitializationParameters(value.remote);
  if (
    remote !== null &&
    ['repositoryId', 'canonicalOrigin', 'sourceCommit', 'sourceTree'].some(
      (key) =>
        remote[key as keyof typeof remote] !== local[key as keyof typeof local],
    )
  ) {
    throw invalidSelection();
  }
  return freezeGrantCanonical({
    ...value,
    local,
    remote,
  }) as ProtectedBaseSelectionObservationV1;
}

function assertLocalObservation(
  value: unknown,
): LocalProtectedBaseObservationV1 {
  if (
    !isRecord(value) ||
    !grantHasExactKeys(value, [
      'schemaVersion',
      'kind',
      ...IDENTITY_KEYS,
      'localCommit',
    ]) ||
    value.kind !== 'local-protected-base-observation.v1' ||
    (value.localCommit !== null &&
      (typeof value.localCommit !== 'string' ||
        !COMMIT_OID.test(value.localCommit)))
  ) {
    throw invalidSelection();
  }
  const { localCommit, ...identity } = value;
  const parameters = assertLocalProtectedBaseParameters({
    ...identity,
    kind: 'local-protected-base-initialization.v1',
  });
  return Object.freeze({
    ...parameters,
    kind: 'local-protected-base-observation.v1',
    localCommit,
  }) as LocalProtectedBaseObservationV1;
}

function boundedText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 1024 &&
    value.trim() === value &&
    !/[\0\r\n]/u.test(value)
  );
}

function invalidSelection() {
  return workflowError(
    'PROTECTED_BASE_SELECTION_INVALID',
    'The protected-base selection does not match one exact repository, commit, and target.',
    ExitCode.guard,
  );
}

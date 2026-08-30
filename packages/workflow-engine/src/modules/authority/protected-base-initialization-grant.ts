import crypto from 'node:crypto';

import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { isRecord } from '../../foundation/canonical-json/contract-values.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import type { GrantRequestInput, StateBinding } from './grant-core.ts';
import type {
  AuthorizedTransitionContext,
  TransitionDefinition,
} from './grant-transition-registry.ts';

export const PROTECTED_BASE_INITIALIZATION_TRANSITION_ID =
  'git.protected-base.initialize-authorize.v1' as const;

const COMMIT_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SIMPLE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const BRANCH_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/;

export type ProtectedBaseInitializationObservationV1 = Readonly<{
  schemaVersion: 1;
  kind: 'protected-base-initialization-observation.v1';
  repositoryId: string;
  canonicalOrigin: string;
  remoteName: string;
  fetchUrl: string;
  pushUrl: string;
  protectedBranch: string;
  sourceCommit: string;
  sourceTree: string;
  remoteRefCount: number;
  remoteRefsDigest: `sha256:${string}`;
  remoteCommit: string | null;
  trackingCommit: string | null;
}>;

export type ProtectedBaseInitializationParametersV1 = Readonly<{
  schemaVersion: 1;
  kind: 'protected-base-initialization-authorization.v1';
  repositoryId: string;
  canonicalOrigin: string;
  remoteName: string;
  fetchUrl: string;
  pushUrl: string;
  protectedBranch: string;
  sourceCommit: string;
  sourceTree: string;
}>;

export type ProtectedBaseInitializationPort = Readonly<{
  observe(): ProtectedBaseInitializationObservationV1;
}>;

export function createProtectedBaseInitializationGrantRequest(
  port: ProtectedBaseInitializationPort,
  proposedReason: string,
): GrantRequestInput {
  const observation = port.observe();
  if (
    observation.remoteRefCount !== 0 ||
    observation.remoteCommit !== null ||
    observation.trackingCommit !== null
  ) {
    throw workflowError(
      'PROTECTED_BASE_INITIALIZATION_NOT_APPLICABLE',
      'Protected-base initialization is available only for an exact empty remote with no local tracking ref.',
      ExitCode.guard,
    );
  }
  return Object.freeze({
    sourceModuleId: 'git-protected-base',
    failureCode: 'protected-base-unavailable',
    facts: observation,
    stateBinding: protectedBaseInitializationStateBinding(observation),
    candidates: Object.freeze([
      Object.freeze({
        transitionId: PROTECTED_BASE_INITIALIZATION_TRANSITION_ID,
        parameters: parametersFromObservation(observation),
        allowedReasonCodes: Object.freeze(['initialize-empty-protected-base']),
        reasonRequired: true,
        proposedReason: assertBoundedText(proposedReason, 'proposed reason'),
      }),
    ]),
  });
}

export function protectedBaseInitializationGrantTransitionDefinitions(
  port: ProtectedBaseInitializationPort,
): readonly TransitionDefinition<ProtectedBaseInitializationParametersV1>[] {
  return Object.freeze([
    Object.freeze({
      transitionId: PROTECTED_BASE_INITIALIZATION_TRANSITION_ID,
      parameterSchemaDigest: digest(
        canonicalJson({
          schemaVersion: 1,
          kind: 'protected-base-initialization-authorization.schema.v1',
          required: [
            'repositoryId',
            'canonicalOrigin',
            'remoteName',
            'fetchUrl',
            'pushUrl',
            'protectedBranch',
            'sourceCommit',
            'sourceTree',
          ],
        }),
      ),
      consequenceDigest: digest(
        canonicalJson({
          schemaVersion: 1,
          kind: 'protected-base-initialization-authorization-consequence.v1',
          effect: 'authorize-one-exact-create-only-protected-ref-publication',
          remoteEffectApplied: false,
          forceOverwritePermitted: false,
        }),
      ),
      resolutionKind: 'non-retry',
      allowedApprovalMethods: ['human-presence', 'ssh'] as const,
      validateParameters: assertProtectedBaseInitializationParameters,
      renderTrustedChoice(parameters: ProtectedBaseInitializationParametersV1) {
        return Object.freeze({
          title: `Authorize initialization of ${parameters.protectedBranch} on the empty canonical remote`,
          consequences: Object.freeze([
            `Authorize exact commit ${parameters.sourceCommit} for create-only publication as refs/heads/${parameters.protectedBranch}.`,
            'Do not overwrite any remote ref and do not authorize a different local commit.',
            'This decision records authority only; the external publication executor remains a separate governed operation.',
          ]),
        });
      },
      observeState(parameters: ProtectedBaseInitializationParametersV1) {
        assertProtectedBaseInitializationParameters(parameters);
        return protectedBaseInitializationStateBinding(port.observe());
      },
      async execute(
        context: AuthorizedTransitionContext<ProtectedBaseInitializationParametersV1>,
      ) {
        context.assertLifecycleOwned();
        const observed = port.observe();
        assertSameInitializationIdentity(observed, context.parameters);
        if (
          observed.remoteRefCount !== 0 ||
          observed.remoteCommit !== null ||
          observed.trackingCommit !== null
        ) {
          throw workflowError(
            'PROTECTED_BASE_INITIALIZATION_STATE_CHANGED',
            'The protected base is no longer an exact empty-remote initialization candidate.',
            ExitCode.staleState,
          );
        }
        context.assertLifecycleOwned();
        return Object.freeze({
          outcome: 'completed' as const,
          details: Object.freeze({
            schemaVersion: 1,
            kind: 'protected-base-initialization-authorized.v1',
            protectedBranch: context.parameters.protectedBranch,
            sourceCommit: context.parameters.sourceCommit,
            remoteEffectApplied: false,
          }),
        });
      },
    }),
  ]);
}

function parametersFromObservation(
  observation: ProtectedBaseInitializationObservationV1,
): ProtectedBaseInitializationParametersV1 {
  return Object.freeze({
    schemaVersion: 1,
    kind: 'protected-base-initialization-authorization.v1',
    repositoryId: observation.repositoryId,
    canonicalOrigin: observation.canonicalOrigin,
    remoteName: observation.remoteName,
    fetchUrl: observation.fetchUrl,
    pushUrl: observation.pushUrl,
    protectedBranch: observation.protectedBranch,
    sourceCommit: observation.sourceCommit,
    sourceTree: observation.sourceTree,
  });
}

export function assertProtectedBaseInitializationParameters(
  value: unknown,
): ProtectedBaseInitializationParametersV1 {
  if (
    !isRecord(value) ||
    canonicalJson(Object.keys(value).sort()) !==
      canonicalJson(
        [
          'schemaVersion',
          'kind',
          'repositoryId',
          'canonicalOrigin',
          'remoteName',
          'fetchUrl',
          'pushUrl',
          'protectedBranch',
          'sourceCommit',
          'sourceTree',
        ].sort(),
      ) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'protected-base-initialization-authorization.v1' ||
    typeof value.repositoryId !== 'string' ||
    typeof value.canonicalOrigin !== 'string' ||
    typeof value.remoteName !== 'string' ||
    !SIMPLE_NAME.test(value.remoteName) ||
    typeof value.fetchUrl !== 'string' ||
    typeof value.pushUrl !== 'string' ||
    typeof value.protectedBranch !== 'string' ||
    !BRANCH_NAME.test(value.protectedBranch) ||
    value.protectedBranch.includes('..') ||
    typeof value.sourceCommit !== 'string' ||
    !COMMIT_OID.test(value.sourceCommit) ||
    typeof value.sourceTree !== 'string' ||
    !COMMIT_OID.test(value.sourceTree)
  ) {
    throw workflowError(
      'PROTECTED_BASE_INITIALIZATION_PARAMETERS_INVALID',
      'Protected-base initialization authorization parameters are malformed.',
      ExitCode.guard,
    );
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: 'protected-base-initialization-authorization.v1',
    repositoryId: assertBoundedText(value.repositoryId, 'repository ID'),
    canonicalOrigin: assertBoundedText(
      value.canonicalOrigin,
      'canonical origin',
    ),
    remoteName: value.remoteName,
    fetchUrl: assertBoundedText(value.fetchUrl, 'fetch URL'),
    pushUrl: assertBoundedText(value.pushUrl, 'push URL'),
    protectedBranch: value.protectedBranch,
    sourceCommit: value.sourceCommit,
    sourceTree: value.sourceTree,
  });
}

function assertSameInitializationIdentity(
  observation: ProtectedBaseInitializationObservationV1,
  expected: ProtectedBaseInitializationParametersV1,
): void {
  if (
    observation.repositoryId !== expected.repositoryId ||
    observation.canonicalOrigin !== expected.canonicalOrigin ||
    observation.remoteName !== expected.remoteName ||
    observation.fetchUrl !== expected.fetchUrl ||
    observation.pushUrl !== expected.pushUrl ||
    observation.protectedBranch !== expected.protectedBranch ||
    observation.sourceCommit !== expected.sourceCommit ||
    observation.sourceTree !== expected.sourceTree
  ) {
    throw workflowError(
      'PROTECTED_BASE_INITIALIZATION_STATE_CHANGED',
      'Protected-base initialization state changed; fresh Human Gate approval is required.',
      ExitCode.staleState,
    );
  }
}

export function protectedBaseInitializationStateBinding(
  observation: ProtectedBaseInitializationObservationV1,
): StateBinding {
  return Object.freeze({
    kind: 'protected-base-initialization',
    digest: digest(canonicalJson(observation)),
  });
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

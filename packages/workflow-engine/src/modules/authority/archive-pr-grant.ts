import crypto from 'node:crypto';

import type { CentralGrantCompletedAuthorityRefV1 } from '@jigwright/core/central-grant-port';

import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { isRecord } from '../../foundation/canonical-json/contract-values.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import {
  readArchivePublicationPreparation,
  type ArchivePublicationPreparationV1,
} from '../../runtime/storage-journal/archive-publication-store.ts';
import {
  readGrantRecord,
  type GrantStorePaths,
  type TerminalGrantRecord,
} from '../../runtime/storage-journal/grant-store.ts';
import type { GrantRequestInput, StateBinding } from './grant-core.ts';
import {
  grantTransitionPreconditionChanged,
  type AuthorizedTransitionContext,
  type TransitionDefinition,
} from './grant-transition-registry.ts';

export const ARCHIVE_PR_PUBLICATION_TRANSITION_ID =
  'github.archive-pr.publish' as const;
const PREPARATION_IDENTITY = /^sha256:[0-9a-f]{64}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const COMPLETED_GRANT_MAX_AGE_MS = 10 * 60_000;

export type ArchivePullRequestPublicationTargetV1 = Readonly<{
  schemaVersion: 1;
  kind: 'archive-pr-publication-target.v1';
  repositoryId: string;
  canonicalOrigin: string;
  remoteName: 'origin';
  apiBaseUrl: 'https://api.github.com';
  owner: string;
  repository: string;
  adapterConfigDigest: `sha256:${string}`;
}>;

export type ArchivePullRequestGrantParametersV1 = Readonly<{
  schemaVersion: 1;
  kind: 'archive-pr-publication-authorization.v1';
  preparationIdentity: `sha256:${string}`;
  publicationTarget: ArchivePullRequestPublicationTargetV1;
}>;

export type CompletedArchivePullRequestGrantReferenceV1 =
  CentralGrantCompletedAuthorityRefV1 &
    Readonly<{ transitionId: typeof ARCHIVE_PR_PUBLICATION_TRANSITION_ID }>;

export function createArchivePullRequestGrantRequest(
  runtimeRoot: string,
  preparationIdentity: string,
  publicationTarget: ArchivePullRequestPublicationTargetV1,
  proposedReason: string,
): GrantRequestInput {
  const preparation = readArchivePublicationPreparation(
    runtimeRoot,
    preparationIdentity,
  );
  const parameters = archiveGrantParameters(
    preparation.preparationIdentity,
    publicationTarget,
  );
  return Object.freeze({
    sourceModuleId: 'github-archive',
    failureCode: 'archive-pr-publication-requires-human-authorization',
    facts: Object.freeze({
      schemaVersion: 1,
      kind: 'archive-pr-publication-request.v1',
      repositoryId: preparation.repositoryId,
      changeId: preparation.changeId,
      preparationIdentity: preparation.preparationIdentity,
      publicationTarget,
      remoteName: preparation.protectedBase.remoteName,
      protectedBranch: preparation.protectedBase.branch,
      archiveBranch: preparation.archive.branch,
      archiveHead: preparation.archive.headCommit,
    }),
    stateBinding: preparationStateBinding(preparation, publicationTarget),
    candidates: Object.freeze([
      Object.freeze({
        transitionId: ARCHIVE_PR_PUBLICATION_TRANSITION_ID,
        parameters,
        allowedReasonCodes: Object.freeze(['publish-reviewed-archive']),
        reasonRequired: true,
        proposedReason,
      }),
    ]),
  });
}

export function archivePullRequestGrantTransitionDefinitions(
  runtimeRoot: string,
): readonly TransitionDefinition<ArchivePullRequestGrantParametersV1>[] {
  return Object.freeze([
    Object.freeze({
      transitionId: ARCHIVE_PR_PUBLICATION_TRANSITION_ID,
      parameterSchemaDigest: digest(
        canonicalJson({
          schemaVersion: 1,
          kind: 'archive-pr-publication-authorization-parameters.schema.v1',
          required: ['preparationIdentity', 'publicationTarget'],
        }),
      ),
      consequenceDigest: digest(
        canonicalJson({
          schemaVersion: 1,
          kind: 'archive-pr-publication-authorization-consequence.v1',
          effect: 'authorizes-one-exact-idempotent-publication-retry-family',
          remoteEffectApplied: false,
        }),
      ),
      resolutionKind: 'non-retry',
      allowedApprovalMethods: ['human-presence', 'ssh'] as const,
      validateParameters: assertArchiveGrantParameters,
      renderTrustedChoice(parameters: ArchivePullRequestGrantParametersV1) {
        const preparation = readArchivePublicationPreparation(
          runtimeRoot,
          parameters.preparationIdentity,
        );
        return Object.freeze({
          title: `Authorize archive PR publication for ${preparation.changeId}`,
          consequences: Object.freeze([
            `Permit publication of exact archive commit ${preparation.archive.headCommit}.`,
            `Permit only ${parameters.publicationTarget.canonicalOrigin} (${parameters.publicationTarget.owner}/${parameters.publicationTarget.repository}).`,
            'Do not approve, bypass, merge, force-update, or publish any different branch.',
          ]),
        });
      },
      observeState(parameters: ArchivePullRequestGrantParametersV1) {
        return preparationStateBinding(
          readArchivePublicationPreparation(
            runtimeRoot,
            parameters.preparationIdentity,
          ),
          parameters.publicationTarget,
        );
      },
      async execute(
        context: AuthorizedTransitionContext<ArchivePullRequestGrantParametersV1>,
      ) {
        context.assertLifecycleOwned();
        let preparation: ArchivePublicationPreparationV1;
        try {
          preparation = readArchivePublicationPreparation(
            runtimeRoot,
            context.parameters.preparationIdentity,
          );
        } catch {
          throw grantTransitionPreconditionChanged(
            'ARCHIVE_PR_PREPARATION_STALE',
            'The exact archive publication preparation is no longer available.',
          );
        }
        context.assertLifecycleOwned();
        return Object.freeze({
          outcome: 'completed' as const,
          details: Object.freeze({
            schemaVersion: 1,
            kind: 'archive-pr-publication-authorized.v1',
            preparationIdentity: preparation.preparationIdentity,
            publicationTargetDigest: digest(
              canonicalJson(context.parameters.publicationTarget),
            ),
            remoteEffectApplied: false,
          }),
        });
      },
    }),
  ]);
}

export function authenticateCompletedArchivePullRequestGrant(
  paths: GrantStorePaths,
  runtimeRoot: string,
  challengeId: string,
  preparationIdentity: string,
  publicationTarget: ArchivePullRequestPublicationTargetV1,
  now = new Date(),
): CompletedArchivePullRequestGrantReferenceV1 {
  try {
    return authenticateCompletedArchivePullRequestGrantUnsafe(
      paths,
      runtimeRoot,
      challengeId,
      preparationIdentity,
      publicationTarget,
      now,
    );
  } catch {
    throw grantInvalid();
  }
}

function authenticateCompletedArchivePullRequestGrantUnsafe(
  paths: GrantStorePaths,
  runtimeRoot: string,
  challengeId: string,
  preparationIdentity: string,
  publicationTarget: ArchivePullRequestPublicationTargetV1,
  now: Date,
): CompletedArchivePullRequestGrantReferenceV1 {
  const preparation = readArchivePublicationPreparation(
    runtimeRoot,
    preparationIdentity,
  );
  const record = readGrantRecord(paths, challengeId);
  if (record.state !== 'completed') throw grantInvalid();
  const terminal = record as TerminalGrantRecord;
  const choice = terminal.challenge.choices.find(
    ({ choiceId }) => choiceId === terminal.approvalSubject.choiceId,
  );
  const parameters = archiveGrantParameters(
    preparation.preparationIdentity,
    publicationTarget,
  );
  const expectedState = preparationStateBinding(preparation, publicationTarget);
  const completedAt = Date.parse(terminal.completedAt);
  const nowTime = now.getTime();
  if (
    terminal.challenge.sourceModuleId !== 'github-archive' ||
    terminal.challenge.failureCode !==
      'archive-pr-publication-requires-human-authorization' ||
    choice?.transitionId !== ARCHIVE_PR_PUBLICATION_TRANSITION_ID ||
    canonicalJson(choice.parameters) !== canonicalJson(parameters) ||
    terminal.challenge.stateBinding.kind !== expectedState.kind ||
    terminal.challenge.stateBinding.digest !== expectedState.digest ||
    terminal.approvalSubject.stateDigest !== expectedState.digest ||
    terminal.poststateDigest !== expectedState.digest ||
    !Number.isFinite(nowTime) ||
    !Number.isFinite(completedAt) ||
    completedAt > nowTime + 30_000 ||
    completedAt < nowTime - COMPLETED_GRANT_MAX_AGE_MS ||
    canonicalJson(terminal.outcome) !==
      canonicalJson({
        outcome: 'completed',
        details: {
          schemaVersion: 1,
          kind: 'archive-pr-publication-authorized.v1',
          preparationIdentity: preparation.preparationIdentity,
          publicationTargetDigest: digest(canonicalJson(publicationTarget)),
          remoteEffectApplied: false,
        },
      })
  ) {
    throw grantInvalid();
  }
  return Object.freeze({
    contractVersion: 'central-grant-completed-authority-ref.v1',
    challengeId: terminal.challenge.challengeId,
    challengeDigest: terminal.challenge.challengeDigest,
    transitionId: ARCHIVE_PR_PUBLICATION_TRANSITION_ID,
    operationId: terminal.operationId,
    terminalOutcomeDigest: digest(canonicalJson(terminal.outcome)),
  });
}

function archiveGrantParameters(
  preparationIdentity: string,
  publicationTarget: ArchivePullRequestPublicationTargetV1,
): ArchivePullRequestGrantParametersV1 {
  return assertArchiveGrantParameters({
    schemaVersion: 1,
    kind: 'archive-pr-publication-authorization.v1',
    preparationIdentity,
    publicationTarget,
  });
}

function assertArchiveGrantParameters(
  value: unknown,
): ArchivePullRequestGrantParametersV1 {
  if (
    !isRecord(value) ||
    JSON.stringify(Object.keys(value).sort()) !==
      JSON.stringify(
        [
          'schemaVersion',
          'kind',
          'preparationIdentity',
          'publicationTarget',
        ].sort(),
      ) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'archive-pr-publication-authorization.v1' ||
    typeof value.preparationIdentity !== 'string' ||
    !PREPARATION_IDENTITY.test(value.preparationIdentity)
  ) {
    throw workflowError(
      'ARCHIVE_PR_GRANT_PARAMETERS_INVALID',
      'Archive PR grant parameters are malformed.',
      ExitCode.guard,
    );
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: 'archive-pr-publication-authorization.v1',
    preparationIdentity: value.preparationIdentity as `sha256:${string}`,
    publicationTarget: assertArchivePublicationTarget(value.publicationTarget),
  });
}

function preparationStateBinding(
  preparation: ArchivePublicationPreparationV1,
  publicationTarget: ArchivePullRequestPublicationTargetV1,
): StateBinding {
  return Object.freeze({
    kind: 'archive-pr-publication-preparation',
    digest: digest(
      canonicalJson({
        schemaVersion: 1,
        kind: 'archive-pr-publication-state.v1',
        preparationIdentity: preparation.preparationIdentity,
        publicationTarget,
      }),
    ),
  });
}

export function assertArchivePublicationTarget(
  value: unknown,
): ArchivePullRequestPublicationTargetV1 {
  if (
    !isRecord(value) ||
    JSON.stringify(Object.keys(value).sort()) !==
      JSON.stringify(
        [
          'schemaVersion',
          'kind',
          'repositoryId',
          'canonicalOrigin',
          'remoteName',
          'apiBaseUrl',
          'owner',
          'repository',
          'adapterConfigDigest',
        ].sort(),
      ) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'archive-pr-publication-target.v1' ||
    typeof value.repositoryId !== 'string' ||
    !/^github:[A-Za-z0-9_-]+$/u.test(value.repositoryId) ||
    typeof value.owner !== 'string' ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u.test(value.owner) ||
    typeof value.repository !== 'string' ||
    !/^[A-Za-z0-9_.-]{1,100}$/u.test(value.repository) ||
    value.canonicalOrigin !==
      `https://github.com/${value.owner}/${value.repository}.git` ||
    value.remoteName !== 'origin' ||
    value.apiBaseUrl !== 'https://api.github.com' ||
    typeof value.adapterConfigDigest !== 'string' ||
    !SHA256.test(value.adapterConfigDigest)
  ) {
    throw workflowError(
      'ARCHIVE_PR_PUBLICATION_TARGET_INVALID',
      'Archive PR publication target is malformed or does not match its canonical GitHub identity.',
      ExitCode.guard,
    );
  }
  return Object.freeze(
    structuredClone(value),
  ) as ArchivePullRequestPublicationTargetV1;
}

function digest(value: string): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function grantInvalid() {
  return workflowError(
    'ARCHIVE_PR_CENTRAL_GRANT_INVALID',
    'Archive publication requires the canonical completed Central Grant record for this exact preparation.',
    ExitCode.staleState,
  );
}

/**
 * Registers the recoverable Central Grant exception for exact document obligations.
 *
 * Invariants:
 * - Approval binds the current task, implementation and document bytes.
 * - Recovery reuses the same durable exception and never claims the documents passed.
 *
 * Depends on: Required document disposition service, Grant transitions and core ID validation.
 * Failure modes: A stale candidate refuses execution; an interrupted write awaits receipt recovery.
 */
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { isRecord } from '../../foundation/canonical-json/contract-values.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import type {
  GrantRequestInput,
  StateBinding,
} from '../../modules/authority/grant-core.ts';
import {
  grantHasExactKeys,
  grantSha256,
} from '../../modules/authority/grant-primitives.ts';
import {
  grantTransitionPreconditionChanged,
  type TransitionDefinition,
} from '../../modules/authority/grant-transition-registry.ts';
import { assertSessionId } from '@jigwright/core/runtime-path-kernel';
import {
  SYSTEM_DOCUMENT_DISPOSITION_TRANSITION as TRANSITION,
  SYSTEM_DOCUMENT_DISPOSITION_REQUIRED,
} from '../../modules/source/document-disposition.ts';
import type { SystemDocumentDispositionService } from './system-document-dispositions.ts';

export const SYSTEM_DOCUMENT_GRANT_REASON = 'defer-system-document-obligations';
type Parameters = Readonly<{
  schemaVersion: 1;
  sessionId: string;
  candidateDigest: `sha256:${string}`;
}>;
const presentation = {
  title:
    'Continue this candidate with its document obligations explicitly skipped',
  consequences: [
    'Records skipped-by-grant for the exact affected contracts and design explanations.',
    'Does not mark a document review, contract validity check, or required test as passed.',
    'Changed implementation, document or delta bytes require a new decision.',
  ],
};

export function createSystemDocumentGrantService({
  observeSystemDocumentCandidate,
  recordSystemDocumentGrantException,
}: Pick<
  SystemDocumentDispositionService,
  'observeSystemDocumentCandidate' | 'recordSystemDocumentGrantException'
>) {
  function createSystemDocumentGrantRequest(
    cwd: string,
    sessionId: string,
  ): GrantRequestInput {
    const candidate = observeSystemDocumentCandidate(cwd, sessionId);
    return {
      sourceModuleId: 'system-documents',
      failureCode: 'system-documents.disposition-required',
      facts: { sessionId, documents: candidate.documents },
      stateBinding: binding(candidate.candidateDigest),
      candidates: [
        {
          transitionId: TRANSITION,
          parameters: {
            schemaVersion: 1,
            sessionId,
            candidateDigest: candidate.candidateDigest,
          },
          allowedReasonCodes: [SYSTEM_DOCUMENT_GRANT_REASON],
          reasonRequired: true,
          proposedReason:
            'Defer these exact document obligations while retaining their explicit skipped status.',
        },
      ],
    };
  }

  function systemDocumentGrantTransitionDefinitions(
    cwd: string,
    hooks: { afterExceptionRecorded?: () => void } = {},
  ): readonly TransitionDefinition<Parameters>[] {
    return [
      {
        transitionId: TRANSITION,
        parameterSchemaDigest: grantSha256(
          canonicalJson({
            schema: 'system-document-exception-parameters.v1',
            required: ['schemaVersion', 'sessionId', 'candidateDigest'],
          }),
        ),
        consequenceDigest: grantSha256(canonicalJson(presentation)),
        resolutionKind: 'non-retry',
        allowedApprovalMethods: ['human-presence', 'ssh'],
        validateParameters(value) {
          if (
            !isRecord(value) ||
            !grantHasExactKeys(value, [
              'schemaVersion',
              'sessionId',
              'candidateDigest',
            ]) ||
            value.schemaVersion !== 1 ||
            typeof value.sessionId !== 'string' ||
            typeof value.candidateDigest !== 'string' ||
            !/^sha256:[0-9a-f]{64}$/.test(value.candidateDigest)
          )
            throw workflowError(
              'GRANT_PARAMETERS_INVALID',
              'Document exception parameters must identify one exact task candidate.',
              ExitCode.guard,
            );
          assertSessionId(value.sessionId, () =>
            workflowError(
              'INVALID_SESSION_ID',
              `Invalid session ID: ${value.sessionId}`,
              ExitCode.usage,
            ),
          );
          return value as Parameters;
        },
        renderTrustedChoice: () => presentation,
        observeState: (parameters) =>
          binding(
            observeSystemDocumentCandidate(cwd, parameters.sessionId)
              .candidateDigest,
          ),
        async execute(context) {
          context.assertLifecycleOwned();
          const { sessionId, candidateDigest } = context.parameters;
          if (
            observeSystemDocumentCandidate(cwd, sessionId).candidateDigest !==
            candidateDigest
          )
            throw grantTransitionPreconditionChanged(
              'SYSTEM_DOCUMENT_GRANT_STALE',
              'The document exception candidate changed before execution.',
            );
          const reportId = recordSystemDocumentGrantException(
            cwd,
            sessionId,
            candidateDigest,
            {
              challengeId: context.challengeId,
              operationId: context.operationId,
              approvalSubjectDigest: context.approvalSubjectDigest,
            },
          );
          hooks.afterExceptionRecorded?.();
          context.assertLifecycleOwned();
          return {
            outcome: 'completed',
            details: {
              sessionId,
              candidateDigest,
              status: 'skipped-by-grant',
              reportId,
            },
          };
        },
      },
    ];
  }

  return {
    dispositionRequiredCode: SYSTEM_DOCUMENT_DISPOSITION_REQUIRED,
    createSystemDocumentGrantRequest,
    systemDocumentGrantTransitionDefinitions,
  };
}

function binding(digest: `sha256:${string}`): StateBinding {
  return { kind: 'system-document-candidate.v1', digest };
}

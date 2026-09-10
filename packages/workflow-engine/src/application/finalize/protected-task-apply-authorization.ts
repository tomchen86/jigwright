/**
 * Checks that protected task application has the exact prepared Central
 * Grant authorization.
 *
 * Invariants:
 * - The stored operation, approval subject, state binding and selected
 *   transition parameters must match the supplied binding.
 */
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import { approvalSubjectDigest } from '../../modules/authority/grant-core.ts';
import { grantSha256 } from '../../modules/authority/grant-primitives.ts';
import {
  assertProtectedTaskApplyParameters,
  PROTECTED_TASK_APPLY_CONSEQUENCE_DIGEST,
  PROTECTED_TASK_APPLY_PARAMETER_SCHEMA_DIGEST,
  PROTECTED_TASK_APPLY_TRANSITION_ID,
  type ProtectedTaskApplyFinalizationParametersV1,
} from '../../modules/authority/protected-task-apply-grant.ts';
import {
  parseProtectedTaskApplyAuthorizationBinding,
  type ProtectedTaskApplyAuthorizationBinding,
} from '../../runtime/repository-transaction/finalize-transaction.ts';
import {
  grantStorePaths,
  readGrantRecord,
} from '../../runtime/storage-journal/grant-store.ts';

export function assertPreparedProtectedTaskApplyAuthorization(
  runtimeRoot: string,
  candidate: ProtectedTaskApplyAuthorizationBinding,
  expectedParameters?: ProtectedTaskApplyFinalizationParametersV1,
): Readonly<{ parameters: ProtectedTaskApplyFinalizationParametersV1 }> {
  const binding = parseProtectedTaskApplyAuthorizationBinding(candidate);
  const record = readGrantRecord(
    grantStorePaths(runtimeRoot),
    binding.challengeId,
  );
  if (
    record.state !== 'prepared' ||
    record.operationId !== binding.operationId ||
    approvalSubjectDigest(record.approvalSubject) !==
      binding.approvalSubjectDigest ||
    record.challenge.sourceModuleId !== 'task-finalization' ||
    record.challenge.failureCode !== 'protected-task-apply-required' ||
    record.challenge.stateBinding.kind !== 'protected-task-apply-state.v1' ||
    record.challenge.stateBinding.digest !== binding.stateBindingDigest
  ) {
    throw protectedTaskApplyAuthorizationInvalid();
  }
  const choice = record.challenge.choices.find(
    ({ choiceId }) => choiceId === record.approvalSubject.choiceId,
  );
  if (
    choice === undefined ||
    choice.transitionId !== PROTECTED_TASK_APPLY_TRANSITION_ID ||
    choice.resolutionKind !== 'non-retry' ||
    choice.parameterSchemaDigest !==
      PROTECTED_TASK_APPLY_PARAMETER_SCHEMA_DIGEST ||
    choice.consequenceDigest !== PROTECTED_TASK_APPLY_CONSEQUENCE_DIGEST ||
    grantSha256(canonicalJson(choice.parameters)) !== binding.parametersDigest
  ) {
    throw protectedTaskApplyAuthorizationInvalid();
  }
  const parameters = assertProtectedTaskApplyParameters(choice.parameters);
  if (
    parameters.stateBindingDigest !== binding.stateBindingDigest ||
    parameters.commitMessage !== binding.commitMessage ||
    (expectedParameters !== undefined &&
      canonicalJson(parameters) !== canonicalJson(expectedParameters))
  ) {
    throw protectedTaskApplyAuthorizationInvalid();
  }
  return Object.freeze({ parameters });
}

function protectedTaskApplyAuthorizationInvalid() {
  return workflowError(
    'PROTECTED_TASK_APPLY_AUTHORIZATION_INVALID',
    'Protected Apply requires the exact current prepared Central Grant operation.',
    ExitCode.guard,
  );
}

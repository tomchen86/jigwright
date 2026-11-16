import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import { assertInvestigationCheckpointEnvelope } from '../investigation/domain/investigation-checkpoint-contract.ts';
import type {
  GroupDispositionsPayload,
  InvestigationCheckpointEnvelope,
  MainTermsPayload,
  WhyAnswersPayload,
} from '../investigation/domain/investigation-session-types.ts';
import type { InvestigationStatus } from './investigation-status.ts';

export function createInvestigationCheckpointEnvelope(
  status: InvestigationStatus,
  payload: MainTermsPayload,
): Extract<InvestigationCheckpointEnvelope, { kind: 'main-terms' }>;

export function createInvestigationCheckpointEnvelope(
  status: InvestigationStatus,
  payload: GroupDispositionsPayload,
): Extract<InvestigationCheckpointEnvelope, { kind: 'group-dispositions' }>;

export function createInvestigationCheckpointEnvelope(
  status: InvestigationStatus,
  payload: WhyAnswersPayload,
): Extract<InvestigationCheckpointEnvelope, { kind: 'why-answers' }>;

export function createInvestigationCheckpointEnvelope(
  status: InvestigationStatus,
  payload: MainTermsPayload | GroupDispositionsPayload | WhyAnswersPayload,
): InvestigationCheckpointEnvelope {
  if (status.checkpoint === null) {
    throw workflowError(
      'INVESTIGATION_CHECKPOINT_NOT_AVAILABLE',
      'The investigation is not waiting for caller input.',
      ExitCode.guard,
    );
  }
  const envelope = {
    schemaVersion: 1 as const,
    kind: status.checkpoint.kind,
    checkpointId: status.checkpoint.checkpointId,
    investigationId: status.investigationId,
    changeId: status.changeId,
    expectedRevision: status.revision,
    baseline: status.baseline,
    intentDigest: status.intentDigest,
    blindManifestDigest: status.blindManifestDigest,
    payload,
  };
  return assertInvestigationCheckpointEnvelope(envelope);
}

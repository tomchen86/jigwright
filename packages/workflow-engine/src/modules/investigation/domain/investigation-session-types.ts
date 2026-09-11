/**
 * Defines persisted investigation sessions, checkpoint payloads, and current-ref records.
 *
 * Invariants:
 * - Record fields and optionality remain compatible with the current persisted schemas.
 * - Milestones and blockers retain their exact checkpoint and human-resolution shapes.
 */
import { type ClassDisposition } from './class-disposition.ts';
import { type SampleAudit } from './class-sample-audit.ts';
import { type InvestigationDispositionInput } from './investigation-groups.ts';
import { type InvestigationMainTermInput } from './investigation-terms.ts';
import { type InvestigationWhyCheckpointAnswer } from '../manifest/investigation-why-domain.ts';
import { type InvestigationHumanActionBlocker } from './human-resolution-contract.ts';

export type InvestigationSessionState =
  | 'actor-resolution-required'
  | 'human-action-required'
  | 'awaiting-main-terms'
  | 'waiting-for-provider'
  | 'awaiting-group-dispositions'
  | 'awaiting-ledger-answers'
  | 'investigation-sealed';

export type InvestigationCheckpointKind =
  'main-terms' | 'group-dispositions' | 'why-answers';

export type MainTermsPayload = {
  reference: string;
  terms: InvestigationMainTermInput[];
};

export type GroupDispositionsPayload = {
  dispositions: InvestigationDispositionInput[];
  /**
   * Rationales that cover a class of groups at once. The engine expands each
   * into one disposition per member, so what the evidence records is unchanged;
   * what changes is how much an author had to write to say the same thing.
   */
  classes?: ClassDisposition[];
  /**
   * The hand review of the sampled members of each class. Every mechanical
   * guard checks the predicate; this is the part only a person can answer,
   * which is whether the written rationale is true of what those hits do.
   */
  sampleAudits?: SampleAudit[];
};

export type WhyAnswersPayload = {
  answers: InvestigationWhyCheckpointAnswer[];
};

export type InvestigationCheckpointEnvelope =
  | InvestigationCheckpointEnvelopeBase<'main-terms', MainTermsPayload>
  | InvestigationCheckpointEnvelopeBase<
      'group-dispositions',
      GroupDispositionsPayload
    >
  | InvestigationCheckpointEnvelopeBase<'why-answers', WhyAnswersPayload>;

type InvestigationCheckpointEnvelopeBase<
  Kind extends InvestigationCheckpointKind,
  Payload,
> = {
  schemaVersion: 1;
  kind: Kind;
  checkpointId: string;
  investigationId: string;
  changeId: string;
  expectedRevision: number;
  baseline: {
    head: string;
    tree: string;
  };
  intentDigest: string;
  blindManifestDigest: string;
  payload: Payload;
};

export type StoredInvestigationCheckpoint = {
  envelopeDigest: string;
  contributionDigest: string;
  envelope: InvestigationCheckpointEnvelope;
};

export type InvestigationScanSaturationAcceptanceEnvelope = {
  schemaVersion: 1;
  kind: 'scan-saturation-acceptance';
  investigationId: string;
  changeId: string;
  expectedRevision: number;
  baseline: {
    head: string;
    tree: string;
  };
  intentDigest: string;
  blindManifestDigest: string;
  saturatedTermIds: string[];
  acknowledgeIncompleteScan: true;
};

export type StoredInvestigationScanSaturationAcceptance = {
  envelopeDigest: string;
  envelope: InvestigationScanSaturationAcceptanceEnvelope;
};

export type BlindResultReference = {
  invocationId: string;
  requestDigest: string;
  outputDigest: string;
};

export type InvestigationSession = {
  schemaVersion: 1;
  investigationId: string;
  revision: number;
  /** Semantic evidence/materialization version; lifecycle-only blockers do not advance it. */
  semanticRevision: number;
  /** Every durable session CAS advances this clock exactly once. */
  lifecycleRevision: number;
  state: InvestigationSessionState;
  changeId: string;
  mandateBinding?: {
    schemaVersion: 1;
    mandateTaskId: string;
    mandateId: string;
    mandateDigest: string;
    changeId: string;
    externalAuditRoot: string;
  };
  repositoryRoot: string;
  gitCommonDirectory: string;
  branch: string | null;
  baseline: {
    head: string;
    tree: string;
  };
  intentDigest: string;
  planReviewCoveragePolicyDigest: string;
  blindManifestDigest: string;
  blindRequestDigest: string;
  blindInvocationIds: string[];
  currentBlindInvocationId: string;
  /**
   * A human-authored, baseline-bound acknowledgement that only the named
   * per-term scans are incomplete. Omitted for non-saturated and historical
   * investigations.
   */
  scanSaturationAcceptance?: StoredInvestigationScanSaturationAcceptance;
  milestones: {
    mainTerms: StoredInvestigationCheckpoint | null;
    blindResult: BlindResultReference | null;
    reviewerTermSourceNodeId: string | null;
    groupDispositions: StoredInvestigationCheckpoint | null;
    whyAnswers: StoredInvestigationCheckpoint | null;
  };
  blocker:
    | {
        state: 'actor-resolution-required' | 'human-action-required';
        code: string;
      }
    | InvestigationHumanActionBlocker
    | null;
  createdAt: string;
  updatedAt: string;
};

export type CurrentInvestigationRef = {
  schemaVersion: 1;
  changeId: string;
  investigationId: string;
};

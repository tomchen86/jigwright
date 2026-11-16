/** Canonical investigation lifecycle status, including provider progress observations. */
import type {
  InvestigationCheckpointKind,
  InvestigationSessionState,
} from '../investigation/domain/investigation-session-types.ts';
import type {
  ProviderInvocationFailure,
  ProviderInvocationRecord,
} from '../provider-orchestration/provider-invocation-record.ts';
import type { ProviderInvocationActivity } from '../provider-orchestration/provider-invocation-activity.ts';
export type InvestigationStatus = {
  kind: 'investigation';
  investigationId: string;
  changeId: string;
  revision: number;
  semanticRevision: number;
  lifecycleRevision: number;
  state: InvestigationSessionState;
  baseline: {
    head: string;
    tree: string;
  };
  intentDigest: string;
  blindManifestDigest: string;
  providerInvocationId: string;
  provider: {
    state: ProviderInvocationRecord['state'];
    providerId: ProviderInvocationRecord['providerId'];
    attempt: number;
    revision: number;
    leaseGeneration: number;
    leaseExpiresAt: string | null;
    failure: ProviderInvocationFailure | null;
    resultDigest: string | null;
    activity: ProviderInvocationActivity;
  };
  checkpoint: {
    schemaVersion: 1;
    kind: InvestigationCheckpointKind;
    checkpointId: string;
  } | null;
  nextAction:
    | 'submit-main-terms'
    | 'wait-for-provider'
    | 'resume-provider-result'
    | 'expire-provider-lease'
    | 'retry-provider'
    | 'reconcile-repository'
    | 'submit-group-dispositions'
    | 'submit-why-answers'
    | 'resolve-actor'
    | 'human-action'
    | 'investigation-complete';
};

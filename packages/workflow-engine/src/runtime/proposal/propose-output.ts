import type { resolveActorIdentity } from '../../modules/authority/actor-identity.ts';
import type { CollaborationGrantRequest } from '../../modules/authority/collaboration-grant-codec.ts';
import type { OrdinaryProposeOutput } from '../../modules/proposal/propose-types.ts';

export function collaborationGrantRequiredOutput(input: {
  changeId: string;
  actorResolution: Extract<
    ReturnType<typeof resolveActorIdentity>,
    { outcome: 'resolved' }
  >;
  grantRequest: CollaborationGrantRequest | null;
  lifecyclePhase: 'blind-survey' | 'plan-review';
  conflictingRole: 'plan-reviewer';
}): OrdinaryProposeOutput {
  return {
    schemaVersion: 1,
    kind: 'workflow-propose',
    changeId: input.changeId,
    state: 'human-action-required',
    nextAction: 'human-action',
    investigation: null,
    createdDate: new Date().toISOString().slice(0, 10),
    actorResolution: {
      outcome: 'resolved',
      providerId: input.actorResolution.actor.providerId,
      assurance: input.actorResolution.actor.assurance,
      signals: input.actorResolution.signals,
    },
    inputSchema: {
      schemaVersion: 1,
      kind: 'collaboration-grant-selection',
      lifecyclePhase: input.lifecyclePhase,
      conflictingRole: input.conflictingRole,
      grantRequest: input.grantRequest,
      allowedDegradedForms:
        input.grantRequest === null
          ? ['caller-supplied']
          : ['same-provider-fresh-session'],
      resumeOption: '--grant <grant-id>',
    },
    work: null,
    materializedArtifacts: null,
    planReview: null,
    planningTransition: null,
    semanticReuse: null,
    classSampleAudits: [],
    floorTrimming: { dropped: [], escalated: false },
  };
}

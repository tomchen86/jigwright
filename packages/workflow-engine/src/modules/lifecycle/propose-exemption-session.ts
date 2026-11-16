/** Canonical durable proposal exemption identity and lifecycle data. */
import type { ProviderId } from '../provider-orchestration/provider-registry.ts';
import type { ActorSignal } from '../authority/actor-identity.ts';
import type { EvidenceNode } from '../../foundation/evidence-node/evidence-node.ts';
import type { InvestigationExemption } from '../investigation/domain/investigation-applicability.ts';
import type { NormalizedChangeIntent } from '../source/change-intent.ts';
import type { TaskMandateBinding } from '../authority/task-mandate-contract.ts';
export type ProposeExemptionActor = {
  providerId: ProviderId;
  assurance: 'self-declared' | 'runtime-hint' | 'adapter-assigned';
};

export type ProposeExemptionSession = {
  schemaVersion: 1;
  kind: 'propose-exemption-session';
  investigationId: string;
  revision: 0;
  state: 'investigation-exempt';
  changeId: string;
  mandateBinding?: TaskMandateBinding;
  repositoryRoot: string;
  gitCommonDirectory: string;
  branch: string | null;
  baseline: { head: string; tree: string };
  intentDigest: string;
  intent: NormalizedChangeIntent;
  applicability: InvestigationExemption;
  applicabilityNode: EvidenceNode;
  actor: ProposeExemptionActor;
  signals: ActorSignal[];
  createdAt: string;
};

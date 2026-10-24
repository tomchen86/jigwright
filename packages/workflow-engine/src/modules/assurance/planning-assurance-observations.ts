import type { RoleResultAdmission } from '../provider-orchestration/role-result-admission.ts';
import type { CollaborationGrantCodec } from '../authority/collaboration-grant-codec.ts';
import type { PlanReviewChallengeClosureSignatureVerifier } from './plan-review-disposition.ts';
/** Semantic observations required by planning assurance; each call observes the current source. */
import type { PlanReviewTargetSnapshot } from './plan-review-target-snapshot-record.ts';
import type { MaintainerPolicy } from '../authority/maintainer-policy.ts';
import type { PlanReviewCoverageTargetReader } from './plan-review-coverage.ts';

export type PlanningAssuranceEvidenceObservations = Readonly<{
  readRepositoryCitation(
    repositoryRoot: string,
    tree: string,
    repositoryPath: string,
  ): { blobOid: string; content: string };
  readPlanningSnapshotOrigin(
    repositoryRoot: string,
    snapshot: PlanReviewTargetSnapshot,
  ): string | null;
  readPlanningSnapshotArtifact(
    repositoryRoot: string,
    commit: string | null,
    artifactPath: string,
  ): Buffer;
}>;

export type PlanningAssuranceRoleAdmission = Readonly<{
  roleAdmission: Pick<
    RoleResultAdmission,
    | 'admitConsumedRoleContextSharingResultReplay'
    | 'admitConsumedRoleResultReplay'
    | 'admitRoleResult'
    | 'assertAdmittedRoleResultRecord'
  >;
  grantCodec: Pick<
    CollaborationGrantCodec,
    | 'canonicalCollaborationGrantEnvelope'
    | 'parseCollaborationGrantEnvelope'
    | 'directHumanReviewAttestationDigest'
  >;
}>;

export type PlanningAssuranceDependencies = PlanningAssuranceObservations &
  PlanningAssuranceRoleAdmission &
  Readonly<{
    verifyChallengeClosureSignature: PlanReviewChallengeClosureSignatureVerifier;
  }>;

export type PlanningAssuranceObservations =
  PlanningAssuranceEvidenceObservations &
    Readonly<{
      readCurrentSchema(repositoryRoot: string): string;
      readPlanningArtifact(
        repositoryRoot: string,
        artifactPath: string,
      ): string;
      readPlanningSchemaDigest(
        repositoryRoot: string,
        schemaPath: string,
      ): string;
      loadMaintainerPolicyAtCommit(
        repositoryRoot: string,
        commit: string,
      ): MaintainerPolicy;
      readCoverageTarget: PlanReviewCoverageTargetReader;
    }>;

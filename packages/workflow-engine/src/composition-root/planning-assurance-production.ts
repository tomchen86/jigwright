import { PLAN_REVIEW_CHALLENGE_CLOSURE_NAMESPACE } from '../modules/assurance/plan-review.ts';
import { planningAssuranceObservations } from '../runtime/repository-observation/planning-assurance.ts';
import { collaborationGrantCodec } from '../runtime/grants/grant-services.ts';
import { roleResultAdmission } from './role-admission-production.ts';
import type { PlanningAssuranceDependencies } from '../modules/assurance/planning-assurance-observations.ts';
import { canonicalPlanReviewChallengeClosurePayload } from '../modules/assurance/plan-review-disposition.ts';
import { verifySshSignatureWithPublicKey } from '../adapters/signing/ssh/maintainer-signer.ts';
/**
 * Binds planning assurance to actual current role policy observations.
 *
 * Invariants:
 * - Every evaluation reads its policy pair and passes explicit presence or absence to the domain.
 */
import type { PlanningAssurancePort } from '../modules/assurance/planning-assurance-port.ts';
import {
  createTaskPlanningAssuranceBinding,
  deriveInvestigationFirstPlanningSubject,
  validateInvestigationFirstPlanningReadiness,
} from '../modules/assurance/planning-assurance-validator.ts';
import { readCurrentPlanningRoleOverridePolicy } from '../runtime/repository-transaction/planning-role-provider-policy-reader.ts';

export const planningAssuranceDependencies: PlanningAssuranceDependencies =
  Object.freeze({
    ...planningAssuranceObservations,
    roleAdmission: roleResultAdmission,
    grantCodec: collaborationGrantCodec,
    verifyChallengeClosureSignature({ authority, publicKey }) {
      verifySshSignatureWithPublicKey(
        canonicalPlanReviewChallengeClosurePayload(authority),
        authority.signature,
        authority.signer,
        publicKey,
        PLAN_REVIEW_CHALLENGE_CLOSURE_NAMESPACE,
      );
    },
  });

export const productionPlanningAssurance: PlanningAssurancePort = Object.freeze(
  {
    createTaskBinding(contract, summary) {
      return createTaskPlanningAssuranceBinding(
        collaborationGrantCodec,
        contract,
        summary,
      );
    },
    deriveSubject(repositoryRoot, contract) {
      return deriveInvestigationFirstPlanningSubject(
        planningAssuranceDependencies,
        repositoryRoot,
        contract,
        readCurrentPlanningRoleOverridePolicy(
          repositoryRoot,
          contract.changeId,
        ),
      );
    },
    validateReadiness(repositoryRoot, contract, consumedPlanReviewReplay) {
      return validateInvestigationFirstPlanningReadiness(
        planningAssuranceDependencies,
        repositoryRoot,
        contract,
        consumedPlanReviewReplay,
        readCurrentPlanningRoleOverridePolicy(
          repositoryRoot,
          contract.changeId,
        ),
      );
    },
  },
);

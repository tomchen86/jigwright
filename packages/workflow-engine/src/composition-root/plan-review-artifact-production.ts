/** Binds tracked PlanReview shape admission to the required role admission service. */
import {
  parsePlanReviewArtifact as parseWithAdmission,
  type PlanReviewArtifactParser,
} from '../modules/assurance/plan-review-artifact.ts';
import { roleResultAdmission } from './role-admission-production.ts';
export const parsePlanReviewArtifact: PlanReviewArtifactParser =
  parseWithAdmission.bind(undefined, roleResultAdmission);

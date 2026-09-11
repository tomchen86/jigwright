/** Canonical provider invocation manifest DTOs; field and wire semantics are unchanged. */
import type { BlindSurveyManifest } from '../investigation/manifest/blind-survey-manifest.ts';
import type {
  PlanReviewManifest,
  TaskDiffReviewContinuationManifest,
  TaskDiffReviewManifest,
} from '../assurance/provider-review-manifests.ts';
import type { TaskStrategyImplementationManifest } from './task-strategy-implementation-manifest.ts';

export type ProviderInvocationManifest =
  | BlindSurveyManifest
  | PlanReviewManifest
  | TaskDiffReviewManifest
  | TaskDiffReviewContinuationManifest
  | TaskStrategyImplementationManifest;

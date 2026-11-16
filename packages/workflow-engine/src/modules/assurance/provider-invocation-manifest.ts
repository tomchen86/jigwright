/** The complete set of provider invocation manifest variants. */
import type { BlindSurveyManifest } from '../investigation/manifest/blind-survey-manifest.ts';
import type {
  PlanReviewManifest,
  TaskDiffReviewManifest,
  TaskDiffReviewContinuationManifest,
} from './provider-review-manifests.ts';
import type { TaskStrategyImplementationManifest } from '../provider-orchestration/task-strategy-implementation-manifest.ts';

export type ProviderInvocationManifest =
  | BlindSurveyManifest
  | PlanReviewManifest
  | TaskDiffReviewManifest
  | TaskDiffReviewContinuationManifest
  | TaskStrategyImplementationManifest;

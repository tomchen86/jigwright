/** Canonical blind survey manifest DTOs; field and wire semantics are unchanged. */
import type { NormalizedChangeIntent } from '../../source/change-intent.ts';

export type BlindSurveyManifest = {
  schemaVersion: 1;
  kind: 'blind-survey-manifest';
  changeId: string;
  repositoryId: string;
  baseCommit: string;
  baseTree: string;
  normalizedIntent: NormalizedChangeIntent;
  architectureQuestion: string;
  capabilityProfile: 'repository-read-only';
};

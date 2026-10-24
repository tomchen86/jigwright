import type { BlindSurveyManifest } from '../src/modules/investigation/manifest/blind-survey-manifest.ts';
import { git } from './fixture.ts';

export const CHANGE_ID = 'demo-change';

export function createManifest(
  repository: string,
  investigationId: string,
): BlindSurveyManifest {
  return {
    schemaVersion: 1,
    kind: 'blind-survey-manifest',
    changeId: CHANGE_ID,
    repositoryId: 'fixture',
    baseCommit: git(repository, ['rev-parse', 'HEAD']).trim(),
    baseTree: git(repository, ['rev-parse', 'HEAD^{tree}']).trim(),
    normalizedIntent: {
      schemaVersion: 1,
      summary: `Retain provider history for ${investigationId}.`,
      sourceRefs: [],
      explicitPaths: [
        'packages/workflow-engine/src/runtime/provider-execution/provider-retention.ts',
      ],
      explicitSymbols: ['pruneProviderRuntime'],
      explicitConfigKeys: [],
      renamePairs: [],
    },
    architectureQuestion: 'Which private provider runtime may be pruned?',
    capabilityProfile: 'repository-read-only',
  };
}

import crypto from 'node:crypto';

import { createOpenSpecAdapter } from './openspec-adapter-production.ts';
import { OPENSPEC_ASSET_DEFINITIONS } from '../adapters/planning/openspec/documents/openspec-planning-asset-contract.ts';
import { ExitCode, workflowError } from '../foundation/errors/errors.ts';
import type {
  PlanningProviderAuthoringPort,
  PlanningProviderReviewedAssetMirror,
} from '../modules/planning-provider/planning-provider-authoring-port.ts';
import { repositoryPlanningConfiguration } from '../modules/repository-consumer/repository-consumer-config.ts';

export function createPlanningProviderAuthoringPort(
  repositoryRoot: string,
): PlanningProviderAuthoringPort {
  const planning = repositoryPlanningConfiguration(repositoryRoot);
  if (planning.providerId !== 'openspec') {
    throw workflowError(
      'PLANNING_PROVIDER_UNSUPPORTED',
      'The configured planning provider has no production authoring adapter.',
      ExitCode.guard,
    );
  }
  const adapter = createOpenSpecAdapter(repositoryRoot);
  return Object.freeze({
    providerId: planning.providerId,
    instruction(changeId, contractName, artifactId) {
      const instruction = adapter.instructions(
        changeId,
        contractName,
        artifactId,
      );
      return Object.freeze({
        outputPath: instruction.outputPath,
        instruction: instruction.instruction,
        template: instruction.template,
      });
    },
    inspectStatus(changeId, contractName) {
      const status = adapter.status(changeId, contractName);
      return Object.freeze({
        isComplete: status.isComplete,
        artifacts: Object.freeze(
          status.artifacts.map(({ id, status: artifactStatus }) =>
            Object.freeze({ id, status: artifactStatus }),
          ),
        ),
      });
    },
  });
}

export function planningProviderReviewedAssetMirrors(
  repositoryRoot: string,
): readonly PlanningProviderReviewedAssetMirror[] {
  const planning = repositoryPlanningConfiguration(repositoryRoot);
  if (planning.providerId !== 'openspec') {
    throw workflowError(
      'PLANNING_PROVIDER_UNSUPPORTED',
      'The configured planning provider has no reviewed asset definition.',
      ExitCode.guard,
    );
  }
  return Object.freeze(
    OPENSPEC_ASSET_DEFINITIONS.flatMap((asset) => {
      if (asset.mirrorOf === null) return [];
      const reference = `OPENSPEC_ASSET_DEFINITIONS:${asset.mirrorOf}->${asset.destinationPath}`;
      return [
        Object.freeze({
          relationshipId: `openspec-asset-mirror:${sha256(reference)}`,
          mirrorOf: asset.mirrorOf,
          destinationPath: asset.destinationPath,
          reference,
        }),
      ];
    }).sort((left, right) =>
      left.relationshipId.localeCompare(right.relationshipId),
    ),
  );
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

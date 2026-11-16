/** Coordinates explicit guidance projections and guards config drift before writes. */
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import { renderAgentGuidanceRules } from '../../modules/guidance/catalog/agent-rule-registry.ts';
import { createProjectionService } from '../../modules/projection/projection-service.ts';
import {
  AGENT_GUIDANCE_CONFIG,
  PROJECTION_ID,
  CONVENTIONAL_TARGETS,
  parseAgentGuidanceConfiguration,
  parseAgentGuidanceTarget,
  guidanceSourceContent,
  renderGuidanceConfiguration,
  guidanceDiff,
  invalidConfig,
  type AgentGuidanceStorage,
  type AgentGuidanceTarget,
  type AgentGuidanceOptions,
} from '../../modules/adoption/agent-guidance.ts';
export function createAgentGuidanceService(
  storage: AgentGuidanceStorage,
  readSourceText: (ref: string) => string,
  printDiff: (diff: string) => void,
) {
  function guidanceSuggestions(): string[] {
    return CONVENTIONAL_TARGETS.filter((target) =>
      storage.isRegularFile(target),
    );
  }
  function readAgentGuidanceTargets(): AgentGuidanceTarget[] {
    return readAgentGuidanceConfiguration().targets;
  }
  function readAgentGuidanceConfiguration() {
    // Preserve config read/UTF-8 errors versus JSON/shape errors at their old boundaries.
    storage.assertTarget(AGENT_GUIDANCE_CONFIG);
    let value: unknown;
    try {
      const text = storage.read(AGENT_GUIDANCE_CONFIG);
      if (text === null) return { targets: [] };
      value = JSON.parse(text);
    } catch {
      throw invalidConfig('must contain valid JSON');
    }
    const parsed = parseAgentGuidanceConfiguration(value);
    for (const target of parsed.targets) storage.assertTarget(target.path);
    return parsed;
  }
  function installAgentGuidance(
    requestedTargets: readonly (string | AgentGuidanceTarget)[] = [],
    options: AgentGuidanceOptions = {},
  ) {
    if (requestedTargets.length === 0) {
      return {
        action: 'install',
        targets: [],
        suggestions: guidanceSuggestions(),
        confirmationRequired: true,
      };
    }
    const existingConfig = readAgentGuidanceConfiguration();
    const requested = new Map<string, AgentGuidanceTarget>();
    for (const value of requestedTargets) {
      const target = parseAgentGuidanceTarget(
        typeof value === 'string' ? { path: value } : value,
      );
      storage.assertTarget(target.path);
      requested.set(target.path, target);
    }
    // Validate every destination, including config, before projecting any target.
    storage.assertTarget(AGENT_GUIDANCE_CONFIG);
    const config = renderGuidanceConfiguration(existingConfig, [
      ...requested.values(),
    ]);
    const previousConfig = storage.read(AGENT_GUIDANCE_CONFIG);
    const onDiff = options.onDiff ?? printDiff;
    const assertConfigUnchanged = () => {
      const current = storage.read(AGENT_GUIDANCE_CONFIG);
      if (current !== previousConfig) {
        throw workflowError(
          'AGENT_GUIDANCE_CONFIG_CHANGED',
          'Guidance target configuration changed after its diff was prepared.',
          ExitCode.verification,
        );
      }
    };
    let configPreviewed = false;
    const previewConfig = () => {
      if (previousConfig !== config && !configPreviewed) {
        onDiff(guidanceDiff(AGENT_GUIDANCE_CONFIG, previousConfig, config));
        configPreviewed = true;
      }
    };
    const targets = guidanceService([...requested.values()], {
      onDiff(diff) {
        previewConfig();
        onDiff(diff);
        assertConfigUnchanged();
      },
    }).project(PROJECTION_ID, { install: true, heading: '## Jigwright' });
    if (previousConfig !== config) {
      previewConfig();
      assertConfigUnchanged();
      storage.write(AGENT_GUIDANCE_CONFIG, config);
    }
    return {
      action: 'install',
      targets,
      confirmationRequired: false,
      suggestions: [],
    };
  }

  function refreshAgentGuidance(options: AgentGuidanceOptions = {}) {
    return {
      action: 'refresh',
      targets: guidanceService(readAgentGuidanceTargets(), options).project(
        PROJECTION_ID,
      ),
    };
  }

  function removeAgentGuidance(options: AgentGuidanceOptions = {}) {
    // Keep the target declaration so status can report intentional removal.
    return {
      action: 'remove',
      targets: guidanceService(readAgentGuidanceTargets(), options).remove(
        PROJECTION_ID,
      ),
    };
  }

  function statusAgentGuidance() {
    return {
      action: 'status',
      targets: guidanceService(readAgentGuidanceTargets()).status(),
    };
  }

  function guidanceService(
    targets: readonly AgentGuidanceTarget[],
    options: AgentGuidanceOptions = {},
  ) {
    const onDiff = options.onDiff ?? printDiff;
    return createProjectionService(
      [
        {
          id: PROJECTION_ID,
          source: () => {
            const { sourceRefs = [] } = readAgentGuidanceConfiguration();
            const content = guidanceSourceContent(
              sourceRefs.map(readSourceText),
              renderAgentGuidanceRules(),
            );
            return targets.map((target) => ({ path: target.path, content }));
          },
        },
      ],
      {
        read: storage.read,
        beforeWrite(change) {
          onDiff(
            guidanceDiff(
              change.path,
              change.before ?? null,
              change.after ?? null,
            ),
          );
        },
        write: storage.write,
      },
    );
  }

  return Object.freeze({
    guidanceSuggestions,
    readAgentGuidanceTargets,
    installAgentGuidance,
    refreshAgentGuidance,
    removeAgentGuidance,
    statusAgentGuidance,
  });
}

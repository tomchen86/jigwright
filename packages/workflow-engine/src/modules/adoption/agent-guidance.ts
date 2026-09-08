import fs from 'node:fs';
import path from 'node:path';

import { normalizeExactRepositoryPath } from '@jigwright/core/repository-path';
import { assertPolicyPathInsideRepository } from '@jigwright/core/runtime-path-kernel';

import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import { replaceTextAtomic } from '../../foundation/filesystem/atomic-text.ts';
import { renderAgentGuidanceRules } from '../guidance/catalog/agent-rule-registry.ts';
import { readGovernanceSource } from '../governance-intake/governance-intake.ts';
import { createProjectionService } from '../projection/projection-service.ts';

export const AGENT_GUIDANCE_CONFIG = 'workflow/agent-guidance.json';
const PROJECTION_ID = 'guidance.agent-section';
const CONVENTIONAL_TARGETS = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md'];

export type AgentGuidanceTarget = { path: string; label?: string };
export type AgentGuidanceOptions = { onDiff?: (diff: string) => void };

export function guidanceSuggestions(repositoryRoot: string): string[] {
  return CONVENTIONAL_TARGETS.filter((target) => {
    try {
      return fs.lstatSync(checkedPath(repositoryRoot, target)).isFile();
    } catch {
      return false;
    }
  });
}

export function readAgentGuidanceTargets(
  repositoryRoot: string,
): AgentGuidanceTarget[] {
  return readAgentGuidanceConfiguration(repositoryRoot).targets;
}

function readAgentGuidanceConfiguration(repositoryRoot: string): {
  targets: AgentGuidanceTarget[];
  sourceRefs?: string[];
} {
  const configPath = checkedPath(repositoryRoot, AGENT_GUIDANCE_CONFIG);
  if (!fs.existsSync(configPath)) return { targets: [] };
  let config: unknown;
  try {
    config = JSON.parse(readUtf8(configPath));
  } catch {
    throw invalidConfig('must contain valid JSON');
  }
  if (
    !config ||
    typeof config !== 'object' ||
    !('targets' in config) ||
    !Array.isArray(config.targets)
  ) {
    throw invalidConfig('must contain a targets array');
  }
  const targets = config.targets.map((target: unknown) =>
    parseTarget(repositoryRoot, target),
  );
  if (new Set(targets.map((target) => target.path)).size !== targets.length) {
    throw invalidConfig(
      'target paths must be unique; labels do not identify targets',
    );
  }
  if ('sourceRefs' in config) {
    if (
      !Array.isArray(config.sourceRefs) ||
      !config.sourceRefs.every(
        (ref: unknown) =>
          typeof ref === 'string' && /^SRC-[a-f0-9]{64}$/u.test(ref),
      ) ||
      new Set(config.sourceRefs).size !== config.sourceRefs.length
    ) {
      throw invalidConfig('sourceRefs must contain unique Source references');
    }
    return { targets, sourceRefs: config.sourceRefs };
  }
  return { targets };
}

export function installAgentGuidance(
  repositoryRoot: string,
  requestedTargets: readonly (string | AgentGuidanceTarget)[] = [],
  options: AgentGuidanceOptions = {},
) {
  if (requestedTargets.length === 0) {
    return {
      action: 'install',
      targets: [],
      suggestions: guidanceSuggestions(repositoryRoot),
      confirmationRequired: true,
    };
  }
  const existingConfig = readAgentGuidanceConfiguration(repositoryRoot);
  const existing = existingConfig.targets;
  const requested = new Map<string, AgentGuidanceTarget>();
  for (const value of requestedTargets) {
    const target = parseTarget(
      repositoryRoot,
      typeof value === 'string' ? { path: value } : value,
    );
    requested.set(target.path, target);
  }
  const merged = new Map(existing.map((target) => [target.path, target]));
  for (const [targetPath, target] of requested) {
    merged.set(targetPath, { ...merged.get(targetPath), ...target });
  }
  // Validate every destination, including config, before projecting any target.
  const configPath = checkedPath(repositoryRoot, AGENT_GUIDANCE_CONFIG);
  const config = `${JSON.stringify(
    {
      targets: [...merged.values()],
      ...(existingConfig.sourceRefs === undefined
        ? {}
        : { sourceRefs: existingConfig.sourceRefs }),
    },
    null,
    2,
  )}\n`;
  const previousConfig = fs.existsSync(configPath)
    ? readUtf8(configPath)
    : null;
  const onDiff = options.onDiff ?? printDiff;
  const assertConfigUnchanged = () => {
    const currentPath = checkedPath(repositoryRoot, AGENT_GUIDANCE_CONFIG);
    const current = fs.existsSync(currentPath) ? readUtf8(currentPath) : null;
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
  const targets = guidanceService(repositoryRoot, [...requested.values()], {
    onDiff(diff) {
      previewConfig();
      onDiff(diff);
      assertConfigUnchanged();
    },
  }).project(PROJECTION_ID, { install: true, heading: '## Jigwright' });
  if (previousConfig !== config) {
    previewConfig();
    assertConfigUnchanged();
    replaceTextAtomic(configPath, config, { allowCreate: true });
  }
  return {
    action: 'install',
    targets,
    confirmationRequired: false,
    suggestions: [],
  };
}

export function refreshAgentGuidance(
  repositoryRoot: string,
  options: AgentGuidanceOptions = {},
) {
  return {
    action: 'refresh',
    targets: guidanceService(
      repositoryRoot,
      readAgentGuidanceTargets(repositoryRoot),
      options,
    ).project(PROJECTION_ID),
  };
}

export function removeAgentGuidance(
  repositoryRoot: string,
  options: AgentGuidanceOptions = {},
) {
  // Keep the target declaration so status can report intentional removal.
  return {
    action: 'remove',
    targets: guidanceService(
      repositoryRoot,
      readAgentGuidanceTargets(repositoryRoot),
      options,
    ).remove(PROJECTION_ID),
  };
}

export function statusAgentGuidance(repositoryRoot: string) {
  return {
    action: 'status',
    targets: guidanceService(
      repositoryRoot,
      readAgentGuidanceTargets(repositoryRoot),
    ).status(),
  };
}

function guidanceService(
  repositoryRoot: string,
  targets: readonly AgentGuidanceTarget[],
  options: AgentGuidanceOptions = {},
) {
  const onDiff = options.onDiff ?? printDiff;
  return createProjectionService(
    [
      {
        id: PROJECTION_ID,
        source: () => {
          const { sourceRefs = [] } =
            readAgentGuidanceConfiguration(repositoryRoot);
          const wording = [
            ...sourceRefs.map(
              (ref) => readGovernanceSource(repositoryRoot, ref).text,
            ),
            renderAgentGuidanceRules(),
          ].join('\n\n');
          // Exact Source text is generated content; formatters must not reflow it.
          const content =
            sourceRefs.length === 0
              ? wording
              : `\n<!-- prettier-ignore-start -->\n\n${wording}\n\n<!-- prettier-ignore-end -->\n`;
          return targets.map((target) => ({ path: target.path, content }));
        },
      },
    ],
    {
      read(target) {
        const targetPath = checkedPath(repositoryRoot, target);
        return fs.existsSync(targetPath) ? readUtf8(targetPath) : null;
      },
      beforeWrite(change) {
        onDiff(
          guidanceDiff(
            change.path,
            change.before ?? null,
            change.after ?? null,
          ),
        );
      },
      write(target, content) {
        const targetPath = checkedPath(repositoryRoot, target);
        replaceTextAtomic(targetPath, content, { allowCreate: true });
      },
    },
  );
}

function parseTarget(
  repositoryRoot: string,
  value: unknown,
): AgentGuidanceTarget {
  if (
    !value ||
    typeof value !== 'object' ||
    !('path' in value) ||
    typeof value.path !== 'string' ||
    ('label' in value &&
      (typeof value.label !== 'string' || value.label.trim().length === 0))
  ) {
    throw invalidConfig(
      'each target must have a path and an optional nonempty label',
    );
  }
  if (!/\.(md|markdown)$/iu.test(value.path)) {
    throw workflowError(
      'AGENT_GUIDANCE_UNSUPPORTED_TARGET',
      `Agent guidance v1 supports Markdown files only (.md or .markdown): ${value.path}`,
      ExitCode.usage,
    );
  }
  checkedPath(repositoryRoot, value.path);
  return {
    path: value.path,
    ...('label' in value ? { label: value.label as string } : {}),
  };
}

function checkedPath(repositoryRoot: string, target: string): string {
  try {
    normalizeExactRepositoryPath(target);
    assertPolicyPathInsideRepository(repositoryRoot, target);
  } catch (error) {
    throw workflowError(
      'AGENT_GUIDANCE_UNSAFE_TARGET',
      error instanceof Error
        ? error.message
        : `Unsafe guidance path: ${target}`,
      ExitCode.usage,
    );
  }
  const segments = target.split('/');
  let current = repositoryRoot;
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stat) break;
    if (index === segments.length - 1 ? !stat.isFile() : !stat.isDirectory()) {
      throw workflowError(
        'AGENT_GUIDANCE_UNSAFE_TARGET',
        `Guidance path must resolve to a regular file: ${target}`,
        ExitCode.usage,
      );
    }
  }
  return path.join(repositoryRoot, target);
}

function readUtf8(filePath: string): string {
  const bytes = fs.readFileSync(filePath);
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) {
    throw workflowError(
      'AGENT_GUIDANCE_UNSUPPORTED_ENCODING',
      `Guidance files must be valid UTF-8: ${filePath}`,
      ExitCode.usage,
    );
  }
  return text;
}

function printDiff(diff: string): void {
  process.stderr.write(diff);
}

function invalidConfig(reason: string) {
  return workflowError(
    'AGENT_GUIDANCE_CONFIG_INVALID',
    `${AGENT_GUIDANCE_CONFIG} ${reason}.`,
    ExitCode.usage,
  );
}

function guidanceDiff(
  target: string,
  before: string | null,
  after: string | null,
): string {
  const lines = (value: string | null) =>
    value === null || value === '' ? [] : value.replace(/\n$/u, '').split('\n');
  const beforeLines = lines(before);
  const afterLines = lines(after);
  return [
    `--- ${before === null ? '/dev/null' : `a/${target}`}`,
    `+++ ${after === null ? '/dev/null' : `b/${target}`}`,
    `@@ -1,${beforeLines.length} +1,${afterLines.length} @@`,
    ...beforeLines.map((line) => `-${line}`),
    ...afterLines.map((line) => `+${line}`),
    '',
  ].join('\n');
}

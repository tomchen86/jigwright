/** Explicit guidance target, configuration and exact Source wording policy. */
import { normalizeExactRepositoryPath } from '@jigwright/core/repository-path';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import type { ProjectionIO } from '../projection/projection-service.ts';
export type AgentGuidanceStorage = Pick<ProjectionIO, 'read' | 'write'> &
  Readonly<{
    assertTarget(target: string): void;
    isRegularFile(target: string): boolean;
  }>;
export const AGENT_GUIDANCE_CONFIG = 'workflow/agent-guidance.json';
export const PROJECTION_ID = 'guidance.agent-section';
export const CONVENTIONAL_TARGETS = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md'];

export type AgentGuidanceTarget = { path: string; label?: string };
export type AgentGuidanceOptions = { onDiff?: (diff: string) => void };

export function parseAgentGuidanceConfiguration(config: unknown): {
  targets: AgentGuidanceTarget[];
  sourceRefs?: string[];
} {
  if (
    !config ||
    typeof config !== 'object' ||
    !('targets' in config) ||
    !Array.isArray(config.targets)
  ) {
    throw invalidConfig('must contain a targets array');
  }
  const targets = config.targets.map((target: unknown) =>
    parseAgentGuidanceTarget(target),
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

export function parseAgentGuidanceTarget(value: unknown): AgentGuidanceTarget {
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
  try {
    normalizeExactRepositoryPath(value.path);
  } catch (error) {
    throw unsafeGuidanceTarget(value.path, error);
  }
  return {
    path: value.path,
    ...('label' in value ? { label: value.label as string } : {}),
  };
}

export function invalidConfig(reason: string) {
  return workflowError(
    'AGENT_GUIDANCE_CONFIG_INVALID',
    `${AGENT_GUIDANCE_CONFIG} ${reason}.`,
    ExitCode.usage,
  );
}

export function guidanceDiff(
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

export function unsafeGuidanceTarget(target: string, error: unknown) {
  return workflowError(
    'AGENT_GUIDANCE_UNSAFE_TARGET',
    error instanceof Error ? error.message : `Unsafe guidance path: ${target}`,
    ExitCode.usage,
  );
}
/** Owner Source wording is embedded byte-for-byte, protected against formatter reflow. */
export function guidanceSourceContent(
  sourceTexts: readonly string[],
  rules: string,
): string {
  const wording = [...sourceTexts, rules].join('\n\n');
  return sourceTexts.length === 0
    ? wording
    : `\n<!-- prettier-ignore-start -->\n\n${wording}\n\n<!-- prettier-ignore-end -->\n`;
}

export function renderGuidanceConfiguration(
  existing: {
    targets: readonly AgentGuidanceTarget[];
    sourceRefs?: readonly string[];
  },
  requested: readonly AgentGuidanceTarget[],
): string {
  const merged = new Map(
    existing.targets.map((target) => [target.path, target]),
  );
  for (const target of requested)
    merged.set(target.path, { ...merged.get(target.path), ...target });
  return `${JSON.stringify({ targets: [...merged.values()], ...(existing.sourceRefs === undefined ? {} : { sourceRefs: existing.sourceRefs }) }, null, 2)}\n`;
}

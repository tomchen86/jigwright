/**
 * Resolves colocated contracts and their proof references from a caller's snapshot.
 *
 * Invariants:
 * - The nearest containing spec owns a path; sibling prefixes never imply ownership.
 * - Parsing preserves normative text and ignores metadata inside fenced examples.
 */
import path from 'node:path';
import { markdownLines } from '@jigwright/core/markdown-sections';
import { normalizeExactRepositoryPath } from '@jigwright/core/repository-path';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';

export type SystemScenario = {
  title: string;
  sources: string[];
  covers: string | null;
  test: string | null;
  text: string;
};

export type SystemRequirement = {
  title: string;
  sources: string[];
  scenarios: SystemScenario[];
  text: string;
};

export type SystemSpec = {
  path: string;
  title: string;
  purpose: string;
  requirements: SystemRequirement[];
};

export type SystemDescriptionSnapshot = Readonly<{
  listPaths(): readonly string[];
  readText(relativePath: string): string | undefined;
}>;

export function findContainingSpec(
  filePath: string,
  specPaths: readonly string[],
): string | null {
  return findCommonSpec([filePath], specPaths);
}

export function findCommonSpec(
  filePaths: readonly string[],
  specPaths: readonly string[],
): string | null {
  if (filePaths.length === 0) return null;
  const files = filePaths.map(normalizeExactRepositoryPath);
  return (
    specPaths
      .map(normalizeExactRepositoryPath)
      .filter((specPath) => {
        if (path.posix.basename(specPath) !== 'spec.md') return false;
        const directory = path.posix.dirname(specPath);
        return files.every(
          (file) => directory === '.' || file.startsWith(`${directory}/`),
        );
      })
      .sort(
        (left, right) => right.split('/').length - left.split('/').length,
      )[0] ?? null
  );
}

export function parseSystemSpec(
  relativePath: string,
  text: string,
): SystemSpec {
  const spec: SystemSpec = {
    path: normalizeExactRepositoryPath(relativePath),
    title: '',
    purpose: '',
    requirements: [],
  };
  let requirement: SystemRequirement | undefined;
  let scenario: SystemScenario | undefined;
  let purpose = false;
  const fields = new WeakMap<object, Set<string>>();
  for (const line of markdownLines(text)) {
    const heading = line.fenced
      ? null
      : /^(#{1,4})\s+(.+?)\s*#*\s*$/.exec(line.text);
    if (heading) {
      const level = heading[1]!.length;
      const title = heading[2]!;
      if (level <= 2) {
        purpose = level === 2 && title === 'Purpose';
        requirement = undefined;
        scenario = undefined;
        if (level === 1 && !spec.title) spec.title = title;
        continue;
      }
      if (level === 3 && title.startsWith('Requirement: ')) {
        requirement = {
          title: title.slice(13),
          sources: [],
          scenarios: [],
          text: '',
        };
        spec.requirements.push(requirement);
        scenario = undefined;
      } else if (level === 4 && title.startsWith('Scenario: ') && requirement) {
        scenario = {
          title: title.slice(10),
          sources: [],
          covers: null,
          test: null,
          text: '',
        };
        requirement.scenarios.push(scenario);
      }
    }
    if (purpose) spec.purpose += line.raw;
    if (requirement) requirement.text += line.raw;
    if (scenario) scenario.text += line.raw;
    const metadata = line.fenced
      ? null
      : /^(sources|covers|test):\s*(.*?)\s*$/.exec(line.text);
    const target = scenario ?? requirement;
    if (!metadata || !target) continue;
    const key = metadata[1]!;
    const value = metadata[2]!;
    const seen = fields.get(target) ?? new Set<string>();
    if (seen.has(key)) throw invalid(`Duplicate ${key} in ${target.title}.`);
    seen.add(key);
    fields.set(target, seen);
    if (key === 'sources') {
      if (!/^\[.*\]$/.test(value))
        throw invalid(`sources must be an inline list in ${target.title}.`);
      target.sources = value
        .slice(1, -1)
        .split(',')
        .map((entry) => entry.trim().replace(/^(['"])(.*)\1$/, '$2'))
        .filter(Boolean);
    } else if (scenario) {
      scenario[key as 'covers' | 'test'] = value || null;
    }
  }
  spec.purpose = spec.purpose.trim();
  return spec;

  function invalid(message: string) {
    return workflowError(
      'SYSTEM_SPEC_INVALID',
      `${relativePath}: ${message}`,
      ExitCode.verification,
    );
  }
}

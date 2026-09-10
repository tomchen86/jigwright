/**
 * Derives module reference sections from snapshot CLI usage, union types,
 * contracts and source headers.
 *
 * Invariants:
 * - A module receives generated reference sections only when its README
 *   contains a confirmed Why paragraph.
 */
import path from 'node:path';
import { extractFileHeader } from '../source/file-header.ts';
import { readModuleReadmeWhy } from '../source/module-readme.ts';
import {
  findContainingSpec,
  type SystemDescriptionSnapshot,
  type SystemSpec,
} from '../source/spec-ownership.ts';
import { MODULE_README_COMMANDS } from './engine-projection-registry.ts';
import type { ProjectionBinding } from './projection-service.ts';

export function moduleReadmeProjectionBindings(
  snapshot: SystemDescriptionSnapshot,
  specs: readonly SystemSpec[],
  changedPathsSince: (directory: string, commit: string) => readonly string[],
  headerHistory: (file: string, commit: string) => string = () =>
    'History unavailable',
): ProjectionBinding[] {
  const usageSource =
    snapshot.readText(
      'packages/workflow-engine/src/entrypoints/cli/cli-input.ts',
    ) ?? '';
  const usage = [
    ...usageSource.matchAll(
      /^\s*['"]  (?:pnpm workflow |jigwright )(.+?) — ([^'"\r\n]+)['"],?$/gm,
    ),
  ].map((match) => ({ command: match[1]!, description: match[2]! }));
  const catalog =
    snapshot.readText(
      'packages/workflow-engine/src/modules/guidance/catalog/managed-workflow-command-registry.ts',
    ) ?? '';
  const constants = new Map(
    [
      ...catalog.matchAll(
        /const ([A-Z_]+)\s*=\s*'((?:pnpm workflow |jigwright )[^']+)';/g,
      ),
    ].map((match) => [match[1]!, match[2]!]),
  );
  // Read literal catalog facts from the selected snapshot, never execute its
  // TypeScript or import the current checkout's catalog for a pinned tree.
  for (const entry of catalog.split(/\n  \{\n/)) {
    const commands = /usage:\s*\[([\s\S]*?)\],/.exec(entry)?.[1];
    const description = /purpose:\s*'([^']+)'/.exec(entry)?.[1];
    if (!commands || !description) continue;
    for (const match of commands.matchAll(
      /'((?:pnpm workflow |jigwright )[^']+)'|\b([A-Z_]+)\b/g,
    )) {
      const command = match[1] ?? constants.get(match[2]!);
      if (command)
        usage.push({
          command: command.replace(/^(?:pnpm workflow |jigwright )/, ''),
          description,
        });
    }
  }
  return (
    Object.keys(MODULE_README_COMMANDS) as Array<
      keyof typeof MODULE_README_COMMANDS
    >
  ).flatMap((module) => {
    const directory = `packages/workflow-engine/src/modules/${module}`;
    const target = `${directory}/README.md`;
    const current = snapshot.readText(target);
    const why = current === undefined ? null : readModuleReadmeWhy(current);
    if (!why) return [];
    const sourceFiles = snapshot
      .listPaths()
      .filter(
        (file) =>
          file.startsWith(`${directory}/`) && /\.[cm]?[jt]sx?$/.test(file),
      )
      .sort();
    const data = sourceFiles.flatMap((file) => {
      const source = snapshot.readText(file) ?? '';
      return [
        ...source.matchAll(
          /(?:export\s+)?type\s+(\w+)\s*=\s*\|?\s*((?:(?:'[^']+'|"[^"]+"|null|undefined)\s*\|\s*)*(?:'[^']+'|"[^"]+"|null|undefined))\s*;/g,
        ),
      ].map((match) => ({
        name: match[1]!,
        values: [
          ...match[2]!.matchAll(/'([^']+)'|"([^"]+)"|\b(null|undefined)\b/g),
        ]
          .map((value) => value[1] ?? value[2] ?? value[3]!)
          .join(', '),
        file,
      }));
    });
    const owner = findContainingSpec(
      `${directory}/module.ts`,
      specs.map((spec) => spec.path),
    );
    const contract = specs.find((spec) => spec.path === owner);
    const changes = changedPathsSince(directory, why.confirmedAtCommit);
    const commands = usage.filter(({ command }) =>
      (MODULE_README_COMMANDS[module] as readonly string[]).includes(
        command.split(' ')[0]!,
      ),
    );
    const content = [
      '',
      '<!-- prettier-ignore-start -->',
      '',
      `${changes.length} ${changes.length === 1 ? 'file changed' : 'files changed'} in this module since confirmation.`,
      '',
      '## Commands',
      '',
      '| Command and parameters | Does what |',
      '| --- | --- |',
      ...commands.map(
        ({ command, description }) =>
          `| ${cell(command)} | ${cell(description)} |`,
      ),
      '',
      '## Data',
      '',
      '| Type | Values | Source |',
      '| --- | --- | --- |',
      ...data.map(
        (row) =>
          `| ${cell(row.name)} | ${cell(row.values)} | ${link(path.posix.relative(directory, row.file), row.file)} |`,
      ),
      '',
      '## Contracts',
      '',
      ...(contract?.requirements.map(
        (requirement) =>
          `- ${link(requirement.title, `${contract.path}#${anchor(`Requirement: ${requirement.title}`)}`)}`,
      ) ?? ['No containing contract is available.']),
      '',
      '## Files',
      '',
      'Header history compares Git blame at the explanation confirmation with this source snapshot. It is a hint, not verification of the explanation.',
      '',
      '| File | Responsibility | Invariants | Header history |',
      '| --- | --- | ---: | --- |',
      ...sourceFiles.map((file) => {
        const header = extractFileHeader(snapshot.readText(file) ?? '');
        return `| ${link(path.posix.relative(directory, file), file)} | ${cell(header?.responsibility.split(/(?<=[.!?。！？])\s/)[0] ?? 'No leading responsibility comment.')} | ${header?.invariants.length ?? 0} | ${cell(headerHistory(file, why.confirmedAtCommit))} |`;
      }),
      '',
      '<!-- prettier-ignore-end -->',
      '',
    ].join('\n');
    return [
      {
        id: `documents.${module}-readme` as const,
        source: () => [{ path: target, content }],
      },
    ];

    function link(label: string, file: string): string {
      const [filePath, fragment] = file.split('#', 2);
      return `[${cell(label).replaceAll('[', '\\[').replaceAll(']', '\\]')}](${encodeURI(path.posix.relative(directory, filePath!))}${fragment ? `#${fragment}` : ''})`;
    }
  });
}

function cell(text: string): string {
  return text
    .replaceAll('|', '\\|')
    .replaceAll('\n', ' ')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function anchor(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s/g, '-');
}

/**
 * Presents the task's inherited contracts, original requirements and file invariants.
 *
 * Invariants:
 * - Every rendered value comes from the same pinned repository snapshot.
 * - Source wording is exact; binding identifiers remain outside readable context.
 */
import path from 'node:path';
import { markdownLines } from '@jigwright/core/markdown-sections';
import { matchesAllowedPath } from '@jigwright/core/repository-path';
import { extractFileHeader } from './file-header.ts';
import { readModuleReadmeWhy } from './module-readme.ts';
import {
  findContainingSpec,
  parseSystemSpec,
  type SystemDescriptionSnapshot,
} from './spec-ownership.ts';
import { readSystemSource, systemSpecPaths } from './system-documents.ts';

export function systemDocumentContext(
  snapshot: SystemDescriptionSnapshot,
  allowedPaths: readonly string[],
) {
  const allPaths = snapshot.listPaths();
  const files = allPaths.filter((file) =>
    allowedPaths.some((scope) => matchesAllowedPath(file, scope)),
  );
  const targets = [
    ...files,
    ...allowedPaths.map((scope) =>
      scope.endsWith('/**') ? `${scope.slice(0, -3)}/spec.md` : scope,
    ),
  ];
  const specs = systemSpecPaths(allPaths)
    .filter((spec) =>
      targets.some((file) => findContainingSpec(file, [spec]) !== null),
    )
    .map((spec) => parseSystemSpec(spec, snapshot.readText(spec) ?? ''));
  const refs = new Set(
    specs.flatMap((spec) =>
      spec.requirements.flatMap((requirement) => [
        ...requirement.sources,
        ...requirement.scenarios.flatMap((scenario) => scenario.sources),
      ]),
    ),
  );
  return {
    contracts: specs.map((spec) => ({
      path: spec.path,
      title: spec.title,
      text: readableContract(snapshot.readText(spec.path) ?? ''),
    })),
    sources: [...refs].map((ref) => ({
      originalText: readSystemSource(snapshot, ref).text,
    })),
    files: files.flatMap((file) => {
      if (!/\.[cm]?[jt]sx?$/.test(file)) return [];
      const header = extractFileHeader(snapshot.readText(file) ?? '');
      return header
        ? [
            {
              path: file,
              responsibility: header.responsibility,
              invariants: header.invariants,
            },
          ]
        : [];
    }),
    readmes: [
      ...new Set(
        specs.map((spec) =>
          path.posix.join(path.posix.dirname(spec.path), 'README.md'),
        ),
      ),
    ].flatMap((file) => {
      const text = snapshot.readText(file);
      const why = text === undefined ? null : readModuleReadmeWhy(text);
      return why === null ? [] : [{ path: file, text: why.text }];
    }),
  };
}

function readableContract(text: string): string {
  return markdownLines(text)
    .filter(
      (line) =>
        line.fenced ||
        !/^(?:sources|covers|test|capabilities):\s*/.test(line.text),
    )
    .map((line) => line.raw)
    .join('');
}

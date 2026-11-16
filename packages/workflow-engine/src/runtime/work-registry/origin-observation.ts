/** Discovers and reads change-origin records with current consumer/path validation on every lookup. */
import fs from 'node:fs';
import path from 'node:path';
import {
  registryInvalid,
  parseOrigin,
  changeIdentity,
} from '../../modules/governance-intake/work-registry-record.ts';
import { originChangeIdentity } from '../../modules/governance-intake/work-registry-queries.ts';
import type { ChangeOriginV1 } from '../../modules/governance-intake/work-registry-contracts.ts';
import {
  repositoryConsumerPath,
  loadRepositoryConsumerConfiguration,
} from '../workflow-configuration/repository-consumer.ts';
export function listOriginPaths(repositoryRoot: string): string[] {
  const changesRoot = repositoryConsumerPath(
    repositoryRoot,
    loadRepositoryConsumerConfiguration(repositoryRoot).configuration
      .workRegistry.changeOriginRoot,
  );
  const stats = fs.lstatSync(changesRoot, { throwIfNoEntry: false });
  if (!stats) return [];
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw registryInvalid('OpenSpec change root is unsafe.');
  }
  const paths: string[] = [];
  const visit = (directory: string, depth: number): void => {
    if (depth > 2) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw registryInvalid('Change origin tree contains a symbolic link.');
      }
      if (entry.isDirectory()) {
        visit(target, depth + 1);
      } else if (entry.isFile() && entry.name === 'origin.json') {
        paths.push(target);
      }
    }
  };
  visit(changesRoot, 0);
  return paths.sort();
}
export function originChangeId(
  repositoryRoot: string,
  originPath: string,
): string {
  const changesRoot = repositoryConsumerPath(
    repositoryRoot,
    loadRepositoryConsumerConfiguration(repositoryRoot).configuration
      .workRegistry.changeOriginRoot,
  );
  const relative = path
    .relative(changesRoot, originPath)
    .replaceAll(path.sep, '/');
  return originChangeIdentity(relative);
}
export function readOrigin(reference: string): ChangeOriginV1 {
  return parseOrigin(fs.readFileSync(reference, 'utf8'));
}
export function relativeOriginPath(
  repositoryRoot: string,
  reference: string,
): string {
  return path.relative(repositoryRoot, reference).replaceAll(path.sep, '/');
}
export function createCurrentOriginReader(
  readOptionalPlainFile: (reference: string) => string | null,
) {
  function readCurrentOrigin(
    repositoryRoot: string,
    requestedChangeId: string,
  ): ChangeOriginV1 | null {
    const configuration =
      loadRepositoryConsumerConfiguration(repositoryRoot).configuration
        .workRegistry;
    const changeId = changeIdentity(requestedChangeId);
    const originPath = path.join(
      repositoryConsumerPath(repositoryRoot, configuration.changeOriginRoot),
      changeId,
      'origin.json',
    );
    const source = readOptionalPlainFile(originPath);
    if (source === null) return null;
    const origin = parseOrigin(source);
    return origin;
  }
  return readCurrentOrigin;
}

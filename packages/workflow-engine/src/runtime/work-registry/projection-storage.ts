/** Observes projection destinations/history topology and publishes exact projection bytes. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  repositoryConsumerPath,
  loadRepositoryConsumerConfiguration,
} from '../workflow-configuration/repository-consumer.ts';
import { projectionDrift } from '../../modules/governance-intake/work-registry-projections.ts';
export function createWorkRegistryProjectionStorage(
  readOptionalPlainFile: (reference: string) => string | null,
) {
  function replaceTextFile(filePath: string, content: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const before = readOptionalPlainFile(filePath);
    if (before === content) return;
    const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporary, content, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o644,
    });
    try {
      fs.renameSync(temporary, filePath);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
  return {
    read: readOptionalPlainFile,
    write: replaceTextFile,
    readLayout: (root: string) =>
      loadRepositoryConsumerConfiguration(root).configuration.workRegistry,
    resolvePath: repositoryConsumerPath,
    exists: (target: string) => fs.existsSync(target),
    historyState(target: string): 'absent' | 'directory' | 'unsafe' {
      const stats = fs.lstatSync(target, { throwIfNoEntry: false });
      return stats === undefined
        ? 'absent'
        : stats.isDirectory() && !stats.isSymbolicLink()
          ? 'directory'
          : 'unsafe';
    },
    listHistoryPaths(historyRoot: string, strict: boolean): string[] {
      if (!strict)
        return fs
          .readdirSync(historyRoot)
          .map((name) => path.join(historyRoot, name));
      return fs
        .readdirSync(historyRoot, { withFileTypes: true })
        .map((entry) => {
          if (
            !entry.isFile() ||
            entry.isSymbolicLink() ||
            !/^\d{4}\.md$/.test(entry.name)
          )
            throw projectionDrift(
              'Work Registry history contains an unexpected path.',
            );
          return path.join(historyRoot, entry.name);
        });
    },
  };
}

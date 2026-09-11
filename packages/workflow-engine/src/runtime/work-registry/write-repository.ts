/** Observe validated registry targets and commit canonical records under the existing transaction protocol. */
import { canonicalJson } from '@jigwright/core/canonical-json';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  ChangeOriginV1,
  WorkItemPromotionChangeEntryV1,
  WorkItemPromotionPreparationBindingV1,
  WorkItemPromotionSurveyV1,
  WorkItemV1,
} from '../../modules/governance-intake/work-registry-contracts.ts';
import type { WorkRegistryMutation } from '../../modules/governance-intake/work-registry-mutation.ts';
import { registryInvalid } from '../../modules/governance-intake/work-registry-record.ts';
import {
  loadRepositoryConsumerConfiguration,
  repositoryConsumerPath,
} from '../repository-observation/repository-consumer.ts';
import { runGit } from '../repository-transaction/git.ts';
import { createWorkRegistryStorage } from './storage.ts';
import {
  commitWorkItemRecordTransaction,
  createWorkItemRecordTransaction,
  createWorkRegistryPromotionLocks,
  findExactRecoveredWorkItemPromotion,
  parsePromotionItemContent,
  readStablePromotionTarget,
  recoverWorkItemPromotionTransactionsUnlocked,
  replayRecoveredWorkItemPromotion,
} from './transactions.ts';
function assertChangeDirectory(
  repositoryRoot: string,
  changeId: string,
  purpose: 'Promotion' | 'Source linking' = 'Promotion',
): string {
  const changeDirectory = path.join(
    repositoryConsumerPath(
      repositoryRoot,
      loadRepositoryConsumerConfiguration(repositoryRoot).configuration
        .workRegistry.changeOriginRoot,
    ),
    changeId,
  );
  const stats = fs.lstatSync(changeDirectory, { throwIfNoEntry: false });
  if (!stats?.isDirectory() || stats.isSymbolicLink()) {
    throw registryInvalid(
      `${purpose} requires an existing plain change directory.`,
    );
  }
  return changeDirectory;
}

function createMonotonicWorkItemId(timestamp: string): string {
  const time = BigInt(new Date(timestamp).valueOf());
  const random = crypto.randomBytes(10);
  let value = (time << 80n) | BigInt(`0x${random.toString('hex')}`);
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let encoded = '';
  for (let index = 0; index < 26; index += 1) {
    encoded = alphabet[Number(value & 31n)] + encoded;
    value >>= 5n;
  }
  return `WORK-${encoded}`;
}

function promotionChangeDirectory(
  repositoryRoot: string,
  changeId: string,
): string {
  return path.join(
    repositoryConsumerPath(
      repositoryRoot,
      loadRepositoryConsumerConfiguration(repositoryRoot).configuration
        .workRegistry.changeOriginRoot,
    ),
    changeId,
  );
}

function ensureWorkItemPromotionChangeDirectoryUnlocked(
  repositoryRoot: string,
  changeId: string,
): string {
  const changeDirectory = promotionChangeDirectory(repositoryRoot, changeId);
  const parent = path.dirname(changeDirectory);
  const parentStats = fs.lstatSync(parent, { throwIfNoEntry: false });
  if (!parentStats?.isDirectory() || parentStats.isSymbolicLink()) {
    throw registryInvalid('Promotion change root is unsafe or unavailable.');
  }
  const stats = fs.lstatSync(changeDirectory, { throwIfNoEntry: false });
  if (stats === undefined) {
    fs.mkdirSync(changeDirectory, { mode: 0o755 });
    fs.chmodSync(changeDirectory, 0o755);
  } else if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw registryInvalid('Promotion change directory is unsafe.');
  }
  return changeDirectory;
}

function snapshotPromotionChangeEntries(
  changeDirectory: string,
): readonly WorkItemPromotionChangeEntryV1[] {
  const entries: WorkItemPromotionChangeEntryV1[] = [];
  const visit = (directory: string, prefix: string): void => {
    const beforeDirectory = fs.lstatSync(directory);
    if (!beforeDirectory.isDirectory() || beforeDirectory.isSymbolicLink()) {
      throw registryInvalid('Promotion change entry is unsafe.');
    }
    const names = fs.readdirSync(directory).sort();
    for (const name of names) {
      const entryPath = path.join(directory, name);
      const relativePath = prefix ? `${prefix}/${name}` : name;
      const stats = fs.lstatSync(entryPath);
      if (stats.isSymbolicLink()) {
        throw registryInvalid('Promotion change entry is unsafe.');
      }
      if (stats.isDirectory()) {
        entries.push({
          path: relativePath,
          kind: 'directory',
          mode: stats.mode & 0o777,
        });
        visit(entryPath, relativePath);
      } else if (stats.isFile()) {
        if (stats.nlink !== 1) {
          throw registryInvalid('Promotion change entry is unsafe.');
        }
        entries.push({
          path: relativePath,
          kind: 'file',
          mode: stats.mode & 0o777,
          digest: stablePromotionFileDigest(entryPath, stats),
        });
      } else {
        throw registryInvalid('Promotion change entry is unsafe.');
      }
    }
    const afterDirectory = fs.lstatSync(directory);
    if (
      !afterDirectory.isDirectory() ||
      afterDirectory.isSymbolicLink() ||
      beforeDirectory.dev !== afterDirectory.dev ||
      beforeDirectory.ino !== afterDirectory.ino ||
      beforeDirectory.mode !== afterDirectory.mode ||
      beforeDirectory.mtimeMs !== afterDirectory.mtimeMs ||
      canonicalJson(fs.readdirSync(directory).sort()) !== canonicalJson(names)
    ) {
      throw registryInvalid(
        'Promotion change directory changed during inspection.',
      );
    }
  };
  visit(changeDirectory, '');
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

function stablePromotionFileDigest(
  filePath: string,
  before: fs.Stats,
): `sha256:${string}` {
  const bytes = fs.readFileSync(filePath);
  const after = fs.lstatSync(filePath);
  if (
    !after.isFile() ||
    after.isSymbolicLink() ||
    after.nlink !== 1 ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mode !== after.mode ||
    before.mtimeMs !== after.mtimeMs ||
    bytes.byteLength !== after.size
  ) {
    throw registryInvalid('Promotion change entry changed during inspection.');
  }
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function listSymbolConsumers(
  repositoryRoot: string,
  commit: string,
  symbol: string,
): string[] {
  const output = runGit(
    repositoryRoot,
    ['grep', '-l', '-z', '-F', '-e', symbol, commit, '--', '.'],
    true,
  );
  const prefix = `${commit}:`;
  return output
    .split('\0')
    .filter(Boolean)
    .map((entry) => {
      if (!entry.startsWith(prefix)) {
        throw registryInvalid(
          'Promotion survey returned an invalid consumer path.',
        );
      }
      const relativePath = entry.slice(prefix.length);
      if (
        path.isAbsolute(relativePath) ||
        path.posix.normalize(relativePath) !== relativePath ||
        relativePath.startsWith('../') ||
        relativePath.includes('\\')
      ) {
        throw registryInvalid('Promotion survey consumer path is invalid.');
      }
      return relativePath;
    })
    .sort();
}

function observeChangeTarget(
  changeDirectory: string,
): WorkItemPromotionPreparationBindingV1['changeTarget'] {
  const stats = fs.lstatSync(changeDirectory, { throwIfNoEntry: false });
  if (stats !== undefined && (!stats.isDirectory() || stats.isSymbolicLink())) {
    throw registryInvalid('Promotion change directory is unsafe.');
  }
  const existingEntries =
    stats === undefined
      ? null
      : snapshotPromotionChangeEntries(changeDirectory);
  const stableStats = fs.lstatSync(changeDirectory, {
    throwIfNoEntry: false,
  });
  if (
    (stats === undefined) !== (stableStats === undefined) ||
    (stats !== undefined &&
      stableStats !== undefined &&
      (!stableStats.isDirectory() ||
        stableStats.isSymbolicLink() ||
        stats.dev !== stableStats.dev ||
        stats.ino !== stableStats.ino ||
        stats.mode !== stableStats.mode ||
        stats.mtimeMs !== stableStats.mtimeMs))
  ) {
    throw registryInvalid(
      'Promotion change directory changed during inspection.',
    );
  }
  const originEntry = existingEntries?.find(
    (entry) => entry.path === 'origin.json',
  );
  if (originEntry?.kind === 'directory') {
    throw registryInvalid('Promotion change origin is unsafe.');
  }
  return stats === undefined
    ? ({ kind: 'absent-change' } as const)
    : ({
        kind: 'existing-change' as const,
        directoryMode: stableStats!.mode & 0o777,
        entries: existingEntries!,
        originDigest: originEntry?.digest ?? null,
      } as const);
}
export function createWorkRegistryWriteRepository() {
  const locks = createWorkRegistryPromotionLocks();
  const storage = createWorkRegistryStorage(locks);
  return {
    withRegistry: locks.withWorkRegistryPromotionLockWhenAvailable,
    withPromotion<T>(
      repositoryRoot: string,
      operation: (mutation: WorkRegistryMutation) => T,
    ): T {
      return locks.withWorkRegistryPromotionLock(repositoryRoot, (runtime) =>
        operation({
          recover: () => recoverWorkItemPromotionTransactionsUnlocked(runtime),
          replay: (id, changeId, digest, grant) =>
            replayRecoveredWorkItemPromotion(
              runtime,
              id,
              changeId,
              digest,
              grant,
            ),
          hasReceipt: (id, changeId, digest, grant) =>
            findExactRecoveredWorkItemPromotion(
              runtime,
              id,
              changeId,
              digest,
              grant,
            ) !== null,
          commit: (change, hooks) => {
            const transaction = createWorkItemRecordTransaction(
              repositoryRoot,
              change.itemPath,
              change.originPath,
              change.itemBefore,
              change.originBefore,
              change.item,
              change.origin,
              change.grantBinding,
              change.sourceUpdate,
            );
            const committed = commitWorkItemRecordTransaction(
              runtime,
              transaction,
              hooks,
            );
            return {
              item:
                change.sourceUpdate === undefined
                  ? parsePromotionItemContent(committed.after.itemContent)
                  : change.item,
              originPath: path.join(
                repositoryRoot,
                ...committed.originRelativePath.split('/'),
              ),
            };
          },
        }),
      );
    },
    layout: (root: string) =>
      loadRepositoryConsumerConfiguration(root).configuration.workRegistry,
    resolvePath: repositoryConsumerPath,
    changeDirectory: assertChangeDirectory,
    promotionChangeDirectory,
    observeChangeTarget,
    ensureChangeDirectory: ensureWorkItemPromotionChangeDirectoryUnlocked,
    currentCommit: (root: string) => runGit(root, ['rev-parse', 'HEAD']).trim(),
    symbolConsumers: listSymbolConsumers,
    createId: createMonotonicWorkItemId,
    findItem: storage.findWorkItemPath,
    readItem: storage.readWorkItem,
    readItemSnapshot: storage.readWorkItemRecord,
    createItem: (reference: string, item: WorkItemV1) =>
      storage.createCanonicalFile(reference, item),
    replaceItem: (reference: string, item: WorkItemV1) =>
      storage.replaceCanonicalFile(reference, item),
    writeOrigin: (reference: string, origin: ChangeOriginV1) =>
      storage.replaceCanonicalFile(reference, origin),
    writeSurvey: (reference: string, survey: WorkItemPromotionSurveyV1) =>
      storage.replaceCanonicalFile(reference, survey),
    readRecordText: storage.readOptionalPlainFile,
    readOriginBefore: (reference: string, allowMissing: boolean) =>
      allowMissing
        ? (readStablePromotionTarget(reference, true)?.content ?? null)
        : readStablePromotionTarget(reference, false).content,
  };
}

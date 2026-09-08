/** Stable canonical Work Item reads, path discovery, and create/replace file publication. Registry locks are bound by the facade. */
import { TextDecoder } from 'node:util';
import {
  registryInvalid,
  parseWorkItem,
  WORK_ITEM_FILE_MODE,
  isNodeError,
} from './work-registry-record.ts';
import path from 'node:path';
import { canonicalJson } from '@jigwright/core/canonical-json';
import fs from 'node:fs';
import {
  repositoryConsumerPath,
  repositoryWorkRegistryConfiguration,
} from '../repository-consumer/repository-consumer-config.ts';
import crypto from 'node:crypto';
import type {
  WorkRegistryStorageBindings,
  WorkItemV1,
} from './work-registry.ts';

export function createWorkRegistryStorage(
  bindings: WorkRegistryStorageBindings,
) {
  const { withWorkRegistryPromotionLockWhenAvailable } = bindings;

  function readWorkItem(itemPath: string): WorkItemV1 {
    return readWorkItemRecord(itemPath).item;
  }

  function readWorkItemRecord(
    itemPath: string,
  ): Readonly<{ item: WorkItemV1; serialized: string }> {
    const bytes = readPlainWorkItemBytes(itemPath);
    let serialized: string;
    let value: unknown;
    try {
      serialized = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      value = JSON.parse(serialized);
    } catch {
      throw registryInvalid('Work Item is invalid.');
    }
    const item = parseWorkItem(value);
    if (
      path.basename(itemPath) !== `${item.id}.yaml` ||
      path.basename(path.dirname(itemPath)) !== item.createdAt.slice(0, 4) ||
      !bytes.equals(Buffer.from(`${canonicalJson(item)}\n`, 'utf8'))
    ) {
      throw registryInvalid('Work Item path and identity differ.');
    }
    return { item, serialized };
  }

  function readPlainWorkItemBytes(itemPath: string): Buffer {
    let before: fs.BigIntStats | undefined;
    try {
      before = fs.lstatSync(itemPath, {
        bigint: true,
        throwIfNoEntry: false,
      });
    } catch {
      throw registryInvalid('Work Item path is unsafe.');
    }
    if (before === undefined || !isSafeWorkItemFile(before)) {
      throw registryInvalid('Work Item path is unsafe.');
    }
    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(
        itemPath,
        fs.constants.O_RDONLY |
          (process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW),
      );
      const openedBefore = fs.fstatSync(descriptor, { bigint: true });
      if (
        !isSafeWorkItemFile(openedBefore) ||
        !sameWorkItemFileSnapshot(before, openedBefore)
      ) {
        throw new Error('Work Item changed before descriptor admission.');
      }
      const bytes = fs.readFileSync(descriptor);
      const openedAfter = fs.fstatSync(descriptor, { bigint: true });
      const after = fs.lstatSync(itemPath, {
        bigint: true,
        throwIfNoEntry: false,
      });
      if (
        after === undefined ||
        !isSafeWorkItemFile(openedAfter) ||
        !isSafeWorkItemFile(after) ||
        BigInt(bytes.byteLength) !== openedBefore.size ||
        !sameWorkItemFileSnapshot(openedBefore, openedAfter) ||
        !sameWorkItemFileSnapshot(openedAfter, after)
      ) {
        throw new Error('Work Item changed while it was read.');
      }
      return bytes;
    } catch {
      throw registryInvalid('Work Item path could not be read safely.');
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
  }

  function isSafeWorkItemFile(stats: fs.BigIntStats): boolean {
    return (
      stats.isFile() &&
      !stats.isSymbolicLink() &&
      stats.nlink === 1n &&
      (process.platform === 'win32' ||
        (stats.mode & 0o777n) === BigInt(WORK_ITEM_FILE_MODE)) &&
      (typeof process.getuid !== 'function' ||
        stats.uid === BigInt(process.getuid()))
    );
  }

  function sameWorkItemFileSnapshot(
    left: fs.BigIntStats,
    right: fs.BigIntStats,
  ): boolean {
    return (
      left.dev === right.dev &&
      left.ino === right.ino &&
      left.mode === right.mode &&
      left.nlink === right.nlink &&
      left.uid === right.uid &&
      left.gid === right.gid &&
      left.size === right.size &&
      left.mtimeNs === right.mtimeNs &&
      left.ctimeNs === right.ctimeNs
    );
  }

  function listWorkItemPaths(repositoryRoot: string): string[] {
    return withWorkRegistryPromotionLockWhenAvailable(repositoryRoot, () =>
      listWorkItemPathsUnlocked(repositoryRoot),
    );
  }

  function listWorkItemPathsUnlocked(repositoryRoot: string): string[] {
    const itemsRoot = repositoryConsumerPath(
      repositoryRoot,
      repositoryWorkRegistryConfiguration(repositoryRoot).itemRoot,
    );
    const rootStats = fs.lstatSync(itemsRoot, { throwIfNoEntry: false });
    if (!rootStats) return [];
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
      throw registryInvalid('Work Registry item root is unsafe.');
    }
    const itemPaths: string[] = [];
    for (const entry of fs.readdirSync(itemsRoot, { withFileTypes: true })) {
      const yearRoot = path.join(itemsRoot, entry.name);
      const yearStats = fs.lstatSync(yearRoot);
      if (
        entry.isSymbolicLink() ||
        !entry.isDirectory() ||
        !yearStats.isDirectory() ||
        yearStats.isSymbolicLink() ||
        !/^\d{4}$/.test(entry.name)
      ) {
        throw registryInvalid('Work Registry year entry is unsafe or invalid.');
      }
      for (const item of fs.readdirSync(yearRoot, { withFileTypes: true })) {
        const itemPath = path.join(yearRoot, item.name);
        const itemStats = fs.lstatSync(itemPath);
        if (
          item.isSymbolicLink() ||
          !item.isFile() ||
          !itemStats.isFile() ||
          itemStats.isSymbolicLink() ||
          !/^WORK-[0-9A-HJKMNP-TV-Z]{26}\.yaml$/.test(item.name)
        ) {
          throw registryInvalid(
            'Work Registry item entry is unsafe or invalid.',
          );
        }
        itemPaths.push(itemPath);
      }
    }
    return itemPaths.sort();
  }

  function findWorkItemPath(repositoryRoot: string, id: string): string {
    const matches = listWorkItemPaths(repositoryRoot).filter(
      (itemPath) => path.basename(itemPath, '.yaml') === id,
    );
    if (matches.length !== 1) {
      throw registryInvalid(
        'Work Item must resolve to exactly one stable path.',
      );
    }
    return matches[0]!;
  }

  function createCanonicalFile(filePath: string, value: unknown): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const content = `${canonicalJson(value)}\n`;
    try {
      fs.writeFileSync(filePath, content, {
        encoding: 'utf8',
        flag: 'wx',
        mode: WORK_ITEM_FILE_MODE,
      });
    } catch (error) {
      if (
        isNodeError(error) &&
        error.code === 'EEXIST' &&
        readWorkItemRecord(filePath).serialized === content
      ) {
        return;
      }
      if (isNodeError(error) && error.code === 'EEXIST') {
        throw registryInvalid(
          'A different Work Item already owns this identity.',
        );
      }
      throw error;
    }
  }

  function replaceCanonicalFile(filePath: string, value: unknown): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporary, `${canonicalJson(value)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: WORK_ITEM_FILE_MODE,
    });
    try {
      fs.renameSync(temporary, filePath);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }

  function readOptionalPlainFile(filePath: string): string | null {
    const stats = fs.lstatSync(filePath, { throwIfNoEntry: false });
    if (!stats) return null;
    if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
      throw registryInvalid('Work Registry path is unsafe.');
    }
    return fs.readFileSync(filePath, 'utf8');
  }

  return {
    createCanonicalFile,
    findWorkItemPath,
    readWorkItem,
    replaceCanonicalFile,
    listWorkItemPaths,
    readWorkItemRecord,
    readOptionalPlainFile,
    listWorkItemPathsUnlocked,
  };
}

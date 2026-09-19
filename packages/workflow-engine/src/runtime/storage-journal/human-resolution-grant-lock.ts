/**
 * Serializes grant-store access and checks interrupted publication recovery state.
 *
 * Invariants:
 * - Temporary reclamation and prepared-recovery barriers precede the protected operation.
 * - Lock options preserve their existing scope and grant-specific recovery exceptions.
 */
import fs from 'node:fs';
import path from 'node:path';
import { type InvestigationRuntimePaths } from '../paths/runtime-paths.ts';
import {
  type HumanResolutionGrantPublicationQuarantineReceipt,
  assertHumanResolutionGrantPublicationQuarantineReceipt,
  HUMAN_RESOLUTION_GRANT_FILE,
  HUMAN_RESOLUTION_GRANT_TEMPORARY,
} from '../../modules/investigation/domain/human-resolution-grant-publication-contract.ts';
import {
  assertPrivateFile,
  fsyncDirectory,
  privatePathExists,
  readPrivateCanonicalJson,
  walkPrivateDirectory,
  withPrivateRuntimeLock,
} from '../journal-primitives/investigation-private-files.ts';
import {
  assertHumanResolutionGrantId,
  humanResolutionGrantUnsafe,
} from '../../modules/investigation/domain/human-resolution-values.ts';
import {
  humanResolutionGrantPublicationRecoveryRequired,
  humanResolutionPaths,
} from '../journal-primitives/investigation-resolution-values.ts';

export function humanResolutionGrantPublicationRecoveryPath(
  stores: ReturnType<typeof humanResolutionPaths>,
  grantId: string,
): string {
  return path.join(stores.publicationRecoveries, `${grantId}.json`);
}

export function readHumanResolutionGrantPublicationRecovery(
  paths: InvestigationRuntimePaths,
  stores: ReturnType<typeof humanResolutionPaths>,
  grantId: string,
): HumanResolutionGrantPublicationQuarantineReceipt | null {
  const receiptPath = humanResolutionGrantPublicationRecoveryPath(
    stores,
    grantId,
  );
  if (!privatePathExists(paths, receiptPath, humanResolutionGrantUnsafe)) {
    return null;
  }
  return assertHumanResolutionGrantPublicationQuarantineReceipt(
    readPrivateCanonicalJson(paths, receiptPath, humanResolutionGrantUnsafe),
    grantId,
  );
}

export function assertNoPreparedHumanResolutionGrantPublicationRecovery(
  paths: InvestigationRuntimePaths,
  grantId: string,
): void {
  const stores = humanResolutionPaths(paths);
  withHumanResolutionGrantStoreLock(
    paths,
    stores,
    () => {
      const receipt = readHumanResolutionGrantPublicationRecovery(
        paths,
        stores,
        grantId,
      );
      if (receipt?.phase === 'prepared') {
        throw humanResolutionGrantPublicationRecoveryRequired();
      }
    },
    {
      allowInterruptedAvailablePublication: true,
      targetGrantId: grantId,
    },
  );
}

export function withHumanResolutionGrantStoreLock<T>(
  paths: InvestigationRuntimePaths,
  stores: ReturnType<typeof humanResolutionPaths>,
  operation: () => T,
  options: {
    allowInterruptedAvailablePublication?: boolean;
    allowPreparedPublicationRecovery?: boolean;
    targetGrantId?: string;
  } = {},
): T {
  return withPrivateRuntimeLock(
    paths,
    path.join(stores.locks, 'grant-store.lock'),
    () => {
      reclaimHumanResolutionGrantTemporaries(
        paths,
        stores,
        options.allowInterruptedAvailablePublication ?? false,
        options.targetGrantId,
      );
      if (
        options.targetGrantId !== undefined &&
        !options.allowPreparedPublicationRecovery &&
        readHumanResolutionGrantPublicationRecovery(
          paths,
          stores,
          options.targetGrantId,
        )?.phase === 'prepared'
      ) {
        throw humanResolutionGrantPublicationRecoveryRequired();
      }
      return operation();
    },
    'HUMAN_RESOLUTION_GRANT_STORE_CONFLICT',
    humanResolutionGrantUnsafe,
  );
}

function reclaimHumanResolutionGrantTemporaries(
  paths: InvestigationRuntimePaths,
  stores: ReturnType<typeof humanResolutionPaths>,
  allowInterruptedAvailablePublication: boolean,
  targetGrantId: string | undefined,
): void {
  for (const directory of [
    stores.available,
    stores.terminal,
    stores.publicationRecoveries,
  ]) {
    if (
      !walkPrivateDirectory(paths, directory, humanResolutionGrantUnsafe, false)
    ) {
      continue;
    }
    let removed = false;
    for (const name of fs.readdirSync(directory)) {
      const temporaryMatch = HUMAN_RESOLUTION_GRANT_TEMPORARY.exec(name);
      if (!temporaryMatch?.[1]) {
        continue;
      }
      const temporaryGrantId = assertHumanResolutionGrantId(temporaryMatch[1]);
      const temporaryPath = path.join(directory, name);
      const stats = fs.lstatSync(temporaryPath, { throwIfNoEntry: false });
      if (!stats) {
        continue;
      }
      assertPrivateFile(stats, humanResolutionGrantUnsafe);
      if (directory === stores.available) {
        if (
          allowInterruptedAvailablePublication ||
          (targetGrantId !== undefined && temporaryGrantId !== targetGrantId)
        ) {
          continue;
        }
        throw humanResolutionGrantPublicationRecoveryRequired();
      }
      fs.unlinkSync(temporaryPath);
      removed = true;
    }
    if (removed) {
      fsyncDirectory(directory);
    }
  }
}

export function listHumanResolutionGrantIds(
  paths: InvestigationRuntimePaths,
  directory: string,
): string[] {
  if (
    !walkPrivateDirectory(paths, directory, humanResolutionGrantUnsafe, false)
  ) {
    return [];
  }
  const names = fs.readdirSync(directory);
  if (names.length > 4096) {
    throw humanResolutionGrantUnsafe();
  }
  const grantIds: string[] = [];
  for (const name of names) {
    const match = HUMAN_RESOLUTION_GRANT_FILE.exec(name);
    if (match?.[1]) {
      grantIds.push(assertHumanResolutionGrantId(match[1]));
      continue;
    }
    if (HUMAN_RESOLUTION_GRANT_TEMPORARY.test(name)) {
      const stats = fs.lstatSync(path.join(directory, name), {
        throwIfNoEntry: false,
      });
      if (!stats) {
        continue;
      }
      assertPrivateFile(stats, humanResolutionGrantUnsafe);
      continue;
    }
    {
      throw humanResolutionGrantUnsafe();
    }
  }
  return grantIds;
}

export function listHumanResolutionGrantPublicationRecoveryIds(
  paths: InvestigationRuntimePaths,
  stores: ReturnType<typeof humanResolutionPaths>,
): string[] {
  if (
    !walkPrivateDirectory(
      paths,
      stores.publicationRecoveries,
      humanResolutionGrantUnsafe,
      false,
    )
  ) {
    return [];
  }
  const names = fs.readdirSync(stores.publicationRecoveries).sort();
  if (names.length > 4096) {
    throw humanResolutionGrantUnsafe();
  }
  return names.map((name) => {
    const grantId = HUMAN_RESOLUTION_GRANT_FILE.exec(name)?.[1];
    if (!grantId) {
      throw humanResolutionGrantUnsafe();
    }
    const validatedGrantId = assertHumanResolutionGrantId(grantId);
    readHumanResolutionGrantPublicationRecovery(
      paths,
      stores,
      validatedGrantId,
    );
    return validatedGrantId;
  });
}

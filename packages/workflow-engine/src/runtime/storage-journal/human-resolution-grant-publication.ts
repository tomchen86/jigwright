/**
 * Inspects and quarantines interrupted human-resolution grant publication.
 *
 * Invariants:
 * - Recovery binds the exact observed publication files, audit tag, and grant identity.
 * - Prepared receipts, quarantine moves, and final receipt publication preserve replay order.
 *
 * Depends on: grant publication contracts, grant-store locking, and resolution journals.
 * Failure modes: a recovery accepts changed publication state or leaves an ambiguous grant executable.
 */
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { type InvestigationRuntimePaths } from '../session-workspace/paths.ts';
import {
  humanResolutionGrantPublicationRecoveryPath,
  listHumanResolutionGrantIds,
  listHumanResolutionGrantPublicationRecoveryIds,
  readHumanResolutionGrantPublicationRecovery,
  withHumanResolutionGrantStoreLock,
} from './human-resolution-grant-lock.ts';
import {
  assertHumanResolutionGrantPublicationQuarantineReceipt,
  HUMAN_RESOLUTION_GRANT_FILE,
  HUMAN_RESOLUTION_GRANT_TEMPORARY,
  type HumanResolutionGrantPublicationQuarantineReceipt,
  type HumanResolutionGrantPublicationStateBinding,
  type HumanResolutionGrantPublicationStoreInspection,
  type HumanResolutionGrantPublicationStoreState,
  type QuarantinedHumanResolutionGrantPublication,
} from './human-resolution-grant-publication-contract.ts';
import {
  ACTIVE_HUMAN_RESOLUTION_JOURNAL,
  readActiveHumanResolutionJournal,
  scanActiveHumanResolutionJournalDirectory,
} from './human-resolution-journal.ts';
import {
  assertPrivateFile,
  createPrivateRawFile,
  ensurePrivateInvestigationDirectory,
  fsyncDirectory,
  privatePathExists,
  readPrivateBuffer,
  readPrivateCanonicalJson,
  walkPrivateDirectory,
  writePrivateCanonicalJsonAtomic,
} from './investigation-private-files.ts';
import {
  assertHumanResolutionGrantId,
  humanResolutionGrantPublicationRecoveryAmbiguous,
  humanResolutionGrantPublicationRecoveryInvalid,
  humanResolutionGrantPublicationRecoveryStale,
  humanResolutionGrantUnsafe,
  humanResolutionJournalPath,
  humanResolutionJournalUnsafe,
  humanResolutionPaths,
  isBoundedResolutionText,
} from './investigation-resolution-values.ts';
import { isDigest, isRecord, sha256 } from './investigation-store-values.ts';

export function inspectInterruptedHumanResolutionGrantPublications(
  paths: InvestigationRuntimePaths,
  requestedGrantId?: string,
): HumanResolutionGrantPublicationStoreInspection[] {
  const grantId =
    requestedGrantId === undefined
      ? undefined
      : assertHumanResolutionGrantId(requestedGrantId);
  const stores = humanResolutionPaths(paths);
  return withHumanResolutionGrantStoreLock(
    paths,
    stores,
    () => {
      listHumanResolutionGrantIds(paths, stores.available);
      const temporaryGrantIds = walkPrivateDirectory(
        paths,
        stores.available,
        humanResolutionGrantUnsafe,
        false,
      )
        ? fs.readdirSync(stores.available).flatMap((temporaryName) => {
            const match = HUMAN_RESOLUTION_GRANT_TEMPORARY.exec(temporaryName);
            if (!match?.[1]) {
              return [];
            }
            const observedGrantId = assertHumanResolutionGrantId(match[1]);
            return grantId === undefined || observedGrantId === grantId
              ? [observedGrantId]
              : [];
          })
        : [];
      const recoveryGrantIds =
        grantId === undefined
          ? listHumanResolutionGrantPublicationRecoveryIds(paths, stores)
          : privatePathExists(
                paths,
                humanResolutionGrantPublicationRecoveryPath(stores, grantId),
                humanResolutionGrantUnsafe,
              )
            ? [grantId]
            : [];
      const preparedReceiptGrantIds = recoveryGrantIds.filter(
        (observedGrantId) =>
          readHumanResolutionGrantPublicationRecovery(
            paths,
            stores,
            observedGrantId,
          )?.phase === 'prepared',
      );
      const grantIds = [
        ...new Set([...temporaryGrantIds, ...preparedReceiptGrantIds]),
      ].sort();
      return grantIds.map((observedGrantId) => {
        const receipt = readHumanResolutionGrantPublicationRecovery(
          paths,
          stores,
          observedGrantId,
        );
        if (receipt?.phase === 'prepared') {
          assertHumanResolutionGrantPublicationQuarantineReplayState(
            paths,
            stores,
            receipt,
          );
          return {
            storeState: receipt.publicationStoreState,
            preparedBinding: {
              auditTag: receipt.auditTag,
              publicationStateDigest: receipt.publicationStateDigest,
            },
          };
        }
        return {
          storeState: observeHumanResolutionGrantPublicationStoreState(
            paths,
            stores,
            observedGrantId,
          ),
          preparedBinding: null,
        };
      });
    },
    {
      allowInterruptedAvailablePublication: true,
      allowPreparedPublicationRecovery: true,
      targetGrantId: grantId,
    },
  );
}

export function quarantineInterruptedHumanResolutionGrantPublication(
  paths: InvestigationRuntimePaths,
  requestedGrantId: string,
  expectedPublicationStateDigest: string,
  reason: string,
  bindPublicationState: (
    storeState: HumanResolutionGrantPublicationStoreState,
  ) => HumanResolutionGrantPublicationStateBinding,
  now: Date = new Date(),
): QuarantinedHumanResolutionGrantPublication {
  const grantId = assertHumanResolutionGrantId(requestedGrantId);
  if (
    !isDigest(expectedPublicationStateDigest) ||
    !isBoundedResolutionText(reason, 1024) ||
    !Number.isFinite(now.getTime())
  ) {
    throw humanResolutionGrantPublicationRecoveryInvalid();
  }
  const stores = humanResolutionPaths(paths);
  const recoveryId = sha256(
    canonicalJson({
      schema: 'human-resolution-grant-publication-quarantine.v1',
      grantId,
      publicationStateDigest: expectedPublicationStateDigest,
    }),
  );
  const receiptPath = humanResolutionGrantPublicationRecoveryPath(
    stores,
    grantId,
  );
  const result = {
    action: 'quarantined' as const,
    grantId,
    publicationStateDigest: expectedPublicationStateDigest,
  };
  return withHumanResolutionGrantStoreLock(
    paths,
    stores,
    () => {
      const existingReceipt = privatePathExists(
        paths,
        receiptPath,
        humanResolutionGrantUnsafe,
      )
        ? readPrivateCanonicalJson(
            paths,
            receiptPath,
            humanResolutionGrantUnsafe,
          )
        : null;
      if (existingReceipt !== null) {
        const receipt = assertHumanResolutionGrantPublicationQuarantineReceipt(
          existingReceipt,
          grantId,
        );
        if (
          receipt.recoveryId !== recoveryId ||
          receipt.publicationStateDigest !== expectedPublicationStateDigest ||
          receipt.reason !== reason
        ) {
          throw humanResolutionGrantPublicationRecoveryStale();
        }
        assertHumanResolutionGrantPublicationQuarantineReplayState(
          paths,
          stores,
          receipt,
        );
        completeHumanResolutionGrantPublicationQuarantine(
          paths,
          stores,
          receipt,
        );
        finalizeHumanResolutionGrantPublicationQuarantineReceipt(
          paths,
          receiptPath,
          receipt,
        );
        return result;
      }
      const observed = observeHumanResolutionGrantPublicationStoreState(
        paths,
        stores,
        grantId,
      );
      const binding = bindPublicationState(observed);
      const observedStateDigest = binding.publicationStateDigest;
      if (
        !isDigest(observedStateDigest) ||
        observedStateDigest !== expectedPublicationStateDigest
      ) {
        throw humanResolutionGrantPublicationRecoveryStale();
      }
      if (observed.temporaries.length === 0) {
        throw humanResolutionGrantPublicationRecoveryAmbiguous();
      }
      ensurePrivateInvestigationDirectory(
        paths,
        stores.quarantine,
        humanResolutionGrantUnsafe,
      );
      const receipt = {
        schemaVersion: 1 as const,
        kind: 'human-resolution-grant-publication-recovery' as const,
        recoveryId,
        action: 'quarantined' as const,
        phase: 'prepared' as const,
        grantId,
        publicationStateDigest: expectedPublicationStateDigest,
        auditTag: binding.auditTag,
        publicationStoreState: observed,
        artifacts: observed.temporaries.map((temporary, index) => ({
          temporaryName: temporary.temporaryName,
          rawSha256: temporary.rawSha256,
          unsafeObservationDigest: temporary.unsafeObservationDigest,
          byteLength: temporary.byteLength,
          quarantineArtifact: `${recoveryId}.${index + 1}.grant-publication.artifact`,
        })),
        reason,
        recordedAt: now.toISOString(),
      };
      createPrivateRawFile(
        paths,
        receiptPath,
        `${canonicalJson(receipt)}\n`,
        humanResolutionGrantUnsafe,
      );
      const validatedReceipt =
        assertHumanResolutionGrantPublicationQuarantineReceipt(
          readPrivateCanonicalJson(
            paths,
            receiptPath,
            humanResolutionGrantUnsafe,
          ),
          grantId,
        );
      completeHumanResolutionGrantPublicationQuarantine(
        paths,
        stores,
        validatedReceipt,
      );
      finalizeHumanResolutionGrantPublicationQuarantineReceipt(
        paths,
        receiptPath,
        validatedReceipt,
      );
      return result;
    },
    {
      allowInterruptedAvailablePublication: true,
      allowPreparedPublicationRecovery: true,
      targetGrantId: grantId,
    },
  );
}

function observeHumanResolutionGrantPublicationStoreState(
  paths: InvestigationRuntimePaths,
  stores: ReturnType<typeof humanResolutionPaths>,
  grantId: string,
): HumanResolutionGrantPublicationStoreState {
  for (const directory of [
    stores.available,
    stores.reserved,
    stores.terminal,
  ]) {
    listHumanResolutionGrantIds(paths, directory);
  }
  const temporaries = walkPrivateDirectory(
    paths,
    stores.available,
    humanResolutionGrantUnsafe,
    false,
  )
    ? fs
        .readdirSync(stores.available)
        .flatMap((temporaryName) => {
          const match = HUMAN_RESOLUTION_GRANT_TEMPORARY.exec(temporaryName);
          if (
            !match?.[1] ||
            assertHumanResolutionGrantId(match[1]) !== grantId
          ) {
            return [];
          }
          const { content, ...observed } = observePrivateGrantPublicationFile(
            path.join(stores.available, temporaryName),
          );
          return [
            {
              temporaryName,
              ...observed,
              parsedEnvelopeGrantId:
                parseInterruptedHumanResolutionGrantEnvelopeId(content),
            },
          ];
        })
        .sort((left, right) =>
          left.temporaryName.localeCompare(right.temporaryName),
        )
    : [];
  const digestIfPresent = (filePath: string): string | null =>
    privatePathExists(paths, filePath, humanResolutionGrantUnsafe)
      ? observePrivateGrantPublicationFile(filePath).rawSha256
      : null;
  return {
    grantId,
    temporaries,
    durable: {
      availableDigest: digestIfPresent(
        path.join(stores.available, `${grantId}.json`),
      ),
      reservedDigest: digestIfPresent(
        path.join(stores.reserved, `${grantId}.json`),
      ),
      terminalDigest: digestIfPresent(
        path.join(stores.terminal, `${grantId}.json`),
      ),
    },
    sameGrantJournalDigest: digestIfPresent(
      humanResolutionJournalPath(paths, grantId),
    ),
    sameGrantActiveJournalDigest: observeSameGrantActiveJournalDigest(
      paths,
      grantId,
    ),
    sameGrantReceiptDigest: digestIfPresent(
      path.join(stores.receipts, `${grantId}.json`),
    ),
  };
}

function observeSameGrantActiveJournalDigest(
  paths: InvestigationRuntimePaths,
  grantId: string,
): string | null {
  const scanned = scanActiveHumanResolutionJournalDirectory(paths);
  if (scanned === null) {
    return null;
  }
  let match: string | null = null;
  for (const name of scanned.journalNames) {
    const changeId = ACTIVE_HUMAN_RESOLUTION_JOURNAL.exec(name)?.[1];
    if (!changeId) {
      throw humanResolutionJournalUnsafe();
    }
    const journal = readActiveHumanResolutionJournal(paths, changeId);
    if (journal?.grantId !== grantId) {
      continue;
    }
    if (match !== null) {
      throw humanResolutionJournalUnsafe();
    }
    match = observePrivateGrantPublicationFile(
      path.join(scanned.activeDirectory, name),
    ).rawSha256;
  }
  return match;
}

function observePrivateGrantPublicationFile(filePath: string): {
  rawSha256: string;
  unsafeObservationDigest: string;
  byteLength: number;
  content: Buffer;
} {
  const before = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (!before) {
    throw humanResolutionGrantUnsafe();
  }
  assertPrivateFile(before, humanResolutionGrantUnsafe);
  const content = readPrivateBuffer(filePath, humanResolutionGrantUnsafe);
  const after = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (
    !after ||
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    after.size !== before.size ||
    after.mode !== before.mode ||
    after.nlink !== before.nlink
  ) {
    throw humanResolutionGrantUnsafe();
  }
  const rawSha256 = sha256(content);
  return {
    rawSha256,
    unsafeObservationDigest: sha256(
      canonicalJson({
        schema: 'human-resolution-grant-publication-file.v1',
        device: before.dev,
        inode: before.ino,
        mode: before.mode & 0o777,
        nlink: before.nlink,
        byteLength: content.byteLength,
        rawSha256,
      }),
    ),
    byteLength: content.byteLength,
    content,
  };
}

function parseInterruptedHumanResolutionGrantEnvelopeId(
  content: Buffer,
): string | null {
  try {
    const value = JSON.parse(content.toString('utf8')) as unknown;
    if (
      isRecord(value) &&
      isRecord(value.payload) &&
      typeof value.payload.grantId === 'string' &&
      HUMAN_RESOLUTION_GRANT_FILE.test(`${value.payload.grantId}.json`)
    ) {
      return value.payload.grantId;
    }
  } catch {
    return null;
  }
  return null;
}

function completeHumanResolutionGrantPublicationQuarantine(
  paths: InvestigationRuntimePaths,
  stores: ReturnType<typeof humanResolutionPaths>,
  receipt: HumanResolutionGrantPublicationQuarantineReceipt,
): void {
  assertHumanResolutionGrantPublicationQuarantineReplayState(
    paths,
    stores,
    receipt,
  );
  for (const artifact of receipt.artifacts) {
    const temporaryPath = path.join(stores.available, artifact.temporaryName);
    const quarantinePath = path.join(
      stores.quarantine,
      artifact.quarantineArtifact,
    );
    if (!privatePathExists(paths, temporaryPath, humanResolutionGrantUnsafe)) {
      continue;
    }
    if (receipt.phase === 'quarantined') {
      throw humanResolutionGrantPublicationRecoveryStale();
    }
    fs.renameSync(temporaryPath, quarantinePath);
    fsyncDirectory(stores.available);
    fsyncDirectory(stores.quarantine);
  }
  assertHumanResolutionGrantPublicationQuarantineReplayState(
    paths,
    stores,
    receipt,
  );
}

function finalizeHumanResolutionGrantPublicationQuarantineReceipt(
  paths: InvestigationRuntimePaths,
  receiptPath: string,
  receipt: HumanResolutionGrantPublicationQuarantineReceipt,
): void {
  if (receipt.phase === 'quarantined') {
    return;
  }
  writePrivateCanonicalJsonAtomic(
    paths,
    receiptPath,
    {
      ...receipt,
      phase: 'quarantined',
    },
    humanResolutionGrantUnsafe,
  );
}

function assertHumanResolutionGrantPublicationQuarantineReplayState(
  paths: InvestigationRuntimePaths,
  stores: ReturnType<typeof humanResolutionPaths>,
  receipt: HumanResolutionGrantPublicationQuarantineReceipt,
): void {
  const observed = observeHumanResolutionGrantPublicationStoreState(
    paths,
    stores,
    receipt.grantId,
  );
  if (
    canonicalJson({
      durable: observed.durable,
      sameGrantJournalDigest: observed.sameGrantJournalDigest,
      sameGrantActiveJournalDigest: observed.sameGrantActiveJournalDigest,
      sameGrantReceiptDigest: observed.sameGrantReceiptDigest,
    }) !==
    canonicalJson({
      durable: receipt.publicationStoreState.durable,
      sameGrantJournalDigest:
        receipt.publicationStoreState.sameGrantJournalDigest,
      sameGrantActiveJournalDigest:
        receipt.publicationStoreState.sameGrantActiveJournalDigest,
      sameGrantReceiptDigest:
        receipt.publicationStoreState.sameGrantReceiptDigest,
    })
  ) {
    throw humanResolutionGrantPublicationRecoveryStale();
  }
  const remainingTemporaries = new Map(
    observed.temporaries.map((temporary) => [
      temporary.temporaryName,
      temporary,
    ]),
  );
  for (const artifact of receipt.artifacts) {
    const temporaryPath = path.join(stores.available, artifact.temporaryName);
    const quarantinePath = path.join(
      stores.quarantine,
      artifact.quarantineArtifact,
    );
    const temporaryExists = privatePathExists(
      paths,
      temporaryPath,
      humanResolutionGrantUnsafe,
    );
    const quarantineExists = privatePathExists(
      paths,
      quarantinePath,
      humanResolutionGrantUnsafe,
    );
    if (temporaryExists === quarantineExists) {
      throw humanResolutionGrantPublicationRecoveryStale();
    }
    const observedArtifact = observePrivateGrantPublicationFile(
      temporaryExists ? temporaryPath : quarantinePath,
    );
    if (
      observedArtifact.rawSha256 !== artifact.rawSha256 ||
      observedArtifact.unsafeObservationDigest !==
        artifact.unsafeObservationDigest ||
      observedArtifact.byteLength !== artifact.byteLength
    ) {
      throw humanResolutionGrantPublicationRecoveryStale();
    }
    if (temporaryExists) {
      const remaining = remainingTemporaries.get(artifact.temporaryName);
      if (
        !remaining ||
        remaining.rawSha256 !== artifact.rawSha256 ||
        remaining.unsafeObservationDigest !==
          artifact.unsafeObservationDigest ||
        remaining.byteLength !== artifact.byteLength
      ) {
        throw humanResolutionGrantPublicationRecoveryStale();
      }
      remainingTemporaries.delete(artifact.temporaryName);
    }
  }
  if (remainingTemporaries.size !== 0) {
    throw humanResolutionGrantPublicationRecoveryStale();
  }
}

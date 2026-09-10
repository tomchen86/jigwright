/**
 * Publishes private maintenance records and reconciles interrupted
 * publication.
 *
 * Invariants:
 * - An existing prepared publication must match the requested artifact
 *   replay.
 */
import type fs from 'node:fs';
// intervention maintenance publication; repository effects remain bound by the public module.
import type {
  InterventionMaintenancePublicationBindings,
  InterventionMaintenancePublicationBindingsTypes,
} from './intervention-maintenance.ts';

export function createInterventionMaintenancePublication(
  bindings: () => InterventionMaintenancePublicationBindings,
) {
  function ensurePrivateDirectory(directory: string): void {
    const boundServices: InterventionMaintenancePublicationBindings =
      bindings();
    const { fs, PRIVATE_DIRECTORY_MODE, workflowError, ExitCode } =
      boundServices;

    fs.mkdirSync(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    const stats = fs.lstatSync(directory);
    if (
      !stats.isDirectory() ||
      stats.isSymbolicLink() ||
      (stats.mode & 0o777) !== PRIVATE_DIRECTORY_MODE
    ) {
      throw workflowError(
        'INTERVENTION_MAINTENANCE_STORAGE_UNSAFE',
        'Maintenance records require private plain directories.',
        ExitCode.unsafeEnvironment,
      );
    }
  }

  function createPrivateFileExclusive(
    filePath: string,
    content: string,
    testObservePublication?: (
      phase:
        | 'file-fsynced'
        | 'target-linked'
        | 'target-directory-fsynced'
        | 'temporary-cleaned',
    ) => void,
  ): void {
    const boundServices: InterventionMaintenancePublicationBindings =
      bindings();
    const { path, fs, PRIVATE_FILE_MODE } = boundServices;

    const directory = path.dirname(filePath);
    const temporary = privatePublicationTemporaryPath(filePath);
    const descriptor = fs.openSync(
      temporary,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_NOFOLLOW,
      PRIVATE_FILE_MODE,
    );
    try {
      fs.fchmodSync(descriptor, PRIVATE_FILE_MODE);
      fs.writeFileSync(descriptor, content, 'utf8');
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    testObservePublication?.('file-fsynced');
    finishPrivateFileExclusivePublication(
      filePath,
      temporary,
      content,
      testObservePublication,
    );
  }

  function reconcilePrivateFileExclusivePublication(
    filePath: string,
    content: string,
  ): boolean {
    const boundServices: InterventionMaintenancePublicationBindings =
      bindings();
    const { fs, artifactPublicationCorrupt } = boundServices;

    const temporary = privatePublicationTemporaryPath(filePath);
    const targetExists = fs.lstatSync(filePath, { throwIfNoEntry: false });
    const temporaryExists = fs.lstatSync(temporary, { throwIfNoEntry: false });
    if (targetExists === undefined && temporaryExists === undefined)
      return false;
    if (temporaryExists === undefined) return true;
    const prepared = readPrivatePublicationFile(
      temporary,
      targetExists === undefined ? 1n : 2n,
    );
    if (!sameArtifactPublicationReplay(prepared.content, content)) {
      throw artifactPublicationCorrupt();
    }
    if (targetExists === undefined) {
      finishPrivateFileExclusivePublication(
        filePath,
        temporary,
        prepared.content,
      );
      return true;
    }
    const target = readPrivatePublicationFile(filePath, 2n);
    if (
      target.content !== prepared.content ||
      target.stats.dev !== prepared.stats.dev ||
      target.stats.ino !== prepared.stats.ino
    ) {
      throw artifactPublicationCorrupt();
    }
    finishPrivateFileExclusivePublication(
      filePath,
      temporary,
      prepared.content,
    );
    return true;
  }

  function finishPrivateFileExclusivePublication(
    filePath: string,
    temporary: string,
    content: string,
    testObservePublication?: (
      phase:
        | 'file-fsynced'
        | 'target-linked'
        | 'target-directory-fsynced'
        | 'temporary-cleaned',
    ) => void,
  ): void {
    const boundServices: InterventionMaintenancePublicationBindings =
      bindings();
    const { path, fs } = boundServices;

    const directory = path.dirname(filePath);
    if (fs.lstatSync(filePath, { throwIfNoEntry: false }) === undefined) {
      fs.linkSync(temporary, filePath);
      testObservePublication?.('target-linked');
    }
    assertExactPrivatePublicationPair(filePath, temporary, content);
    fsyncDirectory(directory);
    testObservePublication?.('target-directory-fsynced');
    assertExactPrivatePublicationPair(filePath, temporary, content);
    fs.unlinkSync(temporary);
    fsyncDirectory(directory);
    assertExactPrivatePublicationFile(filePath, content, 1n);
    testObservePublication?.('temporary-cleaned');
  }

  function assertExactPrivatePublicationPair(
    filePath: string,
    temporary: string,
    content: string,
  ): void {
    const boundServices: InterventionMaintenancePublicationBindings =
      bindings();
    const { artifactPublicationCorrupt } = boundServices;

    const target = assertExactPrivatePublicationFile(filePath, content, 2n);
    const prepared = assertExactPrivatePublicationFile(temporary, content, 2n);
    if (target.dev !== prepared.dev || target.ino !== prepared.ino) {
      throw artifactPublicationCorrupt();
    }
  }

  function assertExactPrivatePublicationFile(
    filePath: string,
    content: string,
    expectedLinks: bigint,
  ): fs.BigIntStats {
    const boundServices: InterventionMaintenancePublicationBindings =
      bindings();
    const { artifactPublicationCorrupt } = boundServices;

    const observed = readPrivatePublicationFile(filePath, expectedLinks);
    if (observed.content !== content) throw artifactPublicationCorrupt();
    return observed.stats;
  }

  function readPrivatePublicationFile(
    filePath: string,
    expectedLinks: bigint,
  ): { stats: fs.BigIntStats; content: string } {
    const boundServices: InterventionMaintenancePublicationBindings =
      bindings();
    const {
      fs,
      artifactPublicationCorrupt,
      PRIVATE_FILE_MODE,
      sameArtifactExecutableIdentity,
    } = boundServices;

    let descriptor: number;
    try {
      descriptor = fs.openSync(
        filePath,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
      );
    } catch {
      throw artifactPublicationCorrupt();
    }
    try {
      const before = fs.fstatSync(descriptor, { bigint: true });
      const raw = fs.readFileSync(descriptor, 'utf8');
      const after = fs.fstatSync(descriptor, { bigint: true });
      const current = fs.lstatSync(filePath, {
        bigint: true,
        throwIfNoEntry: false,
      });
      if (
        current === undefined ||
        !before.isFile() ||
        before.isSymbolicLink() ||
        before.nlink !== expectedLinks ||
        (before.mode & 0o777n) !== BigInt(PRIVATE_FILE_MODE) ||
        !sameArtifactExecutableIdentity(before, after) ||
        !sameArtifactExecutableIdentity(before, current)
      ) {
        throw artifactPublicationCorrupt();
      }
      return { stats: before, content: raw };
    } finally {
      fs.closeSync(descriptor);
    }
  }

  function sameArtifactPublicationReplay(
    observedContent: string,
    candidateContent: string,
  ): boolean {
    const boundServices: InterventionMaintenancePublicationBindings =
      bindings();
    const { isRecord, canonicalJson, verifyRecordDigest } = boundServices;

    try {
      const observed = JSON.parse(observedContent) as unknown;
      const candidate = JSON.parse(candidateContent) as unknown;
      if (
        !isRecord(observed) ||
        !isRecord(candidate) ||
        `${canonicalJson(observed)}\n` !== observedContent ||
        `${canonicalJson(candidate)}\n` !== candidateContent ||
        !verifyRecordDigest(observed) ||
        !verifyRecordDigest(candidate) ||
        typeof observed.createdAt !== 'string' ||
        Number.isNaN(Date.parse(observed.createdAt)) ||
        new Date(observed.createdAt).toISOString() !== observed.createdAt
      ) {
        return false;
      }
      const {
        createdAt: _observedCreatedAt,
        recordDigest: _observedRecordDigest,
        ...observedIdentity
      } = observed;
      const {
        createdAt: _candidateCreatedAt,
        recordDigest: _candidateRecordDigest,
        ...candidateIdentity
      } = candidate;
      return (
        canonicalJson(observedIdentity) === canonicalJson(candidateIdentity)
      );
    } catch {
      return false;
    }
  }

  function privatePublicationTemporaryPath(filePath: string): string {
    return `${filePath}.pending`;
  }

  function replacePrivateFileAtomic(filePath: string, content: string): void {
    const boundServices: InterventionMaintenancePublicationBindings =
      bindings();
    const { crypto, fs, path } = boundServices;

    const temporary = `${filePath}.${crypto.randomUUID()}.tmp`;
    createPrivateFileExclusive(temporary, content);
    fs.renameSync(temporary, filePath);
    fsyncDirectory(path.dirname(filePath));
  }

  function fsyncDirectory(directory: string): void {
    const boundServices: InterventionMaintenancePublicationBindings =
      bindings();
    const { fs } = boundServices;

    const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
    try {
      const stats = fs.fstatSync(descriptor);
      if (!stats.isDirectory())
        throw new Error('publication parent is not a directory');
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
  }

  function readCanonicalPrivateFile(filePath: string, notFoundCode: string) {
    const boundServices: InterventionMaintenancePublicationBindings =
      bindings();
    const {
      fs,
      workflowError,
      ExitCode,
      PRIVATE_FILE_MODE,
      MAX_RECORD_BYTES,
      maintenanceRecordCorrupt,
      canonicalJson,
    } = boundServices;

    const stats = fs.lstatSync(filePath, { throwIfNoEntry: false });
    if (!stats) {
      throw workflowError(
        notFoundCode,
        'Persisted maintenance record was not found.',
        ExitCode.conflict,
      );
    }
    if (
      !stats.isFile() ||
      stats.isSymbolicLink() ||
      stats.nlink !== 1 ||
      (stats.mode & 0o777) !== PRIVATE_FILE_MODE ||
      stats.size < 1 ||
      stats.size > MAX_RECORD_BYTES
    ) {
      throw maintenanceRecordCorrupt();
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw maintenanceRecordCorrupt();
    }
    if (`${canonicalJson(value)}\n` !== raw) throw maintenanceRecordCorrupt();
    return value;
  }
  return {
    ensurePrivateDirectory,
    createPrivateFileExclusive,
    reconcilePrivateFileExclusivePublication,
    replacePrivateFileAtomic,
    readCanonicalPrivateFile,
  };
}

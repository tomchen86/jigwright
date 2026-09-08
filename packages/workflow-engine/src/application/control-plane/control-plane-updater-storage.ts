// control plane updater storage; repository effects remain bound by the public module.
import type {
  ControlPlaneUpdaterStorageBindings,
  ControlPlaneUpdaterStorageBindingsTypes,
} from './intervention-control-updater.ts';
type UpdaterPaths = ControlPlaneUpdaterStorageBindingsTypes['UpdaterPaths'];
type EngineArtifact = ControlPlaneUpdaterStorageBindingsTypes['EngineArtifact'];
type Sha256Digest = ControlPlaneUpdaterStorageBindingsTypes['Sha256Digest'];

export function createControlPlaneUpdaterStorage(
  bindings: () => ControlPlaneUpdaterStorageBindings,
) {
  function updaterPaths(storageRoot: string): UpdaterPaths {
    const boundServices: ControlPlaneUpdaterStorageBindings = bindings();
    const { interventionControlPersistencePaths, path } = boundServices;

    const root = interventionControlPersistencePaths(storageRoot).root;
    const operations = path.join(root, 'operations');
    return {
      root,
      supervisor: path.join(root, 'control-plane-supervisor.json'),
      approvalCandidates: path.join(root, 'control-plane-approval-candidates'),
      bundles: path.join(root, 'control-plane-promotion-bundles'),
      artifacts: path.join(root, 'control-plane-artifacts'),
      operations,
      lock: path.join(operations, 'control-plane-updater.lock'),
    };
  }

  function ensureUpdaterDirectories(storageRoot: string): UpdaterPaths {
    const paths = updaterPaths(storageRoot);
    for (const directory of [
      paths.root,
      paths.approvalCandidates,
      paths.bundles,
      paths.artifacts,
      paths.operations,
    ]) {
      ensurePrivateDirectory(directory);
    }
    return paths;
  }

  function ensurePrivateDirectory(directory: string): void {
    const boundServices: ControlPlaneUpdaterStorageBindings = bindings();
    const {
      ensurePlainDirectory,
      fs,
      PRIVATE_DIRECTORY_MODE,
      workflowError,
      ExitCode,
    } = boundServices;

    ensurePlainDirectory(directory);
    const stats = fs.lstatSync(directory);
    if ((stats.mode & 0o777) !== PRIVATE_DIRECTORY_MODE) {
      throw workflowError(
        'CONTROL_PLANE_STORAGE_UNSAFE',
        'Control-plane state directories must be private.',
        ExitCode.unsafeEnvironment,
      );
    }
  }

  function withUpdaterLock<T>(
    storageRoot: string,
    operation: string,
    callback: () => T,
  ): T {
    const boundServices: ControlPlaneUpdaterStorageBindings = bindings();
    const {
      crypto,
      canonicalJson,
      publishPreparedExclusiveLock,
      workflowError,
      ExitCode,
      isNodeError,
      reclaimDeadPreparedLock,
    } = boundServices;

    const paths = updaterPaths(storageRoot);
    ensurePrivateDirectory(paths.root);
    ensurePrivateDirectory(paths.operations);
    const ownerToken = crypto.randomUUID();
    const content = `${canonicalJson({
      kind: 'control-plane-updater-lock.v1',
      operation,
      pid: process.pid,
      ownerToken,
    })}\n`;
    let descriptor: number | undefined;
    for (
      let attempt = 0;
      attempt < 3 && descriptor === undefined;
      attempt += 1
    ) {
      try {
        descriptor = publishPreparedExclusiveLock(
          paths.lock,
          content,
          ownerToken,
          () =>
            workflowError(
              'CONTROL_PLANE_UPDATER_LOCK_UNSAFE',
              'Control-plane updater lock is unsafe.',
              ExitCode.unsafeEnvironment,
            ),
        );
      } catch (error) {
        if (!isNodeError(error) || error.code !== 'EEXIST') throw error;
        const reclaimed = reclaimDeadPreparedLock(paths.lock, (raw) => {
          try {
            const value = JSON.parse(raw) as Record<string, unknown>;
            if (
              `${canonicalJson(value)}\n` !== raw ||
              !Number.isSafeInteger(value.pid) ||
              typeof value.ownerToken !== 'string'
            ) {
              return null;
            }
            return { pid: value.pid as number, ownerToken: value.ownerToken };
          } catch {
            return null;
          }
        });
        if (reclaimed === 'unsafe') {
          throw workflowError(
            'CONTROL_PLANE_UPDATER_LOCK_UNSAFE',
            'Control-plane updater lock is unsafe.',
            ExitCode.unsafeEnvironment,
          );
        }
        if (reclaimed === 'occupied') {
          throw workflowError(
            'CONTROL_PLANE_UPDATER_BUSY',
            'Another minimal updater process is active.',
            ExitCode.conflict,
          );
        }
      }
    }
    if (descriptor === undefined) {
      throw workflowError(
        'CONTROL_PLANE_UPDATER_BUSY',
        'Could not acquire the minimal updater lock.',
        ExitCode.conflict,
      );
    }
    let result: T | undefined;
    let failure: unknown;
    try {
      result = callback();
    } catch (error) {
      failure = error;
    }
    try {
      releaseUpdaterLock(paths.lock, descriptor);
    } catch (error) {
      failure ??= error;
    }
    if (failure !== undefined) throw failure;
    return result as T;
  }

  function releaseUpdaterLock(lockPath: string, descriptor: number): void {
    const boundServices: ControlPlaneUpdaterStorageBindings = bindings();
    const { fs, workflowError, ExitCode, path } = boundServices;

    try {
      const owned = fs.fstatSync(descriptor);
      const observed = fs.lstatSync(lockPath, { throwIfNoEntry: false });
      if (
        !observed?.isFile() ||
        observed.isSymbolicLink() ||
        observed.dev !== owned.dev ||
        observed.ino !== owned.ino
      ) {
        throw workflowError(
          'CONTROL_PLANE_UPDATER_LOCK_UNSAFE',
          'Minimal updater lost ownership of its lock.',
          ExitCode.unsafeEnvironment,
        );
      }
      fs.unlinkSync(lockPath);
      fsyncDirectory(path.dirname(lockPath));
    } finally {
      fs.closeSync(descriptor);
    }
  }

  function materializedExecutablePath(
    paths: UpdaterPaths,
    artifact: EngineArtifact,
  ): string {
    const boundServices: ControlPlaneUpdaterStorageBindings = bindings();
    const { path } = boundServices;

    return path.join(
      paths.artifacts,
      artifact.artifactId.slice('sha256:'.length),
      'engine',
    );
  }

  function assertConfinedExecutable(
    paths: UpdaterPaths,
    executablePath: string,
    expectedDigest: Sha256Digest,
    expectedArtifactId?: Sha256Digest,
  ): void {
    const boundServices: ControlPlaneUpdaterStorageBindings = bindings();
    const { path, supervisorCorrupt, fs } = boundServices;

    if (
      typeof executablePath !== 'string' ||
      !path.isAbsolute(executablePath) ||
      path.resolve(executablePath) !== executablePath
    ) {
      throw supervisorCorrupt();
    }
    const relative = path.relative(paths.artifacts, executablePath);
    if (
      relative.length === 0 ||
      relative.startsWith('..') ||
      path.isAbsolute(relative) ||
      path.basename(executablePath) !== 'engine'
    ) {
      throw supervisorCorrupt();
    }
    if (
      expectedArtifactId !== undefined &&
      executablePath !==
        path.join(
          paths.artifacts,
          expectedArtifactId.slice('sha256:'.length),
          'engine',
        )
    ) {
      throw supervisorCorrupt();
    }
    assertPrivateExecutable(executablePath, expectedDigest);
    if (
      fs.realpathSync(path.dirname(executablePath)) !==
        path.dirname(executablePath) ||
      fs.realpathSync(executablePath) !== executablePath
    ) {
      throw supervisorCorrupt();
    }
  }

  function assertPrivateExecutable(
    executablePath: string,
    expectedDigest: Sha256Digest,
  ): void {
    const boundServices: ControlPlaneUpdaterStorageBindings = bindings();
    const {
      fs,
      PRIVATE_EXECUTABLE_MODE,
      MAX_EXECUTABLE_BYTES,
      workflowError,
      ExitCode,
      rawDigest,
    } = boundServices;

    const stats = fs.lstatSync(executablePath, { throwIfNoEntry: false });
    if (
      !stats?.isFile() ||
      stats.isSymbolicLink() ||
      stats.nlink !== 1 ||
      (stats.mode & 0o777) !== PRIVATE_EXECUTABLE_MODE ||
      stats.size < 1 ||
      stats.size > MAX_EXECUTABLE_BYTES
    ) {
      throw workflowError(
        'CONTROL_PLANE_EXECUTABLE_UNSAFE',
        'Materialized control-plane executable is unsafe.',
        ExitCode.unsafeEnvironment,
      );
    }
    const descriptor = fs.openSync(
      executablePath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    try {
      const opened = fs.fstatSync(descriptor);
      if (
        opened.dev !== stats.dev ||
        opened.ino !== stats.ino ||
        rawDigest(fs.readFileSync(descriptor)) !== expectedDigest
      ) {
        throw workflowError(
          'CONTROL_PLANE_EXECUTABLE_DIGEST_MISMATCH',
          'Materialized executable digest changed.',
          ExitCode.verification,
        );
      }
    } finally {
      fs.closeSync(descriptor);
    }
  }

  function createPrivateExecutableExclusive(
    filePath: string,
    content: Buffer,
  ): void {
    const boundServices: ControlPlaneUpdaterStorageBindings = bindings();
    const { path, crypto, fs, PRIVATE_EXECUTABLE_MODE, isNodeError } =
      boundServices;

    ensurePrivateDirectory(path.dirname(filePath));
    const temporaryPath = `${filePath}.${crypto.randomUUID()}.tmp`;
    let descriptor: number | undefined;
    let failure: unknown;
    try {
      descriptor = fs.openSync(
        temporaryPath,
        fs.constants.O_WRONLY |
          fs.constants.O_CREAT |
          fs.constants.O_EXCL |
          fs.constants.O_NOFOLLOW,
        PRIVATE_EXECUTABLE_MODE,
      );
      fs.fchmodSync(descriptor, PRIVATE_EXECUTABLE_MODE);
      fs.writeFileSync(descriptor, content);
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      fs.linkSync(temporaryPath, filePath);
      fs.unlinkSync(temporaryPath);
      fsyncDirectory(path.dirname(filePath));
    } catch (error) {
      failure = error;
    }
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch (error) {
        failure ??= error;
      }
    }
    try {
      fs.unlinkSync(temporaryPath);
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'ENOENT') failure ??= error;
    }
    if (failure !== undefined) throw failure;
  }

  function createPrivateFileExclusive(filePath: string, content: string): void {
    const boundServices: ControlPlaneUpdaterStorageBindings = bindings();
    const { path, crypto, fs, PRIVATE_FILE_MODE, isNodeError } = boundServices;

    ensurePrivateDirectory(path.dirname(filePath));
    const temporaryPath = `${filePath}.${crypto.randomUUID()}.tmp`;
    let descriptor: number | undefined;
    let failure: unknown;
    try {
      descriptor = fs.openSync(
        temporaryPath,
        fs.constants.O_WRONLY |
          fs.constants.O_CREAT |
          fs.constants.O_EXCL |
          fs.constants.O_NOFOLLOW,
        PRIVATE_FILE_MODE,
      );
      fs.fchmodSync(descriptor, PRIVATE_FILE_MODE);
      fs.writeFileSync(descriptor, content, 'utf8');
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      fs.linkSync(temporaryPath, filePath);
      fs.unlinkSync(temporaryPath);
      fsyncDirectory(path.dirname(filePath));
    } catch (error) {
      failure = error;
    }
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch (error) {
        failure ??= error;
      }
    }
    try {
      fs.unlinkSync(temporaryPath);
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'ENOENT') failure ??= error;
    }
    if (failure !== undefined) throw failure;
  }

  function replacePrivateFileAtomicCas(
    filePath: string,
    expectedDigest: Sha256Digest,
    content: string,
  ): void {
    const boundServices: ControlPlaneUpdaterStorageBindings = bindings();
    const {
      isRecord,
      workflowError,
      ExitCode,
      crypto,
      fs,
      PRIVATE_FILE_MODE,
      path,
      isNodeError,
    } = boundServices;

    const current = readCanonicalPrivateRecord(
      filePath,
      'CONTROL_PLANE_SUPERVISOR_NOT_FOUND',
    );
    if (!isRecord(current) || current.recordDigest !== expectedDigest) {
      throw workflowError(
        'CONTROL_PLANE_SUPERVISOR_CAS_MISMATCH',
        'Supervisor state changed before the atomic switch.',
        ExitCode.staleState,
      );
    }
    assertPrivateRegularFile(filePath);
    const temporaryPath = `${filePath}.${crypto.randomUUID()}.tmp`;
    let descriptor: number | undefined;
    let failure: unknown;
    try {
      descriptor = fs.openSync(
        temporaryPath,
        fs.constants.O_WRONLY |
          fs.constants.O_CREAT |
          fs.constants.O_EXCL |
          fs.constants.O_NOFOLLOW,
        PRIVATE_FILE_MODE,
      );
      fs.fchmodSync(descriptor, PRIVATE_FILE_MODE);
      fs.writeFileSync(descriptor, content, 'utf8');
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      fs.renameSync(temporaryPath, filePath);
      fsyncDirectory(path.dirname(filePath));
    } catch (error) {
      failure = error;
    }
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch (error) {
        failure ??= error;
      }
    }
    try {
      fs.unlinkSync(temporaryPath);
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'ENOENT') failure ??= error;
    }
    if (failure !== undefined) throw failure;
  }

  function readCanonicalPrivateRecord(
    filePath: string,
    notFoundCode: string,
  ): unknown {
    const boundServices: ControlPlaneUpdaterStorageBindings = bindings();
    const { workflowError, ExitCode, canonicalJson } = boundServices;

    const raw = readPrivateText(filePath, notFoundCode);
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw workflowError(
        'CONTROL_PLANE_STATE_CORRUPT',
        'Control-plane state is not valid JSON.',
        ExitCode.verification,
      );
    }
    if (`${canonicalJson(value)}\n` !== raw) {
      throw workflowError(
        'CONTROL_PLANE_STATE_CORRUPT',
        'Control-plane state is not canonical JSON.',
        ExitCode.verification,
      );
    }
    return value;
  }

  function readPrivateText(filePath: string, notFoundCode: string): string {
    const boundServices: ControlPlaneUpdaterStorageBindings = bindings();
    const { fs, workflowError, ExitCode, MAX_BUNDLE_BYTES } = boundServices;

    const stats = fs.lstatSync(filePath, { throwIfNoEntry: false });
    if (!stats) {
      throw workflowError(
        notFoundCode,
        'Control-plane state was not found.',
        ExitCode.conflict,
      );
    }
    assertPrivateRegularFile(filePath);
    if (stats.size > MAX_BUNDLE_BYTES) {
      throw workflowError(
        'CONTROL_PLANE_STATE_TOO_LARGE',
        'Control-plane state exceeds the maximum size.',
        ExitCode.guard,
      );
    }
    const descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    try {
      const opened = fs.fstatSync(descriptor);
      if (opened.dev !== stats.dev || opened.ino !== stats.ino) {
        throw workflowError(
          'CONTROL_PLANE_STATE_UNSAFE',
          'Control-plane state changed while being opened.',
          ExitCode.unsafeEnvironment,
        );
      }
      return fs.readFileSync(descriptor, 'utf8');
    } finally {
      fs.closeSync(descriptor);
    }
  }

  function assertPrivateRegularFile(filePath: string): void {
    const boundServices: ControlPlaneUpdaterStorageBindings = bindings();
    const { fs, PRIVATE_FILE_MODE, workflowError, ExitCode } = boundServices;

    const stats = fs.lstatSync(filePath, { throwIfNoEntry: false });
    if (
      !stats?.isFile() ||
      stats.isSymbolicLink() ||
      stats.nlink !== 1 ||
      (stats.mode & 0o777) !== PRIVATE_FILE_MODE
    ) {
      throw workflowError(
        'CONTROL_PLANE_STATE_UNSAFE',
        'Control-plane state must be a private regular file.',
        ExitCode.unsafeEnvironment,
      );
    }
  }

  function serializeCanonical(value: unknown): string {
    const boundServices: ControlPlaneUpdaterStorageBindings = bindings();
    const { canonicalJson, MAX_BUNDLE_BYTES, workflowError, ExitCode } =
      boundServices;

    const serialized = `${canonicalJson(value)}\n`;
    if (Buffer.byteLength(serialized) > MAX_BUNDLE_BYTES) {
      throw workflowError(
        'CONTROL_PLANE_STATE_TOO_LARGE',
        'Control-plane state exceeds the maximum size.',
        ExitCode.guard,
      );
    }
    return serialized;
  }

  function fsyncDirectory(directory: string): void {
    const boundServices: ControlPlaneUpdaterStorageBindings = bindings();
    const { fs } = boundServices;

    const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
    try {
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
  }
  return {
    updaterPaths,
    ensureUpdaterDirectories,
    ensurePrivateDirectory,
    withUpdaterLock,
    materializedExecutablePath,
    assertConfinedExecutable,
    assertPrivateExecutable,
    createPrivateExecutableExclusive,
    createPrivateFileExclusive,
    replacePrivateFileAtomicCas,
    readCanonicalPrivateRecord,
    readPrivateText,
    serializeCanonical,
  };
}

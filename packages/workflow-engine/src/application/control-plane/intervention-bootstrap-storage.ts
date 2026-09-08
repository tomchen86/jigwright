// intervention bootstrap storage; repository effects remain bound by the public module.
import type {
  InterventionBootstrapStorageBindings,
  InterventionBootstrapStorageBindingsTypes,
} from './intervention-control-bootstrap.ts';
type Sha256Digest = InterventionBootstrapStorageBindingsTypes['Sha256Digest'];

export function createInterventionBootstrapStorage(
  bindings: () => InterventionBootstrapStorageBindings,
) {
  function localEngineArtifactPath(
    storageRoot: string,
    artifactId: Sha256Digest,
  ): string {
    const boundServices: InterventionBootstrapStorageBindings = bindings();
    const { path, interventionControlPersistencePaths } = boundServices;
    const assertDigest: InterventionBootstrapStorageBindings['assertDigest'] =
      boundServices.assertDigest;

    assertDigest(artifactId, 'BOOTSTRAP_ENGINE_ARTIFACT_CORRUPT');
    return path.join(
      interventionControlPersistencePaths(storageRoot).root,
      'local-engine-artifacts',
      artifactId.slice('sha256:'.length),
      'engine',
    );
  }

  function bindingStateRoot(bindingPath: string): string {
    const boundServices: InterventionBootstrapStorageBindings = bindings();
    const { path } = boundServices;

    const directory = path.dirname(canonicalAbsolutePath(bindingPath));
    return path.basename(directory) === 'local-parent-sessions'
      ? path.dirname(directory)
      : directory;
  }

  function bootstrapBundleDirectory(storageRoot: string): string {
    const boundServices: InterventionBootstrapStorageBindings = bindings();
    const { path, interventionControlPersistencePaths } = boundServices;

    return path.join(
      interventionControlPersistencePaths(storageRoot).root,
      'bootstrap-wip-bundles',
    );
  }

  function bootstrapReceiptDirectory(storageRoot: string): string {
    const boundServices: InterventionBootstrapStorageBindings = bindings();
    const { path, interventionControlPersistencePaths } = boundServices;

    return path.join(
      interventionControlPersistencePaths(storageRoot).root,
      'bootstrap-receipts',
    );
  }

  function wipBundlePath(
    storageRoot: string,
    checkpointId: Sha256Digest,
  ): string {
    const boundServices: InterventionBootstrapStorageBindings = bindings();
    const { path } = boundServices;

    return path.join(
      bootstrapBundleDirectory(storageRoot),
      `${checkpointId.slice('sha256:'.length)}.json`,
    );
  }

  function bootstrapReceiptPath(storageRoot: string, identity: string): string {
    const boundServices: InterventionBootstrapStorageBindings = bindings();
    const { path, crypto } = boundServices;

    return path.join(
      bootstrapReceiptDirectory(storageRoot),
      `${crypto.createHash('sha256').update(identity).digest('hex')}.json`,
    );
  }

  function persistBootstrapReceipt(
    storageRoot: string,
    identity: string,
    receipt: unknown,
  ): void {
    const boundServices: InterventionBootstrapStorageBindings = bindings();
    const { canonicalJson, fs, workflowError, ExitCode } = boundServices;

    const directory = bootstrapReceiptDirectory(storageRoot);
    ensurePrivateDirectory(directory);
    const target = bootstrapReceiptPath(storageRoot, identity);
    const content = Buffer.from(`${canonicalJson(receipt)}\n`);
    if (fs.existsSync(target)) {
      if (
        !readPrivateBytes(
          target,
          'BOOTSTRAP_RECEIPT_NOT_FOUND',
          1024 * 1024,
        ).equals(content)
      ) {
        throw workflowError(
          'BOOTSTRAP_RECEIPT_CONFLICT',
          'Bootstrap receipt identity already contains different bytes.',
          ExitCode.conflict,
        );
      }
      return;
    }
    createPrivateFileExclusive(target, content);
  }

  function readBootstrapReceipt<T>(receiptPath: string): T {
    const boundServices: InterventionBootstrapStorageBindings = bindings();
    const { isRecord, isDigest, workflowError, ExitCode, canonicalDigest } =
      boundServices;

    const value = readCanonicalPrivateJson(
      receiptPath,
      'BOOTSTRAP_RECEIPT_NOT_FOUND',
      1024 * 1024,
    );
    if (!isRecord(value) || !isDigest(value.receiptDigest)) {
      throw workflowError(
        'BOOTSTRAP_RECEIPT_CORRUPT',
        'Bootstrap receipt failed structural verification.',
        ExitCode.verification,
      );
    }
    const { receiptDigest, ...payload } = value;
    if (canonicalDigest(payload) !== receiptDigest) {
      throw workflowError(
        'BOOTSTRAP_RECEIPT_CORRUPT',
        'Bootstrap receipt failed digest verification.',
        ExitCode.verification,
      );
    }
    return value as T;
  }

  function canonicalRepositoryRoot(requestedRoot: string): string {
    const boundServices: InterventionBootstrapStorageBindings = bindings();
    const { fs, workflowError, ExitCode } = boundServices;

    const absolute = canonicalAbsolutePath(requestedRoot);
    const stats = fs.lstatSync(absolute, { throwIfNoEntry: false });
    if (!stats?.isDirectory() || stats.isSymbolicLink()) {
      throw workflowError(
        'BOOTSTRAP_REPOSITORY_UNSAFE',
        'Bootstrap repository root must be a plain directory.',
        ExitCode.unsafeEnvironment,
      );
    }
    const real = fs.realpathSync(absolute);
    if (real !== absolute) {
      throw workflowError(
        'BOOTSTRAP_REPOSITORY_UNSAFE',
        'Bootstrap repository root must be canonical.',
        ExitCode.unsafeEnvironment,
      );
    }
    const topLevel = gitText(real, ['rev-parse', '--show-toplevel']).trim();
    if (fs.realpathSync(topLevel) !== real) {
      throw workflowError(
        'BOOTSTRAP_REPOSITORY_UNSAFE',
        'Requested path is not the exact Git worktree root.',
        ExitCode.unsafeEnvironment,
      );
    }
    return real;
  }

  function canonicalPlannedWorkspacePath(
    requestedPath: string,
    repositoryRoot: string,
  ): string {
    const boundServices: InterventionBootstrapStorageBindings = bindings();
    const { path, fs, workflowError, ExitCode } = boundServices;

    const absolute = canonicalAbsolutePath(requestedPath);
    const parent = path.dirname(absolute);
    if (!fs.existsSync(parent) || fs.realpathSync(parent) !== parent) {
      throw workflowError(
        'BOOTSTRAP_CHILD_WORKSPACE_PARENT_UNSAFE',
        'Child workspace parent directory must be canonical.',
        ExitCode.unsafeEnvironment,
      );
    }
    if (
      parent !== path.dirname(repositoryRoot) ||
      absolute === repositoryRoot ||
      isPathInside(repositoryRoot, absolute) ||
      isPathInside(absolute, repositoryRoot)
    ) {
      throw workflowError(
        'BOOTSTRAP_CHILD_WORKSPACE_SCOPE_INVALID',
        'Child workspace must be a disjoint sibling of the parent worktree.',
        ExitCode.guard,
      );
    }
    return absolute;
  }

  function canonicalPlainFile(
    requestedPath: string,
    maxBytes: number,
    code: string,
  ): string {
    const boundServices: InterventionBootstrapStorageBindings = bindings();
    const { fs, workflowError, ExitCode } = boundServices;

    const absolute = canonicalAbsolutePath(requestedPath);
    const stats = fs.lstatSync(absolute, { throwIfNoEntry: false });
    if (
      !stats?.isFile() ||
      stats.isSymbolicLink() ||
      stats.size > maxBytes ||
      fs.realpathSync(absolute) !== absolute
    ) {
      throw workflowError(
        code,
        'Bootstrap file must be a bounded canonical regular file.',
        ExitCode.unsafeEnvironment,
      );
    }
    return absolute;
  }

  function canonicalAbsolutePath(requestedPath: string): string {
    const boundServices: InterventionBootstrapStorageBindings = bindings();
    const { path, workflowError, ExitCode } = boundServices;

    if (
      typeof requestedPath !== 'string' ||
      !path.isAbsolute(requestedPath) ||
      path.resolve(requestedPath) !== requestedPath ||
      requestedPath === path.parse(requestedPath).root
    ) {
      throw workflowError(
        'BOOTSTRAP_PATH_INVALID',
        'Bootstrap path must be an explicit normalized absolute path.',
        ExitCode.usage,
      );
    }
    return requestedPath;
  }

  function assertPersistenceOwnedPath(
    storageRoot: string,
    requestedPath: string,
    code: string,
  ): string {
    const boundServices: InterventionBootstrapStorageBindings = bindings();
    const { interventionControlPersistencePaths, workflowError, ExitCode } =
      boundServices;

    const root = interventionControlPersistencePaths(storageRoot).root;
    const absolute = canonicalAbsolutePath(requestedPath);
    if (!isPathInside(root, absolute)) {
      throw workflowError(
        code,
        'Bootstrap mutable state must stay inside the persistence root.',
        ExitCode.guard,
      );
    }
    return absolute;
  }

  function assertSafeRelativePath(value: string): void {
    const boundServices: InterventionBootstrapStorageBindings = bindings();
    const { path, workflowError, ExitCode } = boundServices;

    if (
      typeof value !== 'string' ||
      value.length === 0 ||
      value !== value.normalize('NFC') ||
      path.isAbsolute(value) ||
      value.includes('\\') ||
      value
        .split('/')
        .some((part) => part === '' || part === '.' || part === '..') ||
      value === '.git' ||
      value.startsWith('.git/')
    ) {
      throw workflowError(
        'BOOTSTRAP_UNTRACKED_PATH_INVALID',
        'Untracked allowlist path is unsafe.',
        ExitCode.usage,
      );
    }
  }

  function safeRepositoryPath(
    repositoryRoot: string,
    relativePath: string,
  ): string {
    const boundServices: InterventionBootstrapStorageBindings = bindings();
    const { path, workflowError, ExitCode } = boundServices;

    assertSafeRelativePath(relativePath);
    const target = path.resolve(repositoryRoot, relativePath);
    if (!isPathInside(repositoryRoot, target)) {
      throw workflowError(
        'BOOTSTRAP_UNTRACKED_PATH_INVALID',
        'Untracked path escapes the repository root.',
        ExitCode.guard,
      );
    }
    return target;
  }

  function ensureSafeParentDirectories(
    repositoryRoot: string,
    requestedDirectory: string,
  ): void {
    const boundServices: InterventionBootstrapStorageBindings = bindings();
    const { path, fs, workflowError, ExitCode } = boundServices;

    const relative = path.relative(repositoryRoot, requestedDirectory);
    let current = repositoryRoot;
    for (const part of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      const stats = fs.lstatSync(current, { throwIfNoEntry: false });
      if (!stats) {
        fs.mkdirSync(current, { mode: 0o700 });
      } else if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw workflowError(
          'BOOTSTRAP_RESTORE_PARENT_UNSAFE',
          'Untracked restore parent is not a plain directory.',
          ExitCode.unsafeEnvironment,
        );
      }
    }
  }

  function isPathInside(parentPath: string, childPath: string): boolean {
    const boundServices: InterventionBootstrapStorageBindings = bindings();
    const { path } = boundServices;

    const relative = path.relative(parentPath, childPath);
    return (
      relative.length > 0 &&
      !relative.startsWith('..') &&
      !path.isAbsolute(relative)
    );
  }

  function gitBuffer(
    repositoryRoot: string,
    args: string[],
    input?: Buffer,
  ): Buffer {
    const boundServices: InterventionBootstrapStorageBindings = bindings();
    const { spawnSync, MAX_BUNDLE_BYTES, workflowError, ExitCode } =
      boundServices;

    const result = spawnSync('git', ['-C', repositoryRoot, ...args], {
      input,
      encoding: null,
      maxBuffer: MAX_BUNDLE_BYTES,
      env: {
        ...process.env,
        LANG: 'C',
        LC_ALL: 'C',
      },
    });
    if (
      result.error ||
      result.status !== 0 ||
      !Buffer.isBuffer(result.stdout)
    ) {
      const stderr = Buffer.isBuffer(result.stderr)
        ? result.stderr.toString('utf8').slice(0, 1000)
        : '';
      throw workflowError(
        'BOOTSTRAP_GIT_COMMAND_FAILED',
        `Git command failed: ${args[0] ?? 'unknown'}`,
        ExitCode.verification,
        { details: { status: result.status, stderr } },
      );
    }
    return result.stdout;
  }

  function gitBufferNoThrow(repositoryRoot: string, args: string[]): void {
    const boundServices: InterventionBootstrapStorageBindings = bindings();
    const { spawnSync, MAX_BUNDLE_BYTES } = boundServices;

    spawnSync('git', ['-C', repositoryRoot, ...args], {
      encoding: null,
      maxBuffer: MAX_BUNDLE_BYTES,
      env: { ...process.env, LANG: 'C', LC_ALL: 'C' },
    });
  }

  function gitText(repositoryRoot: string, args: string[]): string {
    return gitBuffer(repositoryRoot, args).toString('utf8');
  }

  function gitRefExists(repositoryRoot: string, ref: string): boolean {
    const boundServices: InterventionBootstrapStorageBindings = bindings();
    const { spawnSync, workflowError, ExitCode } = boundServices;

    const result = spawnSync(
      'git',
      ['-C', repositoryRoot, 'show-ref', '--verify', '--quiet', ref],
      { encoding: null, env: { ...process.env, LANG: 'C', LC_ALL: 'C' } },
    );
    if (result.status === 0) {
      return true;
    }
    if (result.status === 1) {
      return false;
    }
    throw workflowError(
      'BOOTSTRAP_GIT_COMMAND_FAILED',
      'Unable to inspect reserved child change ref.',
      ExitCode.verification,
    );
  }

  function createPrivateFileExclusive(filePath: string, content: Buffer): void {
    const boundServices: InterventionBootstrapStorageBindings = bindings();
    const { path, fs } = boundServices;

    ensurePrivateDirectory(path.dirname(filePath));
    const descriptor = fs.openSync(
      filePath,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_NOFOLLOW,
      0o600,
    );
    try {
      fs.fchmodSync(descriptor, 0o600);
      fs.writeFileSync(descriptor, content);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fsyncDirectory(path.dirname(filePath));
  }

  function createPrivateExecutableExclusive(
    filePath: string,
    content: Buffer,
  ): void {
    const boundServices: InterventionBootstrapStorageBindings = bindings();
    const { path, fs, PRIVATE_EXECUTABLE_MODE } = boundServices;

    ensurePrivateDirectory(path.dirname(filePath));
    const descriptor = fs.openSync(
      filePath,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_NOFOLLOW,
      PRIVATE_EXECUTABLE_MODE,
    );
    try {
      fs.fchmodSync(descriptor, PRIVATE_EXECUTABLE_MODE);
      fs.writeFileSync(descriptor, content);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fsyncDirectory(path.dirname(filePath));
  }

  function assertPrivateLocalEngineExecutable(
    filePath: string,
    expectedDigest: Sha256Digest,
  ): void {
    const boundServices: InterventionBootstrapStorageBindings = bindings();
    const {
      fs,
      PRIVATE_EXECUTABLE_MODE,
      MAX_UNTRACKED_FILE_BYTES,
      workflowError,
      ExitCode,
      rawDigest,
    } = boundServices;

    const stats = fs.lstatSync(filePath, { throwIfNoEntry: false });
    if (
      !stats?.isFile() ||
      stats.isSymbolicLink() ||
      stats.nlink !== 1 ||
      (stats.mode & 0o777) !== PRIVATE_EXECUTABLE_MODE ||
      stats.size < 1 ||
      stats.size > MAX_UNTRACKED_FILE_BYTES ||
      fs.realpathSync(filePath) !== filePath
    ) {
      throw workflowError(
        'BOOTSTRAP_LOCAL_ENGINE_ARTIFACT_UNSAFE',
        'Materialized local engine artifact is missing, indirect, or unsafe.',
        ExitCode.unsafeEnvironment,
      );
    }
    const descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    try {
      const opened = fs.fstatSync(descriptor);
      const bytes = fs.readFileSync(descriptor);
      if (
        opened.dev !== stats.dev ||
        opened.ino !== stats.ino ||
        opened.size !== stats.size ||
        rawDigest(bytes) !== expectedDigest
      ) {
        throw workflowError(
          'BOOTSTRAP_LOCAL_ENGINE_ARTIFACT_DIGEST_MISMATCH',
          'Materialized local engine artifact digest changed.',
          ExitCode.verification,
        );
      }
    } finally {
      fs.closeSync(descriptor);
    }
  }

  function writePrivateFileAtomic(filePath: string, content: Buffer): void {
    const boundServices: InterventionBootstrapStorageBindings = bindings();
    const { path, crypto, fs } = boundServices;

    const absolute = canonicalAbsolutePath(filePath);
    ensurePrivateDirectory(path.dirname(absolute));
    const temporaryPath = `${absolute}.${crypto.randomUUID()}.tmp`;
    createPrivateFileExclusive(temporaryPath, content);
    fs.renameSync(temporaryPath, absolute);
    fsyncDirectory(path.dirname(absolute));
  }

  function replacePrivateFileAtomic(
    filePath: string,
    content: Buffer,
    expectedRecordDigest: Sha256Digest,
  ): void {
    const boundServices: InterventionBootstrapStorageBindings = bindings();
    const { readLocalEngineBinding, workflowError, ExitCode } = boundServices;

    const current = readLocalEngineBinding(filePath);
    if (current.recordDigest !== expectedRecordDigest) {
      throw workflowError(
        'BOOTSTRAP_BINDING_CAS_MISMATCH',
        'Local engine binding changed before atomic replacement.',
        ExitCode.staleState,
      );
    }
    writePrivateFileAtomic(filePath, content);
  }

  function ensurePrivateDirectory(directory: string): void {
    const boundServices: InterventionBootstrapStorageBindings = bindings();
    const { ensurePlainDirectory, fs } = boundServices;

    ensurePlainDirectory(directory);
    const stats = fs.statSync(directory);
    if ((stats.mode & 0o077) !== 0) {
      fs.chmodSync(directory, 0o700);
    }
  }

  function readCanonicalPrivateJson(
    filePath: string,
    notFoundCode: string,
    maxBytes: number,
  ): unknown {
    const boundServices: InterventionBootstrapStorageBindings = bindings();
    const { workflowError, ExitCode, canonicalJson } = boundServices;

    const bytes = readPrivateBytes(filePath, notFoundCode, maxBytes);
    const raw = bytes.toString('utf8');
    if (!Buffer.from(raw, 'utf8').equals(bytes)) {
      throw workflowError(
        'BOOTSTRAP_PERSISTENCE_OBJECT_CORRUPT',
        'Bootstrap persistence object is not valid UTF-8.',
        ExitCode.verification,
      );
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw workflowError(
        'BOOTSTRAP_PERSISTENCE_OBJECT_CORRUPT',
        'Bootstrap persistence object is not JSON.',
        ExitCode.verification,
      );
    }
    if (`${canonicalJson(value)}\n` !== raw) {
      throw workflowError(
        'BOOTSTRAP_PERSISTENCE_OBJECT_CORRUPT',
        'Bootstrap persistence object is not canonical.',
        ExitCode.verification,
      );
    }
    return value;
  }

  function readPrivateBytes(
    filePath: string,
    notFoundCode: string,
    maxBytes: number,
  ): Buffer {
    const boundServices: InterventionBootstrapStorageBindings = bindings();
    const { fs, workflowError, ExitCode } = boundServices;

    const stats = fs.lstatSync(filePath, { throwIfNoEntry: false });
    if (!stats) {
      throw workflowError(
        notFoundCode,
        'Bootstrap persistence object was not found.',
        ExitCode.conflict,
      );
    }
    if (
      !stats.isFile() ||
      stats.isSymbolicLink() ||
      stats.nlink !== 1 ||
      (stats.mode & 0o777) !== 0o600 ||
      stats.size > maxBytes
    ) {
      throw workflowError(
        'BOOTSTRAP_PERSISTENCE_OBJECT_UNSAFE',
        'Bootstrap persistence object is not a bounded private file.',
        ExitCode.unsafeEnvironment,
      );
    }
    const descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    try {
      const opened = fs.fstatSync(descriptor);
      if (
        opened.dev !== stats.dev ||
        opened.ino !== stats.ino ||
        opened.nlink !== 1 ||
        (opened.mode & 0o777) !== 0o600 ||
        opened.size > maxBytes
      ) {
        throw workflowError(
          'BOOTSTRAP_PERSISTENCE_OBJECT_UNSAFE',
          'Bootstrap persistence object changed while being opened.',
          ExitCode.unsafeEnvironment,
        );
      }
      return fs.readFileSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
  }

  function readOptionalPlainFile(
    filePath: string,
    maxBytes: number,
  ): Buffer | null {
    const boundServices: InterventionBootstrapStorageBindings = bindings();
    const { fs, workflowError, ExitCode } = boundServices;

    const stats = fs.lstatSync(filePath, { throwIfNoEntry: false });
    if (!stats) {
      return null;
    }
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > maxBytes) {
      throw workflowError(
        'BOOTSTRAP_SESSION_SNAPSHOT_UNSAFE',
        'Existing session snapshot target is unsafe.',
        ExitCode.unsafeEnvironment,
      );
    }
    return fs.readFileSync(filePath);
  }

  function fsyncDirectory(directory: string): void {
    const boundServices: InterventionBootstrapStorageBindings = bindings();
    const { fs } = boundServices;

    const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
    try {
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
  }
  return {
    localEngineArtifactPath,
    bindingStateRoot,
    bootstrapBundleDirectory,
    wipBundlePath,
    bootstrapReceiptPath,
    persistBootstrapReceipt,
    readBootstrapReceipt,
    canonicalRepositoryRoot,
    canonicalPlannedWorkspacePath,
    canonicalPlainFile,
    canonicalAbsolutePath,
    assertPersistenceOwnedPath,
    assertSafeRelativePath,
    safeRepositoryPath,
    ensureSafeParentDirectories,
    isPathInside,
    gitBuffer,
    gitBufferNoThrow,
    gitText,
    gitRefExists,
    createPrivateFileExclusive,
    createPrivateExecutableExclusive,
    assertPrivateLocalEngineExecutable,
    writePrivateFileAtomic,
    replacePrivateFileAtomic,
    ensurePrivateDirectory,
    readCanonicalPrivateJson,
    readPrivateBytes,
    readOptionalPlainFile,
    fsyncDirectory,
  };
}

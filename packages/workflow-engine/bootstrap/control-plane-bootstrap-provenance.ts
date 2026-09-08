import { BUILT_IN_BOOTSTRAP_RUNTIME_PATHS } from './control-plane-bootstrap-values.ts';
/** Immutable Git repository identity and initial supervisor provenance. */
import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  bootstrapRepositoryIdentityInvalid,
  MAX_STATE_BYTES,
  isRecord,
  isNonEmptyTrimmed,
  bootstrapPackageRootInvalid,
  bootstrapBaseMismatch,
  bootstrapRemoteBaseMismatch,
  bootstrapProvenanceChanged,
  PROCESS_TIMEOUT_MS,
  trustError,
  MAX_CLOSURE_FILE_BYTES,
  protectedCapabilityManifestInvalid,
} from './control-plane-bootstrap-values.ts';
import type {
  BootstrapRepositoryIdentity,
  InitialSupervisorProvenance,
  BootstrapProtectedTreeEntry,
} from './control-plane-bootstrap-types.ts';
import { safeProtectedCapabilityPath } from './control-plane-bootstrap-protected-records.ts';

/** Resolve the repository identity from clean Git inputs, never mutable src. */
export function verifyBootstrapRepositoryIdentity(
  identity: BootstrapRepositoryIdentity,
): string {
  assertBootstrapRepositoryPaths(identity);
  const captured = readBootstrapHeadAndTree(identity.worktreeRoot);
  const repositoryId = verifyBootstrapRepositoryIdentityAt(
    identity,
    captured.headOid,
  );
  const observed = readBootstrapHeadAndTree(identity.worktreeRoot);
  const observedRepositoryId = verifyBootstrapRepositoryIdentityAt(
    identity,
    captured.headOid,
  );
  if (
    observed.headOid !== captured.headOid ||
    observed.treeOid !== captured.treeOid ||
    observedRepositoryId !== repositoryId
  ) {
    throw bootstrapRepositoryIdentityInvalid();
  }
  return repositoryId;
}

export function verifyBootstrapRepositoryIdentityAt(
  identity: BootstrapRepositoryIdentity,
  revision: string,
): string {
  const observedCommonDirectory = exactBootstrapGitOutput(
    identity.worktreeRoot,
    ['rev-parse', '--path-format=absolute', '--git-common-dir'],
  );
  const observedWorktreeRoot = exactBootstrapGitOutput(identity.worktreeRoot, [
    'rev-parse',
    '--path-format=absolute',
    '--show-toplevel',
  ]);
  let exactCommonDirectory: string;
  let exactWorktreeRoot: string;
  try {
    if (
      observedCommonDirectory.includes('\n') ||
      observedWorktreeRoot.includes('\n')
    ) {
      throw bootstrapRepositoryIdentityInvalid();
    }
    exactCommonDirectory = fs.realpathSync(observedCommonDirectory);
    exactWorktreeRoot = fs.realpathSync(observedWorktreeRoot);
  } catch {
    throw bootstrapRepositoryIdentityInvalid();
  }
  if (
    exactCommonDirectory !== identity.gitCommonDirectory ||
    exactWorktreeRoot !== identity.worktreeRoot
  ) {
    throw bootstrapRepositoryIdentityInvalid();
  }
  const policyBytes = exactBootstrapGitOutput(identity.worktreeRoot, [
    'show',
    `${revision}:workflow/maintainer-policy.json`,
  ]);
  if (Buffer.byteLength(policyBytes) > MAX_STATE_BYTES) {
    throw bootstrapRepositoryIdentityInvalid();
  }
  let policy: unknown;
  try {
    policy = JSON.parse(policyBytes);
  } catch {
    throw bootstrapRepositoryIdentityInvalid();
  }
  if (
    !isRecord(policy) ||
    !isRecord(policy.repository) ||
    !isNonEmptyTrimmed(policy.repository.id) ||
    policy.repository.id.length > 512 ||
    !/^github:[A-Za-z0-9_.:-]+$/.test(policy.repository.id) ||
    !isNonEmptyTrimmed(policy.repository.origin) ||
    policy.repository.origin.length > 2_048 ||
    !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/.test(
      policy.repository.origin,
    )
  ) {
    throw bootstrapRepositoryIdentityInvalid();
  }
  const origin = exactBootstrapGitOutput(identity.worktreeRoot, [
    'config',
    '--local',
    '--get',
    'remote.origin.url',
  ]);
  if (origin.includes('\n') || origin !== policy.repository.origin) {
    throw bootstrapRepositoryIdentityInvalid();
  }
  return policy.repository.id;
}

export function captureInitialSupervisorProvenance(
  identity: BootstrapRepositoryIdentity,
  packageRoot: string,
): InitialSupervisorProvenance {
  assertBootstrapRepositoryPaths(identity);
  const expectedPackageRoot = path.join(
    identity.worktreeRoot,
    'packages',
    'workflow-engine',
  );
  if (packageRoot !== expectedPackageRoot) {
    throw bootstrapPackageRootInvalid();
  }
  assertTrackedBootstrapPackageRoot(packageRoot);

  let branchRef: string;
  try {
    branchRef = exactBootstrapGitOutput(identity.worktreeRoot, [
      'symbolic-ref',
      '-q',
      'HEAD',
    ]);
  } catch {
    throw bootstrapBaseMismatch();
  }
  if (
    identity.branchRef !== branchRef ||
    !/^refs\/heads\/[A-Za-z0-9._/-]+$/.test(branchRef)
  ) {
    throw bootstrapBaseMismatch();
  }

  const { headOid, treeOid } = readBootstrapHeadAndTree(identity.worktreeRoot);
  const branchHead = exactBootstrapGitOutput(identity.worktreeRoot, [
    'rev-parse',
    '--verify',
    `${branchRef}^{commit}`,
  ]);
  if (branchHead !== headOid) throw bootstrapBaseMismatch();

  const configRaw = exactBootstrapGitOutput(identity.worktreeRoot, [
    'show',
    `${headOid}:workflow/config.json`,
  ]);
  let config: unknown;
  try {
    config = JSON.parse(configRaw);
  } catch {
    throw bootstrapBaseMismatch();
  }
  if (
    !isRecord(config) ||
    !Array.isArray(config.protectedBranches) ||
    config.protectedBranches.length === 0 ||
    !config.protectedBranches.every(
      (entry) =>
        typeof entry === 'string' &&
        /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(entry) &&
        !entry.includes('..'),
    ) ||
    `refs/heads/${String(config.protectedBranches[0])}` !== branchRef
  ) {
    throw bootstrapBaseMismatch();
  }
  const remoteBaseRef = `refs/remotes/origin/${String(config.protectedBranches[0])}`;
  const remoteBaseOid = readBootstrapRemoteBaseOid(
    identity.worktreeRoot,
    remoteBaseRef,
  );
  if (remoteBaseOid !== headOid) throw bootstrapRemoteBaseMismatch();

  const repositoryId = verifyBootstrapRepositoryIdentityAt(identity, headOid);
  assertBootstrapRepositoryClean(identity.worktreeRoot);
  const tree = readBootstrapHeadTree(identity.worktreeRoot, headOid);
  const requiredTrackedPaths = [
    'packages/workflow-engine/package.json',
    'packages/workflow-engine/bootstrap/built-in-engine-closure.json',
    ...BUILT_IN_BOOTSTRAP_RUNTIME_PATHS,
    'packages/workflow-engine/bootstrap/workflow-launcher.ts',
  ];
  for (const requiredPath of requiredTrackedPaths) {
    const entry = tree.find((candidate) => candidate.path === requiredPath);
    if (
      entry?.type !== 'blob' ||
      (entry.mode !== '100644' && entry.mode !== '100755')
    ) {
      throw bootstrapPackageRootInvalid();
    }
  }
  return {
    repositoryId,
    branchRef,
    remoteBaseRef,
    remoteBaseOid,
    headOid,
    treeOid,
    packageRoot,
  };
}

export function assertInitialSupervisorProvenanceUnchanged(
  identity: BootstrapRepositoryIdentity,
  provenance: InitialSupervisorProvenance,
): void {
  try {
    assertBootstrapRepositoryPaths(identity);
    assertTrackedBootstrapPackageRoot(provenance.packageRoot);
    const branchRef = exactBootstrapGitOutput(identity.worktreeRoot, [
      'symbolic-ref',
      '-q',
      'HEAD',
    ]);
    const observed = readBootstrapHeadAndTree(identity.worktreeRoot);
    const remoteBaseOid = readBootstrapRemoteBaseOid(
      identity.worktreeRoot,
      provenance.remoteBaseRef,
    );
    const repositoryId = verifyBootstrapRepositoryIdentityAt(
      identity,
      provenance.headOid,
    );
    assertBootstrapRepositoryClean(identity.worktreeRoot);
    if (
      branchRef !== provenance.branchRef ||
      identity.branchRef !== provenance.branchRef ||
      observed.headOid !== provenance.headOid ||
      observed.treeOid !== provenance.treeOid ||
      remoteBaseOid !== provenance.remoteBaseOid ||
      repositoryId !== provenance.repositoryId
    ) {
      throw bootstrapProvenanceChanged();
    }
  } catch (error) {
    if (
      isRecord(error) &&
      error.code === 'CONTROL_PLANE_BOOTSTRAP_PROVENANCE_CHANGED'
    ) {
      throw error;
    }
    throw bootstrapProvenanceChanged();
  }
}

export function readBootstrapRemoteBaseOid(
  worktreeRoot: string,
  remoteBaseRef: string,
): string {
  if (
    !/^refs\/remotes\/origin\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(remoteBaseRef)
  ) {
    throw bootstrapRemoteBaseMismatch();
  }
  let oid: string;
  try {
    oid = exactBootstrapGitOutput(worktreeRoot, [
      'rev-parse',
      '--verify',
      `${remoteBaseRef}^{commit}`,
    ]);
  } catch {
    throw bootstrapRemoteBaseMismatch();
  }
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid)) {
    throw bootstrapRemoteBaseMismatch();
  }
  return oid;
}

function readBootstrapHeadAndTree(worktreeRoot: string): {
  headOid: string;
  treeOid: string;
} {
  const headOid = exactBootstrapGitOutput(worktreeRoot, [
    'rev-parse',
    '--verify',
    'HEAD^{commit}',
  ]);
  const treeOid = exactBootstrapGitOutput(worktreeRoot, [
    'rev-parse',
    '--verify',
    `${headOid}^{tree}`,
  ]);
  if (
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(headOid) ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(treeOid)
  ) {
    throw bootstrapRepositoryIdentityInvalid();
  }
  return { headOid, treeOid };
}

function assertTrackedBootstrapPackageRoot(packageRoot: string): void {
  const stats = fs.lstatSync(packageRoot, { throwIfNoEntry: false });
  if (
    !stats?.isDirectory() ||
    stats.isSymbolicLink() ||
    path.resolve(packageRoot) !== packageRoot ||
    fs.realpathSync(packageRoot) !== packageRoot
  ) {
    throw bootstrapPackageRootInvalid();
  }
}

function assertBootstrapRepositoryPaths(
  identity: BootstrapRepositoryIdentity,
): void {
  for (const directory of [
    identity.gitCommonDirectory,
    identity.worktreeRoot,
  ]) {
    const stats = fs.lstatSync(directory, { throwIfNoEntry: false });
    if (
      typeof directory !== 'string' ||
      !path.isAbsolute(directory) ||
      path.resolve(directory) !== directory ||
      !stats?.isDirectory() ||
      stats.isSymbolicLink() ||
      fs.realpathSync(directory) !== directory
    ) {
      throw bootstrapRepositoryIdentityInvalid();
    }
  }
  if (
    identity.branchRef !== null &&
    (!isNonEmptyTrimmed(identity.branchRef) ||
      !identity.branchRef.startsWith('refs/heads/') ||
      identity.branchRef.includes('\0') ||
      identity.branchRef.includes('\n'))
  ) {
    throw bootstrapRepositoryIdentityInvalid();
  }
}

export function exactBootstrapGitOutput(
  cwd: string,
  argv: readonly string[],
  allowEmpty = false,
): string {
  const executable = process.platform === 'win32' ? 'git' : '/usr/bin/git';
  const result = childProcess.spawnSync(executable, [...argv], {
    cwd,
    encoding: 'utf8',
    env: {
      PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
      LANG: 'C',
      LC_ALL: 'C',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
    },
    timeout: PROCESS_TIMEOUT_MS,
    maxBuffer: MAX_STATE_BYTES,
    windowsHide: true,
  });
  if (
    result.error !== undefined ||
    result.signal !== null ||
    result.status !== 0 ||
    typeof result.stdout !== 'string' ||
    Buffer.byteLength(result.stdout) > MAX_STATE_BYTES
  ) {
    throw bootstrapRepositoryIdentityInvalid();
  }
  const output = result.stdout.trim();
  if ((!allowEmpty && output.length === 0) || output.includes('\0')) {
    throw bootstrapRepositoryIdentityInvalid();
  }
  return output;
}

function assertBootstrapRepositoryClean(worktreeRoot: string): void {
  const status = exactBootstrapGitOutput(
    worktreeRoot,
    ['status', '--porcelain=v1', '--untracked-files=all'],
    true,
  );
  if (status.length !== 0) {
    throw trustError(
      'CONTROL_PLANE_BOOTSTRAP_REPOSITORY_DIRTY',
      'Initial control-plane bootstrap requires a clean repository worktree.',
      14,
    );
  }
}

export function readBootstrapHeadTree(
  worktreeRoot: string,
  revision = 'HEAD',
): BootstrapProtectedTreeEntry[] {
  const executable = process.platform === 'win32' ? 'git' : '/usr/bin/git';
  const result = childProcess.spawnSync(
    executable,
    ['-c', 'core.quotePath=false', 'ls-tree', '-rz', '--full-tree', revision],
    {
      cwd: worktreeRoot,
      encoding: 'buffer',
      env: {
        PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
        LANG: 'C',
        LC_ALL: 'C',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
        GIT_TERMINAL_PROMPT: '0',
      },
      timeout: PROCESS_TIMEOUT_MS,
      maxBuffer: MAX_CLOSURE_FILE_BYTES,
      windowsHide: true,
    },
  );
  if (
    result.error !== undefined ||
    result.signal !== null ||
    result.status !== 0 ||
    !Buffer.isBuffer(result.stdout) ||
    result.stdout.length > MAX_CLOSURE_FILE_BYTES
  ) {
    throw protectedCapabilityManifestInvalid();
  }
  const output = result.stdout;
  if (output.length === 0) return [];
  if (output.at(-1) !== 0) throw protectedCapabilityManifestInvalid();
  const text = output.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(output)) {
    throw protectedCapabilityManifestInvalid();
  }
  const entries = text
    .slice(0, -1)
    .split('\0')
    .map((record): BootstrapProtectedTreeEntry => {
      const tab = record.indexOf('\t');
      const metadata = tab === -1 ? [] : record.slice(0, tab).split(' ');
      const filePath = tab === -1 ? '' : record.slice(tab + 1);
      const [mode, type, objectId] = metadata;
      if (
        metadata.length !== 3 ||
        mode === undefined ||
        type === undefined ||
        objectId === undefined ||
        !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(objectId) ||
        !safeProtectedCapabilityPath(filePath, false)
      ) {
        throw protectedCapabilityManifestInvalid();
      }
      return { path: filePath, mode, objectId, type };
    });
  const paths = entries.map((entry) => entry.path);
  if (new Set(paths).size !== paths.length) {
    throw protectedCapabilityManifestInvalid();
  }
  return entries;
}

export function readBootstrapGitBlob(
  worktreeRoot: string,
  revision: string,
  filePath: string,
): Buffer {
  if (
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(revision) ||
    !safeProtectedCapabilityPath(filePath, false)
  ) {
    throw protectedCapabilityManifestInvalid();
  }
  const executable = process.platform === 'win32' ? 'git' : '/usr/bin/git';
  const result = childProcess.spawnSync(
    executable,
    ['show', `${revision}:${filePath}`],
    {
      cwd: worktreeRoot,
      encoding: 'buffer',
      env: {
        PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
        LANG: 'C',
        LC_ALL: 'C',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
        GIT_TERMINAL_PROMPT: '0',
      },
      timeout: PROCESS_TIMEOUT_MS,
      maxBuffer: MAX_CLOSURE_FILE_BYTES,
      windowsHide: true,
    },
  );
  if (
    result.error !== undefined ||
    result.signal !== null ||
    result.status !== 0 ||
    !Buffer.isBuffer(result.stdout) ||
    result.stdout.length > MAX_CLOSURE_FILE_BYTES
  ) {
    throw protectedCapabilityManifestInvalid();
  }
  return result.stdout;
}

export function bootstrapCommitIsAncestor(
  worktreeRoot: string,
  ancestor: string,
  descendant: string,
): boolean {
  if (
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(ancestor) ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(descendant)
  ) {
    return false;
  }
  const executable = process.platform === 'win32' ? 'git' : '/usr/bin/git';
  const result = childProcess.spawnSync(
    executable,
    ['merge-base', '--is-ancestor', ancestor, descendant],
    {
      cwd: worktreeRoot,
      encoding: 'utf8',
      env: {
        PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
        LANG: 'C',
        LC_ALL: 'C',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
        GIT_TERMINAL_PROMPT: '0',
      },
      timeout: PROCESS_TIMEOUT_MS,
      maxBuffer: MAX_STATE_BYTES,
      windowsHide: true,
    },
  );
  return (
    result.error === undefined && result.signal === null && result.status === 0
  );
}

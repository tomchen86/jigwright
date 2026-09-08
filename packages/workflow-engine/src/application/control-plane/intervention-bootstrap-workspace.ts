// intervention bootstrap workspace; repository effects remain bound by the public module.
import type {
  InterventionBootstrapWorkspaceBindings,
  InterventionBootstrapWorkspaceBindingsTypes,
} from './intervention-control-bootstrap.ts';
type Sha256Digest = InterventionBootstrapWorkspaceBindingsTypes['Sha256Digest'];
type PersistedInterventionRecord =
  InterventionBootstrapWorkspaceBindingsTypes['PersistedInterventionRecord'];
type PersistedWipBundle =
  InterventionBootstrapWorkspaceBindingsTypes['PersistedWipBundle'];
type HarnessMaintenanceGrantEnvelope =
  InterventionBootstrapWorkspaceBindingsTypes['HarnessMaintenanceGrantEnvelope'];
type BootstrapDependencies =
  InterventionBootstrapWorkspaceBindingsTypes['BootstrapDependencies'];
type WipRestoreReceipt =
  InterventionBootstrapWorkspaceBindingsTypes['WipRestoreReceipt'];
type PersistedUntrackedFile =
  InterventionBootstrapWorkspaceBindingsTypes['PersistedUntrackedFile'];
declare const persistInterventionPlan: InterventionBootstrapWorkspaceBindings['persistInterventionPlan'];

export function createInterventionBootstrapWorkspace(
  bindings: () => InterventionBootstrapWorkspaceBindings,
) {
  function discoverBootstrapUntrackedAllowlist(
    repositoryRoot: string,
  ): string[] {
    const boundServices: InterventionBootstrapWorkspaceBindings = bindings();
    const { canonicalRepositoryRoot } = boundServices;

    return listUntracked(canonicalRepositoryRoot(repositoryRoot));
  }

  function persistTrustedBootstrapSessionSnapshot(
    storageRoot: string,
    session: unknown,
  ): string {
    const boundServices: InterventionBootstrapWorkspaceBindings = bindings();
    const {
      canonicalJson,
      MAX_SESSION_BYTES,
      workflowError,
      ExitCode,
      rawDigest,
      path,
      interventionControlPersistencePaths,
      createPrivateFileExclusive,
      isNodeError,
      readPrivateBytes,
    } = boundServices;

    const content = Buffer.from(`${canonicalJson(session)}\n`, 'utf8');
    if (content.length > MAX_SESSION_BYTES) {
      throw workflowError(
        'BOOTSTRAP_SESSION_SNAPSHOT_TOO_LARGE',
        'Durable workflow session exceeds the bootstrap size limit.',
        ExitCode.guard,
      );
    }
    const digest = rawDigest(content);
    const snapshotPath = path.join(
      interventionControlPersistencePaths(storageRoot).root,
      'session-snapshots',
      `${digest.slice('sha256:'.length)}.json`,
    );
    try {
      createPrivateFileExclusive(snapshotPath, content);
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'EEXIST') {
        throw error;
      }
    }
    const observed = readPrivateBytes(
      snapshotPath,
      'BOOTSTRAP_SESSION_SNAPSHOT_NOT_FOUND',
      MAX_SESSION_BYTES,
    );
    if (!observed.equals(content)) {
      throw workflowError(
        'BOOTSTRAP_SESSION_SNAPSHOT_CONFLICT',
        'Content-addressed durable session snapshot differs from its source.',
        ExitCode.staleState,
      );
    }
    return snapshotPath;
  }

  function capturePersistedWipIntervention(
    storageRoot: string,
    input: {
      repositoryRoot: string;
      parent: Parameters<typeof persistInterventionPlan>[1]['parent'];
      interventionChangeId: string;
      childWorkspacePath: string;
      changeRef: string;
      untrackedAllowlist: string[];
      sessionSnapshotPath: string;
      pendingIntent: string;
      policyDigest: Sha256Digest;
      now: Date;
      testAfterInterventionPersistedBeforeSidecar?: () => void;
    },
  ): {
    intervention: PersistedInterventionRecord;
    bundle: PersistedWipBundle;
  } {
    const boundServices: InterventionBootstrapWorkspaceBindings = bindings();
    const {
      canonicalRepositoryRoot,
      exactDate,
      gitText,
      assertGitOid,
      MAX_SESSION_BYTES,
      workflowError,
      ExitCode,
      gitBuffer,
      MAX_PATCH_BYTES,
      canonicalJson,
      canonicalPlainFile,
      assertPersistenceOwnedPath,
      fs,
      rawDigest,
      canonicalDigest,
      createWipCheckpoint,
      persistInterventionPlan,
      canonicalPlannedWorkspacePath,
    } = boundServices;
    const assertDigest: InterventionBootstrapWorkspaceBindings['assertDigest'] =
      boundServices.assertDigest;
    const assertNonEmpty: InterventionBootstrapWorkspaceBindings['assertNonEmpty'] =
      boundServices.assertNonEmpty;

    const repositoryRoot = canonicalRepositoryRoot(input.repositoryRoot);
    const now = exactDate(input.now, 'BOOTSTRAP_CLOCK_INVALID');
    const baseOid = gitText(repositoryRoot, ['rev-parse', 'HEAD']).trim();
    assertGitOid(baseOid, 'BOOTSTRAP_BASE_OID_INVALID');
    assertDigest(input.parent.engineBinding, 'BOOTSTRAP_ENGINE_DIGEST_INVALID');
    assertDigest(input.policyDigest, 'BOOTSTRAP_POLICY_DIGEST_INVALID');
    assertNonEmpty(input.pendingIntent, 'BOOTSTRAP_PENDING_INTENT_INVALID');
    if (Buffer.byteLength(input.pendingIntent, 'utf8') > MAX_SESSION_BYTES) {
      throw workflowError(
        'BOOTSTRAP_PENDING_INTENT_INVALID',
        'Pending intent exceeds the bootstrap size limit.',
        ExitCode.guard,
      );
    }
    const workingTreePatch = gitBuffer(repositoryRoot, [
      'diff',
      '--binary',
      '--full-index',
      'HEAD',
      '--',
    ]);
    const stagedPatch = gitBuffer(repositoryRoot, [
      'diff',
      '--binary',
      '--full-index',
      '--cached',
      'HEAD',
      '--',
    ]);
    if (
      workingTreePatch.length > MAX_PATCH_BYTES ||
      stagedPatch.length > MAX_PATCH_BYTES
    ) {
      throw workflowError(
        'BOOTSTRAP_TRACKED_PATCH_TOO_LARGE',
        'Tracked WIP patch exceeds the bootstrap size limit.',
        ExitCode.guard,
      );
    }
    const trackedPaths = parseNulPaths(
      gitBuffer(repositoryRoot, ['diff', '--name-only', '-z', 'HEAD', '--']),
    );
    const allowlist = validateUntrackedAllowlist(input.untrackedAllowlist);
    const observedUntracked = listUntracked(repositoryRoot);
    if (canonicalJson(allowlist) !== canonicalJson(observedUntracked)) {
      throw workflowError(
        'BOOTSTRAP_UNTRACKED_ALLOWLIST_MISMATCH',
        'Untracked allowlist must exactly cover every non-ignored untracked path.',
        ExitCode.guard,
        { details: { expected: observedUntracked, actual: allowlist } },
      );
    }
    const untracked = captureUntrackedFiles(repositoryRoot, allowlist);
    const sessionSnapshotPath = canonicalPlainFile(
      assertPersistenceOwnedPath(
        storageRoot,
        input.sessionSnapshotPath,
        'BOOTSTRAP_SESSION_SNAPSHOT_OUTSIDE_STATE',
      ),
      MAX_SESSION_BYTES,
      'BOOTSTRAP_SESSION_SNAPSHOT_UNSAFE',
    );
    const sessionBytes = fs.readFileSync(sessionSnapshotPath);
    const status = gitBuffer(repositoryRoot, [
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
    ]);
    const tracked = {
      paths: trackedPaths,
      workingTreePatchBase64: workingTreePatch.toString('base64'),
      stagedPatchBase64: stagedPatch.toString('base64'),
      workingTreePatchDigest: rawDigest(workingTreePatch),
      stagedPatchDigest: rawDigest(stagedPatch),
    };
    const trackedTreeDigest = canonicalDigest(tracked);
    const untrackedBundleDigest = canonicalDigest(untracked);
    const sessionStateDigest = rawDigest(sessionBytes);
    const pendingIntentDigest = rawDigest(Buffer.from(input.pendingIntent));
    const worktreeFingerprint = canonicalDigest({
      baseOid,
      statusDigest: rawDigest(status),
      trackedTreeDigest,
      untrackedBundleDigest,
      sessionStateDigest,
      pendingIntentDigest,
    });
    const checkpoint = createWipCheckpoint({
      parentChangeId: input.parent.changeId,
      baseOid,
      worktreeFingerprint,
      trackedTreeDigest,
      untrackedBundleDigest,
      sessionStateDigest,
      pendingIntentDigest,
      engineDigest: input.parent.engineBinding,
      policyDigest: input.policyDigest,
      createdAt: now.toISOString(),
    });
    const bundlePayload = {
      kind: 'harness-wip-bundle.v1' as const,
      checkpointId: checkpoint.checkpointId,
      parentChangeId: input.parent.changeId,
      repositoryRoot,
      baseOid,
      tracked,
      untracked,
      session: {
        snapshotPath: sessionSnapshotPath,
        contentBase64: sessionBytes.toString('base64'),
        contentDigest: sessionStateDigest,
      },
      pendingIntent: input.pendingIntent,
      statusPorcelainBase64: status.toString('base64'),
      capturedAt: now.toISOString(),
    };
    const bundle: PersistedWipBundle = {
      ...bundlePayload,
      bundleDigest: canonicalDigest(bundlePayload),
    };
    persistWipBundle(storageRoot, bundle);
    const intervention = persistInterventionPlan(storageRoot, {
      parent: input.parent,
      interventionChangeId: input.interventionChangeId,
      checkpoint,
      childWorkspace: {
        parentWorkspacePath: repositoryRoot,
        childWorkspacePath: canonicalPlannedWorkspacePath(
          input.childWorkspacePath,
          repositoryRoot,
        ),
        changeRef: input.changeRef,
      },
      now,
      testAfterInterventionPersistedBeforeSidecar:
        input.testAfterInterventionPersistedBeforeSidecar,
    });
    return { intervention, bundle };
  }

  function readPersistedWipBundle(
    storageRoot: string,
    checkpointId: Sha256Digest,
  ): PersistedWipBundle {
    const boundServices: InterventionBootstrapWorkspaceBindings = bindings();
    const {
      readCanonicalPrivateJson,
      wipBundlePath,
      MAX_BUNDLE_BYTES,
      isRecord,
      hasExactKeys,
      corruptWipBundle,
      canonicalDigest,
      rawDigest,
      decodeCanonicalBase64,
      assertSafeRelativePath,
      canonicalJson,
      exactIso,
      assertGitOid,
    } = boundServices;
    const assertDigest: InterventionBootstrapWorkspaceBindings['assertDigest'] =
      boundServices.assertDigest;

    assertDigest(checkpointId, 'BOOTSTRAP_CHECKPOINT_ID_INVALID');
    const value = readCanonicalPrivateJson(
      wipBundlePath(storageRoot, checkpointId),
      'BOOTSTRAP_WIP_BUNDLE_NOT_FOUND',
      MAX_BUNDLE_BYTES,
    );
    if (
      !isRecord(value) ||
      value.kind !== 'harness-wip-bundle.v1' ||
      value.checkpointId !== checkpointId ||
      !hasExactKeys(value, [
        'baseOid',
        'bundleDigest',
        'capturedAt',
        'checkpointId',
        'kind',
        'parentChangeId',
        'pendingIntent',
        'repositoryRoot',
        'session',
        'statusPorcelainBase64',
        'tracked',
        'untracked',
      ])
    ) {
      throw corruptWipBundle();
    }
    const bundle = value as unknown as PersistedWipBundle;
    const { bundleDigest, ...payload } = bundle;
    try {
      assertDigest(bundleDigest, 'BOOTSTRAP_WIP_BUNDLE_CORRUPT');
      if (
        !isRecord(bundle.tracked) ||
        !hasExactKeys(bundle.tracked, [
          'paths',
          'stagedPatchBase64',
          'stagedPatchDigest',
          'workingTreePatchBase64',
          'workingTreePatchDigest',
        ]) ||
        !isRecord(bundle.session) ||
        !hasExactKeys(bundle.session, [
          'contentBase64',
          'contentDigest',
          'snapshotPath',
        ]) ||
        canonicalDigest(payload) !== bundleDigest ||
        rawDigest(
          decodeCanonicalBase64(bundle.tracked.workingTreePatchBase64),
        ) !== bundle.tracked.workingTreePatchDigest ||
        rawDigest(decodeCanonicalBase64(bundle.tracked.stagedPatchBase64)) !==
          bundle.tracked.stagedPatchDigest ||
        rawDigest(decodeCanonicalBase64(bundle.session.contentBase64)) !==
          bundle.session.contentDigest ||
        !Array.isArray(bundle.untracked) ||
        !Array.isArray(bundle.tracked.paths) ||
        typeof bundle.statusPorcelainBase64 !== 'string'
      ) {
        throw corruptWipBundle();
      }
      decodeCanonicalBase64(bundle.statusPorcelainBase64);
      for (const trackedPath of bundle.tracked.paths) {
        assertSafeRelativePath(trackedPath);
      }
      if (
        canonicalJson(bundle.tracked.paths) !==
        canonicalJson([...new Set(bundle.tracked.paths)].sort())
      ) {
        throw corruptWipBundle();
      }
      for (const entry of bundle.untracked) {
        if (
          !isRecord(entry) ||
          !hasExactKeys(entry, [
            'contentBase64',
            'contentDigest',
            'mode',
            'path',
          ])
        ) {
          throw corruptWipBundle();
        }
        assertSafeRelativePath(entry.path);
        if (
          !['100644', '100755'].includes(entry.mode) ||
          rawDigest(decodeCanonicalBase64(entry.contentBase64)) !==
            entry.contentDigest
        ) {
          throw corruptWipBundle();
        }
      }
      exactIso(bundle.capturedAt, 'BOOTSTRAP_WIP_BUNDLE_CORRUPT');
      assertGitOid(bundle.baseOid, 'BOOTSTRAP_WIP_BUNDLE_CORRUPT');
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        error.code === 'BOOTSTRAP_WIP_BUNDLE_CORRUPT'
      ) {
        throw error;
      }
      throw corruptWipBundle();
    }
    return bundle;
  }

  function restorePersistedWipBundle(
    storageRoot: string,
    input: {
      parentChangeId: string;
      repositoryRoot: string;
      sessionSnapshotPath: string;
      maintenanceGrantEnvelope: HarnessMaintenanceGrantEnvelope;
    },
    dependencies: BootstrapDependencies,
  ): WipRestoreReceipt {
    const boundServices: InterventionBootstrapWorkspaceBindings = bindings();
    const {
      requireHumanVerifier,
      bootstrapNow,
      readPersistedIntervention,
      verifyHarnessMaintenanceGrant,
      canonicalRepositoryRoot,
      assertPersistenceOwnedPath,
      workflowError,
      ExitCode,
      gitText,
      bootstrapReceiptPath,
      fs,
      readBootstrapReceipt,
      gitBuffer,
      readOptionalPlainFile,
      MAX_SESSION_BYTES,
      decodeCanonicalBase64,
      writePrivateFileAtomic,
      canonicalDigest,
      persistBootstrapReceipt,
    } = boundServices;

    const verifier = requireHumanVerifier(dependencies);
    const now = bootstrapNow(dependencies);
    const intervention = readPersistedIntervention(
      storageRoot,
      input.parentChangeId,
    );
    verifyHarnessMaintenanceGrant(input.maintenanceGrantEnvelope, {
      now,
      parent: intervention.parent,
      relationship: intervention.relationship,
      checkpoint: intervention.checkpoint,
      verifyHumanSignature: verifier,
    });
    const bundle = readPersistedWipBundle(
      storageRoot,
      intervention.checkpoint.checkpointId,
    );
    const repositoryRoot = canonicalRepositoryRoot(input.repositoryRoot);
    const sessionPath = assertPersistenceOwnedPath(
      storageRoot,
      input.sessionSnapshotPath,
      'BOOTSTRAP_SESSION_SNAPSHOT_OUTSIDE_STATE',
    );
    if (
      repositoryRoot !== intervention.childWorkspace.parentWorkspacePath ||
      repositoryRoot !== bundle.repositoryRoot ||
      sessionPath !== bundle.session.snapshotPath
    ) {
      throw workflowError(
        'BOOTSTRAP_RESTORE_BINDING_MISMATCH',
        'Restore target differs from the signed intervention checkpoint.',
        ExitCode.verification,
      );
    }
    assertCheckpointMatchesBundle(intervention, bundle);
    if (
      gitText(repositoryRoot, ['rev-parse', 'HEAD']).trim() !== bundle.baseOid
    ) {
      throw workflowError(
        'BOOTSTRAP_RESTORE_BASE_MISMATCH',
        'Parent HEAD changed since checkpoint capture.',
        ExitCode.staleState,
      );
    }
    const receiptPath = bootstrapReceiptPath(
      storageRoot,
      `restore-${bundle.checkpointId}`,
    );
    if (fs.existsSync(receiptPath)) {
      const receipt = readBootstrapReceipt<WipRestoreReceipt>(receiptPath);
      assertRestoreReceipt(
        receipt,
        input.parentChangeId,
        repositoryRoot,
        bundle,
      );
      verifyRestoredBundle(repositoryRoot, sessionPath, bundle);
      return receipt;
    }
    const alreadyRestored = restoredBundleMatches(
      repositoryRoot,
      sessionPath,
      bundle,
    );
    if (
      !alreadyRestored &&
      gitBuffer(repositoryRoot, [
        'status',
        '--porcelain=v1',
        '-z',
        '--untracked-files=all',
      ]).length !== 0
    ) {
      throw workflowError(
        'BOOTSTRAP_RESTORE_WORKTREE_NOT_CLEAN',
        'WIP restore requires the exact clean checkpoint base.',
        ExitCode.conflict,
      );
    }
    if (!alreadyRestored) {
      const priorSession = readOptionalPlainFile(
        sessionPath,
        MAX_SESSION_BYTES,
      );
      let restoreFailure: unknown;
      try {
        applyGitPatch(
          repositoryRoot,
          decodeCanonicalBase64(bundle.tracked.workingTreePatchBase64),
          false,
        );
        applyGitPatch(
          repositoryRoot,
          decodeCanonicalBase64(bundle.tracked.stagedPatchBase64),
          true,
        );
        restoreUntrackedFiles(repositoryRoot, bundle.untracked);
        writePrivateFileAtomic(
          sessionPath,
          decodeCanonicalBase64(bundle.session.contentBase64),
        );
        verifyRestoredBundle(repositoryRoot, sessionPath, bundle);
      } catch (error) {
        restoreFailure = error;
      }
      if (restoreFailure !== undefined) {
        rollbackFailedRestore(
          repositoryRoot,
          bundle,
          sessionPath,
          priorSession,
        );
        throw restoreFailure;
      }
    }
    const receiptPayload = {
      kind: 'harness-wip-restore-receipt.v1' as const,
      checkpointId: bundle.checkpointId,
      bundleDigest: bundle.bundleDigest,
      parentChangeId: input.parentChangeId,
      repositoryRoot,
      restoredAt: now.toISOString(),
      effectsPerformed: !alreadyRestored,
    };
    const receipt: WipRestoreReceipt = {
      ...receiptPayload,
      receiptDigest: canonicalDigest(receiptPayload),
    };
    persistBootstrapReceipt(
      storageRoot,
      `restore-${bundle.checkpointId}`,
      receipt,
    );
    return receipt;
  }

  function assertCheckpointMatchesBundle(
    intervention: PersistedInterventionRecord,
    bundle: PersistedWipBundle,
  ): void {
    const boundServices: InterventionBootstrapWorkspaceBindings = bindings();
    const { canonicalDigest, rawDigest, workflowError, ExitCode } =
      boundServices;

    const checkpoint = intervention.checkpoint;
    if (
      bundle.checkpointId !== checkpoint.checkpointId ||
      bundle.parentChangeId !== checkpoint.parentChangeId ||
      bundle.baseOid !== checkpoint.baseOid ||
      canonicalDigest(bundle.tracked) !== checkpoint.trackedTreeDigest ||
      canonicalDigest(bundle.untracked) !== checkpoint.untrackedBundleDigest ||
      bundle.session.contentDigest !== checkpoint.sessionStateDigest ||
      rawDigest(Buffer.from(bundle.pendingIntent)) !==
        checkpoint.pendingIntentDigest
    ) {
      throw workflowError(
        'BOOTSTRAP_WIP_BUNDLE_CHECKPOINT_MISMATCH',
        'WIP bundle bytes do not match the persisted checkpoint.',
        ExitCode.verification,
      );
    }
  }

  function verifyRestoredBundle(
    repositoryRoot: string,
    sessionPath: string,
    bundle: PersistedWipBundle,
  ): void {
    const boundServices: InterventionBootstrapWorkspaceBindings = bindings();
    const {
      gitBuffer,
      rawDigest,
      fs,
      workflowError,
      ExitCode,
      safeRepositoryPath,
    } = boundServices;

    const working = gitBuffer(repositoryRoot, [
      'diff',
      '--binary',
      '--full-index',
      'HEAD',
      '--',
    ]);
    const staged = gitBuffer(repositoryRoot, [
      'diff',
      '--binary',
      '--full-index',
      '--cached',
      'HEAD',
      '--',
    ]);
    const status = gitBuffer(repositoryRoot, [
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
    ]);
    if (
      rawDigest(working) !== bundle.tracked.workingTreePatchDigest ||
      rawDigest(staged) !== bundle.tracked.stagedPatchDigest ||
      status.toString('base64') !== bundle.statusPorcelainBase64 ||
      rawDigest(fs.readFileSync(sessionPath)) !== bundle.session.contentDigest
    ) {
      throw workflowError(
        'BOOTSTRAP_RESTORE_VERIFICATION_FAILED',
        'Restored WIP does not reproduce the captured bytes.',
        ExitCode.verification,
      );
    }
    for (const entry of bundle.untracked) {
      const target = safeRepositoryPath(repositoryRoot, entry.path);
      if (rawDigest(fs.readFileSync(target)) !== entry.contentDigest) {
        throw workflowError(
          'BOOTSTRAP_RESTORE_VERIFICATION_FAILED',
          'Restored untracked file digest mismatch.',
          ExitCode.verification,
        );
      }
    }
  }

  function restoredBundleMatches(
    repositoryRoot: string,
    sessionPath: string,
    bundle: PersistedWipBundle,
  ): boolean {
    try {
      verifyRestoredBundle(repositoryRoot, sessionPath, bundle);
      return true;
    } catch {
      return false;
    }
  }

  function assertRestoreReceipt(
    receipt: WipRestoreReceipt,
    parentChangeId: string,
    repositoryRoot: string,
    bundle: PersistedWipBundle,
  ): void {
    const boundServices: InterventionBootstrapWorkspaceBindings = bindings();
    const { workflowError, ExitCode, exactIso } = boundServices;

    if (
      receipt.kind !== 'harness-wip-restore-receipt.v1' ||
      receipt.checkpointId !== bundle.checkpointId ||
      receipt.bundleDigest !== bundle.bundleDigest ||
      receipt.parentChangeId !== parentChangeId ||
      receipt.repositoryRoot !== repositoryRoot ||
      typeof receipt.effectsPerformed !== 'boolean'
    ) {
      throw workflowError(
        'BOOTSTRAP_RECEIPT_CORRUPT',
        'WIP restore receipt does not match the persisted checkpoint.',
        ExitCode.verification,
      );
    }
    exactIso(receipt.restoredAt, 'BOOTSTRAP_RECEIPT_CORRUPT');
  }

  function rollbackFailedRestore(
    repositoryRoot: string,
    bundle: PersistedWipBundle,
    sessionPath: string,
    priorSession: Buffer | null,
  ): void {
    const boundServices: InterventionBootstrapWorkspaceBindings = bindings();
    const { gitBufferNoThrow, fs, isNodeError, writePrivateFileAtomic } =
      boundServices;

    gitBufferNoThrow(repositoryRoot, ['reset', '--hard', bundle.baseOid]);
    for (const trackedPath of bundle.tracked.paths) {
      if (!pathExistsAtBase(repositoryRoot, bundle.baseOid, trackedPath)) {
        removeRestoredUntracked(repositoryRoot, trackedPath);
      }
    }
    for (const entry of bundle.untracked) {
      removeRestoredUntracked(repositoryRoot, entry.path);
    }
    if (priorSession === null) {
      try {
        fs.unlinkSync(sessionPath);
      } catch (error) {
        if (!isNodeError(error) || error.code !== 'ENOENT') {
          throw error;
        }
      }
    } else {
      writePrivateFileAtomic(sessionPath, priorSession);
    }
  }

  function pathExistsAtBase(
    repositoryRoot: string,
    baseOid: string,
    relativePath: string,
  ): boolean {
    const boundServices: InterventionBootstrapWorkspaceBindings = bindings();
    const { assertSafeRelativePath, gitBuffer } = boundServices;

    assertSafeRelativePath(relativePath);
    return (
      gitBuffer(repositoryRoot, [
        'ls-tree',
        '--name-only',
        '-z',
        baseOid,
        '--',
        relativePath,
      ]).length > 0
    );
  }

  function applyGitPatch(
    repositoryRoot: string,
    patchBytes: Buffer,
    cached: boolean,
  ): void {
    const boundServices: InterventionBootstrapWorkspaceBindings = bindings();
    const { gitBuffer } = boundServices;

    if (patchBytes.length === 0) {
      return;
    }
    gitBuffer(
      repositoryRoot,
      [
        'apply',
        '--binary',
        '--whitespace=nowarn',
        ...(cached ? ['--cached'] : []),
        '-',
      ],
      patchBytes,
    );
  }

  function restoreUntrackedFiles(
    repositoryRoot: string,
    entries: PersistedUntrackedFile[],
  ): void {
    const boundServices: InterventionBootstrapWorkspaceBindings = bindings();
    const {
      safeRepositoryPath,
      ensureSafeParentDirectories,
      path,
      fs,
      workflowError,
      ExitCode,
      decodeCanonicalBase64,
    } = boundServices;

    for (const entry of entries) {
      const target = safeRepositoryPath(repositoryRoot, entry.path);
      ensureSafeParentDirectories(repositoryRoot, path.dirname(target));
      if (fs.lstatSync(target, { throwIfNoEntry: false })) {
        throw workflowError(
          'BOOTSTRAP_RESTORE_UNTRACKED_COLLISION',
          `Restore target already exists: ${entry.path}`,
          ExitCode.conflict,
        );
      }
      fs.writeFileSync(target, decodeCanonicalBase64(entry.contentBase64), {
        mode: entry.mode === '100755' ? 0o755 : 0o644,
        flag: 'wx',
      });
    }
  }

  function captureUntrackedFiles(
    repositoryRoot: string,
    allowlist: string[],
  ): PersistedUntrackedFile[] {
    const boundServices: InterventionBootstrapWorkspaceBindings = bindings();
    const {
      safeRepositoryPath,
      fs,
      workflowError,
      ExitCode,
      MAX_UNTRACKED_FILE_BYTES,
      MAX_UNTRACKED_TOTAL_BYTES,
      rawDigest,
    } = boundServices;

    let total = 0;
    return allowlist.map((relativePath) => {
      const target = safeRepositoryPath(repositoryRoot, relativePath);
      const stats = fs.lstatSync(target, { throwIfNoEntry: false });
      if (!stats?.isFile() || stats.isSymbolicLink()) {
        throw workflowError(
          'BOOTSTRAP_UNTRACKED_FILE_UNSAFE',
          `Allowlisted untracked path is not a regular file: ${relativePath}`,
          ExitCode.guard,
        );
      }
      if (stats.size > MAX_UNTRACKED_FILE_BYTES) {
        throw workflowError(
          'BOOTSTRAP_UNTRACKED_FILE_TOO_LARGE',
          `Allowlisted untracked file is too large: ${relativePath}`,
          ExitCode.guard,
        );
      }
      const content = fs.readFileSync(target);
      total += content.length;
      if (total > MAX_UNTRACKED_TOTAL_BYTES) {
        throw workflowError(
          'BOOTSTRAP_UNTRACKED_TOTAL_TOO_LARGE',
          'Allowlisted untracked bytes exceed the total limit.',
          ExitCode.guard,
        );
      }
      return {
        path: relativePath,
        mode: (stats.mode & 0o111) !== 0 ? '100755' : '100644',
        contentBase64: content.toString('base64'),
        contentDigest: rawDigest(content),
      };
    });
  }

  function validateUntrackedAllowlist(values: string[]): string[] {
    const boundServices: InterventionBootstrapWorkspaceBindings = bindings();
    const { workflowError, ExitCode, assertSafeRelativePath, canonicalJson } =
      boundServices;

    if (!Array.isArray(values)) {
      throw workflowError(
        'BOOTSTRAP_UNTRACKED_ALLOWLIST_INVALID',
        'Untracked allowlist must be an array.',
        ExitCode.usage,
      );
    }
    for (const value of values) {
      assertSafeRelativePath(value);
    }
    const normalized = [...new Set(values)].sort();
    if (canonicalJson(values) !== canonicalJson(normalized)) {
      throw workflowError(
        'BOOTSTRAP_UNTRACKED_ALLOWLIST_INVALID',
        'Untracked allowlist must be sorted and unique.',
        ExitCode.usage,
      );
    }
    return normalized;
  }

  function listUntracked(repositoryRoot: string): string[] {
    const boundServices: InterventionBootstrapWorkspaceBindings = bindings();
    const { gitBuffer } = boundServices;

    return parseNulPaths(
      gitBuffer(repositoryRoot, [
        'ls-files',
        '--others',
        '--exclude-standard',
        '-z',
      ]),
    );
  }

  function parseNulPaths(output: Buffer): string[] {
    const boundServices: InterventionBootstrapWorkspaceBindings = bindings();
    const { workflowError, ExitCode, assertSafeRelativePath } = boundServices;

    if (output.length === 0) {
      return [];
    }
    if (output.at(-1) !== 0) {
      throw workflowError(
        'BOOTSTRAP_GIT_PATH_OUTPUT_INVALID',
        'Git path output is not NUL terminated.',
        ExitCode.verification,
      );
    }
    const bytes = output.subarray(0, output.length - 1);
    const decoded = bytes.toString('utf8');
    if (!Buffer.from(decoded, 'utf8').equals(bytes)) {
      throw workflowError(
        'BOOTSTRAP_GIT_PATH_OUTPUT_INVALID',
        'Git path output is not valid UTF-8.',
        ExitCode.verification,
      );
    }
    const values = decoded.split('\0');
    for (const value of values) {
      assertSafeRelativePath(value);
    }
    return [...new Set(values)].sort();
  }

  function persistWipBundle(
    storageRoot: string,
    bundle: PersistedWipBundle,
  ): void {
    const boundServices: InterventionBootstrapWorkspaceBindings = bindings();
    const {
      bootstrapBundleDirectory,
      ensurePrivateDirectory,
      canonicalJson,
      MAX_BUNDLE_BYTES,
      workflowError,
      ExitCode,
      wipBundlePath,
      fs,
      readPrivateBytes,
      createPrivateFileExclusive,
    } = boundServices;

    const directory = bootstrapBundleDirectory(storageRoot);
    ensurePrivateDirectory(directory);
    const content = Buffer.from(`${canonicalJson(bundle)}\n`);
    if (content.length > MAX_BUNDLE_BYTES) {
      throw workflowError(
        'BOOTSTRAP_WIP_BUNDLE_TOO_LARGE',
        'WIP bundle exceeds the persistence size limit.',
        ExitCode.guard,
      );
    }
    const target = wipBundlePath(storageRoot, bundle.checkpointId);
    if (fs.existsSync(target)) {
      if (
        !readPrivateBytes(
          target,
          'BOOTSTRAP_WIP_BUNDLE_NOT_FOUND',
          MAX_BUNDLE_BYTES,
        ).equals(content)
      ) {
        throw workflowError(
          'BOOTSTRAP_WIP_BUNDLE_COLLISION',
          'Checkpoint bundle path contains different bytes.',
          ExitCode.verification,
        );
      }
      return;
    }
    createPrivateFileExclusive(target, content);
  }

  function removeRestoredUntracked(
    repositoryRoot: string,
    relativePath: string,
  ): void {
    const boundServices: InterventionBootstrapWorkspaceBindings = bindings();
    const { safeRepositoryPath, fs, isNodeError, path, isPathInside } =
      boundServices;

    const target = safeRepositoryPath(repositoryRoot, relativePath);
    try {
      fs.unlinkSync(target);
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'ENOENT') {
        throw error;
      }
    }
    let directory = path.dirname(target);
    while (
      directory !== repositoryRoot &&
      isPathInside(repositoryRoot, directory)
    ) {
      try {
        fs.rmdirSync(directory);
      } catch (error) {
        if (
          isNodeError(error) &&
          ['ENOENT', 'ENOTEMPTY'].includes(error.code ?? '')
        ) {
          break;
        }
        throw error;
      }
      directory = path.dirname(directory);
    }
  }
  return {
    discoverBootstrapUntrackedAllowlist,
    persistTrustedBootstrapSessionSnapshot,
    capturePersistedWipIntervention,
    readPersistedWipBundle,
    restorePersistedWipBundle,
    assertCheckpointMatchesBundle,
  };
}

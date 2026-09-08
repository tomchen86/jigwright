// intervention bootstrap child worktree; repository effects remain bound by the public module.
import type {
  InterventionBootstrapChildWorktreeBindings,
  InterventionBootstrapChildWorktreeBindingsTypes,
} from './intervention-control-bootstrap.ts';
type HarnessMaintenanceGrantEnvelope =
  InterventionBootstrapChildWorktreeBindingsTypes['HarnessMaintenanceGrantEnvelope'];
type BootstrapDependencies =
  InterventionBootstrapChildWorktreeBindingsTypes['BootstrapDependencies'];
type ChildWorktreeMaterializationReceipt =
  InterventionBootstrapChildWorktreeBindingsTypes['ChildWorktreeMaterializationReceipt'];
type PersistedInterventionRecord =
  InterventionBootstrapChildWorktreeBindingsTypes['PersistedInterventionRecord'];

export function createInterventionBootstrapChildWorktree(
  bindings: () => InterventionBootstrapChildWorktreeBindings,
) {
  function materializeInterventionChildWorktree(
    storageRoot: string,
    input: {
      parentChangeId: string;
      repositoryRoot: string;
      maintenanceGrantEnvelope: HarnessMaintenanceGrantEnvelope;
    },
    dependencies: BootstrapDependencies,
  ): ChildWorktreeMaterializationReceipt {
    const boundServices: InterventionBootstrapChildWorktreeBindings =
      bindings();
    const {
      requireHumanVerifier,
      bootstrapNow,
      readPersistedIntervention,
      verifyHarnessMaintenanceGrant,
      canonicalRepositoryRoot,
      workflowError,
      ExitCode,
      readPersistedWipBundle,
      bootstrapReceiptPath,
      fs,
      readBootstrapReceipt,
      recordBootstrapSidecarWorkspaceMaterialized,
      gitRefExists,
      gitBuffer,
      gitBufferNoThrow,
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
    const repositoryRoot = canonicalRepositoryRoot(input.repositoryRoot);
    const metadata = intervention.childWorkspace;
    if (repositoryRoot !== metadata.parentWorkspacePath) {
      throw workflowError(
        'BOOTSTRAP_CHILD_WORKTREE_PARENT_MISMATCH',
        'Child worktree request is not bound to the persisted parent workspace.',
        ExitCode.verification,
      );
    }
    readPersistedWipBundle(storageRoot, metadata.checkpointId);
    const receiptPath = bootstrapReceiptPath(
      storageRoot,
      `worktree-${metadata.workspaceId}`,
    );
    if (fs.existsSync(receiptPath)) {
      const receipt =
        readBootstrapReceipt<ChildWorktreeMaterializationReceipt>(receiptPath);
      assertMaterializationReceipt(receipt, repositoryRoot, metadata);
      verifyMaterializedWorktree(repositoryRoot, metadata);
      recordBootstrapSidecarWorkspaceMaterialized(storageRoot, {
        parentChangeId: input.parentChangeId,
        workspaceId: receipt.workspaceId,
        receiptDigest: receipt.receiptDigest,
        materializedAt: receipt.materializedAt,
      });
      return receipt;
    }
    if (fs.lstatSync(metadata.childWorkspacePath, { throwIfNoEntry: false })) {
      throw workflowError(
        'BOOTSTRAP_CHILD_WORKTREE_PATH_OCCUPIED',
        'Child worktree path became occupied after reservation.',
        ExitCode.conflict,
      );
    }
    if (gitRefExists(repositoryRoot, metadata.changeRef)) {
      throw workflowError(
        'BOOTSTRAP_CHILD_WORKTREE_REF_EXISTS',
        'Reserved child change ref already exists.',
        ExitCode.conflict,
      );
    }
    const branch = metadata.changeRef.slice('refs/heads/'.length);
    let failure: unknown;
    try {
      gitBuffer(repositoryRoot, [
        'worktree',
        'add',
        '-b',
        branch,
        metadata.childWorkspacePath,
        metadata.baseOid,
      ]);
      verifyMaterializedWorktree(repositoryRoot, metadata);
    } catch (error) {
      failure = error;
    }
    if (failure !== undefined) {
      gitBufferNoThrow(repositoryRoot, [
        'worktree',
        'remove',
        '--force',
        metadata.childWorkspacePath,
      ]);
      removeExactChildWorkspace(metadata.childWorkspacePath, repositoryRoot);
      throw failure;
    }
    const receiptPayload = {
      kind: 'intervention-child-worktree-materialized.v1' as const,
      workspaceId: metadata.workspaceId,
      checkpointId: metadata.checkpointId,
      parentChangeId: metadata.parentChangeId,
      interventionChangeId: metadata.interventionChangeId,
      repositoryRoot,
      childWorkspacePath: metadata.childWorkspacePath,
      changeRef: metadata.changeRef,
      headOid: metadata.baseOid,
      materializedAt: now.toISOString(),
      effectsPerformed: true as const,
    };
    const receipt: ChildWorktreeMaterializationReceipt = {
      ...receiptPayload,
      receiptDigest: canonicalDigest(receiptPayload),
    };
    persistBootstrapReceipt(
      storageRoot,
      `worktree-${metadata.workspaceId}`,
      receipt,
    );
    dependencies.testHooks?.afterWorktreeReceiptPersistedBeforeSidecar?.();
    recordBootstrapSidecarWorkspaceMaterialized(storageRoot, {
      parentChangeId: input.parentChangeId,
      workspaceId: receipt.workspaceId,
      receiptDigest: receipt.receiptDigest,
      materializedAt: receipt.materializedAt,
    });
    return receipt;
  }

  function verifyMaterializedWorktree(
    repositoryRoot: string,
    metadata: PersistedInterventionRecord['childWorkspace'],
  ): void {
    const boundServices: InterventionBootstrapChildWorktreeBindings =
      bindings();
    const {
      canonicalRepositoryRoot,
      workflowError,
      ExitCode,
      fs,
      gitText,
      path,
    } = boundServices;

    const childRoot = canonicalRepositoryRoot(metadata.childWorkspacePath);
    if (childRoot !== metadata.childWorkspacePath) {
      throw workflowError(
        'BOOTSTRAP_CHILD_WORKTREE_VERIFICATION_FAILED',
        'Materialized child root differs from the reservation.',
        ExitCode.verification,
      );
    }
    const commonParent = fs.realpathSync(
      gitText(repositoryRoot, ['rev-parse', '--git-common-dir'])
        .trim()
        .startsWith('/')
        ? gitText(repositoryRoot, ['rev-parse', '--git-common-dir']).trim()
        : path.join(
            repositoryRoot,
            gitText(repositoryRoot, ['rev-parse', '--git-common-dir']).trim(),
          ),
    );
    const childCommonRaw = gitText(childRoot, [
      'rev-parse',
      '--git-common-dir',
    ]).trim();
    const childCommon = fs.realpathSync(
      path.isAbsolute(childCommonRaw)
        ? childCommonRaw
        : path.join(childRoot, childCommonRaw),
    );
    if (
      childCommon !== commonParent ||
      gitText(childRoot, ['rev-parse', 'HEAD']).trim() !== metadata.baseOid ||
      gitText(childRoot, ['symbolic-ref', 'HEAD']).trim() !== metadata.changeRef
    ) {
      throw workflowError(
        'BOOTSTRAP_CHILD_WORKTREE_VERIFICATION_FAILED',
        'Materialized child worktree failed repository/ref/base verification.',
        ExitCode.verification,
      );
    }
  }

  function assertMaterializationReceipt(
    receipt: ChildWorktreeMaterializationReceipt,
    repositoryRoot: string,
    metadata: PersistedInterventionRecord['childWorkspace'],
  ): void {
    const boundServices: InterventionBootstrapChildWorktreeBindings =
      bindings();
    const { workflowError, ExitCode } = boundServices;

    if (
      receipt.kind !== 'intervention-child-worktree-materialized.v1' ||
      receipt.workspaceId !== metadata.workspaceId ||
      receipt.checkpointId !== metadata.checkpointId ||
      receipt.parentChangeId !== metadata.parentChangeId ||
      receipt.interventionChangeId !== metadata.interventionChangeId ||
      receipt.repositoryRoot !== repositoryRoot ||
      receipt.childWorkspacePath !== metadata.childWorkspacePath ||
      receipt.changeRef !== metadata.changeRef ||
      receipt.headOid !== metadata.baseOid ||
      receipt.effectsPerformed !== true
    ) {
      throw workflowError(
        'BOOTSTRAP_RECEIPT_CORRUPT',
        'Child worktree receipt does not match its reservation.',
        ExitCode.verification,
      );
    }
  }

  function removeExactChildWorkspace(
    childPath: string,
    parentRoot: string,
  ): void {
    const boundServices: InterventionBootstrapChildWorktreeBindings =
      bindings();
    const { path, isPathInside, workflowError, ExitCode, fs } = boundServices;

    if (
      !path.isAbsolute(childPath) ||
      childPath === parentRoot ||
      isPathInside(parentRoot, childPath) ||
      isPathInside(childPath, parentRoot)
    ) {
      throw workflowError(
        'BOOTSTRAP_CHILD_WORKTREE_CLEANUP_UNSAFE',
        'Refusing to clean an unvalidated child workspace path.',
        ExitCode.unsafeEnvironment,
      );
    }
    fs.rmSync(childPath, { recursive: true, force: true });
  }
  return { materializeInterventionChildWorktree };
}

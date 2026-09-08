// intervention bootstrap engine; repository effects remain bound by the public module.
import type {
  InterventionBootstrapEngineBindings,
  InterventionBootstrapEngineBindingsTypes,
} from './intervention-control-bootstrap.ts';
type Sha256Digest = InterventionBootstrapEngineBindingsTypes['Sha256Digest'];
type LocalEngineBinding =
  InterventionBootstrapEngineBindingsTypes['LocalEngineBinding'];
type EngineArtifact =
  InterventionBootstrapEngineBindingsTypes['EngineArtifact'];
type PersistedInterventionRecord =
  InterventionBootstrapEngineBindingsTypes['PersistedInterventionRecord'];

export function createInterventionBootstrapEngine(
  bindings: () => InterventionBootstrapEngineBindings,
) {
  function initializeLocalEngineBinding(
    storageRoot: string,
    bindingPath: string,
    input: {
      parentChangeId: string;
      parentWorkspacePath: string;
      parentBranch: string;
      interventionChangeId: string;
      txId: string;
      checkpointId: Sha256Digest;
      engineDigest: Sha256Digest;
      artifactId: Sha256Digest;
      executableDigest: Sha256Digest;
      executablePath: string;
      sessionSchema: string;
      now: Date;
    },
  ): LocalEngineBinding {
    const boundServices: InterventionBootstrapEngineBindings = bindings();
    const {
      canonicalRepositoryRoot,
      gitText,
      localEngineArtifactPath,
      workflowError,
      ExitCode,
      exactDate,
      canonicalDigest,
      createPrivateFileExclusive,
      assertPersistenceOwnedPath,
      canonicalJson,
    } = boundServices;
    const assertNonEmpty: InterventionBootstrapEngineBindings['assertNonEmpty'] =
      boundServices.assertNonEmpty;
    const assertDigest: InterventionBootstrapEngineBindings['assertDigest'] =
      boundServices.assertDigest;

    assertNonEmpty(input.parentChangeId, 'BOOTSTRAP_BINDING_INVALID');
    assertNonEmpty(input.interventionChangeId, 'BOOTSTRAP_BINDING_INVALID');
    assertNonEmpty(input.txId, 'BOOTSTRAP_BINDING_INVALID');
    assertNonEmpty(input.sessionSchema, 'BOOTSTRAP_BINDING_INVALID');
    assertDigest(input.checkpointId, 'BOOTSTRAP_BINDING_INVALID');
    assertDigest(input.engineDigest, 'BOOTSTRAP_BINDING_INVALID');
    assertDigest(input.artifactId, 'BOOTSTRAP_BINDING_INVALID');
    assertDigest(input.executableDigest, 'BOOTSTRAP_BINDING_INVALID');
    const parentWorkspacePath = canonicalRepositoryRoot(
      input.parentWorkspacePath,
    );
    const expectedParentBranch = `refs/heads/work/${input.parentChangeId}`;
    if (
      input.parentBranch !== expectedParentBranch ||
      gitText(parentWorkspacePath, ['symbolic-ref', 'HEAD']).trim() !==
        expectedParentBranch ||
      input.executablePath !==
        localEngineArtifactPath(storageRoot, input.artifactId)
    ) {
      throw workflowError(
        'BOOTSTRAP_BINDING_PARENT_SCOPE_INVALID',
        'Local binding requires the exact parent worktree branch and artifact path.',
        ExitCode.verification,
      );
    }
    const now = exactDate(input.now, 'BOOTSTRAP_CLOCK_INVALID');
    const payload = {
      kind: 'local-parent-session-metadata.v2' as const,
      parentChangeId: input.parentChangeId,
      parentWorkspacePath,
      parentBranch: input.parentBranch,
      interventionChangeId: input.interventionChangeId,
      txId: input.txId,
      checkpointId: input.checkpointId,
      engineDigest: input.engineDigest,
      activeArtifact: {
        artifactId: input.artifactId,
        executableDigest: input.executableDigest,
        executablePath: input.executablePath,
      },
      sessionSchema: input.sessionSchema,
      blocker: {
        kind: 'harness-intervention' as const,
        checkpointId: input.checkpointId,
        blockedBy: input.interventionChangeId,
      },
      interventionState: 'active' as const,
      generation: 1,
      updatedAt: now.toISOString(),
    };
    const binding: LocalEngineBinding = {
      ...payload,
      recordDigest: canonicalDigest(payload),
    };
    createPrivateFileExclusive(
      assertPersistenceOwnedPath(
        storageRoot,
        bindingPath,
        'BOOTSTRAP_BINDING_OUTSIDE_STATE',
      ),
      Buffer.from(`${canonicalJson(binding)}\n`),
    );
    return binding;
  }

  function readLocalEngineBinding(bindingPath: string): LocalEngineBinding {
    const boundServices: InterventionBootstrapEngineBindings = bindings();
    const {
      readCanonicalPrivateJson,
      canonicalAbsolutePath,
      isRecord,
      hasExactKeys,
      corruptBinding,
      isDigest,
      canonicalDigest,
      localEngineArtifactPath,
      bindingStateRoot,
      exactIso,
    } = boundServices;

    const value = readCanonicalPrivateJson(
      canonicalAbsolutePath(bindingPath),
      'BOOTSTRAP_BINDING_NOT_FOUND',
      64 * 1024,
    );
    if (
      !isRecord(value) ||
      value.kind !== 'local-parent-session-metadata.v2' ||
      !hasExactKeys(value, [
        'activeArtifact',
        'blocker',
        'checkpointId',
        'engineDigest',
        'generation',
        'interventionChangeId',
        'interventionState',
        'kind',
        'parentBranch',
        'parentChangeId',
        'parentWorkspacePath',
        'recordDigest',
        'sessionSchema',
        'txId',
        'updatedAt',
      ])
    ) {
      throw corruptBinding();
    }
    const binding = value as unknown as LocalEngineBinding;
    const { recordDigest, ...payload } = binding;
    if (
      !isDigest(recordDigest) ||
      canonicalDigest(payload) !== recordDigest ||
      !Number.isSafeInteger(binding.generation) ||
      binding.generation < 1 ||
      !isDigest(binding.engineDigest) ||
      !isDigest(binding.checkpointId) ||
      !isRecord(binding.activeArtifact) ||
      !hasExactKeys(binding.activeArtifact, [
        'artifactId',
        'executableDigest',
        'executablePath',
      ]) ||
      !isDigest(binding.activeArtifact.artifactId) ||
      !isDigest(binding.activeArtifact.executableDigest) ||
      binding.activeArtifact.executablePath !==
        localEngineArtifactPath(
          bindingStateRoot(bindingPath),
          binding.activeArtifact.artifactId,
        ) ||
      typeof binding.txId !== 'string' ||
      binding.txId.length === 0 ||
      binding.txId.trim() !== binding.txId ||
      typeof binding.parentChangeId !== 'string' ||
      binding.parentChangeId.length === 0 ||
      binding.parentChangeId.trim() !== binding.parentChangeId ||
      binding.parentBranch !== `refs/heads/work/${binding.parentChangeId}` ||
      canonicalAbsolutePath(binding.parentWorkspacePath) !==
        binding.parentWorkspacePath ||
      !['active', 'adopted'].includes(binding.interventionState) ||
      (binding.interventionState === 'active'
        ? !isHarnessInterventionBlocker(
            binding.blocker,
            binding.checkpointId,
            binding.interventionChangeId,
          )
        : binding.blocker !== null)
    ) {
      throw corruptBinding();
    }
    exactIso(binding.updatedAt, 'BOOTSTRAP_BINDING_CORRUPT');
    return binding;
  }

  function rebindLocalEngineAfterRolledBackAdoption(
    storageRoot: string,
    bindingPath: string,
    input: {
      parentChangeId: string;
      interventionChangeId: string;
      txId: string;
      checkpointId: Sha256Digest;
      engineDigest: Sha256Digest;
      artifactId: Sha256Digest;
      executableDigest: Sha256Digest;
      sessionSchema: string;
      now: Date;
    },
  ): LocalEngineBinding {
    const boundServices: InterventionBootstrapEngineBindings = bindings();
    const {
      workflowError,
      ExitCode,
      exactDate,
      localEngineArtifactPath,
      canonicalDigest,
      replacePrivateFileAtomic,
      assertPersistenceOwnedPath,
      canonicalJson,
    } = boundServices;

    const current = readLocalEngineBinding(bindingPath);
    if (
      current.parentChangeId !== input.parentChangeId ||
      current.interventionChangeId !== input.interventionChangeId ||
      current.checkpointId !== input.checkpointId ||
      current.engineDigest !== input.engineDigest ||
      current.sessionSchema !== input.sessionSchema ||
      current.interventionState !== 'active' ||
      !isHarnessInterventionBlocker(
        current.blocker,
        input.checkpointId,
        input.interventionChangeId,
      )
    ) {
      throw workflowError(
        'BOOTSTRAP_PARENT_SESSION_RETRY_MISMATCH',
        'A rolled-back parent session cannot be rebound to this repair attempt.',
        ExitCode.staleState,
      );
    }
    const now = exactDate(input.now, 'BOOTSTRAP_CLOCK_INVALID');
    const executablePath = localEngineArtifactPath(
      storageRoot,
      input.artifactId,
    );
    const { recordDigest: _recordDigest, ...payload } = current;
    const nextPayload = {
      ...payload,
      txId: input.txId,
      activeArtifact: {
        artifactId: input.artifactId,
        executableDigest: input.executableDigest,
        executablePath,
      },
      generation: current.generation + 1,
      updatedAt: now.toISOString(),
    };
    const next: LocalEngineBinding = {
      ...nextPayload,
      recordDigest: canonicalDigest(nextPayload),
    };
    replacePrivateFileAtomic(
      assertPersistenceOwnedPath(
        storageRoot,
        bindingPath,
        'BOOTSTRAP_BINDING_OUTSIDE_STATE',
      ),
      Buffer.from(`${canonicalJson(next)}\n`),
      current.recordDigest,
    );
    return next;
  }

  function assertEngineArtifactIntegrity(artifact: EngineArtifact): void {
    const boundServices: InterventionBootstrapEngineBindings = bindings();
    const {
      isRecord,
      hasExactKeys,
      workflowError,
      ExitCode,
      isDigest,
      canonicalDigest,
    } = boundServices;

    const artifactKeys = [
      'artifactId',
      'canReadSessionSchemas',
      'executableDigest',
      'kind',
      'policySchemaVersion',
      'protocolVersion',
      'smokeReportDigest',
      'sourceChangeId',
      'sourceDigest',
      'writesSessionSchema',
    ];
    if (
      !isRecord(artifact) ||
      !hasExactKeys(
        artifact,
        'workflowBindingDigest' in artifact
          ? [...artifactKeys, 'workflowBindingDigest']
          : artifactKeys,
      ) ||
      artifact.kind !== 'engine-artifact.v1'
    ) {
      throw workflowError(
        'BOOTSTRAP_ENGINE_ARTIFACT_CORRUPT',
        'Engine artifact failed structural verification.',
        ExitCode.verification,
      );
    }
    const { artifactId, ...payload } = artifact;
    if (!isDigest(artifactId) || canonicalDigest(payload) !== artifactId) {
      throw workflowError(
        'BOOTSTRAP_ENGINE_ARTIFACT_CORRUPT',
        'Engine artifact failed content-addressed verification.',
        ExitCode.verification,
      );
    }
  }

  function materializeLocalEngineExecutable(
    storageRoot: string,
    intervention: PersistedInterventionRecord,
    artifact: EngineArtifact,
    requestedExecutablePath: string,
  ): string {
    const boundServices: InterventionBootstrapEngineBindings = bindings();
    const {
      localEngineArtifactPath,
      fs,
      assertPrivateLocalEngineExecutable,
      canonicalPlainFile,
      MAX_UNTRACKED_FILE_BYTES,
      isPathInside,
      workflowError,
      ExitCode,
      rawDigest,
      createPrivateExecutableExclusive,
    } = boundServices;

    const target = localEngineArtifactPath(storageRoot, artifact.artifactId);
    if (fs.lstatSync(target, { throwIfNoEntry: false }) !== undefined) {
      assertPrivateLocalEngineExecutable(target, artifact.executableDigest);
      return target;
    }
    const executablePath = canonicalPlainFile(
      requestedExecutablePath,
      MAX_UNTRACKED_FILE_BYTES,
      'BOOTSTRAP_ENGINE_EXECUTABLE_UNSAFE',
    );
    const childRoot = intervention.childWorkspace.childWorkspacePath;
    if (!isPathInside(childRoot, executablePath)) {
      throw workflowError(
        'BOOTSTRAP_ENGINE_EXECUTABLE_OUTSIDE_CHILD',
        'Engine executable must come from the intervention child workspace.',
        ExitCode.guard,
      );
    }
    const sourceStats = fs.lstatSync(executablePath);
    if (sourceStats.nlink !== 1) {
      throw workflowError(
        'BOOTSTRAP_ENGINE_EXECUTABLE_UNSAFE',
        'Engine executable source must have exactly one link.',
        ExitCode.unsafeEnvironment,
      );
    }
    const sourceDescriptor = fs.openSync(
      executablePath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    let executableBytes: Buffer;
    try {
      const opened = fs.fstatSync(sourceDescriptor);
      executableBytes = fs.readFileSync(sourceDescriptor);
      if (
        opened.dev !== sourceStats.dev ||
        opened.ino !== sourceStats.ino ||
        opened.size !== sourceStats.size
      ) {
        throw workflowError(
          'BOOTSTRAP_ENGINE_EXECUTABLE_UNSAFE',
          'Engine executable source changed while being opened.',
          ExitCode.unsafeEnvironment,
        );
      }
    } finally {
      fs.closeSync(sourceDescriptor);
    }
    if (rawDigest(executableBytes) !== artifact.executableDigest) {
      throw workflowError(
        'BOOTSTRAP_ENGINE_EXECUTABLE_DIGEST_MISMATCH',
        'Engine executable bytes differ from the adopted artifact.',
        ExitCode.verification,
      );
    }
    createPrivateExecutableExclusive(target, executableBytes);
    assertPrivateLocalEngineExecutable(target, artifact.executableDigest);
    return target;
  }

  function runEngineExecutable(
    executablePath: string,
    expectedDigest: Sha256Digest,
    mode: '--bootstrap-probe' | '--health-check',
  ): Record<string, unknown> {
    const boundServices: InterventionBootstrapEngineBindings = bindings();
    const {
      assertPrivateLocalEngineExecutable,
      path,
      spawnSync,
      ENGINE_COMMAND_TIMEOUT_MS,
      workflowError,
      ExitCode,
      isRecord,
    } = boundServices;

    assertPrivateLocalEngineExecutable(executablePath, expectedDigest);
    const executableDirectory = path.dirname(executablePath);
    const result = spawnSync(executablePath, [mode], {
      cwd: executableDirectory,
      encoding: 'utf8',
      timeout: ENGINE_COMMAND_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      env: {
        PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
        LANG: 'C',
        LC_ALL: 'C',
        TMPDIR: executableDirectory,
      },
    });
    if (
      result.error ||
      result.status !== 0 ||
      typeof result.stdout !== 'string'
    ) {
      throw workflowError(
        'BOOTSTRAP_ENGINE_COMMAND_FAILED',
        `Engine ${mode} command failed.`,
        ExitCode.verification,
      );
    }
    let value: unknown;
    try {
      value = JSON.parse(result.stdout);
    } catch {
      throw workflowError(
        'BOOTSTRAP_ENGINE_COMMAND_OUTPUT_INVALID',
        `Engine ${mode} command did not emit JSON.`,
        ExitCode.verification,
      );
    }
    if (!isRecord(value)) {
      throw workflowError(
        'BOOTSTRAP_ENGINE_COMMAND_OUTPUT_INVALID',
        `Engine ${mode} command output must be an object.`,
        ExitCode.verification,
      );
    }
    return value;
  }

  function ensureBindingEngine(
    bindingPath: string,
    current: LocalEngineBinding,
    expectedFrom: Sha256Digest,
    target: Sha256Digest,
    at: string,
  ): LocalEngineBinding {
    const boundServices: InterventionBootstrapEngineBindings = bindings();
    const {
      workflowError,
      ExitCode,
      canonicalDigest,
      replacePrivateFileAtomic,
      canonicalJson,
    } = boundServices;

    if (current.engineDigest === target) {
      return current;
    }
    if (current.engineDigest !== expectedFrom) {
      throw workflowError(
        'BOOTSTRAP_BINDING_ENGINE_MISMATCH',
        'Local engine binding is neither the expected source nor target.',
        ExitCode.staleState,
      );
    }
    const { recordDigest: _recordDigest, ...currentPayload } = current;
    const payload = {
      ...currentPayload,
      engineDigest: target,
      generation: current.generation + 1,
      updatedAt: at,
    };
    const next: LocalEngineBinding = {
      ...payload,
      recordDigest: canonicalDigest(payload),
    };
    replacePrivateFileAtomic(
      bindingPath,
      Buffer.from(`${canonicalJson(next)}\n`),
      current.recordDigest,
    );
    return next;
  }

  function ensureBindingAdoptionFinalized(
    bindingPath: string,
    current: LocalEngineBinding,
    checkpointId: Sha256Digest,
    interventionChangeId: string,
    at: string,
  ): LocalEngineBinding {
    const boundServices: InterventionBootstrapEngineBindings = bindings();
    const {
      workflowError,
      ExitCode,
      canonicalDigest,
      replacePrivateFileAtomic,
      canonicalJson,
    } = boundServices;

    if (current.interventionState === 'adopted' && current.blocker === null) {
      return current;
    }
    if (
      current.interventionState !== 'active' ||
      !isHarnessInterventionBlocker(
        current.blocker,
        checkpointId,
        interventionChangeId,
      )
    ) {
      throw workflowError(
        'BOOTSTRAP_PARENT_SESSION_CAS_MISMATCH',
        'Parent session blocker changed before adoption finalization.',
        ExitCode.staleState,
      );
    }
    const { recordDigest: _recordDigest, ...currentPayload } = current;
    const payload = {
      ...currentPayload,
      blocker: null,
      interventionState: 'adopted' as const,
      generation: current.generation + 1,
      updatedAt: at,
    };
    const next: LocalEngineBinding = {
      ...payload,
      recordDigest: canonicalDigest(payload),
    };
    replacePrivateFileAtomic(
      bindingPath,
      Buffer.from(`${canonicalJson(next)}\n`),
      current.recordDigest,
    );
    return next;
  }

  function assertBindingEngine(
    binding: LocalEngineBinding,
    expected: Sha256Digest,
  ): void {
    const boundServices: InterventionBootstrapEngineBindings = bindings();
    const { workflowError, ExitCode } = boundServices;

    if (binding.engineDigest !== expected) {
      throw workflowError(
        'BOOTSTRAP_BINDING_ENGINE_MISMATCH',
        'Local engine binding does not select the journal engine.',
        ExitCode.staleState,
      );
    }
  }

  function isHarnessInterventionBlocker(
    value: unknown,
    checkpointId: Sha256Digest,
    interventionChangeId: string,
  ): boolean {
    const boundServices: InterventionBootstrapEngineBindings = bindings();
    const { isRecord, hasExactKeys } = boundServices;

    return (
      isRecord(value) &&
      hasExactKeys(value, ['blockedBy', 'checkpointId', 'kind']) &&
      value.kind === 'harness-intervention' &&
      value.checkpointId === checkpointId &&
      value.blockedBy === interventionChangeId
    );
  }
  return {
    initializeLocalEngineBinding,
    readLocalEngineBinding,
    rebindLocalEngineAfterRolledBackAdoption,
    assertEngineArtifactIntegrity,
    materializeLocalEngineExecutable,
    runEngineExecutable,
    ensureBindingEngine,
    ensureBindingAdoptionFinalized,
    assertBindingEngine,
    isHarnessInterventionBlocker,
  };
}

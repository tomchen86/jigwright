/**
 * Builds and validates engine artifacts for an active intervention.
 *
 * Invariants:
 * - Source content must remain unchanged during bootstrap and health
 *   probes.
 */
import type fs from 'node:fs';
// intervention artifact production; repository effects remain bound by the public module.
import type {
  InterventionArtifactProductionBindings,
  InterventionArtifactProductionBindingsTypes,
} from './intervention-maintenance.ts';
type PersistedInterventionEngineArtifact =
  InterventionArtifactProductionBindingsTypes['PersistedInterventionEngineArtifact'];
type EngineArtifact =
  InterventionArtifactProductionBindingsTypes['EngineArtifact'];
type Sha256Digest = InterventionArtifactProductionBindingsTypes['Sha256Digest'];
type HarnessMaintenanceGrantEnvelope =
  InterventionArtifactProductionBindingsTypes['HarnessMaintenanceGrantEnvelope'];
declare const preparePersistedEngineAdoption: InterventionArtifactProductionBindings['preparePersistedEngineAdoption'];

export function createInterventionArtifactProduction(
  bindings: () => InterventionArtifactProductionBindings,
) {
  function buildAndPersistInterventionEngineArtifact(
    storageRoot: string,
    input: {
      parentChangeId: string;
      executablePath: string;
      protocolVersion: number;
      policySchemaVersion: number;
      now: Date;
    },
  ): PersistedInterventionEngineArtifact {
    const boundServices: InterventionArtifactProductionBindings = bindings();
    const {
      readPersistedIntervention,
      readPersistedBootstrapSidecarWorkflow,
      workflowError,
      ExitCode,
      discoverRepository,
      digest,
      canonicalJson,
      createEngineArtifact,
    } = boundServices;

    const intervention = readPersistedIntervention(
      storageRoot,
      input.parentChangeId,
    );
    const sidecarWorkflow = readPersistedBootstrapSidecarWorkflow(
      storageRoot,
      input.parentChangeId,
    );
    if (sidecarWorkflow.workflowBinding.status !== 'repair-active') {
      throw workflowError(
        'INTERVENTION_ENGINE_BUILD_WORKFLOW_NOT_ACTIVE',
        'Engine artifacts can only be built by the active bootstrap-maintenance Workflow.',
        ExitCode.conflict,
      );
    }
    if (
      !Number.isSafeInteger(input.protocolVersion) ||
      input.protocolVersion < 1 ||
      !Number.isSafeInteger(input.policySchemaVersion) ||
      input.policySchemaVersion < 1
    ) {
      throw workflowError(
        'INTERVENTION_ENGINE_BUILD_VERSION_INVALID',
        'Engine artifact protocol and policy schema versions must be positive integers.',
        ExitCode.usage,
      );
    }
    const childWorkspacePath = intervention.childWorkspace.childWorkspacePath;
    const childRepository = discoverRepository(childWorkspacePath);
    if (
      childRepository.repositoryRealPath !== childWorkspacePath ||
      childRepository.branch !==
        `work/${intervention.relationship.interventionChangeId}` ||
      childRepository.head !== intervention.checkpoint.baseOid
    ) {
      throw workflowError(
        'INTERVENTION_ENGINE_BUILD_WORKSPACE_MISMATCH',
        'Engine artifact must be built from the exact reserved child worktree and checkpoint base.',
        ExitCode.verification,
      );
    }
    const executablePath = assertScopedChildArtifactPath(
      childWorkspacePath,
      input.executablePath,
    );
    const executableBytes = readBoundedArtifactSource(
      childWorkspacePath,
      executablePath,
    );
    const executableDigest = digest(executableBytes);
    const sourceDigestBeforeSmoke =
      interventionSourceDigest(childWorkspacePath);
    const probe = runArtifactProbe(executablePath, '--bootstrap-probe');
    const health = runArtifactProbe(executablePath, '--health-check');
    const sourceDigest = interventionSourceDigest(childWorkspacePath);
    if (sourceDigest !== sourceDigestBeforeSmoke) {
      throw workflowError(
        'INTERVENTION_ENGINE_BUILD_SOURCE_DRIFT',
        'Engine source changed while the candidate smoke contract was running.',
        ExitCode.staleState,
      );
    }
    if (
      probe.kind !== 'engine-bootstrap-probe.v1' ||
      probe.started !== true ||
      probe.sessionSchema !== intervention.parent.sessionSchema ||
      health.kind !== 'engine-health.v1' ||
      health.healthy !== true ||
      health.sessionSchema !== intervention.parent.sessionSchema
    ) {
      throw workflowError(
        'INTERVENTION_ENGINE_BUILD_SMOKE_FAILED',
        'Candidate engine did not pass the bootstrap and health smoke contract.',
        ExitCode.verification,
      );
    }
    const smokeReportDigest = digest(
      canonicalJson({
        kind: 'intervention-engine-smoke-report.v1',
        executableDigest,
        sourceDigest,
        probe,
        health,
      }),
    );
    const artifact = createEngineArtifact({
      sourceChangeId: intervention.relationship.interventionChangeId,
      sourceDigest,
      executableDigest,
      protocolVersion: input.protocolVersion,
      canReadSessionSchemas: [intervention.parent.sessionSchema],
      writesSessionSchema: intervention.parent.sessionSchema,
      policySchemaVersion: input.policySchemaVersion,
      smokeReportDigest,
      workflowBindingDigest:
        sidecarWorkflow.workflowBinding.workflowBindingDigest,
    });
    return persistInterventionEngineArtifact(storageRoot, {
      parentChangeId: input.parentChangeId,
      artifact,
      executablePath,
      now: input.now,
    });
  }

  function persistInterventionEngineArtifact(
    storageRoot: string,
    input: {
      parentChangeId: string;
      artifact: EngineArtifact;
      executablePath: string;
      now: Date;
      testObserveArtifactRecordPublication?: (
        phase:
          | 'file-fsynced'
          | 'target-linked'
          | 'target-directory-fsynced'
          | 'temporary-cleaned',
      ) => void;
      testAfterArtifactExecutableOpenedBeforeRead?: () => void;
      testAfterWorkflowBindingVerifiedBeforeArtifactPersisted?: () => void;
      testAfterArtifactPersistedBeforeSidecar?: () => void;
    },
  ): PersistedInterventionEngineArtifact {
    const boundServices: InterventionArtifactProductionBindings = bindings();
    const {
      readPersistedIntervention,
      readPersistedBootstrapSidecarWorkflow,
      workflowError,
      ExitCode,
      activeBootstrapMaintenanceWorkflowBindingDigest,
      withRecordDigest,
      exactDate,
      maintenancePaths,
      ensurePrivateDirectory,
      storedArtifactRecordPath,
      canonicalJson,
      reconcilePrivateFileExclusivePublication,
      fs,
      recordBootstrapSidecarArtifactReady,
      createPrivateFileExclusive,
      deepFreeze,
    } = boundServices;

    const intervention = readPersistedIntervention(
      storageRoot,
      input.parentChangeId,
    );
    const sidecarWorkflow = readPersistedBootstrapSidecarWorkflow(
      storageRoot,
      input.parentChangeId,
    );
    if (sidecarWorkflow.workflowBinding.status !== 'repair-active') {
      throw workflowError(
        'INTERVENTION_ENGINE_ARTIFACT_WORKFLOW_NOT_ACTIVE',
        'Engine artifacts can be persisted only while the bootstrap-maintenance Workflow is repair-active.',
        ExitCode.conflict,
      );
    }
    const workflowBindingDigest =
      activeBootstrapMaintenanceWorkflowBindingDigest(
        sidecarWorkflow.workflowBinding,
      );
    const artifact = verifyArtifact(input.artifact);
    if (
      artifact.sourceChangeId !== intervention.relationship.interventionChangeId
    ) {
      throw workflowError(
        'INTERVENTION_ENGINE_ARTIFACT_BINDING_MISMATCH',
        'Engine artifact was not produced by the persisted intervention.',
        ExitCode.verification,
      );
    }
    if (
      artifact.workflowBindingDigest !== undefined &&
      artifact.workflowBindingDigest !== workflowBindingDigest
    ) {
      throw workflowError(
        'INTERVENTION_ENGINE_ARTIFACT_WORKFLOW_BINDING_MISMATCH',
        'Engine artifact belongs to a different bootstrap-maintenance Workflow binding.',
        ExitCode.verification,
      );
    }
    const executablePath = verifyArtifactExecutable(
      intervention.childWorkspace.childWorkspacePath,
      input.executablePath,
      artifact.executableDigest,
      input.testAfterArtifactExecutableOpenedBeforeRead,
    );
    const record = withRecordDigest({
      kind: 'persisted-intervention-engine-artifact.v2' as const,
      parentChangeId: input.parentChangeId,
      interventionChangeId: intervention.relationship.interventionChangeId,
      checkpointId: intervention.checkpoint.checkpointId,
      artifact,
      executablePath,
      workflowBindingDigest,
      workflowStatus: 'repair-active' as const,
      createdAt: exactDate(input.now).toISOString(),
    });
    const paths = maintenancePaths(storageRoot);
    ensurePrivateDirectory(paths.artifacts);
    const target = storedArtifactRecordPath(storageRoot, artifact.artifactId);
    const serializedRecord = `${canonicalJson(record)}\n`;
    if (
      reconcilePrivateFileExclusivePublication(target, serializedRecord) ||
      fs.existsSync(target)
    ) {
      const existing = readInterventionEngineArtifact(
        storageRoot,
        artifact.artifactId,
      );
      if (
        existing.parentChangeId !== record.parentChangeId ||
        existing.interventionChangeId !== record.interventionChangeId ||
        existing.checkpointId !== record.checkpointId ||
        canonicalJson(existing.artifact) !== canonicalJson(record.artifact) ||
        existing.executablePath !== record.executablePath ||
        existing.workflowBindingDigest !== record.workflowBindingDigest ||
        existing.workflowStatus !== record.workflowStatus
      ) {
        throw workflowError(
          'INTERVENTION_ENGINE_ARTIFACT_CONFLICT',
          'Artifact id is already bound to different intervention bytes.',
          ExitCode.conflict,
        );
      }
      assertArtifactWorkflowStillActive(
        storageRoot,
        input.parentChangeId,
        sidecarWorkflow.recordDigest,
        workflowBindingDigest,
      );
      recordBootstrapSidecarArtifactReady(storageRoot, {
        parentChangeId: existing.parentChangeId,
        artifact: existing.artifact,
        evidenceDigest: existing.recordDigest,
        readyAt: existing.createdAt,
      });
      return existing;
    }
    input.testAfterWorkflowBindingVerifiedBeforeArtifactPersisted?.();
    assertArtifactWorkflowStillActive(
      storageRoot,
      input.parentChangeId,
      sidecarWorkflow.recordDigest,
      workflowBindingDigest,
    );
    createPrivateFileExclusive(
      target,
      serializedRecord,
      input.testObserveArtifactRecordPublication,
    );
    input.testAfterArtifactPersistedBeforeSidecar?.();
    assertArtifactWorkflowStillActive(
      storageRoot,
      input.parentChangeId,
      sidecarWorkflow.recordDigest,
      workflowBindingDigest,
    );
    recordBootstrapSidecarArtifactReady(storageRoot, {
      parentChangeId: record.parentChangeId,
      artifact: record.artifact,
      evidenceDigest: record.recordDigest,
      readyAt: record.createdAt,
    });
    return deepFreeze(structuredClone(record));
  }

  function assertArtifactWorkflowStillActive(
    storageRoot: string,
    parentChangeId: string,
    expectedSidecarRecordDigest: Sha256Digest,
    expectedWorkflowBindingDigest: Sha256Digest,
  ): void {
    const boundServices: InterventionArtifactProductionBindings = bindings();
    const { readPersistedBootstrapSidecarWorkflow, workflowError, ExitCode } =
      boundServices;

    const current = readPersistedBootstrapSidecarWorkflow(
      storageRoot,
      parentChangeId,
    );
    if (
      current.recordDigest !== expectedSidecarRecordDigest ||
      current.workflowBinding.status !== 'repair-active' ||
      current.workflowBinding.workflowBindingDigest !==
        expectedWorkflowBindingDigest
    ) {
      throw workflowError(
        'INTERVENTION_ENGINE_ARTIFACT_WORKFLOW_NOT_ACTIVE',
        'Bootstrap-maintenance Workflow changed before the artifact record could be persisted.',
        ExitCode.staleState,
      );
    }
  }

  function readInterventionEngineArtifact(
    storageRoot: string,
    artifactId: string,
  ): PersistedInterventionEngineArtifact {
    const boundServices: InterventionArtifactProductionBindings = bindings();
    const {
      readStoredInterventionEngineArtifact,
      readPersistedIntervention,
      artifactRecordCorrupt,
      readPersistedBootstrapSidecarWorkflow,
      activeBootstrapMaintenanceWorkflowBindingDigest,
      deepFreeze,
    } = boundServices;

    const record = readStoredInterventionEngineArtifact(
      storageRoot,
      artifactId,
    );
    const intervention = readPersistedIntervention(
      storageRoot,
      record.parentChangeId,
    );
    const artifact = verifyArtifact(record.artifact);
    if (
      artifact.artifactId !== artifactId ||
      record.interventionChangeId !==
        intervention.relationship.interventionChangeId ||
      record.checkpointId !== intervention.checkpoint.checkpointId
    ) {
      throw artifactRecordCorrupt();
    }
    const sidecarWorkflow = readPersistedBootstrapSidecarWorkflow(
      storageRoot,
      record.parentChangeId,
    );
    if (
      record.workflowBindingDigest !==
        (sidecarWorkflow.workflowBinding.status === 'repair-active'
          ? sidecarWorkflow.workflowBinding.workflowBindingDigest
          : activeBootstrapMaintenanceWorkflowBindingDigest(
              sidecarWorkflow.workflowBinding,
            )) ||
      (artifact.workflowBindingDigest !== undefined &&
        artifact.workflowBindingDigest !== record.workflowBindingDigest)
    ) {
      throw artifactRecordCorrupt();
    }
    verifyArtifactExecutable(
      intervention.childWorkspace.childWorkspacePath,
      record.executablePath,
      artifact.executableDigest,
    );
    return deepFreeze(structuredClone({ ...record, artifact }));
  }

  function preparePersistedEngineAdoptionFromArtifactRecord(
    storageRoot: string,
    input: {
      txId: string;
      parentChangeId: string;
      artifactId: Sha256Digest;
      maintenanceGrantEnvelope: HarnessMaintenanceGrantEnvelope;
      priorLocalAdoptions: number;
      testAfterArtifactSnapshotBeforeParentLock?: () => void;
    },
    dependencies: Parameters<typeof preparePersistedEngineAdoption>[2],
  ) {
    const boundServices: InterventionArtifactProductionBindings = bindings();
    const { workflowError, ExitCode, preparePersistedEngineAdoption } =
      boundServices;

    const record = readInterventionEngineArtifact(
      storageRoot,
      input.artifactId,
    );
    if (record.parentChangeId !== input.parentChangeId) {
      throw workflowError(
        'INTERVENTION_ENGINE_ARTIFACT_WORKFLOW_BINDING_REQUIRED',
        'Engine adoption requires the exact persisted v2 artifact record for the active bootstrap-maintenance Workflow.',
        ExitCode.verification,
      );
    }
    input.testAfterArtifactSnapshotBeforeParentLock?.();
    return preparePersistedEngineAdoption(
      storageRoot,
      {
        txId: input.txId,
        parentChangeId: input.parentChangeId,
        artifact: record.artifact,
        artifactAuthority: {
          recordDigest: record.recordDigest,
          createdAt: record.createdAt,
          workflowBindingDigest: record.workflowBindingDigest,
        },
        maintenanceGrantEnvelope: input.maintenanceGrantEnvelope,
        priorLocalAdoptions: input.priorLocalAdoptions,
      },
      dependencies,
    );
  }

  function interventionSourceDigest(childWorkspacePath: string): Sha256Digest {
    const boundServices: InterventionArtifactProductionBindings = bindings();
    const {
      runGit,
      path,
      fs,
      MAX_EXECUTABLE_BYTES,
      workflowError,
      ExitCode,
      MAX_SOURCE_SNAPSHOT_BYTES,
      digest,
      canonicalJson,
    } = boundServices;

    const changed = runGit(childWorkspacePath, [
      'diff',
      '--name-only',
      '--no-renames',
      '-z',
      'HEAD',
      '--',
    ]);
    const untracked = runGit(childWorkspacePath, [
      'ls-files',
      '--others',
      '--exclude-standard',
      '-z',
    ]);
    const paths = [
      ...new Set([...splitNul(changed), ...splitNul(untracked)]),
    ].sort();
    let totalBytes = 0;
    const entries = paths.map((relativePath) => {
      assertMaintenanceScopedRelativePath(relativePath);
      const target = path.join(childWorkspacePath, relativePath);
      const stats = fs.lstatSync(target, { throwIfNoEntry: false });
      if (!stats) {
        return { path: relativePath, kind: 'deleted' as const };
      }
      if (
        !stats.isFile() ||
        stats.isSymbolicLink() ||
        stats.nlink !== 1 ||
        stats.size > MAX_EXECUTABLE_BYTES
      ) {
        throw workflowError(
          'INTERVENTION_ENGINE_BUILD_SOURCE_UNSAFE',
          `Engine source snapshot contains an unsafe entry: ${relativePath}`,
          ExitCode.unsafeEnvironment,
        );
      }
      totalBytes += stats.size;
      if (totalBytes > MAX_SOURCE_SNAPSHOT_BYTES) {
        throw workflowError(
          'INTERVENTION_ENGINE_BUILD_SOURCE_TOO_LARGE',
          'Engine source snapshot exceeds the bounded build limit.',
          ExitCode.guard,
        );
      }
      return {
        path: relativePath,
        kind: 'file' as const,
        mode: (stats.mode & 0o111) === 0 ? '100644' : '100755',
        contentDigest: digest(fs.readFileSync(target)),
      };
    });
    const head = runGit(childWorkspacePath, ['rev-parse', 'HEAD']).trim();
    return digest(
      canonicalJson({
        kind: 'intervention-engine-source-snapshot.v1',
        head,
        entries,
      }),
    );
  }

  function assertScopedChildArtifactPath(
    childWorkspacePath: string,
    requestedPath: string,
  ): string {
    const boundServices: InterventionArtifactProductionBindings = bindings();
    const { path, workflowError, ExitCode, fs } = boundServices;

    if (
      typeof requestedPath !== 'string' ||
      !path.isAbsolute(requestedPath) ||
      path.resolve(requestedPath) !== requestedPath
    ) {
      throw workflowError(
        'INTERVENTION_ENGINE_BUILD_PATH_INVALID',
        'Engine executable path must be exact, normalized, and absolute.',
        ExitCode.usage,
      );
    }
    const childRoot = fs.realpathSync(childWorkspacePath);
    const relativePath = path.relative(childRoot, requestedPath);
    if (
      relativePath.length === 0 ||
      relativePath.startsWith('..') ||
      path.isAbsolute(relativePath)
    ) {
      throw workflowError(
        'INTERVENTION_ENGINE_BUILD_PATH_OUTSIDE_SCOPE',
        'Engine executable must stay inside the reserved child worktree.',
        ExitCode.guard,
      );
    }
    assertMaintenanceScopedRelativePath(relativePath);
    return requestedPath;
  }

  function assertMaintenanceScopedRelativePath(relativePath: string): void {
    const boundServices: InterventionArtifactProductionBindings = bindings();
    const { path, workflowError, ExitCode } = boundServices;

    const normalized = relativePath.split(path.sep).join('/');
    if (
      normalized !== relativePath ||
      normalized.length === 0 ||
      normalized.startsWith('/') ||
      normalized.split('/').some((part) => part === '' || part === '..') ||
      (!normalized.startsWith('packages/workflow-engine/') &&
        !normalized.startsWith('packages/harness-runtime/'))
    ) {
      throw workflowError(
        'INTERVENTION_ENGINE_BUILD_SCOPE_VIOLATION',
        `Engine build changed a path outside the signed maintenance scope: ${relativePath}`,
        ExitCode.guard,
      );
    }
  }

  function readBoundedArtifactSource(
    childWorkspacePath: string,
    filePath: string,
  ): Buffer {
    const boundServices: InterventionArtifactProductionBindings = bindings();
    const { workflowError, ExitCode } = boundServices;

    try {
      return readStableArtifactExecutable(childWorkspacePath, filePath).bytes;
    } catch {
      throw workflowError(
        'INTERVENTION_ENGINE_BUILD_EXECUTABLE_UNSAFE',
        'Candidate engine must be a bounded canonical single-link executable.',
        ExitCode.unsafeEnvironment,
      );
    }
  }

  function runArtifactProbe(
    executablePath: string,
    mode: '--bootstrap-probe' | '--health-check',
  ): Record<string, unknown> {
    const boundServices: InterventionArtifactProductionBindings = bindings();
    const {
      spawnSync,
      path,
      ENGINE_PROBE_TIMEOUT_MS,
      workflowError,
      ExitCode,
      isRecord,
    } = boundServices;

    const result = spawnSync(executablePath, [mode], {
      cwd: path.dirname(executablePath),
      encoding: 'utf8',
      timeout: ENGINE_PROBE_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      env: {
        PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
        LANG: 'C',
        LC_ALL: 'C',
        TMPDIR: path.dirname(executablePath),
      },
    });
    if (
      result.error ||
      result.status !== 0 ||
      typeof result.stdout !== 'string'
    ) {
      throw workflowError(
        'INTERVENTION_ENGINE_BUILD_SMOKE_FAILED',
        `Candidate engine ${mode} command failed.`,
        ExitCode.verification,
      );
    }
    let value: unknown;
    try {
      value = JSON.parse(result.stdout);
    } catch {
      throw workflowError(
        'INTERVENTION_ENGINE_BUILD_SMOKE_INVALID',
        `Candidate engine ${mode} output is not JSON.`,
        ExitCode.verification,
      );
    }
    if (!isRecord(value)) {
      throw workflowError(
        'INTERVENTION_ENGINE_BUILD_SMOKE_INVALID',
        `Candidate engine ${mode} output must be an object.`,
        ExitCode.verification,
      );
    }
    return value;
  }

  function splitNul(value: string): string[] {
    const boundServices: InterventionArtifactProductionBindings = bindings();
    const { workflowError, ExitCode } = boundServices;

    if (value.length === 0) return [];
    if (!value.endsWith('\0')) {
      throw workflowError(
        'INTERVENTION_ENGINE_BUILD_GIT_OUTPUT_INVALID',
        'Git source snapshot output was not NUL terminated.',
        ExitCode.verification,
      );
    }
    return value.slice(0, -1).split('\0');
  }

  function verifyArtifact(artifact: EngineArtifact): EngineArtifact {
    const boundServices: InterventionArtifactProductionBindings = bindings();
    const { createEngineArtifact, artifactRecordCorrupt } = boundServices;

    const rebuilt = createEngineArtifact(artifact);
    if (rebuilt.artifactId !== artifact.artifactId)
      throw artifactRecordCorrupt();
    return rebuilt;
  }

  function verifyArtifactExecutable(
    childWorkspacePath: string,
    requestedPath: string,
    expectedDigest: Sha256Digest,
    testAfterOpenedBeforeRead?: () => void,
  ): string {
    const boundServices: InterventionArtifactProductionBindings = bindings();
    const { digest, workflowError, ExitCode } = boundServices;

    try {
      const stable = readStableArtifactExecutable(
        childWorkspacePath,
        requestedPath,
        testAfterOpenedBeforeRead,
      );
      if (digest(stable.bytes) !== expectedDigest)
        throw new Error('digest drift');
      return stable.executablePath;
    } catch {
      throw workflowError(
        'INTERVENTION_ENGINE_ARTIFACT_DRIFT',
        'Persisted engine artifact executable is missing, unsafe, or changed.',
        ExitCode.verification,
      );
    }
  }

  function readStableArtifactExecutable(
    childWorkspacePath: string,
    requestedPath: string,
    testAfterOpenedBeforeRead?: () => void,
  ): { executablePath: string; bytes: Buffer } {
    const boundServices: InterventionArtifactProductionBindings = bindings();
    const { path, fs } = boundServices;

    if (
      typeof requestedPath !== 'string' ||
      !path.isAbsolute(requestedPath) ||
      path.resolve(requestedPath) !== requestedPath
    ) {
      throw new Error('non-canonical executable path');
    }
    const childRoot = fs.realpathSync(childWorkspacePath);
    if (childRoot !== childWorkspacePath) {
      throw new Error('non-canonical child workspace');
    }
    const relative = path.relative(childRoot, requestedPath);
    if (
      relative.length === 0 ||
      relative.startsWith('..') ||
      path.isAbsolute(relative)
    ) {
      throw new Error('executable outside child workspace');
    }

    const descriptor = fs.openSync(
      requestedPath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    try {
      const before = fs.fstatSync(descriptor, { bigint: true });
      assertStableArtifactExecutable(before);
      testAfterOpenedBeforeRead?.();
      const bytes = fs.readFileSync(descriptor);
      const after = fs.fstatSync(descriptor, { bigint: true });
      const current = fs.lstatSync(requestedPath, {
        bigint: true,
        throwIfNoEntry: false,
      });
      let currentRealPath: string | null = null;
      try {
        currentRealPath = fs.realpathSync(requestedPath);
      } catch {
        // The stable identity comparison below fails closed.
      }
      if (
        current === undefined ||
        current.isSymbolicLink() ||
        currentRealPath !== requestedPath ||
        bytes.length !== Number(before.size) ||
        !sameArtifactExecutableIdentity(before, after) ||
        !sameArtifactExecutableIdentity(before, current)
      ) {
        throw new Error('executable pathname changed during verification');
      }
      return { executablePath: requestedPath, bytes };
    } finally {
      fs.closeSync(descriptor);
    }
  }

  function assertStableArtifactExecutable(stats: fs.BigIntStats): void {
    const boundServices: InterventionArtifactProductionBindings = bindings();
    const { MAX_EXECUTABLE_BYTES } = boundServices;

    if (
      !stats.isFile() ||
      stats.isSymbolicLink() ||
      stats.nlink !== 1n ||
      stats.size < 1n ||
      stats.size > BigInt(MAX_EXECUTABLE_BYTES)
    ) {
      throw new Error('unsafe executable inode');
    }
  }

  function sameArtifactExecutableIdentity(
    expected: fs.BigIntStats,
    observed: fs.BigIntStats,
  ): boolean {
    return (
      observed.isFile() &&
      !observed.isSymbolicLink() &&
      expected.dev === observed.dev &&
      expected.ino === observed.ino &&
      expected.mode === observed.mode &&
      expected.nlink === observed.nlink &&
      expected.size === observed.size &&
      expected.mtimeNs === observed.mtimeNs &&
      expected.ctimeNs === observed.ctimeNs
    );
  }
  return {
    buildAndPersistInterventionEngineArtifact,
    persistInterventionEngineArtifact,
    readInterventionEngineArtifact,
    preparePersistedEngineAdoptionFromArtifactRecord,
    sameArtifactExecutableIdentity,
  };
}

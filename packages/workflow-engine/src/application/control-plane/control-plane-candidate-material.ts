/**
 * Derives frozen control-plane candidate material and resolves its
 * supervisor history and executable evidence.
 *
 * Invariants:
 * - A successor supervisor cannot create an initial history anchor when
 *   verified history is absent.
 */
// Repository effects remain bound by the public module.
import type {
  BootstrapControlPlaneEngineArtifact,
  ControlPlanePromotionBootstrapObservations,
} from '../../modules/authority/intervention-bootstrap-contract.ts';
import type {
  ControlPlaneCandidateMaterialBindings,
  ControlPlaneCandidateMaterialBindingsTypes,
} from './control-plane-promotion-producer.ts';
import { resolveTreeOid } from '../../runtime/repository-transaction/git-object-ids.ts';

type VerifiedControlPlaneSupervisorHistory =
  ControlPlaneCandidateMaterialBindingsTypes['VerifiedControlPlaneSupervisorHistory'];
type ImmutableCandidateBundleV2 =
  ControlPlaneCandidateMaterialBindingsTypes['ImmutableCandidateBundleV2'];
type DerivedFrozenCandidate =
  ControlPlaneCandidateMaterialBindingsTypes['DerivedFrozenCandidate'];
type ExactControlPlaneChangeV2 =
  ControlPlaneCandidateMaterialBindingsTypes['ExactControlPlaneChangeV2'];
type ControlPlanePromotionFileMaterial =
  ControlPlaneCandidateMaterialBindingsTypes['ControlPlanePromotionFileMaterial'];
type Sha256Digest = ControlPlaneCandidateMaterialBindingsTypes['Sha256Digest'];
type ExactGitFileState =
  ControlPlaneCandidateMaterialBindingsTypes['ExactGitFileState'];
declare const readControlPlaneSupervisorState: ControlPlaneCandidateMaterialBindingsTypes['readControlPlaneSupervisorState'];
declare const discoverRepository: ControlPlaneCandidateMaterialBindingsTypes['discoverRepository'];

export function createControlPlaneCandidateMaterial(
  bindings: () => ControlPlaneCandidateMaterialBindings,
) {
  function ensureTerminalSupervisorHistory(
    stateRoot: string,
    supervisor: ReturnType<typeof readControlPlaneSupervisorState>,
    expectedActiveTrustCommit: string,
    bootstrapObservations: ControlPlanePromotionBootstrapObservations,
  ): {
    history: VerifiedControlPlaneSupervisorHistory;
    restartArtifact: BootstrapControlPlaneEngineArtifact;
  } {
    const boundServices: ControlPlaneCandidateMaterialBindings = bindings();
    const {
      controlPlaneSupervisorHistoryDirectory,
      fs,
      readControlPlaneSupervisorHistory,
      producerError,
      ExitCode,
      createControlPlaneSupervisorHistoryAnchor,
      appendControlPlaneSupervisorHistoryRecord,
    } = boundServices;

    const {
      readBuiltInControlPlaneEngineArtifact,
      readInitialControlPlaneSupervisorAnchorEvidence,
    } = bootstrapObservations;

    const directory = controlPlaneSupervisorHistoryDirectory(stateRoot);
    if (fs.lstatSync(directory, { throwIfNoEntry: false }) !== undefined) {
      const history = readControlPlaneSupervisorHistory(stateRoot);
      if (supervisor.generation === 1) {
        return {
          history,
          restartArtifact: readBuiltInControlPlaneEngineArtifact(stateRoot),
        };
      }
      return {
        history,
        restartArtifact: resolveTerminalHistoryArtifact(
          stateRoot,
          supervisor,
          history,
        ),
      };
    }
    if (supervisor.generation !== 1 || supervisor.transition !== null) {
      throw producerError(
        'CONTROL_PLANE_PRODUCER_HISTORY_REQUIRED',
        'A successor supervisor requires an existing verified current history anchor.',
        ExitCode.staleState,
      );
    }
    const evidence = readInitialControlPlaneSupervisorAnchorEvidence(
      stateRoot,
      supervisor.repositoryId,
    );
    if (
      evidence.activeTrustCommit !== expectedActiveTrustCommit ||
      evidence.supervisorRecordDigest !== supervisor.recordDigest
    ) {
      throw producerError(
        'CONTROL_PLANE_PRODUCER_HISTORY_MISMATCH',
        'Initial bootstrap evidence does not bind the frozen candidate trust base.',
        ExitCode.staleState,
      );
    }
    const anchor = createControlPlaneSupervisorHistoryAnchor({
      repositoryId: supervisor.repositoryId,
      generation: 1,
      supervisorRecordDigest: supervisor.recordDigest,
      activeArtifact: evidence.activeArtifact,
      activeTrustCommit: evidence.activeTrustCommit,
      authority: {
        kind: 'initial-bootstrap-anchor.v1',
        initialBootstrapPublishedDigest: evidence.publishedRecordDigest,
      },
      recordedAt: evidence.recordedAt,
    });
    appendControlPlaneSupervisorHistoryRecord(stateRoot, anchor);
    return {
      history: readControlPlaneSupervisorHistory(stateRoot),
      restartArtifact: readBuiltInControlPlaneEngineArtifact(stateRoot),
    };
  }

  function resolveTerminalHistoryArtifact(
    stateRoot: string,
    supervisor: ReturnType<typeof readControlPlaneSupervisorState>,
    history: VerifiedControlPlaneSupervisorHistory,
  ): BootstrapControlPlaneEngineArtifact {
    const boundServices: ControlPlaneCandidateMaterialBindings = bindings();
    const {
      producerError,
      ExitCode,
      readPersistedControlPlaneUpdate,
      readPersistedControlPlaneApprovalCandidateCurrent,
    } = boundServices;

    const leaf = history.leaf;
    if (leaf.kind === 'control-plane-supervisor-history-anchor.v1') {
      throw producerError(
        'CONTROL_PLANE_PRODUCER_HISTORY_ARTIFACT_UNAVAILABLE',
        'The terminal history leaf has no material-bound update authority.',
        ExitCode.verification,
      );
    }
    const grantId = leaf.grantId;
    const record = readPersistedControlPlaneUpdate(stateRoot, grantId);
    if (
      record.kind !== 'persisted-control-plane-update.v3' ||
      record.grantState !== 'consumed' ||
      (record.transaction.state !== 'FINALIZED' &&
        record.transaction.state !== 'ROLLED_BACK')
    ) {
      throw producerError(
        'CONTROL_PLANE_PRODUCER_HISTORY_MISMATCH',
        'The terminal history record points to a non-terminal update.',
        ExitCode.verification,
      );
    }
    const candidate = readPersistedControlPlaneApprovalCandidateCurrent(
      stateRoot,
      record.envelope.payload.promotionBundleDigest,
    );
    const material = candidate.bundle.material;
    const artifact =
      record.transaction.state === 'FINALIZED'
        ? material.candidateArtifact
        : material.recoveryBundle.restartArtifact;
    if (
      artifact.artifactId !== supervisor.activeArtifact.artifactId ||
      artifact.executableDigest !==
        supervisor.activeArtifact.executableDigest ||
      history.supervisorRecordDigest !== supervisor.recordDigest ||
      history.generation !== supervisor.generation ||
      (leaf.kind === 'control-plane-supervisor-history-terminal.v1' &&
        (leaf.updateRecordDigest !== record.recordDigest ||
          leaf.transactionJournalDigest !== record.transaction.journalDigest))
    ) {
      throw producerError(
        'CONTROL_PLANE_PRODUCER_HISTORY_MISMATCH',
        'The terminal history artifact differs from the current supervisor or update record.',
        ExitCode.verification,
      );
    }
    return artifact;
  }

  function assertFrozenCandidatePrestate(
    repository: ReturnType<typeof discoverRepository>,
    candidate: ImmutableCandidateBundleV2,
  ): void {
    const boundServices: ControlPlaneCandidateMaterialBindings = bindings();
    const { producerError, ExitCode, runGit, canonicalJson } = boundServices;

    const expectedTargetRef =
      repository.branch === null ? null : `refs/heads/${repository.branch}`;
    if (
      candidate.classification !== 'control-plane' ||
      candidate.manifest.trustBaseCommit !== candidate.expectedOldCommit ||
      repository.head !== candidate.expectedOldCommit ||
      candidate.targetRef !== expectedTargetRef
    ) {
      throw producerError(
        'CONTROL_PLANE_PRODUCER_FROZEN_CANDIDATE_MISMATCH',
        'Production material requires a frozen Class-C candidate for the exact clean HEAD and target ref.',
        ExitCode.staleState,
      );
    }
    const tree = resolveTreeOid(
      repository.repositoryRoot,
      candidate.candidateCommit,
    );
    const parents = runGit(repository.repositoryRoot, [
      'rev-list',
      '--parents',
      '-n',
      '1',
      candidate.candidateCommit,
    ])
      .trim()
      .split(/\s+/)
      .slice(1);
    const message = readGitCommitMessage(
      repository.repositoryRoot,
      candidate.candidateCommit,
    );
    if (
      tree !== candidate.resultTree ||
      canonicalJson(parents) !== canonicalJson([candidate.expectedOldCommit]) ||
      message !== candidate.commitMessage
    ) {
      throw producerError(
        'CONTROL_PLANE_PRODUCER_CANDIDATE_COMMIT_MISMATCH',
        'The frozen candidate commit does not bind the claimed tree, parent, and message.',
        ExitCode.verification,
      );
    }
  }

  function assertProducerStateRoot(
    gitCommonDirectory: string,
    stateRoot: string,
    bootstrapObservations: ControlPlanePromotionBootstrapObservations,
  ): void {
    const boundServices: ControlPlaneCandidateMaterialBindings = bindings();
    const { fs, path, producerError, ExitCode } = boundServices;

    const { bootstrapInterventionStateRoot } = bootstrapObservations;
    const expected = bootstrapInterventionStateRoot(gitCommonDirectory);
    const stats =
      typeof stateRoot === 'string'
        ? fs.lstatSync(stateRoot, { throwIfNoEntry: false })
        : undefined;
    if (
      typeof stateRoot !== 'string' ||
      !path.isAbsolute(stateRoot) ||
      path.resolve(stateRoot) !== stateRoot ||
      stateRoot !== expected ||
      (stats !== undefined &&
        (!stats.isDirectory() ||
          stats.isSymbolicLink() ||
          fs.realpathSync(stateRoot) !== stateRoot))
    ) {
      throw producerError(
        'CONTROL_PLANE_PRODUCER_STATE_ROOT_MISMATCH',
        'Control-plane producer state must be the bootstrap-derived store for the exact repository.',
        ExitCode.unsafeEnvironment,
      );
    }
  }

  function readGitCommitMessage(
    repositoryRoot: string,
    candidateCommit: string,
  ): string {
    const boundServices: ControlPlaneCandidateMaterialBindings = bindings();
    const { runGitBuffer, producerError, ExitCode } = boundServices;

    const commit = runGitBuffer(repositoryRoot, [
      'cat-file',
      'commit',
      candidateCommit,
    ]);
    const separator = commit.indexOf(Buffer.from('\n\n'));
    if (separator < 0) {
      throw producerError(
        'CONTROL_PLANE_PRODUCER_CANDIDATE_COMMIT_MISMATCH',
        'The frozen candidate commit object has no canonical message boundary.',
        ExitCode.verification,
      );
    }
    return commit.subarray(separator + 2).toString('utf8');
  }

  function deriveFrozenCandidate(
    repositoryRoot: string,
    candidate: ImmutableCandidateBundleV2,
  ): DerivedFrozenCandidate {
    const boundServices: ControlPlaneCandidateMaterialBindings = bindings();
    const {
      runGitBuffer,
      compareCanonicalStrings,
      canonicalJson,
      producerError,
      ExitCode,
    } = boundServices;

    const changedPaths = runGitBuffer(repositoryRoot, [
      'diff',
      '--name-only',
      '-z',
      '--no-renames',
      candidate.expectedOldCommit,
      candidate.candidateCommit,
      '--',
    ])
      .toString('utf8')
      .split('\0')
      .filter(Boolean)
      .sort(compareCanonicalStrings);
    const manifestPaths = candidate.manifest.files.map(
      ({ path: filePath }) => filePath,
    );
    if (canonicalJson(changedPaths) !== canonicalJson(manifestPaths)) {
      throw producerError(
        'CONTROL_PLANE_PRODUCER_EXACT_DIFF_MISMATCH',
        'The candidate commit changed paths differ from the frozen patch manifest.',
        ExitCode.verification,
      );
    }
    const exactChanges: ExactControlPlaneChangeV2[] = [];
    const beforeFiles: ControlPlanePromotionFileMaterial[] = [];
    const afterFiles: ControlPlanePromotionFileMaterial[] = [];
    for (const manifestFile of candidate.manifest.files) {
      const before = readGitFileState(
        repositoryRoot,
        candidate.expectedOldCommit,
        manifestFile.path,
      );
      const after = readGitFileState(
        repositoryRoot,
        candidate.candidateCommit,
        manifestFile.path,
      );
      const operation =
        before === null ? 'add' : after === null ? 'delete' : 'modify';
      if (
        operation !== manifestFile.operation ||
        (before?.objectId ?? null) !== manifestFile.beforeBlobOid ||
        (before?.mode ?? null) !== manifestFile.beforeMode ||
        (after?.contentDigest.slice('sha256:'.length) ?? null) !==
          manifestFile.afterSha256 ||
        (after?.mode ?? null) !== manifestFile.afterMode
      ) {
        throw producerError(
          'CONTROL_PLANE_PRODUCER_EXACT_DIFF_MISMATCH',
          `Git object bytes or modes for ${manifestFile.path} differ from the frozen patch manifest.`,
          ExitCode.verification,
        );
      }
      exactChanges.push({
        path: manifestFile.path,
        beforeDigest: before?.contentDigest ?? null,
        afterDigest: after?.contentDigest ?? null,
        beforeMode: before?.mode ?? null,
        afterMode: after?.mode ?? null,
      });
      if (before !== null) beforeFiles.push(promotionFile(before));
      if (after !== null) afterFiles.push(promotionFile(after));
    }
    return {
      exactChanges,
      beforeFiles,
      afterFiles,
    };
  }

  function frozenCandidateSourceDigest(
    expectedOldCommit: string,
    changes: ExactControlPlaneChangeV2[],
  ): Sha256Digest {
    const boundServices: ControlPlaneCandidateMaterialBindings = bindings();
    const {
      compareCanonicalStrings,
      producerError,
      ExitCode,
      rawDigest,
      canonicalJson,
    } = boundServices;

    const entries = [...changes]
      .sort((left, right) => compareCanonicalStrings(left.path, right.path))
      .map((change) => {
        if (change.afterDigest === null) {
          if (change.afterMode !== null) {
            throw producerError(
              'CONTROL_PLANE_PRODUCER_ARTIFACT_SOURCE_MISMATCH',
              'Deleted candidate source entry unexpectedly retains a Git mode.',
              ExitCode.verification,
            );
          }
          return { path: change.path, kind: 'deleted' as const };
        }
        if (change.afterMode === null) {
          throw producerError(
            'CONTROL_PLANE_PRODUCER_ARTIFACT_SOURCE_MISMATCH',
            'Candidate source entry is missing its exact Git mode.',
            ExitCode.verification,
          );
        }
        return {
          path: change.path,
          kind: 'file' as const,
          mode: change.afterMode,
          contentDigest: change.afterDigest,
        };
      });
    return rawDigest(
      canonicalJson({
        kind: 'intervention-engine-source-snapshot.v1',
        head: expectedOldCommit,
        entries,
      }),
    );
  }

  function readGitFileState(
    repositoryRoot: string,
    commit: string,
    filePath: string,
  ): ExactGitFileState | null {
    const boundServices: ControlPlaneCandidateMaterialBindings = bindings();
    const { runGitBuffer, gitMaterialInvalid, rawDigest } = boundServices;

    const output = runGitBuffer(repositoryRoot, [
      'ls-tree',
      '-z',
      commit,
      '--',
      `:(literal)${filePath}`,
    ]);
    if (output.length === 0) return null;
    const records = output.toString('utf8').split('\0').filter(Boolean);
    if (records.length !== 1) throw gitMaterialInvalid(filePath);
    const match = /^(\d{6}) blob ([0-9a-f]{40}|[0-9a-f]{64})\t(.+)$/.exec(
      records[0]!,
    );
    if (
      match === null ||
      match[3] !== filePath ||
      (match[1] !== '100644' && match[1] !== '100755')
    ) {
      throw gitMaterialInvalid(filePath);
    }
    const content = runGitBuffer(repositoryRoot, [
      'cat-file',
      'blob',
      match[2]!,
    ]);
    return {
      path: filePath,
      mode: match[1] as '100644' | '100755',
      objectId: match[2]!,
      content,
      contentDigest: rawDigest(content),
    };
  }

  function promotionFile(
    state: ExactGitFileState,
  ): ControlPlanePromotionFileMaterial {
    return {
      path: state.path,
      mode: state.mode,
      contentBase64: state.content.toString('base64'),
      contentDigest: state.contentDigest,
    };
  }

  function readStableExecutable(
    executablePath: string,
    expectedDigest: Sha256Digest,
  ): Buffer {
    const boundServices: ControlPlaneCandidateMaterialBindings = bindings();
    const { fs, MAX_EXECUTABLE_BYTES, executableInvalid, rawDigest } =
      boundServices;

    const stats = fs.lstatSync(executablePath, { throwIfNoEntry: false });
    if (
      !stats?.isFile() ||
      stats.isSymbolicLink() ||
      stats.size < 1 ||
      stats.size > MAX_EXECUTABLE_BYTES ||
      (stats.mode & 0o111) === 0
    ) {
      throw executableInvalid();
    }
    const content = fs.readFileSync(executablePath);
    if (rawDigest(content) !== expectedDigest) throw executableInvalid();
    return content;
  }

  function assertExecutableUnchanged(
    executablePath: string,
    expectedBytes: Buffer,
    expectedDigest: Sha256Digest,
  ): void {
    const boundServices: ControlPlaneCandidateMaterialBindings = bindings();
    const { executableInvalid } = boundServices;

    const observed = readStableExecutable(executablePath, expectedDigest);
    if (!observed.equals(expectedBytes)) throw executableInvalid();
  }

  function runControlPlaneProbe(
    executablePath: string,
    executableDigest: Sha256Digest,
    mode: '--control-plane-self-test' | '--control-plane-restart-probe',
    expected: {
      kind: 'control-plane-self-test.v1' | 'control-plane-restart.v1';
      property: 'healthy' | 'ready';
      closureDigest: Sha256Digest;
    },
  ): Record<string, unknown> {
    const boundServices: ControlPlaneCandidateMaterialBindings = bindings();
    const {
      path,
      childProcess,
      PROCESS_TIMEOUT_MS,
      MAX_PROCESS_OUTPUT_BYTES,
      processEvidenceInvalid,
    } = boundServices;

    readStableExecutable(executablePath, executableDigest);
    const cwd = path.dirname(executablePath);
    const result = childProcess.spawnSync(executablePath, [mode], {
      cwd,
      shell: false,
      encoding: 'utf8',
      timeout: PROCESS_TIMEOUT_MS,
      maxBuffer: MAX_PROCESS_OUTPUT_BYTES,
      windowsHide: true,
      env: {
        PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
        LANG: 'C',
        LC_ALL: 'C',
        TMPDIR: cwd,
      },
    });
    if (result.error || result.signal || result.status !== 0) {
      throw processEvidenceInvalid();
    }
    let response: unknown;
    try {
      response = JSON.parse(result.stdout.trim()) as unknown;
    } catch {
      throw processEvidenceInvalid();
    }
    if (
      response === null ||
      typeof response !== 'object' ||
      Array.isArray(response) ||
      Object.keys(response).sort().join(',') !==
        ['closureDigest', 'kind', expected.property].sort().join(',') ||
      (response as Record<string, unknown>).kind !== expected.kind ||
      (response as Record<string, unknown>)[expected.property] !== true ||
      (response as Record<string, unknown>).closureDigest !==
        expected.closureDigest
    ) {
      throw processEvidenceInvalid();
    }
    return response as Record<string, unknown>;
  }
  return {
    ensureTerminalSupervisorHistory,
    assertFrozenCandidatePrestate,
    assertProducerStateRoot,
    deriveFrozenCandidate,
    frozenCandidateSourceDigest,
    readStableExecutable,
    assertExecutableUnchanged,
    runControlPlaneProbe,
  };
}

import type { MaintainerManifestOperations } from '../../modules/authority/maintainer-manifest.ts';
/**
 * Prepares candidate checks and verifies maintainer apply preconditions.
 *
 * Invariants:
 * - Approve-and-apply checks require the current candidate to match its
 *   preflight.
 */
// maintainer apply checks; repository effects remain bound by the public module.
import type {
  MaintainerApplyChecksBindings,
  MaintainerApplyChecksBindingsTypes,
} from './maintainer-approve.ts';
type MaintainerGrantV2PreflightResult =
  MaintainerApplyChecksBindingsTypes['MaintainerGrantV2PreflightResult'];
type PrepareMaintainerGrantV2ChecksOptions =
  MaintainerApplyChecksBindingsTypes['PrepareMaintainerGrantV2ChecksOptions'];
type MaintainerChecksAttestationV2 =
  MaintainerApplyChecksBindingsTypes['MaintainerChecksAttestationV2'];
type MaintainerCheckJournalIdentity =
  MaintainerApplyChecksBindingsTypes['MaintainerCheckJournalIdentity'];
type ApproveAndApplyMaintainerGrantV2Request =
  MaintainerApplyChecksBindingsTypes['ApproveAndApplyMaintainerGrantV2Request'];
type CheckDefinition = MaintainerApplyChecksBindingsTypes['CheckDefinition'];
declare const discoverRepository: MaintainerApplyChecksBindings['discoverRepository'];

export function createMaintainerApplyChecks(
  bindings: () => MaintainerApplyChecksBindings,
) {
  function prepareMaintainerGrantV2Checks(
    manifestOperations: MaintainerManifestOperations,
    cwd: string,
    preflight: MaintainerGrantV2PreflightResult,
    environment: NodeJS.ProcessEnv = process.env,
    options: PrepareMaintainerGrantV2ChecksOptions = {},
  ): MaintainerChecksAttestationV2 {
    const boundServices: MaintainerApplyChecksBindings = bindings();
    const {
      workflowError,
      ExitCode,
      discoverRepository,
      preflightMaintainerGrantV2,
      canonicalJson,
      pinCheckRunner,
      assertDisposableDatabaseForRepository,
      fingerprintWorkingState,
      maintainerChecksEnvironmentDigest,
      parseMaintainerPolicy,
      runGit,

      resolveCandidateHarnessEngineDigest,
      digest,
      maintainerGrantStorePaths,
      withRepositoryLifecycleOperation,
      openMaintainerCheckJournal,
      runCheck,
      createCheckEnvironmentForRepository,
      appendMaintainerCheckEvidence,
      completeMaintainerCheckJournal,
    } = boundServices;

    if (!preflight.grantable || preflight.classification === 'control-plane') {
      throw workflowError(
        'MAINTAINER_CONTROL_PLANE_GRANT_REQUIRED',
        'Only an ordinary candidate can use maintainer approve-and-apply.',
        ExitCode.guard,
      );
    }
    const initial = discoverRepository(cwd);
    if (initial.head !== preflight.trustBaseCommit) {
      throw workflowError(
        'MAINTAINER_PATCH_STALE_BASE',
        'The repository base moved before pre-approval checks.',
        ExitCode.staleState,
      );
    }
    const refreshed = preflightMaintainerGrantV2(manifestOperations, cwd, {
      profileId: preflight.manifest.profile,
    });
    if (canonicalJson(refreshed) !== canonicalJson(preflight)) {
      throw workflowError(
        'MAINTAINER_CHECK_PREFLIGHT_STALE',
        'The exact candidate no longer matches its preapproval check preflight.',
        ExitCode.staleState,
      );
    }
    const definitions = loadBaseCheckDefinitions(
      initial.repositoryRoot,
      preflight.trustBaseCommit,
      preflight.requiredChecks,
    );
    const pinned = preflight.requiredChecks.map((checkId) => ({
      checkId,
      definition: definitions[checkId]!,
      runner: pinCheckRunner(
        initial.repositoryRoot,
        checkId,
        definitions[checkId]!,
      ),
    }));
    const database = pinned.some(
      ({ definition }) => definition.destructiveDatabase,
    )
      ? assertDisposableDatabaseForRepository(
          initial.repositoryRoot,
          environment,
        )
      : undefined;
    const fingerprint = fingerprintWorkingState(
      initial.repositoryRoot,
      initial.head,
      initial.statusEntries,
    );
    const environmentDigest = maintainerChecksEnvironmentDigest(
      database?.identity ?? null,
    );
    const basePolicy = parseMaintainerPolicy(
      JSON.parse(
        runGit(initial.repositoryRoot, [
          'show',
          `${preflight.trustBaseCommit}:workflow/maintainer-policy.json`,
        ]),
      ),
    );
    const profile = manifestOperations.loadCapabilityProfileFromTrustBase(
      initial.repositoryRoot,
      preflight.trustBaseCommit,
      preflight.manifest.profile,
    );
    const harnessEngineDigest = resolveCandidateHarnessEngineDigest(
      initial,
      basePolicy.repository.id,
      environment,
    );
    const identity: MaintainerCheckJournalIdentity = {
      schemaVersion: 2,
      repositoryId: basePolicy.repository.id,
      repositoryRealPath: initial.repositoryRealPath,
      trustBaseCommit: preflight.trustBaseCommit,
      policyDigest: preflight.policyDigest,
      profileId: preflight.manifest.profile,
      profileVersion: preflight.manifest.profileVersion,
      patchDigest: preflight.patchDigest,
      candidateStateDigest: fingerprint,
      environmentDigest,
      harnessEngineDigest,
      requiredChecks: pinned.map((entry) => ({
        checkId: entry.checkId,
        definitionDigest: digest(canonicalJson(entry.definition)),
        runner: entry.runner.runner,
        runnerDigest: entry.runner.digest,
        destructiveDatabase: entry.definition.destructiveDatabase,
        databaseIdentity: entry.definition.destructiveDatabase
          ? (database?.identity ?? null)
          : null,
        dependsOn: [...preflight.checkDependencies[entry.checkId]!],
        externalSnapshotDigest: externalStateSnapshot(
          entry.checkId,
          preflight.checkDependencies[entry.checkId]!,
          options.externalStateDigests,
        ),
        externalMaxAgeMs: preflight.checkDependencies[entry.checkId]!.includes(
          'external-state',
        )
          ? (profile.externalStateFreshness?.[entry.checkId]?.maxAgeMs ?? null)
          : null,
      })),
    };
    const clock = options.clock ?? (() => new Date());
    const storePaths = maintainerGrantStorePaths(initial.gitCommonDirectory);
    return withRepositoryLifecycleOperation(
      storePaths.runtime,
      (assertOwned) => {
        assertOwned();
        assertCandidateUnchanged(
          initial.repositoryRoot,
          initial.head,
          fingerprint,
        );
        assertHarnessEngineUnchanged(
          initial,
          basePolicy.repository.id,
          environment,
          harnessEngineDigest,
        );
        const opened = openMaintainerCheckJournal(
          initial.gitCommonDirectory,
          identity,
          clock(),
        );
        const journalPath = opened.path;
        let journal = opened.journal;
        if (journal.state === 'completed') {
          const final = journal.finalAttestation!;
          assertExactChecksAttestation(final, identity);
          return final;
        }
        for (const entry of pinned.slice(journal.checks.length)) {
          const startedAt = clock().toISOString();
          const expected = identity.requiredChecks.find(
            ({ checkId }) => checkId === entry.checkId,
          )!;
          let evidenceCompletedAt: Date | undefined;
          const evidence = runCheck(
            initial.repositoryRoot,
            entry.checkId,
            entry.definition,
            entry.runner,
            createCheckEnvironmentForRepository(
              initial.repositoryRoot,
              environment,
              entry.definition.destructiveDatabase,
            ),
            entry.definition.destructiveDatabase
              ? database?.identity
              : undefined,
            expected.externalSnapshotDigest
              ? {
                  completedAt: () => {
                    evidenceCompletedAt = clock();
                    return evidenceCompletedAt;
                  },
                  externalSnapshotDigest: expected.externalSnapshotDigest,
                  maxAgeMs: expected.externalMaxAgeMs!,
                }
              : undefined,
          );
          const completedAt = (evidenceCompletedAt ?? clock()).toISOString();
          assertCandidateUnchanged(
            initial.repositoryRoot,
            initial.head,
            fingerprint,
          );
          assertHarnessEngineUnchanged(
            initial,
            basePolicy.repository.id,
            environment,
            harnessEngineDigest,
          );
          assertOwned();
          journal = appendMaintainerCheckEvidence(
            journalPath,
            journal,
            {
              evidence,
              commandDigest: digest(canonicalJson(entry.definition)),
              startedAt,
              completedAt,
            },
            clock(),
          );
          options.testAfterCheckPersisted?.(entry.checkId);
        }
        const attestation: MaintainerChecksAttestationV2 = {
          schemaVersion: 2,
          trustBaseCommit: identity.trustBaseCommit,
          policyDigest: identity.policyDigest,
          patchDigest: identity.patchDigest,
          candidateStateDigest: identity.candidateStateDigest,
          environmentDigest: identity.environmentDigest,
          harnessEngineDigest,
          checks: journal.checks,
        };
        journal = completeMaintainerCheckJournal(
          journalPath,
          journal,
          attestation,
          clock(),
        );
        const final = journal.finalAttestation!;
        assertExactChecksAttestation(final, identity);
        return final;
      },
    );
  }

  function assertApproveAndApplyPreconditions(
    cwd: string,
    request: ApproveAndApplyMaintainerGrantV2Request,
    preflight: MaintainerGrantV2PreflightResult,
    environment: NodeJS.ProcessEnv,
  ): void {
    const boundServices: MaintainerApplyChecksBindings = bindings();
    const {
      validateCommitSubject,
      workflowError,
      ExitCode,
      validateMaintainerEvidenceWaivers,
      discoverRepository,
      loadStableValidatedChangeContract,
      listConflictingActiveWorkflowSessionIds,
      maintainerGrantStorePaths,
      runGit,
      resolveCommitIdentity,
    } = boundServices;

    validateCommitSubject(request.message);
    if (
      request.reason.length < 12 ||
      request.reason.length > 500 ||
      request.reason.trim() !== request.reason ||
      [...request.reason].some((character) => {
        const point = character.codePointAt(0) ?? 0;
        return point <= 31 || (point >= 127 && point <= 159);
      })
    ) {
      throw workflowError(
        'MAINTAINER_GRANT_INVALID',
        'Maintainer grant reason is invalid.',
        ExitCode.guard,
      );
    }
    validateMaintainerEvidenceWaivers(
      request.evidenceWaivers ?? [],
      preflight.requiredChecks,
      preflight.checkDependencies,
    );
    const repository = discoverRepository(cwd);
    if (repository.head !== preflight.trustBaseCommit || !repository.branch) {
      throw workflowError(
        'AUTHORITY_BRANCH_INVALID',
        'Approve-and-apply requires a named branch at the exact candidate base.',
        ExitCode.staleState,
      );
    }
    const contract = loadStableValidatedChangeContract(
      repository,
      request.changeId,
    ).contract;
    const expectedBranch = contract.config.branchTemplate.replace(
      '{changeId}',
      request.changeId,
    );
    if (repository.branch !== expectedBranch) {
      throw workflowError(
        'AUTHORITY_BRANCH_INVALID',
        `Approve-and-apply requires branch ${expectedBranch}.`,
        ExitCode.staleState,
      );
    }
    const activeSessions = listConflictingActiveWorkflowSessionIds(
      maintainerGrantStorePaths(repository.gitCommonDirectory).runtime,
      {
        changeId: request.changeId,
        repositoryRoot: repository.repositoryRealPath,
        targetRef: `refs/heads/${repository.branch}`,
      },
    );
    if (activeSessions.length > 0) {
      throw workflowError(
        'ACTIVE_SESSION_CONFLICT',
        'Maintainer approve-and-apply conflicts with an active change, workspace, or target ref.',
        ExitCode.conflict,
        { details: { activeSessionIds: activeSessions } },
      );
    }
    const signingFormat = runGit(
      repository.repositoryRoot,
      ['config', '--local', '--get', 'gpg.format'],
      true,
    ).trim();
    const signingKey = runGit(
      repository.repositoryRoot,
      ['config', '--local', '--get', 'user.signingkey'],
      true,
    ).trim();
    if (signingFormat !== 'ssh' || !signingKey) {
      throw workflowError(
        'AUTHORITY_GIT_SIGNING_REQUIRED',
        'Approve-and-apply requires local SSH commit signing configuration before checks or grant signing.',
        ExitCode.unsafeEnvironment,
      );
    }
    resolveCommitIdentity(repository.repositoryRoot, environment);
  }

  function assertCandidateUnchanged(
    repositoryRoot: string,
    head: string,
    expectedFingerprint: string,
  ): void {
    const boundServices: MaintainerApplyChecksBindings = bindings();
    const {
      discoverRepository,
      fingerprintWorkingState,
      workflowError,
      ExitCode,
    } = boundServices;

    const current = discoverRepository(repositoryRoot);
    if (
      current.head !== head ||
      fingerprintWorkingState(
        current.repositoryRoot,
        current.head,
        current.statusEntries,
      ) !== expectedFingerprint
    ) {
      throw workflowError(
        'AUTHORITY_CHECK_MUTATED_WORKTREE',
        'A pre-approval check changed the immutable candidate.',
        ExitCode.staleState,
      );
    }
  }

  function externalStateSnapshot(
    checkId: string,
    dependencies: readonly string[],
    snapshots: Readonly<Record<string, string>> | undefined,
  ): string | null {
    const boundServices: MaintainerApplyChecksBindings = bindings();
    const { workflowError, ExitCode } = boundServices;

    if (!dependencies.includes('external-state')) return null;
    const snapshot = snapshots?.[checkId];
    if (typeof snapshot !== 'string' || !/^[0-9a-f]{64}$/.test(snapshot)) {
      throw workflowError(
        'APPLY_ATTESTATION_EXTERNAL_STATE_REQUIRED',
        `Check ${checkId} requires a trusted current external-state snapshot.`,
        ExitCode.staleState,
      );
    }
    return snapshot;
  }

  function assertHarnessEngineUnchanged(
    repository: ReturnType<typeof discoverRepository>,
    repositoryId: string,
    environment: NodeJS.ProcessEnv,
    expectedDigest: string,
  ): void {
    const boundServices: MaintainerApplyChecksBindings = bindings();
    const { resolveCandidateHarnessEngineDigest, workflowError, ExitCode } =
      boundServices;

    if (
      resolveCandidateHarnessEngineDigest(
        repository,
        repositoryId,
        environment,
      ) !== expectedDigest
    ) {
      throw workflowError(
        'APPLY_ATTESTATION_INVALIDATED',
        'The selected harness engine changed while candidate checks were running.',
        ExitCode.staleState,
      );
    }
  }

  function assertExactChecksAttestation(
    attestation: MaintainerChecksAttestationV2,
    identity: MaintainerCheckJournalIdentity,
  ): asserts attestation is MaintainerChecksAttestationV2 {
    const boundServices: MaintainerApplyChecksBindings = bindings();
    const { workflowError, ExitCode } = boundServices;

    if (
      identity.schemaVersion !== 2 ||
      attestation.schemaVersion !== 2 ||
      attestation.trustBaseCommit !== identity.trustBaseCommit ||
      attestation.policyDigest !== identity.policyDigest ||
      attestation.patchDigest !== identity.patchDigest ||
      attestation.candidateStateDigest !== identity.candidateStateDigest ||
      attestation.environmentDigest !== identity.environmentDigest ||
      attestation.harnessEngineDigest !== identity.harnessEngineDigest ||
      attestation.checks.length !== identity.requiredChecks.length ||
      attestation.checks.some((check, index) => {
        const expected = identity.requiredChecks[index];
        return (
          !expected ||
          check.evidence.checkId !== expected.checkId ||
          check.evidence.runnerDigest !== expected.runnerDigest ||
          check.commandDigest !== expected.definitionDigest
        );
      })
    ) {
      throw workflowError(
        'MAINTAINER_CHECK_JOURNAL_INVALID',
        'The terminal check journal does not match its exact execution identity.',
        ExitCode.staleState,
      );
    }
  }

  function loadBaseCheckDefinitions(
    repositoryRoot: string,
    baseCommit: string,
    requiredChecks: string[],
  ): Record<string, CheckDefinition> {
    const boundServices: MaintainerApplyChecksBindings = bindings();
    const { runGit, workflowError, ExitCode } = boundServices;

    try {
      const raw = JSON.parse(
        runGit(repositoryRoot, ['show', `${baseCommit}:workflow/checks.json`]),
      ) as { schemaVersion?: unknown; checks?: unknown };
      if (
        raw.schemaVersion !== 1 ||
        typeof raw.checks !== 'object' ||
        raw.checks === null ||
        Array.isArray(raw.checks)
      ) {
        throw new Error('invalid base checks');
      }
      const checks = raw.checks as Record<string, unknown>;
      return Object.fromEntries(
        requiredChecks.map((checkId) => {
          const definition = checks[checkId] as
            Partial<CheckDefinition> | undefined;
          if (
            !definition ||
            !Array.isArray(definition.command) ||
            !definition.command.every((part) => typeof part === 'string') ||
            typeof definition.destructiveDatabase !== 'boolean'
          ) {
            throw new Error(`invalid base check ${checkId}`);
          }
          return [
            checkId,
            {
              command: [...definition.command],
              destructiveDatabase: definition.destructiveDatabase,
            },
          ];
        }),
      );
    } catch {
      throw workflowError(
        'AUTHORITY_CHECK_INVALID',
        'Required check definitions are unavailable from the exact grant base.',
        ExitCode.guard,
      );
    }
  }
  return {
    prepareMaintainerGrantV2Checks,
    assertApproveAndApplyPreconditions,
    loadBaseCheckDefinitions,
  };
}

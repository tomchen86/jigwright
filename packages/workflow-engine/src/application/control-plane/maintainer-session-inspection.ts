import type { MaintainerManifestOperations } from '../../modules/authority/maintainer-manifest.ts';
/**
 * Inspects authority sessions and runs checks within their approved scope.
 *
 * Invariants:
 * - Authority checks require changed paths and reject paths outside the
 *   grant.
 */
// maintainer session inspection; repository effects remain bound by the public module.
import type {
  MaintainerSessionInspectionBindings,
  MaintainerSessionInspectionBindingsTypes,
} from './maintainer-session.ts';
type AuthoritySessionOptions =
  MaintainerSessionInspectionBindingsTypes['AuthoritySessionOptions'];
type CheckEvidence = MaintainerSessionInspectionBindingsTypes['CheckEvidence'];
type AuthoritySession =
  MaintainerSessionInspectionBindingsTypes['AuthoritySession'];
type AuthorityPinnedCheck =
  MaintainerSessionInspectionBindingsTypes['AuthorityPinnedCheck'];
type CheckDefinition =
  MaintainerSessionInspectionBindingsTypes['CheckDefinition'];

export function createMaintainerSessionInspection(
  bindings: () => MaintainerSessionInspectionBindings,
) {
  function checkAuthoritySession(
    withAuthorityRefusalAudit: WithAuthorityRefusalAudit,
    grantServices: MaintainerGrantExecutionServices,
    manifestOperations: MaintainerManifestOperations,
    taskMandate: MaintainerTaskMandateOperations,
    cwd: string,
    requestedSessionId: string,
    options: AuthoritySessionOptions = {},
  ): {
    sessionId: string;
    grantId: string;
    changedPaths: string[];
    checks: CheckEvidence[];
    reportId: string;
    passed: true;
  } {
    const boundServices: MaintainerSessionInspectionBindings = bindings();
    const {
      readAuthoritySession,
      authorityError,
      verifiedV2AuthorityLifecycleRefusalBinding,
      authorityRefusalDigest,
      listChangedPaths,

      assertDisposableDatabaseForRepository,
      fingerprintWorkingState,
      runCheck,
      createCheckEnvironmentForRepository,
      discoverRepository,
      maintainerGrantStorePaths,
      writeAuthorityCheckReport,
      exactDate,
      writeAuthoritySession,
      failAuthoritySession,
    } = boundServices;

    const initialSession = readAuthoritySession(cwd, requestedSessionId);
    if (initialSession.state !== 'active') {
      throw authorityError(
        'AUTHORITY_SESSION_NOT_ACTIVE',
        `Authority session ${initialSession.sessionId} is ${initialSession.state}.`,
      );
    }
    try {
      const { git, envelope, contractDigest } = inspectAuthoritySession(
        grantServices,
        manifestOperations,
        taskMandate,
        cwd,
        initialSession,
        options,
      );
      return withAuthorityRefusalAudit(
        verifiedV2AuthorityLifecycleRefusalBinding(
          git.repositoryRealPath,
          envelope,
          {
            operation: 'authority.check',
            subjectId: initialSession.sessionId,
            bindingEvidence: {
              mandateBinding: envelope.payload.mandateBinding,
              session: initialSession,
            },
            refusalIdentity: {
              sessionId: initialSession.sessionId,
              workingStateDigest: authorityRefusalDigest({
                head: git.head,
                statusEntries: git.statusEntries,
              }),
            },
          },
        ),
        {
          now: options.now,
          serviceHooks: options.testRefusalAuditServiceHooks,
        },
        () => {
          const changedPaths = listChangedPaths(git.repositoryRoot, git.head);
          const allowedPaths = envelope.payload.allowedPaths;
          const unexpectedPaths = changedPaths.filter(
            (filePath) => !allowedPaths.includes(filePath),
          );
          if (changedPaths.length === 0 || unexpectedPaths.length > 0) {
            throw authorityError(
              'AUTHORITY_SCOPE_INVALID',
              'Authority check requires at least one change and only exact grant paths.',
              { unexpectedPaths },
            );
          }
          manifestOperations.verifyPatchManifestAgainstWorktree(
            git.repositoryRoot,
            envelope.payload.manifest,
          );
          const database = initialSession.pinnedChecks.some(
            ({ definition }) => definition.destructiveDatabase,
          )
            ? assertDisposableDatabaseForRepository(
                git.repositoryRoot,
                options.environment ?? process.env,
              )
            : undefined;
          const initialFingerprint = fingerprintWorkingState(
            git.repositoryRoot,
            git.head,
            git.statusEntries,
          );
          const checks: CheckEvidence[] = [];
          for (const pinned of initialSession.pinnedChecks) {
            checks.push(
              runCheck(
                git.repositoryRoot,
                pinned.checkId,
                pinned.definition,
                pinned.runner,
                createCheckEnvironmentForRepository(
                  git.repositoryRoot,
                  options.environment ?? process.env,
                  pinned.definition.destructiveDatabase,
                ),
                pinned.definition.destructiveDatabase
                  ? database?.identity
                  : undefined,
              ),
            );
            const current = discoverRepository(git.repositoryRoot);
            if (
              current.head !== git.head ||
              fingerprintWorkingState(
                current.repositoryRoot,
                current.head,
                current.statusEntries,
              ) !== initialFingerprint
            ) {
              throw authorityError(
                'AUTHORITY_CHECK_MUTATED_WORKTREE',
                `Required check ${pinned.checkId} changed the authority checkout.`,
              );
            }
          }
          const paths = maintainerGrantStorePaths(git.gitCommonDirectory);
          const reportId = writeAuthorityCheckReport(paths.runtime.reports, {
            sessionId: initialSession.sessionId,
            changeId: initialSession.changeId,
            grantId: initialSession.grantId,
            baseCommit: initialSession.baseCommit,
            policyBlob: initialSession.policyBlob,
            contractDigest,
            allowedPaths,
            changedPaths,
            requiredChecks: initialSession.requiredChecks,
            checks,
            fingerprint: initialFingerprint,
            createdAt: exactDate(options.now ?? new Date()).toISOString(),
          });
          writeAuthoritySession(
            { ...initialSession, latestCheckReportId: reportId },
            false,
          );
          return {
            sessionId: initialSession.sessionId,
            grantId: envelope.payload.grantId,
            changedPaths,
            checks,
            reportId,
            passed: true,
          };
        },
      );
    } catch (error) {
      // A required check exiting non-zero is a recoverable outcome (often an
      // environmental one: load, battery throttling, transient tooling); the
      // checkout is verified unmutated after every check, so the session stays
      // active and the check run may simply be repeated. Scope violations,
      // mutated worktrees, and session-integrity failures remain terminal.
      if (isRecoverableCheckOutcome(error)) {
        throw error;
      }
      failAuthoritySession(initialSession, error, options.now);
      throw error;
    }
  }

  function isRecoverableCheckOutcome(error: unknown): boolean {
    const code =
      error && typeof error === 'object' && 'code' in error
        ? (error as { code: unknown }).code
        : undefined;
    return code === 'CHECK_FAILED' || code === 'CHECK_TERMINATED';
  }

  function inspectAuthoritySession(
    grantServices: MaintainerGrantExecutionServices,
    manifestOperations: MaintainerManifestOperations,
    taskMandate: MaintainerTaskMandateOperations,
    cwd: string,
    session: AuthoritySession,
    options: AuthoritySessionOptions,
  ) {
    const boundServices: MaintainerSessionInspectionBindings = bindings();
    const {
      discoverRepository,
      authorityError,
      readReservedMaintainerGrant,
      digest,
      canonicalMaintainerGrantV2Envelope,
      loadBasePolicy,
      validateReservedGrantAuthorityBinding,
      exactDate,
      assertExactAuditTag,
      sameRecord,
      pinCheckRunner,
      sameStringArray,
      canonicalJson,
      maintainerChecksEnvironmentDigest,
      assertDisposableDatabaseForRepository,
      assertV2CandidateFresh,
    } = boundServices;

    const git = discoverRepository(cwd);
    if (
      git.repositoryRealPath !== session.repositoryRoot ||
      git.gitCommonDirectory !== session.gitCommonDirectory ||
      git.branch !== session.branch ||
      git.head !== session.baseCommit
    ) {
      throw authorityError(
        'AUTHORITY_BASE_DRIFT',
        'Authority repository, branch, or base changed after start.',
      );
    }
    const reservation = readReservedMaintainerGrant(
      git.gitCommonDirectory,
      session.grantId,
    );
    if (
      reservation.sessionId !== session.sessionId ||
      reservation.repositoryRoot !== session.repositoryRoot ||
      digest(canonicalMaintainerGrantV2Envelope(reservation.envelope)) !==
        session.grantDigest
    ) {
      throw authorityError(
        'AUTHORITY_RESERVATION_MISMATCH',
        'Authority reservation no longer matches the pinned session.',
      );
    }
    const { policy, policyContent, policyBlob } = loadBasePolicy(
      git.repositoryRoot,
      session.baseCommit,
    );
    if (
      policyBlob !== session.policyBlob ||
      digest(policyContent) !== session.policyDigest
    ) {
      throw authorityError(
        'AUTHORITY_POLICY_DRIFT',
        'Pinned maintainer policy changed after authority start.',
      );
    }
    validateReservedGrantAuthorityBinding(
      grantServices,
      manifestOperations,
      taskMandate,
      git.repositoryRoot,
      reservation.envelope,
      policy,
      {
        now: exactDate(options.now ?? new Date()),
        expectedBase: session.baseCommit,
        expectedPolicyBlob: session.policyBlob,
        signer: options.signer,
        assertLifecycleOwned: options.lifecycleAssertOwned,
      },
      git.gitCommonDirectory,
      reservation.envelope.payload.grantId,
    );
    assertExactAuditTag(git.repositoryRoot, reservation.envelope, policy);
    const stable = grantServices.loadStableValidatedChangeContract(
      git,
      session.changeId,
    );
    const allowedPaths = reservation.envelope.payload.allowedPaths;
    const expectedContractArtifacts = Object.fromEntries(
      Object.entries(stable.contract.artifactDigests).filter(
        ([filePath]) => !allowedPaths.includes(filePath),
      ),
    );
    if (!sameRecord(session.contractArtifacts, expectedContractArtifacts)) {
      throw authorityError(
        'AUTHORITY_CONTRACT_DRIFT',
        'Pinned OpenSpec authority changed after start.',
      );
    }
    const expectedBranch = stable.contract.config.branchTemplate.replace(
      '{changeId}',
      session.changeId,
    );
    const expectedRequiredChecks = [
      ...reservation.envelope.payload.requiredChecks,
    ];
    const baseChecks = loadBaseCheckDefinitions(
      git.repositoryRoot,
      session.baseCommit,
      expectedRequiredChecks,
    );
    const pinnedChecksAreExact =
      session.pinnedChecks.length === expectedRequiredChecks.length &&
      session.pinnedChecks.every((pinned, index) => {
        const checkId = expectedRequiredChecks[index];
        const definition = baseChecks[checkId];
        if (
          pinned.checkId !== checkId ||
          JSON.stringify(pinned.definition) !== JSON.stringify(definition)
        ) {
          return false;
        }
        try {
          return (
            JSON.stringify(pinned.runner) ===
            JSON.stringify(
              pinCheckRunner(git.repositoryRoot, checkId, definition),
            )
          );
        } catch {
          return false;
        }
      });
    const expectedCandidate = reservation.envelope.payload.candidateBundle;
    if (
      reservation.envelope.payload.changeId !== session.changeId ||
      reservation.envelope.payload.version !== session.grantVersion ||
      reservation.envelope.payload.signer !== session.signer ||
      git.branch !== expectedBranch ||
      git.tree !== session.baselineTree ||
      !sameStringArray(session.allowedPaths, allowedPaths) ||
      !sameStringArray(session.requiredChecks, expectedRequiredChecks) ||
      session.candidateCommit !==
        (expectedCandidate?.candidateCommit ?? null) ||
      session.resultTree !== (expectedCandidate?.resultTree ?? null) ||
      session.candidateBundleDigest !==
        (expectedCandidate?.candidateBundleDigest ?? null) ||
      canonicalJson(session.mandateBinding) !==
        canonicalJson(reservation.envelope.payload.mandateBinding) ||
      session.expectedRefGeneration !==
        (expectedCandidate?.expectedRefGeneration ?? null) ||
      !pinnedChecksAreExact
    ) {
      throw authorityError(
        'AUTHORITY_SESSION_MISMATCH',
        'Authority session state differs from its signed and base-pinned inputs.',
      );
    }
    const environmentDigest = maintainerChecksEnvironmentDigest(
      session.pinnedChecks.some(
        ({ definition }) => definition.destructiveDatabase,
      )
        ? assertDisposableDatabaseForRepository(
            stable.git.repositoryRoot,
            options.environment ?? process.env,
          ).identity
        : null,
    );
    assertV2CandidateFresh(
      grantServices,
      stable.git.repositoryRoot,
      reservation.envelope,
      exactDate(options.now ?? new Date()),
      environmentDigest,
      options.environment,
      options.externalStateDigests,
    );
    return {
      git: stable.git,
      envelope: reservation.envelope,
      policy,
      contractDigest: session.contractDigest,
    };
  }

  function assertPreapprovalChecksCurrent(
    attestation: NonNullable<
      import('../../modules/authority/maintainer-grant-v2-codec.ts').MaintainerGrantV2Payload['checksAttestation']
    >,
    pinnedChecks: AuthorityPinnedCheck[],
    fingerprint: string,
    environmentDigest: string,
  ): CheckEvidence[] {
    const boundServices: MaintainerSessionInspectionBindings = bindings();
    const { digest, canonicalJson, authorityError } = boundServices;

    const exact =
      attestation.candidateStateDigest === fingerprint &&
      attestation.environmentDigest === environmentDigest &&
      attestation.checks.length === pinnedChecks.length &&
      attestation.checks.every((entry, index) => {
        const pinned = pinnedChecks[index];
        return (
          pinned !== undefined &&
          entry.evidence.checkId === pinned.checkId &&
          entry.evidence.outcome === 'passed' &&
          entry.evidence.exitCode === 0 &&
          entry.evidence.runner === pinned.runner.runner &&
          entry.evidence.runnerDigest === pinned.runner.digest &&
          entry.evidence.destructiveDatabase ===
            pinned.definition.destructiveDatabase &&
          entry.commandDigest === digest(canonicalJson(pinned.definition))
        );
      });
    if (!exact) {
      throw authorityError(
        'AUTHORITY_CHECK_REPORT_STALE',
        'Signed pre-approval checks do not match the immutable candidate.',
      );
    }
    return attestation.checks.map(({ evidence }) => evidence);
  }

  function loadBaseCheckDefinitions(
    repositoryRoot: string,
    baseCommit: string,
    requiredChecks: string[],
  ): Record<string, CheckDefinition> {
    const boundServices: MaintainerSessionInspectionBindings = bindings();
    const { runGit, isPostApprovalAdmissionFailure, authorityError } =
      boundServices;

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
    } catch (error) {
      if (isPostApprovalAdmissionFailure(error)) throw error;
      throw authorityError(
        'AUTHORITY_CHECK_INVALID',
        'Required check definitions are unavailable from the exact grant base.',
      );
    }
  }
  return {
    checkAuthoritySession,
    inspectAuthoritySession,
    assertPreapprovalChecksCurrent,
  };
}

import type { MaintainerTaskMandateOperations } from '../../modules/authority/maintainer-grant-v2.ts';

import type { MaintainerGrantExecutionServices } from './maintainer-grant-v2.ts';

import type { WithAuthorityRefusalAudit } from '../../modules/authority/authority-audit-contract.ts';

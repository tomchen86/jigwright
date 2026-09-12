import type {
  CandidateChecksAttestationV3,
  CandidateExternalEffect,
  CandidateProviderInvocation,
  ImmutableCandidateBundleV2,
} from '../../modules/authority/maintainer-candidate-contracts.ts';
import type { AuthorityApplicationReceiptOperations } from '../../modules/authority/authority-application-receipt.ts';
import type { MaintainerManifestOperations } from '../../modules/authority/maintainer-manifest.ts';
/**
 * Coordinates human approval, application, and revocation of v2 Apply
 * Grants.
 *
 * Invariants:
 * - The published candidate summary must match its frozen digest.
 */
import { createMaintainerApplyChecks } from './maintainer-apply-checks.ts';
import { createMaintainerApplyAudit } from './maintainer-apply-audit.ts';
import { createMaintainerApplyReissue } from './maintainer-apply-reissue.ts';
import crypto from 'node:crypto';

import {
  deriveAuthorityAuditRepositoryId,
  scanAuthorityAuditLedger,
} from '../../runtime/storage-journal/authority-audit-ledger.ts';
import { recordAuthorityAuditEvent } from '../../runtime/storage-journal/authority-audit-service.ts';
import {
  authorityRefusalDigest,
  withAuthorityRefusalAudit,
} from '../../modules/authority/authority-refusal-audit.ts';
import { authorityApplicationReceiptTagRef } from '../../modules/authority/authority-application-receipt.ts';
import {
  pinCheckRunner,
  runCheck,
} from '../../adapters/consumer/repository/work-registry/check-runner.ts';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import type { CheckDefinition } from '../../modules/source/check-command.ts';
import {
  assertDisposableDatabaseForRepository,
  createCheckEnvironmentForRepository,
} from '../../adapters/consumer/repository/work-registry/database-policy.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import {
  armPostApprovalAdmissionDeadline,
  assertPostApprovalAdmissionDeadline,
  createPostApprovalAdmissionDeadline,
  discoverRepository,
  enterPostApprovalTerminalCleanup,
  fingerprintWorkingState,
  isPostApprovalAdmissionFailure,
  runGit,
  withPostApprovalAdmissionDeadline,
  type PostApprovalAdmissionDeadline,
  type PostApprovalBudgetTestOptions,
} from '../../runtime/repository-transaction/git.ts';
import {
  authorityCandidateCommitMessage,
  createSignedAuthorityCandidateCommitObject,
  previewExactStaging,
  resolveCommitIdentity,
  validateCommitSubject,
} from '../../runtime/repository-transaction/git-transitions.ts';
import {
  buildCandidateExternalEffectsManifest,
  buildImmutableCandidateBundleV2,
} from '../../modules/authority/maintainer-candidate-contracts.ts';
import { sealedCandidateDependencySnapshot } from '../../modules/authority/maintainer-candidate-dependencies.ts';
import {
  appendMaintainerCheckEvidence,
  completeMaintainerCheckJournal,
  openMaintainerCheckJournal,
  type MaintainerCheckJournalIdentity,
} from '../../runtime/storage-journal/maintainer-check-journal.ts';
import { commitAuthoritySession } from './maintainer-commit.ts';
import {
  MAINTAINER_GRANT_V2_SIGNATURE_NAMESPACE,
  canonicalMaintainerGrantV2Envelope,
  canonicalMaintainerGrantV2Payload,
  maintainerChecksEnvironmentDigest,
  validateMaintainerEvidenceWaivers,
  type MaintainerChecksAttestationV2,
  type MaintainerEvidenceWaiver,
  type MaintainerGrantV2Envelope,
} from '../../modules/authority/maintainer-grant-v2-codec.ts';
import { type MaintainerGrantV2PreflightResult } from '../../modules/authority/maintainer-grant-v2.ts';

import { parseMaintainerPolicy } from '../../modules/authority/maintainer-policy.ts';
import {
  createInteractiveSshSigner,
  type MaintainerSignerProvider,
} from '../../adapters/signing/ssh/maintainer-signer.ts';
import { startAuthoritySession } from './maintainer-session.ts';
import {
  maintainerGrantStorePaths,
  readMaintainerGrantV2RevocationTargetUnderLifecycleLock,
  readTerminalMaintainerGrant,
  terminallyFailAvailableMaintainerGrantV2UnderLifecycleLock,
  terminallyFailMaintainerReservationUnderLifecycleLock,
  terminallyRevokeAvailableMaintainerGrantV2UnderLifecycleLock,
} from '../../runtime/storage-journal/maintainer-store.ts';
import { listProviderInvocationLifecycleProjections } from '../../runtime/storage-journal/provider-invocation-lifecycle.ts';
import { loadInvestigationRuntimeContext } from '../../composition-root/lifecycle-context.ts';
import { readProviderInvocation } from '../../runtime/storage-journal/provider-invocation-store.ts';
import {
  listConflictingActiveWorkflowSessionIds,
  withRepositoryLifecycleOperation,
} from '../../runtime/session-workspace/session-store.ts';
import { type TaskMandateBinding } from '../../modules/authority/task-mandate-contract.ts';
import { loadStableValidatedChangeContract } from '../../composition-root/validated-contract-context.ts';

export type ApproveAndApplyMaintainerGrantV2Request = {
  changeId: string;
  taskId: string;
  profileId: string;
  reason: string;
  message: string;
  externalEffects: CandidateExternalEffect[];
  evidenceWaivers?: MaintainerEvidenceWaiver[];
  ttlMinutes?: number;
};

export type ApproveAndApplyMaintainerGrantV2Options = {
  now?: Date;
  signer?: MaintainerSignerProvider;
  environment?: NodeJS.ProcessEnv;
  /** Trusted current snapshots for checks that declare external-state. */
  externalStateDigests?: Readonly<Record<string, string>>;
  commitClock?: () => Date;
  testBeforeRefUpdate?: () => void;
  testPoststateVerification?: () => void;
  commitCrashAfter?:
    'index-staged' | 'commit-created' | 'ref-cas' | 'ref-updated';
  testBeforeConsume?: () => void;
  testBeforeAudit?: (eventType: 'cas' | 'grant-consume') => void;
  testBeforeCandidateCommitSigning?: () => void;
  /** Test-only interruption point after the signed grant is durable. */
  testAfterGrantIssued?: (
    grant: import('../../modules/authority/maintainer-grant-v2.ts').MaintainerGrantV2IssueResult,
  ) => void;
  /** Test-only deterministic seam; production always uses the code-owned cap. */
  testPostApprovalBudget?: PostApprovalBudgetTestOptions;
  testRefusalAuditServiceHooks?: AuthorityAuditServiceHooks;
};

export type ReissueAndApplyMaintainerGrantV2Request = {
  priorGrantId: string;
  reason: string;
  evidenceWaivers?: MaintainerEvidenceWaiver[];
  ttlMinutes?: number;
};

export type ReissueAndApplyMaintainerGrantV2Options = Omit<
  ApproveAndApplyMaintainerGrantV2Options,
  'testBeforeCandidateCommitSigning' | 'testAfterGrantIssued'
> & {
  grantId?: string;
};

export type RevokeMaintainerGrantV2Request = {
  grantId: string;
  reason: string;
};

export type RevokeMaintainerGrantV2Options = {
  now?: Date;
  signer?: MaintainerSignerProvider;
  testAfterAudit?: () => void;
  testRefusalAuditServiceHooks?: AuthorityAuditServiceHooks;
};

export type PrepareMaintainerGrantV2ChecksOptions = {
  clock?: () => Date;
  /** Trusted current snapshots for checks that declare external-state. */
  externalStateDigests?: Readonly<Record<string, string>>;
  /** Test-only interruption point after one passed check is durably journaled. */
  testAfterCheckPersisted?: (checkId: string) => void;
};

export function approveAndApplyMaintainerGrantV2(
  grantServices: MaintainerGrantExecutionServices,
  authorityApplicationReceipts: AuthorityApplicationReceiptOperations,
  manifestOperations: MaintainerManifestOperations,
  taskMandate: MaintainerTaskMandateOperations,
  cwd: string,
  request: ApproveAndApplyMaintainerGrantV2Request,
  options: ApproveAndApplyMaintainerGrantV2Options = {},
) {
  const deadline = createPostApprovalAdmissionDeadline(
    options.testPostApprovalBudget,
  );
  return withPostApprovalAdmissionDeadline(deadline, () => {
    const mandateBinding = taskMandate.inspectActiveTaskMandateBinding(
      cwd,
      request.taskId,
      {
        now: options.now,
        signer: options.signer,
      },
    );
    const refusalBinding = applyRefusalBinding(cwd, mandateBinding, request);
    return withAuthorityRefusalAudit(
      refusalBinding,
      {
        now: options.now,
        serviceHooks: options.testRefusalAuditServiceHooks,
      },
      () =>
        approveAndApplyMaintainerGrantV2WithBinding(
          grantServices,
          authorityApplicationReceipts,
          manifestOperations,
          taskMandate,
          cwd,
          request,
          options,
          mandateBinding,
          deadline,
        ),
    );
  });
}

function approveAndApplyMaintainerGrantV2WithBinding(
  grantServices: MaintainerGrantExecutionServices,
  authorityApplicationReceipts: AuthorityApplicationReceiptOperations,
  manifestOperations: MaintainerManifestOperations,
  taskMandate: MaintainerTaskMandateOperations,
  cwd: string,
  request: ApproveAndApplyMaintainerGrantV2Request,
  options: ApproveAndApplyMaintainerGrantV2Options,
  mandateBinding: TaskMandateBinding,
  deadline: PostApprovalAdmissionDeadline,
) {
  assertApplyMandateChange(mandateBinding, request.changeId);
  const effectsManifest = buildCandidateExternalEffectsManifest({
    changeId: request.changeId,
    mandateBinding,
    externalEffects: request.externalEffects,
  });
  const preflight = grantServices.preflightMaintainerGrantV2(
    manifestOperations,
    cwd,
    {
      profileId: request.profileId,
    },
  );
  assertApproveAndApplyPreconditions(
    cwd,
    request,
    preflight,
    options.environment ?? process.env,
  );
  const frozenRepository = discoverRepository(cwd);
  const grantId = crypto.randomUUID();
  const targetRef = `refs/heads/${frozenRepository.branch!}`;
  const refLedger = grantServices.ensureDurableRefGenerationLedger(
    frozenRepository.gitCommonDirectory,
    targetRef,
    frozenRepository.head,
  );
  const prospective = previewExactStaging(
    frozenRepository.repositoryRoot,
    frozenRepository.head,
    preflight.manifest.files.map(({ path: filePath }) => filePath),
  );
  const checksAttestation = prepareMaintainerGrantV2Checks(
    grantServices,
    manifestOperations,
    cwd,
    preflight,
    options.environment ?? process.env,
    { externalStateDigests: options.externalStateDigests },
  );
  // Read from the trust base, never from the candidate: a check's definition
  // is what the repository says it is, and a candidate that could restate its
  // own definition would be grading its own paper.
  const baseDefinitions = loadBaseCheckDefinitions(
    frozenRepository.repositoryRoot,
    preflight.trustBaseCommit,
    preflight.requiredChecks,
  );
  // The commit object's SSH signature is itself a human-authority ceremony.
  // Run every expensive candidate check first so a failing or ungrantable
  // candidate never asks the maintainer to unlock/sign a commit object.
  options.testBeforeCandidateCommitSigning?.();
  const candidateCommit = createSignedAuthorityCandidateCommitObject(
    frozenRepository.repositoryRoot,
    prospective.tree,
    frozenRepository.head,
    request.message,
    request.changeId,
    options.environment,
  );
  const repository = discoverRepository(cwd);
  const policy = parseMaintainerPolicy(
    JSON.parse(
      runGit(repository.repositoryRoot, [
        'show',
        `${preflight.trustBaseCommit}:workflow/maintainer-policy.json`,
      ]),
    ),
  );
  const signer =
    options.signer ??
    createInteractiveSshSigner(repository.repositoryRoot, policy);
  const auditScope = maintainerAuditScope(
    repository.repositoryRealPath,
    policy.repository.id,
    mandateBinding,
  );
  const candidateChecks = checksAttestation.checks.map((check) => {
    const dependencies = [
      ...preflight.checkDependencies[check.evidence.checkId]!,
    ];
    const externalState = dependencies.includes('external-state');
    return {
      checkId: check.evidence.checkId,
      definitionDigest: digest(
        canonicalJson(baseDefinitions[check.evidence.checkId]!),
      ),
      commandDigest: check.commandDigest,
      runnerDigest: check.evidence.runnerDigest,
      environmentDigest: checksAttestation.environmentDigest,
      resultDigest: digest(canonicalJson(check.evidence)),
      outcome: 'passed' as const,
      startedAt: check.startedAt,
      completedAt: check.completedAt,
      reuseClass: externalState
        ? ('external-state' as const)
        : ('toolchain-dependent' as const),
      maxAgeMs: externalState
        ? (check.evidence.maxAgeMs ?? null)
        : 48 * 60 * 60 * 1_000,
      externalSnapshotDigest: check.evidence.externalSnapshotDigest ?? null,
      dependsOn: dependencies,
    };
  });
  const candidateChecksAttestation: CandidateChecksAttestationV3 = {
    schemaVersion: 3,
    candidateTree: prospective.tree,
    patchDigest: preflight.patchDigest,
    trustBaseCommit: preflight.trustBaseCommit,
    dependencySnapshot: sealedCandidateDependencySnapshot({
      candidateTree: prospective.tree,
      baseCommit: preflight.trustBaseCommit,
      harnessEngineDigest: checksAttestation.harnessEngineDigest,
      policyDigest: preflight.policyDigest,
      checks: candidateChecks,
    }),
    checks: candidateChecks,
  };
  const providerInvocations = collectCandidateProviderInvocations(
    cwd,
    request.changeId,
  );
  const supportingArtifacts = grantServices.storeCandidateSupportingArtifacts(
    repository.gitCommonDirectory,
    {
      effectsManifest,
      providerInvocations: {
        schemaVersion: 1,
        kind: 'candidate-provider-invocations.v1',
        changeId: request.changeId,
        mandateBinding,
        invocations: providerInvocations,
      },
      recoveryPlan: {
        schemaVersion: 1,
        kind: 'candidate-recovery-plan.v1',
        changeId: request.changeId,
        mandateBinding,
        targetRef,
        expectedOldCommit: repository.head,
        expectedRefGeneration: refLedger.generation,
        candidateCommit,
        rollbackTarget: repository.head,
      },
    },
  );
  const { bundle: candidateBundle, humanReadableSummary } =
    buildImmutableCandidateBundleV2({
      mandateBinding,
      repositoryId: policy.repository.id,
      targetRef,
      expectedOldCommit: repository.head,
      expectedRefGeneration: refLedger.generation,
      candidateCommit,
      resultTree: prospective.tree,
      commitMessage: `${authorityCandidateCommitMessage(
        request.message,
        request.changeId,
      )}\n`,
      manifest: preflight.manifest,
      checksAttestation: candidateChecksAttestation,
      effectsManifestDigest: supportingArtifacts.effectsManifestDigest,
      providerInvocationsDigest: supportingArtifacts.providerInvocationsDigest,
      classification: preflight.classification,
      recoveryPlanDigest: supportingArtifacts.recoveryPlanDigest,
      createdAt: (options.now ?? new Date()).toISOString(),
    });
  const { humanReadableSummaryDigest } =
    grantServices.storeCandidateHumanReadableSummary(
      repository.gitCommonDirectory,
      humanReadableSummary,
    );
  if (
    humanReadableSummaryDigest !== candidateBundle.humanReadableSummaryDigest
  ) {
    throw workflowError(
      'APPLY_CANDIDATE_STORE_INVALID',
      'The candidate summary publication differs from its frozen digest.',
      ExitCode.guard,
    );
  }
  grantServices.assertStoredCandidateSupportingArtifacts(
    repository.gitCommonDirectory,
    request.changeId,
    candidateBundle,
  );
  const candidateStorePath = grantServices.storeImmutableCandidateBundle(
    repository.gitCommonDirectory,
    candidateBundle,
  );
  appendCandidateBundleAudit(auditScope, candidateBundle, request.changeId);
  const grant = grantServices.issueMaintainerGrantV2(
    manifestOperations,
    taskMandate,
    cwd,
    {
      changeId: request.changeId,
      reason: request.reason,
      manifest: preflight.manifest,
      checksAttestation,
      candidateBundle,
      evidenceWaivers: request.evidenceWaivers ?? [],
      ttlMinutes: request.ttlMinutes,
    },
    {
      now: options.now,
      grantId,
      signer,
      environment: options.environment,
      externalStateDigests: options.externalStateDigests,
      beforeGrantPublication: (envelope) => {
        armPostApprovalAdmissionDeadline(deadline);
        appendApplyGrantAudit(auditScope, envelope);
        assertPostApprovalAdmissionDeadline(deadline);
      },
    },
  );
  withPublishedGrantAdmissionCleanup(
    repository.gitCommonDirectory,
    grant.grantId,
    deadline,
    options.now,
    () => {
      assertPostApprovalAdmissionDeadline(deadline);
      options.testAfterGrantIssued?.(grant);
    },
  );
  // The one command already established human presence while signing the exact
  // candidate. Subsequent session and commit admission may reverify identity
  // and signature but must not ask the maintainer to repeat the same ceremony.
  const confirmedSigner = afterConfirmedPresence(signer);
  const session = withPublishedGrantAdmissionCleanup(
    repository.gitCommonDirectory,
    grant.grantId,
    deadline,
    options.now,
    () =>
      startAuthoritySession(
        grantServices,
        manifestOperations,
        taskMandate,
        cwd,
        request.changeId,
        grant.grantId,
        {
          now: options.now,
          signer: confirmedSigner,
          environment: options.environment,
          externalStateDigests: options.externalStateDigests,
          allowSignedV2Candidate: true,
          postApprovalDeadline: deadline,
        },
      ),
  );
  const committed = commitAuthoritySession(
    grantServices,
    authorityApplicationReceipts,
    manifestOperations,
    taskMandate,
    cwd,
    session.sessionId,
    request.message,
    {
      now: options.now,
      signer: confirmedSigner,
      environment: options.environment,
      externalStateDigests: options.externalStateDigests,
      clock: options.commitClock,
      testBeforeRefUpdate: options.testBeforeRefUpdate,
      testPoststateVerification: options.testPoststateVerification,
      testCrashAfter: options.commitCrashAfter,
      testBeforeConsume: options.testBeforeConsume,
      testBeforeAudit: options.testBeforeAudit,
      postApprovalDeadline: deadline,
    },
  );
  return {
    grantId: grant.grantId,
    sessionId: session.sessionId,
    commitHash: committed.commitHash,
    attestationRelayCommand: committed.attestationRelayCommand,
    tagRef: grant.tagRef,
    publishCommand: grant.publishCommand,
    applicationReceiptTagRef: authorityApplicationReceiptTagRef(
      policy,
      grant.grantId,
    ),
    checksAttestationDigest: grant.envelope.payload.checksAttestationDigest,
    candidateCommit,
    resultTree: prospective.tree,
    candidateBundleDigest: candidateBundle.candidateBundleDigest,
    candidateStorePath,
    evidenceWaivers: grant.envelope.payload.evidenceWaivers,
    applied: true as const,
  };
}

export function revokeMaintainerGrantV2(
  cwd: string,
  request: RevokeMaintainerGrantV2Request,
  options: RevokeMaintainerGrantV2Options = {},
) {
  const reason = assertApplyRevocationReason(request.reason);
  const repository = discoverRepository(cwd);
  const paths = maintainerGrantStorePaths(repository.gitCommonDirectory);
  const initial = withRepositoryLifecycleOperation(
    paths.runtime,
    (assertOwned) =>
      readMaintainerGrantV2RevocationTargetUnderLifecycleLock(
        repository.gitCommonDirectory,
        request.grantId,
        assertOwned,
      ),
    { allowMaintainerGrantId: request.grantId },
  );
  const envelope = initial.envelope;
  const trusted = verifyHistoricalApplyGrantTrust(
    repository,
    envelope,
    options.signer,
    'MAINTAINER_GRANT_REVOCATION_REPOSITORY_MISMATCH',
    'Apply Grant v2 no longer matches this repository identity or trust base.',
  );
  return withAuthorityRefusalAudit(
    applyGrantRefusalBinding(
      repository.repositoryRealPath,
      envelope,
      'maintainer.grant-v2.revoke',
      {
        grantId: request.grantId,
        reasonDigest: authorityRefusalDigest(reason),
      },
    ),
    {
      now: options.now,
      serviceHooks: options.testRefusalAuditServiceHooks,
    },
    () => {
      if (initial.state !== 'available' && initial.state !== 'revoked') {
        throw workflowError(
          'MAINTAINER_GRANT_REVOCATION_STATE_INVALID',
          'Apply Grant v2 revocation only terminalizes an available unused grant.',
          ExitCode.guard,
        );
      }
      const signer = trusted.signer;
      signer.assertHumanPresent();
      const revoker = signer.identity();
      if (
        !trusted.currentPolicy.trustedSigners.some(
          ({ identity }) => identity === revoker,
        )
      ) {
        throw workflowError(
          'MAINTAINER_GRANT_REVOCATION_SIGNER_UNTRUSTED',
          'Apply Grant v2 revocation requires a currently trusted maintainer signer.',
          ExitCode.verification,
        );
      }
      const now = exactRevocationDate(options.now ?? new Date());
      const terminalReason = `Maintainer revoke: ${reason}`;
      return withRepositoryLifecycleOperation(
        paths.runtime,
        (assertOwned) => {
          const current =
            readMaintainerGrantV2RevocationTargetUnderLifecycleLock(
              repository.gitCommonDirectory,
              request.grantId,
              assertOwned,
            );
          if (
            canonicalMaintainerGrantV2Envelope(current.envelope) !==
              canonicalMaintainerGrantV2Envelope(envelope) ||
            (current.state !== 'available' && current.state !== 'revoked') ||
            (current.state === 'revoked' &&
              current.terminalReason !== terminalReason)
          ) {
            throw workflowError(
              'MAINTAINER_GRANT_REVOCATION_STATE_INVALID',
              'Apply Grant v2 state changed before audited revocation.',
              ExitCode.staleState,
            );
          }
          const audit = appendApplyGrantRevocationAudit(
            repository.repositoryRealPath,
            current.envelope,
            revoker,
            reason,
            current.state === 'revoked'
              ? exactRevocationDate(current.terminalRecordedAt!)
              : now,
          );
          options.testAfterAudit?.();
          const grant =
            terminallyRevokeAvailableMaintainerGrantV2UnderLifecycleLock(
              repository.gitCommonDirectory,
              request.grantId,
              terminalReason,
              now,
              assertOwned,
            );
          return {
            grantId: grant.grantId,
            state: 'revoked' as const,
            taskId: current.envelope.payload.taskId,
            changeId: current.envelope.payload.changeId,
            replayed: current.state === 'revoked',
            audit,
          };
        },
        { allowMaintainerGrantId: request.grantId },
      );
    },
  );
}

function withPublishedGrantAdmissionCleanup<T>(
  gitCommonDirectory: string,
  grantId: string,
  deadline: PostApprovalAdmissionDeadline,
  now: Date | undefined,
  operation: () => T,
): T {
  try {
    return operation();
  } catch (error) {
    if (!isPostApprovalAdmissionFailure(error)) throw error;
    enterPostApprovalTerminalCleanup(deadline);
    const reason =
      error instanceof Error
        ? error.message
        : 'Post-approval admission timed out before CAS.';
    withRepositoryLifecycleOperation(
      maintainerGrantStorePaths(gitCommonDirectory).runtime,
      (assertOwned) => {
        const current = readMaintainerGrantV2RevocationTargetUnderLifecycleLock(
          gitCommonDirectory,
          grantId,
          assertOwned,
        );
        if (current.state === 'available') {
          terminallyFailAvailableMaintainerGrantV2UnderLifecycleLock(
            gitCommonDirectory,
            grantId,
            reason,
            now ?? new Date(),
            assertOwned,
          );
        } else if (current.state === 'reserved' && current.sessionId !== null) {
          terminallyFailMaintainerReservationUnderLifecycleLock(
            gitCommonDirectory,
            grantId,
            current.sessionId,
            reason,
            now ?? new Date(),
          );
        }
      },
      { allowMaintainerGrantId: grantId },
    );
    throw error;
  }
}

function assertApplyMandateChange(
  binding: TaskMandateBinding,
  changeId: string,
): void {
  if (binding.changeId !== changeId) {
    throw workflowError(
      'APPLY_TASK_MANDATE_CHANGE_MISMATCH',
      'Approve-and-apply requires a Task Mandate for the exact change.',
      ExitCode.guard,
    );
  }
}

function afterConfirmedPresence(
  signer: MaintainerSignerProvider,
): MaintainerSignerProvider {
  return {
    assertHumanPresent() {},
    identity: () => signer.identity(),
    sign: (payload, namespace) => signer.sign(payload, namespace),
    verify: (payload, signature, identity, namespace) =>
      signer.verify(payload, signature, identity, namespace),
  };
}

function assertApplyRevocationReason(value: string): string {
  if (
    typeof value !== 'string' ||
    value.length < 12 ||
    value.length > 500 ||
    value.trim() !== value ||
    [...value].some((character) => {
      const point = character.codePointAt(0) ?? 0;
      return point <= 31 || (point >= 127 && point <= 159);
    })
  ) {
    throw workflowError(
      'MAINTAINER_GRANT_REVOCATION_REASON_INVALID',
      'Apply Grant v2 revocation requires an exact human-readable reason.',
      ExitCode.guard,
    );
  }
  return value;
}

function exactRevocationDate(value: Date | string): Date {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw workflowError(
      'MAINTAINER_GRANT_REVOCATION_TIME_INVALID',
      'Apply Grant v2 revocation requires an exact timestamp.',
      ExitCode.guard,
    );
  }
  return date;
}

function digest(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export type MaintainerApplyChecksBindings = {
  workflowError: typeof workflowError;
  ExitCode: typeof ExitCode;
  discoverRepository: typeof discoverRepository;

  canonicalJson: typeof canonicalJson;
  pinCheckRunner: typeof pinCheckRunner;
  assertDisposableDatabaseForRepository: typeof assertDisposableDatabaseForRepository;
  fingerprintWorkingState: typeof fingerprintWorkingState;
  maintainerChecksEnvironmentDigest: typeof maintainerChecksEnvironmentDigest;
  parseMaintainerPolicy: typeof parseMaintainerPolicy;
  runGit: typeof runGit;

  digest: typeof digest;
  maintainerGrantStorePaths: typeof maintainerGrantStorePaths;
  withRepositoryLifecycleOperation: typeof withRepositoryLifecycleOperation;
  openMaintainerCheckJournal: typeof openMaintainerCheckJournal;
  runCheck: typeof runCheck;
  createCheckEnvironmentForRepository: typeof createCheckEnvironmentForRepository;
  appendMaintainerCheckEvidence: typeof appendMaintainerCheckEvidence;
  completeMaintainerCheckJournal: typeof completeMaintainerCheckJournal;
  validateCommitSubject: typeof validateCommitSubject;
  validateMaintainerEvidenceWaivers: typeof validateMaintainerEvidenceWaivers;
  loadStableValidatedChangeContract: typeof loadStableValidatedChangeContract;
  listConflictingActiveWorkflowSessionIds: typeof listConflictingActiveWorkflowSessionIds;
  resolveCommitIdentity: typeof resolveCommitIdentity;
};
export type MaintainerApplyChecksBindingsTypes = {
  MaintainerGrantV2PreflightResult: MaintainerGrantV2PreflightResult;
  PrepareMaintainerGrantV2ChecksOptions: PrepareMaintainerGrantV2ChecksOptions;
  MaintainerChecksAttestationV2: MaintainerChecksAttestationV2;
  MaintainerCheckJournalIdentity: MaintainerCheckJournalIdentity;
  ApproveAndApplyMaintainerGrantV2Request: ApproveAndApplyMaintainerGrantV2Request;
  CheckDefinition: CheckDefinition;
  discoverRepository: typeof discoverRepository;
};

const {
  prepareMaintainerGrantV2Checks,
  assertApproveAndApplyPreconditions,
  loadBaseCheckDefinitions,
} = createMaintainerApplyChecks(() => ({
  workflowError,
  ExitCode,
  discoverRepository,

  canonicalJson,
  pinCheckRunner,
  assertDisposableDatabaseForRepository,
  fingerprintWorkingState,
  maintainerChecksEnvironmentDigest,
  parseMaintainerPolicy,
  runGit,

  digest,
  maintainerGrantStorePaths,
  withRepositoryLifecycleOperation,
  openMaintainerCheckJournal,
  runCheck,
  createCheckEnvironmentForRepository,
  appendMaintainerCheckEvidence,
  completeMaintainerCheckJournal,
  validateCommitSubject,
  validateMaintainerEvidenceWaivers,
  loadStableValidatedChangeContract,
  listConflictingActiveWorkflowSessionIds,
  resolveCommitIdentity,
}));
export { prepareMaintainerGrantV2Checks };

export type MaintainerApplyAuditBindings = {
  loadInvestigationRuntimeContext: typeof loadInvestigationRuntimeContext;
  listProviderInvocationLifecycleProjections: typeof listProviderInvocationLifecycleProjections;
  readProviderInvocation: typeof readProviderInvocation;
  digest: typeof digest;
  canonicalJson: typeof canonicalJson;
  deriveAuthorityAuditRepositoryId: typeof deriveAuthorityAuditRepositoryId;
  discoverRepository: typeof discoverRepository;
  parseMaintainerPolicy: typeof parseMaintainerPolicy;
  runGit: typeof runGit;
  authorityRefusalDigest: typeof authorityRefusalDigest;
  canonicalMaintainerGrantV2Envelope: typeof canonicalMaintainerGrantV2Envelope;
  recordAuthorityAuditEvent: typeof recordAuthorityAuditEvent;
  workflowError: typeof workflowError;
  ExitCode: typeof ExitCode;
  scanAuthorityAuditLedger: typeof scanAuthorityAuditLedger;
  crypto: typeof crypto;
};
export type MaintainerApplyAuditBindingsTypes = {
  CandidateProviderInvocation: CandidateProviderInvocation;
  TaskMandateBinding: TaskMandateBinding;
  AuthorityAuditLedgerScope: AuthorityAuditLedgerScope;
  ApproveAndApplyMaintainerGrantV2Request: ApproveAndApplyMaintainerGrantV2Request;
  AuthorityRefusalAuditBinding: AuthorityRefusalAuditBinding;
  MaintainerGrantV2Envelope: MaintainerGrantV2Envelope;
  ImmutableCandidateBundleV2: ImmutableCandidateBundleV2;
  Sha256Digest: Sha256Digest;
};

const {
  collectCandidateProviderInvocations,
  maintainerAuditScope,
  applyRefusalBinding,
  applyGrantRefusalBinding,
  appendCandidateBundleAudit,
  appendApplyGrantAudit,
  appendApplyGrantRevocationAudit,
} = createMaintainerApplyAudit(() => ({
  loadInvestigationRuntimeContext,
  listProviderInvocationLifecycleProjections,
  readProviderInvocation,
  digest,
  canonicalJson,
  deriveAuthorityAuditRepositoryId,
  discoverRepository,
  parseMaintainerPolicy,
  runGit,
  authorityRefusalDigest,
  canonicalMaintainerGrantV2Envelope,
  recordAuthorityAuditEvent,
  workflowError,
  ExitCode,
  scanAuthorityAuditLedger,
  crypto,
}));

export type MaintainerApplyReissueBindings = {
  createPostApprovalAdmissionDeadline: typeof createPostApprovalAdmissionDeadline;
  withPostApprovalAdmissionDeadline: typeof withPostApprovalAdmissionDeadline;
  discoverRepository: typeof discoverRepository;
  readTerminalMaintainerGrant: typeof readTerminalMaintainerGrant;
  withAuthorityRefusalAudit: typeof withAuthorityRefusalAudit;
  applyGrantRefusalBinding: typeof applyGrantRefusalBinding;
  authorityRefusalDigest: typeof authorityRefusalDigest;
  workflowError: typeof workflowError;
  ExitCode: typeof ExitCode;
  authorityCandidateCommitMessage: typeof authorityCandidateCommitMessage;

  armPostApprovalAdmissionDeadline: typeof armPostApprovalAdmissionDeadline;
  appendApplyGrantAudit: typeof appendApplyGrantAudit;
  assertPostApprovalAdmissionDeadline: typeof assertPostApprovalAdmissionDeadline;
  withPublishedGrantAdmissionCleanup: typeof withPublishedGrantAdmissionCleanup;
  afterConfirmedPresence: typeof afterConfirmedPresence;
  startAuthoritySession: typeof startAuthoritySession;
  commitAuthoritySession: typeof commitAuthoritySession;
  authorityApplicationReceiptTagRef: typeof authorityApplicationReceiptTagRef;
  parseMaintainerPolicy: typeof parseMaintainerPolicy;
  runGit: typeof runGit;
  createInteractiveSshSigner: typeof createInteractiveSshSigner;
  canonicalMaintainerGrantV2Payload: typeof canonicalMaintainerGrantV2Payload;
  MAINTAINER_GRANT_V2_SIGNATURE_NAMESPACE: typeof MAINTAINER_GRANT_V2_SIGNATURE_NAMESPACE;
  maintainerAuditScope: typeof maintainerAuditScope;
  scanAuthorityAuditLedger: typeof scanAuthorityAuditLedger;
};
export type MaintainerApplyReissueBindingsTypes = {
  ReissueAndApplyMaintainerGrantV2Request: ReissueAndApplyMaintainerGrantV2Request;
  ReissueAndApplyMaintainerGrantV2Options: ReissueAndApplyMaintainerGrantV2Options;
  PostApprovalAdmissionDeadline: PostApprovalAdmissionDeadline;
  MaintainerGrantV2Envelope: MaintainerGrantV2Envelope;
  MaintainerSignerProvider: MaintainerSignerProvider;
  discoverRepository: typeof discoverRepository;
};

const { reissueAndApplyMaintainerGrantV2, verifyHistoricalApplyGrantTrust } =
  createMaintainerApplyReissue(() => ({
    createPostApprovalAdmissionDeadline,
    withPostApprovalAdmissionDeadline,
    discoverRepository,
    readTerminalMaintainerGrant,
    withAuthorityRefusalAudit,
    applyGrantRefusalBinding,
    authorityRefusalDigest,
    workflowError,
    ExitCode,
    authorityCandidateCommitMessage,

    armPostApprovalAdmissionDeadline,
    appendApplyGrantAudit,
    assertPostApprovalAdmissionDeadline,
    withPublishedGrantAdmissionCleanup,
    afterConfirmedPresence,
    startAuthoritySession,
    commitAuthoritySession,
    authorityApplicationReceiptTagRef,
    parseMaintainerPolicy,
    runGit,
    createInteractiveSshSigner,
    canonicalMaintainerGrantV2Payload,
    MAINTAINER_GRANT_V2_SIGNATURE_NAMESPACE,
    maintainerAuditScope,
    scanAuthorityAuditLedger,
  }));
export { reissueAndApplyMaintainerGrantV2 };

import {
  type AuthorityAuditLedgerScope,
  type Sha256Digest,
  type AuthorityAuditServiceHooks,
  type AuthorityRefusalAuditBinding,
} from '../../modules/authority/authority-audit-contract.ts';

import type { MaintainerTaskMandateOperations } from '../../modules/authority/maintainer-grant-v2.ts';

import type { MaintainerGrantExecutionServices } from './maintainer-grant-v2.ts';

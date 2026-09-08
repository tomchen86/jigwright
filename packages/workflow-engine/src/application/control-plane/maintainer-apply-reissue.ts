// maintainer apply reissue; repository effects remain bound by the public module.
import type {
  MaintainerApplyReissueBindings,
  MaintainerApplyReissueBindingsTypes,
} from './maintainer-approve.ts';
type ReissueAndApplyMaintainerGrantV2Request =
  MaintainerApplyReissueBindingsTypes['ReissueAndApplyMaintainerGrantV2Request'];
type ReissueAndApplyMaintainerGrantV2Options =
  MaintainerApplyReissueBindingsTypes['ReissueAndApplyMaintainerGrantV2Options'];
type PostApprovalAdmissionDeadline =
  MaintainerApplyReissueBindingsTypes['PostApprovalAdmissionDeadline'];
type MaintainerGrantV2Envelope =
  MaintainerApplyReissueBindingsTypes['MaintainerGrantV2Envelope'];
type MaintainerSignerProvider =
  MaintainerApplyReissueBindingsTypes['MaintainerSignerProvider'];
declare const discoverRepository: MaintainerApplyReissueBindings['discoverRepository'];

export function createMaintainerApplyReissue(
  bindings: () => MaintainerApplyReissueBindings,
) {
  function reissueAndApplyMaintainerGrantV2(
    cwd: string,
    request: ReissueAndApplyMaintainerGrantV2Request,
    options: ReissueAndApplyMaintainerGrantV2Options = {},
  ) {
    const boundServices: MaintainerApplyReissueBindings = bindings();
    const {
      createPostApprovalAdmissionDeadline,
      withPostApprovalAdmissionDeadline,
    } = boundServices;

    const deadline = createPostApprovalAdmissionDeadline(
      options.testPostApprovalBudget,
    );
    return withPostApprovalAdmissionDeadline(deadline, () =>
      reissueAndApplyMaintainerGrantV2WithDeadline(
        cwd,
        request,
        options,
        deadline,
      ),
    );
  }

  function reissueAndApplyMaintainerGrantV2WithDeadline(
    cwd: string,
    request: ReissueAndApplyMaintainerGrantV2Request,
    options: ReissueAndApplyMaintainerGrantV2Options,
    deadline: PostApprovalAdmissionDeadline,
  ) {
    const boundServices: MaintainerApplyReissueBindings = bindings();
    const {
      discoverRepository,
      readTerminalMaintainerGrant,
      withAuthorityRefusalAudit,
      applyGrantRefusalBinding,
      authorityRefusalDigest,
      workflowError,
      ExitCode,
      authorityCandidateCommitMessage,
      issueMaintainerGrantV2,
      armPostApprovalAdmissionDeadline,
      appendApplyGrantAudit,
      assertPostApprovalAdmissionDeadline,
      withPublishedGrantAdmissionCleanup,
      afterConfirmedPresence,
      startAuthoritySession,
      commitAuthoritySession,
      authorityApplicationReceiptTagRef,
    } = boundServices;

    const repository = discoverRepository(cwd);
    const prior = readTerminalMaintainerGrant(
      repository.gitCommonDirectory,
      request.priorGrantId,
    );
    const envelope = prior.envelope;
    const trusted = verifyHistoricalApplyGrantTrust(
      repository,
      envelope,
      options.signer,
      'MAINTAINER_GRANT_REISSUE_REPOSITORY_MISMATCH',
      'Retained Apply Grant v2 no longer matches this repository identity or trust base.',
    );
    return withAuthorityRefusalAudit(
      applyGrantRefusalBinding(
        repository.repositoryRealPath,
        envelope,
        'maintainer.reissue-and-apply',
        {
          priorGrantId: request.priorGrantId,
          reasonDigest: authorityRefusalDigest(request.reason),
          ttlMinutes: request.ttlMinutes ?? null,
          requestedGrantId: options.grantId ?? null,
          evidenceWaiversDigest: authorityRefusalDigest(
            request.evidenceWaivers === undefined
              ? { declaration: 'preserve-prior' }
              : request.evidenceWaivers,
          ),
        },
      ),
      {
        now: options.now,
        serviceHooks: options.testRefusalAuditServiceHooks,
      },
      () => {
        if (!['expired', 'invalidated'].includes(prior.state)) {
          throw workflowError(
            'MAINTAINER_GRANT_REISSUE_INVALID',
            'Only an expired or invalidated v2 grant may reissue its retained candidate.',
            ExitCode.guard,
          );
        }
        const payload = envelope.payload;
        const evidenceWaivers =
          request.evidenceWaivers === undefined
            ? payload.evidenceWaivers
            : request.evidenceWaivers;
        const candidate = payload.candidateBundle;
        if (
          candidate === null ||
          payload.checksAttestation === null ||
          payload.checksAttestation.schemaVersion !== 2
        ) {
          throw workflowError(
            'MAINTAINER_GRANT_REISSUE_INVALID',
            'The prior grant does not retain a complete immutable candidate and checks attestation.',
            ExitCode.guard,
          );
        }
        const subject = candidate.commitMessage.split('\n', 1)[0] ?? '';
        if (
          candidate.commitMessage !==
          `${authorityCandidateCommitMessage(subject, payload.changeId)}\n`
        ) {
          throw workflowError(
            'AUTHORITY_CANDIDATE_BINDING_INVALID',
            'The retained candidate does not use the grant-independent v2 commit identity.',
            ExitCode.guard,
          );
        }
        const signer = trusted.signer;
        if (signer.identity() !== payload.signer) {
          throw workflowError(
            'AUTHORITY_CANDIDATE_SIGNER_MISMATCH',
            'Candidate reissue requires the signer that created the retained candidate commit.',
            ExitCode.guard,
          );
        }
        const grant = issueMaintainerGrantV2(
          cwd,
          {
            changeId: payload.changeId,
            reason: request.reason,
            manifest: payload.manifest,
            ttlMinutes: request.ttlMinutes,
            checksAttestation: payload.checksAttestation,
            candidateBundle: candidate,
            evidenceWaivers,
          },
          {
            now: options.now,
            grantId: options.grantId,
            signer,
            environment: options.environment,
            externalStateDigests: options.externalStateDigests,
            beforeGrantPublication: (issuedEnvelope) => {
              armPostApprovalAdmissionDeadline(deadline);
              appendApplyGrantAudit(trusted.auditScope, issuedEnvelope);
              assertPostApprovalAdmissionDeadline(deadline);
            },
          },
        );
        withPublishedGrantAdmissionCleanup(
          repository.gitCommonDirectory,
          grant.grantId,
          deadline,
          options.now,
          () => assertPostApprovalAdmissionDeadline(deadline),
        );
        const confirmedSigner = afterConfirmedPresence(signer);
        const session = withPublishedGrantAdmissionCleanup(
          repository.gitCommonDirectory,
          grant.grantId,
          deadline,
          options.now,
          () =>
            startAuthoritySession(cwd, payload.changeId, grant.grantId, {
              now: options.now,
              signer: confirmedSigner,
              environment: options.environment,
              externalStateDigests: options.externalStateDigests,
              allowSignedV2Candidate: true,
              postApprovalDeadline: deadline,
            }),
        );
        const committed = commitAuthoritySession(
          cwd,
          session.sessionId,
          subject,
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
          reissuedFromGrantId: payload.grantId,
          grantId: grant.grantId,
          sessionId: session.sessionId,
          commitHash: committed.commitHash,
          journalState: committed.journalState,
          attestationRelayCommand: committed.attestationRelayCommand,
          tagRef: grant.tagRef,
          publishCommand: grant.publishCommand,
          applicationReceiptTagRef: authorityApplicationReceiptTagRef(
            trusted.basePolicy,
            grant.grantId,
          ),
          checksAttestationDigest:
            grant.envelope.payload.checksAttestationDigest,
          candidateCommit: candidate.candidateCommit,
          resultTree: candidate.resultTree,
          candidateBundleDigest: candidate.candidateBundleDigest,
          evidenceWaivers: grant.envelope.payload.evidenceWaivers,
          applied: true as const,
        };
      },
    );
  }

  function verifyHistoricalApplyGrantTrust(
    repository: ReturnType<typeof discoverRepository>,
    envelope: MaintainerGrantV2Envelope,
    providedSigner: MaintainerSignerProvider | undefined,
    repositoryMismatchCode: string,
    repositoryMismatchMessage: string,
  ) {
    const boundServices: MaintainerApplyReissueBindings = bindings();
    const {
      parseMaintainerPolicy,
      runGit,
      createInteractiveSshSigner,
      canonicalMaintainerGrantV2Payload,
      MAINTAINER_GRANT_V2_SIGNATURE_NAMESPACE,
      workflowError,
      ExitCode,
      maintainerAuditScope,
      scanAuthorityAuditLedger,
    } = boundServices;

    const basePolicy = parseMaintainerPolicy(
      JSON.parse(
        runGit(repository.repositoryRoot, [
          'show',
          `${envelope.payload.baseCommit}:workflow/maintainer-policy.json`,
        ]),
      ),
    );
    const currentPolicy = parseMaintainerPolicy(
      JSON.parse(
        runGit(repository.repositoryRoot, [
          'show',
          'HEAD:workflow/maintainer-policy.json',
        ]),
      ),
    );
    const signer =
      providedSigner ??
      createInteractiveSshSigner(repository.repositoryRoot, currentPolicy);
    try {
      signer.verify(
        canonicalMaintainerGrantV2Payload(envelope.payload),
        envelope.signature,
        envelope.payload.signer,
        MAINTAINER_GRANT_V2_SIGNATURE_NAMESPACE,
      );
    } catch {
      throw workflowError(
        'AUTHORITY_SIGNATURE_INVALID',
        'Apply Grant v2 historical authority binding requires a valid original grant signature.',
        ExitCode.verification,
      );
    }
    const origin = runGit(
      repository.repositoryRoot,
      ['remote', 'get-url', 'origin'],
      true,
    ).trim();
    if (
      basePolicy.repository.id !== envelope.payload.repositoryId ||
      basePolicy.repository.origin !== envelope.payload.repositoryOrigin ||
      currentPolicy.repository.id !== envelope.payload.repositoryId ||
      currentPolicy.repository.origin !== envelope.payload.repositoryOrigin ||
      origin !== envelope.payload.repositoryOrigin ||
      !basePolicy.trustedSigners.some(
        ({ identity }) => identity === envelope.payload.signer,
      )
    ) {
      throw workflowError(
        repositoryMismatchCode,
        repositoryMismatchMessage,
        ExitCode.staleState,
      );
    }
    const auditScope = maintainerAuditScope(
      repository.repositoryRealPath,
      envelope.payload.repositoryId,
      envelope.payload.mandateBinding,
    );
    scanAuthorityAuditLedger(auditScope);
    return { auditScope, basePolicy, currentPolicy, signer };
  }
  return { reissueAndApplyMaintainerGrantV2, verifyHistoricalApplyGrantTrust };
}

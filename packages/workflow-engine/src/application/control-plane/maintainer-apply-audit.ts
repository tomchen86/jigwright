/**
 * Builds audit bindings and records candidate and Apply Grant events.
 *
 * Invariants:
 * - Apply Grant audit requires its exact immutable candidate.
 */
// maintainer apply audit; repository effects remain bound by the public module.
import type {
  MaintainerApplyAuditBindings,
  MaintainerApplyAuditBindingsTypes,
} from './maintainer-approve.ts';
type CandidateProviderInvocation =
  MaintainerApplyAuditBindingsTypes['CandidateProviderInvocation'];
type TaskMandateBinding =
  MaintainerApplyAuditBindingsTypes['TaskMandateBinding'];
type AuthorityAuditLedgerScope =
  MaintainerApplyAuditBindingsTypes['AuthorityAuditLedgerScope'];
type ApproveAndApplyMaintainerGrantV2Request =
  MaintainerApplyAuditBindingsTypes['ApproveAndApplyMaintainerGrantV2Request'];
type AuthorityRefusalAuditBinding =
  MaintainerApplyAuditBindingsTypes['AuthorityRefusalAuditBinding'];
type MaintainerGrantV2Envelope =
  MaintainerApplyAuditBindingsTypes['MaintainerGrantV2Envelope'];
type ImmutableCandidateBundleV2 =
  MaintainerApplyAuditBindingsTypes['ImmutableCandidateBundleV2'];
type Sha256Digest = MaintainerApplyAuditBindingsTypes['Sha256Digest'];

export function createMaintainerApplyAudit(
  bindings: () => MaintainerApplyAuditBindings,
) {
  function collectCandidateProviderInvocations(
    cwd: string,
    changeId: string,
  ): CandidateProviderInvocation[] {
    const boundServices: MaintainerApplyAuditBindings = bindings();
    const {
      loadInvestigationRuntimeContext,
      listProviderInvocationLifecycleProjections,
      readProviderInvocation,
      digest,
      canonicalJson,
    } = boundServices;

    const runtime = loadInvestigationRuntimeContext(cwd).runtime;
    return listProviderInvocationLifecycleProjections(runtime)
      .filter((projection) => projection.changeId === changeId)
      .map((projection): CandidateProviderInvocation => {
        const record = readProviderInvocation(runtime, projection.invocationId);
        return {
          invocationId: projection.invocationId,
          investigationId: projection.investigationId,
          purpose: projection.purpose,
          attempt: projection.attempt,
          state: projection.state,
          requestDigest: projection.requestDigest,
          manifestDigest: projection.manifestDigest,
          outputDigest: record.result?.outputDigest ?? null,
          failureDigest:
            record.failure === null
              ? null
              : digest(canonicalJson(record.failure)),
        };
      })
      .sort((left, right) =>
        canonicalJson(left).localeCompare(canonicalJson(right)),
      );
  }

  function maintainerAuditScope(
    repositoryRoot: string,
    repositoryIdentity: string,
    mandateBinding: TaskMandateBinding,
  ): AuthorityAuditLedgerScope {
    const boundServices: MaintainerApplyAuditBindings = bindings();
    const { deriveAuthorityAuditRepositoryId } = boundServices;

    return {
      externalAuditRoot: mandateBinding.externalAuditRoot,
      repositoryRoot,
      repositoryId: deriveAuthorityAuditRepositoryId(repositoryIdentity),
    };
  }

  function applyRefusalBinding(
    cwd: string,
    mandateBinding: TaskMandateBinding,
    request: ApproveAndApplyMaintainerGrantV2Request,
  ): AuthorityRefusalAuditBinding {
    const boundServices: MaintainerApplyAuditBindings = bindings();
    const {
      discoverRepository,
      parseMaintainerPolicy,
      runGit,
      authorityRefusalDigest,
    } = boundServices;

    const repository = discoverRepository(cwd);
    const policy = parseMaintainerPolicy(
      JSON.parse(
        runGit(repository.repositoryRoot, [
          'show',
          `${repository.head}:workflow/maintainer-policy.json`,
        ]),
      ),
    );
    const bindingDigest = authorityRefusalDigest(mandateBinding);
    return {
      scope: maintainerAuditScope(
        repository.repositoryRealPath,
        policy.repository.id,
        mandateBinding,
      ),
      family: 'apply',
      operation: 'maintainer.approve-and-apply',
      subjectId: `${request.changeId}:${request.taskId}`,
      actor: { kind: 'engine', identity: 'workflow-engine' },
      taskId: mandateBinding.mandateTaskId,
      changeId: mandateBinding.changeId,
      workflowId: mandateBinding.mandateId,
      grantDigest: null,
      bindingDigest,
      refusalIdentity: {
        changeId: request.changeId,
        taskId: request.taskId,
        profileId: request.profileId,
        reasonDigest: authorityRefusalDigest(request.reason),
        messageDigest: authorityRefusalDigest(request.message),
        externalEffectsDigest: authorityRefusalDigest(
          request.externalEffects === undefined
            ? { declaration: 'missing' }
            : request.externalEffects,
        ),
        evidenceWaiversDigest: authorityRefusalDigest(
          request.evidenceWaivers === undefined
            ? { declaration: 'missing' }
            : request.evidenceWaivers,
        ),
      },
    };
  }

  function applyGrantRefusalBinding(
    repositoryRoot: string,
    envelope: MaintainerGrantV2Envelope,
    operation: string,
    refusalIdentity: Readonly<Record<string, unknown>>,
  ): AuthorityRefusalAuditBinding {
    const boundServices: MaintainerApplyAuditBindings = bindings();
    const { canonicalMaintainerGrantV2Envelope, authorityRefusalDigest } =
      boundServices;

    const mandateBinding = envelope.payload.mandateBinding;
    return {
      scope: maintainerAuditScope(
        repositoryRoot,
        envelope.payload.repositoryId,
        mandateBinding,
      ),
      family: 'apply',
      operation,
      subjectId: envelope.payload.grantId,
      actor: { kind: 'engine', identity: 'workflow-engine' },
      taskId: mandateBinding.mandateTaskId,
      changeId: mandateBinding.changeId,
      workflowId: mandateBinding.mandateId,
      grantDigest: auditBytesDigest(
        canonicalMaintainerGrantV2Envelope(envelope),
      ),
      candidateBundleDigest:
        envelope.payload.candidateBundle === null
          ? null
          : prefixedDigest(
              envelope.payload.candidateBundle.candidateBundleDigest,
            ),
      bindingDigest: authorityRefusalDigest(mandateBinding),
      refusalIdentity,
    };
  }

  function appendCandidateBundleAudit(
    scope: AuthorityAuditLedgerScope,
    candidate: ImmutableCandidateBundleV2,
    changeId: string,
  ): void {
    const boundServices: MaintainerApplyAuditBindings = bindings();
    const { recordAuthorityAuditEvent } = boundServices;

    const candidateBundleDigest = prefixedDigest(
      candidate.candidateBundleDigest,
    );
    const outcomeDigest = auditValueDigest({
      kind: 'authority-candidate-artifacts.v1',
      manifestDigest: candidate.manifestDigest,
      checksAttestationDigest: candidate.checksAttestationDigest,
      effectsManifestDigest: candidate.effectsManifestDigest,
      providerInvocationsDigest: candidate.providerInvocationsDigest,
      recoveryPlanDigest: candidate.recoveryPlanDigest,
    });
    recordAuthorityAuditEvent(scope, {
      eventType: 'candidate-bundle',
      occurredAt: candidate.createdAt,
      idempotencyKey: auditValueDigest({
        kind: 'authority-candidate-bundle-audit.v1',
        candidateBundleDigest,
      }),
      grantDigest: null,
      candidateBundleDigest,
      prestateDigest: auditValueDigest({
        kind: 'authority-candidate-prestate.v1',
        targetRef: candidate.targetRef,
        expectedOldCommit: candidate.expectedOldCommit,
        expectedRefGeneration: candidate.expectedRefGeneration,
      }),
      poststateDigest: auditValueDigest({
        kind: 'authority-candidate-poststate.v1',
        candidateCommit: candidate.candidateCommit,
        resultTree: candidate.resultTree,
      }),
      actor: { kind: 'engine', identity: 'workflow-engine' },
      taskId: candidate.mandateBinding.mandateTaskId,
      changeId,
      workflowId: null,
      command: {
        name: 'candidate.freeze',
        argvDigest: auditValueDigest({ changeId, candidateBundleDigest }),
      },
      providerInvocation: null,
      externalEffect: null,
      result: 'recorded',
      outcomeDigest,
      errorCode: null,
    });
  }

  function appendApplyGrantAudit(
    scope: AuthorityAuditLedgerScope,
    envelope: MaintainerGrantV2Envelope,
  ): void {
    const boundServices: MaintainerApplyAuditBindings = bindings();
    const {
      canonicalMaintainerGrantV2Envelope,
      workflowError,
      ExitCode,
      recordAuthorityAuditEvent,
    } = boundServices;

    const canonicalEnvelope = canonicalMaintainerGrantV2Envelope(envelope);
    const candidate = envelope.payload.candidateBundle;
    if (candidate === null) {
      throw workflowError(
        'APPLY_CANDIDATE_REQUIRED',
        'Apply Grant audit requires the exact immutable candidate.',
        ExitCode.guard,
      );
    }
    const grantDigest = auditBytesDigest(canonicalEnvelope);
    const candidateBundleDigest = prefixedDigest(
      candidate.candidateBundleDigest,
    );
    const outcomeDigest = auditValueDigest({
      kind: 'authority-apply-grant-result.v1',
      classification: envelope.payload.classification,
      manifestDigest: envelope.payload.manifestDigest,
      checksAttestationDigest: envelope.payload.checksAttestationDigest,
      evidenceWaivers: envelope.payload.evidenceWaivers,
    });
    recordAuthorityAuditEvent(scope, {
      eventType: 'apply-grant',
      occurredAt: envelope.payload.issuedAt,
      idempotencyKey: auditValueDigest({
        kind: 'authority-apply-grant-audit.v1',
        grantId: envelope.payload.grantId,
        grantDigest,
      }),
      grantDigest,
      candidateBundleDigest,
      prestateDigest: auditValueDigest({
        kind: 'authority-apply-grant-prestate.v1',
        baseCommit: envelope.payload.baseCommit,
        targetRef: candidate.targetRef,
        expectedRefGeneration: candidate.expectedRefGeneration,
      }),
      poststateDigest: auditValueDigest({
        kind: 'authority-signed-grant.v1',
        grantId: envelope.payload.grantId,
        expiresAt: envelope.payload.expiresAt,
        maxUses: envelope.payload.maxUses,
      }),
      actor: { kind: 'human', identity: envelope.payload.signer },
      taskId: envelope.payload.taskId,
      changeId: envelope.payload.changeId,
      workflowId: null,
      command: {
        name: 'candidate.approve-and-apply',
        argvDigest: auditValueDigest({
          changeId: envelope.payload.changeId,
          candidateBundleDigest,
        }),
      },
      providerInvocation: null,
      externalEffect: null,
      result: 'recorded',
      outcomeDigest,
      errorCode: null,
    });
  }

  function appendApplyGrantRevocationAudit(
    repositoryRoot: string,
    envelope: MaintainerGrantV2Envelope,
    revoker: string,
    reason: string,
    now: Date,
  ) {
    const boundServices: MaintainerApplyAuditBindings = bindings();
    const {
      canonicalMaintainerGrantV2Envelope,
      workflowError,
      ExitCode,
      scanAuthorityAuditLedger,
      recordAuthorityAuditEvent,
    } = boundServices;

    const binding = envelope.payload.mandateBinding;
    const scope = maintainerAuditScope(
      repositoryRoot,
      envelope.payload.repositoryId,
      binding,
    );
    const grantDigest = auditBytesDigest(
      canonicalMaintainerGrantV2Envelope(envelope),
    );
    const candidate = envelope.payload.candidateBundle;
    if (candidate === null) {
      throw workflowError(
        'APPLY_CANDIDATE_REQUIRED',
        'Apply Grant v2 revocation requires its immutable candidate.',
        ExitCode.guard,
      );
    }
    const candidateBundleDigest = prefixedDigest(
      candidate.candidateBundleDigest,
    );
    const reasonDigest = auditValueDigest({
      kind: 'authority-apply-grant-revocation-reason.v1',
      reason,
    });
    const idempotencyKey = auditValueDigest({
      kind: 'authority-apply-grant-revocation.v1',
      grantId: envelope.payload.grantId,
      grantDigest,
      reasonDigest,
    });
    const durableOccurrence = scanAuthorityAuditLedger(scope).records.find(
      ({ record }) => record.idempotencyKey === idempotencyKey,
    )?.record.occurredAt;
    return recordAuthorityAuditEvent(scope, {
      eventType: 'revoke',
      occurredAt: durableOccurrence ?? now.toISOString(),
      idempotencyKey,
      grantDigest,
      candidateBundleDigest,
      prestateDigest: auditValueDigest({
        kind: 'authority-apply-grant-available.v1',
        grantId: envelope.payload.grantId,
        targetRef: candidate.targetRef,
        expectedOldCommit: candidate.expectedOldCommit,
        expectedRefGeneration: candidate.expectedRefGeneration,
      }),
      poststateDigest: auditValueDigest({
        kind: 'authority-apply-grant-revoked.v1',
        grantId: envelope.payload.grantId,
        reasonDigest,
      }),
      actor: { kind: 'human', identity: revoker },
      taskId: binding.mandateTaskId,
      changeId: binding.changeId,
      workflowId: null,
      command: {
        name: 'grant.revoke',
        argvDigest: auditValueDigest({
          grantId: envelope.payload.grantId,
          reasonDigest,
        }),
      },
      providerInvocation: null,
      externalEffect: null,
      result: 'revoked',
      outcomeDigest: auditValueDigest({
        kind: 'authority-apply-grant-revocation-result.v1',
        grantId: envelope.payload.grantId,
        reasonDigest,
      }),
      errorCode: null,
    });
  }

  function prefixedDigest(value: string): Sha256Digest {
    const boundServices: MaintainerApplyAuditBindings = bindings();
    const { workflowError, ExitCode } = boundServices;

    if (!/^[0-9a-f]{64}$/.test(value)) {
      throw workflowError(
        'AUTHORITY_AUDIT_BINDING_INVALID',
        'Authority audit binding requires an exact SHA-256 digest.',
        ExitCode.guard,
      );
    }
    return `sha256:${value}`;
  }

  function auditValueDigest(value: unknown): Sha256Digest {
    const boundServices: MaintainerApplyAuditBindings = bindings();
    const { canonicalJson } = boundServices;

    return auditBytesDigest(canonicalJson(value));
  }

  function auditBytesDigest(value: string): Sha256Digest {
    const boundServices: MaintainerApplyAuditBindings = bindings();
    const { crypto } = boundServices;

    return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
  }
  return {
    collectCandidateProviderInvocations,
    maintainerAuditScope,
    applyRefusalBinding,
    applyGrantRefusalBinding,
    appendCandidateBundleAudit,
    appendApplyGrantAudit,
    appendApplyGrantRevocationAudit,
  };
}

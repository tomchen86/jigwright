/** Executes the complete audit use cases against required repository, input and ledger capabilities. */
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import { parseMaintainerPolicy } from '../../modules/authority/maintainer-policy.ts';
import {
  deriveAuthorityAuditRepositoryId,
  PROTECTED_AUDIT_ASSURANCE,
  type AuthorityAuditRequest,
  type AuthorityAuditRuntime,
  type AuthorityAuditOperationResult,
  type AuthorityAuditLedgerScope,
  type AuthorityAuditInputOperations,
  type AuthorityAuditRepositoryObservations,
  type AuthorityAuditLedgerOperations,
  type AuthorityAuditInputErrors,
} from '../../modules/authority/authority-audit-contract.ts';

export function createAuthorityAuditOperations(
  ledger: AuthorityAuditLedgerOperations,
  repositoryObservations: AuthorityAuditRepositoryObservations,
  input: AuthorityAuditInputOperations,
  errors: Pick<AuthorityAuditInputErrors, 'auditUsageError'>,
) {
  const {
    scanAuthorityAuditLedger,
    showAuthorityAuditTask,
    verifyAuthorityAuditEvents,
    configureProtectedAuthorityAuditLedger,
    createPinnedAuthorityAuditAnchorBackend,
    createPinnedAuditDestructionSignatureVerifier,
    anchorProtectedAuthorityAuditLedger,
    verifyProtectedAuthorityAuditAnchors,
    destroyProtectedAuthorityAuditLedger,
  } = ledger;
  const {
    assertExternalAuditRoot,
    assertProtectedBackendRootInput,
    readPrivateInputFile,
    readCanonicalAuditDestructionGrant,
    assertControllingTerminal,
    exactRuntimeNow,
  } = input;
  const { discoverRepository } = repositoryObservations;
  const { auditUsageError } = errors;
  function executeAuthorityAuditCommand(
    parsed: AuthorityAuditRequest,
    cwd: string,
    runtime: AuthorityAuditRuntime = {},
  ): AuthorityAuditOperationResult {
    const resolved = resolveAuthorityAuditScope(cwd, parsed.auditRoot);

    if (
      parsed.action === 'verify' &&
      parsed.subject !== resolved.repositoryIdentity
    ) {
      throw workflowError(
        'AUTHORITY_AUDIT_REPOSITORY_MISMATCH',
        'Requested repository identity does not match the exact current trust base.',
        ExitCode.verification,
      );
    }

    if (parsed.action === 'profile') {
      if (parsed.subject === 'protected') {
        assertControllingTerminal(runtime);
        assertProtectedBackendRootInput(parsed.backendRoot, resolved.scope);
        const destructionPublicKeyPem = readPrivateInputFile(
          parsed.destructionPublicKey,
          'destruction public key',
        );
        configureProtectedAuthorityAuditLedger(resolved.scope, {
          backendRoot: parsed.backendRoot,
          destructionPublicKeyPem,
        });
      }
      const result = scanAuthorityAuditLedger({
        ...resolved.scope,
        profile: parsed.subject,
      });
      return {
        action: 'profile',
        requestedSubject: parsed.subject,
        verified: true,
        assurance:
          parsed.subject === 'protected' ? PROTECTED_AUDIT_ASSURANCE : null,
        result,
      };
    }

    if (parsed.action === 'show') {
      const result = showAuthorityAuditTask(resolved.scope, parsed.subject);
      return {
        action: 'show',
        requestedSubject: parsed.subject,
        verified: result.ok,
        assurance:
          result.profile === 'protected' ? PROTECTED_AUDIT_ASSURANCE : null,
        result,
      };
    }

    if (parsed.action === 'verify') {
      const result = verifyAuthorityAuditEvents(resolved.scope);
      return {
        action: 'verify',
        requestedSubject: parsed.subject,
        verified: result.ok,
        assurance:
          result.profile === 'protected' ? PROTECTED_AUDIT_ASSURANCE : null,
        result,
      };
    }

    if (parsed.action === 'anchor') {
      const result = anchorProtectedAuthorityAuditLedger(resolved.scope, {
        anchoredAt: exactRuntimeNow(runtime).toISOString(),
        backend: createPinnedAuthorityAuditAnchorBackend(resolved.scope),
      });
      return {
        action: 'anchor',
        requestedSubject: resolved.repositoryIdentity,
        verified: true,
        assurance: PROTECTED_AUDIT_ASSURANCE,
        result,
      };
    }

    if (parsed.action === 'verify-anchors') {
      const result = verifyProtectedAuthorityAuditAnchors(resolved.scope, [
        createPinnedAuthorityAuditAnchorBackend(resolved.scope),
      ]);
      return {
        action: 'verify-anchors',
        requestedSubject: resolved.repositoryIdentity,
        verified: result.ok,
        assurance: PROTECTED_AUDIT_ASSURANCE,
        result,
      };
    }

    if (parsed.action !== 'destroy') {
      throw auditUsageError();
    }
    const envelope = readCanonicalAuditDestructionGrant(parsed.grantFile);
    const result = destroyProtectedAuthorityAuditLedger(
      resolved.scope,
      envelope,
      {
        now: exactRuntimeNow(runtime).toISOString(),
        verifyHumanSignature: createPinnedAuditDestructionSignatureVerifier(
          resolved.scope,
        ),
      },
    );
    return {
      action: 'destroy',
      requestedSubject: envelope.payload.grantId,
      verified: true,
      assurance: PROTECTED_AUDIT_ASSURANCE,
      result,
    };
  }

  function resolveAuthorityAuditScope(
    cwd: string,
    requestedAuditRoot: string,
  ): Readonly<{
    repositoryIdentity: string;
    scope: AuthorityAuditLedgerScope;
  }> {
    const repository = discoverRepository(cwd);
    const auditRoot = assertExternalAuditRoot(requestedAuditRoot);
    let policyValue: unknown;
    try {
      policyValue = JSON.parse(
        repositoryObservations.readPolicyAtHead(
          repository.repositoryRoot,
          repository.head,
        ),
      ) as unknown;
    } catch {
      throw workflowError(
        'AUTHORITY_AUDIT_TRUST_BASE_MISSING',
        'Audit inspection requires the exact current maintainer trust base.',
        ExitCode.verification,
      );
    }
    const policy = parseMaintainerPolicy(policyValue);
    return {
      repositoryIdentity: policy.repository.id,
      scope: {
        externalAuditRoot: auditRoot,
        repositoryRoot: repository.repositoryRoot,
        repositoryId: deriveAuthorityAuditRepositoryId(policy.repository.id),
      },
    };
  }
  return {
    execute: executeAuthorityAuditCommand,
    resolveScope: resolveAuthorityAuditScope,
  };
}

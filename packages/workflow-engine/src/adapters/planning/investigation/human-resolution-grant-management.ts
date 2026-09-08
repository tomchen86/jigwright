/** Stored human-resolution grant inspection, publication recovery and revocation. */
import type {
  HumanResolutionRuntimeBindings,
  HumanResolutionRuntimeTypes,
} from './investigation-session.ts';

type HumanResolutionGrantPublicationAuditTag =
  HumanResolutionRuntimeTypes['HumanResolutionGrantPublicationAuditTag'];

type HumanResolutionGrantPublicationStateBinding =
  HumanResolutionRuntimeTypes['HumanResolutionGrantPublicationStateBinding'];

type HumanResolutionGrantPublicationStoreState =
  HumanResolutionRuntimeTypes['HumanResolutionGrantPublicationStoreState'];

type QuarantinedHumanResolutionGrantPublication =
  HumanResolutionRuntimeTypes['QuarantinedHumanResolutionGrantPublication'];

type HumanResolutionGrantStoreEntry =
  HumanResolutionRuntimeTypes['HumanResolutionGrantStoreEntry'];

type HumanRevocationOptions =
  HumanResolutionRuntimeTypes['HumanRevocationOptions'];

export type HumanResolutionGrantInspection = {
  grantId: string;
  state: HumanResolutionGrantStoreEntry['state'];
  investigationId: string;
  changeId: string;
  expectedStateDigest: string;
  decision: HumanResolutionNode['decision'];
  consequences: HumanResolutionNode['consequences'];
  issuedAt: string;
  expiresAt: string;
  signer: string;
  terminalReason: string | null;
  recordedAt: string | null;
};

export type HumanResolutionGrantPublicationRecoveryInspection =
  HumanResolutionGrantPublicationStoreState & {
    auditTag: HumanResolutionGrantPublicationAuditTag;
    publicationStateDigest: string;
  };
type HumanResolutionNode = HumanResolutionRuntimeTypes['HumanResolutionNode'];

type HumanResolutionGrantManagementBindings = Pick<
  HumanResolutionRuntimeBindings,
  | 'canonicalJson'
  | 'ExitCode'
  | 'workflowError'
  | 'runGit'
  | 'inspectInterruptedHumanResolutionGrantPublications'
  | 'inspectStoredHumanResolutionGrants'
  | 'quarantineInterruptedHumanResolutionGrantPublication'
  | 'revokeStoredHumanResolutionGrant'
  | 'withHumanResolutionGrantExecution'
  | 'loadInvestigationRuntimeContext'
  | 'parseHumanResolutionGrantEnvelope'
  | 'verifyHumanResolutionGrantForRevocation'
  | 'withHumanResolutionTransitionAuthority'
>;

export function createHumanResolutionGrantManagement(
  runtime: HumanResolutionGrantManagementBindings,
  digest: (value: string) => string,
) {
  const {
    canonicalJson,
    ExitCode,
    workflowError,
    runGit,
    inspectInterruptedHumanResolutionGrantPublications,
    inspectStoredHumanResolutionGrants,
    quarantineInterruptedHumanResolutionGrantPublication,
    revokeStoredHumanResolutionGrant,
    withHumanResolutionGrantExecution,
    loadInvestigationRuntimeContext,
    parseHumanResolutionGrantEnvelope,
    verifyHumanResolutionGrantForRevocation,
    withHumanResolutionTransitionAuthority,
  } = runtime;

  function inspectHumanResolutionGrants(
    cwd: string,
    requestedGrantId?: string,
  ): HumanResolutionGrantInspection[] {
    const context = loadInvestigationRuntimeContext(cwd);
    return inspectStoredHumanResolutionGrants(
      context.runtime,
      requestedGrantId,
    ).map(inspectHumanResolutionGrant);
  }

  function inspectHumanResolutionGrantPublicationRecoveries(
    cwd: string,
    requestedGrantId?: string,
  ): HumanResolutionGrantPublicationRecoveryInspection[] {
    const context = loadInvestigationRuntimeContext(cwd);
    return inspectInterruptedHumanResolutionGrantPublications(
      context.runtime,
      requestedGrantId,
    ).map(({ storeState, preparedBinding }) =>
      inspectHumanResolutionGrantPublicationRecovery(
        context,
        storeState,
        preparedBinding,
      ),
    );
  }

  function discardHumanResolutionGrantPublication(
    cwd: string,
    requestedGrantId: string,
    expectedPublicationStateDigest: string,
    reason: string,
    now: Date = new Date(),
  ): QuarantinedHumanResolutionGrantPublication {
    const context = loadInvestigationRuntimeContext(cwd);
    return withHumanResolutionGrantExecution(
      context.runtime,
      requestedGrantId,
      () =>
        quarantineInterruptedHumanResolutionGrantPublication(
          context.runtime,
          requestedGrantId,
          expectedPublicationStateDigest,
          reason,
          (storeState) => {
            const { auditTag, publicationStateDigest } =
              inspectHumanResolutionGrantPublicationRecovery(
                context,
                storeState,
                null,
              );
            return { auditTag, publicationStateDigest };
          },
          now,
        ),
      { allowPublicationRecovery: true },
    );
  }

  function inspectHumanResolutionGrantPublicationRecovery(
    context: ReturnType<typeof loadInvestigationRuntimeContext>,
    storeState: HumanResolutionGrantPublicationStoreState,
    preparedBinding: HumanResolutionGrantPublicationStateBinding | null,
  ): HumanResolutionGrantPublicationRecoveryInspection {
    if (preparedBinding !== null) {
      const publicationStateDigest = digest(
        canonicalJson({
          schemaVersion: 1,
          kind: 'human-resolution-grant-publication-state',
          ...storeState,
          auditTag: preparedBinding.auditTag,
        }),
      );
      if (publicationStateDigest !== preparedBinding.publicationStateDigest) {
        throw workflowError(
          'HUMAN_RESOLUTION_GRANT_PUBLICATION_RECOVERY_STALE',
          'Prepared publication recovery no longer matches its bound state.',
          ExitCode.staleState,
        );
      }
      return {
        ...storeState,
        auditTag: preparedBinding.auditTag,
        publicationStateDigest,
      };
    }
    const tagSuffix = `/resolution-${storeState.grantId}`;
    const matchingTags = runGit(context.git.repositoryRoot, [
      'for-each-ref',
      '--format=%(refname)%09%(objectname)%09%(objecttype)',
      'refs/tags',
    ])
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split('\t'))
      .filter(([ref]) => ref?.endsWith(tagSuffix));
    if (matchingTags.length > 1) {
      throw workflowError(
        'HUMAN_RESOLUTION_GRANT_PUBLICATION_RECOVERY_AMBIGUOUS',
        'Multiple local audit tags could belong to the interrupted grant publication.',
        ExitCode.unsafeEnvironment,
      );
    }
    const [tagRef = null, refObjectOid = null, objectType = null] =
      matchingTags[0] ?? [];
    if (
      refObjectOid !== null &&
      (tagRef === null ||
        objectType !== 'tag' ||
        !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(refObjectOid))
    ) {
      throw workflowError(
        'HUMAN_RESOLUTION_GRANT_PUBLICATION_RECOVERY_AMBIGUOUS',
        'The local audit ref is not an exact annotated tag.',
        ExitCode.unsafeEnvironment,
      );
    }
    const auditTag = {
      status: refObjectOid ? ('present' as const) : ('absent' as const),
      tagRef,
      refObjectOid,
      objectType,
    };
    const publicationStateDigest = digest(
      canonicalJson({
        schemaVersion: 1,
        kind: 'human-resolution-grant-publication-state',
        ...storeState,
        auditTag,
      }),
    );
    return {
      ...storeState,
      auditTag,
      publicationStateDigest,
    };
  }

  function revokeHumanResolutionGrant(
    cwd: string,
    requestedGrantId: string,
    options?: HumanRevocationOptions,
  ): HumanResolutionGrantInspection {
    if (options === undefined) {
      throw workflowError(
        'HUMAN_REVOCATION_API_REQUIRED',
        'Human-resolution revocation requires an exact reason and current-human authorization.',
        ExitCode.guard,
      );
    }
    const context = loadInvestigationRuntimeContext(cwd);
    return withHumanResolutionGrantExecution(
      context.runtime,
      requestedGrantId,
      () => {
        const stored = inspectStoredHumanResolutionGrants(
          context.runtime,
          requestedGrantId,
        )[0]!;
        const envelope = parseHumanResolutionGrantEnvelope(
          stored.envelopeBytes,
        );
        verifyHumanResolutionGrantForRevocation(
          context.git.repositoryRoot,
          envelope,
          options.verifier,
        );
        if (stored.state === 'revoked') {
          return inspectHumanResolutionGrant(
            revokeStoredHumanResolutionGrant(
              context.runtime,
              context.git.repositoryRoot,
              requestedGrantId,
              options,
            ),
          );
        }
        if (stored.state === 'consumed') {
          throw workflowError(
            'HUMAN_REVOCATION_STATE_INVALID',
            'Consumed human-resolution authority cannot be revoked.',
            ExitCode.guard,
          );
        }
        const current = inspectHumanResolutionGrant(stored);
        return withHumanResolutionTransitionAuthority(
          context.lifecycleRuntime,
          current.changeId,
          requestedGrantId,
          (assertOwned) => {
            assertOwned();
            const revoked = revokeStoredHumanResolutionGrant(
              context.runtime,
              context.git.repositoryRoot,
              requestedGrantId,
              options,
            );
            assertOwned();
            return inspectHumanResolutionGrant(revoked);
          },
        );
      },
    );
  }

  function inspectHumanResolutionGrant(
    entry: HumanResolutionGrantStoreEntry,
  ): HumanResolutionGrantInspection {
    const envelope = parseHumanResolutionGrantEnvelope(entry.envelopeBytes);
    if (envelope.payload.grantId !== entry.grantId) {
      throw workflowError(
        'HUMAN_RESOLUTION_GRANT_UNSAFE',
        'Human resolution grant storage and envelope identities differ.',
        ExitCode.unsafeEnvironment,
      );
    }
    return {
      grantId: entry.grantId,
      state: entry.state,
      investigationId: envelope.payload.target.workflowId,
      changeId: envelope.payload.target.changeId,
      expectedStateDigest: envelope.payload.expected.stateDigest,
      decision: envelope.payload.decision,
      consequences: envelope.payload.consequences,
      issuedAt: envelope.payload.issuedAt,
      expiresAt: envelope.payload.expiresAt,
      signer: envelope.payload.signer,
      terminalReason: entry.terminalReason,
      recordedAt: entry.recordedAt,
    };
  }

  return {
    inspectHumanResolutionGrants,
    inspectHumanResolutionGrantPublicationRecoveries,
    discardHumanResolutionGrantPublication,
    revokeHumanResolutionGrant,
  };
}

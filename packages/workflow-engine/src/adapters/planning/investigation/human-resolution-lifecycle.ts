/** Human-resolution grant inspection, publication and exact journal recovery.
 * Runtime bindings stay at the existing investigation adapter boundary.
 */
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
type HumanResolutionConsequences =
  HumanResolutionRuntimeTypes['HumanResolutionConsequences'];
type HumanResolutionDecision =
  HumanResolutionRuntimeTypes['HumanResolutionDecision'];
type HumanResolutionExpectedState =
  HumanResolutionRuntimeTypes['HumanResolutionExpectedState'];
type HumanResolutionJournal =
  HumanResolutionRuntimeTypes['HumanResolutionJournal'];
type HumanResolutionGrantStoreEntry =
  HumanResolutionRuntimeTypes['HumanResolutionGrantStoreEntry'];
type HumanResolutionNode = HumanResolutionRuntimeTypes['HumanResolutionNode'];
type HumanResolutionTarget =
  HumanResolutionRuntimeTypes['HumanResolutionTarget'];
type InvestigationResolutionState =
  HumanResolutionRuntimeTypes['InvestigationResolutionState'];
type HumanRevocationOptions =
  HumanResolutionRuntimeTypes['HumanRevocationOptions'];

export type HumanResolutionExecutionOptions = {
  now?: Date;
  simulateCrashAfter?:
    | 'prepared'
    | 'evidence-refs'
    | 'start-reservation'
    | 'current-ref'
    | 'state-published'
    | 'receipt-written'
    | 'completed';
};

export class SimulatedHumanResolutionCrash extends Error {
  readonly phase: NonNullable<
    HumanResolutionExecutionOptions['simulateCrashAfter']
  >;

  constructor(
    phase: NonNullable<HumanResolutionExecutionOptions['simulateCrashAfter']>,
  ) {
    super(`Simulated human-resolution crash after ${phase}.`);
    this.phase = phase;
  }
}

export type HumanResolutionExecutionResult = {
  grantId: string;
  investigationId: string;
  decision: HumanResolutionNode['decision'];
  beforeStateDigest: string;
  afterStateDigest: string;
  resolutionNodeId: string;
  receiptDigest: string;
  recovered: boolean;
};

export type GrantCoreHumanResolutionAuthorization = Readonly<{
  schemaVersion: 1;
  kind: 'grant-core-human-resolution.v1';
  challengeId: string;
  approvalSubjectDigest: `sha256:${string}`;
  repositoryId: string;
  repositoryHead: string;
  repositoryTree: string;
  target: HumanResolutionTarget;
  expected: HumanResolutionExpectedState;
  decision: HumanResolutionDecision;
  consequences: HumanResolutionConsequences;
}>;

type HumanResolutionExecutionAuthorization = Readonly<{
  grantId: string;
  grantDigest: string;
  repositoryId: string;
  repositoryHead: string;
  repositoryTree: string | null;
  target: HumanResolutionTarget;
  expected: HumanResolutionExpectedState;
  decision: HumanResolutionDecision;
  consequences: HumanResolutionConsequences;
}>;

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

export type GrantCoreHumanResolutionExecutionOptions = Readonly<{
  now?: Date;
  simulateCrashAfter?: NonNullable<
    HumanResolutionExecutionOptions['simulateCrashAfter']
  >;
}>;

type PreparedHumanResolutionExecution = {
  authorization: HumanResolutionExecutionAuthorization;
  node: HumanResolutionNode;
  journal: HumanResolutionJournal;
  receipt: Record<string, unknown>;
  beforeState: InvestigationResolutionState;
};
export function createHumanResolutionLifecycle(
  runtime: HumanResolutionRuntimeBindings,
) {
  const {
    crypto,
    canonicalJson,
    compareAndSwapEvidenceRefsDocument,
    investigationEvidenceRefsClosureDigest,
    quarantineUnsafeEvidenceRefsDocument,
    readInvestigationEvidenceRefsClosure,
    ExitCode,
    workflowError,
    runGit,
    copyGrantDate,
    assertHumanResolutionDecision,
    compareAndSwapCurrentInvestigationRef,
    compareAndSwapHumanResolutionHead,
    createHumanResolutionJournal,
    createHumanResolutionNode,
    inspectInvestigationResolutionState,
    inspectInvestigationQuarantineState,
    inspectInterruptedHumanResolutionGrantPublications,
    investigationCurrentRefDigest,
    investigationResolutionStateDigest,
    humanResolutionDecisionSchemaDigest,
    inspectStoredHumanResolutionGrants,
    scanProviderInvocationLifecycles,
    quarantineUnsafeCurrentInvestigationRef,
    quarantineUnsafeInvestigationStartReservation,
    quarantineInterruptedHumanResolutionGrantPublication,
    quarantineUnsafeHumanResolutionRef,
    readCurrentInvestigationRef,
    readHumanResolutionArchive,
    readHumanResolutionHead,
    readHumanResolutionJournal,
    readHumanResolutionNode,
    readInvestigationSession,
    archiveHumanResolutionSingleton,
    revokeStoredHumanResolutionGrant,
    withHumanResolutionGrantExecution,
    writeHumanResolutionArchive,
    writeHumanResolutionJournal,
    writeHumanResolutionNode,
    writeHumanResolutionReceipt,
    loadInvestigationRuntimeContext,
    assertResolutionConsequences,
    assertResolutionDecisionAvailable,
    assertResolutionDecisionTarget,
    humanResolutionBlockerBinding,
    loadMaintainerPolicyForResolution,
    parseHumanResolutionGrantEnvelope,
    verifyHumanResolutionGrantForRevocation,
    assertChangeId,
    assertInvestigationId,
    assertHeldChangeTransitionAuthority,
    withGrantHumanResolutionTransitionAuthority,
    withHumanResolutionTransitionAuthority,
    assertProviderWorkersQuiescentUnderLifecycleLock,
    readInvestigationStartReservationSnapshot,
    retireInvestigationStartReservation,
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

  function executeGrantCoreHumanResolution(
    cwd: string,
    input: GrantCoreHumanResolutionAuthorization,
    assertRepositoryLifecycleOwned: () => void,
    options: GrantCoreHumanResolutionExecutionOptions = {},
  ): HumanResolutionExecutionResult {
    const context = loadInvestigationRuntimeContext(cwd);
    const authorization = grantCoreHumanResolutionAuthorization(input);
    if (
      context.git.head !== authorization.repositoryHead ||
      context.git.tree !== authorization.repositoryTree
    ) {
      throw workflowError(
        'GRANT_STATE_CHANGED',
        'Repository state changed after the human decision; fresh approval is required.',
        ExitCode.staleState,
      );
    }
    const { policy } = loadMaintainerPolicyForResolution(
      context.git.repositoryRoot,
      authorization.repositoryHead,
    );
    const origin = runGit(context.git.repositoryRoot, [
      'remote',
      'get-url',
      'origin',
    ]).trim();
    if (
      policy.repository.id !== authorization.repositoryId ||
      origin !== policy.repository.origin
    ) {
      throw workflowError(
        'HUMAN_RESOLUTION_REPOSITORY_MISMATCH',
        'The Grant Core resolution belongs to another repository.',
        ExitCode.guard,
      );
    }

    return withGrantHumanResolutionTransitionAuthority(
      context.lifecycleRuntime,
      authorization.target.changeId,
      authorization.grantId,
      assertRepositoryLifecycleOwned,
      (authority) => {
        const assertOwned = assertHeldChangeTransitionAuthority(
          authority,
          authorization.target.changeId,
        );
        assertOwned();
        const existing = readHumanResolutionJournal(
          context.runtime,
          authorization.grantId,
        );
        let prepared: PreparedHumanResolutionExecution;
        let recovered: boolean;
        if (existing === null) {
          const state = inspectAuthorizedHumanResolutionState(
            context,
            authorization,
          );
          assertGrantCoreHumanResolutionState(context, authorization, state);
          assertHumanResolutionProviderQuiescence(
            context,
            authorization.target.workflowId,
          );
          assertOwned();
          prepared = prepareAuthorizedHumanResolutionExecution(
            context,
            authorization,
            state,
            options,
            exactHumanResolutionDate(options.now ?? new Date()),
          );
          recovered = false;
        } else {
          if (
            existing.grantDigest !== authorization.grantDigest ||
            canonicalJson(existing.target) !==
              canonicalJson(authorization.target)
          ) {
            throw humanResolutionRecoveryAmbiguous();
          }
          const node = readHumanResolutionNodeForRecovery(
            context.runtime,
            existing,
          );
          const beforeState = readHumanResolutionArchive(
            context.runtime,
            existing.evidenceArchiveDigest,
          );
          prepared = {
            authorization,
            node,
            journal: existing,
            receipt: buildHumanResolutionReceipt(
              authorization,
              existing,
              node,
              existing.afterStateDigest,
            ),
            beforeState,
          };
          recovered = true;
        }
        assertOwned();
        const result = publishHumanResolutionExecution(
          cwd,
          context,
          prepared,
          options,
          recovered,
        );
        assertOwned();
        return result;
      },
    );
  }

  function grantCoreHumanResolutionAuthorization(
    input: GrantCoreHumanResolutionAuthorization,
  ): HumanResolutionExecutionAuthorization {
    const keys = Object.keys(input as object).sort();
    const expectedKeys = [
      'approvalSubjectDigest',
      'challengeId',
      'consequences',
      'decision',
      'expected',
      'kind',
      'repositoryHead',
      'repositoryId',
      'repositoryTree',
      'schemaVersion',
      'target',
    ].sort();
    if (
      keys.length !== expectedKeys.length ||
      !keys.every((key, index) => key === expectedKeys[index]) ||
      input.schemaVersion !== 1 ||
      input.kind !== 'grant-core-human-resolution.v1' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        input.challengeId,
      ) ||
      !/^sha256:[0-9a-f]{64}$/.test(input.approvalSubjectDigest) ||
      typeof input.repositoryId !== 'string' ||
      input.repositoryId.trim() !== input.repositoryId ||
      input.repositoryId.length < 1 ||
      Buffer.byteLength(input.repositoryId) > 1_024 ||
      !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(input.repositoryHead) ||
      !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(input.repositoryTree) ||
      input.target.workflowKind !== 'investigation' ||
      assertChangeId(input.target.changeId) !== input.target.changeId ||
      assertInvestigationId(input.target.workflowId) !==
        input.target.workflowId ||
      !/^[0-9a-f]{64}$/.test(input.expected.stateDigest) ||
      (input.expected.currentRefDigest !== null &&
        !/^[0-9a-f]{64}$/.test(input.expected.currentRefDigest)) ||
      typeof input.expected.reasonCode !== 'string' ||
      typeof input.expected.blockedTransition !== 'string'
    ) {
      throw workflowError(
        'GRANT_CORE_HUMAN_RESOLUTION_INVALID',
        'Grant Core human-resolution authorization is malformed.',
        ExitCode.guard,
      );
    }
    const decision = assertHumanResolutionDecision(input.decision);
    assertResolutionConsequences(decision, input.consequences);
    const normalized = JSON.parse(
      canonicalJson({ ...input, decision }),
    ) as GrantCoreHumanResolutionAuthorization;
    return {
      grantId: normalized.challengeId,
      grantDigest: digest(
        canonicalJson({
          schema: 'grant-core-human-resolution-authorization.v1',
          authorization: normalized,
        }),
      ),
      repositoryId: normalized.repositoryId,
      repositoryHead: normalized.repositoryHead,
      repositoryTree: normalized.repositoryTree,
      target: normalized.target,
      expected: normalized.expected,
      decision: normalized.decision,
      consequences: normalized.consequences,
    };
  }

  function inspectAuthorizedHumanResolutionState(
    context: ReturnType<typeof loadInvestigationRuntimeContext>,
    authorization: HumanResolutionExecutionAuthorization,
  ): InvestigationResolutionState {
    return authorization.decision.kind === 'quarantine'
      ? inspectInvestigationQuarantineState(
          context.runtime,
          authorization.target.workflowId,
          authorization.repositoryId,
        )
      : inspectInvestigationResolutionState(
          context.runtime,
          authorization.target.workflowId,
          authorization.repositoryId,
        );
  }

  function assertGrantCoreHumanResolutionState(
    context: ReturnType<typeof loadInvestigationRuntimeContext>,
    authorization: HumanResolutionExecutionAuthorization,
    state: InvestigationResolutionState,
  ): void {
    const blocker = humanResolutionBlockerBinding(state);
    if (
      state.envelope.repositoryId !== authorization.repositoryId ||
      state.envelope.changeId !== authorization.target.changeId ||
      state.envelope.investigationId !== authorization.target.workflowId ||
      state.currentStateDigest !== authorization.expected.stateDigest ||
      state.currentRefDigest !== authorization.expected.currentRefDigest ||
      blocker.reasonCode !== authorization.expected.reasonCode ||
      blocker.blockedTransition !== authorization.expected.blockedTransition
    ) {
      throw workflowError(
        'GRANT_STATE_CHANGED',
        'Investigation state changed after the human decision; fresh approval is required.',
        ExitCode.staleState,
      );
    }
    assertResolutionDecisionAvailable(state, authorization.decision);
    assertResolutionDecisionTarget(
      context.runtime,
      state,
      authorization.decision,
    );
    const advertised = state.availableResolutions.find(
      ({ kind }) => kind === authorization.decision.kind,
    );
    if (
      advertised?.parameterSchemaDigest !==
      humanResolutionDecisionSchemaDigest(authorization.decision.kind)
    ) {
      throw workflowError(
        'GRANT_TRANSITION_DEFINITION_CHANGED',
        'Investigation resolution schema changed after challenge creation.',
        ExitCode.staleState,
      );
    }
  }

  function prepareAuthorizedHumanResolutionExecution(
    context: ReturnType<typeof loadInvestigationRuntimeContext>,
    authorization: HumanResolutionExecutionAuthorization,
    state: InvestigationResolutionState,
    options: HumanResolutionExecutionOptions,
    now: Date,
  ): PreparedHumanResolutionExecution {
    let currentRef: ReturnType<typeof readCurrentInvestigationRef>;
    try {
      currentRef = readCurrentInvestigationRef(
        context.runtime,
        authorization.target.changeId,
      );
    } catch (error) {
      if (
        authorization.decision.kind !== 'quarantine' ||
        state.envelope.ambiguityDigest === null ||
        state.currentRefDigest === null
      ) {
        throw error;
      }
      currentRef = null;
    }
    const plannedCurrentWorkflowRef = planHumanResolutionCurrentRef(
      authorization,
      currentRef?.investigationId ?? null,
    );
    const plannedStartReservation = planHumanResolutionStartReservation(
      context,
      authorization,
      state,
    );
    const plannedEvidenceRefs = planHumanResolutionEvidenceRefs(
      context,
      authorization,
      state,
    );
    let previousResolutionNodeId: string | null;
    let resolutionRefMode: HumanResolutionJournal['resolutionRefMode'] =
      'preserve';
    try {
      previousResolutionNodeId = readHumanResolutionHead(
        context.runtime,
        authorization.target.workflowId,
      );
    } catch (error) {
      if (
        authorization.decision.kind !== 'quarantine' ||
        state.envelope.ambiguityDigest === null
      ) {
        throw error;
      }
      previousResolutionNodeId = state.envelope.resolutionHeadNodeId;
      resolutionRefMode = 'quarantine-whole';
    }
    if (previousResolutionNodeId !== state.envelope.resolutionHeadNodeId) {
      throw workflowError(
        'HUMAN_RESOLUTION_GRANT_STALE',
        'Human resolution overlay changed during preparation.',
        ExitCode.staleState,
      );
    }
    const node = createHumanResolutionNode({
      target: authorization.target,
      expected: authorization.expected,
      decision: authorization.decision,
      consequences: authorization.consequences,
      grantId: authorization.grantId,
      grantDigest: authorization.grantDigest,
      previousResolutionNodeId,
      createdAt: now.toISOString(),
    });
    const evidenceArchiveDigest = writeHumanResolutionArchive(
      context.runtime,
      state.currentStateDigest,
      state,
    );
    writeHumanResolutionNode(context.runtime, node);
    const afterEnvelope = {
      ...state.envelope,
      currentRefDigest: plannedCurrentWorkflowRef.nextDigest,
      startReservationDigest: plannedStartReservation.nextDigest,
      evidenceRefs:
        plannedEvidenceRefs.nextDigest === null
          ? null
          : plannedEvidenceRefs.retainedRefs,
      evidenceRefsDigest: plannedEvidenceRefs.nextDigest,
      evidenceRefsClosureDigest: plannedEvidenceRefs.nextClosureDigest,
      resolutionHeadNodeId: node.nodeId,
    };
    const afterStateDigest = investigationResolutionStateDigest(afterEnvelope);
    const provisionalJournal = {
      phase: 'prepared' as const,
      grantId: authorization.grantId,
      grantDigest: authorization.grantDigest,
      target: authorization.target,
      beforeStateDigest: state.currentStateDigest,
      afterStateDigest,
      beforeResolutionRef: previousResolutionNodeId,
      resolutionRefMode,
      plannedResolutionNodeId: node.nodeId,
      plannedCurrentWorkflowRef,
      plannedStartReservation,
      plannedEvidenceRefs,
      evidenceArchiveDigest,
      receiptDigest: '0'.repeat(64),
      createdAt: now.toISOString(),
    };
    const provisional = createHumanResolutionJournal(provisionalJournal);
    const receipt = buildHumanResolutionReceipt(
      authorization,
      provisional,
      node,
      afterStateDigest,
    );
    const receiptDigest = digest(canonicalJson(receipt));
    const journal = createHumanResolutionJournal({
      ...provisionalJournal,
      receiptDigest,
    });
    writeHumanResolutionJournal(context.runtime, journal);
    maybeSimulateHumanResolutionCrash(options, 'prepared');
    return { authorization, node, journal, receipt, beforeState: state };
  }

  function publishHumanResolutionExecution(
    cwd: string,
    context: ReturnType<typeof loadInvestigationRuntimeContext>,
    prepared: PreparedHumanResolutionExecution,
    options: HumanResolutionExecutionOptions,
    recovered: boolean,
  ): HumanResolutionExecutionResult {
    const { authorization, node, journal, receipt, beforeState } = prepared;
    if (
      node.nodeId !== journal.plannedResolutionNodeId ||
      digest(canonicalJson(receipt)) !== journal.receiptDigest ||
      beforeState.currentStateDigest !== journal.beforeStateDigest
    ) {
      throw humanResolutionRecoveryAmbiguous();
    }
    quarantineUnsafeResolutionRefIfNeeded(
      context,
      journal,
      node,
      beforeState,
      authorization.repositoryId,
    );
    assertRecoverableStateShape(
      context,
      beforeState,
      journal,
      authorization.repositoryId,
    );
    publishPlannedEvidenceRefs(context, journal);
    publishHumanResolutionJournalPhase(
      context,
      journal,
      'evidence-refs-published',
    );
    maybeSimulateHumanResolutionCrash(options, 'evidence-refs');
    publishPlannedStartReservation(context, journal);
    publishHumanResolutionJournalPhase(
      context,
      journal,
      'start-reservation-published',
    );
    maybeSimulateHumanResolutionCrash(options, 'start-reservation');
    publishPlannedCurrentInvestigationRef(context, journal, node, beforeState);
    publishHumanResolutionJournalPhase(
      context,
      journal,
      'current-ref-published',
    );
    maybeSimulateHumanResolutionCrash(options, 'current-ref');
    const observedHead = readHumanResolutionHead(
      context.runtime,
      journal.target.workflowId,
    );
    const expectedHead =
      journal.resolutionRefMode === 'quarantine-whole'
        ? null
        : journal.beforeResolutionRef;
    if (observedHead === expectedHead) {
      compareAndSwapHumanResolutionHead(
        context.runtime,
        journal.target.workflowId,
        expectedHead,
        journal.plannedResolutionNodeId,
      );
    } else if (observedHead !== journal.plannedResolutionNodeId) {
      throw humanResolutionRecoveryAmbiguous();
    }
    const afterState =
      node.decision.kind === 'quarantine'
        ? inspectInvestigationQuarantineState(
            context.runtime,
            journal.target.workflowId,
            authorization.repositoryId,
          )
        : inspectInvestigationResolutionState(
            context.runtime,
            journal.target.workflowId,
            authorization.repositoryId,
          );
    if (afterState.currentStateDigest !== journal.afterStateDigest) {
      throw humanResolutionRecoveryAmbiguous();
    }
    publishHumanResolutionJournalPhase(context, journal, 'state-published');
    maybeSimulateHumanResolutionCrash(options, 'state-published');
    const receiptDigest = writeHumanResolutionReceipt(
      context.runtime,
      authorization.grantId,
      receipt,
    );
    if (receiptDigest !== journal.receiptDigest) {
      throw humanResolutionRecoveryAmbiguous();
    }
    publishHumanResolutionJournalPhase(context, journal, 'receipt-written');
    maybeSimulateHumanResolutionCrash(options, 'receipt-written');
    writeHumanResolutionJournal(
      context.runtime,
      updateHumanResolutionJournalPhase(journal, 'completed'),
    );
    maybeSimulateHumanResolutionCrash(options, 'completed');
    return {
      grantId: authorization.grantId,
      investigationId: journal.target.workflowId,
      decision: node.decision,
      beforeStateDigest: journal.beforeStateDigest,
      afterStateDigest: journal.afterStateDigest,
      resolutionNodeId: node.nodeId,
      receiptDigest,
      recovered,
    };
  }

  function quarantineUnsafeResolutionRefIfNeeded(
    context: ReturnType<typeof loadInvestigationRuntimeContext>,
    journal: HumanResolutionJournal,
    node: HumanResolutionNode,
    beforeState: InvestigationResolutionState,
    repositoryId: string,
  ): void {
    if (
      node.decision.kind !== 'quarantine' ||
      beforeState.envelope.ambiguityDigest === null ||
      journal.resolutionRefMode !== 'quarantine-whole'
    ) {
      return;
    }
    quarantineUnsafeHumanResolutionRef(
      context.runtime,
      journal.target.workflowId,
      repositoryId,
      beforeState.currentStateDigest,
    );
  }

  function assertHumanResolutionProviderQuiescence(
    context: ReturnType<typeof loadInvestigationRuntimeContext>,
    investigationId: string,
  ): void {
    readInvestigationSession(context.runtime, investigationId);
    try {
      assertProviderWorkersQuiescentUnderLifecycleLock(context.runtime);
    } catch {
      throw workflowError(
        'HUMAN_RESOLUTION_PROVIDER_NOT_QUIESCENT',
        'Human resolution requires every repository provider worker to be durably quiescent.',
        ExitCode.guard,
      );
    }
    let projections: ReturnType<
      typeof scanProviderInvocationLifecycles
    >['projections'];
    try {
      projections = scanProviderInvocationLifecycles(
        context.runtime,
      ).projections;
    } catch {
      throw workflowError(
        'HUMAN_RESOLUTION_PROVIDER_NOT_QUIESCENT',
        'Human resolution requires every repository provider invocation to have a safe, unleased lifecycle state.',
        ExitCode.guard,
      );
    }
    for (const invocation of projections) {
      if (invocation.state === 'leased' || invocation.lease !== null) {
        throw workflowError(
          'HUMAN_RESOLUTION_PROVIDER_NOT_QUIESCENT',
          'Human resolution requires every repository provider invocation to be unleased and quiescent.',
          ExitCode.guard,
          {
            details: {
              invocationId: invocation.invocationId,
              investigationId: invocation.investigationId,
              state: invocation.state,
            },
          },
        );
      }
    }
  }

  function planHumanResolutionCurrentRef(
    authorization: HumanResolutionExecutionAuthorization,
    observedInvestigationId: string | null,
  ): HumanResolutionJournal['plannedCurrentWorkflowRef'] {
    const targetId = authorization.target.workflowId;
    const decision = authorization.decision;
    let nextInvestigationId = observedInvestigationId;
    if (decision.kind === 'abort' || decision.kind === 'quarantine') {
      if (observedInvestigationId === targetId) {
        nextInvestigationId = null;
      }
    } else if (decision.kind === 'supersede') {
      if (
        decision.parameters.successorInvestigationId !== null &&
        observedInvestigationId !== targetId
      ) {
        throw workflowError(
          'HUMAN_RESOLUTION_CURRENT_REF_MISMATCH',
          'A superseding successor can replace only the exact current target.',
          ExitCode.staleState,
        );
      }
      nextInvestigationId =
        observedInvestigationId === targetId
          ? decision.parameters.successorInvestigationId
          : observedInvestigationId;
    } else if (decision.kind === 'repair') {
      if (observedInvestigationId !== targetId) {
        throw workflowError(
          'HUMAN_RESOLUTION_CURRENT_REF_MISMATCH',
          'Typed current-ref repair requires the bound target to be current.',
          ExitCode.staleState,
        );
      }
      nextInvestigationId = decision.parameters.successorInvestigationId;
    } else if (observedInvestigationId !== targetId) {
      throw workflowError(
        'HUMAN_RESOLUTION_CURRENT_REF_MISMATCH',
        'A progressing resolution requires the bound investigation to be current.',
        ExitCode.staleState,
      );
    }
    return {
      expectedInvestigationId: observedInvestigationId,
      expectedDigest: investigationCurrentRefDigest(
        observedInvestigationId === null
          ? null
          : {
              changeId: authorization.target.changeId,
              investigationId: observedInvestigationId,
            },
      ),
      nextInvestigationId,
      nextDigest: investigationCurrentRefDigest(
        nextInvestigationId === null
          ? null
          : {
              changeId: authorization.target.changeId,
              investigationId: nextInvestigationId,
            },
      ),
    };
  }

  function releasesGenerationNamespace(
    decision: HumanResolutionNode['decision'],
  ): boolean {
    return (
      decision.kind === 'abort' ||
      decision.kind === 'quarantine' ||
      (decision.kind === 'supersede' &&
        decision.parameters.successorInvestigationId === null)
    );
  }

  function planHumanResolutionStartReservation(
    context: ReturnType<typeof loadInvestigationRuntimeContext>,
    authorization: HumanResolutionExecutionAuthorization,
    state: InvestigationResolutionState,
  ): HumanResolutionJournal['plannedStartReservation'] {
    const decision = authorization.decision;
    if (
      (decision.kind === 'repair' ||
        (decision.kind === 'supersede' &&
          decision.parameters.successorInvestigationId !== null)) &&
      decision.parameters.successorInvestigationId !== null
    ) {
      throw workflowError(
        'HUMAN_RESOLUTION_SUCCESSOR_BINDING_MISSING',
        'A successor resolution requires a complete versioned start and evidence binding.',
        ExitCode.guard,
      );
    }
    let snapshot: ReturnType<typeof readInvestigationStartReservationSnapshot>;
    try {
      snapshot = readInvestigationStartReservationSnapshot(
        context.runtime,
        authorization.target.changeId,
      );
    } catch (error) {
      if (
        decision.kind !== 'quarantine' ||
        state.envelope.ambiguityDigest === null ||
        state.envelope.startReservationDigest === null
      ) {
        throw error;
      }
      return {
        mode: 'quarantine-whole',
        expectedDigest: state.envelope.startReservationDigest,
        nextDigest: null,
        archiveDigest: state.envelope.startReservationDigest,
      };
    }
    if (snapshot.digest !== state.envelope.startReservationDigest) {
      throw workflowError(
        'HUMAN_RESOLUTION_GRANT_STALE',
        'Investigation start reservation changed after grant issuance.',
        ExitCode.staleState,
      );
    }
    if (!releasesGenerationNamespace(decision) || snapshot.digest === null) {
      return {
        mode: 'preserve',
        expectedDigest: snapshot.digest,
        nextDigest: snapshot.digest,
        archiveDigest: null,
      };
    }
    if (
      snapshot.reservation?.changeId !== authorization.target.changeId ||
      snapshot.reservation.investigationId !==
        authorization.target.workflowId ||
      snapshot.rawDocument === null
    ) {
      throw humanResolutionRecoveryAmbiguous();
    }
    archiveHumanResolutionSingleton(
      context.runtime,
      'start-reservation',
      snapshot.digest,
      snapshot.rawDocument,
      true,
    );
    return {
      mode: 'retire',
      expectedDigest: snapshot.digest,
      nextDigest: null,
      archiveDigest: snapshot.digest,
    };
  }

  function planHumanResolutionEvidenceRefs(
    context: ReturnType<typeof loadInvestigationRuntimeContext>,
    authorization: HumanResolutionExecutionAuthorization,
    state: InvestigationResolutionState,
  ): HumanResolutionJournal['plannedEvidenceRefs'] {
    const quarantineWhole =
      (): HumanResolutionJournal['plannedEvidenceRefs'] => ({
        mode: 'quarantine-whole',
        expectedDigest: state.envelope.evidenceRefsDigest,
        nextDigest: null,
        expectedClosureDigest: state.envelope.evidenceRefsClosureDigest,
        nextClosureDigest: null,
        retiredRefs: {},
        retainedRefs: {},
        archiveDigest: state.envelope.evidenceRefsDigest,
      });
    if (
      authorization.decision.kind === 'quarantine' &&
      state.envelope.ambiguityDigest !== null &&
      state.envelope.evidenceRefs === null &&
      state.envelope.evidenceRefsDigest !== null &&
      state.envelope.evidenceRefsClosureDigest === null
    ) {
      return quarantineWhole();
    }
    let closure: ReturnType<typeof readInvestigationEvidenceRefsClosure>;
    try {
      closure = readInvestigationEvidenceRefsClosure(
        context.runtime,
        authorization.target.changeId,
      );
    } catch (error) {
      if (
        authorization.decision.kind !== 'quarantine' ||
        state.envelope.ambiguityDigest === null ||
        state.envelope.evidenceRefsDigest === null
      ) {
        throw error;
      }
      return quarantineWhole();
    }
    const snapshot = closure.snapshot;
    if (
      snapshot.digest !== state.envelope.evidenceRefsDigest ||
      canonicalJson(snapshot.refs) !==
        canonicalJson(state.envelope.evidenceRefs) ||
      closure.closureDigest !== state.envelope.evidenceRefsClosureDigest
    ) {
      throw workflowError(
        'HUMAN_RESOLUTION_GRANT_STALE',
        'Investigation evidence refs changed after grant issuance.',
        ExitCode.staleState,
      );
    }
    const currentRefs = { ...(snapshot.refs ?? {}) };
    if (!releasesGenerationNamespace(authorization.decision)) {
      return {
        mode: 'preserve',
        expectedDigest: snapshot.digest,
        nextDigest: snapshot.digest,
        expectedClosureDigest: closure.closureDigest,
        nextClosureDigest: closure.closureDigest,
        retiredRefs: {},
        retainedRefs: currentRefs,
        archiveDigest: null,
      };
    }
    const retiredRefs: Record<string, string> = {};
    const retainedRefs: Record<string, string> = {};
    for (const [refName, nodeId] of Object.entries(currentRefs)) {
      const owner = closure.owners[refName];
      if (owner === undefined) {
        throw humanResolutionRecoveryAmbiguous();
      }
      if (owner === authorization.target.workflowId) {
        retiredRefs[refName] = nodeId;
      } else {
        retainedRefs[refName] = nodeId;
      }
    }
    if (Object.keys(retiredRefs).length === 0) {
      return {
        mode: 'preserve',
        expectedDigest: snapshot.digest,
        nextDigest: snapshot.digest,
        expectedClosureDigest: closure.closureDigest,
        nextClosureDigest: closure.closureDigest,
        retiredRefs: {},
        retainedRefs,
        archiveDigest: null,
      };
    }
    if (snapshot.digest === null || snapshot.rawDocument === null) {
      throw humanResolutionRecoveryAmbiguous();
    }
    archiveHumanResolutionSingleton(
      context.runtime,
      'evidence-refs',
      snapshot.digest,
      snapshot.rawDocument,
      false,
    );
    const nextDigest =
      Object.keys(retainedRefs).length === 0
        ? null
        : digest(
            canonicalJson({
              schemaVersion: 1,
              changeId: authorization.target.changeId,
              refs: retainedRefs,
            }),
          );
    const nextClosureDigest =
      Object.keys(retainedRefs).length === 0
        ? null
        : investigationEvidenceRefsClosureDigest(
            authorization.target.changeId,
            closure.entries.filter((entry) =>
              Object.hasOwn(retainedRefs, entry.refName),
            ),
          );
    return {
      mode: 'partition',
      expectedDigest: snapshot.digest,
      nextDigest,
      expectedClosureDigest: closure.closureDigest,
      nextClosureDigest,
      retiredRefs,
      retainedRefs,
      archiveDigest: snapshot.digest,
    };
  }

  function publishPlannedEvidenceRefs(
    context: ReturnType<typeof loadInvestigationRuntimeContext>,
    journal: HumanResolutionJournal,
  ): void {
    const planned = journal.plannedEvidenceRefs;
    if (planned.mode === 'quarantine-whole') {
      quarantineUnsafeEvidenceRefsDocument(
        context.runtime,
        journal.target.changeId,
        planned.expectedDigest as string,
      );
      return;
    }
    const nextRefs = planned.nextDigest === null ? null : planned.retainedRefs;
    const published = compareAndSwapEvidenceRefsDocument(context.runtime, {
      changeId: journal.target.changeId,
      expectedDigest: planned.expectedDigest,
      nextRefs,
    });
    if (published.digest !== planned.nextDigest) {
      throw humanResolutionRecoveryAmbiguous();
    }
    const closure = readInvestigationEvidenceRefsClosure(
      context.runtime,
      journal.target.changeId,
    );
    if (
      closure.snapshot.digest !== planned.nextDigest ||
      closure.closureDigest !== planned.nextClosureDigest ||
      canonicalJson(closure.snapshot.refs) !== canonicalJson(nextRefs)
    ) {
      throw humanResolutionRecoveryAmbiguous();
    }
  }

  function publishPlannedStartReservation(
    context: ReturnType<typeof loadInvestigationRuntimeContext>,
    journal: HumanResolutionJournal,
  ): void {
    const planned = journal.plannedStartReservation;
    if (planned.mode === 'quarantine-whole') {
      quarantineUnsafeInvestigationStartReservation(
        context.runtime,
        journal.target.changeId,
        planned.expectedDigest as string,
      );
      return;
    }
    if (planned.mode === 'retire') {
      const published = retireInvestigationStartReservation(context.runtime, {
        changeId: journal.target.changeId,
        expectedDigest: planned.expectedDigest,
      });
      if (published.digest !== planned.nextDigest) {
        throw humanResolutionRecoveryAmbiguous();
      }
      return;
    }
    const observed = readInvestigationStartReservationSnapshot(
      context.runtime,
      journal.target.changeId,
    );
    if (
      observed.digest !== planned.expectedDigest ||
      observed.digest !== planned.nextDigest
    ) {
      throw humanResolutionRecoveryAmbiguous();
    }
  }

  function publishPlannedCurrentInvestigationRef(
    context: ReturnType<typeof loadInvestigationRuntimeContext>,
    journal: HumanResolutionJournal,
    node: HumanResolutionNode,
    beforeState: InvestigationResolutionState,
  ): void {
    let observed: string | null;
    try {
      observed =
        readCurrentInvestigationRef(context.runtime, journal.target.changeId)
          ?.investigationId ?? null;
    } catch (error) {
      if (
        node.decision.kind !== 'quarantine' ||
        beforeState.envelope.ambiguityDigest === null ||
        beforeState.currentRefDigest === null
      ) {
        throw error;
      }
      quarantineUnsafeCurrentInvestigationRef(
        context.runtime,
        journal.target.changeId,
        beforeState.currentRefDigest,
      );
      observed = null;
    }
    const expected = journal.plannedCurrentWorkflowRef.expectedInvestigationId;
    const next = journal.plannedCurrentWorkflowRef.nextInvestigationId;
    if (observed === next) {
      return;
    }
    if (observed !== expected) {
      throw humanResolutionRecoveryAmbiguous();
    }
    if (expected !== next) {
      compareAndSwapCurrentInvestigationRef(
        context.runtime,
        journal.target.changeId,
        expected,
        next,
      );
    }
  }

  function assertRecoverableStateShape(
    context: ReturnType<typeof loadInvestigationRuntimeContext>,
    before: InvestigationResolutionState,
    journal: HumanResolutionJournal,
    repositoryId: string,
  ): void {
    const node = readHumanResolutionNode(
      context.runtime,
      journal.plannedResolutionNodeId,
    );
    const observed =
      node.decision.kind === 'quarantine'
        ? inspectInvestigationQuarantineState(
            context.runtime,
            journal.target.workflowId,
            repositoryId,
          )
        : inspectInvestigationResolutionState(
            context.runtime,
            journal.target.workflowId,
            repositoryId,
          );
    const stableObserved = {
      ...observed.envelope,
      currentRefDigest: before.envelope.currentRefDigest,
      startReservationDigest: before.envelope.startReservationDigest,
      evidenceRefs: before.envelope.evidenceRefs,
      evidenceRefsDigest: before.envelope.evidenceRefsDigest,
      evidenceRefsClosureDigest: before.envelope.evidenceRefsClosureDigest,
      resolutionHeadNodeId: before.envelope.resolutionHeadNodeId,
      ambiguityDigest:
        node.decision.kind === 'quarantine'
          ? before.envelope.ambiguityDigest
          : observed.envelope.ambiguityDigest,
    };
    const allowedObservedRefDigests =
      node.decision.kind === 'quarantine'
        ? [
            before.envelope.currentRefDigest,
            journal.plannedCurrentWorkflowRef.nextDigest,
          ]
        : [
            journal.plannedCurrentWorkflowRef.expectedDigest,
            journal.plannedCurrentWorkflowRef.nextDigest,
          ];
    const allowedStartReservationDigests = [
      journal.plannedStartReservation.expectedDigest,
      journal.plannedStartReservation.nextDigest,
    ];
    const allowedEvidenceRefsDigests = [
      journal.plannedEvidenceRefs.expectedDigest,
      journal.plannedEvidenceRefs.nextDigest,
    ];
    const allowedEvidenceRefsClosureDigests = [
      journal.plannedEvidenceRefs.expectedClosureDigest,
      journal.plannedEvidenceRefs.nextClosureDigest,
    ];
    const expectedEvidenceRefs =
      observed.envelope.evidenceRefsDigest ===
      journal.plannedEvidenceRefs.expectedDigest
        ? before.envelope.evidenceRefs
        : observed.envelope.evidenceRefsDigest ===
            journal.plannedEvidenceRefs.nextDigest
          ? journal.plannedEvidenceRefs.nextDigest === null
            ? null
            : journal.plannedEvidenceRefs.retainedRefs
          : undefined;
    if (
      canonicalJson(stableObserved) !== canonicalJson(before.envelope) ||
      !allowedObservedRefDigests.includes(observed.currentRefDigest) ||
      !allowedStartReservationDigests.includes(
        observed.envelope.startReservationDigest,
      ) ||
      !allowedEvidenceRefsDigests.includes(
        observed.envelope.evidenceRefsDigest,
      ) ||
      !allowedEvidenceRefsClosureDigests.includes(
        observed.envelope.evidenceRefsClosureDigest,
      ) ||
      expectedEvidenceRefs === undefined ||
      canonicalJson(observed.envelope.evidenceRefs) !==
        canonicalJson(expectedEvidenceRefs) ||
      ![
        journal.beforeResolutionRef,
        ...(journal.resolutionRefMode === 'quarantine-whole' ? [null] : []),
        journal.plannedResolutionNodeId,
      ].includes(observed.envelope.resolutionHeadNodeId)
    ) {
      throw humanResolutionRecoveryAmbiguous();
    }
  }

  function buildHumanResolutionReceipt(
    authorization: HumanResolutionExecutionAuthorization,
    journal: HumanResolutionJournal,
    node: HumanResolutionNode,
    afterStateDigest: string,
  ): Record<string, unknown> {
    return {
      schemaVersion: 1,
      kind: 'human-resolution-receipt',
      grantId: authorization.grantId,
      grantDigest: journal.grantDigest,
      target: authorization.target,
      beforeStateDigest: journal.beforeStateDigest,
      afterStateDigest,
      resolutionNodeId: node.nodeId,
      resolutionRefMode: journal.resolutionRefMode,
      evidenceArchiveDigest: journal.evidenceArchiveDigest,
      decision: node.decision,
      consequences: node.consequences,
      plannedCurrentWorkflowRef: journal.plannedCurrentWorkflowRef,
      plannedStartReservation: journal.plannedStartReservation,
      plannedEvidenceRefs: journal.plannedEvidenceRefs,
      recordedAt: journal.createdAt,
    };
  }

  function updateHumanResolutionJournalPhase(
    journal: HumanResolutionJournal,
    phase: HumanResolutionJournal['phase'],
  ): HumanResolutionJournal {
    return createHumanResolutionJournal({
      phase,
      grantId: journal.grantId,
      grantDigest: journal.grantDigest,
      target: journal.target,
      beforeStateDigest: journal.beforeStateDigest,
      afterStateDigest: journal.afterStateDigest,
      beforeResolutionRef: journal.beforeResolutionRef,
      resolutionRefMode: journal.resolutionRefMode,
      plannedResolutionNodeId: journal.plannedResolutionNodeId,
      plannedCurrentWorkflowRef: journal.plannedCurrentWorkflowRef,
      plannedStartReservation: journal.plannedStartReservation,
      plannedEvidenceRefs: journal.plannedEvidenceRefs,
      evidenceArchiveDigest: journal.evidenceArchiveDigest,
      receiptDigest: journal.receiptDigest,
      createdAt: journal.createdAt,
    });
  }

  function publishHumanResolutionJournalPhase(
    context: ReturnType<typeof loadInvestigationRuntimeContext>,
    journal: HumanResolutionJournal,
    phase: Exclude<HumanResolutionJournal['phase'], 'grant-consumed'>,
  ): void {
    if (
      HUMAN_RESOLUTION_JOURNAL_PHASES.indexOf(journal.phase) >=
      HUMAN_RESOLUTION_JOURNAL_PHASES.indexOf(phase)
    ) {
      return;
    }
    writeHumanResolutionJournal(
      context.runtime,
      updateHumanResolutionJournalPhase(journal, phase),
    );
  }

  const HUMAN_RESOLUTION_JOURNAL_PHASES = [
    'prepared',
    'evidence-refs-published',
    'start-reservation-published',
    'current-ref-published',
    'state-published',
    'receipt-written',
    'completed',
    'grant-consumed',
  ] as const satisfies readonly HumanResolutionJournal['phase'][];

  function readHumanResolutionNodeForRecovery(
    paths: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
    journal: HumanResolutionJournal,
  ): HumanResolutionNode {
    const node = readHumanResolutionNode(
      paths,
      journal.plannedResolutionNodeId,
    );
    if (
      node.grantId !== journal.grantId ||
      node.grantDigest !== journal.grantDigest ||
      node.previousResolutionNodeId !== journal.beforeResolutionRef ||
      node.target.workflowId !== journal.target.workflowId
    ) {
      throw humanResolutionRecoveryAmbiguous();
    }
    return node;
  }

  function maybeSimulateHumanResolutionCrash(
    options: HumanResolutionExecutionOptions,
    phase: NonNullable<HumanResolutionExecutionOptions['simulateCrashAfter']>,
  ): void {
    if (options.simulateCrashAfter === phase) {
      throw new SimulatedHumanResolutionCrash(phase);
    }
  }

  function exactHumanResolutionDate(value: Date): Date {
    const date = copyGrantDate(value);
    if (date === null) {
      throw workflowError(
        'HUMAN_RESOLUTION_TIME_INVALID',
        'Human resolution requires an exact timestamp.',
        ExitCode.guard,
      );
    }
    return date;
  }

  function humanResolutionRecoveryAmbiguous() {
    return workflowError(
      'HUMAN_RESOLUTION_RECOVERY_AMBIGUOUS',
      'Human resolution recovery observed state outside the exact journal.',
      ExitCode.staleState,
    );
  }

  function digest(value: string): string {
    return crypto.createHash('sha256').update(value).digest('hex');
  }
  return {
    inspectHumanResolutionGrants,
    inspectHumanResolutionGrantPublicationRecoveries,
    discardHumanResolutionGrantPublication,
    revokeHumanResolutionGrant,
    executeGrantCoreHumanResolution,
  };
}

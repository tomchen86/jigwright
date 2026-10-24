/**
 * Inspects exact investigation state and observations required for resolution or quarantine.
 *
 * Invariants:
 * - Sessions, refs, journals, grants, and provider evidence retain their exact owner bindings.
 * - Quarantine observations preserve ambiguity and never silently discard unsafe state.
 */
import path from 'node:path';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { type InvestigationRuntimePaths } from '../paths/runtime-paths.ts';
import { assertInvestigationId } from '../../foundation/repository-path/repository-path.ts';
import {
  observeInvestigationEvidenceRefsAmbiguities,
  readInvestigationEvidenceRefsClosure,
} from './evidence-ref-closure.ts';
import {
  type HumanResolutionNode,
  type InvestigationResolutionState,
  type InvestigationResolutionStateEnvelope,
  advertisedHumanResolutions,
  effectiveHumanResolutionState,
  humanResolutionDecisionSchemaDigest,
  investigationResolutionStateDigest,
  terminalHumanResolutionState,
} from '../../modules/investigation/domain/human-resolution-contract.ts';
import {
  assertEvidenceClosureTargetBinding,
  digestBoundStartReservation,
} from './human-resolution-evidence-binding.ts';
import {
  readHumanResolutionArchive,
  readHumanResolutionJournal,
} from '../lifecycle-ledgers/human-resolution-journal.ts';
import {
  readHumanResolutionHead,
  readHumanResolutionHeadReference,
  readHumanResolutionNode,
} from './human-resolution-nodes.ts';
import {
  type BoundProviderRetryReservation,
  bindProviderInvocationResolutionState,
  bindProviderRetryReservationResolutionState,
  observeProviderRetryReservationAmbiguities,
} from './human-resolution-provider-state.ts';
import {
  currentInvestigationRefPath,
  humanResolutionNodePath,
  humanResolutionRefPath,
  humanResolutionStateInvalid,
  investigationStartReservationPath,
  normalizeAmbiguityObservations,
  observeUnsafePath,
  startReservationUnsafe,
} from '../journal-primitives/investigation-resolution-values.ts';
import { isBoundedResolutionText } from '../../modules/investigation/domain/human-resolution-values.ts';
import {
  readCurrentInvestigationRef,
  readInvestigationSession,
} from './investigation-session-records.ts';
import {
  deepFreeze,
  providerInvocationUnsafe,
  sha256,
} from '../../modules/investigation/domain/investigation-store-values.ts';
import { digestPrivateDirectoryEntries } from './provider-runtime-retention.ts';

export function inspectInvestigationResolutionState(
  paths: InvestigationRuntimePaths,
  requestedInvestigationId: string,
  repositoryId: string,
): InvestigationResolutionState {
  if (!isBoundedResolutionText(repositoryId, 1024)) {
    throw humanResolutionStateInvalid();
  }
  const investigationId = assertInvestigationId(requestedInvestigationId);
  const session = readInvestigationSession(paths, investigationId);
  const currentRef = readCurrentInvestigationRef(paths, session.changeId);
  const currentRefDigest =
    currentRef === null ? null : sha256(`${canonicalJson(currentRef)}\n`);
  const startReservationDigest = digestBoundStartReservation(
    paths,
    session,
    startReservationUnsafe,
  );
  const resolutionHeadNodeId = readHumanResolutionHead(paths, investigationId);
  const resolutionNode =
    resolutionHeadNodeId === null
      ? null
      : readHumanResolutionNode(paths, resolutionHeadNodeId);
  if (
    resolutionNode !== null &&
    (resolutionNode.target.workflowId !== investigationId ||
      resolutionNode.target.changeId !== session.changeId)
  ) {
    throw humanResolutionStateInvalid();
  }
  const retryState = bindProviderRetryReservationResolutionState(
    paths,
    session,
    providerInvocationUnsafe,
  );
  const providerState = bindProviderInvocationResolutionState(
    paths,
    session,
    retryState.bindings,
  );
  const evidenceClosure = readInvestigationEvidenceRefsClosure(
    paths,
    session.changeId,
  );
  assertEvidenceClosureTargetBinding(paths, session, evidenceClosure);
  const evidenceRefsDigest = evidenceClosure.snapshot.digest;
  const evidenceRefs =
    evidenceClosure.snapshot.refs === null
      ? null
      : { ...evidenceClosure.snapshot.refs };
  const evidenceRefsClosureDigest = evidenceClosure.closureDigest;
  const blockerDigest =
    session.blocker === null ? null : sha256(canonicalJson(session.blocker));
  const envelope: InvestigationResolutionStateEnvelope = {
    schemaVersion: 2,
    workflowKind: 'investigation',
    repositoryId,
    changeId: session.changeId,
    investigationId,
    sessionDigest: sha256(`${canonicalJson(session)}\n`),
    sessionRevision: session.revision,
    currentRefDigest,
    startReservationDigest,
    resolutionHeadNodeId,
    providerInvocationDigests: providerState.providerInvocationDigests,
    providerRetryReservations: retryState.reservations,
    repositoryProviderLeases: providerState.repositoryProviderLeases,
    evidenceRefs,
    evidenceRefsDigest,
    evidenceRefsClosureDigest,
    blockerDigest,
    ambiguityDigest: null,
  };
  const effectiveState = resolutionNode
    ? effectiveHumanResolutionState(resolutionNode, session.state)
    : session.state;
  const availableResolutions = terminalHumanResolutionState(effectiveState)
    ? []
    : advertisedHumanResolutions(session.blocker);
  return deepFreeze({
    envelope,
    currentStateDigest: investigationResolutionStateDigest(envelope),
    currentRefDigest,
    blocker: session.blocker,
    availableResolutions,
    effectiveState,
  });
}

export function inspectInvestigationQuarantineState(
  paths: InvestigationRuntimePaths,
  requestedInvestigationId: string,
  repositoryId: string,
): InvestigationResolutionState {
  try {
    const strict = inspectInvestigationResolutionState(
      paths,
      requestedInvestigationId,
      repositoryId,
    );
    if (strict.effectiveState !== 'quarantined-by-human-resolution') {
      return strict;
    }
    const nodeId = strict.envelope.resolutionHeadNodeId;
    if (nodeId === null) {
      throw humanResolutionStateInvalid();
    }
    const node = readHumanResolutionNode(paths, nodeId);
    const journal = readHumanResolutionJournal(paths, node.grantId);
    if (
      journal === null ||
      journal.plannedResolutionNodeId !== nodeId ||
      journal.beforeStateDigest !== node.expected.stateDigest
    ) {
      throw humanResolutionStateInvalid();
    }
    const before = readHumanResolutionArchive(
      paths,
      journal.evidenceArchiveDigest,
    );
    const envelope = {
      ...strict.envelope,
      ambiguityDigest: before.envelope.ambiguityDigest,
    };
    return deepFreeze({
      ...strict,
      envelope,
      currentStateDigest: investigationResolutionStateDigest(envelope),
    });
  } catch {
    // Quarantine never treats malformed dependencies as valid. It records
    // bounded no-follow observations so a root human can remove the target
    // from the active namespace without inventing a repaired interpretation.
  }
  if (!isBoundedResolutionText(repositoryId, 1024)) {
    throw humanResolutionStateInvalid();
  }
  const investigationId = assertInvestigationId(requestedInvestigationId);
  const session = readInvestigationSession(paths, investigationId);
  const ambiguities: Array<{
    object: string;
    observationDigest: string;
  }> = [];
  let currentRefDigest: string | null;
  try {
    const currentRef = readCurrentInvestigationRef(paths, session.changeId);
    currentRefDigest =
      currentRef === null ? null : sha256(`${canonicalJson(currentRef)}\n`);
  } catch {
    currentRefDigest = observeUnsafePath(
      currentInvestigationRefPath(paths, session.changeId),
      'current-ref',
      ambiguities,
    );
  }
  let startReservationDigest: string | null;
  try {
    startReservationDigest = digestBoundStartReservation(
      paths,
      session,
      startReservationUnsafe,
    );
  } catch {
    startReservationDigest = observeUnsafePath(
      investigationStartReservationPath(paths, session.changeId),
      'start-reservation',
      ambiguities,
    );
  }
  let resolutionHeadNodeId: string | null;
  let resolutionNode: HumanResolutionNode | null = null;
  try {
    resolutionHeadNodeId = readHumanResolutionHeadReference(
      paths,
      investigationId,
    );
    if (resolutionHeadNodeId !== null) {
      try {
        resolutionNode = readHumanResolutionNode(paths, resolutionHeadNodeId);
      } catch {
        observeUnsafePath(
          humanResolutionNodePath(paths, resolutionHeadNodeId),
          `resolution-node:${resolutionHeadNodeId}`,
          ambiguities,
        );
      }
    }
  } catch {
    observeUnsafePath(
      humanResolutionRefPath(paths, investigationId),
      'resolution-ref',
      ambiguities,
    );
    resolutionHeadNodeId = null;
  }
  let providerRetryReservations: InvestigationResolutionStateEnvelope['providerRetryReservations'];
  let providerRetryBindings: BoundProviderRetryReservation[] = [];
  try {
    const retryState = bindProviderRetryReservationResolutionState(
      paths,
      session,
      providerInvocationUnsafe,
    );
    providerRetryReservations = retryState.reservations;
    providerRetryBindings = retryState.bindings;
  } catch {
    providerRetryReservations = [];
    observeProviderRetryReservationAmbiguities(paths, session, ambiguities);
  }
  let providerInvocationDigests: InvestigationResolutionStateEnvelope['providerInvocationDigests'];
  let repositoryProviderLeases: InvestigationResolutionStateEnvelope['repositoryProviderLeases'];
  try {
    const providerState = bindProviderInvocationResolutionState(
      paths,
      session,
      providerRetryBindings,
    );
    providerInvocationDigests = providerState.providerInvocationDigests;
    repositoryProviderLeases = providerState.repositoryProviderLeases;
  } catch {
    providerInvocationDigests = session.blindInvocationIds.map(
      (invocationId) => {
        try {
          return {
            invocationId,
            files: digestPrivateDirectoryEntries(
              paths,
              path.join(paths.invocations, invocationId),
              providerInvocationUnsafe,
            ),
          };
        } catch {
          const digestValue = observeUnsafePath(
            path.join(paths.invocations, invocationId),
            `provider-invocation:${invocationId}`,
            ambiguities,
          );
          return {
            invocationId,
            files: [{ name: 'unsafe-observation', digest: digestValue }],
          };
        }
      },
    );
    repositoryProviderLeases = [];
    observeUnsafePath(paths.invocations, 'provider-invocations', ambiguities);
  }
  let evidenceRefs: Record<string, string> | null;
  let evidenceRefsDigest: string | null;
  let evidenceRefsClosureDigest: string | null;
  try {
    const evidenceClosure = readInvestigationEvidenceRefsClosure(
      paths,
      session.changeId,
    );
    assertEvidenceClosureTargetBinding(paths, session, evidenceClosure);
    evidenceRefsDigest = evidenceClosure.snapshot.digest;
    evidenceRefs =
      evidenceClosure.snapshot.refs === null
        ? null
        : { ...evidenceClosure.snapshot.refs };
    evidenceRefsClosureDigest = evidenceClosure.closureDigest;
  } catch {
    evidenceRefs = null;
    evidenceRefsClosureDigest = null;
    const observations = observeInvestigationEvidenceRefsAmbiguities(
      paths,
      session.changeId,
    );
    ambiguities.push(...observations);
    evidenceRefsDigest =
      observations.find(({ object }) => object === 'evidence-refs')
        ?.observationDigest ?? null;
  }
  if (ambiguities.length === 0) {
    throw humanResolutionStateInvalid();
  }
  const normalizedAmbiguities = normalizeAmbiguityObservations(ambiguities);
  const ambiguityDigest = sha256(
    canonicalJson({
      schema: 'investigation-quarantine-observation.v1',
      ambiguities: normalizedAmbiguities,
    }),
  );
  const blockerDigest =
    session.blocker === null ? null : sha256(canonicalJson(session.blocker));
  const envelope: InvestigationResolutionStateEnvelope = {
    schemaVersion: 2,
    workflowKind: 'investigation',
    repositoryId,
    changeId: session.changeId,
    investigationId,
    sessionDigest: sha256(`${canonicalJson(session)}\n`),
    sessionRevision: session.revision,
    currentRefDigest,
    startReservationDigest,
    resolutionHeadNodeId,
    providerInvocationDigests,
    providerRetryReservations,
    repositoryProviderLeases,
    evidenceRefs,
    evidenceRefsDigest,
    evidenceRefsClosureDigest,
    blockerDigest,
    ambiguityDigest,
  };
  const effectiveState =
    resolutionNode === null
      ? ('human-action-required' as const)
      : effectiveHumanResolutionState(resolutionNode, 'human-action-required');
  return deepFreeze({
    envelope,
    currentStateDigest: investigationResolutionStateDigest(envelope),
    currentRefDigest,
    blocker: session.blocker,
    availableResolutions: terminalHumanResolutionState(effectiveState)
      ? []
      : [
          {
            kind: 'quarantine',
            parameterSchemaDigest:
              humanResolutionDecisionSchemaDigest('quarantine'),
          },
        ],
    effectiveState,
  });
}

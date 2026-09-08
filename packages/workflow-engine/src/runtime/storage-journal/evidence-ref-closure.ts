/**
 * Builds exact investigation evidence ref closures and ambiguity observations.
 *
 * Invariants:
 * - Every ref and dependency retains validated ownership and canonical digest identity.
 * - Unsafe observations remain explicit and closure entries keep their original ordering.
 *
 * Depends on: ref snapshots, evidence readers, and planning and review ownership validators.
 * Failure modes: a closure silently omits unsafe evidence or assigns refs to the wrong investigation.
 */
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import {
  type EvidenceNode,
  canonicalEvidenceNodeEnvelope,
} from '../../foundation/evidence-node/evidence-node.ts';
import {
  type InvestigationRuntimePaths,
  assertChangeId,
  assertInvestigationId,
} from '../session-workspace/paths.ts';
import { readEvidenceNode } from './evidence-node-store.ts';
import { assertPlanReviewGrantRequirementOwnership } from './evidence-plan-review-grants.ts';
import { assertPlanReviewRequestOwnership } from './evidence-plan-review-ownership.ts';
import {
  type InvestigationEvidenceOwnership,
  assertExemptionSessionOwnership,
  assertPlanningMaterializationOwnership,
} from './evidence-planning-ownership.ts';
import {
  type EvidenceRefsSnapshot,
  readEvidenceRefsSnapshot,
} from './evidence-ref-store.ts';
import {
  DIGEST_PATTERN,
  REF_NAME_PATTERN,
  evidenceObjectPath,
  evidenceRefPath,
  refInvalid,
  refUnsafe,
  sha256,
} from './evidence-store-values.ts';
import { exactUnsafePathObservationDigest } from './evidence-unsafe-observation.ts';

export type InvestigationEvidenceRefsClosure = Readonly<{
  snapshot: EvidenceRefsSnapshot;
  closureDigest: string | null;
  owners: Readonly<Record<string, string>>;
  entries: readonly InvestigationEvidenceRefClosureEntry[];
}>;

export type InvestigationEvidenceRefClosureEntry = Readonly<{
  refName: string;
  nodeId: string;
  resultDigest: string;
  envelopeDigest: string;
  ownerInvestigationId: string;
  dependencies: readonly InvestigationEvidenceDependencyClosureEntry[];
}>;

export type InvestigationEvidenceDependencyClosureEntry = Readonly<{
  role: string;
  nodeId: string;
  resultDigest: string;
  envelopeDigest: string;
}>;

export function readInvestigationEvidenceRefsClosure(
  paths: InvestigationRuntimePaths,
  requestedChangeId: string,
): InvestigationEvidenceRefsClosure {
  const changeId = assertChangeId(requestedChangeId);
  const snapshot = readEvidenceRefsSnapshot(paths, changeId);
  if (snapshot.refs === null) {
    return Object.freeze({
      snapshot,
      closureDigest: null,
      owners: Object.freeze({}),
      entries: Object.freeze([]),
    });
  }
  const closure = computeInvestigationEvidenceRefsClosure(
    paths,
    changeId,
    snapshot.refs,
  );
  return Object.freeze({
    snapshot,
    ...closure,
  });
}

export function observeInvestigationEvidenceRefsAmbiguities(
  paths: InvestigationRuntimePaths,
  requestedChangeId: string,
): Array<{ object: string; observationDigest: string }> {
  const changeId = assertChangeId(requestedChangeId);
  const observations = new Map<string, string>();
  const observe = (object: string, filePath: string) => {
    observations.set(
      object,
      exactUnsafePathObservationDigest(filePath, object),
    );
  };
  const refPath = evidenceRefPath(paths, changeId);
  observe('evidence-refs', refPath);
  let snapshot: EvidenceRefsSnapshot;
  try {
    snapshot = readEvidenceRefsSnapshot(paths, changeId);
  } catch {
    return sortedAmbiguityObservations(observations);
  }
  if (snapshot.refs === null) {
    return sortedAmbiguityObservations(observations);
  }
  const pending = Object.values(snapshot.refs).sort();
  const visited = new Set<string>();
  while (pending.length > 0) {
    const nodeId = pending.shift();
    if (!nodeId || visited.has(nodeId)) {
      continue;
    }
    if (visited.size >= 4096) {
      throw refUnsafe();
    }
    visited.add(nodeId);
    observe(`evidence-node:${nodeId}`, evidenceObjectPath(paths, nodeId));
    try {
      const node = readEvidenceNode(paths, nodeId);
      pending.push(
        ...Object.values(node.provenanceParentNodeIds)
          .filter((parentId) => !visited.has(parentId))
          .sort(),
      );
    } catch {
      // The exact missing or malformed causal object is already observed.
    }
  }
  return sortedAmbiguityObservations(observations);
}

function sortedAmbiguityObservations(
  observations: ReadonlyMap<string, string>,
): Array<{ object: string; observationDigest: string }> {
  return [...observations]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([object, observationDigest]) => ({ object, observationDigest }));
}

export function computeInvestigationEvidenceRefsClosure(
  paths: InvestigationRuntimePaths,
  requestedChangeId: string,
  refs: Readonly<Record<string, string>>,
): Pick<
  InvestigationEvidenceRefsClosure,
  'closureDigest' | 'owners' | 'entries'
> {
  const changeId = assertChangeId(requestedChangeId);
  const owners: Record<string, string> = {};
  const entries: InvestigationEvidenceRefClosureEntry[] = Object.entries(refs)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([refName, nodeId]) => {
      const node = readEvidenceNode(paths, nodeId);
      const ownership = assertInvestigationEvidenceRefOwner(
        paths,
        refs,
        refName,
        node,
        changeId,
      );
      owners[refName] = ownership.ownerInvestigationId;
      return Object.freeze({
        refName,
        nodeId,
        resultDigest: node.resultDigest,
        envelopeDigest: sha256(canonicalEvidenceNodeEnvelope(node)),
        ownerInvestigationId: ownership.ownerInvestigationId,
        dependencies: ownership.dependencies,
      });
    });
  return Object.freeze({
    closureDigest: investigationEvidenceRefsClosureDigest(changeId, entries),
    owners: Object.freeze(owners),
    entries: Object.freeze(entries),
  });
}

export function investigationEvidenceRefsClosureDigest(
  requestedChangeId: string,
  entries: readonly InvestigationEvidenceRefClosureEntry[],
): string {
  const changeId = assertChangeId(requestedChangeId);
  const sorted = [...entries].sort((left, right) =>
    left.refName.localeCompare(right.refName),
  );
  if (
    sorted.some(
      (entry, index) =>
        entry.refName !== entries[index]?.refName ||
        !REF_NAME_PATTERN.test(entry.refName) ||
        !DIGEST_PATTERN.test(entry.nodeId) ||
        !DIGEST_PATTERN.test(entry.resultDigest) ||
        !DIGEST_PATTERN.test(entry.envelopeDigest) ||
        assertInvestigationId(entry.ownerInvestigationId) !==
          entry.ownerInvestigationId ||
        !Array.isArray(entry.dependencies) ||
        entry.dependencies.some(
          (dependency, dependencyIndex) =>
            dependency.role.length === 0 ||
            dependency.role !==
              [...entry.dependencies].sort((left, right) =>
                left.role.localeCompare(right.role),
              )[dependencyIndex]?.role ||
            !DIGEST_PATTERN.test(dependency.nodeId) ||
            !DIGEST_PATTERN.test(dependency.resultDigest) ||
            !DIGEST_PATTERN.test(dependency.envelopeDigest),
        ),
    )
  ) {
    throw refInvalid();
  }
  return sha256(
    canonicalJson({
      schemaVersion: 1,
      changeId,
      entries,
    }),
  );
}

function assertInvestigationEvidenceRefOwner(
  paths: InvestigationRuntimePaths,
  refs: Readonly<Record<string, string>>,
  refName: string,
  node: EvidenceNode,
  expectedChangeId: string,
): InvestigationEvidenceOwnership {
  try {
    switch (refName) {
      case 'propose/planning-materialization':
        return assertPlanningMaterializationOwnership(
          paths,
          node,
          expectedChangeId,
        );
      case 'propose/plan-review-request':
        return assertPlanReviewRequestOwnership(
          paths,
          refs,
          node,
          expectedChangeId,
        );
      case 'propose/plan-review-grant-requirement':
        return assertPlanReviewGrantRequirementOwnership(
          node,
          expectedChangeId,
        );
      case 'propose/exemption-session':
        return assertExemptionSessionOwnership(paths, node, expectedChangeId);
      default:
        throw refInvalid();
    }
  } catch {
    throw refInvalid();
  }
}

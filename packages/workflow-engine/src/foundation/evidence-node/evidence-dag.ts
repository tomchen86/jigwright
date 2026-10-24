/**
 * Validates the closed, topologically ordered evidence dependency DAG.
 *
 * Invariants:
 * - Every provenance edge resolves inside the validated set and carries its
 *   parent's exact recorded result.
 */
import { ExitCode, workflowError } from '../errors/errors.ts';
import {
  assertStoredEvidenceNode,
  type EvidenceNode,
} from './evidence-node.ts';

/**
 * Validate a closed, topologically ordered ordinary dependency DAG over its
 * provenance edges. Every node envelope is revalidated by recomputing both
 * digests, so a node whose stored id or result was forged fails closed. Node
 * types are open — any well-formed future node (for example an investigation-why
 * node) is accepted — but each node's semantic-parent roles must correspond
 * exactly to its provenance-parent roles, and every recorded semantic result
 * must equal the resolved parent's result. A duplicate `nodeId` (including a
 * same-id/different-output collision), a provenance edge to a node absent from
 * the set, a semantic/provenance role mismatch, a forged parent result, or a
 * provenance cycle is rejected. The
 * returned topological order is deterministic regardless of input order: ready
 * nodes are always emitted in ascending `nodeId` order, so a pure sink such as
 * an investigation coverage node lands last.
 */
export function validateClosedEvidenceDag(nodes: EvidenceNode[]): {
  topologicalNodeIds: string[];
} {
  const validated = nodes.map((node) =>
    assertStoredEvidenceNode(node, dagInvalid),
  );

  const byId = new Map<string, EvidenceNode>();
  for (const node of validated) {
    if (byId.has(node.nodeId)) {
      throw dagInvalid();
    }
    byId.set(node.nodeId, node);
  }

  const remainingIndegree = new Map<string, number>();
  const children = new Map<string, string[]>();
  for (const node of validated) {
    remainingIndegree.set(node.nodeId, 0);
    children.set(node.nodeId, []);
  }
  for (const node of validated) {
    const provenanceRoles = Object.keys(node.provenanceParentNodeIds);
    const semanticRoles = Object.keys(node.semanticParentResultDigests);
    if (
      provenanceRoles.length !== semanticRoles.length ||
      !provenanceRoles.every((role) =>
        Object.prototype.hasOwnProperty.call(
          node.semanticParentResultDigests,
          role,
        ),
      )
    ) {
      throw dagInvalid();
    }
    const parents = new Set<string>();
    for (const role of provenanceRoles) {
      const parentId = node.provenanceParentNodeIds[role]!;
      const parent = byId.get(parentId);
      if (!parent) {
        throw dagInvalid();
      }
      if (node.semanticParentResultDigests[role] !== parent.resultDigest) {
        throw dagInvalid();
      }
      parents.add(parentId);
    }
    for (const parentId of parents) {
      children.get(parentId)!.push(node.nodeId);
    }
    remainingIndegree.set(node.nodeId, parents.size);
  }

  const ready: string[] = [];
  for (const [nodeId, indegree] of remainingIndegree) {
    if (indegree === 0) {
      ready.push(nodeId);
    }
  }
  const order: string[] = [];
  while (ready.length > 0) {
    ready.sort();
    const nodeId = ready.shift()!;
    order.push(nodeId);
    for (const child of children.get(nodeId)!) {
      const next = remainingIndegree.get(child)! - 1;
      remainingIndegree.set(child, next);
      if (next === 0) {
        ready.push(child);
      }
    }
  }
  if (order.length !== validated.length) {
    throw dagInvalid();
  }
  return { topologicalNodeIds: order };
}

function dagInvalid() {
  return workflowError(
    'EVIDENCE_DAG_INVALID',
    'Closed evidence DAG is malformed.',
    ExitCode.usage,
  );
}

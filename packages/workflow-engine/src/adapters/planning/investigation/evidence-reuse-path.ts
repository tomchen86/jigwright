import crypto from 'node:crypto';

import { canonicalJson } from '../../../foundation/canonical-json/canonical-json.ts';
import {
  readConvergenceBinding,
  readReuseProofBinding,
} from './evidence-convergence.ts';
import { evaluateEvidenceCurrentness } from './evidence-currentness.ts';
import {
  assertStoredEvidenceNode,
  createEvidenceNode,
  type EvidenceNode,
} from './evidence-node.ts';
import { ExitCode, workflowError } from '../../../foundation/errors/errors.ts';

const EVIDENCE_CURRENTNESS_VALIDATOR_VERSION = 'evidence-currentness.v1';

const INVENTORY_CURRENTNESS_TYPE = 'investigation-inventory-currentness';
const INVENTORY_CURRENTNESS_SCHEMA = 'investigation.inventory-currentness.v1';
const INVENTORY_CURRENTNESS_EVALUATOR =
  'investigation.inventory-currentness.v1';
const INVENTORY_CURRENTNESS_OUTPUT_SCHEMA =
  'investigation.inventory-currentness-output.v1';
const INVENTORY_TYPE = 'investigation-tree-inventory';
const INVENTORY_SCHEMA = 'investigation.tree-inventory.v1';
const INVENTORY_EVALUATOR = 'investigation-scanner.v1';
const INVENTORY_OUTPUT_SCHEMA = 'investigation.tree-inventory-output.v1';
const SEALED_INVESTIGATION_REUSE_SCHEMA = 'investigation.seal.v2';
const SEALED_INVESTIGATION_REUSE_EVALUATOR = 'workflow-propose.v2';
const SEALED_INVESTIGATION_REUSE_OUTPUT_SCHEMA = 'investigation.seal-output.v2';
const INVENTORY_CURRENTNESS_POLICY_DIGEST = crypto
  .createHash('sha256')
  .update(
    canonicalJson({
      schema: 'investigation.inventory-currentness-policy.v1',
      validatorVersion: EVIDENCE_CURRENTNESS_VALIDATOR_VERSION,
    }),
    'utf8',
  )
  .digest('hex');

const DIGEST = '[0-9a-f]{64}';
const CURRENT_PARENT_REF = new RegExp(
  `^current-parent/(${DIGEST})/(${DIGEST})$`,
);
const REUSE_PROOF_REF = new RegExp(`^reuse-proof/(${DIGEST})/(${DIGEST})$`);

type ReusePathPair = Readonly<{
  key: string;
  descendantNodeId: string;
  parentRoleDigest: string;
  newParentNodeId: string;
  proofNodeId: string;
  parentRole: string;
  proof: EvidenceNode;
  convergence: EvidenceNode;
}>;

/**
 * Bind the semantic inventory result to the exact inventory node that produced
 * it. The seal depends on this node, so a replacement inventory whose semantic
 * result converges can retain the prior currentness node only through the
 * tracked convergence/proof path validated below.
 */
function createInvestigationInventoryCurrentnessNode(
  inventoryNode: EvidenceNode,
): EvidenceNode {
  const inventory = assertStoredEvidenceNode(inventoryNode, reusePathInvalid);
  if (
    inventory.type !== INVENTORY_TYPE ||
    inventory.nodeSchema !== INVENTORY_SCHEMA ||
    inventory.evaluator !== INVENTORY_EVALUATOR ||
    inventory.outputSchema !== INVENTORY_OUTPUT_SCHEMA
  ) {
    throw reusePathInvalid();
  }
  return createEvidenceNode({
    type: INVENTORY_CURRENTNESS_TYPE,
    nodeSchema: INVENTORY_CURRENTNESS_SCHEMA,
    evaluator: INVENTORY_CURRENTNESS_EVALUATOR,
    policyDigest: INVENTORY_CURRENTNESS_POLICY_DIGEST,
    exactInputDigests: {},
    semanticParentResultDigests: { inventory: inventory.resultDigest },
    provenanceParentNodeIds: { inventory: inventory.nodeId },
    outputSchema: INVENTORY_CURRENTNESS_OUTPUT_SCHEMA,
    output: {
      inventoryResultDigest: inventory.resultDigest,
      complete: true,
    },
    runtimeMetadata: {},
  });
}

function assertInvestigationInventoryCurrentnessNode(
  node: EvidenceNode,
): EvidenceNode {
  const currentness = assertStoredEvidenceNode(node, reusePathInvalid);
  if (
    currentness.type !== INVENTORY_CURRENTNESS_TYPE ||
    currentness.nodeSchema !== INVENTORY_CURRENTNESS_SCHEMA ||
    currentness.evaluator !== INVENTORY_CURRENTNESS_EVALUATOR ||
    currentness.policyDigest !== INVENTORY_CURRENTNESS_POLICY_DIGEST ||
    currentness.outputSchema !== INVENTORY_CURRENTNESS_OUTPUT_SCHEMA ||
    Object.keys(currentness.exactInputDigests).length !== 0 ||
    canonicalJson(Object.keys(currentness.semanticParentResultDigests)) !==
      canonicalJson(['inventory']) ||
    canonicalJson(Object.keys(currentness.provenanceParentNodeIds)) !==
      canonicalJson(['inventory']) ||
    typeof currentness.output !== 'object' ||
    currentness.output === null ||
    Array.isArray(currentness.output)
  ) {
    throw reusePathInvalid();
  }
  const output = currentness.output as Record<string, unknown>;
  if (
    canonicalJson(Object.keys(output).sort()) !==
      canonicalJson(['complete', 'inventoryResultDigest']) ||
    output.complete !== true ||
    output.inventoryResultDigest !==
      currentness.semanticParentResultDigests.inventory
  ) {
    throw reusePathInvalid();
  }
  return currentness;
}

function evidenceParentRoleDigest(parentRole: string): string {
  if (parentRole.length === 0) throw reusePathInvalid();
  return crypto.createHash('sha256').update(parentRole, 'utf8').digest('hex');
}

/**
 * Validate the engine-owned current path for every retained descendant. A
 * changed edge is represented by two exact refs: one selects the current parent
 * and one selects the immutable proof. The proof and its convergence record are
 * accepted only when the descendant is reachable from an ordinary current ref,
 * every changed role is paired exactly once, and the shared currentness
 * evaluator independently accepts the complete direct-parent set.
 */
export function validateTrackedEvidenceReusePaths(
  nodes: readonly EvidenceNode[],
  currentRefs: Readonly<Record<string, string>>,
): void {
  const validated = nodes.map((node) =>
    assertStoredEvidenceNode(node, reusePathInvalid),
  );
  const byId = new Map(validated.map((node) => [node.nodeId, node]));
  for (const node of validated) {
    if (node.type === INVENTORY_CURRENTNESS_TYPE) {
      assertInvestigationInventoryCurrentnessNode(node);
      const inventory = byId.get(node.provenanceParentNodeIds.inventory!);
      if (
        !inventory ||
        createInvestigationInventoryCurrentnessNode(inventory).nodeId !==
          node.nodeId
      ) {
        throw reusePathInvalid();
      }
    }
    if (
      node.type === 'sealed-investigation' &&
      node.nodeSchema === SEALED_INVESTIGATION_REUSE_SCHEMA
    ) {
      const currentnessId =
        node.provenanceParentNodeIds['inventory-currentness'];
      const currentness = currentnessId ? byId.get(currentnessId) : undefined;
      if (
        node.evaluator !== SEALED_INVESTIGATION_REUSE_EVALUATOR ||
        node.outputSchema !== SEALED_INVESTIGATION_REUSE_OUTPUT_SCHEMA ||
        !currentness ||
        node.semanticParentResultDigests['inventory-currentness'] !==
          currentness.resultDigest
      ) {
        throw reusePathInvalid();
      }
      assertInvestigationInventoryCurrentnessNode(currentness);
    }
  }
  const currentParents = new Map<string, string>();
  const reuseProofs = new Map<string, string>();
  const ordinaryRootIds: string[] = [];

  for (const [refName, nodeId] of Object.entries(currentRefs)) {
    const parentMatch = CURRENT_PARENT_REF.exec(refName);
    const proofMatch = REUSE_PROOF_REF.exec(refName);
    if (parentMatch) {
      currentParents.set(`${parentMatch[1]}/${parentMatch[2]}`, nodeId);
      continue;
    }
    if (proofMatch) {
      reuseProofs.set(`${proofMatch[1]}/${proofMatch[2]}`, nodeId);
      continue;
    }
    if (
      refName.startsWith('current-parent/') ||
      refName.startsWith('reuse-proof/')
    ) {
      throw reusePathInvalid();
    }
    ordinaryRootIds.push(nodeId);
  }

  const specialNodes = validated.filter(isReusePathNode);
  if (currentParents.size === 0 && reuseProofs.size === 0) {
    if (specialNodes.length > 0) throw reusePathInvalid();
    return;
  }
  if (
    currentParents.size !== reuseProofs.size ||
    [...currentParents.keys()].some((key) => !reuseProofs.has(key))
  ) {
    throw reusePathInvalid();
  }

  const pairs: ReusePathPair[] = [];
  const consumedProofIds = new Set<string>();
  const consumedConvergenceIds = new Set<string>();
  for (const [key, newParentNodeId] of currentParents) {
    const [descendantNodeId, parentRoleDigest] = key.split('/');
    const proofNodeId = reuseProofs.get(key)!;
    const descendant = byId.get(descendantNodeId);
    const newParent = byId.get(newParentNodeId);
    const proof = byId.get(proofNodeId);
    const binding = proof ? readReuseProofBinding(proof) : null;
    const convergence = binding ? byId.get(binding.convergenceNode) : undefined;
    const convergenceBinding = convergence
      ? readConvergenceBinding(convergence)
      : null;
    if (
      !descendant ||
      !newParent ||
      !proof ||
      !binding ||
      !convergence ||
      !convergenceBinding ||
      isReusePathNode(descendant) ||
      isReusePathNode(newParent) ||
      binding.validatorVersion !== EVIDENCE_CURRENTNESS_VALIDATOR_VERSION ||
      binding.descendantNode !== descendantNodeId ||
      binding.newParentNode !== newParentNodeId ||
      binding.parentRole.length === 0 ||
      evidenceParentRoleDigest(binding.parentRole) !== parentRoleDigest ||
      descendant.provenanceParentNodeIds[binding.parentRole] !==
        binding.oldParentNode ||
      convergenceBinding.oldParentNode !== binding.oldParentNode ||
      convergenceBinding.newParentNode !== binding.newParentNode ||
      convergenceBinding.sharedResultDigest !== binding.sharedResultDigest
    ) {
      throw reusePathInvalid();
    }
    consumedProofIds.add(proof.nodeId);
    consumedConvergenceIds.add(convergence.nodeId);
    pairs.push({
      key,
      descendantNodeId,
      parentRoleDigest,
      newParentNodeId,
      proofNodeId,
      parentRole: binding.parentRole,
      proof,
      convergence,
    });
  }

  if (
    specialNodes.some(
      (node) =>
        (node.type === 'evidence-reuse-proof' &&
          !consumedProofIds.has(node.nodeId)) ||
        (node.type === 'evidence-convergence' &&
          !consumedConvergenceIds.has(node.nodeId)),
    )
  ) {
    throw reusePathInvalid();
  }

  const reachable = new Set<string>();
  const addOrdinaryClosure = (rootId: string): void => {
    const pending = [rootId];
    while (pending.length > 0) {
      const nodeId = pending.pop()!;
      if (reachable.has(nodeId)) continue;
      const node = byId.get(nodeId);
      if (!node || isReusePathNode(node)) throw reusePathInvalid();
      reachable.add(nodeId);
      pending.push(...Object.values(node.provenanceParentNodeIds));
    }
  };
  ordinaryRootIds.forEach(addOrdinaryClosure);
  let changed = true;
  while (changed) {
    changed = false;
    for (const pair of pairs) {
      if (
        reachable.has(pair.descendantNodeId) &&
        !reachable.has(pair.newParentNodeId)
      ) {
        addOrdinaryClosure(pair.newParentNodeId);
        changed = true;
      }
    }
  }
  if (pairs.some((pair) => !reachable.has(pair.descendantNodeId))) {
    throw reusePathInvalid();
  }

  const byDescendant = new Map<string, ReusePathPair[]>();
  for (const pair of pairs) {
    const grouped = byDescendant.get(pair.descendantNodeId) ?? [];
    grouped.push(pair);
    byDescendant.set(pair.descendantNodeId, grouped);
  }
  for (const [descendantNodeId, descendantPairs] of byDescendant) {
    const descendant = byId.get(descendantNodeId)!;
    const previousParents: Record<string, EvidenceNode> = {};
    const resolvedCurrentParents: Record<string, EvidenceNode> = {};
    for (const [role, parentNodeId] of Object.entries(
      descendant.provenanceParentNodeIds,
    )) {
      const parent = byId.get(parentNodeId);
      if (!parent || isReusePathNode(parent)) throw reusePathInvalid();
      previousParents[role] = parent;
      resolvedCurrentParents[role] = parent;
    }
    for (const pair of descendantPairs) {
      if (
        resolvedCurrentParents[pair.parentRole]?.nodeId !== pair.newParentNodeId
      ) {
        const next = byId.get(pair.newParentNodeId);
        if (!next) throw reusePathInvalid();
        resolvedCurrentParents[pair.parentRole] = next;
      } else {
        throw reusePathInvalid();
      }
    }
    const result = evaluateEvidenceCurrentness({
      node: descendant,
      expectedIdentity: {
        type: descendant.type,
        evaluator: descendant.evaluator,
        policyDigest: descendant.policyDigest,
        nodeSchema: descendant.nodeSchema,
        outputSchema: descendant.outputSchema,
      },
      expectedExactInputDigests: { ...descendant.exactInputDigests },
      previousParents,
      currentParents: resolvedCurrentParents,
      convergenceRecords: descendantPairs.map(({ convergence }) => convergence),
      reuseProofs: descendantPairs.map(({ proof }) => proof),
      validatorVersion: EVIDENCE_CURRENTNESS_VALIDATOR_VERSION,
    });
    if (
      !result.current ||
      canonicalJson(result.reusedParentRoles) !==
        canonicalJson(
          descendantPairs.map(({ parentRole }) => parentRole).sort(),
        )
    ) {
      throw reusePathInvalid();
    }
  }
}

function isReusePathNode(node: EvidenceNode): boolean {
  return (
    node.type === 'evidence-convergence' || node.type === 'evidence-reuse-proof'
  );
}

function reusePathInvalid() {
  return workflowError(
    'EVIDENCE_REUSE_PATH_INVALID',
    'Tracked descendant reuse path is malformed or incomplete.',
    ExitCode.verification,
  );
}

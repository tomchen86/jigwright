/**
 * Preserves workflow evidence identities and errors around the neutral core codec.
 *
 * Invariants:
 * - Canonical envelopes and node identities match the core evidence codec.
 * - Invalid inputs retain WorkflowError codes and exit statuses.
 */
import { CanonicalJsonError } from '@jigwright/core/canonical-json';
import {
  assertStoredEvidenceNode as assertCoreStoredEvidenceNode,
  canonicalEvidenceNodeEnvelope as canonicalCoreEvidenceNodeEnvelope,
  createEvidenceNode as createCoreEvidenceNode,
  type EvidenceNode,
  type EvidenceNodeInput,
} from '@jigwright/core/evidence-node';

import {
  ExitCode,
  workflowError,
  type WorkflowError,
} from '../errors/errors.ts';

export type { EvidenceNode, EvidenceNodeInput };

export function createEvidenceNode(input: EvidenceNodeInput): EvidenceNode {
  return createCoreEvidenceNode(input, nodeInvalid);
}

export function canonicalEvidenceNodeEnvelope(node: EvidenceNode): string {
  try {
    return canonicalCoreEvidenceNodeEnvelope(node);
  } catch (error) {
    if (error instanceof CanonicalJsonError) {
      throw workflowError(
        'CANONICAL_JSON_INVALID',
        'Value cannot be encoded as canonical JSON data.',
        ExitCode.usage,
      );
    }
    throw error;
  }
}

export function assertStoredEvidenceNode(
  value: unknown,
  invalid: () => WorkflowError,
): EvidenceNode {
  return assertCoreStoredEvidenceNode(value, invalid);
}

function nodeInvalid(): WorkflowError {
  return workflowError(
    'EVIDENCE_NODE_INVALID',
    'Evidence node input is malformed.',
    ExitCode.usage,
  );
}

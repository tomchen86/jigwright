/**
 * Verifies timeout authority against the exact durable single-use Grant record.
 *
 * Invariants:
 * - Cryptographic binding alone cannot replace terminal consumption inspection.
 */
import crypto from 'node:crypto';
import path from 'node:path';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { inspectExecutionBudgetGrantAuthorization } from '../storage-journal/execution-budget-grants.ts';
import { canonicalExecutionBudgetGrantRequest } from '../../modules/authority/execution-governance-grant-contracts.ts';
import {
  invalidProviderExecutionBudgetAuthority,
  type ProviderExecutionBudgetAuthority,
} from '../../modules/provider-orchestration/provider-execution-budget-authority.ts';

export {
  createProviderExecutionBudgetAuthority,
  validateProviderExecutionBudgetAuthority,
  type ProviderExecutionBudgetAuthority,
  type ProviderExecutionGrantAuthorityInput,
} from '../../modules/provider-orchestration/provider-execution-budget-authority.ts';

export function assertDurableProviderExecutionBudgetAuthority(
  investigationsRoot: string,
  authority: ProviderExecutionBudgetAuthority,
): void {
  if (path.basename(investigationsRoot) !== 'investigations') {
    throw invalidProviderExecutionBudgetAuthority();
  }
  try {
    const stored = inspectExecutionBudgetGrantAuthorization(
      path.dirname(investigationsRoot),
      authority.grantId,
    );
    const requestDigest = digestText(
      canonicalExecutionBudgetGrantRequest(authority.grantRequest),
    );
    const exactReceipt = stored.receipts.find(
      ({ receiptId }) => receiptId === authority.receipt.receiptId,
    );
    if (
      stored.payload.grantId !== authority.grantId ||
      stored.payload.requestDigest !== requestDigest ||
      stored.payload.maxUses !== 1 ||
      stored.state !== 'consumed' ||
      stored.remainingUses !== 0 ||
      stored.receipts.length !== 1 ||
      stored.payload.workflowId !== authority.grantRequest.workflowId ||
      stored.payload.epoch !== authority.grantRequest.epoch ||
      stored.payload.jobId !== authority.grantRequest.jobId ||
      canonicalJson(stored.payload.mandateBinding) !==
        canonicalJson(authority.grantRequest.mandateBinding) ||
      canonicalJson(stored.payload.allowedChanges) !==
        canonicalJson(authority.grantRequest.requestedChanges) ||
      exactReceipt === undefined ||
      canonicalJson(exactReceipt) !== canonicalJson(authority.receipt)
    ) {
      throw invalidProviderExecutionBudgetAuthority();
    }
  } catch {
    throw invalidProviderExecutionBudgetAuthority();
  }
}

function digestText(value: string): string {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

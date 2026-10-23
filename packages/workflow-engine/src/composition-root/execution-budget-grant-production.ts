/** Binds execution-budget Grant management to mandate, audit and signer capabilities. */
import {
  issueExecutionBudgetGrant as issue,
  revokeIssuedExecutionBudgetGrant as revoke,
} from '../runtime/grant-management/execution-budget-grant-management.ts';
import { withAuthorityRefusalAudit } from './authority-refusal-production.ts';
import { taskMandateOperations } from './task-mandate-production.ts';
import { createInteractiveSshSigner } from '../adapters/signing/ssh/maintainer-signer.ts';

export {
  inspectIssuedExecutionBudgetGrant,
  type IssueExecutionBudgetGrantOptions,
  type IssueExecutionBudgetGrantResult,
} from '../runtime/grant-management/execution-budget-grant-management.ts';

export const issueExecutionBudgetGrant = issue.bind(
  undefined,
  taskMandateOperations,
  withAuthorityRefusalAudit,
  createInteractiveSshSigner,
);

export const revokeIssuedExecutionBudgetGrant = revoke.bind(
  undefined,
  withAuthorityRefusalAudit,
  createInteractiveSshSigner,
);

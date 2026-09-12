/** Capabilities for a bound repository check run; pinned executions retain their own runner. */
import type { CheckEvidence } from '../../foundation/check-evidence/check-evidence.ts';
import type { ResolvedRequiredCiCheck } from './required-checks.ts';

export type CheckPostValidation = 'live-current-ref' | 'immutable-head';
export type CheckCheckoutObservation = Readonly<{
  head: string;
  statusEntryCount: number;
  fingerprint: string;
}>;

export type CheckExecutionPort = Readonly<{
  preflightDatabase(): string;
  pin(
    check: ResolvedRequiredCiCheck,
    databaseIdentity?: string,
  ): () => CheckEvidence;
  observe(expectedHead: string): CheckCheckoutObservation;
  validate(mode: CheckPostValidation, head: string): void;
}>;

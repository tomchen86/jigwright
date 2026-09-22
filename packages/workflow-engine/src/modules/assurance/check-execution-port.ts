/** Bound ordinary execution; checkout validation remains a separate consumer capability. */
import type {
  CheckEvidenceMetadata,
  ObservedCheckOutcome,
} from '../../foundation/check-evidence/check-evidence.ts';
import type { PinnedCheckRunner } from '../source/check-command.ts';
import type { ResolvedRequiredCheck } from './required-checks.ts';

export type CheckPostValidation = 'live-current-ref' | 'immutable-head';
export type CheckCheckoutObservation = Readonly<{
  head: string;
  statusEntryCount: number;
  fingerprint: string;
}>;

export type PinnedCheckExecution = Readonly<{
  runner: PinnedCheckRunner;
  execute(metadata?: CheckEvidenceMetadata): ObservedCheckOutcome;
}>;

export type CheckExecutionPort = Readonly<{
  preflightDatabase(): string;
  /** Observe identity now; environment construction and execution remain deferred. */
  pin(
    check: ResolvedRequiredCheck,
    databaseIdentity?: string,
  ): PinnedCheckExecution;
}>;

/** Construction binds inputs without observing repository or environment state. */
export type CheckExecutionFactory = (
  repositoryRoot: string,
  environment: NodeJS.ProcessEnv,
) => CheckExecutionPort;

export type CheckRepositoryValidation = Readonly<{
  observe(expectedHead: string): CheckCheckoutObservation;
  validate(mode: CheckPostValidation, head: string): void;
}>;

/** Patch transaction inputs and results shared by their real producer and application callers. */
import type {
  TaskStrategyPatchChange,
  TaskStrategyPatchImplementer,
  TaskStrategyPatchRecord,
  TaskStrategyPatchReservation,
  TaskStrategyPatchImportReceipt,
  TaskStrategyPatchCurrentBinding,
} from './task-strategy-evidence.ts';

export type TaskStrategyPatchCrashPhase =
  | 'reservation-persisted'
  | 'record-persisted'
  | 'patch-applied'
  | 'receipt-persisted';

export type CallerTaskStrategyPatchInput = Readonly<{
  patch: string | Buffer;
  explicitActor?: string;
  environment?: NodeJS.ProcessEnv;
}>;

export type TaskStrategyPatchImportInput = CallerTaskStrategyPatchInput &
  Readonly<{ testCrashAfter?: TaskStrategyPatchCrashPhase }>;

export type LocalTaskStrategyPatchAdoptionOptions = Readonly<{
  testCrashAfter?: TaskStrategyPatchCrashPhase;
}>;

export type TaskStrategyPatchValidation = Readonly<{
  schemaVersion: 1;
  kind: 'task-strategy-patch-validation.v1';
  sessionId: string;
  strategy: 'cross-agent-tdd' | 'tdd-single-agent';
  sourceTree: string;
  candidateTree: string;
  patchDigest: string;
  changedPaths: readonly string[];
  changes: readonly TaskStrategyPatchChange[];
  implementer: TaskStrategyPatchImplementer;
}>;

export type ImportedTaskStrategyPatch = Readonly<{
  record: TaskStrategyPatchRecord;
  reservation: TaskStrategyPatchReservation;
  receipt: TaskStrategyPatchImportReceipt;
  binding: TaskStrategyPatchCurrentBinding;
}>;

export type ProviderTaskStrategyPatchValidationInput = Readonly<{
  patch: string | Buffer;
  implementationReservationDigest: string;
  implementationSubjectDigest: string;
}>;

export type ProviderTaskStrategyPatchImportInput = Readonly<{
  patch: string | Buffer;
  implementationResultBindingDigest: string;
  implementationSubjectDigest: string;
  testCrashAfter?: TaskStrategyPatchCrashPhase;
}>;

export type CallerTaskStrategyPatchValidationInput = Readonly<{
  patch: string | Buffer;
  callerImplementer: Extract<
    TaskStrategyPatchImplementer,
    { providerId: null }
  >;
  implementationSubjectDigest: string;
}>;

export type CallerTaskStrategyPatchImportInput = Readonly<{
  patch: string | Buffer;
  callerImplementationBindingDigest: string;
  implementationSubjectDigest: string;
  testCrashAfter?: TaskStrategyPatchCrashPhase;
}>;

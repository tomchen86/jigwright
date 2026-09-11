/** Required observations and durable operations for the external-effect lifecycle. */
import { type SessionRuntimeLayoutV1 } from '@jigwright/core/session-runtime-layout-port';
import {
  type TaskMandateRepositoryServices,
  type TaskMandateAuditServices,
  type TaskMandateServices,
} from './task-mandate-services.ts';
import {
  type ExternalEffectTransitionOptions,
  type ExternalEffectAuditEvent,
  type Sha256Digest,
  type ExternalEffectTaskMandateOperations,
} from './external-effect-grant.ts';
export type ExternalEffectStorePaths = {
  runtime: SessionRuntimeLayoutV1;
  root: string;
  pending: string;
  available: string;
  transactions: string;
  terminal: string;
  idempotency: string;
};
export type ExternalEffectStoreServices = {
  externalEffectStorePaths: (
    gitCommonDirectory: string,
  ) => ExternalEffectStorePaths;
  ensureStore: (paths: ExternalEffectStorePaths) => void;
  assertStore: (paths: ExternalEffectStorePaths) => void;

  assertIdempotencyAvailable: (
    paths: ExternalEffectStorePaths,
    idempotencyKey: string,
    grantId: string,
    grantDigest: Sha256Digest,
  ) => void;
  createIdempotencyIndex: (
    paths: ExternalEffectStorePaths,
    idempotencyKey: string,
    grantId: string,
    grantDigest: Sha256Digest,
  ) => void;

  assertGrantAbsent: (paths: ExternalEffectStorePaths, grantId: string) => void;
  grantPath: (directory: string, grantId: string) => string;
  reconciliationPath: (
    paths: ExternalEffectStorePaths,
    grantId: string,
  ) => string;
  createPrivateFileAtomic: (filePath: string, content: string) => void;
  replacePrivateFileAtomic: (filePath: string, content: string) => void;
  readOptionalPrivateFile: (filePath: string) => string | null;
  unlinkIfExact: (filePath: string, expected: string) => void;
};
export type ExternalEffectRepositoryServices = Pick<
  TaskMandateRepositoryServices,
  | 'discoverRepository'
  | 'loadPolicyAt'
  | 'repositoryOrigin'
  | 'createInteractiveSshSigner'
> & {
  assertExternalAuditRoot: (value: string, repositoryRoot: string) => string;
  resolveSourceOid: (repositoryRoot: string, sourceOid: string) => string;
};
export type ExternalEffectAuditServices = Pick<
  TaskMandateAuditServices,
  | 'deriveAuthorityAuditRepositoryId'
  | 'authorityRefusalDigest'
  | 'withAuthorityRefusalAudit'
> & {
  emitAudit: (
    repositoryRoot: string,
    options: Pick<
      ExternalEffectTransitionOptions,
      'onAuditRecord' | 'testAuditServiceHooks'
    >,
    input: Omit<ExternalEffectAuditEvent, 'eventId'>,
  ) => void;
};
export type ExternalEffectGrantServices = {
  store: ExternalEffectStoreServices;
  repository: ExternalEffectRepositoryServices;
  audit: ExternalEffectAuditServices;
  taskMandate: ExternalEffectTaskMandateOperations;
  now: TaskMandateServices['now'];
  withRepositoryLifecycleOperation: TaskMandateServices['withRepositoryLifecycleOperation'];
  newTransactionEntropy: () => string;
};

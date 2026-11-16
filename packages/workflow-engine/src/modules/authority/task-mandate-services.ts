/** Required repository, persistence, clock and audit capabilities for mandate rules. */

import type { SessionRuntimeLayoutV1 } from '@jigwright/core/session-runtime-layout-port';
import type {
  AuthorityAuditEventInput,
  AuthorityAuditLedgerScope,
  AuthorityAuditRecordedEvent,
  AuthorityAuditServiceHooks,
  WithAuthorityRefusalAudit,
} from './authority-audit-contract.ts';
import type { MaintainerPolicy } from './maintainer-policy.ts';
import type { MaintainerSignerProvider } from './maintainer-signer-port.ts';
import { type TaskMandateRecord } from './task-mandate-values.ts';
export type TaskMandateStorePaths = {
  runtime: SessionRuntimeLayoutV1;
  root: string;
  active: string;
  terminal: string;
  history: string;
};
export type TaskMandateStoreServices = {
  taskMandateStorePaths: (gitCommonDirectory: string) => TaskMandateStorePaths;
  ensureStore: (paths: TaskMandateStorePaths) => void;
  readTaskRecord: (
    paths: TaskMandateStorePaths,
    taskId: string,
  ) => TaskMandateRecord;
  taskRecordPath: (directory: string, taskId: string) => string;
  taskHistoryPath: (
    directory: string,
    taskId: string,
    mandateId: string,
  ) => string;
  createPrivateFileAtomic: (filePath: string, content: string) => void;
  replacePrivateFileAtomic: (filePath: string, content: string) => void;
  readPrivateFile: (filePath: string) => string;
  fsyncDirectory: (directory: string) => void;
  exists: (filePath: string) => boolean;
  move: (sourcePath: string, destinationPath: string) => void;
};
export type TaskMandateRepositoryServices = {
  discoverRepository: (cwd: string) => {
    repositoryRoot: string;
    gitCommonDirectory: string;
    head: string;
  };
  loadPolicyAt: (
    repositoryRoot: string,
    commit: string,
  ) => { policy: MaintainerPolicy; policyBlob: string };
  repositoryHead: (repositoryRoot: string) => string;
  repositoryOrigin: (repositoryRoot: string) => string;
  createInteractiveSshSigner: (
    repositoryRoot: string,
    policy: MaintainerPolicy,
  ) => MaintainerSignerProvider;
  isPostApprovalAdmissionFailure: (error: unknown) => boolean;
};
export type TaskMandateAuditServices = {
  scanAuthorityAuditLedger: (scope: AuthorityAuditLedgerScope) => void;
  recordAuthorityAuditEvent: (
    scope: AuthorityAuditLedgerScope,
    input: AuthorityAuditEventInput,
    hooks?: AuthorityAuditServiceHooks,
  ) => AuthorityAuditRecordedEvent;

  withAuthorityRefusalAudit: WithAuthorityRefusalAudit;
};
export type TaskMandateServices = {
  store: TaskMandateStoreServices;
  repository: TaskMandateRepositoryServices;
  audit: TaskMandateAuditServices;
  now: () => Date;
  newMandateId: () => string;
  withRepositoryLifecycleOperation: <T>(
    runtime: SessionRuntimeLayoutV1,
    operation: (assertOwned: () => void) => T,
  ) => T;
};

/** Binds live storage, authority, observations and entropy to the external-effect lifecycle. */
import crypto from 'node:crypto';
import { createExternalEffectGrantOperations } from '../application/control-plane/external-effect-grant.ts';
import { externalEffectStore } from '../runtime/storage-journal/external-effect-grant-store.ts';
import {
  externalEffectRepository,
  publishRepository,
} from '../runtime/storage-journal/external-effect-grant-repository.ts';

import { taskMandateOperations } from './task-mandate-production.ts';
export const externalEffectGrantOperations =
  createExternalEffectGrantOperations({
    store: externalEffectStore,
    repository: { ...externalEffectRepository, createInteractiveSshSigner },
    audit: {
      emitAudit,

      withAuthorityRefusalAudit,
    },
    taskMandate: taskMandateOperations,
    now: () => new Date(),
    newTransactionEntropy: () => crypto.randomBytes(32).toString('hex'),
    withRepositoryLifecycleOperation,
  });
export const {
  issueExternalEffectGrant,
  inspectExternalEffectGrant,
  inspectExternalEffectGrantForExecutor,
  reserveExternalEffectGrant,
  markExternalEffectDispatchIssued,
  recordExternalEffectObservation,
  consumeExternalEffectGrant,
  terminalizeExternalEffectGrant,
  assertActivePublishTransaction,
  reconcileExternalEffectGrant,
  revokeExternalEffectGrant,
} = externalEffectGrantOperations;

import { emitAudit } from '../runtime/storage-journal/external-effect-grant-audit.ts';

import { withAuthorityRefusalAudit } from '../modules/authority/authority-refusal-audit.ts';
import { withRepositoryLifecycleOperation } from '../runtime/session-workspace/session-store.ts';

import { createPublishExecutor } from '../application/control-plane/publish-executor.ts';
import { createProductionPublishRunner } from '../adapters/remote/github/publish-runner.ts';

export const executePublishGrant = createPublishExecutor({
  grants: externalEffectGrantOperations,
  repository: publishRepository,
  createProductionPublishRunner,
  now: () => new Date(),
  environment: () => process.env,
});

import { createInteractiveSshSigner } from '../adapters/signing/ssh/maintainer-signer.ts';

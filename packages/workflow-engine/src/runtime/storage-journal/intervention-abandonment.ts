/** Dispose exact active intervention metadata with durable intent, drift checks and replay. */
import {
  persistedBootstrapSidecarSessionPath,
  readPersistedBootstrapSidecarWorkflow,
} from './intervention-control-persistence.ts';
import {
  sidecarMatchesIntervention,
  sidecarProjectionConflict,
} from './intervention-sidecar-records.ts';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import {
  ExitCode,
  WorkflowError,
  workflowError,
} from '../../foundation/errors/errors.ts';
import type { Sha256Digest } from '../../modules/authority/intervention-control-values.ts';
import type { LocalEngineBinding } from '../../modules/authority/intervention-bootstrap-contract.ts';
import { readLocalEngineBinding } from './intervention-parent-binding.ts';
import {
  readCanonicalPrivateJson,
  createPrivateMetadataFileExclusive,
  fsyncDirectory,
} from './intervention-persistence-files.ts';
import { assertPersistenceOwnedPath } from './intervention-persistence-paths.ts';
import {
  canonicalDigest,
  exactIso,
  assertDigest,
  hasExactKeys,
  isRecord,
  isDigest,
} from './intervention-persistence-values.ts';
import {
  readPersistedIntervention,
  recordBootstrapSidecarAbandoned,
  interventionRecordPath,
  interventionControlPersistencePaths,
  withInterventionParentOperation,
  type PersistedInterventionRecord,
} from './intervention-control-persistence.ts';
export interface InterventionAbandonmentIntent {
  kind: 'intervention-abandonment-intent.v1';
  parentChangeId: string;
  grantId: string;
  grantRecordDigest: Sha256Digest;
  reason: string;
  abandonedAt: string;
  intervention: PersistedInterventionRecord;
  localBinding: LocalEngineBinding | null;
  intentDigest: Sha256Digest;
}
export interface InterventionAbandonmentReceipt {
  kind: 'intervention-abandonment-receipt.v1';
  parentChangeId: string;
  grantId: string;
  intentDigest: Sha256Digest;
  completedAt: string;
  blockerCleared: true;
  bindingCleared: boolean;
  receiptDigest: Sha256Digest;
}
interface InterventionAbandonmentTarget {
  parentChangeId: string;
  interventionChangeId: string;
  checkpointId: Sha256Digest;
  grantId: string;
}
interface InterventionAbandonmentInput extends InterventionAbandonmentTarget {
  grantRecordDigest: Sha256Digest;
  reason: string;
  at: string;
  testAfterIntentPersisted?: () => void;
}
export function assertPersistedInterventionAbandonable(
  storageRoot: string,
  bindingPath: string,
  input: InterventionAbandonmentTarget,
): void {
  const existingIntent = readOptionalAbandonmentIntent(
    storageRoot,
    input.parentChangeId,
    input.grantId,
  );
  if (existingIntent !== null) {
    assertAuthorizedInterventionTarget(existingIntent.intervention, input);
    return;
  }
  const intervention = readPersistedIntervention(
    storageRoot,
    input.parentChangeId,
  );
  assertAuthorizedInterventionTarget(intervention, input);
  const localBinding = readOptionalLocalEngineBinding(bindingPath);
  assertAbandonableProjection(intervention, localBinding, storageRoot);
}
export function abandonPersistedIntervention(
  storageRoot: string,
  bindingPath: string,
  input: InterventionAbandonmentInput,
): {
  intent: InterventionAbandonmentIntent;
  receipt: InterventionAbandonmentReceipt;
  effectsPerformed: boolean;
} {
  return withInterventionParentOperation(
    storageRoot,
    input.parentChangeId,
    () =>
      abandonPersistedInterventionUnderParentLock(
        storageRoot,
        bindingPath,
        input,
      ),
  );
}
function abandonPersistedInterventionUnderParentLock(
  storageRoot: string,
  bindingPath: string,
  input: InterventionAbandonmentInput,
): {
  intent: InterventionAbandonmentIntent;
  receipt: InterventionAbandonmentReceipt;
  effectsPerformed: boolean;
} {
  assertDigest(input.grantRecordDigest, 'INTERVENTION_ABANDONMENT_INVALID');
  assertNonEmpty(input.reason, 'INTERVENTION_ABANDONMENT_INVALID');
  exactIso(input.at, 'INTERVENTION_ABANDONMENT_INVALID');
  const safeBindingPath = assertPersistenceOwnedPath(
    storageRoot,
    bindingPath,
    'BOOTSTRAP_BINDING_OUTSIDE_STATE',
  );
  const paths = abandonmentPaths(
    storageRoot,
    input.parentChangeId,
    input.grantId,
  );
  const existingIntent = readOptionalAbandonmentIntent(
    storageRoot,
    input.parentChangeId,
    input.grantId,
  );
  let intent: InterventionAbandonmentIntent;
  let effectsPerformed = false;
  if (existingIntent === null) {
    const intervention = readPersistedIntervention(
      storageRoot,
      input.parentChangeId,
    );
    assertAuthorizedInterventionTarget(intervention, input);
    const localBinding = readOptionalLocalEngineBinding(safeBindingPath);
    assertAbandonableProjection(intervention, localBinding, storageRoot);
    const payload = {
      kind: 'intervention-abandonment-intent.v1' as const,
      parentChangeId: input.parentChangeId,
      grantId: input.grantId,
      grantRecordDigest: input.grantRecordDigest,
      reason: input.reason,
      abandonedAt: input.at,
      intervention: structuredClone(intervention),
      localBinding:
        localBinding === null ? null : structuredClone(localBinding),
    };
    intent = {
      ...payload,
      intentDigest: canonicalDigest(payload),
    };
    createPrivateMetadataFileExclusive(
      paths.intent,
      Buffer.from(`${canonicalJson(intent)}\n`),
    );
    effectsPerformed = true;
    input.testAfterIntentPersisted?.();
  } else {
    intent = existingIntent;
    assertAuthorizedInterventionTarget(intent.intervention, input);
    if (
      intent.grantRecordDigest !== input.grantRecordDigest ||
      intent.reason !== input.reason ||
      intent.abandonedAt !== input.at
    ) {
      throw workflowError(
        'INTERVENTION_ABANDONMENT_CONFLICT',
        'Intervention abandonment already has a different human authorization.',
        ExitCode.conflict,
      );
    }
  }
  if (fs.existsSync(paths.receipt)) {
    const receipt = readAbandonmentReceipt(paths.receipt, intent);
    return { intent, receipt, effectsPerformed: false };
  }
  if (intent.localBinding !== null) {
    const observedBinding = readOptionalLocalEngineBinding(safeBindingPath);
    if (observedBinding !== null) {
      if (observedBinding.recordDigest !== intent.localBinding.recordDigest) {
        throw workflowError(
          'INTERVENTION_ABANDONMENT_BINDING_DRIFT',
          'Parent engine binding changed after abandonment was authorized.',
          ExitCode.staleState,
        );
      }
      fs.unlinkSync(safeBindingPath);
      fsyncDirectory(path.dirname(safeBindingPath));
      effectsPerformed = true;
    }
  } else if (readOptionalLocalEngineBinding(safeBindingPath) !== null) {
    throw workflowError(
      'INTERVENTION_ABANDONMENT_BINDING_DRIFT',
      'A parent engine binding appeared after abandonment was authorized.',
      ExitCode.staleState,
    );
  }
  const activePath = interventionRecordPath(storageRoot, input.parentChangeId);
  if (fs.existsSync(activePath)) {
    const observed = readPersistedIntervention(
      storageRoot,
      input.parentChangeId,
    );
    if (observed.recordDigest !== intent.intervention.recordDigest) {
      throw workflowError(
        'INTERVENTION_ABANDONMENT_RECORD_DRIFT',
        'Active intervention changed after abandonment was authorized.',
        ExitCode.staleState,
      );
    }
    fs.unlinkSync(activePath);
    fsyncDirectory(path.dirname(activePath));
    effectsPerformed = true;
  }
  recordBootstrapSidecarAbandoned(storageRoot, {
    parentChangeId: input.parentChangeId,
    intervention: intent.intervention,
    evidenceDigest: intent.intentDigest,
    abandonedAt: intent.abandonedAt,
  });
  const receiptPayload = {
    kind: 'intervention-abandonment-receipt.v1' as const,
    parentChangeId: input.parentChangeId,
    grantId: input.grantId,
    intentDigest: intent.intentDigest,
    completedAt: input.at,
    blockerCleared: true as const,
    bindingCleared: intent.localBinding !== null,
  };
  const receipt: InterventionAbandonmentReceipt = {
    ...receiptPayload,
    receiptDigest: canonicalDigest(receiptPayload),
  };
  createPrivateMetadataFileExclusive(
    paths.receipt,
    Buffer.from(`${canonicalJson(receipt)}\n`),
  );
  return { intent, receipt, effectsPerformed };
}
function assertAuthorizedInterventionTarget(
  intervention: PersistedInterventionRecord,
  target: InterventionAbandonmentTarget,
): void {
  if (
    intervention.parent?.changeId !== target.parentChangeId ||
    intervention.relationship?.parentChangeId !== target.parentChangeId ||
    intervention.relationship?.interventionChangeId !==
      target.interventionChangeId ||
    intervention.relationship?.checkpointId !== target.checkpointId ||
    intervention.checkpoint?.parentChangeId !== target.parentChangeId ||
    intervention.checkpoint?.checkpointId !== target.checkpointId
  ) {
    throw workflowError(
      'INTERVENTION_ABANDONMENT_AUTHORITY_MISMATCH',
      'Intervention metadata does not match the checkpoint authorized for disposition.',
      ExitCode.guard,
    );
  }
}
function assertAbandonableProjection(
  intervention: PersistedInterventionRecord,
  localBinding: LocalEngineBinding | null,
  storageRoot: string,
): void {
  const sidecarPath = persistedBootstrapSidecarSessionPath(
    storageRoot,
    intervention.parent.changeId,
  );
  if (
    fs.existsSync(sidecarPath) &&
    !sidecarMatchesIntervention(
      readPersistedBootstrapSidecarWorkflow(
        storageRoot,
        intervention.parent.changeId,
      ),
      intervention,
    )
  ) {
    throw sidecarProjectionConflict(
      'Sidecar identity differs from the intervention being abandoned.',
    );
  }
  if (localBinding === null) return;
  if (
    localBinding.parentChangeId !== intervention.parent.changeId ||
    localBinding.interventionChangeId !==
      intervention.relationship.interventionChangeId ||
    localBinding.checkpointId !== intervention.checkpoint.checkpointId ||
    localBinding.parentWorkspacePath !==
      intervention.childWorkspace.parentWorkspacePath ||
    localBinding.sessionSchema !== intervention.parent.sessionSchema
  ) {
    throw workflowError(
      'INTERVENTION_ABANDONMENT_BINDING_MISMATCH',
      'Parent metadata does not belong to this intervention checkpoint.',
      ExitCode.guard,
    );
  }
}
function readOptionalLocalEngineBinding(
  bindingPath: string,
): LocalEngineBinding | null {
  if (!fs.existsSync(bindingPath)) return null;
  return readLocalEngineBinding(bindingPath);
}
function abandonmentPaths(
  storageRoot: string,
  parentChangeId: string,
  grantId: string,
) {
  assertNonEmpty(parentChangeId, 'INTERVENTION_ABANDONMENT_INVALID');
  assertNonEmpty(grantId, 'INTERVENTION_ABANDONMENT_INVALID');
  const identity = crypto
    .createHash('sha256')
    .update(`intervention-abandonment\0${parentChangeId}\0${grantId}`)
    .digest('hex');
  const directory = path.join(
    interventionControlPersistencePaths(storageRoot).root,
    'intervention-abandonments',
  );
  return {
    intent: path.join(directory, `${identity}.intent.json`),
    receipt: path.join(directory, `${identity}.receipt.json`),
  };
}
function readOptionalAbandonmentIntent(
  storageRoot: string,
  parentChangeId: string,
  grantId: string,
): InterventionAbandonmentIntent | null {
  const target = abandonmentPaths(storageRoot, parentChangeId, grantId).intent;
  if (!fs.existsSync(target)) return null;
  const value = readCanonicalPrivateJson(
    target,
    'INTERVENTION_ABANDONMENT_NOT_FOUND',
    40 * 1024 * 1024,
  );
  if (
    !isRecord(value) ||
    value.kind !== 'intervention-abandonment-intent.v1' ||
    value.parentChangeId !== parentChangeId ||
    value.grantId !== grantId ||
    !hasExactKeys(value, [
      'abandonedAt',
      'grantId',
      'grantRecordDigest',
      'intentDigest',
      'intervention',
      'kind',
      'localBinding',
      'parentChangeId',
      'reason',
    ]) ||
    !isDigest(value.intentDigest) ||
    !isRecord(value.intervention)
  ) {
    throw corruptAbandonment();
  }
  const { intentDigest, ...payload } = value;
  if (
    canonicalDigest(payload) !== intentDigest ||
    !isDigest(value.grantRecordDigest) ||
    typeof value.reason !== 'string' ||
    value.reason.trim() !== value.reason ||
    value.reason.length === 0 ||
    !verifyEmbeddedRecordDigest(value.intervention) ||
    (value.localBinding !== null &&
      (!isRecord(value.localBinding) ||
        !verifyEmbeddedRecordDigest(value.localBinding)))
  ) {
    throw corruptAbandonment();
  }
  exactIso(String(value.abandonedAt), 'INTERVENTION_ABANDONMENT_CORRUPT');
  return value as unknown as InterventionAbandonmentIntent;
}
function readAbandonmentReceipt(
  receiptPath: string,
  intent: InterventionAbandonmentIntent,
): InterventionAbandonmentReceipt {
  const value = readCanonicalPrivateJson(
    receiptPath,
    'INTERVENTION_ABANDONMENT_RECEIPT_NOT_FOUND',
    1024 * 1024,
  );
  if (
    !isRecord(value) ||
    value.kind !== 'intervention-abandonment-receipt.v1' ||
    value.parentChangeId !== intent.parentChangeId ||
    value.grantId !== intent.grantId ||
    value.intentDigest !== intent.intentDigest ||
    value.blockerCleared !== true ||
    value.bindingCleared !== (intent.localBinding !== null) ||
    !hasExactKeys(value, [
      'bindingCleared',
      'blockerCleared',
      'completedAt',
      'grantId',
      'intentDigest',
      'kind',
      'parentChangeId',
      'receiptDigest',
    ]) ||
    !isDigest(value.receiptDigest)
  ) {
    throw corruptAbandonment();
  }
  const { receiptDigest, ...payload } = value;
  if (canonicalDigest(payload) !== receiptDigest) {
    throw corruptAbandonment();
  }
  exactIso(String(value.completedAt), 'INTERVENTION_ABANDONMENT_CORRUPT');
  return value as unknown as InterventionAbandonmentReceipt;
}
function verifyEmbeddedRecordDigest(value: Record<string, unknown>): boolean {
  if (!isDigest(value.recordDigest)) return false;
  const { recordDigest, ...payload } = value;
  return canonicalDigest(payload) === recordDigest;
}
function corruptAbandonment(): WorkflowError {
  return workflowError(
    'INTERVENTION_ABANDONMENT_CORRUPT',
    'Durable intervention abandonment evidence failed verification.',
    ExitCode.verification,
  );
}

function assertNonEmpty(value: unknown, code: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.trim() !== value ||
    value.length === 0
  ) {
    throw workflowError(
      code,
      'Expected a non-empty trimmed string.',
      ExitCode.usage,
    );
  }
}

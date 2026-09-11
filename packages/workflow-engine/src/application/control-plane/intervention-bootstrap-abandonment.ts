/**
 * Persists and recovers abandonment of an intervention and its parent
 * engine binding.
 *
 * Invariants:
 * - Abandonment replay preserves the recorded grant digest, reason, and
 *   timestamp.
 */
// intervention bootstrap abandonment; repository effects remain bound by the public module.
import type {
  InterventionBootstrapAbandonmentBindings,
  InterventionBootstrapAbandonmentBindingsTypes,
} from './intervention-control-bootstrap.ts';
type Sha256Digest =
  InterventionBootstrapAbandonmentBindingsTypes['Sha256Digest'];
type InterventionAbandonmentIntent =
  InterventionBootstrapAbandonmentBindingsTypes['InterventionAbandonmentIntent'];
type InterventionAbandonmentReceipt =
  InterventionBootstrapAbandonmentBindingsTypes['InterventionAbandonmentReceipt'];
type PersistedInterventionRecord =
  InterventionBootstrapAbandonmentBindingsTypes['PersistedInterventionRecord'];
type LocalEngineBinding =
  InterventionBootstrapAbandonmentBindingsTypes['LocalEngineBinding'];
type WorkflowError =
  InterventionBootstrapAbandonmentBindingsTypes['WorkflowError'];

export function createInterventionBootstrapAbandonment(
  bindings: () => InterventionBootstrapAbandonmentBindings,
) {
  function assertPersistedInterventionAbandonable(
    storageRoot: string,
    bindingPath: string,
    input: { parentChangeId: string; grantId: string },
  ): void {
    const boundServices: InterventionBootstrapAbandonmentBindings = bindings();
    const { readPersistedIntervention } = boundServices;

    const existingIntent = readOptionalAbandonmentIntent(
      storageRoot,
      input.parentChangeId,
      input.grantId,
    );
    if (existingIntent !== null) return;
    const intervention = readPersistedIntervention(
      storageRoot,
      input.parentChangeId,
    );
    const localBinding = readOptionalLocalEngineBinding(bindingPath);
    assertAbandonableProjection(intervention, localBinding, storageRoot);
  }

  function abandonPersistedIntervention(
    storageRoot: string,
    bindingPath: string,
    input: {
      parentChangeId: string;
      grantId: string;
      grantRecordDigest: Sha256Digest;
      reason: string;
      at: string;
      testAfterIntentPersisted?: () => void;
    },
  ): {
    intent: InterventionAbandonmentIntent;
    receipt: InterventionAbandonmentReceipt;
    effectsPerformed: boolean;
  } {
    const boundServices: InterventionBootstrapAbandonmentBindings = bindings();
    const { withInterventionParentOperation } = boundServices;

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
    input: {
      parentChangeId: string;
      grantId: string;
      grantRecordDigest: Sha256Digest;
      reason: string;
      at: string;
      testAfterIntentPersisted?: () => void;
    },
  ): {
    intent: InterventionAbandonmentIntent;
    receipt: InterventionAbandonmentReceipt;
    effectsPerformed: boolean;
  } {
    const boundServices: InterventionBootstrapAbandonmentBindings = bindings();
    const {
      exactIso,
      assertPersistenceOwnedPath,
      readPersistedIntervention,
      canonicalDigest,
      createPrivateFileExclusive,
      canonicalJson,
      workflowError,
      ExitCode,
      fs,
      fsyncDirectory,
      path,
      interventionRecordPath,
      recordBootstrapSidecarAbandoned,
    } = boundServices;
    const assertDigest: InterventionBootstrapAbandonmentBindings['assertDigest'] =
      boundServices.assertDigest;
    const assertNonEmpty: InterventionBootstrapAbandonmentBindings['assertNonEmpty'] =
      boundServices.assertNonEmpty;

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
      createPrivateFileExclusive(
        paths.intent,
        Buffer.from(`${canonicalJson(intent)}\n`),
      );
      effectsPerformed = true;
      input.testAfterIntentPersisted?.();
    } else {
      intent = existingIntent;
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
    const activePath = interventionRecordPath(
      storageRoot,
      input.parentChangeId,
    );
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
    createPrivateFileExclusive(
      paths.receipt,
      Buffer.from(`${canonicalJson(receipt)}\n`),
    );
    return { intent, receipt, effectsPerformed };
  }

  function assertAbandonableProjection(
    intervention: PersistedInterventionRecord,
    localBinding: LocalEngineBinding | null,
    storageRoot: string,
  ): void {
    const boundServices: InterventionBootstrapAbandonmentBindings = bindings();
    const {
      inFlightPersistedEngineAdoptionTxIds,
      activeBootstrapSidecarPromotionPinTxIds,
      workflowError,
      ExitCode,
      isHarnessInterventionBlocker,
      recoverPersistedEngineAdoption,
    } = boundServices;

    const inFlightTxIds = inFlightPersistedEngineAdoptionTxIds(
      storageRoot,
      intervention.parent.changeId,
    );
    const promotionTxIds = activeBootstrapSidecarPromotionPinTxIds(
      storageRoot,
      intervention.parent.changeId,
    );
    if (promotionTxIds.length > 0) {
      throw workflowError(
        'INTERVENTION_ABANDONMENT_PROMOTION_NOT_TERMINAL',
        'An in-flight repository promotion must be recovered before intervention abandonment.',
        ExitCode.guard,
        { details: { txIds: promotionTxIds } },
      );
    }
    if (localBinding === null) {
      if (inFlightTxIds.length > 0) {
        throw workflowError(
          'INTERVENTION_ABANDONMENT_ADOPTION_NOT_TERMINAL',
          'An in-flight adoption must be recovered before intervention abandonment.',
          ExitCode.guard,
          { details: { txIds: inFlightTxIds } },
        );
      }
      return;
    }
    if (
      localBinding.parentChangeId !== intervention.parent.changeId ||
      localBinding.interventionChangeId !==
        intervention.relationship.interventionChangeId ||
      localBinding.checkpointId !== intervention.checkpoint.checkpointId ||
      localBinding.engineDigest !== intervention.checkpoint.engineDigest ||
      localBinding.interventionState !== 'active' ||
      !isHarnessInterventionBlocker(
        localBinding.blocker,
        intervention.checkpoint.checkpointId,
        intervention.relationship.interventionChangeId,
      )
    ) {
      throw workflowError(
        'INTERVENTION_ABANDONMENT_PARENT_NOT_ROLLED_BACK',
        'Intervention can be abandoned only while the parent is durably bound to its checkpoint engine and blocker.',
        ExitCode.guard,
      );
    }
    const adoption = recoverPersistedEngineAdoption(
      storageRoot,
      localBinding.txId,
    ).record;
    if (
      adoption.journal.state !== 'ENGINE_BINDING_ROLLED_BACK' ||
      adoption.journal.parentChangeId !== intervention.parent.changeId ||
      adoption.journal.interventionChangeId !==
        intervention.relationship.interventionChangeId ||
      adoption.journal.checkpointId !== intervention.checkpoint.checkpointId
    ) {
      throw workflowError(
        'INTERVENTION_ABANDONMENT_ADOPTION_NOT_TERMINAL',
        'An in-flight or committed adoption must be recovered before intervention abandonment.',
        ExitCode.guard,
      );
    }
  }

  function readOptionalLocalEngineBinding(
    bindingPath: string,
  ): LocalEngineBinding | null {
    const boundServices: InterventionBootstrapAbandonmentBindings = bindings();
    const { fs, readLocalEngineBinding } = boundServices;

    if (!fs.existsSync(bindingPath)) return null;
    return readLocalEngineBinding(bindingPath);
  }

  function abandonmentPaths(
    storageRoot: string,
    parentChangeId: string,
    grantId: string,
  ) {
    const boundServices: InterventionBootstrapAbandonmentBindings = bindings();
    const { crypto, path, interventionControlPersistencePaths } = boundServices;
    const assertNonEmpty: InterventionBootstrapAbandonmentBindings['assertNonEmpty'] =
      boundServices.assertNonEmpty;

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
    const boundServices: InterventionBootstrapAbandonmentBindings = bindings();
    const {
      fs,
      readCanonicalPrivateJson,
      MAX_BUNDLE_BYTES,
      isRecord,
      hasExactKeys,
      isDigest,
      canonicalDigest,
      exactIso,
    } = boundServices;

    const target = abandonmentPaths(
      storageRoot,
      parentChangeId,
      grantId,
    ).intent;
    if (!fs.existsSync(target)) return null;
    const value = readCanonicalPrivateJson(
      target,
      'INTERVENTION_ABANDONMENT_NOT_FOUND',
      MAX_BUNDLE_BYTES,
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
    const boundServices: InterventionBootstrapAbandonmentBindings = bindings();
    const {
      readCanonicalPrivateJson,
      isRecord,
      hasExactKeys,
      isDigest,
      canonicalDigest,
      exactIso,
    } = boundServices;

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
    const boundServices: InterventionBootstrapAbandonmentBindings = bindings();
    const { isDigest, canonicalDigest } = boundServices;

    if (!isDigest(value.recordDigest)) return false;
    const { recordDigest, ...payload } = value;
    return canonicalDigest(payload) === recordDigest;
  }

  function corruptAbandonment(): WorkflowError {
    const boundServices: InterventionBootstrapAbandonmentBindings = bindings();
    const { workflowError, ExitCode } = boundServices;

    return workflowError(
      'INTERVENTION_ABANDONMENT_CORRUPT',
      'Durable intervention abandonment evidence failed verification.',
      ExitCode.verification,
    );
  }
  return {
    assertPersistedInterventionAbandonable,
    abandonPersistedIntervention,
  };
}

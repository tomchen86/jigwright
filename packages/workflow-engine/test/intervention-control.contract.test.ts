import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import { WorkflowError } from '../src/foundation/errors/errors.ts';
import {
  CONTROL_PLANE_REVIEW_SIGNATURE_NAMESPACE,
  CONTROL_PLANE_REVIEW_SIGNATURE_NAMESPACE_V2,
  CONTROL_PLANE_REVIEW_SIGNATURE_NAMESPACE_V3,
  CONTROL_PLANE_SIGNATURE_NAMESPACE_V2,
  CONTROL_PLANE_SIGNATURE_NAMESPACE_V3,
  HARNESS_MAINTENANCE_SIGNATURE_NAMESPACE,
  REQUIRED_PROTECTED_CAPABILITIES,
  advanceEngineAdoption,
  advanceMinimalUpdaterTransaction,
  beginHarnessIntervention,
  canonicalHarnessMaintenanceGrantPayload,
  classifyProtectedCandidateImpact,
  controlPlaneCandidateDigest,
  createEngineArtifact,
  createProtectedCapabilityManifest,
  createWipCheckpoint,
  decideControlPlaneRecovery,
  decideEngineAdoptionRecovery,
  finalizeEngineAdoption,
  prepareEngineAdoption,
  prepareMinimalUpdaterTransaction,
  protectedCapabilityClosureDigest,
  verifyHarnessMaintenanceGrant,
  verifyWipCheckpoint,
  validateWorkflowSupersedeReason,
  type ExactControlPlaneChange,
  type HarnessMaintenanceGrantEnvelope,
  type ParentChangeState,
  type ProtectedCapabilityEntry,
  type VerifiedControlPlaneGrantV3,
} from '../src/modules/authority/intervention-control.ts';

const NOW = new Date('2026-08-03T10:00:00.000Z');

test('intervention signature namespaces use the Jigwright product identity', () => {
  assert.deepEqual(
    [
      HARNESS_MAINTENANCE_SIGNATURE_NAMESPACE,
      CONTROL_PLANE_REVIEW_SIGNATURE_NAMESPACE,
      CONTROL_PLANE_SIGNATURE_NAMESPACE_V2,
      CONTROL_PLANE_REVIEW_SIGNATURE_NAMESPACE_V2,
      CONTROL_PLANE_SIGNATURE_NAMESPACE_V3,
      CONTROL_PLANE_REVIEW_SIGNATURE_NAMESPACE_V3,
    ],
    [
      'jigwright.harness-maintenance-grant.v1',
      'jigwright.control-plane-independent-review.v1',
      'jigwright.control-plane-grant.v2',
      'jigwright.control-plane-independent-review.v2',
      'jigwright.control-plane-grant.v3',
      'jigwright.control-plane-independent-review.v3',
    ],
  );
});

function digest(label: string): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(label).digest('hex')}`;
}

function hasCode(code: string) {
  return (error: unknown): boolean =>
    error instanceof WorkflowError && error.code === code;
}

function parentState(): ParentChangeState {
  return {
    changeId: 'parent-A',
    status: 'active',
    engineBinding: digest('engine-E1'),
    sessionSchema: 'v4',
    blocker: null,
  };
}

test('content-addressed WIP checkpoint is immutable and intervention keeps the parent active', () => {
  const parent = parentState();
  const checkpoint = createWipCheckpoint({
    parentChangeId: parent.changeId,
    baseOid: 'a'.repeat(40),
    worktreeFingerprint: digest('worktree'),
    trackedTreeDigest: digest('tracked'),
    untrackedBundleDigest: digest('untracked'),
    sessionStateDigest: digest('session'),
    pendingIntentDigest: digest('pending-intent'),
    engineDigest: parent.engineBinding,
    policyDigest: digest('policy'),
    createdAt: NOW.toISOString(),
  });

  assert.equal(checkpoint.checkpointId.startsWith('sha256:'), true);
  assert.equal(Object.isFrozen(checkpoint), true);
  assert.deepEqual(verifyWipCheckpoint(checkpoint), checkpoint);

  const started = beginHarnessIntervention(
    parent,
    'intervention-B',
    checkpoint,
  );
  assert.equal(started.parent.status, 'active');
  assert.deepEqual(started.parent.blocker, {
    kind: 'harness-intervention',
    checkpointId: checkpoint.checkpointId,
    blockedBy: 'intervention-B',
  });
  assert.equal(started.relationship.kind, 'harness-intervention.v1');
  assert.equal(started.relationship.parentChangeId, 'parent-A');
  assert.equal(started.relationship.interventionChangeId, 'intervention-B');
  assert.equal(started.relationship.state, 'active');

  assert.throws(
    () =>
      beginHarnessIntervention(
        { ...parent, status: 'completed' },
        'intervention-C',
        checkpoint,
      ),
    hasCode('INTERVENTION_PARENT_NOT_ACTIVE'),
  );
  assert.throws(
    () =>
      beginHarnessIntervention(started.parent, 'intervention-C', checkpoint),
    hasCode('INTERVENTION_ALREADY_ACTIVE'),
  );

  const tampered = {
    ...checkpoint,
    trackedTreeDigest: digest('different-tracked-tree'),
  };
  assert.throws(
    () => verifyWipCheckpoint(tampered),
    hasCode('INTERVENTION_CHECKPOINT_DIGEST_MISMATCH'),
  );
});

function maintenanceGrant(
  engineFromDigest: `sha256:${string}`,
): HarnessMaintenanceGrantEnvelope {
  return {
    payload: {
      kind: 'harness-maintenance-grant.v1',
      grantId: 'grant-maintenance-1',
      parentChangeId: 'parent-A',
      interventionChangeId: 'intervention-B',
      scope: {
        paths: ['packages/harness-runtime/**', 'packages/workflow-engine/**'],
        operations: [
          'adopt-engine-into-parent',
          'build-engine-artifact',
          'create-isolated-workspace',
          'modify-engine',
          'run-engine-tests',
        ],
      },
      waivers: [
        'active-change-exclusivity',
        'clean-worktree-required',
        'engine-path-protection',
      ],
      engineFromDigest,
      sessionSchema: 'v4',
      maxLocalAdoptions: 1,
      issuedAt: '2026-08-03T09:55:00.000Z',
      expiresAt: '2026-08-03T11:00:00.000Z',
      humanSigner: 'maintainer@example.test',
      reason:
        'Repair the blocked workflow engine through the intervention lane.',
    },
    signature: 'human-signature-bytes',
  };
}

function interventionFixture() {
  const parent = parentState();
  const checkpoint = createWipCheckpoint({
    parentChangeId: parent.changeId,
    baseOid: 'b'.repeat(40),
    worktreeFingerprint: digest('worktree-2'),
    trackedTreeDigest: digest('tracked-2'),
    untrackedBundleDigest: digest('untracked-2'),
    sessionStateDigest: digest('session-2'),
    pendingIntentDigest: digest('pending-intent-2'),
    engineDigest: parent.engineBinding,
    policyDigest: digest('policy-2'),
    createdAt: NOW.toISOString(),
  });
  const started = beginHarnessIntervention(
    parent,
    'intervention-B',
    checkpoint,
  );
  return { checkpoint, ...started };
}

test('maintenance grant is only verified and V1 adoption commits without a schema migration', () => {
  const fixture = interventionFixture();
  const envelope = maintenanceGrant(fixture.parent.engineBinding);
  const verifiedPayloads: string[] = [];
  const verifiedGrant = verifyHarnessMaintenanceGrant(envelope, {
    now: NOW,
    parent: fixture.parent,
    relationship: fixture.relationship,
    checkpoint: fixture.checkpoint,
    verifyHumanSignature(payload, signature, signer, namespace) {
      verifiedPayloads.push(payload);
      assert.equal(signature, 'human-signature-bytes');
      assert.equal(signer, 'maintainer@example.test');
      assert.equal(namespace, 'jigwright.harness-maintenance-grant.v1');
      return true;
    },
  });
  assert.equal(
    verifiedPayloads[0],
    canonicalHarnessMaintenanceGrantPayload(envelope.payload),
  );

  const artifact = createEngineArtifact({
    sourceChangeId: 'intervention-B',
    sourceDigest: digest('source-B'),
    executableDigest: digest('engine-E2'),
    protocolVersion: 3,
    canReadSessionSchemas: ['v4'],
    writesSessionSchema: 'v4',
    policySchemaVersion: 2,
    smokeReportDigest: digest('smoke-E2'),
  });
  assert.equal(artifact.artifactId.startsWith('sha256:'), true);

  let journal = prepareEngineAdoption({
    txId: 'adoption-tx-1',
    parent: fixture.parent,
    relationship: fixture.relationship,
    checkpoint: fixture.checkpoint,
    artifact,
    maintenanceGrant: verifiedGrant,
    priorLocalAdoptions: 0,
    now: NOW,
  });
  journal = advanceEngineAdoption(journal, {
    kind: 'parent-checkpointed',
    at: '2026-08-03T10:01:00.000Z',
  });
  journal = advanceEngineAdoption(journal, {
    kind: 'engine-binding-updated',
    at: '2026-08-03T10:02:00.000Z',
  });
  assert.deepEqual(decideEngineAdoptionRecovery(journal), {
    action: 'start-new-engine',
    authoritativeEngineDigest: artifact.executableDigest,
    blockerCleared: false,
  });
  assert.throws(
    () =>
      decideEngineAdoptionRecovery({
        ...journal,
        toEngineDigest: digest('tampered-adoption-binding'),
      }),
    hasCode('ENGINE_ADOPTION_JOURNAL_CORRUPT'),
  );
  journal = advanceEngineAdoption(journal, {
    kind: 'new-engine-started',
    at: '2026-08-03T10:03:00.000Z',
  });
  journal = advanceEngineAdoption(journal, {
    kind: 'health-check-passed',
    at: '2026-08-03T10:04:00.000Z',
  });
  journal = advanceEngineAdoption(journal, {
    kind: 'commit',
    at: '2026-08-03T10:05:00.000Z',
  });
  const committed = finalizeEngineAdoption(
    fixture.parent,
    fixture.relationship,
    journal,
  );
  assert.equal(committed.parent.engineBinding, artifact.executableDigest);
  assert.equal(committed.parent.status, 'active');
  assert.equal(committed.parent.blocker, null);
  assert.equal(committed.relationship.state, 'adopted');
  assert.deepEqual(decideEngineAdoptionRecovery(journal), {
    action: 'none',
    authoritativeEngineDigest: artifact.executableDigest,
    blockerCleared: true,
  });
});

test('adoption rejects a V1 schema change and health failure rolls back with blocker intact', () => {
  const fixture = interventionFixture();
  const envelope = maintenanceGrant(fixture.parent.engineBinding);
  const verifiedGrant = verifyHarnessMaintenanceGrant(envelope, {
    now: NOW,
    parent: fixture.parent,
    relationship: fixture.relationship,
    checkpoint: fixture.checkpoint,
    verifyHumanSignature: () => true,
  });
  const incompatible = createEngineArtifact({
    sourceChangeId: 'intervention-B',
    sourceDigest: digest('source-schema-change'),
    executableDigest: digest('engine-schema-v5'),
    protocolVersion: 3,
    canReadSessionSchemas: ['v4', 'v5'],
    writesSessionSchema: 'v5',
    policySchemaVersion: 2,
    smokeReportDigest: digest('smoke-v5'),
  });
  assert.throws(
    () =>
      prepareEngineAdoption({
        txId: 'adoption-schema-change',
        parent: fixture.parent,
        relationship: fixture.relationship,
        checkpoint: fixture.checkpoint,
        artifact: incompatible,
        maintenanceGrant: verifiedGrant,
        priorLocalAdoptions: 0,
        now: NOW,
      }),
    hasCode('ENGINE_ADOPTION_SCHEMA_CHANGE_FORBIDDEN'),
  );

  const compatible = createEngineArtifact({
    sourceChangeId: 'intervention-B',
    sourceDigest: digest('source-compatible'),
    executableDigest: digest('engine-compatible'),
    protocolVersion: 3,
    canReadSessionSchemas: ['v4'],
    writesSessionSchema: 'v4',
    policySchemaVersion: 2,
    smokeReportDigest: digest('smoke-compatible'),
  });
  let journal = prepareEngineAdoption({
    txId: 'adoption-rollback',
    parent: fixture.parent,
    relationship: fixture.relationship,
    checkpoint: fixture.checkpoint,
    artifact: compatible,
    maintenanceGrant: verifiedGrant,
    priorLocalAdoptions: 0,
    now: NOW,
  });
  for (const [kind, at] of [
    ['parent-checkpointed', '2026-08-03T10:01:00.000Z'],
    ['engine-binding-updated', '2026-08-03T10:02:00.000Z'],
    ['new-engine-started', '2026-08-03T10:03:00.000Z'],
    ['health-check-failed', '2026-08-03T10:04:00.000Z'],
    ['engine-binding-rolled-back', '2026-08-03T10:05:00.000Z'],
  ] as const) {
    journal = advanceEngineAdoption(journal, { kind, at });
  }
  const rolledBack = finalizeEngineAdoption(
    fixture.parent,
    fixture.relationship,
    journal,
  );
  assert.equal(
    rolledBack.parent.engineBinding,
    fixture.checkpoint.engineDigest,
  );
  assert.equal(rolledBack.parent.status, 'active');
  assert.equal(rolledBack.parent.blocker?.kind, 'harness-intervention');
  assert.equal(rolledBack.relationship.state, 'active');
  assert.deepEqual(decideEngineAdoptionRecovery(journal), {
    action: 'none',
    authoritativeEngineDigest: fixture.checkpoint.engineDigest,
    blockerCleared: false,
  });
});

function protectedEntries(
  extraAuthorizationDependencies: readonly string[] = [],
): ProtectedCapabilityEntry[] {
  return REQUIRED_PROTECTED_CAPABILITIES.map((capability) => {
    const entrypoints = [`packages/bootstrap/${capability}.ts`];
    const dependencies = [
      `packages/bootstrap/shared/${capability}.ts`,
      ...(capability === 'authorization.verify'
        ? extraAuthorizationDependencies
        : []),
    ].sort();
    const contentDigest = digest(`protected-content:${capability}`);
    return {
      capability,
      entrypoints,
      dependencies,
      contentDigest,
      closureDigest: protectedCapabilityClosureDigest(
        entrypoints,
        dependencies,
        contentDigest,
      ),
    };
  });
}

function grantVerifierComposition(entries: ProtectedCapabilityEntry[]) {
  const closure = (
    capability: (typeof REQUIRED_PROTECTED_CAPABILITIES)[number],
  ) => entries.find((entry) => entry.capability === capability)!.closureDigest;
  const roleContextSharingGrant = {
    kind: 'role-context-sharing-grant-verifier-binding.v1' as const,
    packageExport: './role-context-sharing-degradation' as const,
    packageExportTarget: './src/role-context-sharing-degradation.ts' as const,
    readerContractVersion:
      'jigwright.role-context-sharing-grant-reader.v1' as const,
    signatureNamespace: 'workflow.role-context-sharing-grant.v1' as const,
    authorizedEffect: 'role-context-sharing-degradation' as const,
    policyDigest: digest('fixture-role-context-policy').slice('sha256:'.length),
    sourcePaths: ['packages/grants/package.json'],
    sourceDigest: digest('fixture-role-context-sources'),
    authorizationClosureDigest: closure('authorization.verify'),
  };
  const payload = {
    kind: 'collaboration-grant-verifier-composition.v1' as const,
    packageName: '@jigwright/grants' as const,
    packageVersion: '0.1.0' as const,
    packageManifestPath: 'packages/grants/package.json' as const,
    packageManifestDigest: digest('fixture-grants-package-manifest'),
    verifierImplementation: 'ssh-maintainer-policy.v1' as const,
    verifierContractVersion: 'jigwright.grant-envelope-verifier.v1' as const,
    readerContractVersion:
      'jigwright.collaboration-grant-envelope-reader.v1' as const,
    signatureNamespaces: ['workflow.collaboration-grant.v2'] as const,
    authorizedEffects: ['role-independence-degradation-only'] as const,
    sourcePaths: ['packages/grants/package.json'],
    sourceDigest: digest('fixture-grant-verifier-sources'),
    collaborationPolicyDigest: digest('fixture-collaboration-policy').slice(
      'sha256:'.length,
    ),
    taskDiffReviewPolicyDigest: digest('fixture-task-diff-review-policy').slice(
      'sha256:'.length,
    ),
    roleContextSharingGrant,
    authorizationClosureDigest: closure('authorization.verify'),
    humanTrustRootsClosureDigest: closure('human.trust-roots'),
    applyJournalClosureDigest: closure('apply.journal'),
    controlPlaneUpdateClosureDigest: closure('control-plane.update'),
    recoveryClosureDigest: closure('recovery.rollback'),
    repairAuthority: 'human-only-authority-plan-or-sealed-recovery' as const,
  };
  return {
    ...payload,
    compositionDigest: digest(canonicalJson(payload)),
  };
}

function protectedManifestInputWithComposition() {
  const entries = protectedEntries(['packages/grants/package.json']);
  return {
    schemaVersion: 1 as const,
    manifestPath: 'workflow/protected-capabilities.json',
    grantVerifierComposition: grantVerifierComposition(entries),
    entries,
  };
}

test('intervention-control preserves an optional sealed Grant verifier composition', () => {
  const input = protectedManifestInputWithComposition();
  const manifest = createProtectedCapabilityManifest(input) as ReturnType<
    typeof createProtectedCapabilityManifest
  > & {
    grantVerifierComposition?: unknown;
  };

  assert.deepEqual(
    manifest.grantVerifierComposition,
    input.grantVerifierComposition,
  );
  assert.equal(
    (
      manifest.grantVerifierComposition as {
        packageVersion?: unknown;
        verifierImplementation?: unknown;
      }
    ).packageVersion,
    '0.1.0',
  );
  assert.equal(
    (
      manifest.grantVerifierComposition as {
        packageVersion?: unknown;
        verifierImplementation?: unknown;
      }
    ).verifierImplementation,
    'ssh-maintainer-policy.v1',
  );
});

test('intervention-control keeps historical protected manifests readable without a Grant verifier composition', () => {
  const manifest = createProtectedCapabilityManifest({
    schemaVersion: 1,
    manifestPath: 'workflow/protected-capabilities.json',
    entries: protectedEntries(),
  });

  assert.equal('grantVerifierComposition' in manifest, false);
});

test('intervention-control rejects a partial Grant verifier composition candidate', () => {
  const input = protectedManifestInputWithComposition();
  const { packageVersion: _packageVersion, ...partialComposition } =
    input.grantVerifierComposition;

  assert.throws(
    () =>
      createProtectedCapabilityManifest({
        ...input,
        grantVerifierComposition: partialComposition,
      }),
    hasCode('PROTECTED_CAPABILITY_MANIFEST_INVALID'),
  );
});

test('intervention-control rejects unknown Grant verifier composition keys', () => {
  const input = protectedManifestInputWithComposition();

  assert.throws(
    () =>
      createProtectedCapabilityManifest({
        ...input,
        grantVerifierComposition: {
          ...input.grantVerifierComposition,
          unreviewedFallback: true,
        },
      }),
    hasCode('PROTECTED_CAPABILITY_MANIFEST_INVALID'),
  );
});

test('intervention-control requires an exact role-context-sharing binding when the Grant verifier composition is present', () => {
  const input = protectedManifestInputWithComposition();
  const manifest = createProtectedCapabilityManifest(input);
  assert.deepEqual(
    manifest.grantVerifierComposition?.roleContextSharingGrant,
    input.grantVerifierComposition.roleContextSharingGrant,
  );

  const binding = input.grantVerifierComposition.roleContextSharingGrant;
  assert.ok(binding);
  const {
    roleContextSharingGrant: _omittedBinding,
    compositionDigest: _omittedCompositionDigest,
    ...omittedPayload
  } = input.grantVerifierComposition;
  assert.throws(
    () =>
      createProtectedCapabilityManifest({
        ...input,
        grantVerifierComposition: {
          ...omittedPayload,
          compositionDigest: digest(canonicalJson(omittedPayload)),
        },
      }),
    hasCode('PROTECTED_CAPABILITY_MANIFEST_INVALID'),
  );
  const { policyDigest: _policyDigest, ...partial } = binding;
  for (const invalid of [partial, { ...binding, unreviewedFallback: true }]) {
    assert.throws(
      () =>
        createProtectedCapabilityManifest({
          ...input,
          grantVerifierComposition: {
            ...input.grantVerifierComposition,
            roleContextSharingGrant: invalid,
          },
        }),
      hasCode('PROTECTED_CAPABILITY_MANIFEST_INVALID'),
    );
  }
});

test('protected capability closure classifies dependency and manifest changes as control-plane', () => {
  const manifest = createProtectedCapabilityManifest({
    schemaVersion: 1,
    manifestPath: 'workflow/protected-capabilities.json',
    entries: protectedEntries(),
  });
  const dependency = manifest.entries[0].dependencies[0];
  const controlPlane = classifyProtectedCandidateImpact({
    beforeManifest: manifest,
    afterManifest: manifest,
    changes: [
      {
        path: dependency,
        beforeDigest: digest('dependency-before'),
        afterDigest: digest('dependency-after'),
      },
    ],
  });
  assert.equal(controlPlane.class, 'C');
  assert.equal(controlPlane.kind, 'control-plane');
  assert.deepEqual(controlPlane.affectedCapabilities, [
    manifest.entries[0].capability,
  ]);

  const ordinary = classifyProtectedCandidateImpact({
    beforeManifest: manifest,
    afterManifest: manifest,
    changes: [
      {
        path: 'apps/api/src/example.ts',
        beforeDigest: digest('api-before'),
        afterDigest: digest('api-after'),
      },
    ],
  });
  assert.deepEqual(ordinary, {
    class: 'A',
    kind: 'ordinary',
    affectedCapabilities: [],
    manifestChanged: false,
  });

  const manifestMutation = classifyProtectedCandidateImpact({
    beforeManifest: manifest,
    afterManifest: manifest,
    changes: [
      {
        path: manifest.manifestPath,
        beforeDigest: digest('manifest-before'),
        afterDigest: digest('manifest-after'),
      },
    ],
  });
  assert.equal(manifestMutation.class, 'C');
  assert.equal(manifestMutation.manifestChanged, true);

  const invalidEntries = protectedEntries();
  invalidEntries[0] = {
    ...invalidEntries[0],
    closureDigest: digest('forged-closure'),
  };
  assert.throws(
    () =>
      createProtectedCapabilityManifest({
        schemaVersion: 1,
        manifestPath: 'workflow/protected-capabilities.json',
        entries: invalidEntries,
      }),
    hasCode('PROTECTED_CAPABILITY_CLOSURE_DIGEST_MISMATCH'),
  );
});

test('control-plane exact diffs use canonical code-unit ordering for case-sensitive paths', () => {
  const changes: ExactControlPlaneChange[] = [
    {
      path: 'docs/readme.md',
      beforeDigest: digest('lower-before'),
      afterDigest: digest('lower-after'),
    },
    {
      path: 'docs/Readme.md',
      beforeDigest: digest('upper-before'),
      afterDigest: digest('upper-after'),
    },
  ];

  assert.doesNotThrow(() => controlPlaneCandidateDigest(changes));
  assert.equal(
    controlPlaneCandidateDigest(changes),
    controlPlaneCandidateDigest([...changes].reverse()),
  );
});

function verifiedControlPlaneGrantV3(
  beforeClosureDigest: ReturnType<typeof digest>,
  afterClosureDigest: ReturnType<typeof digest>,
  grantId = 'control-grant-3',
): VerifiedControlPlaneGrantV3 {
  return {
    payload: {
      kind: 'control-plane-grant.v3',
      grantId,
      mandateBinding: {
        schemaVersion: 1,
        parentTaskId: 'control-plane-task',
        mandateId: '33333333-3333-4333-8333-333333333333',
        mandateDigest: '3'.repeat(64),
        changeId: 'control-plane-change',
        externalAuditRoot: '/external/audit/control-plane',
      },
      repositoryId: 'github:example/expense-app',
      frozenCandidateBundleDigest: digest('frozen-candidate-bundle'),
      candidateDigest: digest('control-plane-candidate'),
      promotionMaterialDigest: digest('promotion-material'),
      promotionBundleDigest: digest('promotion-bundle'),
      promotionLineageDigest: digest('promotion-lineage'),
      exactChanges: [
        {
          path: 'packages/workflow-engine/engine.mjs',
          beforeDigest: digest('control-before'),
          afterDigest: digest('control-after'),
          beforeMode: '100644',
          afterMode: '100644',
        },
      ],
      beforeClosureDigest,
      afterClosureDigest,
      affectedCapabilities: [REQUIRED_PROTECTED_CAPABILITIES[0]!],
      behaviorChangeSummary: 'Promote the repaired engine verifier closure.',
      recoveryBundle: {
        bundleDigest: digest('recovery-bundle'),
        previousClosureDigest: beforeClosureDigest,
        restartArtifactDigest: digest('restart-old-control-plane'),
        rollbackTestReportDigest: digest('rollback-test'),
      },
      independentReviewAttestationDigest: digest('independent-review'),
      updaterVersion: 3,
      oneShot: true,
      issuedAt: '2026-08-03T09:55:00.000Z',
      expiresAt: '2026-08-03T11:00:00.000Z',
      humanSigner: 'maintainer@example.test',
    },
    signature: 'control-plane-human-signature',
    verifiedAt: NOW.toISOString(),
    verification: 'human-signature-verified',
  };
}

test('minimal updater v3 rolls back purely', () => {
  const beforeClosureDigest = digest('control-before-closure');
  const afterClosureDigest = digest('control-after-closure');
  const verifiedGrant = verifiedControlPlaneGrantV3(
    beforeClosureDigest,
    afterClosureDigest,
  );

  let tx = prepareMinimalUpdaterTransaction(verifiedGrant, {
    txId: 'control-update-1',
    now: NOW,
  });
  for (const [kind, at] of [
    ['old-closure-verified', '2026-08-03T10:01:00.000Z'],
    ['candidate-verified', '2026-08-03T10:02:00.000Z'],
    ['recovery-bundle-verified', '2026-08-03T10:03:00.000Z'],
    ['atomic-switch-completed', '2026-08-03T10:04:00.000Z'],
  ] as const) {
    tx = advanceMinimalUpdaterTransaction(tx, { kind, at });
  }
  assert.deepEqual(decideControlPlaneRecovery(tx), {
    action: 'rollback-with-recovery-bundle',
    authoritativeClosureDigest: beforeClosureDigest,
    terminal: false,
  });
  assert.throws(
    () =>
      advanceMinimalUpdaterTransaction(tx, {
        kind: 'finalize',
        at: '2026-08-03T10:04:30.000Z',
      }),
    hasCode('CONTROL_PLANE_UPDATE_TRANSITION_INVALID'),
  );
  tx = advanceMinimalUpdaterTransaction(tx, {
    kind: 'self-tests-failed',
    at: '2026-08-03T10:05:00.000Z',
  });
  tx = advanceMinimalUpdaterTransaction(tx, {
    kind: 'rollback-completed',
    at: '2026-08-03T10:06:00.000Z',
  });
  assert.equal(tx.state, 'ROLLED_BACK');
  assert.deepEqual(decideControlPlaneRecovery(tx), {
    action: 'none',
    authoritativeClosureDigest: beforeClosureDigest,
    terminal: true,
  });
});

test('minimal updater v3 finalizes only after self-test', () => {
  const beforeClosureDigest = digest('control-before-closure');
  const afterClosureDigest = digest('control-after-closure');
  const verified = verifiedControlPlaneGrantV3(
    beforeClosureDigest,
    afterClosureDigest,
    'control-grant-success-3',
  );
  let tx = prepareMinimalUpdaterTransaction(verified, {
    txId: 'control-update-success',
    now: NOW,
  });
  for (const [kind, at] of [
    ['old-closure-verified', '2026-08-03T10:01:00.000Z'],
    ['candidate-verified', '2026-08-03T10:02:00.000Z'],
    ['recovery-bundle-verified', '2026-08-03T10:03:00.000Z'],
    ['atomic-switch-completed', '2026-08-03T10:04:00.000Z'],
    ['self-tests-passed', '2026-08-03T10:05:00.000Z'],
    ['finalize', '2026-08-03T10:06:00.000Z'],
  ] as const) {
    tx = advanceMinimalUpdaterTransaction(tx, { kind, at });
  }
  assert.equal(tx.state, 'FINALIZED');
  assert.deepEqual(decideControlPlaneRecovery(tx), {
    action: 'none',
    authoritativeClosureDigest: afterClosureDigest,
    terminal: true,
  });
});

test('supersede rejects execution failures', () => {
  assert.deepEqual(validateWorkflowSupersedeReason('workflow-replaced'), {
    allowed: true,
    reason: 'workflow-replaced',
  });
  assert.throws(
    () => validateWorkflowSupersedeReason('provider-timeout'),
    hasCode('SUPERSEDE_EXECUTION_FAILURE_FORBIDDEN'),
  );
  assert.throws(
    () => validateWorkflowSupersedeReason('contract-or-baseline-change'),
    hasCode('SUPERSEDE_REQUIRES_EPOCH_ROLLOVER'),
  );
  assert.throws(
    () => validateWorkflowSupersedeReason('mystery-reason'),
    hasCode('SUPERSEDE_REASON_UNSUPPORTED'),
  );
});

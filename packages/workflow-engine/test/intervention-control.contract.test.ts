import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import { WorkflowError } from '../src/foundation/errors/errors.ts';
import {
  HARNESS_MAINTENANCE_SIGNATURE_NAMESPACE,
  REQUIRED_PROTECTED_CAPABILITIES,
  createProtectedCapabilityManifest,
  protectedCapabilityClosureDigest,
  validateWorkflowSupersedeReason,
  type ProtectedCapabilityEntry,
} from '../src/modules/authority/intervention-control.ts';

test('maintenance signature namespace uses the Jigwright product identity', () => {
  assert.equal(
    HARNESS_MAINTENANCE_SIGNATURE_NAMESPACE,
    'jigwright.harness-maintenance-grant.v1',
  );
});

function digest(label: string): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(label).digest('hex')}`;
}

function hasCode(code: string) {
  return (error: unknown): boolean =>
    error instanceof WorkflowError && error.code === code;
}

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

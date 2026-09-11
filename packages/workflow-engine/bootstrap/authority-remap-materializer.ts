/** Isolated authority remap orchestration and pinned regeneration order. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import {
  projectAuthorityRemap,
  projectAuthorityRemapPathRoles,
  projectAuthorityRemapChecks,
  projectAuthorityRemapGuards,
  projectAuthorityRemapMaintainerPolicy,
  projectAuthorityRemapProfiles,
} from '../src/composition-root/authority-remap.ts';
import type { AuthorityRemapManifestV1 } from '../src/modules/authority/authority-remap-contract.ts';
import { parseAuthorityPlanIntent } from '../src/application/control-plane/authority-plan.ts';
import { runGitBuffer } from '../src/runtime/repository-transaction/git.ts';
import { generateBuiltInEngineClosure } from './generate-built-in-engine-closure.ts';
import { generateHarnessBootstrapRuntime } from './generate-harness-bootstrap-runtime.ts';
import { generateProtectedCapabilitiesManifest } from './generate-protected-capabilities.ts';
import {
  remapInvalid,
  assertRegenerationDescriptor,
  comparePaths,
  assertUniquePaths,
  applyProjectedTextMutation,
  projectProtectedCapabilityPaths,
  BUILT_IN_OUTPUTS,
  PROTECTED_CAPABILITIES_PATH,
  collectStagedTextMutations,
  assertAllowedFinalMutations,
  assertPinnedProfileAllowsFinalMutations,
  sha256,
  ABSENT_BEFORE_DIGEST,
  ABSENT_AFTER_DIGEST,
} from './authority-remap-mutations.ts';
import type {
  AuthorityRemapMaterializationRequest,
  ReadyAuthorityRemapProjection,
  AuthorityRemapRequest,
} from './authority-remap-mutations.ts';
import {
  assertNoTrackedGitAttributes,
  assertCallerState,
  clonePinnedRepository,
  checkoutPinnedCommit,
  listHarnessBootstrapOutputPaths,
  assertGeneratedOutputsNotIgnored,
} from './authority-remap-workspace.ts';
export type { AuthorityRemapMaterializationRequest } from './authority-remap-mutations.ts';

/**
 * Materialize generator-owned consequences of one already-proven mechanical
 * move in an isolated checkout. This function never prepares, applies, signs,
 * stages, or otherwise mutates authority state in the caller repository.
 */
export async function materializeAuthorityRemap(
  request: AuthorityRemapMaterializationRequest,
): Promise<ReadyAuthorityRemapProjection> {
  const input = Object.freeze({
    repositoryRoot: fs.realpathSync(request.repositoryRoot),
    baseCommit: request.baseCommit,
    moveCommit: request.moveCommit,
    materializationCommit: request.materializationCommit ?? request.moveCommit,
    renamePairs: Object.freeze(
      request.renamePairs.map(({ from, to }) => Object.freeze({ from, to })),
    ),
    authorityPlan: Object.freeze({
      changeId: request.authorityPlan.changeId,
      taskId: request.authorityPlan.taskId,
      profileId: request.authorityPlan.profileId,
      reason: request.authorityPlan.reason,
      message: request.authorityPlan.message,
    }),
    expectedRegenerationDescriptorDigest:
      request.expectedRegenerationDescriptorDigest,
  });
  const repositoryRoot = input.repositoryRoot;
  const projectionRequest: AuthorityRemapRequest = {
    repositoryRoot,
    baseCommit: input.baseCommit,
    moveCommit: input.moveCommit,
    materializationCommit: input.materializationCommit,
    renamePairs: input.renamePairs,
    authorityPlan: input.authorityPlan,
  };

  const pending = projectAuthorityRemap(projectionRequest);
  if (pending.status !== 'requires-regeneration') {
    throw remapInvalid(
      'Authority remap materialization requires an exact pending regeneration descriptor.',
    );
  }
  assertRegenerationDescriptor(
    pending.regeneration,
    input.expectedRegenerationDescriptorDigest,
  );
  assertNoTrackedGitAttributes(repositoryRoot, input.baseCommit);
  assertNoTrackedGitAttributes(repositoryRoot, input.moveCommit);
  assertNoTrackedGitAttributes(repositoryRoot, input.materializationCommit);
  assertCallerState(repositoryRoot, input.materializationCommit);

  const pathRoles = projectAuthorityRemapPathRoles(projectionRequest);
  const checks = projectAuthorityRemapChecks(projectionRequest);
  const guards = projectAuthorityRemapGuards(projectionRequest);
  const maintainerPolicy =
    projectAuthorityRemapMaintainerPolicy(projectionRequest);
  const profiles = projectAuthorityRemapProfiles(projectionRequest);
  const baseMutations = [
    ...(pathRoles.mutation === null ? [] : [pathRoles.mutation]),
    ...(checks.mutation === null ? [] : [checks.mutation]),
    ...guards.mutations,
    ...(maintainerPolicy.mutation === null ? [] : [maintainerPolicy.mutation]),
    ...(profiles.mutation === null ? [] : [profiles.mutation]),
  ].sort((left, right) => comparePaths(left.path, right.path));
  assertUniquePaths(baseMutations.map(({ path: filePath }) => filePath));

  const temporaryRoot = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), 'authority-remap-materializer-'),
  );
  fs.chmodSync(temporaryRoot, 0o700);
  const isolatedRepository = path.join(temporaryRoot, 'repository');

  try {
    clonePinnedRepository(repositoryRoot, isolatedRepository);
    checkoutPinnedCommit(
      isolatedRepository,
      input.baseCommit,
      pending.manifest.baseTree,
    );
    await assertPinnedBaseGeneratedArtifactsCurrent(
      isolatedRepository,
      pending.regeneration.steps,
    );
    checkoutPinnedCommit(
      isolatedRepository,
      input.materializationCommit,
      pending.manifest.materializationTree,
    );
    for (const mutation of baseMutations) {
      applyProjectedTextMutation(isolatedRepository, mutation);
    }
    projectProtectedCapabilityPaths(isolatedRepository, pathRoles.proof.moves);

    const generatedOutputPaths = new Set<string>();
    for (const step of pending.regeneration.steps) {
      if (step === 'built-in-engine-closure') {
        generateBuiltInEngineClosure(isolatedRepository, '--write');
        for (const output of BUILT_IN_OUTPUTS) {
          generatedOutputPaths.add(output);
        }
      } else if (step === 'harness-bootstrap-runtime') {
        generateHarnessBootstrapRuntime(isolatedRepository, '--write');
        for (const output of listHarnessBootstrapOutputPaths(
          isolatedRepository,
        )) {
          generatedOutputPaths.add(output);
        }
      } else if (step === 'protected-capabilities') {
        assertGeneratedOutputsNotIgnored(
          isolatedRepository,
          generatedOutputPaths,
        );
        await generateProtectedCapabilitiesManifest(
          isolatedRepository,
          '--write',
        );
        generatedOutputPaths.add(PROTECTED_CAPABILITIES_PATH);
      } else {
        const exhaustive: never = step;
        throw remapInvalid(
          `Unsupported authority remap regeneration step ${String(exhaustive)}.`,
        );
      }
    }

    assertGeneratedOutputsNotIgnored(isolatedRepository, generatedOutputPaths);
    runGitBuffer(isolatedRepository, ['add', '-A', '--']);
    const mutations = collectStagedTextMutations(
      isolatedRepository,
      input.materializationCommit,
    ).sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    );
    assertAllowedFinalMutations(
      mutations,
      baseMutations.map(({ path: filePath }) => filePath),
      pending.regeneration.steps,
    );
    assertPinnedProfileAllowsFinalMutations(
      isolatedRepository,
      input.baseCommit,
      input.authorityPlan.profileId,
      mutations,
    );
    if (mutations.length === 0) {
      throw remapInvalid(
        'Authority remap regeneration produced no exact authority-plan mutation.',
      );
    }

    const intent = Object.freeze({
      schemaVersion: 1 as const,
      kind: 'authority-plan-intent.v1' as const,
      ...input.authorityPlan,
      mutations: Object.freeze(
        mutations.map((mutation) => Object.freeze({ ...mutation })),
      ),
      externalEffects: Object.freeze([]) as readonly [],
      evidenceWaivers: Object.freeze([]) as readonly [],
    });
    try {
      parseAuthorityPlanIntent(intent);
    } catch {
      throw remapInvalid(
        'Generated authority remap intent does not satisfy the landed authority-plan parser.',
      );
    }
    const intentDigest = sha256(canonicalJson(intent));
    const projections = mutations.map((mutation) =>
      Object.freeze({
        path: mutation.path,
        beforeSha256:
          mutation.expectedBeforeSha256 === null
            ? ABSENT_BEFORE_DIGEST
            : (`sha256:${mutation.expectedBeforeSha256}` as const),
        afterSha256:
          mutation.content === null
            ? ABSENT_AFTER_DIGEST
            : sha256(mutation.content),
      }),
    );
    const manifestIdentity = {
      schemaVersion: 1 as const,
      kind: 'workflow.authority-remap-manifest.v1' as const,
      baseCommit: pending.manifest.baseCommit,
      baseTree: pending.manifest.baseTree,
      moveCommit: pending.manifest.moveCommit,
      moveTree: pending.manifest.moveTree,
      materializationCommit: pending.manifest.materializationCommit,
      materializationTree: pending.manifest.materializationTree,
      mechanicalProofDigest: pending.manifest.mechanicalProofDigest,
      moves: pending.manifest.moves,
      projections: Object.freeze(projections),
      regenerationDescriptorDigest: pending.regeneration.descriptorDigest,
      authorityPlanIntentDigest: intentDigest,
    } satisfies Omit<AuthorityRemapManifestV1, 'manifestDigest'>;
    const manifest = Object.freeze({
      ...manifestIdentity,
      manifestDigest: sha256(canonicalJson(manifestIdentity)),
    });

    assertCallerState(repositoryRoot, input.materializationCommit);
    return Object.freeze({
      status: 'ready' as const,
      manifest,
      intent,
      regeneration: null,
    });
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

async function assertPinnedBaseGeneratedArtifactsCurrent(
  repositoryRoot: string,
  steps: readonly (
    | 'built-in-engine-closure'
    | 'harness-bootstrap-runtime'
    | 'protected-capabilities'
  )[],
): Promise<void> {
  try {
    for (const step of steps) {
      if (step === 'built-in-engine-closure') {
        generateBuiltInEngineClosure(repositoryRoot, '--check');
      } else if (step === 'harness-bootstrap-runtime') {
        generateHarnessBootstrapRuntime(repositoryRoot, '--check');
      } else if (step === 'protected-capabilities') {
        await generateProtectedCapabilitiesManifest(repositoryRoot, '--check');
      } else {
        const exhaustive: never = step;
        throw new Error(`Unsupported regeneration step ${String(exhaustive)}.`);
      }
    }
  } catch {
    throw remapInvalid(
      'Authority remap pinned base generated artifacts are stale.',
    );
  }
}

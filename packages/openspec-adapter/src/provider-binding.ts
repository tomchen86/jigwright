import {
  assertPlanningProviderV1Migration,
  PlanningProviderBindingError,
  planningProviderBindingDigest,
  type PlanningProviderBindingReaderPort,
  type PlanningProviderBindingV1,
  type ResolvedPlanningProviderBinding,
} from '@jigwright/core/planning-provider-binding';

import { OpenSpecAdapterError } from './planning-provider.ts';

export { OpenSpecAdapterError } from './planning-provider.ts';

const OPENSPEC_PROVIDER_ID = 'openspec';
const OPENSPEC_ADAPTER_CONTRACT_VERSION = 1;

export type OpenSpecProviderBindingPolicyV1 = Readonly<{
  providerRequirement: Readonly<{ package: string; version: string }>;
  bindingArtifactPath(changeId: string): string;
}>;

export type OpenSpecProviderBindingResolverV1 = Readonly<{
  resolveCurrent(
    reader: PlanningProviderBindingReaderPort,
    repositoryRoot: string,
    changeRoot: string,
    changeId: string,
  ): ResolvedPlanningProviderBinding;
  resolveCurrentTransition(
    reader: PlanningProviderBindingReaderPort,
    repositoryRoot: string,
    baselineCommit: string,
    changeRoot: string,
    changeId: string,
    transitionKind: 'introduction' | 'revision',
  ): ResolvedPlanningProviderBinding;
  resolveHistorical(
    reader: PlanningProviderBindingReaderPort,
    repositoryRoot: string,
    commit: string,
    changeRoot: string,
    changeId: string,
  ): ResolvedPlanningProviderBinding;
  resolveHistoricalTransition(
    reader: PlanningProviderBindingReaderPort,
    repositoryRoot: string,
    parentCommit: string,
    candidateCommit: string,
    changeRoot: string,
    changeId: string,
    transitionKind: 'introduction' | 'revision',
  ): ResolvedPlanningProviderBinding;
}>;

export function createOpenSpecProviderBindingResolverV1(
  policy: OpenSpecProviderBindingPolicyV1,
): OpenSpecProviderBindingResolverV1 {
  const resolveCurrent = (
    reader: PlanningProviderBindingReaderPort,
    repositoryRoot: string,
    changeRoot: string,
    changeId: string,
  ): ResolvedPlanningProviderBinding => {
    const binding = reader.readCurrent(repositoryRoot, changeId);
    if (binding === null) {
      throw providerBindingMissing(policy, changeId);
    }
    assertOpenSpecBinding(policy, binding, changeRoot, changeId);
    return Object.freeze({
      binding,
      source: 'explicit',
      artifactPath: policy.bindingArtifactPath(changeId),
      bindingDigest: planningProviderBindingDigest(binding),
    });
  };

  const resolveHistorical = (
    reader: PlanningProviderBindingReaderPort,
    repositoryRoot: string,
    commit: string,
    changeRoot: string,
    changeId: string,
  ): ResolvedPlanningProviderBinding => {
    const binding = reader.readPinnedBinding(repositoryRoot, commit, changeId);
    if (binding === null) throw providerBindingMissing(policy, changeId);
    assertOpenSpecBinding(policy, binding, changeRoot, changeId);
    return Object.freeze({
      binding,
      source: 'explicit',
      artifactPath: policy.bindingArtifactPath(changeId),
      bindingDigest: planningProviderBindingDigest(binding),
    });
  };

  const resolveCurrentTransition = (
    reader: PlanningProviderBindingReaderPort,
    repositoryRoot: string,
    baselineCommit: string,
    changeRoot: string,
    changeId: string,
    transitionKind: 'introduction' | 'revision',
  ): ResolvedPlanningProviderBinding => {
    const candidate = reader.readCurrent(repositoryRoot, changeId);
    if (candidate === null) throw providerBindingMissing(policy, changeId);

    if (transitionKind === 'revision') {
      const previous = resolveHistorical(
        reader,
        repositoryRoot,
        baselineCommit,
        changeRoot,
        changeId,
      );
      assertPlanningProviderV1Migration(previous.binding, candidate);
    } else if (
      reader.readPinnedBinding(repositoryRoot, baselineCommit, changeId) !==
      null
    ) {
      throw new OpenSpecAdapterError(
        'PROVIDER_BINDING_INTRODUCTION_INVALID',
        'A planning introduction cannot reuse a provider binding from its parent.',
        { changeId, baselineCommit },
      );
    }

    return resolveCurrent(reader, repositoryRoot, changeRoot, changeId);
  };

  const resolveHistoricalTransition = (
    reader: PlanningProviderBindingReaderPort,
    repositoryRoot: string,
    parentCommit: string,
    candidateCommit: string,
    changeRoot: string,
    changeId: string,
    transitionKind: 'introduction' | 'revision',
  ): ResolvedPlanningProviderBinding => {
    const candidateRaw = reader.readPinnedBinding(
      repositoryRoot,
      candidateCommit,
      changeId,
    );
    if (transitionKind === 'introduction') {
      if (
        reader.readPinnedBinding(repositoryRoot, parentCommit, changeId) !==
        null
      ) {
        throw new OpenSpecAdapterError(
          'PROVIDER_BINDING_INTRODUCTION_INVALID',
          'A planning introduction cannot reuse a provider binding from its parent.',
          { changeId, parentCommit },
        );
      }
      return resolveHistorical(
        reader,
        repositoryRoot,
        candidateCommit,
        changeRoot,
        changeId,
      );
    }

    const previous = resolveHistorical(
      reader,
      repositoryRoot,
      parentCommit,
      changeRoot,
      changeId,
    );
    if (candidateRaw === null) {
      throw new PlanningProviderBindingError(
        'PROVIDER_MIGRATION_UNSUPPORTED',
        'Planning-provider migration is not supported by binding contract v1.',
      );
    }
    assertPlanningProviderV1Migration(previous.binding, candidateRaw);
    const candidate = resolveHistorical(
      reader,
      repositoryRoot,
      candidateCommit,
      changeRoot,
      changeId,
    );
    assertPlanningProviderV1Migration(previous.binding, candidate.binding);
    return candidate;
  };

  return Object.freeze({
    resolveCurrent,
    resolveCurrentTransition,
    resolveHistorical,
    resolveHistoricalTransition,
  });
}

function assertOpenSpecBinding(
  policy: OpenSpecProviderBindingPolicyV1,
  binding: PlanningProviderBindingV1,
  changeRoot: string,
  changeId: string,
): void {
  if (
    binding.changeId !== changeId ||
    binding.providerId !== OPENSPEC_PROVIDER_ID ||
    binding.adapterContractVersion !== OPENSPEC_ADAPTER_CONTRACT_VERSION ||
    binding.providerRequirement.package !==
      policy.providerRequirement.package ||
    binding.providerRequirement.version !==
      policy.providerRequirement.version ||
    binding.planningRoot !== `${changeRoot}/${changeId}`
  ) {
    throw new OpenSpecAdapterError(
      'PROVIDER_BINDING_MISMATCH',
      'Planning-provider binding does not select the reviewed OpenSpec adapter contract.',
      { changeId, providerId: binding.providerId },
    );
  }
}

function providerBindingMissing(
  policy: OpenSpecProviderBindingPolicyV1,
  changeId: string,
): OpenSpecAdapterError {
  return new OpenSpecAdapterError(
    'PROVIDER_BINDING_MISSING',
    'A managed change after the planning-provider cutover requires an explicit binding.',
    { changeId, path: policy.bindingArtifactPath(changeId) },
  );
}

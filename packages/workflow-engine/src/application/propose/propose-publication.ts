/**
 * Builds planning scaffolds and publishes their exact investigation manifests.
 *
 * Invariants:
 * - Manifest publication retains held authority and the exact current session snapshot.
 * - Only authenticated prior-generation bytes qualify for managed scaffold replacement.
 * - Interrupted publication resumes its recorded identity and preserves failure evidence.
 * - Failure observations clear only after the expected publication is confirmed.
 */
import path from 'node:path';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import type {
  InvestigationManifestV3,
  InvestigationV3Blocker,
} from '../../modules/investigation/manifest/investigation-manifest-types.ts';
import { createInvestigationV3Blocker } from '../../modules/investigation/manifest/investigation-manifest.ts';
import { assertPlanningTargetsCompatible } from './propose-artifacts.ts';
import {
  assertCurrentExemptionContext,
  currentChangeOriginBytes,
} from './propose-context.ts';
import {
  buildProposeExemptionInvestigationManifestV3,
  buildProposeInvestigationManifestV3,
  investigationV3BuildFailure,
  investigationV3SessionSnapshotDigest,
} from './propose-investigation-manifest.ts';
import {
  currentPlanningSchemaName,
  writeManagedEntries,
} from './propose-planning-store.ts';
import type {
  InvestigationManifestPublicationFailure,
  InvestigationManifestPublicationLifecycleIdentity,
  InvestigationManifestPublicationPaths,
  InvestigationManifestPublicationSnapshot,
} from '../../modules/investigation/manifest/investigation-publication-contracts.ts';
import type { InvestigationStatus } from '../../modules/lifecycle/investigation-status.ts';
import type { ProposeExemptionSession } from '../../modules/lifecycle/propose-exemption-session.ts';
import type { ProposeRuntime } from './propose-runtime.ts';
import type {
  ProposeWork,
  RebuiltInvestigation,
} from '../../modules/proposal/propose-types.ts';
export function prepareExemptionPlanningScaffold(
  services: Pick<
    ProposeRuntime,
    'investigation' | 'publication' | 'workspace' | 'roleContextSharingGrants'
  >,
  cwd: string,
  session: ProposeExemptionSession,
  allowAuthoredExisting = false,
  allowManagedPlanReview = false,
  materializeScaffold = true,
  assertOwned?: () => void,
): {
  changeDirectory: string;
  investigationBytes: string;
  investigationManifest: InvestigationManifestV3;
  instructions: ProposeWork['authoredInstructions'];
} {
  const context = services.workspace.loadInvestigationRuntimeContext(cwd);
  const changeDirectory = path.join(
    context.git.repositoryRoot,
    context.config.changeRoot,
    session.changeId,
  );
  const metadataBytes = `schema: ${currentPlanningSchemaName(context.git.repositoryRoot)}\ncreated: ${session.createdAt.slice(0, 10)}\n`;
  const investigation = buildProposeExemptionInvestigationManifestV3(
    services.workspace.materializeInvestigationEvidenceView,
    context,
    session,
    materializeScaffold && assertOwned !== undefined
      ? (blocker) =>
          persistAndThrowInvestigationV3BuildFailure(services, {
            context,
            identity: {
              repositoryId: context.config.repositoryName,
              changeId: session.changeId,
              investigationId: session.investigationId,
              sessionRevision: session.revision,
              sessionSnapshotDigest:
                investigationV3SessionSnapshotDigest(session),
            },
            blocker,
            assertOwned,
            assertCurrent: () => {
              const current =
                services.investigation.readProposeExemptionSession(
                  context.runtime,
                  session.investigationId,
                );
              if (canonicalJson(current) !== canonicalJson(session)) {
                throw workflowError(
                  'PROPOSE_INPUT_STALE',
                  'Investigation exemption changed before failure publication.',
                  ExitCode.staleState,
                );
              }
              assertCurrentExemptionContext(services, context, current);
            },
          })
      : undefined,
  );
  const investigationBytes = `${canonicalJson(investigation)}\n`;
  const scaffoldEntries = new Map([
    ['.openspec.yaml', metadataBytes],
    ['investigation.json', investigationBytes],
    ...(session.intent.sourceRefs.length > 0
      ? ([
          ['origin.json', currentChangeOriginBytes(session.intent.sourceRefs)],
        ] as const)
      : []),
  ]);
  assertPlanningTargetsCompatible(
    changeDirectory,
    scaffoldEntries,
    true,
    allowAuthoredExisting,
    allowManagedPlanReview,
  );
  if (materializeScaffold) {
    if (assertOwned === undefined) {
      throw workflowError(
        'PROPOSE_AUTHORIZATION_INVALID',
        'Investigation v3 publication requires held planning authority.',
        ExitCode.guard,
      );
    }
    assertOwned();
    writeManagedEntries(
      services,
      changeDirectory,
      new Map([['.openspec.yaml', metadataBytes]]),
    );
    publishTrackedInvestigationManifestV3(services, {
      context,
      manifest: investigation,
      assertOwned,
      assertCurrent: () => {
        const current = services.investigation.readProposeExemptionSession(
          context.runtime,
          session.investigationId,
        );
        if (canonicalJson(current) !== canonicalJson(session)) {
          throw workflowError(
            'PROPOSE_INPUT_STALE',
            'Investigation exemption changed before Manifest publication.',
            ExitCode.staleState,
          );
        }
        assertCurrentExemptionContext(services, context, current);
      },
    });
  }
  const authoring = services.workspace.planningProviderAuthoring(context);
  const proposalInstruction = authoring.instruction(
    session.changeId,
    currentPlanningSchemaName(context.git.repositoryRoot),
    'proposal',
  );
  return {
    changeDirectory,
    investigationBytes,
    investigationManifest: investigation,
    instructions: [
      {
        artifactId: 'proposal',
        outputPath: proposalInstruction.outputPath,
        instruction: proposalInstruction.instruction,
        template: proposalInstruction.template,
      },
    ],
  };
}

export function preparePlanningScaffold(
  services: Pick<
    ProposeRuntime,
    'investigation' | 'publication' | 'workspace' | 'roleContextSharingGrants'
  >,
  cwd: string,
  status: InvestigationStatus,
  rebuilt: RebuiltInvestigation,
  createdDate: string,
  allowAuthoredExisting = false,
  materializeScaffold = true,
  assertOwned?: () => void,
): {
  changeDirectory: string;
  investigationBytes: string;
  investigationManifest: InvestigationManifestV3;
  metadataBytes: string;
  replaceablePriorGeneration: (
    relativePath: string,
    existing: string,
  ) => boolean;
  instructions: ProposeWork['authoredInstructions'];
} {
  const context = services.workspace.loadInvestigationRuntimeContext(cwd);
  const changeDirectory = path.join(
    context.git.repositoryRoot,
    context.config.changeRoot,
    status.changeId,
  );
  const priorArtifactAtBaseline = (relativePath: string): string | undefined =>
    services.workspace.readFileAtCommit(
      context.git.repositoryRoot,
      rebuilt.session.baseline.head,
      `${context.config.changeRoot}/${status.changeId}/${relativePath}`,
    );
  // The authority to tolerate or replace an existing planning artifact: the
  // prior generation is itself a managed one — the baseline commit carries v2
  // metadata for this change — and the artifact's exact bytes are committed
  // there. Uncommitted bytes never qualify.
  const committedMetadata = priorArtifactAtBaseline('.openspec.yaml');
  const currentSchemaName = currentPlanningSchemaName(
    context.git.repositoryRoot,
  );
  const managedPriorGeneration =
    committedMetadata !== undefined &&
    committedMetadata.startsWith(`schema: ${currentSchemaName}\n`);
  const replaceablePriorGeneration = (
    relativePath: string,
    existing: string,
  ): boolean =>
    managedPriorGeneration &&
    priorArtifactAtBaseline(relativePath) === existing;
  // An amendment keeps the identity of the change it corrects: committed v2
  // metadata carries over instead of restamping the creation date.
  const metadataBytes = managedPriorGeneration
    ? committedMetadata
    : `schema: ${currentSchemaName}\ncreated: ${createdDate}\n`;
  const v3Manifest = buildProposeInvestigationManifestV3(
    services.workspace.materializeInvestigationEvidenceView,
    services.roleContextSharingGrants,
    context,
    rebuilt,
  );
  if (v3Manifest.outcome !== 'built') {
    if (materializeScaffold && assertOwned !== undefined) {
      persistAndThrowInvestigationV3BuildFailure(services, {
        context,
        identity: {
          repositoryId: context.config.repositoryName,
          changeId: rebuilt.session.changeId,
          investigationId: rebuilt.session.investigationId,
          sessionRevision: rebuilt.session.revision,
          sessionSnapshotDigest: investigationV3SessionSnapshotDigest(
            rebuilt.session,
          ),
        },
        blocker: v3Manifest.blocker,
        assertOwned,
        assertCurrent: () => {
          const current = services.investigation.readInvestigationSession(
            context.runtime,
            rebuilt.session.investigationId,
          );
          if (canonicalJson(current) !== canonicalJson(rebuilt.session)) {
            throw workflowError(
              'PROPOSE_INPUT_STALE',
              'Investigation changed before failure publication.',
              ExitCode.staleState,
            );
          }
        },
      });
    }
    throw investigationV3BuildFailure(v3Manifest.blocker);
  }
  const investigationBytes = `${canonicalJson(v3Manifest.manifest)}\n`;
  const scaffoldEntries = new Map([
    ['.openspec.yaml', metadataBytes],
    ['investigation.json', investigationBytes],
    ...(rebuilt.intent.sourceRefs.length > 0
      ? ([
          ['origin.json', currentChangeOriginBytes(rebuilt.intent.sourceRefs)],
        ] as const)
      : []),
  ]);
  if (materializeScaffold) {
    if (assertOwned === undefined) {
      throw workflowError(
        'PROPOSE_AUTHORIZATION_INVALID',
        'Investigation v3 publication requires held planning authority.',
        ExitCode.guard,
      );
    }
    assertPlanningTargetsCompatible(
      changeDirectory,
      scaffoldEntries,
      true,
      allowAuthoredExisting,
      false,
      replaceablePriorGeneration,
    );
    assertOwned();
    writeManagedEntries(
      services,
      changeDirectory,
      new Map([['.openspec.yaml', metadataBytes]]),
    );
    publishTrackedInvestigationManifestV3(services, {
      context,
      manifest: v3Manifest.manifest,
      assertOwned,
      assertCurrent: () => {
        const current = services.investigation.readInvestigationSession(
          context.runtime,
          rebuilt.session.investigationId,
        );
        if (canonicalJson(current) !== canonicalJson(rebuilt.session)) {
          throw workflowError(
            'PROPOSE_INPUT_STALE',
            'Investigation changed before Manifest publication.',
            ExitCode.staleState,
          );
        }
      },
    });
  }

  const authoring = services.workspace.planningProviderAuthoring(context);
  const proposalInstruction = authoring.instruction(
    status.changeId,
    currentPlanningSchemaName(context.git.repositoryRoot),
    'proposal',
  );
  const instructions = [
    {
      artifactId: 'proposal',
      outputPath: proposalInstruction.outputPath,
      instruction: proposalInstruction.instruction,
      template: proposalInstruction.template,
    },
  ];
  return {
    changeDirectory,
    investigationBytes,
    investigationManifest: v3Manifest.manifest,
    metadataBytes,
    replaceablePriorGeneration,
    instructions,
  };
}

function persistAndThrowInvestigationV3BuildFailure(
  services: Pick<ProposeRuntime, 'publication'>,
  input: {
    context: ReturnType<
      ProposeRuntime['workspace']['loadInvestigationRuntimeContext']
    >;
    identity: {
      repositoryId: string;
      changeId: string;
      investigationId: string;
      sessionRevision: number;
      sessionSnapshotDigest: string;
    };
    blocker: InvestigationV3Blocker;
    assertOwned: () => void;
    assertCurrent: () => void;
  },
): never {
  input.assertOwned();
  input.assertCurrent();
  const identity = {
    ...input.identity,
    blocker: input.blocker,
  };
  const emission =
    services.publication.captureInvestigationV3DirectFailureEmission({
      cwd: input.context.git.repositoryRoot,
      identity,
    });
  services.publication.writeInvestigationV3FailureObservation({
    runtime: input.context.runtime,
    ...identity,
    emission,
  });
  input.assertCurrent();
  input.assertOwned();
  throw investigationV3BuildFailure(input.blocker);
}

function clearPersistedInvestigationV3BuildFailure(
  services: Pick<ProposeRuntime, 'publication'>,
  input: {
    context: ReturnType<
      ProposeRuntime['workspace']['loadInvestigationRuntimeContext']
    >;
    identity: {
      repositoryId: string;
      changeId: string;
      investigationId: string;
      sessionRevision: number;
      sessionSnapshotDigest: string;
    };
    manifestDigest: string;
    assertOwned: () => void;
    assertCurrent: () => void;
  },
): void {
  input.assertOwned();
  input.assertCurrent();
  services.publication.clearInvestigationV3FailureObservation({
    runtime: input.context.runtime,
    ...input.identity,
    manifestDigest: input.manifestDigest,
  });
  input.assertCurrent();
  input.assertOwned();
}

function persistAndThrowInvestigationV3PublicationFailure(
  services: Pick<ProposeRuntime, 'publication'>,
  input: {
    context: ReturnType<
      ProposeRuntime['workspace']['loadInvestigationRuntimeContext']
    >;
    failure: InvestigationManifestPublicationFailure;
    blocker?: InvestigationV3Blocker;
    assertOwned: () => void;
    assertCurrent: () => void;
  },
): never {
  input.assertOwned();
  input.assertCurrent();
  services.publication.writeInvestigationV3PublicationFailureObservation({
    runtime: input.context.runtime,
    failure: input.failure,
  });
  input.assertCurrent();
  input.assertOwned();
  throw investigationV3BuildFailure(input.blocker ?? input.failure.blocker);
}

function investigationV3PublicationIdentityMismatch(
  services: Pick<ProposeRuntime, 'publication' | 'workspace'>,
  input: {
    context: ReturnType<
      ProposeRuntime['workspace']['loadInvestigationRuntimeContext']
    >;
    lifecycle: InvestigationManifestPublicationLifecycleIdentity;
    paths: InvestigationManifestPublicationPaths;
    manifest: InvestigationManifestV3;
    observed: unknown;
  },
): {
  blocker: InvestigationV3Blocker;
  failure: InvestigationManifestPublicationFailure;
} {
  const blocker = createInvestigationV3Blocker({
    attemptedTransition: 'publication',
    candidate: {
      directManifestDigest: input.manifest.manifestDigest,
      directInvestigationTargetDigest:
        input.manifest.investigationApproval.investigationTargetDigest,
      observed: input.observed,
    },
    failureCode: 'RECONSTRUCTION_MISMATCH',
    message:
      'Publication recovery identity does not match the direct v3 Manifest builder.',
  });
  const observation = {
    operation: 'inspect' as const,
    paths: structuredClone(input.paths),
  };
  const sourceWithoutEmission = {
    schemaVersion: 1 as const,
    observation,
    failureIdentity: blocker.failureIdentity,
    emittedPublicationStateDigest:
      services.publication.investigationManifestPublicationStateDigest(
        services.publication.observeInvestigationManifestPublicationState({
          repositoryRoot: input.context.git.repositoryRoot,
          privateRoot: input.context.git.gitCommonDirectory,
          source: observation,
        }),
      ),
    emittedGitStateDigest:
      services.publication.investigationManifestPublicationGitStateDigest(
        services.workspace.discoverRepository(input.context.git.repositoryRoot),
      ),
    recoveryPolicy: 'central-grant' as const,
  };
  const withoutEmission = {
    schemaVersion: 1 as const,
    kind: 'investigation-manifest-publication-failure' as const,
    lifecycle: structuredClone(input.lifecycle),
    blocker,
    source: sourceWithoutEmission,
  };
  return {
    blocker,
    failure: services.publication.assertInvestigationManifestPublicationFailure(
      {
        ...withoutEmission,
        source: {
          ...sourceWithoutEmission,
          emissionDigest:
            services.publication.investigationManifestPublicationFailureEmissionDigest(
              withoutEmission,
            ),
        },
      },
    ),
  };
}

export function publishTrackedInvestigationManifestV3(
  services: Pick<ProposeRuntime, 'publication' | 'workspace'>,
  input: {
    context: ReturnType<
      ProposeRuntime['workspace']['loadInvestigationRuntimeContext']
    >;
    manifest: InvestigationManifestV3;
    assertOwned: () => void;
    assertCurrent: () => void;
  },
): void {
  const lifecycle: InvestigationManifestPublicationLifecycleIdentity = {
    repositoryId: input.manifest.repositoryId,
    changeId: input.manifest.changeId,
    investigationId: input.manifest.investigationId,
    sessionRevision: input.manifest.authoring.sessionRevision,
    sessionSnapshotDigest: input.manifest.authoring.sessionSnapshotDigest,
  };
  const namespace =
    services.publication.investigationManifestPublicationNamespace(lifecycle);
  const paths: InvestigationManifestPublicationPaths = {
    manifestPath: `${input.context.config.changeRoot}/${lifecycle.changeId}/investigation.json`,
    currentRefPath: `${input.context.config.runtimeDirectory}/${namespace}/current.json`,
    journalPath: `${input.context.config.runtimeDirectory}/${namespace}/journal.json`,
  };
  const throwPublicationFailure = (
    failure: InvestigationManifestPublicationFailure,
    blocker = failure.blocker,
  ): never =>
    persistAndThrowInvestigationV3PublicationFailure(services, {
      context: input.context,
      failure,
      blocker,
      assertOwned: input.assertOwned,
      assertCurrent: input.assertCurrent,
    });
  const readCurrentRef = (): string => {
    const observed = services.publication.readInvestigationPublicationRefState({
      repositoryRoot: input.context.git.repositoryRoot,
      privateRoot: input.context.git.gitCommonDirectory,
      currentRefPath: paths.currentRefPath,
      lifecycle,
    });
    if (observed.outcome !== 'read') {
      return throwPublicationFailure(observed.failure);
    }
    return observed.currentRefDigest;
  };
  const expected: InvestigationManifestPublicationSnapshot = {
    ...lifecycle,
    currentRefDigest: readCurrentRef(),
  };
  function withTransitionLock<T>(
    operation: (snapshot: InvestigationManifestPublicationSnapshot) => T,
  ): T {
    input.assertOwned();
    input.assertCurrent();
    const result = operation({
      ...lifecycle,
      currentRefDigest: readCurrentRef(),
    });
    input.assertOwned();
    input.assertCurrent();
    return result;
  }
  let published = services.publication.publishInvestigationManifestV3({
    repositoryRoot: input.context.git.repositoryRoot,
    privateRoot: input.context.git.gitCommonDirectory,
    paths,
    manifest: input.manifest,
    expected,
    withTransitionLock,
  });
  if (published.outcome === 'blocked') {
    if (published.blocker.failureCode !== 'PUBLICATION_RECOVERY_REQUIRED') {
      return throwPublicationFailure(published.failure);
    }
    const inspected =
      services.publication.inspectInvestigationManifestPublication({
        repositoryRoot: input.context.git.repositoryRoot,
        privateRoot: input.context.git.gitCommonDirectory,
        paths,
        lifecycle,
      });
    if (inspected.outcome === 'blocked') {
      return throwPublicationFailure(inspected.failure);
    }
    if (inspected.outcome === 'none') {
      const mismatch = investigationV3PublicationIdentityMismatch(services, {
        context: input.context,
        lifecycle,
        paths,
        manifest: input.manifest,
        observed: inspected,
      });
      return throwPublicationFailure(mismatch.failure, mismatch.blocker);
    }
    if (
      inspected.manifestDigest !== input.manifest.manifestDigest ||
      inspected.investigationTargetDigest !==
        input.manifest.investigationApproval.investigationTargetDigest
    ) {
      const mismatch = investigationV3PublicationIdentityMismatch(services, {
        context: input.context,
        lifecycle,
        paths,
        manifest: input.manifest,
        observed: inspected,
      });
      return throwPublicationFailure(mismatch.failure, mismatch.blocker);
    }
    if (inspected.outcome === 'committed') {
      published = {
        outcome: 'published',
        transactionId: inspected.transactionId,
        manifestDigest: inspected.manifestDigest,
        investigationTargetDigest: inspected.investigationTargetDigest,
      };
    } else {
      published = services.publication.resumeInvestigationManifestPublication({
        repositoryRoot: input.context.git.repositoryRoot,
        privateRoot: input.context.git.gitCommonDirectory,
        paths,
        lifecycle,
        withTransitionLock,
      });
      if (published.outcome === 'blocked') {
        return throwPublicationFailure(published.failure);
      }
    }
  }
  if (
    published.manifestDigest !== input.manifest.manifestDigest ||
    published.investigationTargetDigest !==
      input.manifest.investigationApproval.investigationTargetDigest
  ) {
    const mismatch = investigationV3PublicationIdentityMismatch(services, {
      context: input.context,
      lifecycle,
      paths,
      manifest: input.manifest,
      observed: published,
    });
    return throwPublicationFailure(mismatch.failure, mismatch.blocker);
  }
  clearPersistedInvestigationV3BuildFailure(services, {
    context: input.context,
    identity: lifecycle,
    manifestDigest: input.manifest.manifestDigest,
    assertOwned: input.assertOwned,
    assertCurrent: input.assertCurrent,
  });
}

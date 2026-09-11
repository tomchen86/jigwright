/** Observes failure source currentness with an explicitly supplied repository context. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { isRecord } from '../../foundation/canonical-json/contract-values.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import {
  freezeGrantCanonical as freezeCanonical,
  grantSha256 as sha256,
} from '../../modules/authority/grant-primitives.ts';
import { validateForAuthority } from '../../modules/investigation/manifest/investigation-manifest.ts';
import { materializeInvestigationEvidenceView } from './investigation-replay.ts';
import type { WorkflowConfig } from '../../modules/repository-consumer/workflow-config.ts';
import {
  INVESTIGATION_V3_DIRECT_FAILURE_OBSERVER,
  INVESTIGATION_V3_PUBLICATION_STATE_OBSERVER,
  type InvestigationV3FailureObservations,
  type InvestigationV3FailureIdentity,
  type InvestigationV3FailureSource,
  type InvestigationV3ObservedFailureSource,
} from '../../modules/investigation/seal/investigation-v3-failure-source.ts';
import type { InvestigationV3DirectFailureEmission } from '../../modules/investigation/seal/investigation-v3-failure-record.ts';
import {
  investigationManifestPublicationNamespace,
  type InvestigationManifestPublicationFailure,
} from '../../modules/investigation/manifest/investigation-publication-contracts.ts';
import {
  investigationManifestPublicationGitStateDigest,
  investigationManifestPublicationStateDigest,
  observeInvestigationManifestPublicationState,
  readBoundInvestigationManifestPublicationRef,
} from '../managed-documents/transaction/investigation-publication.ts';
import {
  readCurrentInvestigationRef,
  readInvestigationSession,
} from '../storage-journal/investigation-session-records.ts';
import {
  readHumanResolutionHead,
  readHumanResolutionNode,
} from '../storage-journal/human-resolution-nodes.ts';
import { readEvidenceRefs } from '../storage-journal/evidence-object-store.ts';
import {
  isProposeExemptionInvestigationId,
  readCurrentProposeExemptionSession,
  readProposeExemptionSession,
} from '../storage-journal/propose-exemption-store.ts';
import { readInvestigationV3FailureObservation } from '../storage-journal/investigation-v3-failure-store.ts';

export type InvestigationFailureObservationContext = Readonly<{
  git: Parameters<typeof investigationManifestPublicationGitStateDigest>[0];
  config: Pick<
    WorkflowConfig,
    'repositoryName' | 'changeRoot' | 'runtimeDirectory'
  >;
  runtime: Parameters<typeof readInvestigationSession>[0];
}>;

export function createInvestigationV3FailureObservations(
  loadInvestigationRuntimeContext: (
    cwd: string,
  ) => InvestigationFailureObservationContext,
): InvestigationV3FailureObservations {
  function initialInvestigationV3FailureSourceObservation(
    input: Parameters<
      InvestigationV3FailureObservations['initialInvestigationV3FailureSourceObservation']
    >[0],
  ): ReturnType<
    InvestigationV3FailureObservations['initialInvestigationV3FailureSourceObservation']
  > {
    if (input.source.observerId === INVESTIGATION_V3_DIRECT_FAILURE_OBSERVER) {
      let observed: DirectFailureSourceObservation;
      try {
        observed = observedDirect(input.cwd, input.identity, input.source);
      } catch (error) {
        throw sourceChanged(
          `Investigation v3 direct failure lifecycle is unavailable before the central challenge was created (${observationErrorCode(error)}).`,
        );
      }
      assertDirectInitialCurrent(input.identity, input.source, observed);
      return observed;
    }
    const observed = observedPublication(
      input.cwd,
      input.identity,
      input.source,
    );
    if (!sameFailureIdentity(observed.identity, input.identity)) {
      const fields = failureIdentityDifferences(
        observed.identity,
        input.identity,
      );
      throw workflowError(
        'INVESTIGATION_V3_FAILURE_SOURCE_CHANGED',
        `Investigation v3 publication lifecycle identity changed before the central challenge was created: ${fields.join(', ')}.`,
        ExitCode.staleState,
      );
    }
    if (!observed.lifecycleCurrent) {
      throw workflowError(
        'INVESTIGATION_V3_FAILURE_SOURCE_CHANGED',
        'Investigation v3 publication lifecycle is no longer current.',
        ExitCode.staleState,
      );
    }
    if (
      observed.publicationStateDigest !==
      input.source.source.emittedPublicationStateDigest
    ) {
      throw workflowError(
        'INVESTIGATION_V3_FAILURE_SOURCE_CHANGED',
        'Investigation v3 publication failure source changed before the central challenge was created.',
        ExitCode.staleState,
      );
    }
    if (observed.gitStateDigest !== input.source.source.emittedGitStateDigest) {
      throw workflowError(
        'INVESTIGATION_V3_FAILURE_SOURCE_CHANGED',
        'Investigation v3 publication Git state changed before the central challenge was created.',
        ExitCode.staleState,
      );
    }
    return observed;
  }

  function observeInvestigationV3FailureSource(
    input: Parameters<
      InvestigationV3FailureObservations['observeInvestigationV3FailureSource']
    >[0],
  ): ReturnType<
    InvestigationV3FailureObservations['observeInvestigationV3FailureSource']
  > {
    if (input.source.observerId === INVESTIGATION_V3_DIRECT_FAILURE_OBSERVER) {
      try {
        return observedDirect(input.cwd, input.expectedIdentity, input.source);
      } catch (error) {
        return unavailableDirectObservation(
          input.expectedIdentity,
          input.source,
          error,
        );
      }
    }
    return observedPublication(input.cwd, input.expectedIdentity, input.source);
  }

  function captureInvestigationV3DirectFailureEmission(
    input: Parameters<
      InvestigationV3FailureObservations['captureInvestigationV3DirectFailureEmission']
    >[0],
  ): ReturnType<
    InvestigationV3FailureObservations['captureInvestigationV3DirectFailureEmission']
  > {
    let lifecycle: DirectLifecycleObservation;
    try {
      lifecycle = observeDirectLifecycle(input.cwd, input.identity);
    } catch (error) {
      throw sourceChanged(
        `Investigation v3 direct failure lifecycle is unavailable at emission (${observationErrorCode(error)}).`,
      );
    }
    if (!sameFailureIdentity(lifecycle.identity, input.identity)) {
      throw sourceChanged(
        'Investigation v3 direct failure identity changed at emission.',
      );
    }
    if (
      !lifecycle.current ||
      !lifecycle.nonterminal ||
      lifecycle.currentRefDigest === null
    ) {
      throw sourceChanged(
        'Investigation v3 direct failure lifecycle is not current and nonterminal at emission.',
      );
    }
    if (lifecycle.successfulCurrentManifest) {
      throw sourceChanged(
        'Investigation v3 direct failure is stale because its Manifest is already current.',
      );
    }
    return freezeCanonical({
      schemaVersion: 1,
      sessionSnapshotDigest: lifecycle.identity.sessionSnapshotDigest,
      currentRefDigest: lifecycle.currentRefDigest,
      effectiveState: lifecycle.effectiveState,
      lifecycleStateDigest: lifecycle.lifecycleStateDigest,
      gitStateDigest: lifecycle.gitStateDigest,
    });
  }

  type DirectFailureSourceObservation = InvestigationV3ObservedFailureSource &
    Readonly<{
      lifecycleCurrent: boolean;
      lifecycleNonterminal: boolean;
      lifecycleStateDigest: `sha256:${string}`;
      currentRefDigest: `sha256:${string}` | null;
      effectiveState: string;
      gitStateDigest: `sha256:${string}`;
      successfulCurrentManifest: boolean;
      storedEmission: InvestigationV3DirectFailureEmission;
    }>;

  function observedDirect(
    cwd: string,
    expectedIdentity: InvestigationV3FailureIdentity,
    source: Extract<
      InvestigationV3FailureSource,
      { observerId: typeof INVESTIGATION_V3_DIRECT_FAILURE_OBSERVER }
    >,
  ): DirectFailureSourceObservation {
    const context = loadInvestigationRuntimeContext(cwd);
    const observation = readInvestigationV3FailureObservation(
      context.runtime,
      expectedIdentity.investigationId,
    );
    const storedIdentity = freezeCanonical({
      repositoryId: observation.repositoryId,
      changeId: observation.changeId,
      investigationId: observation.investigationId,
      sessionRevision: observation.sessionRevision,
      sessionSnapshotDigest: observation.sessionSnapshotDigest,
      blocker: observation.blocker,
    });
    const lifecycle = observeDirectLifecycle(cwd, storedIdentity);
    return freezeCanonical({
      identity: lifecycle.identity,
      sourceStateDigest: sha256(
        canonicalJson({
          schema: 'investigation-v3-direct-failure-source-state.v2',
          identity: lifecycle.identity,
          storedEmission: observation.emission,
          expectedEmission: source.emission,
          lifecycle: lifecycle.sourceState,
          gitStateDigest: lifecycle.gitStateDigest,
        }),
      ),
      publicationRecoveryKind: null,
      lifecycleCurrent: lifecycle.current,
      lifecycleNonterminal: lifecycle.nonterminal,
      lifecycleStateDigest: lifecycle.lifecycleStateDigest,
      currentRefDigest: lifecycle.currentRefDigest,
      effectiveState: lifecycle.effectiveState,
      gitStateDigest: lifecycle.gitStateDigest,
      successfulCurrentManifest: lifecycle.successfulCurrentManifest,
      storedEmission: observation.emission,
    });
  }

  type DirectLifecycleObservation = Readonly<{
    identity: InvestigationV3FailureIdentity;
    current: boolean;
    nonterminal: boolean;
    currentRefDigest: `sha256:${string}` | null;
    effectiveState: InvestigationV3DirectFailureEmission['effectiveState'];
    lifecycleStateDigest: `sha256:${string}`;
    gitStateDigest: `sha256:${string}`;
    successfulCurrentManifest: boolean;
    sourceState: unknown;
  }>;

  function observeDirectLifecycle(
    cwd: string,
    expected: InvestigationV3FailureIdentity,
  ): DirectLifecycleObservation {
    const context = loadInvestigationRuntimeContext(cwd);
    const gitStateDigest = investigationManifestPublicationGitStateDigest(
      context.git,
    );
    if (isProposeExemptionInvestigationId(expected.investigationId)) {
      const session = readProposeExemptionSession(
        context.runtime,
        expected.investigationId,
      );
      const current = readCurrentProposeExemptionSession(
        context.runtime,
        session.changeId,
      );
      const refNodeId =
        readEvidenceRefs(context.runtime, session.changeId)[
          'propose/exemption-session'
        ] ?? null;
      const currentRefDigest =
        refNodeId === null
          ? null
          : sha256(
              canonicalJson({
                schema: 'investigation-v3-exemption-current-ref.v1',
                refName: 'propose/exemption-session',
                nodeId: refNodeId,
              }),
            );
      const sessionSnapshotDigest = rawSha256(`${canonicalJson(session)}\n`);
      const identity = freezeCanonical({
        repositoryId: context.config.repositoryName,
        changeId: session.changeId,
        investigationId: session.investigationId,
        sessionRevision: session.revision,
        sessionSnapshotDigest,
        blocker: expected.blocker,
      });
      const successfulCurrentManifest = currentManifestIsSuccessful(
        context,
        identity,
      );
      const sourceState = freezeCanonical({
        kind: 'propose-exemption-session',
        session,
        currentRef: {
          nodeId: refNodeId,
          digest: currentRefDigest,
        },
        effectiveState: session.state,
        successfulCurrentManifest,
      });
      return freezeCanonical({
        identity,
        current:
          current?.investigationId === session.investigationId &&
          refNodeId !== null,
        nonterminal: true,
        currentRefDigest,
        effectiveState: 'investigation-exempt',
        lifecycleStateDigest: sha256(
          canonicalJson({
            schema: 'investigation-v3-direct-lifecycle-state.v1',
            sourceState,
          }),
        ),
        gitStateDigest,
        successfulCurrentManifest,
        sourceState,
      });
    }

    const session = readInvestigationSession(
      context.runtime,
      expected.investigationId,
    );
    const current = readCurrentInvestigationRef(
      context.runtime,
      session.changeId,
    );
    const resolutionHeadNodeId = readHumanResolutionHead(
      context.runtime,
      session.investigationId,
    );
    const resolutionNode =
      resolutionHeadNodeId === null
        ? null
        : readHumanResolutionNode(context.runtime, resolutionHeadNodeId);
    const currentRefDigest =
      current === null
        ? null
        : sha256(
            canonicalJson({
              schema: 'investigation-v3-current-ref.v1',
              ref: current,
            }),
          );
    const sessionSnapshotDigest = rawSha256(`${canonicalJson(session)}\n`);
    const identity = freezeCanonical({
      repositoryId: context.config.repositoryName,
      changeId: session.changeId,
      investigationId: session.investigationId,
      sessionRevision: session.revision,
      sessionSnapshotDigest,
      blocker: expected.blocker,
    });
    const effectiveState = directEffectiveState(session.state, resolutionNode);
    const nonterminal = ![
      'aborted-by-human-resolution',
      'superseded-by-human-resolution',
      'quarantined-by-human-resolution',
    ].includes(effectiveState);
    if (!nonterminal) {
      throw sourceChanged(
        'Investigation v3 direct failure lifecycle reached a terminal human resolution.',
      );
    }
    const successfulCurrentManifest = currentManifestIsSuccessful(
      context,
      identity,
    );
    const sourceState = freezeCanonical({
      kind: 'investigation-session',
      session,
      currentRef: current,
      currentRefDigest,
      resolutionHeadNodeId,
      effectiveState,
      successfulCurrentManifest,
    });
    return freezeCanonical({
      identity,
      current: current?.investigationId === session.investigationId,
      nonterminal,
      currentRefDigest,
      effectiveState:
        effectiveState as InvestigationV3DirectFailureEmission['effectiveState'],
      lifecycleStateDigest: sha256(
        canonicalJson({
          schema: 'investigation-v3-direct-lifecycle-state.v1',
          sourceState,
        }),
      ),
      gitStateDigest,
      successfulCurrentManifest,
      sourceState,
    });
  }

  function directEffectiveState(
    fallback: ReturnType<typeof readInvestigationSession>['state'],
    node: ReturnType<typeof readHumanResolutionNode> | null,
  ): string {
    if (node?.decision.kind === 'abort') {
      return 'aborted-by-human-resolution';
    }
    if (
      node?.decision.kind === 'supersede' ||
      node?.decision.kind === 'repair'
    ) {
      return 'superseded-by-human-resolution';
    }
    if (node?.decision.kind === 'quarantine') {
      return 'quarantined-by-human-resolution';
    }
    return fallback;
  }

  function currentManifestIsSuccessful(
    context: InvestigationFailureObservationContext,
    identity: InvestigationV3FailureIdentity,
  ): boolean {
    const manifestPath = `${context.config.changeRoot}/${identity.changeId}/investigation.json`;
    const absolutePath = path.join(context.git.repositoryRoot, manifestPath);
    let bytes: string;
    try {
      bytes = fs.readFileSync(absolutePath, 'utf8');
    } catch {
      return false;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(bytes);
    } catch {
      return false;
    }
    const validation = validateForAuthority(
      materializeInvestigationEvidenceView,
      {
        repositoryRoot: context.git.repositoryRoot,
        manifest: raw,
        expected: {
          repositoryId: identity.repositoryId,
          changeId: identity.changeId,
          investigationId: identity.investigationId,
          sessionRevision: identity.sessionRevision,
          sessionSnapshotDigest: identity.sessionSnapshotDigest,
        },
      },
    );
    if (
      validation.outcome !== 'verified' ||
      bytes !== `${canonicalJson(validation.manifest)}\n`
    ) {
      return false;
    }
    const currentRef = readBoundInvestigationManifestPublicationRef({
      repositoryRoot: context.git.repositoryRoot,
      privateRoot: context.git.gitCommonDirectory,
      currentRefPath: `${context.config.runtimeDirectory}/${investigationManifestPublicationNamespace(
        identity,
      )}/current.json`,
      lifecycle: identity,
      expected: {
        manifestPath,
        manifestDigest: validation.manifestDigest,
        investigationTargetDigest: validation.investigationTargetDigest,
      },
    });
    return currentRef.outcome === 'read';
  }

  function assertDirectInitialCurrent(
    expected: InvestigationV3FailureIdentity,
    source: Extract<
      InvestigationV3FailureSource,
      { observerId: typeof INVESTIGATION_V3_DIRECT_FAILURE_OBSERVER }
    >,
    observed: DirectFailureSourceObservation,
  ): void {
    if (!sameFailureIdentity(observed.identity, expected)) {
      throw sourceChanged(
        'Investigation v3 direct failure identity changed before the central challenge was created.',
      );
    }
    if (
      !observed.lifecycleCurrent ||
      !observed.lifecycleNonterminal ||
      observed.currentRefDigest === null
    ) {
      throw sourceChanged(
        'Investigation v3 direct failure lifecycle is no longer current and nonterminal.',
      );
    }
    if (observed.successfulCurrentManifest) {
      throw sourceChanged(
        'Investigation v3 direct failure is stale because its Manifest is already current.',
      );
    }
    if (
      canonicalJson(observed.storedEmission) !==
        canonicalJson(source.emission) ||
      source.emission.sessionSnapshotDigest !==
        observed.identity.sessionSnapshotDigest ||
      source.emission.currentRefDigest !== observed.currentRefDigest ||
      source.emission.effectiveState !== observed.effectiveState ||
      source.emission.lifecycleStateDigest !== observed.lifecycleStateDigest ||
      source.emission.gitStateDigest !== observed.gitStateDigest
    ) {
      throw sourceChanged(
        'Investigation v3 direct failure lifecycle or Git state changed before the central challenge was created.',
      );
    }
  }

  function unavailableDirectObservation(
    identity: InvestigationV3FailureIdentity,
    source: Extract<
      InvestigationV3FailureSource,
      { observerId: typeof INVESTIGATION_V3_DIRECT_FAILURE_OBSERVER }
    >,
    error: unknown,
  ): DirectFailureSourceObservation {
    const errorCode = observationErrorCode(error);
    const lifecycleStateDigest = sha256(
      canonicalJson({
        schema: 'investigation-v3-direct-lifecycle-unavailable.v1',
        errorCode,
      }),
    );
    return freezeCanonical({
      identity: freezeCanonical(identity),
      sourceStateDigest: sha256(
        canonicalJson({
          schema: 'investigation-v3-direct-failure-source-unavailable.v1',
          identity,
          emission: source.emission,
          errorCode,
        }),
      ),
      publicationRecoveryKind: null,
      lifecycleCurrent: false,
      lifecycleNonterminal: false,
      lifecycleStateDigest,
      currentRefDigest: null,
      effectiveState: 'unavailable',
      gitStateDigest: source.emission.gitStateDigest,
      successfulCurrentManifest: false,
      storedEmission: source.emission,
    });
  }

  function observedPublication(
    cwd: string,
    identity: InvestigationV3FailureIdentity,
    source: Extract<
      InvestigationV3FailureSource,
      { observerId: typeof INVESTIGATION_V3_PUBLICATION_STATE_OBSERVER }
    >,
  ): InvestigationV3ObservedFailureSource & {
    lifecycleCurrent: boolean;
    publicationStateDigest: `sha256:${string}`;
    gitStateDigest: `sha256:${string}`;
  } {
    const context = loadInvestigationRuntimeContext(cwd);
    const lifecycle = observePublicationLifecycle(context, identity);
    const publication = observeInvestigationManifestPublicationState({
      repositoryRoot: context.git.repositoryRoot,
      privateRoot: context.git.gitCommonDirectory,
      source: source.source.observation,
    });
    const publicationStateDigest =
      investigationManifestPublicationStateDigest(publication);
    const gitStateDigest = investigationManifestPublicationGitStateDigest(
      context.git,
    );
    return freezeCanonical({
      identity: freezeCanonical({
        ...lifecycle.identity,
        blocker: identity.blocker,
      }),
      sourceStateDigest: sha256(
        canonicalJson({
          schema: 'investigation-v3-publication-failure-source-state.v3',
          repository: {
            repositoryRealPath: context.git.repositoryRealPath,
            gitCommonDirectory: context.git.gitCommonDirectory,
            branch: context.git.branch,
            head: context.git.head,
            tree: context.git.tree,
            statusEntries: [...context.git.statusEntries].sort(),
            gitStateDigest,
          },
          lifecycle: lifecycle.sourceState,
          failureSource: source.source,
          publication,
        }),
      ),
      publicationRecoveryKind: publication.recoveryKind,
      lifecycleCurrent: lifecycle.current,
      publicationStateDigest,
      gitStateDigest,
    });
  }

  function observePublicationLifecycle(
    context: InvestigationFailureObservationContext,
    expected: InvestigationV3FailureIdentity,
  ): Readonly<{
    identity: Omit<InvestigationV3FailureIdentity, 'blocker'>;
    current: boolean;
    sourceState: unknown;
  }> {
    if (isProposeExemptionInvestigationId(expected.investigationId)) {
      const session = readProposeExemptionSession(
        context.runtime,
        expected.investigationId,
      );
      const current = readCurrentProposeExemptionSession(
        context.runtime,
        session.changeId,
      );
      const sessionSnapshotDigest = rawSha256(`${canonicalJson(session)}\n`);
      return freezeCanonical({
        identity: {
          repositoryId: context.config.repositoryName,
          changeId: session.changeId,
          investigationId: session.investigationId,
          sessionRevision: session.revision,
          sessionSnapshotDigest,
        },
        current: current?.investigationId === session.investigationId,
        sourceState: {
          kind: 'propose-exemption-session',
          session,
          currentInvestigationId: current?.investigationId ?? null,
        },
      });
    }
    const session = readInvestigationSession(
      context.runtime,
      expected.investigationId,
    );
    const current = readCurrentInvestigationRef(
      context.runtime,
      session.changeId,
    );
    const sessionSnapshotDigest = rawSha256(`${canonicalJson(session)}\n`);
    return freezeCanonical({
      identity: {
        repositoryId: context.config.repositoryName,
        changeId: session.changeId,
        investigationId: session.investigationId,
        sessionRevision: session.revision,
        sessionSnapshotDigest,
      },
      current: current?.investigationId === session.investigationId,
      sourceState: {
        kind: 'investigation-session',
        session,
        currentInvestigationId: current?.investigationId ?? null,
      },
    });
  }

  function sameFailureIdentity(
    left: InvestigationV3FailureIdentity,
    right: InvestigationV3FailureIdentity,
  ): boolean {
    return canonicalJson(left) === canonicalJson(right);
  }

  function failureIdentityDifferences(
    observed: InvestigationV3FailureIdentity,
    expected: InvestigationV3FailureIdentity,
  ): string[] {
    return [
      'repositoryId',
      'changeId',
      'investigationId',
      'sessionRevision',
      'sessionSnapshotDigest',
      'blocker',
    ].filter(
      (field) =>
        canonicalJson(
          observed[field as keyof InvestigationV3FailureIdentity],
        ) !==
        canonicalJson(expected[field as keyof InvestigationV3FailureIdentity]),
    );
  }

  function rawSha256(value: string): string {
    return crypto.createHash('sha256').update(value).digest('hex');
  }

  function observationErrorCode(error: unknown): string {
    if (isRecord(error) && typeof error.code === 'string') {
      return error.code.slice(0, 256);
    }
    if (error instanceof Error && error.name.length > 0) {
      return error.name.slice(0, 256);
    }
    return 'UNKNOWN';
  }

  function sourceChanged(message: string) {
    return workflowError(
      'INVESTIGATION_V3_FAILURE_SOURCE_CHANGED',
      message,
      ExitCode.staleState,
    );
  }

  return {
    readRepositoryId(cwd) {
      return loadInvestigationRuntimeContext(cwd).config.repositoryName;
    },
    initialInvestigationV3FailureSourceObservation,
    observeInvestigationV3FailureSource,
    captureInvestigationV3DirectFailureEmission,
  };
}

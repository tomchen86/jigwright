import type { createPlanReviewPreparation } from './plan-review-preparation.ts';
import type { createProposeContext } from './propose-context.ts';
import type { createInvestigationRebuild } from './propose-investigation-rebuild.ts';
import type { createProposeProviderLifecycle } from './propose-provider-lifecycle.ts';
import type { createProposePublication } from './propose-publication.ts';
import type { createProposeStatus } from './propose-status.ts';
import path from 'node:path';
import fs from 'node:fs';
import type { InvestigationStatus } from '../../modules/lifecycle/investigation-status.ts';
import type {
  ProposeResumeOptions,
  ProposeOutput,
  ReviewerReconciliationMaterializationReceipt,
} from '../../modules/proposal/propose-types.ts';

import { workflowError, ExitCode } from '../../foundation/errors/errors.ts';

import { publishTrackedInvestigationManifestV3 } from './propose-publication.ts';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import {
  readPlanningMaterializationReceipt,
  persistPlanningMaterializationReceipt,
  indexBehaviorContracts,
  currentPlanningSchemaName,
} from './propose-planning-store.ts';
import {
  createInvestigationManifestAuthorityNode,
  readInvestigationManifestAuthorityNode,
} from '../../modules/proposal/propose-evidence.ts';
import {
  planningMaterializationStale,
  sha256,
  PLANNING_MATERIALIZATION_REF,
  isRecord,
  hasExactKeys,
  isDigestRecord,
} from '../../modules/proposal/propose-values.ts';
import {
  assertReviewerReconciliationLiveArtifacts,
  reclaimReviewerReconciliationTemporaries,
  fsyncReviewerReconciliationDirectory,
  readReviewerReconciliationSnapshotContents,
} from './propose-artifacts.ts';
import { projectInvestigationManifestLedger } from '../../modules/investigation/domain/investigation-design-ledger.ts';

import type { ProposeDecisionServices } from './propose-decision-services.ts';
import { observeInvestigationRuntimeContext as loadInvestigationRuntimeContext } from '../repository-observation/investigation-runtime-context.ts';
import { getInvestigationStatus } from '../investigation-lifecycle/investigation-session.ts';
import { readInvestigationSession } from '../storage-journal/investigation-session-records.ts';
import { replaceTextAtomic } from '../repository-transaction/atomic-text.ts';
import { PROPOSE_POLICY_DIGEST } from '../../modules/provider-orchestration/provider-contracts.ts';
import { readEvidenceRefs } from '../storage-journal/evidence-ref-store.ts';
import { readEvidenceNode } from '../storage-journal/evidence-node-store.ts';
import { readPlanReviewReservation } from './plan-review-store.ts';
import { readPlanReviewTargetSnapshotNode } from '../../modules/assurance/plan-review.ts';
import {
  readProviderInvocationManifest,
  readProviderInvocationRequest,
  readPlanReviewSnapshotRuntime,
} from '../storage-journal/provider-invocation-artifacts.ts';
import type { InvestigationFirstPlanningSubject } from '../../modules/assurance/planning-assurance-validator.ts';
import { assertGuardContribution } from '../../modules/proposal/propose-input.ts';
import type { ChangeContract } from '../../modules/planning-provider/change-contract.ts';
import {
  parseTasks,
  parseExecutionArtifact,
} from '../../modules/planning-provider/planning-artifact-parsers.ts';
import { loadChecksConfig } from '../workflow-configuration/workflow-configuration.ts';
import { parseCurrentInvestigationManifest } from '../repository-validation/change-contract-reader.ts';
export function createReviewerReconciliation({
  planningAssurance,
  dispatchPreparedPlanReview,
  getProposeStatus,
  preparePlanningScaffold,
  preparePlanReviewInvocation,
  rebuildInvestigation,
  withProposeTransitionAuthority,
}: {
  planningAssurance: ProposeDecisionServices['planningAssurance'];
  dispatchPreparedPlanReview: ReturnType<
    typeof createProposeProviderLifecycle
  >['dispatchPreparedPlanReview'];
  getProposeStatus: ReturnType<typeof createProposeStatus>['getProposeStatus'];
  preparePlanningScaffold: ReturnType<
    typeof createProposePublication
  >['preparePlanningScaffold'];
  preparePlanReviewInvocation: ReturnType<
    typeof createPlanReviewPreparation
  >['preparePlanReviewInvocation'];
  rebuildInvestigation: ReturnType<
    typeof createInvestigationRebuild
  >['rebuildInvestigation'];
  withProposeTransitionAuthority: ReturnType<
    typeof createProposeContext
  >['withProposeTransitionAuthority'];
}) {
  function reconcileReviewerTermPlanningRevision(
    cwd: string,
    status: InvestigationStatus,
    options: ProposeResumeOptions,
  ): ProposeOutput {
    const initialContext = loadInvestigationRuntimeContext(cwd);
    withProposeTransitionAuthority(
      cwd,
      initialContext.lifecycleRuntime,
      status.changeId,
      (assertOwned) => {
        assertOwned();
        const current = getInvestigationStatus(cwd, status.investigationId);
        if (current.state !== 'investigation-sealed') {
          throw workflowError(
            'INVESTIGATION_REVIEWER_REOPEN_STALE',
            'Reviewer-term planning reconciliation requires the resealed investigation.',
            ExitCode.staleState,
          );
        }
        const context = loadInvestigationRuntimeContext(cwd);
        const rebuilt = rebuildInvestigation(
          cwd,
          current.investigationId,
          'consume',
          options.collaborationGrantValidation,
          assertOwned,
        );
        if (rebuilt.reviewerTermSourceNode === null) {
          throw workflowError(
            'INVESTIGATION_REVIEWER_REOPEN_STALE',
            'The resealed investigation has no reviewer-term source.',
            ExitCode.staleState,
          );
        }
        const receipt = readReviewerReconciliationMaterializationReceipt(
          context.runtime,
          current,
        );
        const changeDirectory = path.join(
          context.git.repositoryRoot,
          context.config.changeRoot,
          current.changeId,
        );
        const scaffold = preparePlanningScaffold(
          cwd,
          current,
          rebuilt,
          rebuilt.session.createdAt.slice(0, 10),
          true,
          false,
        );
        const publishCurrentScaffold = () => {
          const assertCurrent = () => {
            const observed = readInvestigationSession(
              context.runtime,
              rebuilt.session.investigationId,
            );
            if (canonicalJson(observed) !== canonicalJson(rebuilt.session)) {
              throw workflowError(
                'PROPOSE_INPUT_STALE',
                'Investigation changed during reviewer-term Manifest publication.',
                ExitCode.staleState,
              );
            }
          };
          publishTrackedInvestigationManifestV3({
            context,
            manifest: scaffold.investigationManifest,
            assertOwned,
            assertCurrent,
          });
        };
        // The prior PlanReview reservation/review-root authenticates old bytes,
        // the sealed session projection derives exact next bytes, and the
        // materialization-ref CAS is the commit point. Before that CAS only old
        // or next bytes may exist; after it, retries require exact next bytes and
        // never roll live files back after a downstream error.
        let currentArtifacts: Record<string, string>;
        if (receipt.matchesCurrentSession) {
          const sealedArtifacts = readPlanningMaterializationReceipt(
            context.runtime,
            current,
            createInvestigationManifestAuthorityNode(
              rebuilt,
              scaffold.investigationManifest,
            ),
          );
          if (sealedArtifacts === null) {
            throw planningMaterializationStale(
              'Reviewer-term reconciliation lost its current materialization.',
            );
          }
          assertOwned();
          const sealedLiveArtifacts = assertReviewerReconciliationLiveArtifacts(
            changeDirectory,
            sealedArtifacts,
            sealedArtifacts,
          );
          const sealedBytes = new Map(
            [...sealedLiveArtifacts.entries()].map(
              ([relativePath, artifact]) => [relativePath, artifact.text],
            ),
          );
          reclaimReviewerReconciliationTemporaries(
            changeDirectory,
            sealedBytes,
            sealedBytes,
          );
          assertOwned();
          assertReviewerReconciliationLiveArtifacts(
            changeDirectory,
            sealedArtifacts,
            sealedArtifacts,
          );
          if (
            sealedArtifacts['investigation.json'] !==
            sha256(scaffold.investigationBytes)
          ) {
            throw planningMaterializationStale(
              'Current reviewer-term materialization does not match the resealed investigation.',
            );
          }
          publishCurrentScaffold();
          currentArtifacts = sealedArtifacts;
        } else {
          const previousArtifacts = readReviewerReconciliationSnapshotArtifacts(
            context.runtime,
            context.config.changeRoot,
            current,
            receipt,
          );
          const previousDesign = previousArtifacts.get('design.md');
          if (
            previousDesign === undefined ||
            !previousArtifacts.has('investigation.json')
          ) {
            throw planningMaterializationStale(
              'Reviewer-term reconciliation snapshot is missing a managed target.',
            );
          }
          if (
            scaffold.investigationManifest.applicability.kind !== 'ordinary'
          ) {
            throw planningMaterializationStale(
              'Reviewer-term reconciliation requires an ordinary v3 Manifest.',
            );
          }
          const nextDesign = projectInvestigationManifestLedger(
            previousDesign,
            scaffold.investigationManifest.applicability.semanticDelta
              .whyOverlays,
          );
          const nextBytes = new Map(previousArtifacts);
          nextBytes.set('investigation.json', scaffold.investigationBytes);
          nextBytes.set('design.md', nextDesign);
          const nextArtifacts = Object.fromEntries(
            [...nextBytes.entries()]
              .sort(([left], [right]) => left.localeCompare(right))
              .map(([relativePath, content]) => [
                relativePath,
                sha256(content),
              ]),
          );
          assertOwned();
          reclaimReviewerReconciliationTemporaries(
            changeDirectory,
            previousArtifacts,
            nextBytes,
          );
          assertOwned();
          const liveArtifacts = assertReviewerReconciliationLiveArtifacts(
            changeDirectory,
            receipt.artifacts,
            nextArtifacts,
          );
          const nextDesignContent = nextBytes.get('design.md');
          const liveDesign = liveArtifacts.get('design.md');
          if (nextDesignContent === undefined || liveDesign === undefined) {
            throw planningMaterializationStale(
              'Reviewer-term reconciliation lost a managed target.',
            );
          }
          publishCurrentScaffold();
          if (liveDesign.digest !== nextArtifacts['design.md']) {
            replaceTextAtomic(
              path.join(changeDirectory, 'design.md'),
              nextDesignContent,
              { allowCreate: false },
            );
          }
          assertReviewerReconciliationLiveArtifacts(
            changeDirectory,
            nextArtifacts,
            nextArtifacts,
          );
          fsyncReviewerReconciliationDirectory(changeDirectory);
          persistPlanningMaterializationReceipt(
            context.runtime,
            current,
            createInvestigationManifestAuthorityNode(
              rebuilt,
              scaffold.investigationManifest,
            ),
            nextArtifacts,
            receipt.nodeId,
          );
          currentArtifacts = nextArtifacts;
        }
        const planning = derivePlanningSubjectFromCurrentDraft(
          cwd,
          current,
          scaffold.investigationBytes,
          currentArtifacts,
        );
        preparePlanReviewInvocation(
          cwd,
          current,
          planning,
          options.collaborationGrant,
          options.roleTopologyResolution,
          options.roleContextSharingGrant,
          assertOwned,
        );
        assertOwned();
      },
    );
    let output = getProposeStatus(
      cwd,
      status.investigationId,
      options.collaborationGrantValidation,
    );
    dispatchPreparedPlanReview(cwd, output, options);
    output = getProposeStatus(
      cwd,
      status.investigationId,
      options.collaborationGrantValidation,
    );
    return output;
  }

  function derivePlanningSubjectFromCurrentDraft(
    cwd: string,
    status: InvestigationStatus,
    investigationBytes: string,
    artifactDigestMap: Record<string, string>,
  ): InvestigationFirstPlanningSubject {
    const context = loadInvestigationRuntimeContext(cwd);
    const changeDirectory = path.join(
      context.git.repositoryRoot,
      context.config.changeRoot,
      status.changeId,
    );
    const tasks = parseTasks(
      fs.readFileSync(path.join(changeDirectory, 'tasks.md'), 'utf8'),
    );
    const guard = assertGuardContribution(
      JSON.parse(
        fs.readFileSync(path.join(changeDirectory, 'guard.json'), 'utf8'),
      ),
      status.changeId,
      tasks.map(({ id }) => id),
      Object.keys(loadChecksConfig(context.git.repositoryRoot).checks),
    );
    const specs = Object.keys(artifactDigestMap)
      .filter((relativePath) => relativePath.startsWith('specs/'))
      .sort()
      .map((relativePath) => ({
        path: relativePath,
        content: fs.readFileSync(
          path.join(changeDirectory, relativePath),
          'utf8',
        ),
      }));
    const behaviorContracts = indexBehaviorContracts(specs);
    const execution = parseExecutionArtifact(
      JSON.parse(
        fs.readFileSync(path.join(changeDirectory, 'execution.json'), 'utf8'),
      ),
      status.changeId,
      tasks,
      guard,
      loadChecksConfig(context.git.repositoryRoot),
      behaviorContracts,
    );
    const investigation = parseCurrentInvestigationManifest(
      JSON.parse(investigationBytes),
      status.changeId,
      {
        repositoryRoot: context.git.repositoryRoot,
        expectedRepositoryId: context.config.repositoryName,
        artifactPath: path.join(changeDirectory, 'investigation.json'),
      },
    );
    const checks = loadChecksConfig(context.git.repositoryRoot);
    const contract: ChangeContract = {
      changeId: status.changeId,
      changeDirectory,
      schemaName: currentPlanningSchemaName(context.git.repositoryRoot),
      config: context.config,
      checks,
      guard,
      tasks,
      behaviorContracts,
      investigation,
      execution,
      artifactPaths: Object.keys(artifactDigestMap).map((relativePath) =>
        path.join(changeDirectory, relativePath),
      ),
      artifactDigests: Object.fromEntries(
        Object.entries(artifactDigestMap).map(([relativePath, digest]) => [
          path.join(changeDirectory, relativePath),
          digest,
        ]),
      ),
    };
    return planningAssurance.deriveSubject(
      context.git.repositoryRoot,
      contract,
    );
  }
  return { reconcileReviewerTermPlanningRevision };
}

function readReviewerReconciliationMaterializationReceipt(
  paths: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  status: InvestigationStatus,
): ReviewerReconciliationMaterializationReceipt {
  const nodeId = readEvidenceRefs(paths, status.changeId)[
    PLANNING_MATERIALIZATION_REF
  ];
  if (!nodeId) {
    throw planningMaterializationStale(
      'Reviewer-term reconciliation has no planning materialization.',
    );
  }
  const node = readEvidenceNode(paths, nodeId);
  const output = node.output;
  const authorityNodeId = node.provenanceParentNodeIds.manifestAuthority;
  const authority =
    typeof authorityNodeId === 'string'
      ? readInvestigationManifestAuthorityNode(
          readEvidenceNode(paths, authorityNodeId),
        )
      : null;
  const boundRevision = isRecord(output) ? output.semanticRevision : null;
  if (
    node.type !== 'propose-planning-materialization' ||
    node.nodeSchema !== 'workflow.propose-planning-materialization.v3' ||
    node.evaluator !== 'workflow-propose.v1' ||
    node.policyDigest !== PROPOSE_POLICY_DIGEST ||
    node.outputSchema !==
      'workflow.propose-planning-materialization-output.v3' ||
    authority === null ||
    !isRecord(output) ||
    !hasExactKeys(output, [
      'investigationId',
      'changeId',
      'semanticRevision',
      'baseline',
      'artifacts',
      'manifestAuthorityNodeId',
      'manifestAuthorityResultDigest',
      'manifestDigest',
      'investigationTargetDigest',
      'sessionSnapshotDigest',
    ]) ||
    output.investigationId !== status.investigationId ||
    output.changeId !== status.changeId ||
    !Number.isSafeInteger(boundRevision) ||
    Number(boundRevision) < 0 ||
    Number(boundRevision) > status.semanticRevision ||
    canonicalJson(output.baseline) !== canonicalJson(status.baseline) ||
    !isDigestRecord(output.artifacts) ||
    output.manifestAuthorityNodeId !== authorityNodeId ||
    output.manifestAuthorityResultDigest !==
      node.semanticParentResultDigests.manifestAuthority ||
    output.manifestDigest !== authority.manifestDigest ||
    output.investigationTargetDigest !== authority.investigationTargetDigest ||
    output.sessionSnapshotDigest !== authority.sessionSnapshotDigest ||
    !hasExactKeys(node.exactInputDigests, [
      'artifacts',
      'baseline',
      'manifestAuthority',
      'manifest',
      'investigationTarget',
      'sessionSnapshot',
    ]) ||
    !hasExactKeys(node.provenanceParentNodeIds, ['manifestAuthority']) ||
    !hasExactKeys(node.semanticParentResultDigests, ['manifestAuthority']) ||
    node.exactInputDigests.artifacts !==
      sha256(canonicalJson(output.artifacts)) ||
    node.exactInputDigests.baseline !==
      sha256(canonicalJson(status.baseline)) ||
    node.exactInputDigests.manifestAuthority !== authorityNodeId ||
    node.exactInputDigests.manifest !== authority.manifestDigest ||
    node.exactInputDigests.investigationTarget !==
      authority.investigationTargetDigest ||
    node.exactInputDigests.sessionSnapshot !== authority.sessionSnapshotDigest
  ) {
    throw planningMaterializationStale(
      'Reviewer-term reconciliation materialization is invalid or stale.',
    );
  }
  return {
    nodeId,
    node,
    matchesCurrentSession: Number(boundRevision) === status.semanticRevision,
    artifacts: output.artifacts as Record<string, string>,
  };
}

function readReviewerReconciliationSnapshotArtifacts(
  paths: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  changeRoot: string,
  status: InvestigationStatus,
  receipt: ReviewerReconciliationMaterializationReceipt,
): Map<string, string> {
  const reservation = readPlanReviewReservation(paths, status);
  if (
    reservation === null ||
    reservation.materializationNode.nodeId !== receipt.nodeId ||
    canonicalJson(reservation.materializationNode) !==
      canonicalJson(receipt.node)
  ) {
    throw planningMaterializationStale(
      'Prior PlanReview does not bind the current old materialization.',
    );
  }
  const durableManifest = readProviderInvocationManifest(
    paths,
    reservation.request.invocationId,
  );
  const durableRequest = readProviderInvocationRequest(
    paths,
    reservation.request.invocationId,
  );
  const snapshotRuntime = readPlanReviewSnapshotRuntime(
    paths,
    reservation.request.invocationId,
  );
  if (
    snapshotRuntime === null ||
    canonicalJson(durableManifest) !== canonicalJson(reservation.manifest) ||
    canonicalJson(durableRequest) !== canonicalJson(reservation.request) ||
    canonicalJson(reservation.manifest.planningTarget) !==
      canonicalJson(
        readPlanReviewTargetSnapshotNode(reservation.targetSnapshotNode),
      )
  ) {
    throw planningMaterializationStale(
      'Prior PlanReview snapshot binding is missing or stale.',
    );
  }
  return readReviewerReconciliationSnapshotContents(
    snapshotRuntime.root,
    `${changeRoot}/${status.changeId}/`,
    reservation.manifest.planningTarget.artifacts,
    receipt.artifacts,
  );
}

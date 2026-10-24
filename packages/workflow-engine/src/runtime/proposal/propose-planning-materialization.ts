import type { createPlanReviewPreparation } from './plan-review-preparation.ts';
import type { createProposeContext } from './propose-context.ts';
import type { createProposePublication } from './propose-publication.ts';
import path from 'node:path';
import fs from 'node:fs';
import type { InvestigationStatus } from '../../modules/lifecycle/investigation-status.ts';
import type {
  RebuiltInvestigation,
  ProposeResumeOptions,
} from '../../modules/proposal/propose-types.ts';
import type { RoleTopologyResolutionDependencyPortV1 } from '../../modules/provider-orchestration/role-topology-resolution.ts';
import {
  assertPlanningPayload,
  assertGuardContribution,
  assertAuthoredMarkdown,
  assertSpecContributions,
} from '../../modules/proposal/propose-input.ts';

import { planningContributionInvalid } from '../../modules/proposal/propose-values.ts';
import { assertPlanningTaskHistory } from '../../modules/planning-provider/planning-task-history.ts';
import {
  indexBehaviorContracts,
  readPlanningMaterializationReceipt,
  currentPlanningSchemaName,
  persistPlanningMaterializationReceipt,
  readExemptionPlanningMaterializationReceipt,
  persistExemptionPlanningMaterializationReceipt,
} from './propose-planning-store.ts';
import { projectInvestigationManifestLedger } from '../../modules/investigation/domain/investigation-design-ledger.ts';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { currentChangeOriginBytes } from './propose-context.ts';
import {
  artifactDigests,
  assertPlanningTargetsCompatible,
} from './propose-artifacts.ts';
import { createInvestigationManifestAuthorityNode } from '../../modules/proposal/propose-evidence.ts';
import { workflowError, ExitCode } from '../../foundation/errors/errors.ts';
import type { ChangeContract } from '../../modules/planning-provider/change-contract.ts';

import type { ProposeDecisionServices } from './propose-decision-services.ts';
import { observeInvestigationRuntimeContext as loadInvestigationRuntimeContext } from '../repository-observation/investigation-runtime-context.ts';
import {
  parseTasks,
  parseExecutionArtifact,
} from '../../modules/planning-provider/planning-artifact-parsers.ts';
import { readFileAtCommit } from '../repository-transaction/git-command.ts';
import { loadChecksConfig } from '../workflow-configuration/workflow-configuration.ts';
import { replaceTextAtomic } from '../repository-transaction/atomic-text.ts';
import { parseCurrentInvestigationManifest } from '../repository-validation/change-contract-reader.ts';
import type { ProposeExemptionSession } from '../../modules/lifecycle/propose-exemption-session.ts';
export function createPlanningMaterialization({
  createPlanningAuthoringPort,
  planningAssurance,
  assertCurrentGovernanceSources,
  prepareExemptionPlanningScaffold,
  preparePlanningScaffold,
  preparePlanReviewInvocation,
}: {
  createPlanningAuthoringPort: ProposeDecisionServices['planningProvider']['createAuthoringPort'];
  planningAssurance: ProposeDecisionServices['planningAssurance'];
  assertCurrentGovernanceSources: ReturnType<
    typeof createProposeContext
  >['assertCurrentGovernanceSources'];
  prepareExemptionPlanningScaffold: ReturnType<
    typeof createProposePublication
  >['prepareExemptionPlanningScaffold'];
  preparePlanningScaffold: ReturnType<
    typeof createProposePublication
  >['preparePlanningScaffold'];
  preparePlanReviewInvocation: ReturnType<
    typeof createPlanReviewPreparation
  >['preparePlanReviewInvocation'];
}) {
  function materializePlanningContribution(
    cwd: string,
    status: InvestigationStatus,
    rebuilt: RebuiltInvestigation,
    payloadInput: unknown,
    collaborationGrant?: ProposeResumeOptions['collaborationGrant'],
    roleTopologyResolution?: RoleTopologyResolutionDependencyPortV1,
    roleContextSharingGrant?: ProposeResumeOptions['roleContextSharingGrant'],
    assertOwned: () => void = () => {},
  ): Record<string, string> {
    const payload = assertPlanningPayload(payloadInput);
    // The full entries map below owns every scaffold byte with rollback, so the
    // scaffold itself stays a pure projection here.
    const scaffold = preparePlanningScaffold(
      cwd,
      status,
      rebuilt,
      rebuilt.session.createdAt.slice(0, 10),
      true,
      false,
    );
    const context = loadInvestigationRuntimeContext(cwd);
    const tasks = parseTasks(payload.tasks);
    if (tasks.length === 0) {
      throw planningContributionInvalid('Planning tasks must be non-empty.');
    }
    // One judgment for both gates: the transition's task-history rule, applied
    // against the session baseline. A fresh change has no baseline tasks and
    // must arrive unchecked; an amendment carries the executed record forward
    // untouched, and may only send it back whole.
    const baselineTasks = readFileAtCommit(
      context.git.repositoryRoot,
      rebuilt.session.baseline.head,
      `${context.config.changeRoot}/${status.changeId}/tasks.md`,
    );
    assertPlanningTaskHistory(
      baselineTasks === undefined ? undefined : parseTasks(baselineTasks),
      tasks,
      { reopenAuthorized: true },
    );
    const guard = assertGuardContribution(
      payload.guard,
      status.changeId,
      tasks.map(({ id }) => id),
      Object.keys(loadChecksConfig(context.git.repositoryRoot).checks),
    );
    const behaviorContracts = indexBehaviorContracts(payload.specs);
    const execution = parseExecutionArtifact(
      {
        schemaVersion: 1,
        kind: 'execution-artifact',
        changeId: status.changeId,
        tasks: payload.executionTasks,
      },
      status.changeId,
      tasks,
      guard,
      loadChecksConfig(context.git.repositoryRoot),
      behaviorContracts,
    );
    if (scaffold.investigationManifest.applicability.kind !== 'ordinary') {
      throw planningContributionInvalid(
        'Ordinary planning requires an ordinary Investigation v3 Manifest.',
      );
    }
    const projectedDesign = projectInvestigationManifestLedger(
      payload.design,
      scaffold.investigationManifest.applicability.semanticDelta.whyOverlays,
    );
    const entries = new Map<string, string>([
      ['.openspec.yaml', scaffold.metadataBytes],
      ['investigation.json', scaffold.investigationBytes],
      ['proposal.md', assertAuthoredMarkdown(payload.proposal, 'proposal')],
      ['design.md', projectedDesign],
      ['tasks.md', assertAuthoredMarkdown(payload.tasks, 'tasks')],
      ['guard.json', `${canonicalJson(guard)}\n`],
      ['execution.json', `${canonicalJson(execution)}\n`],
    ]);
    assertCurrentGovernanceSources(
      context.git.repositoryRoot,
      rebuilt.intent.sourceRefs,
    );
    if (rebuilt.intent.sourceRefs.length > 0) {
      entries.set(
        'origin.json',
        currentChangeOriginBytes(rebuilt.intent.sourceRefs),
      );
    }
    for (const spec of assertSpecContributions(payload.specs)) {
      entries.set(spec.path, spec.content);
    }
    const digests = artifactDigests(entries);
    const manifestAuthorityNode = createInvestigationManifestAuthorityNode(
      rebuilt,
      scaffold.investigationManifest,
    );
    const existingReceipt = readPlanningMaterializationReceipt(
      context.runtime,
      status,
      manifestAuthorityNode,
    );
    if (
      existingReceipt !== null &&
      canonicalJson(existingReceipt) !== canonicalJson(digests)
    ) {
      throw workflowError(
        'PLANNING_MATERIALIZATION_CONFLICT',
        'A different planning materialization is already current.',
        ExitCode.conflict,
      );
    }
    assertPlanningTargetsCompatible(
      scaffold.changeDirectory,
      entries,
      false,
      false,
      false,
      scaffold.replaceablePriorGeneration,
    );
    const createdPaths: string[] = [];
    const replacedBytes = new Map<string, string>();
    try {
      // The prior generation's review reviewed the plan this contribution
      // replaces; removing it returns the graph to review-pending for the fresh
      // review the amendment must earn. Only pristine committed bytes qualify —
      // anything else was already refused above.
      const priorReviewPath = path.join(
        scaffold.changeDirectory,
        'plan-review.json',
      );
      const priorReviewStats = fs.lstatSync(priorReviewPath, {
        throwIfNoEntry: false,
      });
      if (priorReviewStats?.isFile() && !priorReviewStats.isSymbolicLink()) {
        const priorReview = fs.readFileSync(priorReviewPath, 'utf8');
        if (
          scaffold.replaceablePriorGeneration('plan-review.json', priorReview)
        ) {
          fs.rmSync(priorReviewPath);
          replacedBytes.set(priorReviewPath, priorReview);
        }
      }
      for (const [relativePath, content] of entries) {
        const target = path.join(scaffold.changeDirectory, relativePath);
        if (fs.existsSync(target)) {
          const stats = fs.lstatSync(target);
          const existing =
            stats.isFile() && !stats.isSymbolicLink()
              ? fs.readFileSync(target, 'utf8')
              : null;
          if (existing === content) {
            continue;
          }
          if (
            existing === null ||
            !scaffold.replaceablePriorGeneration(relativePath, existing)
          ) {
            throw workflowError(
              'UNMANAGED_PLANNING_CONFLICT',
              'Planning bytes changed during managed materialization.',
              ExitCode.conflict,
            );
          }
          replaceTextAtomic(target, content, {
            defaultMode: 0o644,
          });
          replacedBytes.set(target, existing);
          continue;
        }
        replaceTextAtomic(target, content, {
          allowCreate: true,
          defaultMode: 0o644,
        });
        createdPaths.push(target);
      }
      const authoring = createPlanningAuthoringPort(context.git.repositoryRoot);
      const statusPayload = authoring.inspectStatus(
        status.changeId,
        currentPlanningSchemaName(context.git.repositoryRoot),
      );
      const planReview = statusPayload.artifacts.find(
        ({ id }) => id === 'plan-review',
      );
      if (
        statusPayload.isComplete ||
        planReview?.status !== 'ready' ||
        statusPayload.artifacts.some(
          ({ id, status: artifactStatus }) =>
            id !== 'plan-review' && artifactStatus !== 'done',
        )
      ) {
        throw planningContributionInvalid(
          'OpenSpec did not observe the expected review-pending planning graph.',
        );
      }
      assertPlanningTargetsCompatible(scaffold.changeDirectory, entries, false);
      persistPlanningMaterializationReceipt(
        context.runtime,
        status,
        manifestAuthorityNode,
        digests,
      );
      const investigation = parseCurrentInvestigationManifest(
        JSON.parse(scaffold.investigationBytes),
        status.changeId,
        {
          repositoryRoot: context.git.repositoryRoot,
          expectedRepositoryId: context.config.repositoryName,
          artifactPath: path.join(
            scaffold.changeDirectory,
            'investigation.json',
          ),
        },
      );
      const checks = loadChecksConfig(context.git.repositoryRoot);
      const draftContract: ChangeContract = {
        changeId: status.changeId,
        changeDirectory: scaffold.changeDirectory,
        schemaName: currentPlanningSchemaName(context.git.repositoryRoot),
        config: context.config,
        checks,
        guard,
        tasks,
        behaviorContracts,
        investigation,
        execution,
        artifactPaths: [...entries.keys()].map((relativePath) =>
          path.join(scaffold.changeDirectory, relativePath),
        ),
        artifactDigests: Object.fromEntries(
          Object.entries(digests).map(([relativePath, digest]) => [
            path.join(scaffold.changeDirectory, relativePath),
            digest,
          ]),
        ),
      };
      const planningSubject = planningAssurance.deriveSubject(
        context.git.repositoryRoot,
        draftContract,
      );
      preparePlanReviewInvocation(
        cwd,
        status,
        planningSubject,
        collaborationGrant,
        roleTopologyResolution,
        roleContextSharingGrant,
        assertOwned,
      );
    } catch (error) {
      for (const target of createdPaths.reverse()) {
        fs.rmSync(target, { force: true });
      }
      for (const [target, previous] of replacedBytes) {
        // allowCreate restores the prior plan review, which was removed rather
        // than replaced.
        replaceTextAtomic(target, previous, {
          allowCreate: true,
          defaultMode: 0o644,
        });
      }
      throw error;
    }
    return digests;
  }

  function materializeExemptionPlanningContribution(
    cwd: string,
    session: ProposeExemptionSession,
    payloadInput: unknown,
    collaborationGrant?: ProposeResumeOptions['collaborationGrant'],
    roleTopologyResolution?: RoleTopologyResolutionDependencyPortV1,
    roleContextSharingGrant?: ProposeResumeOptions['roleContextSharingGrant'],
    assertOwned: () => void = () => {},
  ): Record<string, string> {
    const payload = assertPlanningPayload(payloadInput);
    const scaffold = prepareExemptionPlanningScaffold(
      cwd,
      session,
      true,
      false,
      false,
    );
    const context = loadInvestigationRuntimeContext(cwd);
    const tasks = parseTasks(payload.tasks);
    if (tasks.length === 0 || tasks.some(({ completed }) => completed)) {
      throw planningContributionInvalid(
        'Planning tasks must be non-empty and unchecked.',
      );
    }
    const guard = assertGuardContribution(
      payload.guard,
      session.changeId,
      tasks.map(({ id }) => id),
      Object.keys(loadChecksConfig(context.git.repositoryRoot).checks),
    );
    const behaviorContracts = indexBehaviorContracts(payload.specs);
    const execution = parseExecutionArtifact(
      {
        schemaVersion: 1,
        kind: 'execution-artifact',
        changeId: session.changeId,
        tasks: payload.executionTasks,
      },
      session.changeId,
      tasks,
      guard,
      loadChecksConfig(context.git.repositoryRoot),
      behaviorContracts,
    );
    const entries = new Map<string, string>([
      [
        '.openspec.yaml',
        `schema: ${currentPlanningSchemaName(context.git.repositoryRoot)}\ncreated: ${session.createdAt.slice(0, 10)}\n`,
      ],
      ['investigation.json', scaffold.investigationBytes],
      ['proposal.md', assertAuthoredMarkdown(payload.proposal, 'proposal')],
      ['design.md', assertAuthoredMarkdown(payload.design, 'design')],
      ['tasks.md', assertAuthoredMarkdown(payload.tasks, 'tasks')],
      ['guard.json', `${canonicalJson(guard)}\n`],
      ['execution.json', `${canonicalJson(execution)}\n`],
    ]);
    assertCurrentGovernanceSources(
      context.git.repositoryRoot,
      session.intent.sourceRefs,
    );
    if (session.intent.sourceRefs.length > 0) {
      entries.set(
        'origin.json',
        currentChangeOriginBytes(session.intent.sourceRefs),
      );
    }
    for (const spec of assertSpecContributions(payload.specs)) {
      entries.set(spec.path, spec.content);
    }

    const digests = artifactDigests(entries);
    const existingReceipt = readExemptionPlanningMaterializationReceipt(
      context.runtime,
      session,
    );
    if (
      existingReceipt !== null &&
      canonicalJson(existingReceipt) !== canonicalJson(digests)
    ) {
      throw workflowError(
        'PLANNING_MATERIALIZATION_CONFLICT',
        'A different planning materialization is already current.',
        ExitCode.conflict,
      );
    }
    assertPlanningTargetsCompatible(scaffold.changeDirectory, entries, false);
    const createdPaths: string[] = [];
    try {
      for (const [relativePath, content] of entries) {
        const target = path.join(scaffold.changeDirectory, relativePath);
        if (fs.existsSync(target)) {
          const stats = fs.lstatSync(target);
          if (
            !stats.isFile() ||
            stats.isSymbolicLink() ||
            fs.readFileSync(target, 'utf8') !== content
          ) {
            throw workflowError(
              'UNMANAGED_PLANNING_CONFLICT',
              'Planning bytes changed during managed materialization.',
              ExitCode.conflict,
            );
          }
          continue;
        }
        replaceTextAtomic(target, content, {
          allowCreate: true,
          defaultMode: 0o644,
        });
        createdPaths.push(target);
      }
      const authoring = createPlanningAuthoringPort(context.git.repositoryRoot);
      const statusPayload = authoring.inspectStatus(
        session.changeId,
        currentPlanningSchemaName(context.git.repositoryRoot),
      );
      const planReview = statusPayload.artifacts.find(
        ({ id }) => id === 'plan-review',
      );
      if (
        statusPayload.isComplete ||
        planReview?.status !== 'ready' ||
        statusPayload.artifacts.some(
          ({ id, status: artifactStatus }) =>
            id !== 'plan-review' && artifactStatus !== 'done',
        )
      ) {
        throw planningContributionInvalid(
          'OpenSpec did not observe the expected review-pending planning graph.',
        );
      }
      assertPlanningTargetsCompatible(scaffold.changeDirectory, entries, false);
      persistExemptionPlanningMaterializationReceipt(
        context.runtime,
        session,
        digests,
      );
      const investigation = parseCurrentInvestigationManifest(
        JSON.parse(scaffold.investigationBytes),
        session.changeId,
        {
          repositoryRoot: context.git.repositoryRoot,
          expectedRepositoryId: context.config.repositoryName,
          artifactPath: path.join(
            scaffold.changeDirectory,
            'investigation.json',
          ),
        },
      );
      const checks = loadChecksConfig(context.git.repositoryRoot);
      const draftContract: ChangeContract = {
        changeId: session.changeId,
        changeDirectory: scaffold.changeDirectory,
        schemaName: currentPlanningSchemaName(context.git.repositoryRoot),
        config: context.config,
        checks,
        guard,
        tasks,
        behaviorContracts,
        investigation,
        execution,
        artifactPaths: [...entries.keys()].map((relativePath) =>
          path.join(scaffold.changeDirectory, relativePath),
        ),
        artifactDigests: Object.fromEntries(
          Object.entries(digests).map(([relativePath, digest]) => [
            path.join(scaffold.changeDirectory, relativePath),
            digest,
          ]),
        ),
      };
      const planningSubject = planningAssurance.deriveSubject(
        context.git.repositoryRoot,
        draftContract,
      );
      preparePlanReviewInvocation(
        cwd,
        session,
        planningSubject,
        collaborationGrant,
        roleTopologyResolution,
        roleContextSharingGrant,
        assertOwned,
      );
    } catch (error) {
      for (const target of createdPaths.reverse()) {
        fs.rmSync(target, { force: true });
      }
      throw error;
    }
    return digests;
  }
  return {
    materializePlanningContribution,
    materializeExemptionPlanningContribution,
  };
}

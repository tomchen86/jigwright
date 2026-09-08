/**
 * Validates authored planning contributions and materializes their reviewable artifacts.
 *
 * Invariants:
 * - Tasks, guard, execution, specs, and investigation evidence describe one planning graph.
 * - Task history and prior managed bytes retain their baseline authority during replacement.
 * - Rollback restores only owned mutations; receipts bind the exact materialized bytes.
 *
 * Depends on: planning validators, scaffolds, atomic artifacts, receipts, and review preparation.
 * Failure modes: inconsistent planning graphs, overwritten unmanaged edits, or mismatched receipts.
 */

import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import { deriveInvestigationFirstPlanningSubject } from '../../modules/assurance/planning-assurance-validator.ts';
import { assertPlanningTaskHistory } from '../../modules/planning-provider/planning-task-history.ts';
import { projectInvestigationManifestLedger } from '../../modules/projection/investigation-design-projection.ts';
import { type RoleTopologyResolutionDependencyPortV1 } from '../../modules/provider-orchestration/role-topology-resolution.ts';
import { preparePlanReviewInvocation } from './plan-review-preparation.ts';
import {
  artifactDigests,
  assertPlanningTargetsCompatible,
} from './propose-artifacts.ts';
import { planningContributionInvalid } from './propose-common.ts';
import {
  assertCurrentGovernanceSources,
  currentChangeOriginBytes,
} from './propose-context.ts';
import { createInvestigationManifestAuthorityNode } from './propose-evidence.ts';
import {
  assertAuthoredMarkdown,
  assertGuardContribution,
  assertPlanningPayload,
  assertSpecContributions,
} from './propose-input.ts';
import {
  currentPlanningSchemaName,
  indexBehaviorContracts,
  persistExemptionPlanningMaterializationReceipt,
  persistPlanningMaterializationReceipt,
  readExemptionPlanningMaterializationReceipt,
  readPlanningMaterializationReceipt,
} from './propose-planning-store.ts';
import {
  prepareExemptionPlanningScaffold,
  preparePlanningScaffold,
} from './propose-publication.ts';
import type {
  ChangeContract,
  InvestigationStatus,
  ProposeExemptionSession,
  ProposeRuntime,
} from './propose-runtime.ts';
import {
  type ProposeResumeOptions,
  type RebuiltInvestigation,
} from './propose-types.ts';

export function materializePlanningContribution(
  services: ProposeRuntime,
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
    services,
    cwd,
    status,
    rebuilt,
    rebuilt.session.createdAt.slice(0, 10),
    true,
    false,
  );
  const context = services.workspace.loadInvestigationRuntimeContext(cwd);
  const tasks = services.workspace.parseTasks(payload.tasks);
  if (tasks.length === 0) {
    throw planningContributionInvalid('Planning tasks must be non-empty.');
  }
  // One judgment for both gates: the transition's task-history rule, applied
  // against the session baseline. A fresh change has no baseline tasks and
  // must arrive unchecked; an amendment carries the executed record forward
  // untouched, and may only send it back whole.
  const baselineTasks = services.workspace.readFileAtCommit(
    context.git.repositoryRoot,
    rebuilt.session.baseline.head,
    `${context.config.changeRoot}/${status.changeId}/tasks.md`,
  );
  assertPlanningTaskHistory(
    baselineTasks === undefined
      ? undefined
      : services.workspace.parseTasks(baselineTasks),
    tasks,
    { reopenAuthorized: true },
  );
  const guard = assertGuardContribution(
    payload.guard,
    status.changeId,
    tasks.map(({ id }) => id),
    Object.keys(
      services.workspace.loadChecksConfig(context.git.repositoryRoot).checks,
    ),
  );
  const behaviorContracts = indexBehaviorContracts(payload.specs);
  const execution = services.workspace.parseExecutionArtifact(
    {
      schemaVersion: 1,
      kind: 'execution-artifact',
      changeId: status.changeId,
      tasks: payload.executionTasks,
    },
    status.changeId,
    tasks,
    guard,
    services.workspace.loadChecksConfig(context.git.repositoryRoot),
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
    services,
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
        services.workspace.replaceTextAtomic(target, content, {
          defaultMode: 0o644,
        });
        replacedBytes.set(target, existing);
        continue;
      }
      services.workspace.replaceTextAtomic(target, content, {
        allowCreate: true,
        defaultMode: 0o644,
      });
      createdPaths.push(target);
    }
    const authoring = services.workspace.planningProviderAuthoring(context);
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
      services,
      context.runtime,
      status,
      manifestAuthorityNode,
      digests,
    );
    const investigation = services.workspace.parseCurrentInvestigationManifest(
      JSON.parse(scaffold.investigationBytes),
      status.changeId,
      {
        repositoryRoot: context.git.repositoryRoot,
        expectedRepositoryId: context.config.repositoryName,
        artifactPath: path.join(scaffold.changeDirectory, 'investigation.json'),
      },
    );
    const checks = services.workspace.loadChecksConfig(
      context.git.repositoryRoot,
    );
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
    const planningSubject = deriveInvestigationFirstPlanningSubject(
      context.git.repositoryRoot,
      draftContract,
    );
    preparePlanReviewInvocation(
      services,
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
      services.workspace.replaceTextAtomic(target, previous, {
        allowCreate: true,
        defaultMode: 0o644,
      });
    }
    throw error;
  }
  return digests;
}

export function materializeExemptionPlanningContribution(
  services: ProposeRuntime,
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
    services,
    cwd,
    session,
    true,
    false,
    false,
  );
  const context = services.workspace.loadInvestigationRuntimeContext(cwd);
  const tasks = services.workspace.parseTasks(payload.tasks);
  if (tasks.length === 0 || tasks.some(({ completed }) => completed)) {
    throw planningContributionInvalid(
      'Planning tasks must be non-empty and unchecked.',
    );
  }
  const guard = assertGuardContribution(
    payload.guard,
    session.changeId,
    tasks.map(({ id }) => id),
    Object.keys(
      services.workspace.loadChecksConfig(context.git.repositoryRoot).checks,
    ),
  );
  const behaviorContracts = indexBehaviorContracts(payload.specs);
  const execution = services.workspace.parseExecutionArtifact(
    {
      schemaVersion: 1,
      kind: 'execution-artifact',
      changeId: session.changeId,
      tasks: payload.executionTasks,
    },
    session.changeId,
    tasks,
    guard,
    services.workspace.loadChecksConfig(context.git.repositoryRoot),
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
    services,
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
      services.workspace.replaceTextAtomic(target, content, {
        allowCreate: true,
        defaultMode: 0o644,
      });
      createdPaths.push(target);
    }
    const authoring = services.workspace.planningProviderAuthoring(context);
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
      services,
      context.runtime,
      session,
      digests,
    );
    const investigation = services.workspace.parseCurrentInvestigationManifest(
      JSON.parse(scaffold.investigationBytes),
      session.changeId,
      {
        repositoryRoot: context.git.repositoryRoot,
        expectedRepositoryId: context.config.repositoryName,
        artifactPath: path.join(scaffold.changeDirectory, 'investigation.json'),
      },
    );
    const checks = services.workspace.loadChecksConfig(
      context.git.repositoryRoot,
    );
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
    const planningSubject = deriveInvestigationFirstPlanningSubject(
      context.git.repositoryRoot,
      draftContract,
    );
    preparePlanReviewInvocation(
      services,
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

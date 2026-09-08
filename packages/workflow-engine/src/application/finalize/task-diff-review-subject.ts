// Reconstruct the checked candidate and verify its baseline, index, and documentation.
import {
  type TaskDiffReviewSubject,
  deriveTaskDiffReviewCandidatePlan,
  createTaskDiffReviewSubject,
  type TaskDiffReviewRequirement,
  type TaskDiffDocumentationClosureRequirement,
  createTaskDiffDocumentationClosureRequirement,
  type TaskDiffDocumentationHint,
  taskDiffReviewRequirement,
  type TaskDiffPathTransition,
  type TaskDiffTreeEntry,
} from '../../modules/assurance/task-diff-review.ts';
import { type TaskDiffReviewRecord } from '../../modules/assurance/task-diff-review-artifact.ts';
import {
  inspectSession,
  persistSession,
  type SessionInspection,
} from './verification.ts';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { workflowError, ExitCode } from '../../foundation/errors/errors.ts';
import { parseMaintainerPolicy } from '../../modules/authority/maintainer-policy.ts';
import { digestRequiredCheckDefinitions } from '../../modules/lifecycle/contract-digests.ts';
import {
  parsePathRoleRegistry,
  resolvePathRole,
} from '../../modules/source/path-role-registry.ts';
import { type ProviderId } from '../../modules/provider-orchestration/provider-registry.ts';
import { type RecordedRoleParticipant } from '../../modules/provider-orchestration/role-scheduler.ts';
import { resolveCurrentTaskStrategyCorrection } from '../execute-task/task-strategy-correction.ts';
import {
  createTaskStrategyImplementationSubject,
  createTaskStrategyCorrectionSubject,
} from '../../modules/provider-orchestration/task-strategy-provider-contract.ts';
import { resolveActorIdentity } from '../../modules/provider-orchestration/actor-identity.ts';
import type { TaskDiffReviewRuntimeBindings } from './task-diff-review-lifecycle.ts';
import type { BeginTaskDiffReviewOptions } from './task-diff-review-contracts.ts';
import type { createTaskDiffReviewCommonModule } from './task-diff-review-common.ts';

export function createTaskDiffReviewSubjectModule(
  runtime: TaskDiffReviewRuntimeBindings,
  common: ReturnType<typeof createTaskDiffReviewCommonModule>,
) {
  const {
    loadActiveSessionContext,
    readFinalizeTransaction,
    readSessionReport,
    assertInspectionReport,
    assertReportChecks,
    findCurrentExecutionTaskCommits,
    runGit,
    completionDocumentPaths,
    loadInvestigationRuntimeContext,
    readTaskStrategyTransaction,
    readTaskStrategyGreenFailureRecord,
    readTaskStrategyCallerImplementationBinding,
    readTaskStrategyImplementationResultBinding,
    previewExactStaging,
    listStagedPaths,
    fingerprintUnstagedRepositoryProjection,
  } = runtime;
  const {
    reviewNotSatisfied,
    reviewNotReady,
    candidateDiverged,
    parseBaselineJson,
    sha256,
  } = common;
  function assertTaskDiffReviewCandidateCurrent(
    subject: TaskDiffReviewSubject,
    review: TaskDiffReviewRecord,
  ): void {
    const plan = deriveTaskDiffReviewCandidatePlan({
      current: subject,
      predecessor: {
        subject: review.subject,
        reviewRecordDigest: review.recordDigest,
        finalAssuranceCommitmentDigest: null,
      },
    });
    if (plan.action !== 'reuse') throw reviewNotSatisfied();
  }

  function bindDocumentationRemediation(
    cwd: string,
    requestedSessionId: string,
    review: TaskDiffReviewRecord,
  ): void {
    const assessment = review.documentationAssessment;
    if (assessment?.decision !== 'needs-changes') return;
    const context = loadActiveSessionContext(cwd, requestedSessionId);
    const transaction = readFinalizeTransaction(
      context.runtime.root,
      context.session.sessionId,
    );
    if (
      transaction === null ||
      !['checked', 'staged', 'reports-persisted', 'completed'].includes(
        transaction.phase,
      )
    ) {
      throw reviewNotReady();
    }
    const inspection = inspectSession(cwd, requestedSessionId, {
      expectedSession: context.session,
      projectedTaskIds: [...transaction.completedTaskIds],
      projectionSourceDigest: transaction.projectionSourceDigest,
      authorizedTransitionPaths: [...transaction.transitionPaths],
    });
    const current = inspection.session.documentationRemediation;
    const reviewRecordDigests = [
      ...(current?.reviewRecordDigests ?? []),
      review.recordDigest,
    ]
      .filter((candidate, index, values) => values.indexOf(candidate) === index)
      .sort();
    const paths = [...(current?.paths ?? []), ...assessment.requiredPaths]
      .filter((candidate, index, values) => values.indexOf(candidate) === index)
      .sort();
    if (
      canonicalJson(current ?? null) ===
      canonicalJson({ reviewRecordDigests, paths })
    ) {
      return;
    }
    persistSession(inspection, {
      ...inspection.session,
      documentationRemediation: { reviewRecordDigests, paths },
    });
  }

  function inspectTaskDiffReviewSubject(
    cwd: string,
    requestedSessionId: string,
  ): TaskDiffReviewSubject {
    const context = loadActiveSessionContext(cwd, requestedSessionId);
    const transaction = readFinalizeTransaction(
      context.runtime.root,
      context.session.sessionId,
    );
    if (
      transaction === null ||
      !['checked', 'staged', 'reports-persisted', 'completed'].includes(
        transaction.phase,
      ) ||
      transaction.candidateTree === null ||
      transaction.candidateFingerprint === null ||
      transaction.checkReportId === null
    ) {
      throw reviewNotReady();
    }
    const checkedTransaction = transaction as typeof transaction & {
      candidateTree: string;
      candidateFingerprint: string;
      checkReportId: string;
    };
    if (
      transaction.sessionId !== context.session.sessionId ||
      transaction.changeId !== context.session.changeId ||
      transaction.taskId !== context.session.taskId ||
      transaction.repositoryRoot !== context.git.repositoryRealPath ||
      transaction.gitCommonDirectory !== context.git.gitCommonDirectory ||
      transaction.branch !== context.session.branch ||
      canonicalJson(transaction.baseline) !==
        canonicalJson(context.session.baseline)
    ) {
      throw candidateDiverged();
    }

    const inspection = inspectSession(cwd, context.session.sessionId, {
      expectedSession: context.session,
      projectedTaskIds: [...transaction.completedTaskIds],
      projectionSourceDigest: transaction.projectionSourceDigest,
      authorizedTransitionPaths: [...transaction.transitionPaths],
    });
    if (
      canonicalJson(inspection.changedPaths) !==
        canonicalJson(transaction.changedPaths) ||
      inspection.fingerprint !== transaction.candidateFingerprint ||
      canonicalJson(inspection.git.statusEntries) !==
        canonicalJson(transaction.candidateStatusEntries)
    ) {
      throw candidateDiverged();
    }
    assertCandidateIndex(inspection, checkedTransaction);

    const checkReport = readSessionReport(
      inspection,
      checkedTransaction.checkReportId,
    );
    const requiredChecks = [...transaction.requiredChecks];
    assertInspectionReport(
      checkReport,
      inspection,
      'check',
      'TASK_DIFF_REVIEW_CHECK_EVIDENCE_STALE',
      requiredChecks,
    );
    assertReportChecks(
      checkReport,
      inspection,
      requiredChecks,
      'TASK_DIFF_REVIEW_CHECK_EVIDENCE_STALE',
    );
    if (
      checkReport.candidateTree !== checkedTransaction.candidateTree ||
      checkReport.finalizeProfile !==
        'projected-single-pass-ordinary-failure' ||
      checkReport.checkEscalation !== transaction.checkEscalation
    ) {
      throw candidateDiverged();
    }

    const planningAssurance = inspection.session.planningAssurance ?? null;
    if (planningAssurance === null) {
      throw workflowError(
        'TASK_DIFF_REVIEW_PLANNING_ASSURANCE_REQUIRED',
        'TaskDiffReview requires the exact planning assurance binding for this task.',
        ExitCode.staleState,
      );
    }
    const { executionTask, requirement } =
      resolveTaskDiffReviewContract(inspection);
    const maintainerPolicy = parseBaselineJson(
      inspection.git.repositoryRoot,
      inspection.session.baseline.head,
      'workflow/maintainer-policy.json',
      parseMaintainerPolicy,
    );
    const requiredCheckDigests = digestRequiredCheckDefinitions(
      inspection.contract.checks,
      requiredChecks,
    );

    const documentationRequirement = taskDiffDocumentationRequirement(
      inspection,
      checkedTransaction.candidateTree,
    );
    return createTaskDiffReviewSubject({
      repositoryId: maintainerPolicy.repository.id,
      changeId: inspection.session.changeId,
      taskId: inspection.session.taskId,
      baseCommit: inspection.session.baseline.head,
      baseTree: inspection.session.baseline.tree,
      candidateTree: checkedTransaction.candidateTree,
      transitions: deriveTransitions(
        inspection.git.repositoryRoot,
        inspection.session.baseline.tree,
        checkedTransaction.candidateTree,
        transaction.changedPaths,
      ),
      taskContractDigest: sha256(
        canonicalJson({
          schemaVersion: 1,
          kind: 'task-diff-review-task-contract.v1',
          guardTask: inspection.policy,
          executionTask,
        }),
      ),
      requiredCheckPolicyDigest: sha256(
        canonicalJson({
          schemaVersion: 1,
          kind: 'task-diff-review-check-policy.v1',
          requiredCheckDigests,
        }),
      ),
      checkEvidenceDigest: checkedTransaction.checkReportId,
      planningGenerationId: planningAssurance.planningGenerationId,
      planTargetDigest: planningAssurance.planTargetDigest,
      planReviewNodeId: planningAssurance.reviewNodeId,
      planningAssuranceDigest: sha256(canonicalJson(planningAssurance)),
      reviewRequirement: taskDiffReviewRequirementIncludingDocumentation(
        requirement,
        documentationRequirement,
      ),
      documentationRequirement,
    });
  }

  function taskDiffReviewRequirementIncludingDocumentation(
    requirement: TaskDiffReviewRequirement,
    documentationRequirement?: TaskDiffDocumentationClosureRequirement,
  ): TaskDiffReviewRequirement {
    return documentationRequirement?.required === true && !requirement.required
      ? { required: true, basis: 'explicit', riskPaths: [] }
      : requirement;
  }

  function taskDiffDocumentationRequirement(
    inspection: SessionInspection,
    candidateTree: string,
  ) {
    const remainingTasks = inspection.contract.tasks.filter(
      ({ completed, id }) => !completed && id !== inspection.session.taskId,
    );
    if (remainingTasks.length > 0) {
      return createTaskDiffDocumentationClosureRequirement({ required: false });
    }
    const completedTasks = inspection.contract.tasks.filter(
      ({ completed, id }) => completed && id !== inspection.session.taskId,
    );
    let changeBaseCommit = inspection.session.baseline.head;
    if (completedTasks.length > 0) {
      const firstTask = completedTasks[0]!;
      const commits = findCurrentExecutionTaskCommits(
        inspection.git.repositoryRoot,
        inspection.session.changeId,
        firstTask.id,
        inspection.session.baseline.head,
      );
      if (commits.length !== 1) {
        throw workflowError(
          'TASK_DIFF_DOCUMENTATION_BASE_INVALID',
          'Final documentation review requires one canonical first-task commit.',
          ExitCode.staleState,
          { details: { taskId: firstTask.id, commitCount: commits.length } },
        );
      }
      changeBaseCommit = runGit(inspection.git.repositoryRoot, [
        'rev-parse',
        `${commits[0]!.hash}^`,
      ]).trim();
    }
    const changeBaseTree = runGit(inspection.git.repositoryRoot, [
      'rev-parse',
      `${changeBaseCommit}^{tree}`,
    ]).trim();
    const ignoredPaths = new Set([
      `${inspection.contract.config.changeRoot}/${inspection.session.changeId}/tasks.md`,
      ...completionDocumentPaths(inspection.git.repositoryRoot),
    ]);
    const changedPaths = runGit(inspection.git.repositoryRoot, [
      'diff',
      '--name-only',
      '--no-renames',
      '-z',
      changeBaseTree,
      candidateTree,
      '--',
    ])
      .split('\0')
      .filter((candidate) => candidate !== '' && !ignoredPaths.has(candidate))
      .sort();
    if (changedPaths.length === 0) {
      throw workflowError(
        'TASK_DIFF_DOCUMENTATION_CHANGE_EMPTY',
        'Final documentation review requires at least one non-projection change path.',
        ExitCode.verification,
      );
    }
    const transitions = deriveTransitions(
      inspection.git.repositoryRoot,
      changeBaseTree,
      candidateTree,
      changedPaths,
    );
    return createTaskDiffDocumentationClosureRequirement({
      required: true,
      changeBaseCommit,
      changeBaseTree,
      candidateTree,
      changedPaths,
      patchDigest: sha256(
        canonicalJson({
          schemaVersion: 1,
          kind: 'task-diff-documentation-change-patch.v1',
          transitions,
        }),
      ),
      hints: documentationHints(changedPaths),
    });
  }

  function documentationHints(
    changedPaths: readonly string[],
  ): readonly TaskDiffDocumentationHint[] {
    const hints = new Map<TaskDiffDocumentationHint['reason'], Set<string>>();
    const add = (
      reason: TaskDiffDocumentationHint['reason'],
      paths: readonly string[],
    ) => {
      const existing = hints.get(reason) ?? new Set<string>();
      for (const candidate of paths) existing.add(candidate);
      hints.set(reason, existing);
    };
    for (const changedPath of changedPaths) {
      if (
        changedPath.startsWith('packages/workflow-engine/src/cli') ||
        changedPath ===
          'packages/workflow-engine/src/composition-root/lifecycle-context.ts' ||
        changedPath.startsWith(
          'packages/workflow-engine/src/application/finalize/lifecycle',
        ) ||
        changedPath.includes('workflow')
      ) {
        add('workflow-lifecycle-changed', ['docs/WORKFLOW.md']);
      }
      if (
        changedPath.includes('/controller') ||
        changedPath.includes('/dto/') ||
        changedPath.endsWith('package.json')
      ) {
        add('public-interface-changed', ['docs/features']);
      }
      if (
        changedPath.includes('config') ||
        changedPath.startsWith('workflow/schemas/')
      ) {
        add('configuration-changed', ['docs/WORKFLOW.md']);
      }
      if (changedPath.includes('migration')) {
        add('migration-changed', ['docs/architecture', 'docs/features']);
      }
      if (
        changedPath.startsWith('apps/mobile/') ||
        changedPath.startsWith('apps/api/')
      ) {
        add('user-visible-behavior-changed', ['docs/features']);
      }
      if (changedPath === 'docs/ROADMAP.md') {
        add('roadmap-state-changed', ['docs/ROADMAP.md']);
      }
      if (
        changedPath.includes('authority') ||
        changedPath.includes('grant') ||
        changedPath.includes('security')
      ) {
        add('authority-boundary-changed', [
          'docs/WORKFLOW.md',
          'docs/architecture',
        ]);
      }
    }
    return [...hints.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([reason, suggestedPaths]) => ({
        reason,
        suggestedPaths: [...suggestedPaths].sort(),
      }));
  }

  function resolveTaskDiffReviewContract(inspection: SessionInspection) {
    const executionTask =
      inspection.contract.execution?.tasks[inspection.session.taskId];
    if (executionTask === undefined) {
      throw workflowError(
        'TASK_DIFF_REVIEW_TASK_CONTRACT_REQUIRED',
        'TaskDiffReview requires an exact execution task contract.',
        ExitCode.staleState,
      );
    }
    const pathRoles = parseBaselineJson(
      inspection.git.repositoryRoot,
      inspection.session.baseline.head,
      'workflow/path-roles.json',
      parsePathRoleRegistry,
    );
    const pathRoleFacts = inspection.changedPaths.map((changedPath) => {
      const resolution = resolvePathRole(pathRoles, changedPath);
      return {
        path: changedPath,
        role: resolution.registered
          ? resolution.role
          : ('unregistered' as const),
      };
    });
    return {
      executionTask,
      requirement: taskDiffReviewRequirement({
        diffReview: executionTask.diffReview,
        strategy: executionTask.strategy,
        paths: pathRoleFacts,
      }),
    };
  }

  function taskDiffReviewIsActive(
    repositoryRoot: string,
    baselineHead: string,
  ): boolean {
    return [
      'workflow/maintainer-policy.json',
      'workflow/path-roles.json',
    ].every(
      (activationPath) =>
        runGit(repositoryRoot, [
          'ls-tree',
          '--name-only',
          baselineHead,
          '--',
          activationPath,
        ]).trim() === activationPath,
    );
  }

  function recordImplementationActor(
    sessionId: string,
    actor: Readonly<{
      providerId: ProviderId;
      assurance: 'self-declared' | 'runtime-hint' | 'adapter-assigned';
    }>,
  ): RecordedRoleParticipant {
    return Object.freeze({
      providerId: actor.providerId,
      sessionId,
      principalId: `provider:${actor.providerId}`,
      identityAssurance: actor.assurance,
      engineSpawned: false,
    });
  }

  function resolveTaskDiffImplementationActor(
    cwd: string,
    requestedSessionId: string,
    subject: TaskDiffReviewSubject,
    options: BeginTaskDiffReviewOptions,
  ): RecordedRoleParticipant {
    const context = loadActiveSessionContext(cwd, requestedSessionId);
    const runtime = loadInvestigationRuntimeContext(cwd).runtime;
    const transaction = readTaskStrategyTransaction(
      runtime,
      context.session.sessionId,
    );
    const finalizeTransaction = readFinalizeTransaction(
      context.runtime.root,
      context.session.sessionId,
    );
    if (
      finalizeTransaction === null ||
      finalizeTransaction.candidateTree !== subject.candidateTree
    ) {
      throw reviewNotSatisfied();
    }
    if (transaction !== null) {
      const inspection = inspectSession(cwd, context.session.sessionId, {
        expectedSession: context.session,
        projectedTaskIds: [...finalizeTransaction.completedTaskIds],
        projectionSourceDigest: finalizeTransaction.projectionSourceDigest,
        authorizedTransitionPaths: [...finalizeTransaction.transitionPaths],
      });
      const correction = resolveCurrentTaskStrategyCorrection(inspection);
      const initialImplementationSubject =
        createTaskStrategyImplementationSubject({
          sessionId: transaction.sessionId,
          changeId: transaction.changeId,
          taskId: transaction.taskId,
          strategy: transaction.strategy,
          transactionDigest: transaction.recordDigest,
          taskContractDigest: transaction.taskContractDigest,
          sourceTree: transaction.red.candidateTree,
          failureFingerprint: transaction.red.failureFingerprint,
          redEvidenceNodeId: transaction.red.evidenceNodeId,
          redEvidenceResultDigest: transaction.red.evidenceResultDigest,
          testPaths: transaction.red.testPaths,
          fixturePaths: transaction.red.fixturePaths,
          frozenFiles: transaction.red.files,
        });
      const head = correction.head;
      const current = head?.binding ?? null;
      const record = head?.record ?? null;
      const receipt = head?.receipt ?? null;
      if (
        correction.transaction.recordDigest !== transaction.recordDigest ||
        correction.failure !== null ||
        correction.exhausted ||
        current === null ||
        record === null ||
        receipt === null ||
        transaction.sessionId !== context.session.sessionId ||
        transaction.changeId !== context.session.changeId ||
        transaction.taskId !== context.session.taskId ||
        record.sessionId !== context.session.sessionId ||
        record.changeId !== context.session.changeId ||
        record.taskId !== context.session.taskId ||
        record.strategy !== transaction.strategy ||
        record.taskContractDigest !== transaction.taskContractDigest ||
        record.candidateTree === record.sourceTree ||
        current.sessionId !== context.session.sessionId ||
        current.patchDigest !== record.patchDigest ||
        record.candidateTree !== current.candidateTree ||
        record.recordDigest !== current.recordDigest ||
        receipt.sessionId !== context.session.sessionId ||
        receipt.recordDigest !== record.recordDigest ||
        receipt.patchDigest !== record.patchDigest ||
        receipt.candidateTree !== record.candidateTree ||
        receipt.receiptDigest !== current.receiptDigest ||
        receipt.importedAt !== current.createdAt ||
        finalizeTransaction.candidateTree !== subject.candidateTree ||
        !taskDiffSubjectExtendsPatchTree(
          context.git.repositoryRoot,
          record.candidateTree,
          subject.candidateTree,
          finalizeTransaction.projectionMutations.map(({ path }) => path),
        )
      ) {
        throw reviewNotSatisfied();
      }
      let implementationSubject = initialImplementationSubject;
      if (correction.completedCorrectionRounds === 0) {
        if (record.sourceTree !== transaction.red.candidateTree) {
          throw reviewNotSatisfied();
        }
      } else {
        const originatingFailure = readTaskStrategyGreenFailureRecord(
          runtime,
          context.session.sessionId,
          record.sourceTree,
        );
        if (
          originatingFailure === null ||
          originatingFailure.candidateTree !== record.sourceTree ||
          originatingFailure.currentRedTransactionDigest !==
            transaction.recordDigest
        ) {
          throw reviewNotSatisfied();
        }
        implementationSubject = createTaskStrategyCorrectionSubject({
          subject: initialImplementationSubject,
          round: correction.completedCorrectionRounds,
          greenFailureRecord: originatingFailure,
        });
        if (implementationSubject.sourceTree !== record.sourceTree) {
          throw reviewNotSatisfied();
        }
      }
      if (transaction.strategy === 'tdd-single-agent') {
        if (
          canonicalJson(record.implementer) !==
          canonicalJson(transaction.author)
        ) {
          throw reviewNotSatisfied();
        }
        return recordImplementationActor(
          context.session.sessionId,
          transaction.author,
        );
      }
      if (record.implementer.providerId === null) {
        const caller = readTaskStrategyCallerImplementationBinding(
          runtime,
          context.session.sessionId,
          implementationSubject.subjectDigest,
        );
        if (
          caller === null ||
          caller.subjectDigest !== implementationSubject.subjectDigest ||
          caller.output.sessionId !== context.session.sessionId ||
          caller.output.patchDigest !== record.patchDigest ||
          caller.output.sourceTree !== record.sourceTree ||
          caller.roleResult.targetDigest !==
            implementationSubject.subjectDigest ||
          caller.roleResult.participant.providerId !== null ||
          caller.roleResult.participant.principalId !==
            record.implementer.principalId ||
          caller.roleResult.participant.identityAssurance !==
            record.implementer.assurance
        ) {
          throw reviewNotSatisfied();
        }
        return Object.freeze(structuredClone(caller.roleResult.participant));
      }
      const provider = readTaskStrategyImplementationResultBinding(
        runtime,
        context.session.sessionId,
        implementationSubject.subjectDigest,
      );
      if (provider !== null) {
        if (
          provider.subjectDigest !== implementationSubject.subjectDigest ||
          provider.output.sessionId !== context.session.sessionId ||
          provider.output.patchDigest !== record.patchDigest ||
          provider.output.sourceTree !== record.sourceTree ||
          provider.roleResult.targetDigest !==
            implementationSubject.subjectDigest ||
          provider.roleResult.participant.providerId !==
            record.implementer.providerId ||
          provider.roleResult.participant.identityAssurance !==
            record.implementer.assurance
        ) {
          throw reviewNotSatisfied();
        }
        return Object.freeze(structuredClone(provider.roleResult.participant));
      }
      throw reviewNotSatisfied();
    }

    const task = inspectSession(cwd, context.session.sessionId, {
      expectedSession: context.session,
      projectedTaskIds: [...finalizeTransaction.completedTaskIds],
      projectionSourceDigest: finalizeTransaction.projectionSourceDigest,
      authorizedTransitionPaths: [...finalizeTransaction.transitionPaths],
    }).contract.execution?.tasks[context.session.taskId];
    if (
      task?.strategy === 'cross-agent-tdd' ||
      task?.strategy === 'tdd-single-agent'
    ) {
      throw reviewNotSatisfied();
    }

    const actorResolution = resolveActorIdentity({
      ...(options.explicitActor === undefined
        ? {}
        : { explicitActor: options.explicitActor }),
      environment: options.environment ?? process.env,
    });
    if (actorResolution.outcome === 'actor-resolution-required') {
      throw workflowError(
        actorResolution.code,
        'TaskDiffReview requires an unambiguous implementation actor.',
        ExitCode.guard,
        { details: { signals: actorResolution.signals } },
      );
    }
    return recordImplementationActor(
      context.session.sessionId,
      actorResolution.actor,
    );
  }

  function taskDiffSubjectExtendsPatchTree(
    repositoryRoot: string,
    patchTree: string,
    subjectTree: string,
    transitionPaths: readonly string[],
  ): boolean {
    const changedPaths = runGit(repositoryRoot, [
      'diff',
      '--name-only',
      '--no-renames',
      '-z',
      patchTree,
      subjectTree,
      '--',
    ])
      .split('\0')
      .filter(Boolean)
      .sort();
    return (
      canonicalJson(changedPaths) === canonicalJson([...transitionPaths].sort())
    );
  }

  function assertCandidateIndex(
    inspection: ReturnType<typeof inspectSession>,
    transaction: NonNullable<ReturnType<typeof readFinalizeTransaction>> & {
      candidateTree: string;
      candidateFingerprint: string;
      checkReportId: string;
    },
  ): void {
    const indexTree = runGit(inspection.git.repositoryRoot, [
      'write-tree',
    ]).trim();
    if (indexTree === transaction.previousIndexTree) {
      const preview = previewExactStaging(
        inspection.git.repositoryRoot,
        inspection.session.baseline.head,
        [...transaction.changedPaths],
      );
      if (
        preview.tree !== transaction.candidateTree ||
        preview.previousIndexTree !== transaction.previousIndexTree
      ) {
        throw candidateDiverged();
      }
      return;
    }
    if (
      indexTree !== transaction.candidateTree ||
      canonicalJson(
        listStagedPaths(
          inspection.git.repositoryRoot,
          inspection.session.baseline.head,
        ),
      ) !== canonicalJson(transaction.changedPaths) ||
      runGit(inspection.git.repositoryRoot, [
        'diff',
        '--name-only',
        '-z',
        '--',
      ]) !== '' ||
      fingerprintUnstagedRepositoryProjection(
        inspection.git.repositoryRoot,
        inspection.session.baseline.head,
        [...transaction.candidateStatusEntries],
      ) !== transaction.candidateFingerprint
    ) {
      throw candidateDiverged();
    }
  }

  function deriveTransitions(
    repositoryRoot: string,
    baseTree: string,
    candidateTree: string,
    changedPaths: readonly string[],
  ): readonly TaskDiffPathTransition[] {
    return changedPaths.map((changedPath) => {
      const before = readTreeEntry(repositoryRoot, baseTree, changedPath);
      const after = readTreeEntry(repositoryRoot, candidateTree, changedPath);
      if (
        (before === null && after === null) ||
        canonicalJson(before) === canonicalJson(after)
      ) {
        throw candidateDiverged();
      }
      return { path: changedPath, before, after };
    });
  }

  function readTreeEntry(
    repositoryRoot: string,
    tree: string,
    candidatePath: string,
  ): TaskDiffTreeEntry | null {
    const output = runGit(repositoryRoot, [
      'ls-tree',
      '-z',
      tree,
      '--',
      `:(literal)${candidatePath}`,
    ]);
    if (output === '') return null;
    const match =
      /^(100644|100755|120000|160000) (?:blob|commit) ([0-9a-f]{40}|[0-9a-f]{64})\t([^\0]+)\0$/.exec(
        output,
      );
    if (!match || match[3] !== candidatePath) throw candidateDiverged();
    return {
      mode: match[1] as TaskDiffTreeEntry['mode'],
      objectId: match[2]!,
    };
  }
  return {
    assertTaskDiffReviewCandidateCurrent,
    bindDocumentationRemediation,
    inspectTaskDiffReviewSubject,
    taskDiffReviewRequirementIncludingDocumentation,
    taskDiffDocumentationRequirement,
    resolveTaskDiffReviewContract,
    taskDiffReviewIsActive,
    resolveTaskDiffImplementationActor,
  };
}

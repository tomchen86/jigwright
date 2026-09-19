/** Immutable commit replay operations; caller-owned semantic services are required. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalRoleContextSharingGrantEnvelopeV1 } from '../../grants/optional-grants-package.ts';
import { canonicalJson } from '../../../foundation/canonical-json/canonical-json.ts';
import { assertCollaborationGrantId } from '../../../modules/authority/collaboration-grant-codec.ts';
import { readFileAtCommit } from '../../repository-transaction/git-command.ts';
import { isRecord } from '../../../foundation/canonical-json/contract-values.ts';
import type { AmendPlanManagedTrailers } from '@jigwright/core/managed-transition-trailers';
import { loadWorkflowConfig } from '../../repository-observation/workflow-configuration.ts';
import { repositoryCurrentSchemaName } from '../../repository-observation/workflow-configuration.ts';
import { parseTasks } from '../../../modules/planning-provider/planning-artifact-parsers.ts';
import { readManagedSchemaName } from '../../repository-observation/change-metadata.ts';
import type { ChangeContract } from '../../../modules/planning-provider/change-contract.ts';
import type { ManagedSchemaName } from '../../../modules/planning-provider/change-contract.ts';
import type { ParsedTask } from '../../../modules/planning-provider/planning-artifact-types.ts';
import { createTrustedExecutionEnvironment } from '../../process-environment/execution-environment.ts';
import { isEngineProjectionPathForTransition } from '../../../modules/projection/engine-projection-registry.ts';
import { commitChangedPaths } from '../../repository-transaction/git-transitions.ts';
import { commitFacts } from '../../repository-transaction/git-transitions.ts';
import { planningCommitMessage } from '../../repository-transaction/git-transitions.ts';
import { runGit } from '../../repository-transaction/git.ts';
import type { InvestigationFirstPlanningAssuranceSummary } from '../../../modules/assurance/planning-assurance-validator.ts';
import { committedPlanningGeneration } from '../../repository-transaction/planning-generation-history.ts';
import { readPlanningAmendmentDecision } from '../../../modules/lifecycle/planning-amendment-decision.ts';
import { agentRolePlanV2Path } from '../../../modules/source/planning-role-policy-paths.ts';
import { amendmentLeftWorkMarkedDone } from '../../../modules/planning-provider/planning-task-history.ts';
import { assertPlanningTaskHistory } from '../../../modules/planning-provider/planning-task-history.ts';
import { partitionPlanningRolePolicyPaths } from '../../../modules/source/planning-role-policy-paths.ts';
import { taskStates } from '../../../modules/planning-provider/planning-task-history.ts';
import { assertPlanningPaths } from '../../../modules/source/planning-paths.ts';
import { planningProviderBindingPath } from '../../../modules/source/planning-paths.ts';
import type { ResolvedPlanningProviderBinding } from '@jigwright/core/planning-provider-binding';
import { normalizeChangedPath } from '../../../foundation/repository-path/repository-path.ts';
import type { CiPlanningCommitValidation } from '../../../modules/assurance/commit-replay/ci-planning.ts';
import type { CiCollaborationGrantUse } from '../../../modules/assurance/commit-replay/ci-planning.ts';
import { malformedHistoricalGrantClaim } from '../../../modules/assurance/commit-replay/ci-planning.ts';
import type { TreeEntry } from '../../../modules/assurance/commit-replay/ci-planning.ts';
import { readCommittedAmendment } from '../../../modules/assurance/commit-replay/ci-planning.ts';
import type { PlanningTreeReplay } from '../../../modules/assurance/commit-replay/ci-planning.ts';
import { assertCompletePlanningTree } from '../../../modules/assurance/commit-replay/ci-planning.ts';
import { assertChangeId } from '../../../modules/assurance/commit-replay/ci-planning.ts';
import { ciPlanningError } from '../../../modules/assurance/commit-replay/ci-planning.ts';

import type { CiPlanningReplayServices } from './services.ts';
import type { CiPlanningReplayOperations } from '../../../modules/assurance/commit-replay/ci-planning.ts';
export function createCiPlanningReplay(
  services: CiPlanningReplayServices,
): CiPlanningReplayOperations {
  const {
    planningPaths: planningPathPolicy,
    validateHandoffForChange,
    productionPlanningAssurance,
    parsePlanReviewArtifact,
    validateForAuthority,
    createArchiveApplicabilityProjection,
    loadCommittedPlanningDocumentProjection,
    resolveHistoricalOpenSpecPlanningTransitionBinding,
    resolveHistoricalOpenSpecProviderBinding,
    productionConsumedPlanReviewReplayPort,
  } = services;
  function resolveHistoricalPlanningProviderForCi(
    repositoryRoot: string,
    commit: string,
    changeRoot: string,
    changeId: string,
  ) {
    return resolveHistoricalOpenSpecProviderBinding(
      repositoryRoot,
      commit,
      changeRoot,
      changeId,
    );
  }

  function collectHistoricalCollaborationGrantUses(
    repositoryRoot: string,
    head: string,
    changeId: string,
    changeRoot = 'openspec/changes',
  ): readonly CiCollaborationGrantUse[] {
    assertChangeId(changeId);
    const normalizedChangeRoot = normalizeChangedPath(changeRoot);
    if (normalizedChangeRoot !== changeRoot || changeRoot.endsWith('/')) {
      throw ciPlanningError(
        'CI_PLANNING_ROOT_INVALID',
        'CI planning validation requires one canonical change root.',
      );
    }
    const artifactPaths = [
      `${normalizedChangeRoot}/${changeId}/investigation.json`,
      `${normalizedChangeRoot}/${changeId}/plan-review.json`,
    ] as const;
    const commits = runGit(repositoryRoot, [
      'rev-list',
      '--full-history',
      '--reverse',
      head,
      '--',
      ...artifactPaths.map((artifactPath) => `:(literal)${artifactPath}`),
    ])
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    const expectedMessage = `${planningCommitMessage(changeId)}\n`;
    return commits.flatMap((commit) => {
      const facts = commitFacts(repositoryRoot, commit);
      if (facts.parents.length !== 1 || facts.message !== expectedMessage) {
        return [];
      }
      return artifactPaths.flatMap((artifactPath) => {
        const raw = readFileAtCommit(repositoryRoot, commit, artifactPath);
        if (raw === undefined) {
          return [];
        }
        return grantUsesFromPlanningArtifact(
          repositoryRoot,
          raw,
          changeId,
          artifactPath.endsWith('/investigation.json')
            ? 'investigation'
            : 'plan-review',
        );
      });
    });
  }

  function grantUsesFromPlanningArtifact(
    repositoryRoot: string,
    raw: string,
    changeId: string,
    artifactKind: 'investigation' | 'plan-review',
  ): CiCollaborationGrantUse[] {
    let roleResults: unknown[] | undefined;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (raw !== `${canonicalJson(parsed)}\n`) {
        throw new Error('noncanonical artifact');
      }
      roleResults =
        artifactKind === 'investigation'
          ? investigationRoleResultsFromPlanningArtifact(
              repositoryRoot,
              parsed,
              changeId,
            )
          : parsePlanReviewArtifact(parsed, changeId).roleResults;
    } catch {
      throw ciPlanningError(
        'CI_PLANNING_GRANT_HISTORY_INVALID',
        'Historical planning grant claims are malformed.',
      );
    }
    return grantUsesFromRoleResults(roleResults ?? []);
  }

  function investigationRoleResultsFromPlanningArtifact(
    repositoryRoot: string,
    parsed: unknown,
    changeId: string,
  ): unknown[] | undefined {
    if (!isRecord(parsed) || parsed.schemaVersion !== 3) {
      throw ciPlanningError(
        'CI_PLANNING_GRANT_HISTORY_INVALID',
        'Historical planning grant claims require a current v3 investigation Manifest.',
      );
    }
    const authoring = isRecord(parsed.authoring) ? parsed.authoring : undefined;
    const validation = validateForAuthority({
      repositoryRoot,
      manifest: parsed,
      expected: {
        repositoryId:
          typeof parsed.repositoryId === 'string' ? parsed.repositoryId : '',
        changeId,
        investigationId:
          typeof parsed.investigationId === 'string'
            ? parsed.investigationId
            : '',
        sessionRevision:
          authoring && typeof authoring.sessionRevision === 'number'
            ? authoring.sessionRevision
            : -1,
        sessionSnapshotDigest:
          authoring && typeof authoring.sessionSnapshotDigest === 'string'
            ? authoring.sessionSnapshotDigest
            : '',
      },
    });
    if (validation.outcome !== 'verified') {
      throw new Error(validation.blocker.failureCode);
    }
    return validation.manifest.applicability.kind === 'ordinary'
      ? validation.manifest.applicability.semanticDelta.investigationRoleResults
      : [];
  }

  function grantUsesFromRoleResults(
    roleResults: readonly unknown[],
  ): CiCollaborationGrantUse[] {
    return roleResults.flatMap((roleResult) => {
      if (!isRecord(roleResult)) {
        throw ciPlanningError(
          'CI_PLANNING_GRANT_HISTORY_INVALID',
          'Historical planning grant claims are malformed.',
        );
      }
      if (roleResult.grantUse !== null && roleResult.grantUse !== undefined) {
        const use = roleResult.grantUse;
        if (
          !isRecord(use) ||
          (Object.hasOwn(use, 'kind') &&
            use.kind !== 'collaboration-grant-use-identity.v1') ||
          typeof use.grantId !== 'string' ||
          typeof use.signedEnvelopeDigest !== 'string' ||
          typeof use.transitionDigest !== 'string' ||
          !/^[0-9a-f]{64}$/.test(use.signedEnvelopeDigest) ||
          !/^[0-9a-f]{64}$/.test(use.transitionDigest)
        ) {
          throw malformedHistoricalGrantClaim();
        }
        return [
          {
            grantId: assertCollaborationGrantId(use.grantId),
            signedEnvelopeDigest: use.signedEnvelopeDigest,
            transitionDigest: use.transitionDigest,
          },
        ];
      }
      const terminalUse = roleResult.roleContextSharingUse;
      if (terminalUse === null || terminalUse === undefined) return [];
      if (
        isRecord(terminalUse) &&
        terminalUse.kind === 'role-context-sharing-use-identity.v1'
      ) {
        if (
          typeof terminalUse.grantId !== 'string' ||
          typeof terminalUse.signedEnvelopeDigest !== 'string' ||
          typeof terminalUse.transitionDigest !== 'string' ||
          typeof terminalUse.useProjectionDigest !== 'string' ||
          typeof terminalUse.admissionDigest !== 'string' ||
          !/^[0-9a-f]{64}$/.test(terminalUse.signedEnvelopeDigest) ||
          !/^[0-9a-f]{64}$/.test(terminalUse.transitionDigest) ||
          !/^[0-9a-f]{64}$/.test(terminalUse.useProjectionDigest) ||
          !/^[0-9a-f]{64}$/.test(terminalUse.admissionDigest)
        ) {
          throw malformedHistoricalGrantClaim();
        }
        return [
          {
            grantId: assertCollaborationGrantId(terminalUse.grantId),
            signedEnvelopeDigest: terminalUse.signedEnvelopeDigest,
            transitionDigest: terminalUse.transitionDigest,
            useProjectionDigest: terminalUse.useProjectionDigest,
            admissionDigest: terminalUse.admissionDigest,
          },
        ];
      }
      if (
        !isRecord(terminalUse) ||
        terminalUse.kind !== 'role-context-sharing-consumed-use.v1' ||
        typeof terminalUse.grantId !== 'string' ||
        !isRecord(terminalUse.envelope) ||
        !isRecord(terminalUse.expectedBinding) ||
        typeof terminalUse.expectedBinding.targetDigest !== 'string' ||
        !/^[0-9a-f]{64}$/.test(terminalUse.expectedBinding.targetDigest) ||
        typeof terminalUse.useProjectionDigest !== 'string' ||
        !/^[0-9a-f]{64}$/.test(terminalUse.useProjectionDigest) ||
        !isRecord(terminalUse.use) ||
        typeof terminalUse.use.admissionDigest !== 'string' ||
        !/^[0-9a-f]{64}$/.test(terminalUse.use.admissionDigest)
      ) {
        throw malformedHistoricalGrantClaim();
      }
      let signedEnvelopeDigest: string;
      try {
        signedEnvelopeDigest = crypto
          .createHash('sha256')
          .update(
            canonicalRoleContextSharingGrantEnvelopeV1(
              terminalUse.envelope as never,
            ),
          )
          .digest('hex');
      } catch {
        throw malformedHistoricalGrantClaim();
      }
      const useProjectionDigest = crypto
        .createHash('sha256')
        .update(canonicalJson(terminalUse.use))
        .digest('hex');
      if (useProjectionDigest !== terminalUse.useProjectionDigest) {
        throw malformedHistoricalGrantClaim();
      }
      return [
        {
          grantId: assertCollaborationGrantId(terminalUse.grantId),
          signedEnvelopeDigest,
          transitionDigest: terminalUse.expectedBinding.targetDigest,
          useProjectionDigest,
          admissionDigest: terminalUse.use.admissionDigest,
        },
      ];
    });
  }

  function validateCiPlanningCommit(
    repositoryRoot: string,
    commitHash: string,
    changeId: string,
    changeRoot = 'openspec/changes',
  ): CiPlanningCommitValidation {
    assertChangeId(changeId);
    const normalizedChangeRoot = normalizeChangedPath(changeRoot);
    if (normalizedChangeRoot !== changeRoot || changeRoot.endsWith('/')) {
      throw ciPlanningError(
        'CI_PLANNING_ROOT_INVALID',
        'CI planning validation requires one canonical change root.',
      );
    }

    const facts = commitFacts(repositoryRoot, commitHash);
    if (facts.parents.length !== 1) {
      throw ciPlanningError(
        'CI_PLANNING_NON_LINEAR',
        'Planning commits must have exactly one parent.',
      );
    }
    // An amendment carries its own exact block, and the authorization to reopen
    // completed work is read from that block rather than from anything outside
    // the commit — replay sees precisely what the transition claimed.
    const amendment = readCommittedAmendment(facts.message, changeId);
    if (
      amendment === null &&
      facts.message !== `${planningCommitMessage(changeId)}\n`
    ) {
      throw ciPlanningError(
        'CI_PLANNING_MESSAGE_INVALID',
        'Planning commits require the exact managed subject and trailer block.',
      );
    }
    const reopenAuthorized = amendment?.executionImpact === 'required';

    const changedPaths = commitChangedPaths(repositoryRoot, facts.hash);
    if (changedPaths.length === 0) {
      throw ciPlanningError(
        'CI_PLANNING_DIFF_EMPTY',
        'Planning commits require a non-empty planning diff.',
      );
    }

    const engineProjectionPaths = changedPaths.filter((changedPath) =>
      isEngineProjectionPathForTransition(changedPath, 'plan'),
    );
    const planningPaths = changedPaths.filter(
      (changedPath) =>
        !isEngineProjectionPathForTransition(changedPath, 'plan'),
    );
    const prefix = `${normalizedChangeRoot}/${changeId}`;
    const beforeEntries = listTreeEntries(
      repositoryRoot,
      facts.parents[0],
      prefix,
    );
    const afterEntries = listTreeEntries(repositoryRoot, facts.hash, prefix);
    const kind: CiPlanningCommitValidation['kind'] =
      beforeEntries.length === 0 ? 'introduction' : 'revision';
    const afterPaths = new Set(afterEntries.map(({ path }) => path));
    const deletedPaths = beforeEntries
      .map(({ path }) => path)
      .filter(
        (beforePath) =>
          !afterPaths.has(beforePath) && planningPaths.includes(beforePath),
      );
    const rolePolicyPath = agentRolePlanV2Path(changeId);
    if (
      planningPaths.includes(rolePolicyPath) &&
      readFileAtCommit(repositoryRoot, facts.hash, rolePolicyPath) === undefined
    ) {
      deletedPaths.push(rolePolicyPath);
      deletedPaths.sort();
    }
    const rolePolicyPaths = partitionPlanningRolePolicyPaths(
      changeId,
      planningPaths,
      deletedPaths,
    );
    // The governing schema is a fact of the immutable commit, not of the
    // checkout CI happens to run in, so it is resolved from the replayed tree
    // before any schema-sensitive path or artifact rule is applied.
    const replay = replayPlanningTree(
      repositoryRoot,
      facts.hash,
      changeId,
      engineProjectionPaths,
    );
    assertPlanningAssuranceBaseline(repositoryRoot, facts.parents[0]!, replay);
    if (amendment !== null) {
      assertCommittedAmendmentProvenance(
        repositoryRoot,
        normalizedChangeRoot,
        facts.parents[0],
        facts.hash,
        amendment,
        replay.planningAssurance,
      );
    }
    assertPlanningPaths(
      planningPathPolicy.admit,
      normalizedChangeRoot,
      changeId,
      [...rolePolicyPaths.providerChangedPaths],
      rolePolicyPaths.providerDeletedPaths,
      replay.schemaName,
      replay.currentSchemaName,
    );
    const rolePolicyPresent =
      readFileAtCommit(
        repositoryRoot,
        facts.hash,
        rolePolicyPaths.policyPath,
      ) !== undefined;
    if (
      kind === 'introduction' &&
      rolePolicyPresent &&
      !rolePolicyPaths.policyChanged
    ) {
      throw ciPlanningError(
        'CI_PLANNING_ROLE_POLICY_INVALID',
        'Agent-role planning policy is outside its exact investigation-first transition.',
      );
    }
    assertCompletePlanningTree(
      planningPathPolicy,
      normalizedChangeRoot,
      changeId,
      afterEntries,
      [],
      replay.schemaName,
      replay.currentSchemaName,
    );

    let beforeTasks: ParsedTask[] | undefined;
    let planningProvider: ResolvedPlanningProviderBinding;
    if (beforeEntries.length === 0) {
      planningProvider = resolveHistoricalOpenSpecPlanningTransitionBinding(
        repositoryRoot,
        facts.parents[0],
        facts.hash,
        normalizedChangeRoot,
        changeId,
        kind,
      );
      const expectedIntroductionPaths = [
        ...afterEntries.map(({ path: artifactPath }) => artifactPath),
        planningProviderBindingPath(changeId),
        ...(rolePolicyPaths.policyChanged ? [rolePolicyPaths.policyPath] : []),
      ].sort();
      if (
        JSON.stringify(planningPaths) !==
        JSON.stringify(expectedIntroductionPaths)
      ) {
        throw ciPlanningError(
          'CI_PLANNING_INTRODUCTION_INVALID',
          'A planning introduction must add exactly one complete planning tree.',
        );
      }
    } else {
      const parentSchema = replayPlanningSchema(
        repositoryRoot,
        facts.parents[0],
        changeId,
      );
      assertCompletePlanningTree(
        planningPathPolicy,
        normalizedChangeRoot,
        changeId,
        beforeEntries,
        deletedPaths,
        parentSchema.schemaName,
        parentSchema.currentSchemaName,
      );
      planningProvider = resolveHistoricalOpenSpecPlanningTransitionBinding(
        repositoryRoot,
        facts.parents[0],
        facts.hash,
        normalizedChangeRoot,
        changeId,
        kind,
      );
      beforeTasks = parseTasks(
        readRequiredFile(
          repositoryRoot,
          facts.parents[0],
          `${prefix}/tasks.md`,
        ),
      );
    }

    const afterTasks = parseTasks(
      readRequiredFile(repositoryRoot, facts.hash, `${prefix}/tasks.md`),
    );
    const reopenedTasks = assertPlanningTaskHistory(beforeTasks, afterTasks, {
      reopenAuthorized,
    });
    if (
      amendmentLeftWorkMarkedDone({
        reopenAuthorized,
        reopenedTasks,
        beforeTasks,
      })
    ) {
      throw ciPlanningError(
        'CI_PLANNING_AMENDMENT_NOT_REOPENED',
        'An amendment that says the work must be redone has to reopen it; completed tasks are still marked done.',
      );
    }
    createArchiveApplicabilityProjection({
      repositoryRoot,
      changeRoot: normalizedChangeRoot,
      changeId,
      baselineCommit: facts.parents[0],
      sourceCommit: facts.hash,
      activeArtifactPaths: afterEntries.map(
        ({ path: artifactPath }) => artifactPath,
      ),
      planningProvider,
      source: 'commit',
    });
    return {
      changeId,
      kind,
      beforeTasks: beforeTasks ? taskStates(beforeTasks) : undefined,
      afterTasks: taskStates(afterTasks),
      changedPaths,
      schemaName: replay.schemaName,
      planningAssurance: replay.planningAssurance,
      collaborationGrantUses: replay.collaborationGrantUses,
    };
  }

  function assertCommittedAmendmentProvenance(
    repositoryRoot: string,
    changeRoot: string,
    parentCommit: string,
    amendmentCommit: string,
    amendment: AmendPlanManagedTrailers,
    planningAssurance: InvestigationFirstPlanningAssuranceSummary,
  ): void {
    let priorGeneration: string | null;
    try {
      priorGeneration = committedPlanningGeneration(
        repositoryRoot,
        parentCommit,
        changeRoot,
        amendment.changeId,
      );
    } catch {
      throw ciPlanningError(
        'CI_PLANNING_AMENDMENT_PROVENANCE_INVALID',
        'An amendment parent does not name exactly one planning generation.',
      );
    }
    let reviewedDecision: ReturnType<typeof readPlanningAmendmentDecision>;
    try {
      const proposal = readFileAtCommit(
        repositoryRoot,
        amendmentCommit,
        `${changeRoot}/${amendment.changeId}/proposal.md`,
      );
      reviewedDecision =
        proposal === undefined ? null : readPlanningAmendmentDecision(proposal);
    } catch {
      reviewedDecision = null;
    }
    if (
      priorGeneration === null ||
      reviewedDecision === null ||
      reviewedDecision.executionImpact !== amendment.executionImpact ||
      reviewedDecision.amendsPlanningGeneration !== priorGeneration ||
      amendment.planningGeneration !== planningAssurance.planningGenerationId ||
      amendment.planReview !== planningAssurance.reviewNodeId ||
      amendment.amendsPlanningGeneration !== priorGeneration
    ) {
      throw ciPlanningError(
        'CI_PLANNING_AMENDMENT_PROVENANCE_INVALID',
        'Amendment trailers and the reviewed decision must bind the exact impact, generation, review node, and generation replaced by the parent tree.',
      );
    }
  }

  function replayPlanningTree(
    repositoryRoot: string,
    commit: string,
    changeId: string,
    engineProjectionPaths: readonly string[],
  ): PlanningTreeReplay {
    return withPlanningWorktree(repositoryRoot, commit, (worktree) => {
      const currentSchemaName = repositoryCurrentSchemaName(worktree);
      const schemaName = resolveReplayedSchemaName(
        worktree,
        changeId,
        currentSchemaName,
      );
      if (engineProjectionPaths.includes('docs/CURRENT_AND_NEXT_STEPS.md')) {
        validateHandoffForChange(worktree, changeId);
      }
      const { contract, semanticLedgerMutations } =
        loadCommittedPlanningDocumentProjection(
          worktree,
          commit,
          changeId,
          schemaName,
        );
      if (semanticLedgerMutations.length > 0) {
        throw ciPlanningError(
          'CI_PLANNING_SEMANTIC_LEDGER_DRIFT',
          'Planning semantic bindings differ from the exact baseline source projection.',
        );
      }
      const readiness = productionPlanningAssurance.validateReadiness(
        worktree,
        contract,
        productionConsumedPlanReviewReplayPort,
      );
      const manifest = contract.investigation!.manifest;
      const manifestBaseline =
        manifest.applicability.kind === 'exemption'
          ? manifest.applicability.baseline
          : manifest.applicability.replayContract.baseline;
      return {
        schemaName,
        currentSchemaName,
        manifestBaseline,
        planningAssurance: readiness.summary,
        collaborationGrantUses: collectCurrentCollaborationGrantUses(contract),
      };
    });
  }

  function assertPlanningAssuranceBaseline(
    repositoryRoot: string,
    parentCommit: string,
    replay: PlanningTreeReplay,
  ): void {
    const assuranceBaseline = replay.planningAssurance.investigationBaseline;
    const manifestBaseline = replay.manifestBaseline;
    const parent = commitFacts(repositoryRoot, parentCommit);
    if (
      assuranceBaseline.head !== parent.hash ||
      assuranceBaseline.tree !== parent.tree ||
      manifestBaseline.commitOid !== parent.hash ||
      manifestBaseline.treeOid !== parent.tree
    ) {
      throw ciPlanningError(
        'CI_PLANNING_BASELINE_MISMATCH',
        'Committed Investigation Manifest and planning assurance must bind the exact plan-commit parent commit and tree.',
        {
          expectedParentCommit: parent.hash,
          expectedParentTree: parent.tree,
          observedManifestBaseline: manifestBaseline,
          observedPlanningAssuranceBaseline: assuranceBaseline,
        },
      );
    }
  }

  function replayPlanningSchema(
    repositoryRoot: string,
    commit: string,
    changeId: string,
  ): Pick<PlanningTreeReplay, 'schemaName' | 'currentSchemaName'> {
    return withPlanningWorktree(repositoryRoot, commit, (worktree) => {
      const currentSchemaName = repositoryCurrentSchemaName(worktree);
      return {
        schemaName: resolveReplayedSchemaName(
          worktree,
          changeId,
          currentSchemaName,
        ),
        currentSchemaName,
      };
    });
  }

  function resolveReplayedSchemaName(
    worktree: string,
    changeId: string,
    currentSchemaName: ManagedSchemaName,
  ): ManagedSchemaName {
    const changeRoot = loadWorkflowConfig(worktree).changeRoot;
    const schemaName = readManagedSchemaName(
      worktree,
      path.join(worktree, changeRoot, changeId, '.openspec.yaml'),
    );
    if (schemaName !== currentSchemaName) {
      throw ciPlanningError(
        'OPENSPEC_MANAGED_SCHEMA_REQUIRED',
        'Managed changes must declare the repository-configured current schema.',
      );
    }
    return schemaName;
  }

  function collectCurrentCollaborationGrantUses(
    contract: Pick<ChangeContract, 'investigation' | 'planReview'>,
  ): readonly CiCollaborationGrantUse[] {
    const investigationRoleResults =
      contract.investigation?.manifest.applicability.kind === 'ordinary'
        ? contract.investigation.manifest.applicability.semanticDelta
            .investigationRoleResults
        : [];
    return Object.freeze([
      ...grantUsesFromRoleResults(investigationRoleResults),
      ...grantUsesFromRoleResults(contract.planReview?.roleResults ?? []),
    ]);
  }

  function withPlanningWorktree<T>(
    repositoryRoot: string,
    commit: string,
    operation: (worktree: string) => T,
  ): T {
    const temporaryBase = createTrustedExecutionEnvironment().TMPDIR;
    if (!temporaryBase) {
      throw ciPlanningError(
        'CI_PLANNING_TEMPORARY_DIRECTORY_UNAVAILABLE',
        'Planning replay requires a trusted temporary directory.',
      );
    }
    const temporaryRoot = fs.mkdtempSync(
      path.join(fs.realpathSync(temporaryBase), 'workflow-ci-planning-'),
    );
    const worktree = path.join(temporaryRoot, 'worktree');
    let worktreeAdded = false;
    try {
      runGit(repositoryRoot, ['worktree', 'add', '--detach', worktree, commit]);
      worktreeAdded = true;
      return operation(worktree);
    } finally {
      if (worktreeAdded) {
        runGit(repositoryRoot, ['worktree', 'remove', '--force', worktree]);
      }
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  }

  function listTreeEntries(
    repositoryRoot: string,
    commit: string,
    prefix: string,
  ): TreeEntry[] {
    const entries = runGit(repositoryRoot, [
      'ls-tree',
      '-r',
      '-z',
      commit,
      '--',
      `:(literal)${prefix}`,
    ])
      .split('\0')
      .filter(Boolean)
      .map((entry) => {
        const match = /^(\d+) (\S+) [0-9a-f]+\t(.+)$/.exec(entry);
        if (!match) {
          throw ciPlanningError(
            'CI_PLANNING_TREE_INVALID',
            'CI could not parse the planning tree.',
          );
        }
        return {
          mode: match[1],
          type: match[2],
          path: normalizeChangedPath(match[3]),
        };
      })
      .sort((left, right) => left.path.localeCompare(right.path));
    // Git accepts trees whose entries repeat a name; downstream membership
    // checks would collapse the duplicates and read an ambiguous tree as valid.
    const seenPaths = new Set<string>();
    for (const { path: entryPath } of entries) {
      if (seenPaths.has(entryPath)) {
        throw ciPlanningError(
          'CI_PLANNING_TREE_INVALID',
          'Planning trees must not contain duplicate entries.',
        );
      }
      seenPaths.add(entryPath);
    }
    return entries;
  }

  function readRequiredFile(
    repositoryRoot: string,
    commit: string,
    filePath: string,
  ): string {
    try {
      return runGit(repositoryRoot, ['show', `${commit}:${filePath}`]);
    } catch (error) {
      throw ciPlanningError(
        'CI_PLANNING_TREE_INVALID',
        'CI could not read a required planning artifact.',
        { cause: error instanceof Error ? error.message : String(error) },
      );
    }
  }
  return {
    resolveHistoricalPlanningProviderForCi,
    collectHistoricalCollaborationGrantUses,
    validateCiPlanningCommit,
    collectCurrentCollaborationGrantUses,
  };
}

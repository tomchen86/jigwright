/**
 * Replays current PlanReview roles and resolves exact repository and
 * planning evidence.
 *
 * Invariants:
 * - Shared-context review replay requires terminal authority for the exact
 *   transition.
 */
import {
  assertAdmittedRoleResultRecord,
  admitConsumedRoleContextSharingResultReplay,
  admitRoleResult,
  admitConsumedRoleResultReplay,
} from '../provider-orchestration/role-scheduler.ts';
import type { AdmittedRoleResult } from '../provider-orchestration/role-scheduler.ts';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import {
  parseCollaborationGrantEnvelope,
  canonicalCollaborationGrantEnvelope,
  bindingFromPayload,
} from '../authority/collaboration-grant.ts';
import { readPlanReviewNode } from './plan-review.ts';
import type {
  PlanReviewSubject,
  PlanReviewTargetSnapshot,
} from './plan-review.ts';
import type {
  PlanReviewRepositoryEvidence,
  PlanReviewPlanningEvidence,
} from './plan-review-validation.ts';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { parseMaintainerPolicy } from '../authority/maintainer-policy.ts';
import type {
  PlanningAssuranceEvidenceResolverBindings,
  CurrentPlanReviewRoleResultReplayContext,
  ConsumedPlanReviewReplayPort,
  ChangeContract,
  EvidenceNode,
} from './planning-assurance-validator.ts';

export function createPlanningAssuranceEvidenceResolver(
  bindings: PlanningAssuranceEvidenceResolverBindings,
) {
  const { planningNotReady, sha256, isPlainRecord, runGit, runGitBuffer } =
    bindings;

  /**
   * Re-authenticate one persisted PlanReview role result against the terminal
   * Grant record before recovery or status code consumes its role facts. The
   * content-pure role reader remains the first boundary; grant-backed forms then
   * require the same opaque consumed-use replay used by planning readiness.
   */
  function replayCurrentPlanReviewRoleResult(
    storedValue: unknown,
    context: CurrentPlanReviewRoleResultReplayContext,
    consumedPlanReviewReplay?: ConsumedPlanReviewReplayPort,
  ): AdmittedRoleResult {
    let stored: AdmittedRoleResult;
    try {
      stored = assertAdmittedRoleResultRecord(storedValue);
    } catch {
      throw planningNotReady('Stored PlanReview role result is malformed.');
    }
    if (stored.form === 'granted-role-context-sharing') {
      const evidence = stored.roleContextSharingUse;
      const expected = evidence?.expectedBinding;
      if (
        consumedPlanReviewReplay === undefined ||
        evidence === null ||
        expected === undefined ||
        stored.providerInvocation === null ||
        expected.changeId !== context.changeId ||
        expected.baselineCommit !== context.baselineCommit ||
        expected.baselineTree !== context.baselineTree ||
        expected.subjectDigest !== context.subjectDigest ||
        expected.targetDigest !== context.subjectDigest ||
        expected.planningGeneration !== context.planningGenerationId ||
        expected.lifecyclePhase !== 'plan-review'
      ) {
        throw planningNotReady(
          'Role-context-sharing PlanReview is bound to another transition or has no terminal replay authority.',
        );
      }
      const replay = consumedPlanReviewReplay.verifyRoleContextSharing({
        repositoryRoot: context.repositoryRoot,
        evidence,
        assignment: stored.assignment,
        author: stored.author,
        participant: stored.participant,
        content: stored.content,
        providerInvocation: stored.providerInvocation,
      });
      if (
        replay.grantId !== evidence.grantId ||
        replay.terminalRecordDigest !== evidence.terminalRecordDigest ||
        replay.useProjectionDigest !== evidence.useProjectionDigest
      ) {
        throw planningNotReady(
          'Consumed role-context-sharing replay proof does not match the exact stored use.',
        );
      }
      const replayed = admitConsumedRoleContextSharingResultReplay({
        assignment: stored.assignment,
        author: stored.author,
        participant: stored.participant,
        content: stored.content,
        providerInvocation: stored.providerInvocation,
        replay,
      });
      if (canonicalJson(replayed) !== canonicalJson(stored)) {
        throw planningNotReady(
          'Stored PlanReview role result does not replay exactly.',
        );
      }
      return replayed;
    }
    let replayed: AdmittedRoleResult;
    if (stored.form === 'ordinary-provider') {
      if (
        stored.author.sessionId === null ||
        stored.assignment.sessionId === null ||
        stored.author.sessionId === stored.assignment.sessionId ||
        (stored.requiredIndependence === 'session-independent'
          ? stored.achievedIndependence !== 'provider-independent' &&
            stored.achievedIndependence !== 'session-independent'
          : stored.requiredIndependence !== 'provider-independent' ||
            stored.achievedIndependence !== 'provider-independent' ||
            stored.author.providerId === null ||
            stored.author.providerId === stored.assignment.providerId)
      ) {
        throw planningNotReady(
          'Ordinary PlanReview must record a session distinct from the plan author.',
        );
      }
      replayed = admitRoleResult({
        assignment: stored.assignment,
        author: stored.author,
        participant: stored.participant,
        content: stored.content,
        providerInvocation: stored.providerInvocation,
        grantUse: null,
        grantValidation: null,
      });
    } else {
      if (consumedPlanReviewReplay === undefined || !stored.grantUse) {
        throw planningNotReady(
          'Granted PlanReview role result has no terminal replay authority.',
        );
      }
      const envelope = parseCollaborationGrantEnvelope(
        canonicalCollaborationGrantEnvelope(stored.grantUse.envelope),
      );
      if (
        envelope.payload.changeId !== context.changeId ||
        envelope.payload.baselineCommit !== context.baselineCommit ||
        envelope.payload.baselineTree !== context.baselineTree ||
        envelope.payload.targetDigest !== context.subjectDigest ||
        envelope.payload.lifecyclePhase !== 'plan-review'
      ) {
        throw planningNotReady(
          'Granted PlanReview role result is bound to another transition.',
        );
      }
      const expectedBinding = bindingFromPayload(envelope.payload);
      const replay = consumedPlanReviewReplay.verify({
        repositoryRoot: context.repositoryRoot,
        expectedBinding,
        grantUse: stored.grantUse,
        assignment: stored.assignment,
        content: stored.content,
        directHumanReviewAttestation: stored.directHumanReviewAttestation,
      });
      if (
        replay.grantId !== stored.grantUse.grantId ||
        replay.transitionDigest !== stored.grantUse.transitionDigest ||
        replay.useDigest !== sha256(canonicalJson(stored.grantUse))
      ) {
        throw planningNotReady(
          'Consumed PlanReview replay proof does not match the exact stored grant use.',
        );
      }
      replayed = admitConsumedRoleResultReplay({
        assignment: stored.assignment,
        author: stored.author,
        participant: stored.participant,
        content: stored.content,
        providerInvocation: stored.providerInvocation,
        replay,
      });
    }
    if (canonicalJson(replayed) !== canonicalJson(stored)) {
      throw planningNotReady(
        'Stored PlanReview role result does not replay exactly.',
      );
    }
    return replayed;
  }

  function requireCurrentPlanReviewRoleResult(
    repositoryRoot: string,
    contract: ChangeContract,
    providerResultNode: EvidenceNode,
    subject: PlanReviewSubject,
    consumedPlanReviewReplay: ConsumedPlanReviewReplayPort,
  ): AdmittedRoleResult {
    const candidates = contract.planReview?.roleResults ?? [];
    const matches = candidates.filter((candidate) => {
      if (!isPlainRecord(candidate) || !isPlainRecord(candidate.content)) {
        return false;
      }
      return (
        candidate.role === 'plan-reviewer' &&
        candidate.targetDigest === subject.subjectDigest &&
        candidate.content.nodeId === providerResultNode.nodeId &&
        candidate.content.resultDigest === providerResultNode.resultDigest
      );
    });
    if (matches.length !== 1) {
      throw planningNotReady(
        'Exactly one admitted role result must authorize the current PlanReview.',
      );
    }
    return replayCurrentPlanReviewRoleResult(
      matches[0],
      {
        repositoryRoot,
        changeId: contract.changeId,
        baselineCommit: subject.investigationBaseline.head,
        baselineTree: subject.investigationBaseline.tree,
        subjectDigest: subject.subjectDigest,
        planningGenerationId: subject.planningGenerationId,
      },
      consumedPlanReviewReplay,
    );
  }

  function resolvePlanReviewRepositoryEvidence(
    repositoryRoot: string,
    tree: string,
    reviewNode: EvidenceNode,
    planningSnapshot?: PlanReviewTargetSnapshot,
  ): PlanReviewRepositoryEvidence {
    const review = readPlanReviewNode(reviewNode);
    const citations = [
      ...review.findings.flatMap((finding) => finding.evidence),
      ...review.suggestions.flatMap((suggestion) => suggestion.evidence),
      ...(review.scopeAssessment.kind === 'no-challenge'
        ? review.scopeAssessment.evidence
        : []),
    ];
    const paths = [
      ...new Set(
        citations
          .filter(
            (
              citation,
            ): citation is Extract<
              (typeof citations)[number],
              { kind: 'repository-location' }
            > => citation.kind === 'repository-location',
          )
          .map((citation) => citation.path),
      ),
    ].sort(compareUtf8);
    const planningPaths = new Set(
      planningSnapshot?.artifacts.map(({ path }) => path) ?? [],
    );
    return {
      tree,
      locations: paths.map((repositoryPath) => {
        if (planningPaths.has(repositoryPath)) {
          throw planningNotReady(
            'PlanReview cites a planning snapshot path through the repository namespace.',
          );
        }
        const listing = runGit(repositoryRoot, [
          'ls-tree',
          '-z',
          tree,
          '--',
          `:(literal)${repositoryPath}`,
        ]);
        const match = /^100\d{3} blob ([0-9a-f]{40,64})\t/.exec(listing);
        if (!match) {
          throw planningNotReady(
            'PlanReview cites a path absent from its investigation baseline.',
          );
        }
        const content = runGit(repositoryRoot, [
          'show',
          `${tree}:${repositoryPath}`,
        ]);
        return {
          path: repositoryPath,
          blobOid: match[1]!,
          lineCount:
            content.length === 0
              ? 0
              : content.endsWith('\n')
                ? content.slice(0, -1).split('\n').length
                : content.split('\n').length,
        };
      }),
    };
  }

  function resolvePlanReviewPlanningEvidence(
    repositoryRoot: string,
    snapshot: PlanReviewTargetSnapshot,
    reviewNode: EvidenceNode,
  ): PlanReviewPlanningEvidence {
    const review = readPlanReviewNode(reviewNode);
    const citedPaths = [
      ...review.findings.flatMap((finding) => finding.evidence),
      ...review.suggestions.flatMap((suggestion) => suggestion.evidence),
      ...(review.scopeAssessment.kind === 'no-challenge'
        ? review.scopeAssessment.evidence
        : []),
    ]
      .filter(
        (
          citation,
        ): citation is Extract<
          (typeof review.findings)[number]['evidence'][number],
          { kind: 'planning-location' }
        > => citation.kind === 'planning-location',
      )
      .map(({ path: planningPath }) => planningPath);
    const uniquePaths = [...new Set(citedPaths)].sort(compareUtf8);
    const artifacts = new Map(
      snapshot.artifacts.map((artifact) => [artifact.path, artifact]),
    );
    const resolved = new Map<
      string,
      PlanReviewPlanningEvidence['locations'][number]
    >();
    const snapshotCommit = resolvePlanReviewSnapshotCommit(
      repositoryRoot,
      snapshot,
    );
    for (const artifact of snapshot.artifacts) {
      const content =
        snapshotCommit === null
          ? readCurrentPlanningTarget(repositoryRoot, artifact.path)
          : readCommittedPlanningTarget(
              repositoryRoot,
              snapshotCommit,
              artifact.path,
            );
      const digest = crypto.createHash('sha256').update(content).digest('hex');
      const lineCount =
        content.length === 0
          ? 0
          : content.at(-1) === 0x0a
            ? content.toString('utf8').slice(0, -1).split('\n').length
            : content.toString('utf8').split('\n').length;
      if (
        digest !== artifact.sha256 ||
        content.byteLength !== artifact.byteLength ||
        lineCount !== artifact.lineCount
      ) {
        throw planningNotReady(
          'Current planning bytes differ from the reviewed target snapshot.',
        );
      }
      resolved.set(artifact.path, {
        path: artifact.path,
        sha256: digest,
        byteLength: content.byteLength,
        lineCount,
      });
    }
    const locations = uniquePaths.map((planningPath) => {
      const location = resolved.get(planningPath);
      if (!location || !artifacts.has(planningPath)) {
        throw planningNotReady(
          'PlanReview cites a path absent from its planning target snapshot.',
        );
      }
      return location;
    });
    return {
      snapshotDigest: snapshot.snapshotDigest,
      locations,
    };
  }

  function resolvePlanReviewSnapshotCommit(
    repositoryRoot: string,
    snapshot: PlanReviewTargetSnapshot,
  ): string | null {
    const metadataPaths = snapshot.artifacts
      .map(({ path: artifactPath }) => artifactPath)
      .filter((artifactPath) => artifactPath.endsWith('/.openspec.yaml'));
    if (metadataPaths.length !== 1) {
      throw planningNotReady(
        'PlanReview target snapshot does not identify one planning root.',
      );
    }
    const changePrefix = path.posix.dirname(metadataPaths[0]!);
    if (
      snapshot.artifacts.some(
        ({ path: artifactPath }) =>
          artifactPath !== changePrefix &&
          !artifactPath.startsWith(`${changePrefix}/`),
      )
    ) {
      throw planningNotReady(
        'PlanReview target snapshot crosses planning roots.',
      );
    }
    const planReviewPath = `${changePrefix}/plan-review.json`;
    const listing = runGit(repositoryRoot, [
      'ls-tree',
      '-z',
      'HEAD',
      '--',
      `:(literal)${planReviewPath}`,
    ]);
    const match = /^(100644) blob [0-9a-f]{40,64}\t([^\0]+)\0$/.exec(listing);
    if (!match || match[2] !== planReviewPath) return null;

    const absolutePath = path.join(repositoryRoot, planReviewPath);
    const stats = fs.lstatSync(absolutePath, { throwIfNoEntry: false });
    if (!stats) {
      // The committed review has been withdrawn from the worktree — an
      // amendment returning the graph to review-pending. Absence is "no
      // committed review applies", exactly like current bytes that differ; only
      // a file that exists in an unsafe shape is refused.
      return null;
    }
    if (
      !stats.isFile() ||
      stats.isSymbolicLink() ||
      stats.nlink !== 1 ||
      (stats.mode & 0o777) !== 0o644
    ) {
      throw planningNotReady(
        'PlanReview artifact is not a regular mode-0644 file.',
      );
    }
    const current = fs.readFileSync(absolutePath);
    const committed = runGitBuffer(repositoryRoot, [
      'show',
      `HEAD:${planReviewPath}`,
    ]);
    if (!current.equals(committed)) return null;

    const commit = runGit(repositoryRoot, [
      'log',
      '-1',
      '--format=%H',
      'HEAD',
      '--',
      `:(literal)${planReviewPath}`,
    ]).trim();
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)) {
      throw planningNotReady(
        'Committed PlanReview target snapshot origin is not resolvable.',
      );
    }
    const origin = runGitBuffer(repositoryRoot, [
      'show',
      `${commit}:${planReviewPath}`,
    ]);
    if (!origin.equals(committed)) {
      throw planningNotReady(
        'Committed PlanReview target snapshot origin is ambiguous.',
      );
    }
    return commit;
  }

  function readCurrentPlanningTarget(
    repositoryRoot: string,
    artifactPath: string,
  ): Buffer {
    const absolutePath = path.join(repositoryRoot, artifactPath);
    const stats = fs.lstatSync(absolutePath, { throwIfNoEntry: false });
    if (
      !stats?.isFile() ||
      stats.isSymbolicLink() ||
      stats.nlink !== 1 ||
      (stats.mode & 0o777) !== 0o644
    ) {
      throw planningNotReady(
        'PlanReview planning evidence is not a regular mode-0644 file.',
      );
    }
    return fs.readFileSync(absolutePath);
  }

  function readCommittedPlanningTarget(
    repositoryRoot: string,
    commit: string,
    artifactPath: string,
  ): Buffer {
    const listing = runGit(repositoryRoot, [
      'ls-tree',
      '-z',
      commit,
      '--',
      `:(literal)${artifactPath}`,
    ]);
    const match = /^(100644) blob [0-9a-f]{40,64}\t([^\0]+)\0$/.exec(listing);
    if (!match || match[2] !== artifactPath) {
      throw planningNotReady(
        'Committed PlanReview planning evidence is not an exact mode-100644 blob.',
      );
    }
    return runGitBuffer(repositoryRoot, ['show', `${commit}:${artifactPath}`]);
  }

  function loadMaintainerPolicyAtCommit(
    repositoryRoot: string,
    commit: string,
  ): ReturnType<typeof parseMaintainerPolicy> {
    let value: unknown;
    try {
      value = JSON.parse(
        runGit(repositoryRoot, [
          'show',
          `${commit}:workflow/maintainer-policy.json`,
        ]),
      );
    } catch (error) {
      throw planningNotReady(
        `The baseline maintainer policy cannot be read: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return parseMaintainerPolicy(value);
  }

  function compareUtf8(left: string, right: string): number {
    return Buffer.compare(
      Buffer.from(left, 'utf8'),
      Buffer.from(right, 'utf8'),
    );
  }

  return {
    replayCurrentPlanReviewRoleResult,
    resolvePlanReviewRepositoryEvidence,
    resolvePlanReviewPlanningEvidence,
    requireCurrentPlanReviewRoleResult,
    loadMaintainerPolicyAtCommit,
  };
}

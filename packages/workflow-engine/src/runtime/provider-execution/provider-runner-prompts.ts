/**
 * Render the exact managed provider prompt and planning snapshot instructions.
 *
 * Invariants:
 * - Purpose-specific instruction text and canonical prompt bytes stay unchanged.
 * - Planning snapshot validation precedes exposing its content to a provider.
 */

import path from 'node:path';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { type ProviderInvocationRequest } from '../../modules/provider-orchestration/provider-contracts.ts';
import { isRecord, inputManifestMismatch } from './provider-runner-values.ts';

const PROVIDER_PURPOSE_INSTRUCTIONS: Readonly<
  Record<ProviderInvocationRequest['purpose'], readonly string[]>
> = Object.freeze({
  survey: Object.freeze([
    'Independently survey the repository for load-bearing consumers, sibling mechanisms, configuration keys, literal paths, symbols, and architecture invariants relevant to the bound manifest.',
    'Use only the reviewed read/search capability surface.',
    'Return only output that conforms to the bound output schema.',
    // Advisory only: the engine scans every proposed term across the whole
    // pinned tree under a fixed per-term hit ceiling, and a term that exceeds
    // it currently has no recovery exit. A provider cannot count hits, so this
    // states the strategy it can actually act on rather than the limit it
    // cannot measure.
    'For every proposed search term, prefer a verified, repository-specific exact literal that preserves the relevant relationship. When a concept has a commonly used name, use a longer literal containing repository-specific context, a fully qualified symbol, or a literal path rather than the unqualified identifier. Confirm that each literal exists in the pinned repository; use multiple specific terms when necessary to preserve coverage rather than inventing a broader token.',
    // The bound survey validator enforces three constraints the provider-visible
    // JSON schema cannot express: the reference identity, the per-term byte and
    // character bounds, and term uniqueness. They are stated here because a
    // provider that satisfies only the published schema is otherwise rejected
    // with no way to learn why.
    'Set the output "reference" field to exactly the invocationId carried in this prompt request block; any other value is rejected.',
    'Each term value must be at most 256 UTF-8 bytes with no control characters or lone surrogates, and the terms must be unique by their exact kind and value pair.',
  ]),
  'plan-review': Object.freeze([
    'Independently review the complete bound planning target for missing scope, weak WHY rationale, unsupported invariants, contradictions, and testability gaps.',
    'Use only the reviewed read/search capability surface.',
    'Return only output that conforms to the bound output schema.',
    // Coverage, the scope-assessment kind, and every constant discriminator are
    // filled in by the engine from what was actually submitted, so there is no
    // derived field here for a provider to contradict.
    'Review all seven coverage areas; report what you find as "findings" entries whose category names the area.',
    'The output "scopeEvidence" array cites what you read to assess scope. Report a scope problem as a "findings" entry with category "missing-scope" or "missing-consumers"; the engine derives the scope assessment from those categories.',
    // Advisory only: the engine scans every proposed term across the whole
    // pinned tree under a fixed per-term hit ceiling, and a term that exceeds
    // it currently has no recovery exit. A provider cannot count hits, so this
    // states the strategy it can actually act on rather than the limit it
    // cannot measure.
    'For every proposed search term, prefer a verified, repository-specific exact literal that preserves the relevant relationship. When a concept has a commonly used name, use a longer literal containing repository-specific context, a fully qualified symbol, or a literal path rather than the unqualified identifier. Confirm that each literal exists in the pinned repository; use multiple specific terms when necessary to preserve coverage rather than inventing a broader token.',
    'Read every planning artifact only from the immutable planningSnapshot artifact readPath supplied in this prompt. Never substitute the worktree path or the baseline-tree copy for a planning artifact.',
    'In the immutable investigation.json v3 Manifest, find the unique applicability.semanticDelta.investigationRequirements[] entry whose kind is "plan-review-coverage-requirement". Read structured PlanReview coverage only from that entry\'s coverage.requiredTargetIds and coverage.targetBindings. Treat every requiredTargetIds entry as mandatory. For each required target, cite the matching targetBindings row\'s exact evidenceKind and path at least once in scopeAssessment, a finding, or a suggestion. Extra evidence is allowed; omitting a required row is rejected at plan commit.',
    'Cite a planningSnapshot member with kind "planning-location" and its logical path. Cite any other repository file with kind "repository-location"; repository-location lines are validated against the pinned baseline tree. The two namespaces are disjoint and a citation in the wrong namespace is rejected.',
    'Treat planningSnapshot.migration as a binding remediation constraint: preserved-byte-identical artifacts cannot be proposed as editable in this generation, replaceable-on-replanning artifacts may change only through a new planning generation, and engine-managed artifacts are not author-editable.',
  ]),
  'task-diff-review': Object.freeze([
    'Independently review the exact bound candidate tree and its base-to-candidate blob and mode transitions.',
    'Use only the reviewed read/search capability surface and do not mutate the worktree, index, refs, runtime, or any repository file.',
    'Return only output that conforms to the bound task-diff-review output schema.',
    'Review every required area; report what you find as "findings" entries whose category names the area. The output "scopeEvidence" array cites what you read to assess scope, and the engine derives the scope assessment from the findings.',
    'The output "riskPathDispositions" array must contain exactly one row for every subject.reviewRequirement.riskPaths entry covered by reviewScope, with the exact path and role; do not include ordinary paths.',
    'Inspect correctness and invariants, plan alignment, test adequacy, path scope, trust boundaries, dangling consumers, and generated or mirror consistency.',
    'When subject.documentationRequirement.required is true, review the complete changeBaseTree-to-candidateTree change and return exactly one documentationAssessment: updated with every changed documentation path, generated-verified with exact source/generated paths and check evidence, no-impact with a concrete rationale only when no documentation path changed, or needs-changes with exact documentation remediation paths. Omission is rejected. When it is false, omit documentationAssessment.',
    'Every challenge must cite exact repository, check-report, or planning-node evidence. A no-challenge scope assessment must still cite affirmative evidence.',
    'Classify current-change blockers as challenges and independent follow-up ideas as suggestions. The advisory verdict never authorizes completion.',
    'Treat the manifest subject, candidate tree, check evidence, task contract, planning generation, and review policy as immutable bindings; do not substitute live runtime metadata.',
  ]),
  'task-implementation': Object.freeze([
    'Implement only the exact engine-sealed RED subject and reviewed behavior contract carried by the bound manifest.',
    'Treat every frozen test and fixture path as authoritative and immutable; do not include changes to those paths in the returned patch.',
    'Return one unified binary-safe Git patch whose derived changes remain inside the reviewed implementation path scopes.',
    'Use only the reviewed read/search capability surface and do not mutate the worktree, index, refs, runtime, or any repository file.',
    'Return only output that conforms to the bound task-strategy implementation output schema.',
    'Do not report GREEN as authority; the workflow engine independently imports the patch and runs every registered GREEN check.',
  ]),
});

export function renderManagedProviderPrompt(
  request: ProviderInvocationRequest,
  manifest: unknown,
  reviewSnapshotRoot: string | null,
  repairContext: unknown,
): string {
  return canonicalJson({
    schemaVersion: 1,
    kind: 'managed-provider-prompt',
    request,
    manifest,
    repairContext,
    planningSnapshot: renderPlanningSnapshotPrompt(
      request,
      manifest,
      reviewSnapshotRoot,
    ),
    instructions: providerPurposeInstructions(request, manifest),
  });
}

function providerPurposeInstructions(
  request: ProviderInvocationRequest,
  manifest: unknown,
): readonly string[] {
  if (
    request.purpose === 'task-diff-review' &&
    isRecord(manifest) &&
    manifest.kind === 'task-diff-review-continuation-manifest'
  ) {
    return Object.freeze([
      'Re-review the exact immutable candidate in light of every bound challenge and implementer response.',
      'Use only the reviewed read/search capability surface and do not mutate the worktree, index, refs, runtime, or any repository file.',
      'Return structured proposed dispositions under the code-owned continuation schema; these recommendations are evidence and do not themselves accept, close, waive, or otherwise disposition any challenge.',
      'Bind every recommendation to the exact review, response, and complete challenge set, with a concise rationale for each decision.',
      'The workflow engine alone applies the shared authenticated challenge-closure verifier and may mint a Final Assurance record from an eligible result.',
    ]);
  }
  return PROVIDER_PURPOSE_INSTRUCTIONS[request.purpose];
}

function renderPlanningSnapshotPrompt(
  request: ProviderInvocationRequest,
  manifest: unknown,
  reviewSnapshotRoot: string | null,
): unknown {
  if (request.purpose !== 'plan-review') return null;
  if (!isRecord(manifest) || manifest.kind !== 'plan-review-manifest') {
    throw inputManifestMismatch();
  }
  if (manifest.planningTarget === undefined) return null;
  if (
    reviewSnapshotRoot === null ||
    !isRecord(manifest.planningTarget) ||
    !Array.isArray(manifest.planningTarget.artifacts)
  ) {
    throw inputManifestMismatch();
  }
  return {
    snapshotDigest: manifest.planningTarget.snapshotDigest,
    migration: manifest.planningTarget.migration,
    citationContract: {
      planning: {
        kind: 'planning-location',
        lineSource: 'immutable-planning-snapshot',
      },
      repository: {
        kind: 'repository-location',
        lineSource: 'pinned-investigation-baseline-tree',
      },
    },
    artifacts: manifest.planningTarget.artifacts.map((value) => {
      if (
        !isRecord(value) ||
        typeof value.path !== 'string' ||
        typeof value.snapshotFile !== 'string'
      ) {
        throw inputManifestMismatch();
      }
      return {
        ...value,
        readPath: path.join(reviewSnapshotRoot, value.snapshotFile),
      };
    }),
  };
}

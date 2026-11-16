import { type InvestigationManifestV3 } from '../../src/modules/investigation/manifest/investigation-manifest-types.ts';
import { sealInvestigationManifestDraft } from '../../src/modules/investigation/manifest/investigation-manifest.ts';
import { buildInvestigationManifestDraft } from '../../src/composition-root/investigation-production.ts';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {
  readInvestigationPublicationRefState,
  publishInvestigationManifestV3,
} from '../../src/runtime/managed-documents/transaction/investigation-publication.ts';
import {
  investigationManifestPublicationNamespace,
  type InvestigationManifestPublicationPhase,
} from '../../src/modules/investigation/manifest/investigation-publication-contracts.ts';
import fs from 'node:fs';
import path from 'node:path';
import { WorkflowError } from '../../src/foundation/errors/errors.ts';

export function buildCurrentV3Investigation(
  repository: string,
  changeId = 'demo-change',
  sessionRevision = 3,
): InvestigationManifestV3 {
  const baseline = {
    commitOid: execFileSync('git', ['-C', repository, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim(),
    treeOid: execFileSync(
      'git',
      ['-C', repository, 'rev-parse', 'HEAD^{tree}'],
      { encoding: 'utf8' },
    ).trim(),
  };
  const sessionSnapshotDigest = crypto
    .createHash('sha256')
    .update(`contracts-current-v3-session\0${sessionRevision}`)
    .digest('hex');
  const built = buildInvestigationManifestDraft({
    repositoryRoot: repository,
    state: {
      schemaVersion: 1,
      applicabilityKind: 'exemption',
      repositoryId: 'fixture',
      changeId,
      investigationId: `${changeId}-investigation`,
      normalizedIntent: {
        schemaVersion: 1,
        summary: 'Exercise the current v3 contract reader.',
        sourceRefs: [],
        explicitPaths: ['docs/example.md'],
        explicitSymbols: [],
        explicitConfigKeys: [],
        renamePairs: [],
      },
      authoring: { sessionRevision, sessionSnapshotDigest },
      exemption: {
        category: 'documentation-only',
        baseline,
        declaredPaths: ['docs/example.md'],
        declaredChangeClasses: ['documentation-only'],
        rationale: 'This reader fixture changes documentation only.',
        semanticAuthor: {
          id: 'owner',
          provenance: 'checkpoint:contracts-current-v3',
        },
        nonTrivialBehaviorReliance: 'none-declared',
        researchBudgetMinutes: null,
      },
    },
  });
  if (built.outcome !== 'built') assert.fail(built.blocker.failureCode);
  const sealed = sealInvestigationManifestDraft({
    draft: built.draft,
    approval: {
      semanticAuthor: {
        id: 'owner',
        provenance: 'checkpoint:contracts-current-v3-approval',
      },
      approvalProvenanceDigest: crypto
        .createHash('sha256')
        .update('contracts-current-v3-approval')
        .digest('hex'),
    },
  });
  if (sealed.outcome !== 'sealed') assert.fail(sealed.blocker.failureCode);
  return sealed.manifest;
}

export function contractPublicationFixture(
  repository: string,
  manifest: InvestigationManifestV3,
) {
  const lifecycle = {
    repositoryId: manifest.repositoryId,
    changeId: manifest.changeId,
    investigationId: manifest.investigationId,
    sessionRevision: manifest.authoring.sessionRevision,
    sessionSnapshotDigest: manifest.authoring.sessionSnapshotDigest,
  };
  const namespace = investigationManifestPublicationNamespace(lifecycle);
  const paths = {
    manifestPath: `openspec/changes/${manifest.changeId}/investigation.json`,
    currentRefPath: `workflow-engine/${namespace}/current.json`,
    journalPath: `workflow-engine/${namespace}/journal.json`,
  };
  const gitCommonValue = execFileSync(
    'git',
    ['-C', repository, 'rev-parse', '--git-common-dir'],
    { encoding: 'utf8' },
  ).trim();
  const privateRoot = fs.realpathSync(
    path.isAbsolute(gitCommonValue)
      ? gitCommonValue
      : path.resolve(repository, gitCommonValue),
  );
  const refState = readInvestigationPublicationRefState({
    repositoryRoot: repository,
    privateRoot,
    currentRefPath: paths.currentRefPath,
    lifecycle,
  });
  if (refState.outcome !== 'read') assert.fail(refState.blocker.failureCode);
  return {
    lifecycle,
    paths,
    privateRoot,
    expected: {
      ...lifecycle,
      currentRefDigest: refState.currentRefDigest,
    },
  };
}

export function publishCurrentV3Investigation(
  repository: string,
  manifest: InvestigationManifestV3,
  observePhase?: (phase: InvestigationManifestPublicationPhase) => void,
) {
  const publication = contractPublicationFixture(repository, manifest);
  return publishInvestigationManifestV3({
    repositoryRoot: repository,
    privateRoot: publication.privateRoot,
    paths: publication.paths,
    manifest,
    expected: publication.expected,
    withTransitionLock: (operation) => operation(publication.expected),
    observePhase,
  });
}

export function isWorkflowError(error: unknown, code: string): boolean {
  return error instanceof WorkflowError && error.code === code;
}

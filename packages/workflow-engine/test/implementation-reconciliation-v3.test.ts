import { readCurrentImplementationReconciliationRequirement } from '../src/application/reconciliation/investigation-reconciliation.ts';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import type { CurrentInvestigationManifest } from '../src/modules/planning-provider/change-contract.ts';
import {
  buildImplementationReconciliationRequirement,
  IMPLEMENTATION_RECONCILIATION_POLICY_DIGEST,
} from '../src/modules/why-knowledge/implementation-reconciliation.ts';
import { semanticFileSubjectId } from '../src/modules/why-knowledge/semantic-ledger.ts';
import { projectReconciledInvestigationManifestWhyToLedger } from '../src/runtime/managed-documents/transaction/semantic-ledger-projection.ts';
import { readLedgerEntry } from '../src/runtime/storage-journal/semantic-ledger-store.ts';
import {
  ledgerIndexPath,
  ledgerObjectPath,
} from '../src/runtime/storage-journal/semantic-ledger-store.ts';
import { replayTaskSemanticLedger } from '../src/runtime/repository-validation/commit-replay/ci-semantic-ledger.ts';
import type { MutationDisposition } from '../src/modules/why-knowledge/semantic-reconciliation.ts';
import { isWorkflowError } from './fixture.ts';

const BASELINE = {
  head: '1'.repeat(40),
  tree: '2'.repeat(40),
};
const MANIFEST_DIGEST = '3'.repeat(64);

test('v3 authoring builds reconciliation directly from WHY overlays', () => {
  const requirement = buildImplementationReconciliationRequirement({
    changeId: 'v3-change',
    baseline: BASELINE,
    intent: {
      schemaVersion: 1,
      summary: 'Change a.',
      sourceRefs: [],
      explicitPaths: ['src/b.ts', 'src/a.ts'],
      explicitSymbols: [],
      explicitConfigKeys: [],
      renamePairs: [],
    },
    whyOverlays: [whyOverlay('src/a.ts', 'A remains available.')],
  });

  assert.deepEqual(requirement.plannedMutations, [
    {
      subjectId: semanticFileSubjectId('src/a.ts'),
      path: 'src/a.ts',
      intendedChange: 'Change a.',
      invariantsToPreserve: ['A remains available.'],
    },
    {
      subjectId: semanticFileSubjectId('src/b.ts'),
      path: 'src/b.ts',
      intendedChange: 'Change a.',
      invariantsToPreserve: [],
    },
  ]);
});

test('current v3 reconciliation reader binds the exact structured requirement and Manifest', () => {
  const requirement = reconciliationRequirement();
  const resolved = readCurrentImplementationReconciliationRequirement(
    currentInvestigation({
      kind: 'ordinary',
      requirements: [requirement],
    }),
  );

  assert.ok(resolved);
  assert.equal(resolved.requirementId, 'implementation-reconciliation');
  assert.equal(
    resolved.requirementDigest,
    sha256(
      canonicalJson({
        schema: 'implementation-reconciliation-requirement-binding.v3',
        requirement,
      }),
    ),
  );
  assert.equal(resolved.investigationManifestDigest, MANIFEST_DIGEST);
  assert.deepEqual(resolved.requirement, requirement.reconciliation);
});

test('current v3 reconciliation reader rejects ambiguous, non-canonical, and stale requirement authority', () => {
  const requirement = reconciliationRequirement();
  assert.throws(
    () =>
      readCurrentImplementationReconciliationRequirement(
        currentInvestigation({
          kind: 'ordinary',
          requirements: [requirement, { ...requirement, requirementId: 'two' }],
        }),
      ),
    (error) => isWorkflowError(error, 'IMPLEMENTATION_RECONCILIATION_INVALID'),
  );

  const nonCanonical = structuredClone(requirement);
  nonCanonical.reconciliation.plannedMutations = [
    {
      subjectId: semanticFileSubjectId('src/z.ts'),
      path: 'src/z.ts',
      intendedChange: 'Change z.',
      invariantsToPreserve: [],
    },
    ...nonCanonical.reconciliation.plannedMutations,
  ];
  assert.throws(
    () =>
      readCurrentImplementationReconciliationRequirement(
        currentInvestigation({
          kind: 'ordinary',
          requirements: [nonCanonical],
        }),
      ),
    (error) => isWorkflowError(error, 'IMPLEMENTATION_RECONCILIATION_INVALID'),
  );

  assert.throws(
    () =>
      readCurrentImplementationReconciliationRequirement(
        currentInvestigation({
          kind: 'ordinary',
          requirements: [requirement],
          validationManifestDigest: '4'.repeat(64),
        }),
      ),
    (error) => isWorkflowError(error, 'IMPLEMENTATION_RECONCILIATION_INVALID'),
  );
});

test('current v3 reconciliation reader explicitly treats an exemption as no requirement', () => {
  assert.equal(
    readCurrentImplementationReconciliationRequirement(
      currentInvestigation({ kind: 'exemption' }),
    ),
    null,
  );
});

test('reconciled ledger projection consumes v3 WHY overlays without v2 evidence nodes', () => {
  const repository = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-reconciliation-v3-ledger-'),
  );
  try {
    execFileSync('git', ['init', '--quiet'], { cwd: repository });
    fs.mkdirSync(path.join(repository, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(repository, 'src/a.ts'),
      'export const a = 1;\n',
    );
    const subjectId = semanticFileSubjectId('src/a.ts');
    const projection = projectReconciledInvestigationManifestWhyToLedger({
      repositoryRoot: repository,
      changeId: 'v3-change',
      baselineCommit: BASELINE.head,
      whyOverlays: [
        {
          overlayId: '8'.repeat(64),
          pathIdentity: {
            rawBase64: Buffer.from('src/a.ts').toString('base64'),
            utf8: 'src/a.ts',
          },
          blobOid: '9'.repeat(40),
          contentSha256: 'a'.repeat(64),
          groupRefs: [],
          anchors: [],
          why: 'This file owns A.',
          protectedInvariant: 'A remains available.',
          reviewerQuestion: 'Does A remain available?',
          answer: 'Yes.',
          semanticAuthor: {
            id: 'owner',
            provenance: 'checkpoint:investigation-approval',
          },
          readComplete: true,
          semanticAssurance: 'actor-attested-not-engine-verified',
        },
      ],
      policyDigest: IMPLEMENTATION_RECONCILIATION_POLICY_DIGEST,
      actualMutations: [
        {
          subjectId,
          disposition: 'existing-subject-changed',
          whatChanged: 'A changed.',
          whyChanged: 'The plan requires it.',
          preservedInvariants: ['A remains available.'],
          removedInvariants: [],
          ranges: [{ path: 'src/a.ts', startLine: 1, endLine: 1 }],
        },
      ],
    });

    assert.ok(projection);
    const entry = readLedgerEntry(repository, projection.entryIds[0]!);
    assert.equal(Object.hasOwn(entry, 'why'), false);
    assert.equal(entry.subject.path, 'src/a.ts');
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

for (const variant of [
  'changed',
  'unchanged',
  'new',
  'deleted',
  'binary',
  'symlink',
  'asset-import',
] as const) {
  test(`Git replay verifies exact ${variant} reconciliation and rejects ledger drift`, (t) => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'reconciliation-replay-'),
    );
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    git('init', '--quiet');
    git('config', 'user.name', 'Replay Fixture');
    git('config', 'user.email', 'replay@example.invalid');
    git('config', 'commit.gpgsign', 'false');
    const target = 'src/a.ts';
    const other = 'src/other.ts';
    const overlays = [
      whyOverlay(target, 'A remains available.'),
      whyOverlay(other, 'Other remains unchanged.'),
    ];
    fs.mkdirSync(path.join(root, 'src'));
    if (variant !== 'new')
      fs.writeFileSync(path.join(root, target), 'export const a = 1;\n');
    fs.writeFileSync(path.join(root, other), 'export const other = 1;\n');
    fs.writeFileSync(
      path.join(root, 'src/a.css'),
      '.fixture { color: red; }\n',
    );
    fs.mkdirSync(path.join(root, 'dist'));
    fs.writeFileSync(
      path.join(root, 'dist/asset.ts'),
      'export const asset = 1;\n',
    );
    const planning = path.join(root, 'openspec/changes/v3-change');
    fs.mkdirSync(planning, { recursive: true });
    // This unit exercises projection only; the integration test validates the governing plan.
    fs.writeFileSync(
      path.join(planning, 'investigation.json'),
      JSON.stringify({
        applicability: {
          kind: 'ordinary',
          semanticDelta: { whyOverlays: overlays },
        },
      }),
    );
    const commit = (message: string) => {
      git('add', '.');
      git('commit', '--quiet', '-m', message);
      return git('rev-parse', 'HEAD');
    };
    const initial = commit('Initial projection fixture');
    const project = (
      baselineCommit: string,
      paths: string[],
      disposition: MutationDisposition,
    ) =>
      projectReconciledInvestigationManifestWhyToLedger({
        repositoryRoot: root,
        changeId: 'v3-change',
        baselineCommit,
        whyOverlays: overlays,
        policyDigest: IMPLEMENTATION_RECONCILIATION_POLICY_DIGEST,
        actualMutations: paths.map((file) => ({
          subjectId: semanticFileSubjectId(file),
          disposition,
          whatChanged: 'Fixture source binding.',
          whyChanged: 'Exercise portable replay.',
          preservedInvariants: [],
          removedInvariants: [],
          ranges: [],
        })),
      });
    const seed = project(
      initial,
      variant === 'new' ? [other] : [target, other],
      'existing-subject-changed',
    )!;
    const parent = commit('Seed parent ledger');
    if (variant === 'deleted') fs.unlinkSync(path.join(root, target));
    else if (variant === 'symlink') {
      fs.unlinkSync(path.join(root, target));
      fs.symlinkSync('other.ts', path.join(root, target));
    } else if (variant === 'binary')
      fs.writeFileSync(path.join(root, target), Buffer.from([0, 255, 1]));
    else if (variant === 'asset-import')
      fs.writeFileSync(
        path.join(root, target),
        "import './a.css';\nimport '../dist/asset.ts';\nexport const a = 2;\n",
      );
    else if (variant !== 'unchanged')
      fs.writeFileSync(path.join(root, target), 'export const a = 2;\n');
    const disposition =
      variant === 'deleted'
        ? 'subject-deleted'
        : variant === 'new'
          ? 'new-subject'
          : variant === 'unchanged'
            ? 'generated-output'
            : 'existing-subject-changed';
    const projection = project(parent, [target], disposition)!;
    const head = commit('Commit reconciled projection');
    const replay = (candidate: string) =>
      replayTaskSemanticLedger(
        root,
        parent,
        candidate,
        'v3-change',
        git('diff', '--name-only', parent, candidate).split('\n'),
      );
    assert.deepEqual(replay(head), [...projection.paths]);
    const object = projection.paths.find((file) => file !== ledgerIndexPath())!;
    const extra = ledgerObjectPath(`sha256:${'0'.repeat(64)}`);
    for (const mutate of [
      () =>
        fs.writeFileSync(
          path.join(root, ledgerIndexPath()),
          `${canonicalJson({ schemaVersion: 1, kind: 'semantic-ledger-index', subjects: {} })}\n`,
        ),
      () =>
        fs.appendFileSync(
          path.join(root, ledgerObjectPath(seed.entryIds[0]!)),
          '\n',
        ),
      () => {
        fs.mkdirSync(path.dirname(path.join(root, extra)), { recursive: true });
        fs.copyFileSync(path.join(root, object), path.join(root, extra));
      },
    ]) {
      mutate();
      git('add', '.');
      const malformed = git(
        'commit-tree',
        git('write-tree'),
        '-p',
        parent,
        '-m',
        'Invalid projection fixture',
      );
      assert.throws(
        () => replay(malformed),
        (error) => isWorkflowError(error, 'CI_TASK_SEMANTIC_LEDGER_INVALID'),
      );
      git('reset', '--hard', head);
    }
  });
}

function reconciliationRequirement() {
  return {
    kind: 'implementation-reconciliation-requirement' as const,
    requirementId: 'implementation-reconciliation',
    reconciliation: {
      schemaVersion: 1 as const,
      kind: 'implementation-reconciliation-requirement' as const,
      changeId: 'v3-change',
      baseline: BASELINE,
      policyDigest: IMPLEMENTATION_RECONCILIATION_POLICY_DIGEST,
      plannedMutations: [
        {
          subjectId: semanticFileSubjectId('src/a.ts'),
          path: 'src/a.ts',
          intendedChange: 'Change a.',
          invariantsToPreserve: ['A remains available.'],
        },
      ],
    },
    semanticAuthor: {
      id: 'owner',
      provenance: 'checkpoint:investigation-approval',
    },
    provenanceDigest: '5'.repeat(64),
  };
}

function whyOverlay(pathValue: string, protectedInvariant: string) {
  return {
    overlayId: '8'.repeat(64),
    pathIdentity: {
      rawBase64: Buffer.from(pathValue).toString('base64'),
      utf8: pathValue,
    },
    blobOid: '9'.repeat(40),
    contentSha256: 'a'.repeat(64),
    groupRefs: [],
    anchors: [],
    why: 'This file owns A.',
    protectedInvariant,
    reviewerQuestion: 'Does A remain available?',
    answer: 'Yes.',
    semanticAuthor: {
      id: 'owner',
      provenance: 'checkpoint:investigation-approval',
    },
    readComplete: true as const,
    semanticAssurance: 'actor-attested-not-engine-verified' as const,
  };
}

function currentInvestigation(
  input:
    | {
        kind: 'ordinary';
        requirements: unknown[];
        validationManifestDigest?: string;
      }
    | { kind: 'exemption' },
): CurrentInvestigationManifest {
  const applicability =
    input.kind === 'ordinary'
      ? {
          kind: 'ordinary',
          replayContract: {
            baseline: {
              commitOid: BASELINE.head,
              treeOid: BASELINE.tree,
            },
          },
          semanticDelta: {
            investigationRequirements: input.requirements,
            whyOverlays: [],
          },
        }
      : { kind: 'exemption' };
  return {
    manifest: {
      changeId: 'v3-change',
      manifestDigest: MANIFEST_DIGEST,
      applicability,
    },
    validation: {
      kind: 'manifest-authority-admissible',
      manifestDigest:
        input.kind === 'ordinary'
          ? (input.validationManifestDigest ?? MANIFEST_DIGEST)
          : MANIFEST_DIGEST,
      investigationTargetDigest: '6'.repeat(64),
    },
    currentTreeObservation: {
      kind: 'current-tracked-tree',
      path: 'openspec/changes/v3-change/investigation.json',
      contentDigest: '7'.repeat(64),
    },
  } as unknown as CurrentInvestigationManifest;
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

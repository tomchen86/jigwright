import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { CurrentInvestigationManifest } from '../src/adapters/consumer/expense-app/work-registry/contracts.ts';
import { deriveImplementationTermDelta } from '../src/modules/assurance/implementation-term-floor.ts';
import { normalizeInvestigationTerm } from '../src/modules/investigation/domain/investigation-terms.ts';
import { git } from './fixture.ts';

test('implementation term floor derives scan coverage from v3 domain facts only', () => {
  const source = fs.readFileSync(
    path.resolve(
      import.meta.dirname,
      '../src/modules/assurance/implementation-term-floor.ts',
    ),
    'utf8',
  );

  assert.match(source, /\bscanInvestigationTreeFacts\b/);
  assert.match(source, /\bderiveInvestigationGroupFacts\b/);
  assert.doesNotMatch(source, /\bscanInvestigationTree\b/);
  assert.doesNotMatch(source, /\bderiveInvestigationGroups\b/);
  assert.doesNotMatch(source, /\breadInvestigationGroupNode\b/);
  assert.doesNotMatch(source, /investigation-v2/);
});

test('implementation term floor removes canonical terms from the current ordinary v3 Manifest', () => {
  const fixture = createTermFloorFixture();
  try {
    const knownTerm = normalizeInvestigationTerm({
      kind: 'symbol',
      value: 'retainedTerm',
    });
    const delta = deriveImplementationTermDelta({
      repositoryRoot: fixture.repository,
      baselineCommit: fixture.baselineCommit,
      productionPaths: [fixture.productionPath],
      investigation: currentInvestigation({
        kind: 'ordinary',
        replayContract: {
          canonicalTerms: [{ ...knownTerm, provenance: [] }],
        },
      }),
    });

    assert.deepEqual(delta.knownTermIds, [knownTerm.termId]);
    assert.deepEqual(delta.newTerms, []);
  } finally {
    fs.rmSync(fixture.repository, { recursive: true, force: true });
  }
});

test('implementation term floor treats a current v3 exemption as having no known terms', () => {
  const fixture = createTermFloorFixture();
  try {
    const changedTerm = normalizeInvestigationTerm({
      kind: 'symbol',
      value: 'retainedTerm',
    });
    const delta = deriveImplementationTermDelta({
      repositoryRoot: fixture.repository,
      baselineCommit: fixture.baselineCommit,
      productionPaths: [fixture.productionPath],
      investigation: currentInvestigation({ kind: 'exemption' }),
    });

    assert.deepEqual(delta.knownTermIds, []);
    assert.ok(
      delta.newTerms.some(({ termId }) => termId === changedTerm.termId),
    );
    const affected = delta.affectedGroups.filter(
      ({ termId }) => termId === changedTerm.termId,
    );
    assert.equal(affected.length, 1);
    assert.equal(affected[0]!.rootId, 'repository');
    assert.equal(affected[0]!.mutationClass, 'live');
    assert.ok(affected[0]!.hitCount > 0);
    assert.deepEqual(affected[0]!.paths, [fixture.productionPath]);
    assert.match(delta.scanEvidenceDigest, /^[0-9a-f]{64}$/);
  } finally {
    fs.rmSync(fixture.repository, { recursive: true, force: true });
  }
});

function createTermFloorFixture(): {
  repository: string;
  baselineCommit: string;
  productionPath: string;
} {
  const repository = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-term-floor-v3-'),
  );
  git(repository, ['init', '-b', 'main']);
  git(repository, ['config', 'user.email', 'workflow@example.test']);
  git(repository, ['config', 'user.name', 'Workflow Test']);
  const productionPath = 'src/term.ts';
  fs.mkdirSync(path.join(repository, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(repository, productionPath),
    'export const retainedTerm=1;\n',
  );
  git(repository, ['add', productionPath]);
  git(repository, ['commit', '-m', 'Create term-floor fixture']);
  const baselineCommit = git(repository, ['rev-parse', 'HEAD']).trim();
  fs.writeFileSync(
    path.join(repository, productionPath),
    'export const retainedTerm = 1;\n',
  );
  return { repository, baselineCommit, productionPath };
}

function currentInvestigation(
  applicability:
    | {
        kind: 'ordinary';
        replayContract: {
          canonicalTerms: Array<
            ReturnType<typeof normalizeInvestigationTerm> & {
              provenance: never[];
            }
          >;
        };
      }
    | { kind: 'exemption' },
): CurrentInvestigationManifest {
  return {
    manifest: { applicability },
    validation: {
      kind: 'manifest-authority-admissible',
      manifestDigest: 'a'.repeat(64),
      investigationTargetDigest: 'b'.repeat(64),
    },
    currentTreeObservation: {
      kind: 'current-tracked-tree',
      path: 'openspec/changes/example/investigation.json',
      contentDigest: 'c'.repeat(64),
    },
  } as unknown as CurrentInvestigationManifest;
}

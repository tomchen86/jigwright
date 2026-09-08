import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { planningProviderBindingDigest } from '@jigwright/core/planning-provider-binding';
import { createArchiveApplicabilityProjection } from '../src/application/archive/archive-transformation.ts';
import { createOpenSpecPlanningArchiveProjectionPort } from '../src/composition-root/planning-archive-projection-production.ts';
import type { PlanningArchiveProjectionContext } from '../src/modules/planning-provider/planning-archive-projection-port.ts';
import {
  verifyArchiveDeltaOutcomes,
  assertSpecDeltaScenarioPreservation,
} from '../src/runtime/repository-transaction/archive-delta-verifier.ts';
import { git, sourceRepositoryRoot } from './fixture.ts';

test('native OpenSpec validates and archives aliased deltas into one colocated spec without copying planning authority', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'colocated-openspec-'));
  try {
    git(root, ['init', '-b', 'main']);
    git(root, ['config', 'user.name', 'Document test']);
    git(root, ['config', 'user.email', 'documents@example.test']);
    const canonicalPath = 'src/modules/intake/spec.md';
    const changeRoot = 'openspec/changes/colocated-change';
    const original = `# Intake Specification\ncapabilities: [old-intake, old-routing]\n\n## Purpose\nKeep the original owner request wording intact while selecting exactly one route for each request.\n\n## Requirements\n${requirement('Original wording', 'The engine SHALL keep the wording.')}`;
    const deltaOne = `# Wording delta\n\n## MODIFIED Requirements\n${requirement('Original wording', 'The engine SHALL keep the wording byte for byte.')}`;
    const deltaTwo = `# Routing delta\n\n## ADDED Requirements\n${requirement('Route once', 'The engine SHALL route a request once.')}`;
    const artifacts: Record<string, string> = {
      'openspec/config.yaml': 'schema: spec-driven\n',
      [canonicalPath]: original,
      [`${changeRoot}/.openspec.yaml`]:
        'schema: spec-driven\ncreated: 2026-09-08\n',
      [`${changeRoot}/proposal.md`]:
        '# Proposal\n\n## Why\nPreserve requests.\n\n## What Changes\n- Keep and route requests.\n\n## Impact\n- Intake.\n',
      [`${changeRoot}/design.md`]:
        '# Design\n\nOriginal reviewed bytes stay unchanged.\n',
      [`${changeRoot}/tasks.md`]:
        '## Tasks\n\n- [x] 1.1 Keep and route requests\n',
      [`${changeRoot}/specs/old-intake/spec.md`]: deltaOne,
      [`${changeRoot}/specs/old-routing/spec.md`]: deltaTwo,
    };
    for (const [file, content] of Object.entries(artifacts)) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), content);
    }
    git(root, ['add', '-A']);
    git(root, ['commit', '-m', 'Native colocated fixture']);
    const head = git(root, ['rev-parse', 'HEAD']).trim();
    const context: PlanningArchiveProjectionContext = {
      repositoryRoot: sourceRepositoryRoot,
      projectionRoot: fs.realpathSync(root),
      sourceRevision: head,
      changeId: 'colocated-change',
      mode: 'projection',
      planningProvider: {
        source: 'explicit',
        artifactPath: 'workflow/change-providers/colocated-change.json',
        bindingDigest: 'a'.repeat(64),
        binding: {
          schemaVersion: 1,
          changeId: 'colocated-change',
          providerId: 'openspec',
          adapterContractVersion: 1,
          providerRequirement: {
            package: '@fission-ai/openspec',
            version: '1.6.0',
          },
          planningRoot: changeRoot,
        },
      },
    };
    const port = createOpenSpecPlanningArchiveProjectionPort();
    const applicability = createArchiveApplicabilityProjection(
      {
        repositoryRoot: root,
        changeRoot: 'openspec/changes',
        changeId: context.changeId,
        baselineCommit: head,
        sourceCommit: head,
        source: 'worktree',
        activeArtifactPaths: Object.keys(artifacts).filter((p) =>
          p.startsWith(`${changeRoot}/`),
        ),
        planningProvider: {
          ...context.planningProvider,
          bindingDigest: planningProviderBindingDigest(
            context.planningProvider.binding,
          ),
        },
      },
      {
        archiveProjectionPort: {
          ...port,
          inspectArchiveReadiness: (input) =>
            port.inspectArchiveReadiness({
              ...input,
              repositoryRoot: sourceRepositoryRoot,
            }),
          prepareArchive: (input) =>
            port.prepareArchive({
              ...input,
              repositoryRoot: sourceRepositoryRoot,
            }),
          validateProjectedSpecs: (input) =>
            port.validateProjectedSpecs({
              ...input,
              repositoryRoot: sourceRepositoryRoot,
            }),
        },
      },
    );
    assert.deepEqual(Object.keys(applicability.validatedBaseSpecDigests), [
      canonicalPath,
    ]);
    assert.equal(
      fs.readFileSync(path.join(root, canonicalPath), 'utf8'),
      original,
    );
    assert.equal(git(root, ['status', '--porcelain']), '');
    assert.equal(port.validateProjectedSpecs(context).valid, true);
    assert.equal(fs.existsSync(path.join(root, 'openspec/specs')), false);
    const deltaPaths = Object.keys(artifacts).filter((p) =>
      p.includes('/specs/'),
    );
    const preflight = assertSpecDeltaScenarioPreservation(
      root,
      head,
      'openspec/changes',
      'colocated-change',
      deltaPaths,
    );
    assert.deepEqual(Object.keys(preflight.validatedBaseSpecDigests), [
      canonicalPath,
    ]);
    const archive = port.prepareArchive(context);
    assert.deepEqual(archive.totals, {
      added: 1,
      modified: 1,
      removed: 0,
      renamed: 0,
    });
    assert.equal(port.validateProjectedSpecs(context).valid, true);
    assert.equal(fs.existsSync(path.join(root, 'openspec/specs')), false);
    const projected = fs.readFileSync(path.join(root, canonicalPath), 'utf8');
    assert.match(projected, /byte for byte/);
    assert.match(projected, /Requirement: Route once/);
    assert.match(projected, /capabilities: \[old-intake, old-routing\]/);
    for (const [file, content] of Object.entries(artifacts).filter(([p]) =>
      p.startsWith(`${changeRoot}/`),
    )) {
      assert.equal(
        fs.readFileSync(
          path.join(
            root,
            archive.archivePath,
            file.slice(changeRoot.length + 1),
          ),
          'utf8',
        ),
        content,
      );
    }
    git(root, ['add', '-A']);
    const tree = git(root, ['write-tree']).trim();
    assert.deepEqual(
      verifyArchiveDeltaOutcomes(
        root,
        { changeId: 'colocated-change', head },
        { baseSpecPaths: [canonicalPath], tree, totals: archive.totals },
      ).totals,
      archive.totals,
    );
    fs.writeFileSync(
      path.join(root, canonicalPath),
      original.replace('SHALL', 'may'),
    );
    assert.equal(port.validateProjectedSpecs(context).valid, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function requirement(title: string, wording: string): string {
  return `\n### Requirement: ${title}\n\n${wording}\n\n#### Scenario: ${title} is applied\n\n- **WHEN** a request arrives\n- **THEN** the stated behavior occurs\n`;
}

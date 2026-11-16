import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { canonicalJson } from '@jigwright/core/canonical-json';
import { inspectProjectionStatus } from '../src/composition-root/projection-status-production.ts';
import {
  buildInvestigationManifestDraft,
  materializeInvestigationEvidenceView,
} from '../src/composition-root/investigation-production.ts';
import { sealInvestigationManifestDraft } from '../src/modules/investigation/manifest/investigation-manifest.ts';
import { projectInvestigationManifestLedger } from '../src/modules/investigation/domain/investigation-design-ledger.ts';
import { assertPlanningTransitionReport } from '../src/modules/lifecycle/planning-transition-report.ts';
import { validateTaskPolicy } from '../src/modules/planning-provider/guard-policy.ts';
import { spliceProjectionRegion } from '../src/modules/projection/projection-service.ts';
import {
  ordinaryAuthoringState,
  digest,
} from './investigation-manifest-fixture.ts';
import { publishCurrentV3Investigation } from './support/current-contract-fixture.ts';
import { git } from './fixture.ts';
import {
  dependencyOwner,
  readRepositoryDependencies,
} from './support/repository-dependency-graph.ts';

const sourceRoot = path.resolve(import.meta.dirname, '../../..');
const START = '<!-- workflow:investigation-ledger:start v1 -->';
const END = '<!-- workflow:investigation-ledger:end v1 -->';

function requiredArgumentsRemainRequired(): void {
  // @ts-expect-error Guard facts cannot fall back to production authority.
  validateTaskPolicy(
    '1.1',
    { allowedPaths: [], requiredChecks: [] },
    { schemaVersion: 1, checks: {} },
    [],
  );
  // @ts-expect-error Report validation requires its plan-path rule.
  assertPlanningTransitionReport({});
}
void requiredArgumentsRemainRequired;

test('projection engine error adaptation preserves the curated splice API and foreign errors', () => {
  assert.throws(
    () => spliceProjectionRegion('text', { start: -1, end: 2 }, ''),
    {
      name: 'WorkflowError',
      code: 'PROJECTION_INVALID',
      message: 'Invalid projection region offsets.',
    },
  );
  const failure = new Error('caller region failed');
  assert.throws(
    () =>
      spliceProjectionRegion(
        'text',
        {
          get start(): number {
            throw failure;
          },
          end: 2,
        },
        '',
      ),
    (error) => error === failure,
  );
});

test('validation owners no longer import projection and value or type back-edges are rejected', () => {
  const resolver = readRepositoryDependencies(sourceRoot);
  const prefix = 'packages/workflow-engine/src/modules/';
  const projectionOwner = prefix + 'projection';
  for (const relative of [
    'planning-provider/guard-policy.ts',
    'lifecycle/planning-transition-report.ts',
    'assurance/planning-assurance-validator.ts',
    'investigation/domain/investigation-design-ledger.ts',
  ]) {
    const file = path.join(sourceRoot, prefix, relative);
    const check = (additionalSource = '') => {
      const { edges } = resolver.read(file, additionalSource);
      assert.equal(
        edges.some((edge) => dependencyOwner(edge.to) === projectionOwner),
        false,
        relative,
      );
    };
    check();
    const specifier = relative.startsWith('investigation/')
      ? '../../projection/engine-projection-registry.ts'
      : '../projection/engine-projection-registry.ts';
    for (const declaration of [
      `import { projectionDefinitions } from '${specifier}';`,
      `import type { ProjectionDefinition } from '${specifier}';`,
    ])
      assert.throws(() => check('\n' + declaration), assert.AssertionError);
  }
  assert.equal(
    fs.existsSync(
      path.join(
        sourceRoot,
        prefix,
        'projection/investigation-design-projection.ts',
      ),
    ),
    false,
  );
});

test('production WHY status admits ordinary v3 evidence and observes exact metadata without writes', () => {
  const repository = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'projection-ordinary-v3-')),
  );
  try {
    git(repository, ['init', '-b', 'main']);
    git(repository, ['config', 'user.email', 'projection@example.test']);
    git(repository, ['config', 'user.name', 'Projection Test']);
    fs.mkdirSync(path.join(repository, 'src'));
    fs.writeFileSync(
      path.join(repository, 'src/domain.ts'),
      'export const ManifestFirst = "manifest-first";\n',
    );
    git(repository, ['add', '-A']);
    git(repository, ['commit', '-m', 'Create projection fixture']);
    const state = ordinaryAuthoringState(repository);
    if (state.applicabilityKind !== 'ordinary') assert.fail('ordinary state');
    state.ordinary.dispositionDecisions =
      state.ordinary.dispositionDecisions.map((decision) => ({
        ...decision,
        classification: 'load-bearing',
      }));
    const view = materializeInvestigationEvidenceView({
      repositoryRoot: repository,
      authoring: state.ordinary,
    });
    const firstHit = view.grouping.hits[0]!;
    state.ordinary.whyOverlays = [
      {
        overlayId: 'why:projection-source',
        pathIdentity: firstHit.path,
        blobOid: firstHit.sourceObject.objectId,
        contentSha256: firstHit.sourceObject.contentSha256!,
        groupRefs: view.dispositions.map(({ groupRef }) => groupRef),
        anchors: view.grouping.hits.map((hit) => ({
          pathIdentity: hit.path,
          blobOid: hit.sourceObject.objectId,
          byteRange: {
            start: hit.byteOffset,
            end: hit.byteOffset + hit.byteLength,
          },
          termId: hit.termId,
        })),
        why: 'WHY status fixture keeps pinned source meaning.',
        protectedInvariant: 'Both anchors retain their exact pinned bytes.',
        reviewerQuestion:
          'Does the projection preserve this source explanation?',
        answer: 'Yes; both source anchors are represented.',
        semanticAuthor: {
          id: 'owner',
          provenance: 'checkpoint:projection-why',
        },
        readComplete: true,
        semanticAssurance: 'actor-attested-not-engine-verified',
      },
    ];
    const built = buildInvestigationManifestDraft({
      repositoryRoot: repository,
      state,
    });
    if (built.outcome !== 'built') assert.fail(built.blocker.failureCode);
    const sealed = sealInvestigationManifestDraft({
      draft: built.draft,
      approval: {
        semanticAuthor: {
          id: 'owner',
          provenance: 'checkpoint:projection-status',
        },
        approvalProvenanceDigest: digest('projection-status-approval'),
      },
    });
    if (sealed.outcome !== 'sealed') assert.fail(sealed.blocker.failureCode);
    const manifest = sealed.manifest;
    if (manifest.applicability.kind !== 'ordinary')
      assert.fail('ordinary manifest required');
    fs.mkdirSync(path.join(repository, 'workflow'));
    for (const name of ['config.json', 'repository-consumer.json']) {
      fs.copyFileSync(
        path.join(sourceRoot, 'workflow', name),
        path.join(repository, 'workflow', name),
      );
    }
    const configPath = path.join(repository, 'workflow/config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    config.repositoryName = manifest.repositoryId;
    fs.writeFileSync(configPath, `${JSON.stringify(config)}\n`);
    const changeDirectory = path.join(
      repository,
      config.changeRoot,
      manifest.changeId,
    );
    fs.mkdirSync(changeDirectory, { recursive: true });
    const manifestPath = path.join(changeDirectory, 'investigation.json');
    const publication = publishCurrentV3Investigation(repository, manifest);
    assert.equal(publication.outcome, 'published', canonicalJson(publication));
    assert.equal(
      fs.readFileSync(manifestPath, 'utf8'),
      `${canonicalJson(manifest)}\n`,
    );
    const designPath = path.join(changeDirectory, 'design.md');
    const designRelative = path
      .relative(repository, designPath)
      .split(path.sep)
      .join('/');
    const staleRegion = `${START}\r\nstale\r\n${END}`;
    const stale = `😀authored prefix\r\n${staleRegion}\r\n尾`;
    const projected = projectInvestigationManifestLedger(
      stale,
      manifest.applicability.semanticDelta.whyOverlays,
    );
    const expectedRegion = projectInvestigationManifestLedger(
      `${START}\n\n${END}`,
      manifest.applicability.semanticDelta.whyOverlays,
    );
    assert.ok(
      expectedRegion.includes(
        'WHY status fixture keeps pinned source meaning.',
      ),
    );
    assert.ok(expectedRegion.includes('### src/domain.ts'));
    const contentDigest = (value: string) =>
      `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
    const observe = () => {
      const tracked = [
        manifestPath,
        configPath,
        path.join(repository, 'workflow/repository-consumer.json'),
        designPath,
      ];
      const before = tracked.map((file) =>
        fs.existsSync(file) ? fs.readFileSync(file) : undefined,
      );
      const result = inspectProjectionStatus(repository).find(
        (row) => row.id === 'investigation.why-ledger',
      );
      assert.deepEqual(
        tracked.map((file) =>
          fs.existsSync(file) ? fs.readFileSync(file) : undefined,
        ),
        before,
      );
      assert.ok(result);
      return result;
    };
    for (const [content, status, actual] of [
      [projected, 'current', expectedRegion],
      [stale, 'drifted', staleRegion],
    ] as const) {
      fs.writeFileSync(designPath, content);
      const result = observe();
      assert.equal(
        result.state,
        status === 'current' ? 'current' : 'attention',
        JSON.stringify(result),
      );
      assert.deepEqual(result.targets, [
        {
          id: 'investigation.why-ledger',
          path: designRelative,
          state: status,
          version: 1,
          expectedVersion: 1,
          digest: contentDigest(actual),
          expectedDigest: contentDigest(expectedRegion),
        },
      ]);
    }
    fs.rmSync(designPath);
    assert.deepEqual(observe().targets, [
      {
        id: 'investigation.why-ledger',
        path: designRelative,
        state: 'missing',
        version: null,
        expectedVersion: 1,
        digest: null,
        expectedDigest: contentDigest(expectedRegion),
      },
    ]);
    fs.writeFileSync(designPath, '# Missing marker\n');
    const malformed = observe();
    assert.equal(malformed.state, 'error');
    assert.deepEqual(malformed.targets, []);
    assert.equal(
      'error' in malformed ? malformed.error : undefined,
      'Missing investigation-ledger markers.',
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

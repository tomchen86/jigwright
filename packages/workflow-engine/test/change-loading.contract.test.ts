import test from 'node:test';
import {
  createFixtureRepository,
  writeManagedChangeArtifacts,
} from './fixture.ts';
import assert from 'node:assert/strict';
import { loadChangeContract } from '../src/adapters/consumer/repository/work-registry/contracts.ts';
import crypto from 'node:crypto';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import path from 'node:path';
import fs from 'node:fs';
import { deriveInvestigationFirstPlanningSubject } from '../src/modules/assurance/planning-assurance-validator.ts';
import { resumeInvestigationManifestPublication } from '../src/runtime/managed-documents/transaction/investigation-publication.ts';
import os from 'node:os';
import {
  buildCurrentV3Investigation,
  publishCurrentV3Investigation,
  isWorkflowError,
  contractPublicationFixture,
} from './support/current-contract-fixture.ts';

test('change contracts admit a strict v3 Manifest from the observed current tree', () => {
  const repository = createFixtureRepository();
  try {
    const artifacts = writeManagedChangeArtifacts(repository);
    const manifest = buildCurrentV3Investigation(repository);
    assert.equal(
      publishCurrentV3Investigation(repository, manifest).outcome,
      'published',
    );
    const contract = loadChangeContract(repository, 'demo-change');

    assert.equal(contract.schemaName, 'jigwright');
    assert.deepEqual(contract.investigation?.manifest, manifest);
    assert.deepEqual(contract.investigation?.validation, {
      kind: 'manifest-authority-admissible',
      manifestDigest: manifest.manifestDigest,
      investigationTargetDigest:
        manifest.investigationApproval.investigationTargetDigest,
    });
    assert.deepEqual(contract.investigation?.currentTreeObservation, {
      kind: 'current-tracked-tree',
      path: 'openspec/changes/demo-change/investigation.json',
      contentDigest: crypto
        .createHash('sha256')
        .update(`${canonicalJson(manifest)}\n`)
        .digest('hex'),
    });
    assert.deepEqual(contract.execution, artifacts.execution);
    assert.deepEqual(contract.planReview, artifacts.planReview);
    for (const artifact of [
      'investigation.json',
      'execution.json',
      'plan-review.json',
    ]) {
      assert.ok(
        contract.artifactPaths.includes(
          path.join(repository, 'openspec/changes/demo-change', artifact),
        ),
      );
    }
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('the configured current schema owns investigation-first contract semantics', () => {
  const repository = createFixtureRepository();
  try {
    const artifacts = writeManagedChangeArtifacts(repository);
    const manifest = buildCurrentV3Investigation(repository);
    assert.equal(
      publishCurrentV3Investigation(repository, manifest).outcome,
      'published',
    );
    const changeDirectory = path.join(
      repository,
      'openspec/changes/demo-change',
    );
    fs.writeFileSync(
      path.join(changeDirectory, 'origin.json'),
      `${canonicalJson({
        schemaVersion: 1,
        sourceRefs: [],
        workItemRefs: [],
      })}\n`,
    );
    fs.writeFileSync(
      path.join(changeDirectory, 'survey.json'),
      `${canonicalJson({ schemaVersion: 1, consumers: [] })}\n`,
    );
    const consumerPath = path.join(
      repository,
      'workflow/repository-consumer.json',
    );
    const consumer = JSON.parse(fs.readFileSync(consumerPath, 'utf8')) as {
      planning: {
        supportedSchemaNames: string[];
        managedSchemaNames: string[];
        currentSchemaName: string;
      };
    };
    consumer.planning.supportedSchemaNames.push('orbit-spec-v1');
    consumer.planning.managedSchemaNames.push('orbit-spec-v1');
    consumer.planning.currentSchemaName = 'orbit-spec-v1';
    fs.writeFileSync(consumerPath, `${JSON.stringify(consumer, null, 2)}\n`);
    fs.writeFileSync(
      path.join(changeDirectory, '.openspec.yaml'),
      'schema: orbit-spec-v1\ncreated: 2026-07-15\n',
    );

    const contract = loadChangeContract(repository, 'demo-change');
    assert.equal(contract.schemaName, 'orbit-spec-v1');
    assert.deepEqual(contract.investigation?.manifest, manifest);
    assert.deepEqual(contract.execution, artifacts.execution);
    assert.deepEqual(contract.planReview, artifacts.planReview);
    for (const artifact of [
      'investigation.json',
      'execution.json',
      'origin.json',
      'survey.json',
      'plan-review.json',
    ]) {
      assert.equal(
        contract.artifactPaths.includes(path.join(changeDirectory, artifact)),
        true,
        artifact,
      );
    }
    const subject = deriveInvestigationFirstPlanningSubject(
      repository,
      contract,
    );
    assert.equal(subject.target.schemaName, 'orbit-spec-v1');
    assert.equal(
      subject.target.components.some(
        ({ role, path: componentPath }) =>
          role === 'schema-metadata' &&
          componentPath === 'openspec/changes/demo-change/.openspec.yaml',
      ),
      true,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('current change loading rejects a v3 Manifest whose digest no longer replays', () => {
  const repository = createFixtureRepository();
  try {
    writeManagedChangeArtifacts(repository);
    const published = buildCurrentV3Investigation(repository);
    assert.equal(
      publishCurrentV3Investigation(repository, published).outcome,
      'published',
    );
    const manifest = structuredClone(published);
    manifest.manifestDigest = 'f'.repeat(64);
    fs.writeFileSync(
      path.join(repository, 'openspec/changes/demo-change/investigation.json'),
      `${canonicalJson(manifest)}\n`,
    );

    assert.throws(
      () => loadChangeContract(repository, 'demo-change'),
      (error) => isWorkflowError(error, 'RECONSTRUCTION_MISMATCH'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('current change loading rejects tracked revision bytes until private current-ref recovery completes', () => {
  const repository = createFixtureRepository();
  try {
    writeManagedChangeArtifacts(repository);
    const first = buildCurrentV3Investigation(repository, 'demo-change', 3);
    assert.equal(
      publishCurrentV3Investigation(repository, first).outcome,
      'published',
    );
    assert.equal(
      loadChangeContract(repository, 'demo-change').investigation?.manifest
        .manifestDigest,
      first.manifestDigest,
    );

    const second = buildCurrentV3Investigation(repository, 'demo-change', 4);
    const interrupted = publishCurrentV3Investigation(
      repository,
      second,
      (phase) => {
        if (phase === 'manifest-installed') {
          throw new Error('simulated tracked revision crash');
        }
      },
    );
    assert.equal(interrupted.outcome, 'blocked');
    if (interrupted.outcome === 'blocked') {
      assert.equal(
        interrupted.blocker.failureCode,
        'PUBLICATION_RECOVERY_REQUIRED',
      );
    }
    assert.throws(
      () => loadChangeContract(repository, 'demo-change'),
      (error) => isWorkflowError(error, 'REVIEW_TARGET_STALE'),
    );

    const publication = contractPublicationFixture(repository, second);
    const resumed = resumeInvestigationManifestPublication({
      repositoryRoot: repository,
      privateRoot: publication.privateRoot,
      paths: publication.paths,
      lifecycle: publication.lifecycle,
      withTransitionLock: (operation) => operation(publication.expected),
    });
    assert.equal(resumed.outcome, 'published');
    assert.equal(
      loadChangeContract(repository, 'demo-change').investigation?.manifest
        .manifestDigest,
      second.manifestDigest,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('current change loading resolves its private ref from a linked-worktree git-common root', () => {
  const repository = createFixtureRepository();
  const privateStorage = fs.mkdtempSync(
    path.join(os.tmpdir(), 'contracts-current-v3-private-'),
  );
  try {
    writeManagedChangeArtifacts(repository);
    const privateRoot = path.join(privateStorage, 'git-common');
    fs.renameSync(path.join(repository, '.git'), privateRoot);
    fs.writeFileSync(path.join(repository, '.git'), `gitdir: ${privateRoot}\n`);
    const manifest = buildCurrentV3Investigation(repository);
    assert.equal(
      publishCurrentV3Investigation(repository, manifest).outcome,
      'published',
    );
    assert.equal(
      loadChangeContract(repository, 'demo-change').investigation?.manifest
        .manifestDigest,
      manifest.manifestDigest,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(privateStorage, { recursive: true, force: true });
  }
});

test('raw change loading rejects final and ancestor metadata symlink escapes', () => {
  for (const escape of ['metadata', 'change-directory'] as const) {
    const repository = createFixtureRepository();
    const outside = fs.mkdtempSync(
      path.join(os.tmpdir(), 'workflow-metadata-outside-'),
    );
    try {
      const changeDirectory = path.join(
        repository,
        'openspec/changes/demo-change',
      );
      if (escape === 'metadata') {
        const metadataPath = path.join(changeDirectory, '.openspec.yaml');
        const outsideMetadata = path.join(outside, '.openspec.yaml');
        fs.writeFileSync(
          outsideMetadata,
          'schema: expense-app\ncreated: 2026-07-15\n',
        );
        fs.rmSync(metadataPath);
        fs.symlinkSync(outsideMetadata, metadataPath);
      } else {
        const outsideChange = path.join(outside, 'demo-change');
        fs.renameSync(changeDirectory, outsideChange);
        fs.symlinkSync(outsideChange, changeDirectory, 'dir');
      }
      assert.throws(
        () => loadChangeContract(repository, 'demo-change'),
        (error) => isWorkflowError(error, 'OPENSPEC_CHANGE_TREE_UNSAFE'),
        escape,
      );
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  }
});

test('raw change loading rejects the reserved archive container', () => {
  const repository = createFixtureRepository();
  try {
    assert.throws(
      () => loadChangeContract(repository, 'archive'),
      (error) => isWorkflowError(error, 'PLANNING_CHANGE_ID_RESERVED'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

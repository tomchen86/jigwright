import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  readEvidenceNode,
  writeEvidenceNode,
} from '../src/runtime/storage-journal/evidence-object-store.ts';
import { canonicalEvidenceNodeEnvelope } from '../src/foundation/evidence-node/evidence-node.ts';
import { discoverRepository } from '../src/runtime/repository-transaction/git.ts';
import { investigationRuntimePaths } from '../src/runtime/paths/runtime-paths.ts';
import { createFixtureRepository, isWorkflowError } from './fixture.ts';
import {
  createCrashPublicationEvidenceNode,
  runEvidenceObjectCrashChild,
  listEvidenceObjectCrashAliases,
} from './investigation-session-fixture.ts';

test('evidence object publication recovers exact crash aliases without exposing partial finals', () => {
  const repository = createFixtureRepository();
  try {
    const repositoryState = discoverRepository(repository);
    const paths = investigationRuntimePaths(
      repositoryState.gitCommonDirectory,
      'workflow-engine',
    );
    for (const phase of [
      'during-temp-write',
      'before-link',
      'after-link',
    ] as const) {
      const node = createCrashPublicationEvidenceNode(phase);
      const objectPath = path.join(
        paths.objects,
        node.nodeId.slice(0, 2),
        `${node.nodeId}.json`,
      );
      const child = runEvidenceObjectCrashChild(
        repository,
        repositoryState.gitCommonDirectory,
        node,
        objectPath,
        phase,
      );
      assert.equal(
        child.signal,
        'SIGKILL',
        String(child.stderr || child.stdout),
      );
      const aliases = listEvidenceObjectCrashAliases(objectPath);
      assert.equal(aliases.length, 1);
      if (phase !== 'after-link') {
        assert.equal(fs.existsSync(objectPath), false);
        assert.equal(fs.lstatSync(aliases[0]!).nlink, 1);
      } else {
        assert.equal(
          fs.readFileSync(objectPath, 'utf8'),
          canonicalEvidenceNodeEnvelope(node),
        );
        assert.equal(fs.lstatSync(objectPath).nlink, 2);
        assert.equal(fs.lstatSync(aliases[0]!).nlink, 2);
      }

      assert.equal(writeEvidenceNode(paths, node), node.nodeId);
      assert.deepEqual(readEvidenceNode(paths, node.nodeId), node);
      assert.equal(fs.lstatSync(objectPath).nlink, 1);
      assert.deepEqual(listEvidenceObjectCrashAliases(objectPath), []);
    }

    const divergentNode = createCrashPublicationEvidenceNode('divergent');
    const divergentPath = path.join(
      paths.objects,
      divergentNode.nodeId.slice(0, 2),
      `${divergentNode.nodeId}.json`,
    );
    fs.mkdirSync(path.dirname(divergentPath), {
      recursive: true,
      mode: 0o700,
    });
    fs.chmodSync(path.dirname(divergentPath), 0o700);
    fs.writeFileSync(divergentPath, '{"divergent":true}', { mode: 0o600 });
    assert.throws(
      () => writeEvidenceNode(paths, divergentNode),
      (error: unknown) => isWorkflowError(error, 'EVIDENCE_OBJECT_COLLISION'),
    );
    assert.equal(fs.readFileSync(divergentPath, 'utf8'), '{"divergent":true}');
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('evidence object publication rejects a strict-prefix final without altering bytes', () => {
  const repository = createFixtureRepository();
  try {
    const repositoryState = discoverRepository(repository);
    const paths = investigationRuntimePaths(
      repositoryState.gitCommonDirectory,
      'workflow-engine',
    );
    const node = createCrashPublicationEvidenceNode(
      'retired-strict-prefix-final',
    );
    const content = Buffer.from(canonicalEvidenceNodeEnvelope(node), 'utf8');
    const objectPath = path.join(
      paths.objects,
      node.nodeId.slice(0, 2),
      `${node.nodeId}.json`,
    );
    fs.mkdirSync(path.dirname(objectPath), {
      recursive: true,
      mode: 0o700,
    });
    fs.chmodSync(path.dirname(objectPath), 0o700);
    const prefix = content.subarray(0, Math.floor(content.byteLength / 2));
    fs.writeFileSync(objectPath, prefix, { mode: 0o600 });

    assert.throws(
      () => writeEvidenceNode(paths, node),
      (error: unknown) => isWorkflowError(error, 'EVIDENCE_OBJECT_COLLISION'),
    );
    assert.deepEqual(fs.readFileSync(objectPath), prefix);
    assert.deepEqual(listEvidenceObjectCrashAliases(objectPath), []);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

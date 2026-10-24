import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BUILT_IN_ENGINE_CLOSURE_MANIFEST_DIGEST } from '../bootstrap/built-in-engine-closure-pin.ts';
import { maintainerGrantExecutionServices } from '../bootstrap/maintainer-authority-production.ts';
import type { GitState } from '../src/modules/repository-consumer/repository-git-state.ts';
import { setupFixedRunnerFixture } from './fixed-runner-fixture.ts';
import { git } from './fixture.ts';

const repository: GitState = {
  repositoryRoot: '/repo',
  repositoryRealPath: '/real/repo',
  gitCommonDirectory: '/common/git',
  branch: 'work/change-a',
  head: 'a'.repeat(40),
  tree: 'b'.repeat(40),
  statusEntries: [],
};

test('candidate dependency identity stays fixed to the package with consumer selection state', () => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'fixed-engine-identity-')),
  );
  try {
    const stateRoot = path.join(
      root,
      'workflow-engine',
      'intervention-control',
    );
    fs.mkdirSync(stateRoot, { recursive: true });
    const supervisor = path.join(stateRoot, 'control-plane-supervisor.json');
    fs.writeFileSync(
      supervisor,
      '{"candidate":"must not select the running engine"}\n',
    );
    assert.equal(
      maintainerGrantExecutionServices.resolveCandidateHarnessEngineDigest(
        { ...repository, gitCommonDirectory: root, repositoryRealPath: root },
        'consumer-repository',
        { WORKFLOW_LOCAL_ENGINE_RESUME_BINDING: 'retired binding' },
      ),
      BUILT_IN_ENGINE_CLOSURE_MANIFEST_DIGEST.slice('sha256:'.length),
    );
    assert.equal(
      fs.readFileSync(supervisor, 'utf8'),
      '{"candidate":"must not select the running engine"}\n',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('candidate dependency snapshots use the package identity without probing an inert retired consumer state', async () => {
  const scratch = fs.mkdtempSync(
    path.join(os.tmpdir(), 'fixed-engine-snapshot-'),
  );
  const marker = path.join(scratch, 'candidate-executed');
  const fixture = await setupFixedRunnerFixture({
    candidateExecutableFactory: (closureDigest) =>
      Buffer.from(`#!/usr/bin/env node
import('node:fs').then(({ appendFileSync }) => {
appendFileSync(${JSON.stringify(marker)}, process.argv.slice(2).join(' ') + '\\n');
const probe = process.argv[2] === '--control-plane-restart-probe';
process.stdout.write(JSON.stringify(probe
  ? {kind:'control-plane-restart.v1',ready:true,closureDigest:${JSON.stringify(closureDigest)}}
  : {kind:'control-plane-self-test.v1',healthy:true,closureDigest:${JSON.stringify(closureDigest)}}) + '\\n');
});
`),
  });
  try {
    const positiveControl = spawnSync(
      process.execPath,
      [
        fixture.retiredSelection.activeArtifact.executablePath,
        '--control-plane-self-test',
      ],
      { encoding: 'utf8' },
    );
    assert.equal(positiveControl.status, 0, positiveControl.stderr);
    assert.equal(fixture.retiredUpdate.transaction.state, 'FINALIZED');
    assert.ok(
      fs.readFileSync(marker, 'utf8').includes('--control-plane-self-test'),
    );
    fs.unlinkSync(marker);
    const supervisorPath = path.join(
      fixture.stateRoot,
      'control-plane-supervisor.json',
    );
    const before = fs.readFileSync(supervisorPath);
    const head = git(fixture.repository, ['rev-parse', 'HEAD']).trim();
    const policy = git(fixture.repository, [
      'show',
      `${head}:workflow/maintainer-policy.json`,
    ]);
    const snapshot =
      maintainerGrantExecutionServices.currentCandidateDependencySnapshot({
        cwd: fixture.repository,
        repositoryId: JSON.parse(policy).repository.id,
        candidateTree: git(fixture.repository, [
          'rev-parse',
          'HEAD^{tree}',
        ]).trim(),
        baseCommit: head,
        policyDigest: crypto.createHash('sha256').update(policy).digest('hex'),
        checks: [],
      });
    assert.equal(
      snapshot.harnessEngineDigest,
      BUILT_IN_ENGINE_CLOSURE_MANIFEST_DIGEST.slice('sha256:'.length),
    );
    assert.notEqual(
      snapshot.harnessEngineDigest,
      fixture.retiredSelection.activeArtifact.closureDigest.slice(
        'sha256:'.length,
      ),
    );
    assert.equal(fs.existsSync(marker), false);
    assert.deepEqual(fs.readFileSync(supervisorPath), before);
    assert.equal(git(fixture.repository, ['rev-parse', 'HEAD']).trim(), head);
  } finally {
    fixture.cleanup();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

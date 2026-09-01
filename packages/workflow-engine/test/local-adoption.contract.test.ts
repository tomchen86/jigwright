import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  runCurrentJigwrightAdoption,
  verifyCurrentJigwrightAdoptionComparisonV1,
  type CurrentJigwrightAdoptionComparisonV1,
} from '../../../scripts/run-current-jigwright-adoption.ts';

test('current-v3 source and installed facts have a recomputable tamper verifier', () => {
  const comparison = currentComparisonFixture();
  assert.equal(
    verifyCurrentJigwrightAdoptionComparisonV1(comparison).factsDigest,
    comparison.factsDigest,
  );

  const tamperCases: readonly Readonly<{
    name: string;
    mutate(value: any): void;
  }>[] = [
    {
      name: 'payload drift',
      mutate(value) {
        value.source.commands.guide.payload.guide.kind = 'tampered';
      },
    },
    {
      name: 'error drift',
      mutate(value) {
        value.source.init.repeated.payload.error.code = 'TAMPERED';
      },
    },
    {
      name: 'current facts drift',
      mutate(value) {
        value.source.manifestV3.negativeCode = 'TAMPERED';
      },
    },
    {
      name: 'vector drift',
      mutate(value) {
        value.bindings.vectors.fileDigest = sha256('tampered-vector');
      },
    },
    {
      name: 'routed effect drift',
      mutate(value) {
        value.source.routedEffects.requestedGrantTransitions = 1;
      },
    },
    {
      name: 'state fingerprint drift',
      mutate(value) {
        value.source.state.after.refs = sha256('tampered-refs');
      },
    },
  ];
  for (const { name, mutate } of tamperCases) {
    const tampered = structuredClone(comparison);
    mutate(tampered);
    assert.throws(
      () => verifyCurrentJigwrightAdoptionComparisonV1(tampered),
      /comparison is invalid/u,
      name,
    );
  }
});

test('the public adoption command is current-only and preserves the workspace rehearsal', () => {
  const workspaceManifest = JSON.parse(
    fs.readFileSync(path.resolve('package.json'), 'utf8'),
  ) as { scripts: Record<string, string> };

  assert.equal(
    workspaceManifest.scripts['jigwright:adopt-local'],
    'node --experimental-strip-types scripts/run-current-jigwright-adoption.ts',
  );
});

test('one exact Jigwright tarball bootstraps a fresh current-only consumer', () => {
  const adoptionRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-current-adoption-'),
  );
  try {
    const report = runCurrentJigwrightAdoption(process.cwd(), adoptionRoot, {
      allowDirty: true,
    });

    assert.equal(report.schemaVersion, 1);
    assert.equal(report.kind, 'jigwright-current-local-adoption-report.v1');
    assert.deepEqual(
      {
        kind: report.release.kind,
        name: report.release.name,
        version: report.release.version,
      },
      {
        kind: 'jigwright-single-package.v1',
        name: 'jigwright',
        version: '0.1.0',
      },
    );
    assert.match(report.release.digest, /^sha256:[a-f0-9]{64}$/u);
    assert.deepEqual(report.install.publicPackageIdentities, ['jigwright']);
    assert.equal(report.install.networkPolicy, 'offline-exact-local-tarball');
    assert.equal(report.install.lifecycleScriptsDenied, true);
    assert.equal(report.install.lockfileVerified, true);
    assert.equal(report.install.lockfile.path, 'package-lock.json');
    assert.match(report.install.lockfile.digest, /^sha256:[a-f0-9]{64}$/u);
    assert.match(report.install.lockfile.integrity, /^sha512-/u);
    assert.equal(report.install.lockfile.integrityVerified, true);
    assert.deepEqual(report.install.package, {
      name: 'jigwright',
      version: '0.1.0',
      digest: report.release.digest,
    });

    assert.equal(report.bootstrap.init.kind, 'jigwright-init-result.v1');
    assert.equal(report.bootstrap.init.status, 'initialized');
    assert.equal(
      report.bootstrap.repeatedInit.errorClass,
      'JIGWRIGHT_INIT_ALREADY_CONFIGURED',
    );
    assert.equal(report.bootstrap.policyUnchanged, true);
    assert.equal(report.bootstrap.guide, 'workflow-command-guide.v1');
    assert.deepEqual(report.publicSurfaces, {
      manifestV3: true,
      planReview: true,
      centralGrant: true,
    });
    assert.deepEqual(report.currentOnly, {
      historicalRuntimeState: 'unsupported',
      dualRun: 'retired',
      rollback: 'revert-consumer-cutover-commit',
    });
    assert.deepEqual(report.operationalGates, {
      implementation: 'implementation-ready',
      realPilot: 'real-pilot-pending',
      fullGate: 'full-gate-pending',
    });
    assert.equal('parity' in report, false);
    assert.equal('downgrade' in report, false);
    assert.equal(report.consumer.clean, true);
    assert.match(report.consumer.commit, /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);
    assert.match(report.consumer.tree, /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);
    assert.deepEqual(report.consumer.history.cutover, {
      commit: report.consumer.commit,
      tree: report.consumer.tree,
    });
    assert.notEqual(
      report.consumer.history.baseline.commit,
      report.consumer.history.dependency.commit,
    );
    assert.notEqual(
      report.consumer.history.dependency.commit,
      report.consumer.history.cutover.commit,
    );
    assert.deepEqual(report.consumer.rollback.revertedCommits, [
      report.consumer.history.cutover.commit,
      report.consumer.history.dependency.commit,
    ]);
    assert.equal(
      report.consumer.rollback.tree,
      report.consumer.history.baseline.tree,
    );
    assert.equal(report.consumer.rollback.baselineTreeMatched, true);
    assert.equal(report.comparison.exact, true);
    assert.equal(
      report.comparison.bindings.releaseDigest,
      report.release.digest,
    );
    assert.deepEqual(report.comparison.bindings.source, {
      commit: report.release.source.commit,
      tree: report.release.source.tree,
    });
    assert.deepEqual(report.comparison.bindings.consumer, {
      commit: report.consumer.commit,
      tree: report.consumer.tree,
    });
    assert.deepEqual(report.comparison.source, report.comparison.installed);
    assert.equal(report.comparison.source.state.unchanged, true);
    assert.deepEqual(report.comparison.source.routedEffects, {
      scope: 'selected-current-v3-read-only-probes',
      requestedGrantTransitions: 0,
      humanGateCommands: 0,
      externalEffectCommands: 0,
      observedStateMutation: 0,
    });
    assert.equal(report.comparison.source.manifestV3.readerOutcome, 'verified');
    assert.equal(
      report.comparison.source.manifestV3.negativeOutcome,
      'blocked',
    );
    assert.equal(report.comparison.source.centralGrant.recordState, 'pending');
  } finally {
    fs.rmSync(adoptionRoot, { recursive: true, force: true });
  }
});

function currentComparisonFixture(): CurrentJigwrightAdoptionComparisonV1 {
  const command = (
    payload: Record<string, unknown>,
    exitCode = 0,
    stream: 'stdout' | 'stderr' = 'stdout',
  ) => ({ exitCode, stream, payload, payloadDigest: digestJson(payload) });
  const state = {
    refs: sha256('refs'),
    tracked: sha256('tracked'),
    privateRuntime: sha256('private-runtime'),
  };
  const facts = {
    init: {
      fresh: command({
        ok: true,
        result: {
          kind: 'jigwright-init-result.v1',
          status: 'initialized',
          path: 'workflow/jigwright-profile.json',
          digest: sha256('profile'),
        },
      }),
      repeated: command(
        {
          ok: false,
          error: {
            code: 'JIGWRIGHT_INIT_ALREADY_CONFIGURED',
            message: 'Jigwright init never rewrites policy.',
          },
        },
        12,
        'stderr',
      ),
      profileDigest: sha256('profile'),
    },
    commands: {
      guide: command({
        command: 'guide',
        ok: true,
        guide: { kind: 'workflow-command-guide.v1' },
      }),
      doctor: command({ command: 'doctor', ok: true }),
      status: command({ command: 'status', ok: true, sessions: [] }),
      jobList: command({
        command: 'job',
        action: 'list',
        ok: true,
        jobs: [],
      }),
    },
    manifestV3: {
      schemaVersion: 3,
      kind: 'manifest-first-investigation',
      writerOutcome: 'sealed',
      readerOutcome: 'verified',
      manifestDigest: 'a'.repeat(64),
      investigationTargetDigest: 'b'.repeat(64),
      negativeOutcome: 'blocked',
      negativeCode: 'RECONSTRUCTION_MISMATCH',
    },
    centralGrant: {
      policySchemaVersion: 2,
      policyDigest: sha256('policy'),
      recordKind: 'grant-record.v1',
      recordState: 'pending',
      challengeDigest: sha256('challenge'),
      recordDigest: sha256('record'),
      publicReadKind: 'grant-record.v1',
    },
    state: { before: state, after: state, unchanged: true },
    routedEffects: {
      scope: 'selected-current-v3-read-only-probes',
      requestedGrantTransitions: 0,
      humanGateCommands: 0,
      externalEffectCommands: 0,
      observedStateMutation: 0,
    },
  } as const;
  const bindings = {
    releaseDigest: sha256('release'),
    source: { commit: '1'.repeat(40), tree: '2'.repeat(40) },
    consumer: { commit: '3'.repeat(40), tree: '4'.repeat(40) },
    vectors: {
      path: 'facts/workflow-conformance-v2.json',
      fileDigest: sha256('vectors'),
      vectorSetDigest: sha256('vector-set'),
    },
  } as const;
  return {
    schemaVersion: 1,
    kind: 'jigwright-current-v3-source-installed-comparison.v1',
    bindings,
    source: facts,
    installed: facts,
    factsDigest: digestJson({ bindings, source: facts, installed: facts }),
    exact: true,
  };
}

function digestJson(value: unknown): `sha256:${string}` {
  return sha256(canonicalJson(value));
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string'
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  throw new Error('non-JSON fixture');
}

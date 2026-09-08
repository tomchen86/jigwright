import test from 'node:test';
import {
  setupFinalizedControlPlanePromotionFixture,
  CONTROL_PLANE_FIXTURE_REPOSITORY_ID,
} from './control-plane-promotion-fixture.ts';
import assert from 'node:assert/strict';
import { resolveControlPlaneEngineSelection } from '../bootstrap/control-plane-trust.ts';
import path from 'node:path';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import fs from 'node:fs';
import { git } from './fixture.ts';
import {
  readJsonRecord,
  recordField,
  recordDigest,
  digest,
  writeJsonRecord,
  errorCode,
} from './control-plane-supervisor-selection-fixture.ts';

test('finalized current selection remains durable after its admission grant expired', async () => {
  const fixture = await setupFinalizedControlPlanePromotionFixture();
  try {
    assert.equal(
      Date.parse(fixture.record.envelope.payload.expiresAt) < Date.now(),
      true,
    );
    const selected = resolveControlPlaneEngineSelection(
      fixture.stateRoot,
      CONTROL_PLANE_FIXTURE_REPOSITORY_ID,
    );
    assert.equal(
      selected?.activeArtifact.artifactId,
      fixture.candidateArtifact.artifactId,
    );
  } finally {
    fixture.cleanup();
  }
});

test('finalized current selection rejects fully redigested but untrusted review and grant signatures', async () => {
  const fixture = await setupFinalizedControlPlanePromotionFixture();
  try {
    const bundlePath = onlyPrivateJsonFile(
      path.join(fixture.stateRoot, 'control-plane-promotion-bundles'),
    );
    const bundle = readJsonRecord(bundlePath);
    const reviewEnvelope = recordField(bundle, 'independentReviewAttestation');
    reviewEnvelope.signature = 'structurally-valid-untrusted-review-signature';
    bundle.bundleDigest = recordDigest(bundle, 'bundleDigest');

    const updatePath = onlyPrivateJsonFile(
      path.join(fixture.stateRoot, 'control-updates'),
    );
    const update = readJsonRecord(updatePath);
    const envelope = recordField(update, 'envelope');
    const payload = recordField(envelope, 'payload');
    payload.independentReviewAttestationDigest = digest(
      canonicalJson(reviewEnvelope),
    );
    payload.promotionBundleDigest = bundle.bundleDigest;
    envelope.signature = 'structurally-valid-untrusted-grant-signature';
    update.recordDigest = recordDigest(update, 'recordDigest');

    writeJsonRecord(bundlePath, bundle);
    writeJsonRecord(updatePath, update);
    assertTerminalSelectionRejected(fixture.stateRoot);
  } finally {
    fixture.cleanup();
  }
});

test('current promotion rejects forged supervisor generations and additional authority-update inventory', async () => {
  const forgedGeneration = await setupFinalizedControlPlanePromotionFixture();
  try {
    const supervisorPath = path.join(
      forgedGeneration.stateRoot,
      'control-plane-supervisor.json',
    );
    const supervisor = readJsonRecord(supervisorPath);
    supervisor.generation = 999;
    supervisor.recordDigest = recordDigest(supervisor, 'recordDigest');
    writeJsonRecord(supervisorPath, supervisor);
    assertTerminalSelectionRejected(forgedGeneration.stateRoot);
  } finally {
    forgedGeneration.cleanup();
  }

  const additionalUpdate = await setupFinalizedControlPlanePromotionFixture();
  try {
    const updateDirectory = path.join(
      additionalUpdate.stateRoot,
      'control-updates',
    );
    const updatePath = onlyPrivateJsonFile(updateDirectory);
    fs.copyFileSync(
      updatePath,
      path.join(updateDirectory, `${'f'.repeat(64)}.json`),
    );
    fs.chmodSync(path.join(updateDirectory, `${'f'.repeat(64)}.json`), 0o600);
    assertTerminalSelectionRejected(additionalUpdate.stateRoot);
  } finally {
    additionalUpdate.cleanup();
  }
});

test('finalized current selection rejects nonterminal history and unsafe private candidate storage', async () => {
  const nonterminal = await setupFinalizedControlPlanePromotionFixture();
  try {
    const updatePath = onlyPrivateJsonFile(
      path.join(nonterminal.stateRoot, 'control-updates'),
    );
    const update = readJsonRecord(updatePath);
    const transaction = recordField(update, 'transaction');
    const history = transaction.history;
    const observations = update.observations;
    assert.equal(Array.isArray(history), true);
    assert.equal(Array.isArray(observations), true);
    transaction.state = 'SELF_TESTED';
    transaction.history = (history as unknown[]).slice(0, -1);
    transaction.journalDigest = recordDigest(transaction, 'journalDigest');
    update.observations = (observations as unknown[]).slice(0, -1);
    const lastHistory = (transaction.history as unknown[]).at(-1);
    assert.equal(
      typeof lastHistory === 'object' &&
        lastHistory !== null &&
        !Array.isArray(lastHistory),
      true,
    );
    const lastHistoryAt = (lastHistory as Record<string, unknown>).at;
    assert.equal(typeof lastHistoryAt, 'string');
    update.updatedAt = lastHistoryAt;
    update.recordDigest = recordDigest(update, 'recordDigest');
    writeJsonRecord(updatePath, update);
    assertTerminalSelectionRejected(nonterminal.stateRoot);
  } finally {
    nonterminal.cleanup();
  }

  const unsafeCandidate = await setupFinalizedControlPlanePromotionFixture();
  try {
    const gitCommonDirectory = fs.realpathSync(
      git(unsafeCandidate.repository, [
        'rev-parse',
        '--path-format=absolute',
        '--git-common-dir',
      ]).trim(),
    );
    const candidatePath = path.join(
      gitCommonDirectory,
      'workflow-engine',
      'candidates',
      `${unsafeCandidate.frozen.candidateBundleDigest}.json`,
    );
    const original = fs.readFileSync(candidatePath);

    fs.chmodSync(candidatePath, 0o644);
    assertTerminalSelectionRejected(unsafeCandidate.stateRoot);
    fs.chmodSync(candidatePath, 0o600);
    assertTerminalSelectionAccepted(unsafeCandidate.stateRoot);

    const parsed = JSON.parse(original.toString('utf8')) as unknown;
    fs.writeFileSync(candidatePath, `${JSON.stringify(parsed, null, 2)}\n`, {
      mode: 0o600,
    });
    assertTerminalSelectionRejected(unsafeCandidate.stateRoot);
    fs.writeFileSync(candidatePath, original, { mode: 0o600 });
    assertTerminalSelectionAccepted(unsafeCandidate.stateRoot);

    const aliasPath = `${candidatePath}.alias`;
    fs.linkSync(candidatePath, aliasPath);
    assertTerminalSelectionRejected(unsafeCandidate.stateRoot);
    fs.unlinkSync(aliasPath);
    assertTerminalSelectionAccepted(unsafeCandidate.stateRoot);

    const savedPath = `${candidatePath}.saved`;
    fs.renameSync(candidatePath, savedPath);
    fs.symlinkSync(savedPath, candidatePath);
    assertTerminalSelectionRejected(unsafeCandidate.stateRoot);
    fs.unlinkSync(candidatePath);
    fs.renameSync(savedPath, candidatePath);
    assertTerminalSelectionAccepted(unsafeCandidate.stateRoot);
  } finally {
    unsafeCandidate.cleanup();
  }
});

function assertTerminalSelectionAccepted(stateRoot: string): void {
  assert.notEqual(
    resolveControlPlaneEngineSelection(
      stateRoot,
      CONTROL_PLANE_FIXTURE_REPOSITORY_ID,
    ),
    null,
  );
}

function assertTerminalSelectionRejected(stateRoot: string): void {
  assert.throws(
    () =>
      resolveControlPlaneEngineSelection(
        stateRoot,
        CONTROL_PLANE_FIXTURE_REPOSITORY_ID,
      ),
    (error) => errorCode(error) === 'CONTROL_PLANE_SUPERVISOR_NOT_TERMINAL',
  );
}

function onlyPrivateJsonFile(directory: string): string {
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.isFile(), true);
  assert.equal(entries[0]?.isSymbolicLink(), false);
  assert.match(entries[0]?.name ?? '', /^[0-9a-f]{64}\.json$/);
  return path.join(directory, entries[0]!.name);
}

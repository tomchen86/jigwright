import { preflightMaintainerGrantV2 } from '../bootstrap/maintainer-authority-production.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as maintainerGrant from '../src/modules/authority/maintainer-grant-contracts.ts';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { sourceRepositoryRoot, isWorkflowError, git } from './fixture.ts';
import * as maintainerGrantV2 from '../src/modules/authority/maintainer-grant-v2.ts';
import {
  canonicalMaintainerGrantV2Payload,
  canonicalMaintainerGrantV2Envelope,
  parseMaintainerGrantV2Envelope,
  type MaintainerGrantV2Envelope,
  MAINTAINER_GRANT_V2_SIGNATURE_NAMESPACE,
} from '../src/modules/authority/maintainer-grant-v2-codec.ts';
import {
  issueMaintainerGrantV2,
  validateMaintainerGrantV2AuthorityBinding,
} from '../bootstrap/maintainer-authority-production.ts';
import {
  inspectMaintainerGrants,
  reserveMaintainerGrant,
  terminallyRevokeMaintainerReservation,
  maintainerGrantStorePaths,
} from '../src/runtime/storage-journal/maintainer-store.ts';
import { validateCiAuthorityCommit } from '../src/composition-root/ci-replay-production.ts';
import { type MaintainerSignerProvider } from '../src/adapters/signing/ssh/maintainer-signer.ts';
import { startAuthoritySession } from '../bootstrap/maintainer-authority-production.ts';
import { parseMaintainerPolicy } from '../src/modules/authority/maintainer-policy.ts';
import { spawnSync } from 'node:child_process';
import {
  prepareCandidate,
  freezeIssuableCandidate,
  GRANT_ID,
  fakeSigner,
  PROFILE_ID,
  type RetiredV1GrantEnvelopeFixture,
  FAKE_SIGNATURE,
  retiredV1GrantEnvelopeBytes,
} from './support/maintainer-grant-v2-fixture.ts';

test('retired V1 Apply Grant exports are absent from the current authority surface', () => {
  for (const exportName of [
    'canonicalGrantEnvelope',
    'canonicalGrantPayload',
    'parseMaintainerGrantEnvelope',
    'validateGrantPayload',
    'assertGrantPathsEligible',
  ]) {
    assert.equal(exportName in maintainerGrant, false, exportName);
  }
  const authoritySource = fs.readFileSync(
    path.join(
      sourceRepositoryRoot,
      'packages/workflow-engine/src/modules/authority/maintainer-grant-contracts.ts',
    ),
    'utf8',
  );
  for (const retiredType of [
    'MaintainerGrantPayload',
    'MaintainerGrantEnvelope',
    'GrantValidationOptions',
  ]) {
    assert.doesNotMatch(
      authoritySource,
      new RegExp(`\\b${retiredType}\\b`, 'u'),
      retiredType,
    );
  }
});

test('current V2 authority has no post-cutoff discriminator or persisted-field fallback', () => {
  assert.equal(
    'isMaintainerGrantV2Envelope' in maintainerGrantV2,
    false,
    'isMaintainerGrantV2Envelope',
  );

  for (const relativePath of [
    'packages/workflow-engine/src/application/control-plane/maintainer-approve.ts',
    'packages/workflow-engine/src/application/control-plane/maintainer-recovery.ts',
    'packages/workflow-engine/src/application/control-plane/maintainer-session.ts',
    'packages/workflow-engine/src/runtime/repository-validation/commit-replay/ci-authority.ts',
  ]) {
    const source = fs.readFileSync(
      path.join(sourceRepositoryRoot, relativePath),
      'utf8',
    );
    assert.doesNotMatch(
      source,
      /\bisMaintainerGrantV2Envelope\b/u,
      relativePath,
    );
    assert.doesNotMatch(
      source,
      /\bpayload\.evidenceWaivers\s*\?\?\s*\[\]/u,
      relativePath,
    );
  }

  const sessionSource = fs.readFileSync(
    path.join(
      sourceRepositoryRoot,
      'packages/workflow-engine/src/application/control-plane/maintainer-session.ts',
    ),
    'utf8',
  );
  assert.doesNotMatch(
    sessionSource,
    /\benvelope\.payload\.candidateBundleDigest\s*\?\?\s*null/u,
  );
});

test('v2 issue signs every binding and stores a canonical one-shot grant', () => {
  const repository = prepareCandidate();
  const linkedParent = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'v2-common-grant-')),
  );
  const linked = path.join(linkedParent, 'linked');
  const preparedSigned: string[] = [];
  const signed: string[] = [];
  try {
    const prepared = freezeIssuableCandidate(repository, preparedSigned);
    const result = issueMaintainerGrantV2(
      repository,
      {
        changeId: 'demo-change',
        reason: 'Apply the exact workflow-engine candidate',
        manifest: prepared.manifest,
        checksAttestation: prepared.checksAttestation!,
        candidateBundle: prepared.candidateBundle!,
      },
      {
        now: new Date('2026-08-03T09:00:00.000Z'),
        grantId: GRANT_ID,
        signer: fakeSigner(signed),
      },
    );

    assert.equal(result.envelope.payload.version, 2);
    assert.equal(
      result.publishCommand,
      `git push git@github.com:example/fixture.git ${result.tagRef}:${result.tagRef}`,
    );
    assert.equal(result.envelope.payload.profile, PROFILE_ID);
    assert.equal(
      result.envelope.payload.patchDigest,
      prepared.manifest.patchDigest,
    );
    assert.equal(
      result.envelope.payload.manifestDigest,
      prepared.manifestDigest,
    );
    assert.deepEqual(
      result.envelope.payload.allowedPaths,
      prepared.manifest.files.map((file) => file.path),
    );
    assert.deepEqual(
      result.envelope.payload.evidenceOverlay,
      prepared.evidenceOverlay,
    );
    assert.deepEqual(result.envelope.payload.requiredChecks, ['fixture']);
    assert.equal(result.envelope.payload.maxUses, 1);
    assert.equal(
      Date.parse(result.envelope.payload.expiresAt) -
        Date.parse(result.envelope.payload.issuedAt),
      7 * 24 * 60 * 60_000,
    );
    assert.equal(
      signed[0],
      canonicalMaintainerGrantV2Payload(result.envelope.payload),
    );

    const canonical = canonicalMaintainerGrantV2Envelope(result.envelope);
    assert.deepEqual(
      parseMaintainerGrantV2Envelope(canonical),
      result.envelope,
    );
    const namespaceLess = JSON.parse(canonical) as Record<string, unknown>;
    delete namespaceLess.signatureNamespace;
    assert.throws(
      () =>
        parseMaintainerGrantV2Envelope(`${JSON.stringify(namespaceLess)}\n`),
      (error) => isWorkflowError(error, 'MAINTAINER_GRANT_INVALID'),
    );
    assert.equal(fs.readFileSync(result.availableTokenPath, 'utf8'), canonical);
    assert.equal(
      git(repository, ['rev-parse', '--verify', result.tagRef]).trim().length,
      40,
    );

    const tampered = JSON.parse(canonical) as MaintainerGrantV2Envelope;
    tampered.payload.patchDigest = 'f'.repeat(64);
    assert.throws(
      () => parseMaintainerGrantV2Envelope(`${JSON.stringify(tampered)}\n`),
      (error) => isWorkflowError(error, 'MAINTAINER_GRANT_INVALID'),
    );

    git(repository, ['worktree', 'add', '--detach', linked, 'HEAD']);
    const common = fs.realpathSync(path.join(repository, '.git'));
    const linkedCommon = fs.realpathSync(
      git(linked, ['rev-parse', '--git-common-dir']).trim(),
    );
    assert.equal(linkedCommon, common);
    const store = maintainerGrantStorePaths(common);
    assert.equal(
      result.availableTokenPath,
      path.join(store.available, `${GRANT_ID}.json`),
    );
    const before = git(repository, [
      'status',
      '--porcelain=v1',
      '--ignored=matching',
    ]);
    const reservation = reserveMaintainerGrant(linkedCommon, GRANT_ID, {
      repositoryRoot: linked,
      sessionId: 'first-authority-reservation',
      now: new Date('2026-08-03T09:01:00.000Z'),
    });
    assert.equal(reservation.state, 'reserved');
    assert.throws(
      () =>
        reserveMaintainerGrant(common, GRANT_ID, {
          repositoryRoot: repository,
          sessionId: 'second-authority-reservation',
          now: new Date('2026-08-03T09:01:00.000Z'),
        }),
      (error) => isWorkflowError(error, 'ACTIVE_AUTHORITY_CONFLICT'),
    );
    assert.equal(fs.existsSync(result.availableTokenPath), false);
    const reservedPath = path.join(store.reserved, `${GRANT_ID}.json`);
    assert.equal(fs.statSync(reservedPath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(store.reserved).mode & 0o777, 0o700);
    assert.equal(
      inspectMaintainerGrants(common, GRANT_ID)[0]?.reservationSessionId,
      reservation.sessionId,
    );
    assert.equal(
      terminallyRevokeMaintainerReservation(
        linkedCommon,
        GRANT_ID,
        reservation.sessionId,
        'Close the shared-store reservation fixture',
        new Date('2026-08-03T09:02:00.000Z'),
      ).state,
      'revoked',
    );
    assert.equal(fs.existsSync(reservedPath), false);
    assert.equal(
      fs.statSync(path.join(store.terminal, `${GRANT_ID}.json`)).mode & 0o777,
      0o600,
    );
    assert.equal(fs.statSync(store.terminal).mode & 0o777, 0o700);
    assert.equal(
      inspectMaintainerGrants(common, GRANT_ID)[0]?.state,
      'revoked',
    );
    assert.equal(
      git(repository, ['status', '--porcelain=v1', '--ignored=matching']),
      before,
    );
    assert.equal(
      git(linked, ['status', '--porcelain=v1', '--ignored=matching']).trim(),
      '',
    );
  } finally {
    if (fs.existsSync(linked)) git(repository, ['worktree', 'remove', linked]);
    fs.rmSync(linkedParent, { recursive: true, force: true });
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('durable signed V1 grant records fail closed without rewriting bytes', () => {
  const repository = prepareCandidate();
  const preparedSigned: string[] = [];
  const signed: string[] = [];
  const legacyGrantId = '77777777-7777-4777-8777-777777777777';
  try {
    const prepared = freezeIssuableCandidate(repository, preparedSigned);
    const issued = issueMaintainerGrantV2(
      repository,
      {
        changeId: 'demo-change',
        reason: 'Issue current grant only to construct a valid retired record',
        manifest: prepared.manifest,
        checksAttestation: prepared.checksAttestation!,
        candidateBundle: prepared.candidateBundle!,
      },
      {
        now: new Date('2026-08-03T09:00:00.000Z'),
        grantId: GRANT_ID,
        signer: fakeSigner(signed),
      },
    );
    const legacy: RetiredV1GrantEnvelopeFixture = {
      payload: {
        version: 1,
        grantId: legacyGrantId,
        repositoryId: issued.envelope.payload.repositoryId,
        repositoryOrigin: issued.envelope.payload.repositoryOrigin,
        baseCommit: issued.envelope.payload.baseCommit,
        policyBlob: issued.envelope.payload.policyBlob,
        changeId: issued.envelope.payload.changeId,
        allowedPaths: issued.envelope.payload.allowedPaths,
        issuedAt: issued.envelope.payload.issuedAt,
        expiresAt: issued.envelope.payload.expiresAt,
        maxUses: 1,
        reason: issued.envelope.payload.reason,
        signer: issued.envelope.payload.signer,
      },
      signature: FAKE_SIGNATURE,
    };
    const gitCommonDirectory = fs.realpathSync(path.join(repository, '.git'));
    const legacyPath = path.join(
      gitCommonDirectory,
      'workflow-engine/maintainer-grants/available',
      `${legacyGrantId}.json`,
    );
    fs.writeFileSync(legacyPath, retiredV1GrantEnvelopeBytes(legacy), {
      mode: 0o600,
    });
    const before = fs.readFileSync(legacyPath, 'utf8');
    assert.throws(
      () => inspectMaintainerGrants(gitCommonDirectory, legacyGrantId),
      (error) => isWorkflowError(error, 'MAINTAINER_GRANT_INVALID'),
    );
    assert.equal(fs.readFileSync(legacyPath, 'utf8'), before);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('CI rejects the retired V1 authority commit branch before reading Git state', () => {
  const legacyAuthorityCommit = {
    hash: 'a'.repeat(40),
    subject: 'Retired authority transition',
    parents: ['b'.repeat(40)],
    trailers: {
      kind: 'authority',
      changeId: 'demo-change',
      grantId: GRANT_ID,
    },
  } as Parameters<typeof validateCiAuthorityCommit>[1];
  assert.throws(
    () =>
      validateCiAuthorityCommit(
        '/current-only-v1-authority-rejection',
        legacyAuthorityCommit,
      ),
    (error) => isWorkflowError(error, 'CI_AUTHORITY_COMMIT_INVALID'),
  );
});

test('v2 issue rejects a candidate-less request before touching the signer', () => {
  const repository = prepareCandidate();
  const signed: string[] = [];
  let signerTouched = false;
  const signer: MaintainerSignerProvider = {
    assertHumanPresent() {
      signerTouched = true;
    },
    identity() {
      signerTouched = true;
      return 'fixture-maintainer';
    },
    sign() {
      signerTouched = true;
      return FAKE_SIGNATURE;
    },
    verify() {
      signerTouched = true;
    },
  };
  try {
    const preflight = preflightMaintainerGrantV2(repository, {
      profileId: PROFILE_ID,
    });
    assert.throws(
      () =>
        issueMaintainerGrantV2(
          repository,
          {
            changeId: 'demo-change',
            reason: 'Reject candidate-less ordinary v2 grant issuance',
            manifest: preflight.manifest,
          },
          {
            now: new Date('2026-08-03T09:00:00.000Z'),
            grantId: GRANT_ID,
            signer,
          },
        ),
      (error) => isWorkflowError(error, 'APPLY_CANDIDATE_REQUIRED'),
    );
    assert.equal(signerTouched, false);
    assert.deepEqual(signed, []);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('v2 issue rejects a frozen candidate without its exact checks before touching the signer', () => {
  const repository = prepareCandidate();
  const preparedSigned: string[] = [];
  let signerTouched = false;
  const signer: MaintainerSignerProvider = {
    assertHumanPresent() {
      signerTouched = true;
    },
    identity() {
      signerTouched = true;
      return 'fixture-maintainer';
    },
    sign() {
      signerTouched = true;
      return FAKE_SIGNATURE;
    },
    verify() {
      signerTouched = true;
    },
  };
  try {
    const prepared = freezeIssuableCandidate(repository, preparedSigned);
    assert.throws(
      () =>
        issueMaintainerGrantV2(
          repository,
          {
            changeId: 'demo-change',
            reason: 'Reject a candidate without its exact checks attestation',
            manifest: prepared.manifest,
            candidateBundle: prepared.candidateBundle!,
          },
          {
            now: new Date('2026-08-03T09:01:00.000Z'),
            grantId: GRANT_ID,
            signer,
          },
        ),
      (error) => isWorkflowError(error, 'APPLY_CANDIDATE_REQUIRED'),
    );
    assert.equal(signerTouched, false);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('v2 issue rejects checks that are not the candidate exact attestation before touching the signer', () => {
  const repository = prepareCandidate();
  const preparedSigned: string[] = [];
  let signerTouched = false;
  const signer: MaintainerSignerProvider = {
    assertHumanPresent() {
      signerTouched = true;
    },
    identity() {
      signerTouched = true;
      return 'fixture-maintainer';
    },
    sign() {
      signerTouched = true;
      return FAKE_SIGNATURE;
    },
    verify() {
      signerTouched = true;
    },
  };
  try {
    const prepared = freezeIssuableCandidate(repository, preparedSigned);
    const mismatchedChecks = structuredClone(prepared.checksAttestation!);
    mismatchedChecks.checks[0]!.evidence.runnerDigest = 'f'.repeat(64);
    assert.throws(
      () =>
        issueMaintainerGrantV2(
          repository,
          {
            changeId: 'demo-change',
            reason: 'Reject checks that differ from the frozen candidate',
            manifest: prepared.manifest,
            checksAttestation: mismatchedChecks,
            candidateBundle: prepared.candidateBundle!,
          },
          {
            now: new Date('2026-08-03T09:01:00.000Z'),
            grantId: GRANT_ID,
            signer,
          },
        ),
      (error) => isWorkflowError(error, 'MAINTAINER_GRANT_INVALID'),
    );
    assert.equal(signerTouched, false);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('persisted candidate-less v2 fails closed in parsing and authority start', () => {
  const repository = prepareCandidate();
  const preparedSigned: string[] = [];
  let signerTouched = false;
  const candidateLessGrantId = '66666666-6666-4666-8666-666666666666';
  try {
    const prepared = freezeIssuableCandidate(repository, preparedSigned);
    const candidateLessEnvelope: MaintainerGrantV2Envelope = {
      payload: {
        ...structuredClone(prepared),
        grantId: candidateLessGrantId,
        candidateBundle: null,
        candidateBundleDigest: null,
      },
      signatureNamespace: MAINTAINER_GRANT_V2_SIGNATURE_NAMESPACE,
      signature: FAKE_SIGNATURE,
    };
    const canonical = canonicalMaintainerGrantV2Envelope(candidateLessEnvelope);
    assert.throws(
      () => parseMaintainerGrantV2Envelope(canonical),
      (error) => isWorkflowError(error, 'MAINTAINER_GRANT_INVALID'),
    );

    const availablePath = path.join(
      fs.realpathSync(path.join(repository, '.git')),
      'workflow-engine/maintainer-grants/available',
      `${candidateLessGrantId}.json`,
    );
    fs.writeFileSync(availablePath, canonical, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    const signer: MaintainerSignerProvider = {
      assertHumanPresent() {
        signerTouched = true;
      },
      identity() {
        signerTouched = true;
        return 'fixture-maintainer';
      },
      sign() {
        signerTouched = true;
        return FAKE_SIGNATURE;
      },
      verify() {
        signerTouched = true;
      },
    };
    assert.throws(
      () =>
        startAuthoritySession(repository, 'demo-change', candidateLessGrantId, {
          now: new Date('2026-08-03T09:01:00.000Z'),
          signer,
          allowSignedV2Candidate: true,
        }),
      (error) => isWorkflowError(error, 'MAINTAINER_GRANT_INVALID'),
    );
    assert.equal(signerTouched, false);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('authority start rejects a candidate whose frozen supporting artifacts were deleted', () => {
  const repository = prepareCandidate();
  const preparedSigned: string[] = [];
  const signed: string[] = [];
  const signer = fakeSigner(signed);
  try {
    const prepared = freezeIssuableCandidate(repository, preparedSigned);
    const grant = issueMaintainerGrantV2(
      repository,
      {
        changeId: 'demo-change',
        reason: 'Bind admission to every frozen candidate supporting object',
        manifest: prepared.manifest,
        checksAttestation: prepared.checksAttestation!,
        candidateBundle: prepared.candidateBundle!,
      },
      {
        now: new Date('2026-08-03T09:01:00.000Z'),
        grantId: GRANT_ID,
        signer,
      },
    );
    fs.unlinkSync(
      path.join(
        fs.realpathSync(path.join(repository, '.git')),
        'workflow-engine/candidate-artifacts',
        `${prepared.candidateBundle!.effectsManifestDigest}.json`,
      ),
    );

    assert.throws(
      () =>
        startAuthoritySession(repository, 'demo-change', grant.grantId, {
          now: new Date('2026-08-03T09:02:00.000Z'),
          signer,
          allowSignedV2Candidate: true,
        }),
      (error) => isWorkflowError(error, 'APPLY_CANDIDATE_STORE_INVALID'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('v2 issue rejects candidate drift after preflight before requesting a signature', () => {
  const repository = prepareCandidate();
  const preparedSigned: string[] = [];
  const signed: string[] = [];
  try {
    const prepared = freezeIssuableCandidate(repository, preparedSigned);
    fs.writeFileSync(
      path.join(repository, 'packages/workflow-engine/src/limits.ts'),
      'export const LIMIT = 3;\n',
    );
    assert.throws(
      () =>
        issueMaintainerGrantV2(
          repository,
          {
            changeId: 'demo-change',
            reason: 'Apply the exact workflow-engine candidate',
            manifest: prepared.manifest,
            checksAttestation: prepared.checksAttestation!,
            candidateBundle: prepared.candidateBundle!,
          },
          {
            now: new Date('2026-08-03T09:00:00.000Z'),
            grantId: GRANT_ID,
            signer: fakeSigner(signed),
          },
        ),
      (error) => isWorkflowError(error, 'MAINTAINER_PATCH_DRIFT'),
    );
    assert.deepEqual(signed, []);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('v2 admission verifies signature before evaluating expiry', () => {
  const repository = prepareCandidate();
  const preparedSigned: string[] = [];
  const signed: string[] = [];
  let verified = false;
  try {
    const prepared = freezeIssuableCandidate(repository, preparedSigned);
    const grant = issueMaintainerGrantV2(
      repository,
      {
        changeId: 'demo-change',
        reason: 'Bind validation order to signature before time admission',
        manifest: prepared.manifest,
        checksAttestation: prepared.checksAttestation!,
        candidateBundle: prepared.candidateBundle!,
        ttlMinutes: 1,
      },
      {
        now: new Date('2026-08-03T09:00:00.000Z'),
        grantId: GRANT_ID,
        signer: fakeSigner(signed),
      },
    );
    const policy = parseMaintainerPolicy(
      JSON.parse(
        fs.readFileSync(
          path.join(repository, 'workflow/maintainer-policy.json'),
          'utf8',
        ),
      ),
    );
    const rejectingSigner: MaintainerSignerProvider = {
      assertHumanPresent() {},
      identity: () => 'fixture-maintainer',
      sign: () => {
        throw new Error('not used');
      },
      verify: () => {
        verified = true;
        throw new Error('invalid signature');
      },
    };
    assert.throws(
      () =>
        validateMaintainerGrantV2AuthorityBinding(
          repository,
          grant.envelope,
          policy,
          {
            now: new Date('2026-08-03T09:02:00.000Z'),
            expectedBase: grant.envelope.payload.baseCommit,
            expectedPolicyBlob: git(repository, [
              'rev-parse',
              `${grant.envelope.payload.baseCommit}:workflow/maintainer-policy.json`,
            ]).trim(),
            signer: rejectingSigner,
          },
        ),
      (error) => isWorkflowError(error, 'AUTHORITY_SIGNATURE_INVALID'),
    );
    assert.equal(verified, true);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('v2 preflight CLI exposes the manifest without signing or writing grant state', () => {
  const repository = prepareCandidate();
  const cli = path.join(
    sourceRepositoryRoot,
    'packages/workflow-engine/bootstrap/workflow-engine-host.ts',
  );
  try {
    const result = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        cli,
        'maintainer',
        'grant',
        'preflight',
        '--profile',
        PROFILE_ID,
        '--json',
      ],
      { cwd: repository, encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout) as {
      ok: boolean;
      action: string;
      result: { grantable: boolean; manifest: { profile: string } };
    };
    assert.equal(output.ok, true);
    assert.equal(output.action, 'grant-preflight');
    assert.equal(output.result.grantable, true);
    assert.equal(output.result.manifest.profile, PROFILE_ID);
    assert.equal(
      fs.existsSync(
        path.join(repository, '.git/workflow-engine/maintainer-grants'),
      ),
      false,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

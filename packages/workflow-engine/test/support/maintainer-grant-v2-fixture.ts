import {
  type AuthoritySession,
  abortAuthoritySession,
} from '../../src/application/control-plane/maintainer-session.ts';
import {
  approveAndApplyMaintainerGrantV2 as approveAndApplyMaintainerGrantV2Production,
  reissueAndApplyMaintainerGrantV2 as reissueAndApplyMaintainerGrantV2Production,
} from '../../src/application/control-plane/maintainer-approve.ts';
import { commitAuthoritySession as commitAuthoritySessionProduction } from '../../src/application/control-plane/maintainer-commit.ts';
import { recoverAuthorityCommit as recoverAuthorityCommitProduction } from '../../src/application/control-plane/maintainer-recovery.ts';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import {
  git,
  createFixtureRepository,
  writeReadyV3ExemptChange,
} from '../fixture.ts';
import {
  computeProtectedCapabilityEntryDigests,
  REQUIRED_PROTECTED_CAPABILITIES,
} from '../../src/adapters/consumer/repository/work-registry/protected-capabilities.ts';
import { commitPlanningTransition } from '../../src/application/propose/planning-transition.ts';
import { authorizeTaskMandate } from '../../src/modules/authority/task-mandate.ts';
import { type CandidateChecksAttestationV3 } from '../../src/modules/authority/maintainer-candidate.ts';
import { type MaintainerSignerProvider } from '../../src/adapters/signing/ssh/maintainer-signer.ts';
import { parseMaintainerPolicy } from '../../src/modules/authority/maintainer-policy.ts';
import os from 'node:os';
import {
  MAINTAINER_GRANT_V2_SIGNATURE_NAMESPACE,
  type MaintainerGrantV2Payload,
} from '../../src/modules/authority/maintainer-grant-v2.ts';
import { AUTHORITY_APPLICATION_RECEIPT_SIGNATURE_NAMESPACE } from '../../src/modules/authority/authority-application-receipt.ts';
import { inspectMaintainerGrants } from '../../src/runtime/storage-journal/maintainer-store.ts';

export const PROFILE_ID = 'workflow-engine-bootstrap';

export const ROOT_PROFILE_ID = 'workflow-engine-root-one-shot';

export const TASK_ID = 'demo-task';

export const GRANT_ID = '33333333-3333-4333-8333-333333333333';

export const FAKE_SIGNATURE = [
  '-----BEGIN SSH SIGNATURE-----',
  'ZmFrZQ==',
  '-----END SSH SIGNATURE-----',
  '',
].join('\n');

type IsExact<T, Expected> = [T] extends [Expected]
  ? [Expected] extends [T]
    ? true
    : false
  : false;

export const AUTHORITY_SESSION_GRANT_VERSION_IS_EXACT_V2: IsExact<
  AuthoritySession['grantVersion'],
  2
> = true;

export type RetiredV1GrantEnvelopeFixture = Readonly<{
  payload: Readonly<{
    version: 1;
    grantId: string;
    repositoryId: string;
    repositoryOrigin: string;
    baseCommit: string;
    policyBlob: string;
    changeId: string;
    allowedPaths: readonly string[];
    issuedAt: string;
    expiresAt: string;
    maxUses: 1;
    reason: string;
    signer: string;
  }>;
  signature: string;
}>;

export function retiredV1GrantEnvelopeBytes(
  envelope: RetiredV1GrantEnvelopeFixture,
): string {
  return `${JSON.stringify(envelope)}\n`;
}

const temporaryAuditRoots = new Set<string>();

const STABLE_POST_APPROVAL_TEST_BUDGET = Object.freeze({
  monotonicNow: () => 0,
});

export function approveAndApplyMaintainerGrantV2(
  cwd: Parameters<typeof approveAndApplyMaintainerGrantV2Production>[0],
  request: Parameters<typeof approveAndApplyMaintainerGrantV2Production>[1],
  options: NonNullable<
    Parameters<typeof approveAndApplyMaintainerGrantV2Production>[2]
  > = {},
) {
  return approveAndApplyMaintainerGrantV2Production(cwd, request, {
    testPostApprovalBudget: STABLE_POST_APPROVAL_TEST_BUDGET,
    ...options,
  });
}

export function reissueAndApplyMaintainerGrantV2(
  cwd: Parameters<typeof reissueAndApplyMaintainerGrantV2Production>[0],
  request: Parameters<typeof reissueAndApplyMaintainerGrantV2Production>[1],
  options: NonNullable<
    Parameters<typeof reissueAndApplyMaintainerGrantV2Production>[2]
  > = {},
) {
  return reissueAndApplyMaintainerGrantV2Production(cwd, request, {
    testPostApprovalBudget: STABLE_POST_APPROVAL_TEST_BUDGET,
    ...options,
  });
}

export function commitAuthoritySession(
  cwd: Parameters<typeof commitAuthoritySessionProduction>[0],
  requestedSessionId: Parameters<typeof commitAuthoritySessionProduction>[1],
  subject: Parameters<typeof commitAuthoritySessionProduction>[2],
  options: NonNullable<
    Parameters<typeof commitAuthoritySessionProduction>[3]
  > = {},
) {
  return commitAuthoritySessionProduction(cwd, requestedSessionId, subject, {
    testPostApprovalBudget: STABLE_POST_APPROVAL_TEST_BUDGET,
    ...options,
  });
}

export function recoverAuthorityCommit(
  cwd: Parameters<typeof recoverAuthorityCommitProduction>[0],
  requestedSessionId: Parameters<typeof recoverAuthorityCommitProduction>[1],
  now: Parameters<typeof recoverAuthorityCommitProduction>[2],
  options: NonNullable<
    Parameters<typeof recoverAuthorityCommitProduction>[3]
  > = {},
) {
  return recoverAuthorityCommitProduction(cwd, requestedSessionId, now, {
    testPostApprovalBudget: STABLE_POST_APPROVAL_TEST_BUDGET,
    ...options,
  });
}

export function externalAuditRoot(repository: string): string {
  const root = `${fs.realpathSync(repository)}.external-authority-audit`;
  temporaryAuditRoots.add(root);
  return root;
}

export function snapshotPrivateTree(root: string): ReadonlyArray<{
  relativePath: string;
  mode: number;
  bytes: string;
}> {
  const snapshot: Array<{
    relativePath: string;
    mode: number;
    bytes: string;
  }> = [];
  const visit = (directory: string): void => {
    for (const entry of fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
        continue;
      }
      const stats = fs.lstatSync(entryPath);
      snapshot.push({
        relativePath: path.relative(root, entryPath),
        mode: stats.mode,
        bytes: fs.readFileSync(entryPath).toString('base64'),
      });
    }
  };
  visit(root);
  return snapshot;
}

test.after(() => {
  for (const root of temporaryAuditRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function installV2TrustBase(repository: string): void {
  const signingKey = path.join(repository, '.git/workflow-test-signing-key');
  const generated = spawnSync(
    '/usr/bin/ssh-keygen',
    ['-q', '-t', 'ed25519', '-N', '', '-f', signingKey],
    { encoding: 'utf8' },
  );
  assert.equal(generated.status, 0, generated.stderr);
  const publicKey = fs
    .readFileSync(`${signingKey}.pub`, 'utf8')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .join(' ');
  const fingerprintResult = spawnSync(
    '/usr/bin/ssh-keygen',
    ['-l', '-E', 'sha256', '-f', `${signingKey}.pub`],
    { encoding: 'utf8' },
  );
  assert.equal(fingerprintResult.status, 0, fingerprintResult.stderr);
  const fingerprint = fingerprintResult.stdout.match(
    /SHA256:[A-Za-z0-9+/]+/,
  )?.[0];
  assert.ok(fingerprint);
  git(repository, ['config', 'gpg.format', 'ssh']);
  git(repository, ['config', 'user.signingkey', signingKey]);

  const policy = {
    schemaVersion: 1,
    repository: {
      id: 'github:R_fixture',
      origin: 'https://github.com/example/fixture.git',
    },
    phase: 'bootstrap',
    auditTagPrefix: 'refs/tags/workflow-grant/',
    signatureNamespace: 'workflow.maintainer-grant.v1',
    maxTtlMinutes: 30,
    maxUses: 1,
    bootstrapEligiblePaths: [
      'packages/workflow-engine/src/**',
      'workflow/checks.json',
    ],
    sealedImmutablePaths: [],
    requiredChecks: ['fixture'],
    trustedSigners: [
      {
        identity: 'fixture-maintainer',
        publicKey,
        fingerprint,
      },
    ],
  };
  const profiles = {
    schemaVersion: 1,
    profiles: {
      [PROFILE_ID]: {
        id: PROFILE_ID,
        version: 1,
        authorityClass: 'ordinary',
        implementationPaths: ['packages/workflow-engine/src/**'],
        evidencePaths: ['packages/workflow-engine/test/**'],
        policyPaths: ['workflow/**'],
        verificationInfrastructurePaths: ['.github/workflows/**'],
        forbiddenPaths: [
          'packages/workflow-engine/src/modules/authority/maintainer-grant.ts',
        ],
        constraints: {
          evidenceOnlyGrantForbidden: true,
          samePackageRequired: true,
          evidenceAdditionsAllowed: true,
          maximumFiles: 12,
        },
        requiredChecks: ['fixture'],
        checkDependencies: {
          fixture: ['harness-engine', 'runner', 'source-tree'],
        },
      },
      [ROOT_PROFILE_ID]: {
        id: ROOT_PROFILE_ID,
        version: 1,
        authorityClass: 'root-one-shot',
        implementationPaths: ['packages/workflow-engine/src/**'],
        evidencePaths: ['packages/workflow-engine/test/**'],
        policyPaths: ['workflow/**'],
        verificationInfrastructurePaths: ['.github/workflows/**'],
        forbiddenPaths: [
          'packages/workflow-engine/src/modules/authority/maintainer-grant.ts',
        ],
        constraints: {
          evidenceOnlyGrantForbidden: true,
          samePackageRequired: true,
          evidenceAdditionsAllowed: true,
          maximumFiles: 12,
        },
        requiredChecks: ['fixture'],
        checkDependencies: {
          fixture: ['harness-engine', 'runner', 'source-tree'],
        },
      },
    },
  };
  fs.mkdirSync(path.join(repository, 'packages/workflow-engine/src'), {
    recursive: true,
  });
  fs.mkdirSync(
    path.join(repository, 'packages/workflow-engine/src/modules/authority'),
    { recursive: true },
  );
  fs.mkdirSync(
    path.join(
      repository,
      'packages/workflow-engine/src/adapters/consumer/repository/work-registry',
    ),
    { recursive: true },
  );
  fs.mkdirSync(path.join(repository, 'packages/workflow-engine/test'), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(repository, 'packages/workflow-engine/src/limits.ts'),
    'export const LIMIT = 1;\n',
  );
  fs.writeFileSync(
    path.join(
      repository,
      'packages/workflow-engine/src/modules/authority/execution-governance.ts',
    ),
    'export const GRANT_LIMIT = 1;\n',
  );
  fs.writeFileSync(
    path.join(
      repository,
      'packages/workflow-engine/src/adapters/consumer/repository/work-registry/protected-capabilities.ts',
    ),
    'export const PROTECTED_CAPABILITY_LOADER = true;\n',
  );
  fs.writeFileSync(
    path.join(repository, 'packages/workflow-engine/test/limits.test.ts'),
    'export const EXPECTED = 1;\n',
  );
  fs.writeFileSync(
    path.join(repository, 'workflow/maintainer-policy.json'),
    `${JSON.stringify(policy, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(repository, 'workflow/maintainer-profiles.json'),
    `${JSON.stringify(profiles, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(repository, 'scripts/pass.mjs'),
    [
      "import fs from 'node:fs';",
      "if (fs.existsSync('.git/v2-force-check-failure')) process.exit(1);",
      "fs.writeFileSync('.git/v2-check-passed', 'passed');",
      '',
    ].join('\n'),
  );
  git(repository, [
    'remote',
    'add',
    'origin',
    'https://github.com/example/fixture.git',
  ]);
  git(repository, ['add', '.']);
  git(repository, ['commit', '-m', 'Install maintainer v2 trust base files']);

  const contentBase = git(repository, ['rev-parse', 'HEAD']).trim();
  const entrypoints = [
    'packages/workflow-engine/src/modules/authority/execution-governance.ts',
  ];
  const dependencies = [
    'packages/workflow-engine/src/adapters/consumer/repository/work-registry/protected-capabilities.ts',
    'workflow/protected-capabilities.json',
  ];
  const closure = computeProtectedCapabilityEntryDigests(
    repository,
    contentBase,
    { entrypoints, dependencies },
  );
  const protectedCapabilities = {
    kind: 'protected-capability-manifest.v1',
    schemaVersion: 1,
    manifestPath: 'workflow/protected-capabilities.json',
    entries: REQUIRED_PROTECTED_CAPABILITIES.map((capability) => ({
      capability,
      entrypoints,
      dependencies,
      ...closure,
    })),
  };
  fs.writeFileSync(
    path.join(repository, 'workflow/protected-capabilities.json'),
    `${JSON.stringify(protectedCapabilities, null, 2)}\n`,
  );
  git(repository, ['add', 'workflow/protected-capabilities.json']);
  git(repository, ['commit', '-m', 'Install typed capability closure']);
}

export function prepareCandidate(): string {
  const repository = createFixtureRepository();
  installV2TrustBase(repository);
  git(repository, ['checkout', '-b', 'work/demo-change']);
  writeReadyV3ExemptChange(repository, 'demo-change');
  commitPlanningTransition(repository, 'demo-change');
  authorizeTaskMandate(
    repository,
    {
      changeId: 'demo-change',
      taskId: TASK_ID,
      intent: 'Prepare and apply the exact demo change candidate safely.',
      providerCalls: {},
    },
    {
      now: new Date('2026-08-03T08:55:00.000Z'),
      signer: fixtureV2SshSigner(repository),
      externalAuditRoot: externalAuditRoot(repository),
    },
  );
  fs.writeFileSync(
    path.join(repository, 'packages/workflow-engine/src/limits.ts'),
    'export const LIMIT = 2;\n',
  );
  fs.writeFileSync(
    path.join(repository, 'packages/workflow-engine/test/limits.test.ts'),
    'export const EXPECTED = 2;\n',
  );
  return repository;
}

export function afterEvidenceExpires(
  attestation: CandidateChecksAttestationV3,
): Date {
  const expiries = attestation.checks.flatMap(({ completedAt, maxAgeMs }) =>
    maxAgeMs === null ? [] : [Date.parse(completedAt) + maxAgeMs],
  );
  assert.ok(expiries.length > 0, 'evidence has no expiring check to observe');
  return new Date(Math.max(...expiries) + 60_000);
}

function prepareTwoCheckCandidate(): string {
  const repository = createFixtureRepository();
  installV2TrustBase(repository);
  git(repository, ['checkout', '-b', 'work/demo-change']);

  const checksPath = path.join(repository, 'workflow/checks.json');
  const checks = JSON.parse(fs.readFileSync(checksPath, 'utf8')) as {
    checks: Record<string, { command: string[]; destructiveDatabase: boolean }>;
  };
  checks.checks = {
    fixture: {
      command: ['node', 'scripts/check-one.mjs'],
      destructiveDatabase: false,
    },
    'fixture-two': {
      command: ['node', 'scripts/check-two.mjs'],
      destructiveDatabase: false,
    },
  };
  fs.writeFileSync(checksPath, `${JSON.stringify(checks, null, 2)}\n`);
  for (const [name, marker] of [
    ['check-one.mjs', 'check-one-count'],
    ['check-two.mjs', 'check-two-count'],
  ] as const) {
    fs.writeFileSync(
      path.join(repository, 'scripts', name),
      [
        "import fs from 'node:fs';",
        `const marker = new URL('../.git/${marker}', import.meta.url);`,
        "const count = fs.existsSync(marker) ? Number(fs.readFileSync(marker, 'utf8')) : 0;",
        'fs.writeFileSync(marker, String(count + 1));',
        '',
      ].join('\n'),
    );
  }
  const policyPath = path.join(repository, 'workflow/maintainer-policy.json');
  const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8')) as {
    requiredChecks: string[];
  };
  policy.requiredChecks = ['fixture', 'fixture-two'];
  fs.writeFileSync(policyPath, `${JSON.stringify(policy, null, 2)}\n`);
  const profilesPath = path.join(
    repository,
    'workflow/maintainer-profiles.json',
  );
  const profiles = JSON.parse(fs.readFileSync(profilesPath, 'utf8')) as {
    profiles: Record<
      string,
      {
        requiredChecks: string[];
        checkDependencies: Record<string, string[]>;
      }
    >;
  };
  for (const profile of Object.values(profiles.profiles)) {
    profile.requiredChecks = ['fixture', 'fixture-two'];
    profile.checkDependencies['fixture-two'] = [
      'harness-engine',
      'runner',
      'source-tree',
    ];
  }
  fs.writeFileSync(profilesPath, `${JSON.stringify(profiles, null, 2)}\n`);
  git(repository, ['add', '.']);
  git(repository, ['commit', '-m', 'Install two exact base checks']);
  fs.writeFileSync(
    path.join(repository, 'packages/workflow-engine/src/limits.ts'),
    'export const LIMIT = 2;\n',
  );
  fs.writeFileSync(
    path.join(repository, 'packages/workflow-engine/test/limits.test.ts'),
    'export const EXPECTED = 2;\n',
  );
  return repository;
}

export function checkRunCount(repository: string, marker: string): number {
  return Number(fs.readFileSync(path.join(repository, '.git', marker), 'utf8'));
}

export function withTwoCheckCandidate<T>(
  operation: (repository: string) => T,
): T {
  const repository = prepareTwoCheckCandidate();
  try {
    return operation(repository);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
}

export function fixtureV2SshSigner(
  repository: string,
): MaintainerSignerProvider {
  const policy = parseMaintainerPolicy(
    JSON.parse(
      fs.readFileSync(
        path.join(repository, 'workflow/maintainer-policy.json'),
        'utf8',
      ),
    ),
  );
  const trusted = policy.trustedSigners[0];
  assert.ok(trusted);
  const privateKey = path.join(repository, '.git/workflow-test-signing-key');
  return {
    assertHumanPresent() {},
    identity: () => trusted.identity,
    sign(payload, namespace) {
      const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), 'workflow-v2-receipt-sign-'),
      );
      const payloadPath = path.join(directory, 'payload');
      try {
        fs.writeFileSync(payloadPath, payload, { mode: 0o600 });
        const result = spawnSync(
          '/usr/bin/ssh-keygen',
          [
            '-Y',
            'sign',
            '-f',
            privateKey,
            '-n',
            namespace ?? policy.signatureNamespace,
            payloadPath,
          ],
          { encoding: 'utf8' },
        );
        assert.equal(result.status, 0, result.stderr);
        return fs.readFileSync(`${payloadPath}.sig`, 'utf8');
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
    verify() {},
  };
}

export function annotatedTagBody(repository: string, ref: string): string {
  const raw = git(repository, ['cat-file', 'tag', ref]);
  const separator = raw.indexOf('\n\n');
  assert.notEqual(separator, -1);
  return raw.slice(separator + 2);
}

export function writeAnnotatedTag(
  repository: string,
  ref: string,
  target: string,
  body: string,
): void {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-v2-receipt-tag-'),
  );
  const messagePath = path.join(directory, 'message');
  try {
    fs.writeFileSync(messagePath, body, { mode: 0o600 });
    git(repository, [
      'tag',
      '--force',
      '--annotate',
      '--cleanup=verbatim',
      '--file',
      messagePath,
      ref.slice('refs/tags/'.length),
      target,
    ]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

export function fakeSigner(
  signed: string[],
  beforeSign: () => void = () => {},
): MaintainerSignerProvider {
  return {
    assertHumanPresent() {},
    identity() {
      return 'fixture-maintainer';
    },
    sign(payload, namespace) {
      beforeSign();
      assert.equal(
        [
          MAINTAINER_GRANT_V2_SIGNATURE_NAMESPACE,
          AUTHORITY_APPLICATION_RECEIPT_SIGNATURE_NAMESPACE,
          'HARNESS_TASK_MANDATE_V2',
        ].includes(namespace ?? ''),
        true,
      );
      signed.push(payload);
      return FAKE_SIGNATURE;
    },
    verify(payload, _signature, identity, namespace) {
      if (namespace !== 'HARNESS_TASK_MANDATE_V2') {
        assert.equal(signed.includes(payload), true);
      }
      assert.equal(identity, 'fixture-maintainer');
      assert.equal(
        [
          MAINTAINER_GRANT_V2_SIGNATURE_NAMESPACE,
          AUTHORITY_APPLICATION_RECEIPT_SIGNATURE_NAMESPACE,
          'HARNESS_TASK_MANDATE_V2',
        ].includes(namespace ?? ''),
        true,
      );
    },
  };
}

export function verifyingReissueSigner(
  priorVerifier: MaintainerSignerProvider,
  signed: string[],
): MaintainerSignerProvider {
  const current = fakeSigner(signed);
  return {
    ...current,
    verify(payload, signature, identity, namespace) {
      try {
        current.verify(payload, signature, identity, namespace);
      } catch {
        priorVerifier.verify(payload, signature, identity, namespace);
      }
    },
  };
}

export function freezeIssuableCandidate(
  repository: string,
  signed: string[],
): MaintainerGrantV2Payload {
  assert.throws(
    () =>
      approveAndApplyMaintainerGrantV2(
        repository,
        {
          changeId: 'demo-change',
          taskId: TASK_ID,
          externalEffects: [],
          profileId: PROFILE_ID,
          reason: 'Freeze an exact candidate for deterministic issue admission',
          message: 'Apply frozen workflow candidate',
        },
        {
          now: new Date('2026-08-03T09:00:00.000Z'),
          signer: fakeSigner(signed),
          commitCrashAfter: 'commit-created',
        },
      ),
    (error) =>
      error instanceof Error && error.name === 'SimulatedAuthorityCrash',
  );
  const payload = JSON.parse(signed[0]!) as MaintainerGrantV2Payload;
  assert.ok(payload.candidateBundle);
  assert.ok(payload.checksAttestation);
  const inspection = inspectMaintainerGrants(
    fs.realpathSync(path.join(repository, '.git')),
    payload.grantId,
  )[0];
  assert.ok(inspection?.reservationSessionId);
  abortAuthoritySession(
    repository,
    inspection.reservationSessionId,
    'Retain the frozen candidate for issue admission tests',
    new Date('2026-08-03T09:00:01.000Z'),
  );
  git(repository, ['reset', '--mixed', 'HEAD']);
  return payload;
}

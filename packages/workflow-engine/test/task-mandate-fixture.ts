/** Shared task-mandate fixtures; this module registers no tests. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deriveAuthorityAuditRepositoryId } from '../src/runtime/storage-journal/authority-audit-ledger.ts';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import { resolveBuiltInProviderDefinitionSnapshot } from '@jigwright/core/built-in-provider-definition';
import type { MaintainerSignerProvider } from '../src/adapters/signing/ssh/maintainer-signer.ts';
import {
  TASK_MANDATE_SIGNATURE_NAMESPACE_V2,
  type TaskMandateRequest,
} from '../src/modules/authority/task-mandate.ts';
import {
  computeProtectedCapabilityEntryDigestsFromWorktree,
  REQUIRED_PROTECTED_CAPABILITIES,
} from '../src/adapters/consumer/repository/work-registry/protected-capabilities.ts';
import {
  createFixtureRepository,
  git,
  sourceRepositoryRoot,
} from './fixture.ts';

export const TASK_ID = 'plan-review-scope-contract';

export const CHANGE_ID = 'demo-change';

export const MANDATE_ID = '44444444-4444-4444-8444-444444444444';

export const ISSUED_AT = new Date('2026-08-03T09:00:00.000Z');

export function externalAuditRoot(repository: string): string {
  const container = `${repository}.authority-audit-container`;
  fs.mkdirSync(container, { mode: 0o700, recursive: true });
  fs.chmodSync(container, 0o700);
  return path.join(fs.realpathSync(container), 'audit');
}

export function cleanupRepository(repository: string): void {
  fs.rmSync(repository, { recursive: true, force: true });
  fs.rmSync(`${repository}.authority-audit-container`, {
    recursive: true,
    force: true,
  });
}

export function auditScope(repository: string) {
  return {
    repositoryRoot: fs.realpathSync(repository),
    externalAuditRoot: externalAuditRoot(repository),
    repositoryId: deriveAuthorityAuditRepositoryId('github:R_fixture'),
  };
}

export function prepareRepository(
  trustedSigner: {
    identity: string;
    publicKey: string;
    fingerprint: string;
  } = {
    identity: 'fixture-maintainer',
    publicKey:
      'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJL6dVljsgm9EAbjCiOhA/tKsgApOhKmcB/NRewL1uns',
    fingerprint: 'SHA256:7UB1aHADtIMUJBFt3sjo9RwoBDgCKc1B1GlEucUDL4U',
  },
): string {
  const repository = createFixtureRepository();
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
    bootstrapEligiblePaths: ['packages/workflow-engine/src/**'],
    sealedImmutablePaths: [],
    requiredChecks: ['fixture'],
    trustedSigners: [trustedSigner],
  };
  fs.writeFileSync(
    path.join(repository, 'workflow/maintainer-policy.json'),
    `${JSON.stringify(policy, null, 2)}\n`,
  );
  fs.copyFileSync(
    path.join(sourceRepositoryRoot, 'workflow/grant-policy.json'),
    path.join(repository, 'workflow/grant-policy.json'),
  );
  git(repository, [
    'remote',
    'add',
    'origin',
    'https://github.com/example/fixture.git',
  ]);
  git(repository, ['add', '.']);
  git(repository, ['commit', '-m', 'Install task mandate trust base']);
  return repository;
}

export function enableConditionalTaskAuthorization(
  repository: string,
  protectedRole = 'lifecycle',
): void {
  const configPath = path.join(repository, 'workflow/config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<
    string,
    unknown
  >;
  config.taskAuthorization = {
    pathRoleRegistry: 'workflow/path-roles.json',
    mandateRequiredRoles: [protectedRole],
  };
  fs.writeFileSync(configPath, `${canonicalJson(config)}\n`, 'utf8');
  fs.writeFileSync(
    path.join(repository, 'workflow/path-roles.json'),
    `${canonicalJson({
      schemaVersion: 1,
      kind: 'path-role-registry',
      roles: {
        [protectedRole]: ['packages/workflow-engine/src/**'],
        ordinary: ['src/**'],
      },
    })}\n`,
    'utf8',
  );
  const loaderPath =
    'packages/workflow-engine/src/adapters/consumer/repository/work-registry/protected-capabilities.ts';
  const manifestPath = 'workflow/protected-capabilities.json';
  const loaderTarget = path.join(repository, loaderPath);
  fs.mkdirSync(path.dirname(loaderTarget), { recursive: true });
  fs.writeFileSync(loaderTarget, 'export const fixtureLoader = true;\n');
  const entries = REQUIRED_PROTECTED_CAPABILITIES.map((capability) => {
    const entrypoints =
      capability === 'authorization.verify'
        ? [loaderPath, manifestPath]
        : [manifestPath];
    return {
      capability,
      entrypoints,
      dependencies: [],
      ...computeProtectedCapabilityEntryDigestsFromWorktree(repository, {
        entrypoints,
        dependencies: [],
      }),
    };
  });
  fs.writeFileSync(
    path.join(repository, manifestPath),
    `${canonicalJson({
      kind: 'protected-capability-manifest.v1',
      schemaVersion: 1,
      manifestPath,
      entries,
    })}\n`,
    'utf8',
  );
  git(repository, [
    'add',
    'workflow/config.json',
    'workflow/path-roles.json',
    manifestPath,
    loaderPath,
  ]);
  git(repository, ['commit', '-m', 'Enable conditional task authorization']);
}

export function agentProviderConfigToml(): string {
  const claude = resolveBuiltInProviderDefinitionSnapshot('claude', 'darwin')!;
  const codex = resolveBuiltInProviderDefinitionSnapshot('codex', 'darwin')!;
  return `schema_version = 2
global_ranking = ["claude-main", "codex-main"]

[[providers]]
id = "claude-main"
logical_provider_id = "claude"
family = "claude"
capabilities = ["fresh-session", "plan-review", "survey", "task-diff-review", "task-implementation"]
trust_tier = "built-in-reviewed"
enabled = true
protocol = "${claude.protocol}"
executable = "${claude.executableCandidates[0]}"

[[providers]]
id = "codex-main"
logical_provider_id = "codex"
family = "codex"
capabilities = ["fresh-session", "plan-review", "survey", "task-diff-review", "task-implementation"]
trust_tier = "built-in-reviewed"
enabled = true
protocol = "${codex.protocol}"
executable = "${codex.executableCandidates[0]}"

[provider_preferences]
author = ["claude-main", "codex-main"]
builder = ["claude-main", "codex-main"]
reviewer = ["claude-main", "codex-main"]
`;
}

export function request(
  changeId = CHANGE_ID,
  maxInvocations = 1,
): TaskMandateRequest {
  const providerDeclaration = {
    maxInvocations,
    maxBudget: null,
    dataTypes: [
      'diff',
      'repository-metadata',
      'source-code',
      'task-intent',
      'test-output',
    ] as const,
    sourceCode: true,
    secrets: false as const,
    retryOnFailure: true,
    retryRequiresHuman: false,
  };
  return {
    changeId,
    taskId: TASK_ID,
    intent: 'Repair the PlanReview scope contract and add regression coverage.',
    providerCalls: {
      claude: {
        ...providerDeclaration,
        dataTypes: [...providerDeclaration.dataTypes],
      },
      codex: {
        ...providerDeclaration,
        dataTypes: [...providerDeclaration.dataTypes],
      },
    },
  };
}

export function fakeSigner(signed: string[]): MaintainerSignerProvider {
  return {
    assertHumanPresent() {},
    identity() {
      return 'fixture-maintainer';
    },
    sign(payload, namespace) {
      assert.equal(namespace, TASK_MANDATE_SIGNATURE_NAMESPACE_V2);
      signed.push(payload);
      return [
        '-----BEGIN SSH SIGNATURE-----',
        'ZmFrZQ==',
        '-----END SSH SIGNATURE-----',
        '',
      ].join('\n');
    },
    verify(payload, _signature, identity, namespace) {
      assert.equal(signed.includes(payload), true);
      assert.equal(identity, 'fixture-maintainer');
      assert.equal(namespace, TASK_MANDATE_SIGNATURE_NAMESPACE_V2);
    },
  };
}

export function generateSigningKey(directory: string): {
  privateKey: string;
  trustedSigner: {
    identity: string;
    publicKey: string;
    fingerprint: string;
  };
} {
  const privateKey = path.join(directory, 'id_ed25519');
  const generated = spawnSync(
    '/usr/bin/ssh-keygen',
    ['-q', '-t', 'ed25519', '-N', '', '-f', privateKey],
    { encoding: 'utf8' },
  );
  assert.equal(generated.status, 0, generated.stderr);
  const publicKey = fs
    .readFileSync(`${privateKey}.pub`, 'utf8')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .join(' ');
  const fingerprintResult = spawnSync(
    '/usr/bin/ssh-keygen',
    ['-l', '-E', 'sha256', '-f', `${privateKey}.pub`],
    { encoding: 'utf8' },
  );
  assert.equal(fingerprintResult.status, 0, fingerprintResult.stderr);
  const fingerprint = fingerprintResult.stdout.match(
    /SHA256:[A-Za-z0-9+/]+/,
  )?.[0];
  assert.ok(fingerprint);
  return {
    privateKey,
    trustedSigner: {
      identity: 'fixture-maintainer',
      publicKey,
      fingerprint,
    },
  };
}

export function realSigningProvider(
  privateKey: string,
): MaintainerSignerProvider {
  return {
    assertHumanPresent() {},
    identity: () => 'fixture-maintainer',
    sign(payload, namespace) {
      const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), 'task-mandate-sign-'),
      );
      const payloadPath = path.join(directory, 'payload');
      try {
        fs.writeFileSync(payloadPath, payload, { mode: 0o600 });
        const signed = spawnSync(
          '/usr/bin/ssh-keygen',
          [
            '-Y',
            'sign',
            '-f',
            privateKey,
            '-n',
            namespace ?? TASK_MANDATE_SIGNATURE_NAMESPACE_V2,
            payloadPath,
          ],
          { encoding: 'utf8' },
        );
        assert.equal(signed.status, 0, signed.stderr);
        return fs.readFileSync(`${payloadPath}.sig`, 'utf8');
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
    verify() {},
  };
}

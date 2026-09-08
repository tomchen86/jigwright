/** Repository edits and pinned policy fixtures for exact authority remapping. */
import path from 'node:path';
import fs from 'node:fs';
import { git, sourceRepositoryRoot } from './fixture.ts';
import { parseCapabilityProfile } from '../src/modules/authority/maintainer-manifest.ts';

export function write(
  repository: string,
  relativePath: string,
  content: string,
): void {
  const target = path.join(repository, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

export function move(repository: string, from: string, to: string): void {
  fs.mkdirSync(path.dirname(path.join(repository, to)), { recursive: true });
  git(repository, ['mv', from, to]);
}

export function commitAll(repository: string, message: string): void {
  git(repository, ['add', '-A']);
  git(repository, ['commit', '-m', message]);
}

export function commitGeneratedRuntimeFixture(
  repository: string,
  message: string,
): void {
  stageGeneratedRuntimeFixture(repository);
  git(repository, ['commit', '-m', message]);
}

export function stageGeneratedRuntimeFixture(repository: string): void {
  git(repository, ['add', '-A']);
  // The runtime closure intentionally contains generated package files below a
  // normally ignored node_modules path. Fixture bases must pin those exact
  // bytes, otherwise the strict pre-materialization drift check masks the
  // remap behavior under test.
  git(repository, [
    'add',
    '--force',
    'packages/workflow-engine/bootstrap/recovery-runtime',
  ]);
}

export function updatePathRoles(
  repository: string,
  mutate: (roles: Record<string, string[]>) => void,
): void {
  const registryPath = path.join(repository, 'workflow/path-roles.json');
  const value = JSON.parse(fs.readFileSync(registryPath, 'utf8')) as {
    roles: Record<string, string[]>;
  };
  mutate(value.roles);
  fs.writeFileSync(registryPath, `${JSON.stringify(value, null, 2)}\n`);
}

export function updateChecks(
  repository: string,
  mutate: (
    checks: Record<string, { command: string[]; destructiveDatabase: boolean }>,
  ) => void,
): void {
  const checksPath = path.join(repository, 'workflow/checks.json');
  const value = JSON.parse(fs.readFileSync(checksPath, 'utf8')) as {
    checks: Record<string, { command: string[]; destructiveDatabase: boolean }>;
  };
  mutate(value.checks);
  fs.writeFileSync(checksPath, `${JSON.stringify(value, null, 2)}\n`);
}

export function writeGuard(
  repository: string,
  relativePath: string,
  changeId: string,
  allowedPath: string,
): void {
  write(
    repository,
    relativePath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        changeId,
        tasks: {
          '1.1': {
            allowedPaths: [allowedPath],
            requiredChecks: ['fixture'],
          },
        },
      },
      null,
      2,
    )}\n`,
  );
}

type MaintainerPolicySource = {
  bootstrapEligiblePaths: string[];
  sealedImmutablePaths: string[];
  [key: string]: unknown;
};

export function writeMaintainerPolicy(
  repository: string,
  mutate: (policy: MaintainerPolicySource) => void,
): void {
  const policy = JSON.parse(
    fs.readFileSync(
      path.join(sourceRepositoryRoot, 'workflow/maintainer-policy.json'),
      'utf8',
    ),
  ) as MaintainerPolicySource;
  mutate(policy);
  policy.bootstrapEligiblePaths.sort();
  policy.sealedImmutablePaths.sort();
  write(
    repository,
    'workflow/maintainer-policy.json',
    `${JSON.stringify(policy, null, 2)}\n`,
  );
}

export function writeMaintainerProfiles(
  repository: string,
  options: {
    implementationPaths: string[];
    evidencePaths?: string[];
    policyPaths?: string[];
    verificationInfrastructurePaths?: string[];
    forbiddenPaths?: string[];
  },
): void {
  const profile = {
    id: 'remap-profile',
    version: 1,
    authorityClass: 'root-one-shot',
    implementationPaths: [...options.implementationPaths].sort(),
    evidencePaths: [...(options.evidencePaths ?? [])].sort(),
    policyPaths: [
      ...(options.policyPaths ?? [
        'workflow/maintainer-policy.json',
        'workflow/maintainer-profiles.json',
      ]),
    ].sort(),
    verificationInfrastructurePaths: [
      ...(options.verificationInfrastructurePaths ?? ['workflow/checks.json']),
    ].sort(),
    forbiddenPaths: [...(options.forbiddenPaths ?? [])].sort(),
    constraints: {
      evidenceOnlyGrantForbidden: true,
      samePackageRequired: true,
      evidenceAdditionsAllowed: true,
      maximumFiles: 100,
    },
    requiredChecks: ['fixture'],
    checkDependencies: {
      fixture: ['source-tree'],
    },
  };
  parseCapabilityProfile(profile);
  write(
    repository,
    'workflow/maintainer-profiles.json',
    `${JSON.stringify(
      {
        schemaVersion: 1,
        profiles: { 'remap-profile': profile },
      },
      null,
      2,
    )}\n`,
  );
}

export function removeFixtureActiveGuard(repository: string): void {
  fs.rmSync(path.join(repository, 'openspec/changes/demo-change/guard.json'));
}

export function head(repository: string): string {
  return git(repository, ['rev-parse', 'HEAD']).trim();
}

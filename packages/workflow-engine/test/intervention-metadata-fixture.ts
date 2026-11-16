/** Finite existing metadata for status/disposition tests; no self-update producer. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import { readPersistedIntervention } from '../src/runtime/storage-journal/intervention-plan-store.ts';
import {
  readMaintenanceGrantRecord,
  type PersistedMaintenanceGrantRecord,
} from '../src/application/control-plane/intervention-maintenance.ts';
import { readLocalEngineBinding } from '../src/runtime/storage-journal/intervention-parent-binding.ts';
import type {
  LocalEngineBinding,
  BootstrapInterventionCliDependencies,
} from '../src/modules/authority/intervention-bootstrap-contract.ts';
import { deriveAuthorityAuditRepositoryId } from '../src/runtime/storage-journal/authority-audit-ledger.ts';
import {
  canonicalHarnessMaintenanceGrantPayload,
  HARNESS_MAINTENANCE_SIGNATURE_NAMESPACE,
} from '../src/modules/authority/intervention-control.ts';
export const NOW = new Date('2026-08-03T10:00:00.000Z');
export const EXPIRES = '2026-08-03T10:30:00.000Z';
export const SIGNER = 'maintainer@example.test';
export function digest(value: string | Buffer): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}
export function git(repositoryRoot: string, args: string[]): string {
  return execFileSync('git', ['-C', repositoryRoot, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
function fixtureRepository() {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'intervention-human-cli-')),
  );
  fs.chmodSync(root, 0o700);
  const repositoryRoot = path.join(root, 'parent');
  fs.mkdirSync(repositoryRoot, { mode: 0o700 });
  git(repositoryRoot, ['init', '-b', 'work/parent-A']);
  git(repositoryRoot, ['config', 'user.email', 'workflow@example.test']);
  git(repositoryRoot, ['config', 'user.name', 'Workflow Test']);
  const origin = 'https://github.com/example/intervention-fixture.git';
  git(repositoryRoot, ['remote', 'add', 'origin', origin]);
  fs.mkdirSync(path.join(repositoryRoot, 'workflow'), { mode: 0o700 });
  fs.writeFileSync(
    path.join(repositoryRoot, 'workflow/maintainer-policy.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        repository: { id: 'github:R_intervention_fixture', origin },
        phase: 'bootstrap',
        auditTagPrefix: 'refs/tags/workflow-grant/',
        signatureNamespace: 'workflow.maintainer-grant.v1',
        maxTtlMinutes: 30,
        maxUses: 1,
        bootstrapEligiblePaths: ['packages/workflow-engine/**'],
        sealedImmutablePaths: [],
        requiredChecks: ['fixture'],
        trustedSigners: [
          {
            identity: 'maintainer@example.test',
            publicKey:
              'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJL6dVljsgm9EAbjCiOhA/tKsgApOhKmcB/NRewL1uns',
            fingerprint: 'SHA256:7UB1aHADtIMUJBFt3sjo9RwoBDgCKc1B1GlEucUDL4U',
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  fs.writeFileSync(path.join(repositoryRoot, 'tracked.txt'), 'base\n');
  git(repositoryRoot, ['add', '.']);
  git(repositoryRoot, ['commit', '-m', 'Create fixture baseline']);
  const gitCommonValue = git(repositoryRoot, [
    'rev-parse',
    '--git-common-dir',
  ]).trim();
  const gitCommonDirectory = fs.realpathSync(
    path.isAbsolute(gitCommonValue)
      ? gitCommonValue
      : path.resolve(repositoryRoot, gitCommonValue),
  );
  const stateRoot = path.join(
    gitCommonDirectory,
    'workflow-engine',
    'intervention-control',
  );
  fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  const sessionSnapshotPath = path.join(
    stateRoot,
    'parent-session-snapshot.json',
  );
  fs.writeFileSync(sessionSnapshotPath, '{"checkpoint":"plan-review"}\n', {
    mode: 0o600,
  });
  const externalAuditRoot = path.join(root, 'authority-audit');
  const auditScope = {
    externalAuditRoot,
    repositoryRoot,
    repositoryId: deriveAuthorityAuditRepositoryId(
      `git-common:${gitCommonDirectory}`,
    ),
  };
  return {
    root,
    repositoryRoot,
    gitCommonDirectory,
    stateRoot,
    sessionSnapshotPath,
    externalAuditRoot,
    auditScope,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
function snapshotFiles(directory: string): Array<[string, string]> {
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const file = path.join(directory, entry.name);
      return entry.isDirectory()
        ? snapshotFiles(file)
        : [
            [file, fs.readFileSync(file).toString('base64')] as [
              string,
              string,
            ],
          ];
    });
}
export function withDigest<T extends Record<string, unknown>>(value: T) {
  const { recordDigest: _ignored, ...payload } = value;
  return { ...payload, recordDigest: digest(canonicalJson(payload)) };
}
export function writeRecord(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, canonicalJson(value) + '\n', { mode: 0o600 });
}
function signed(payload: string, namespace: string, signer = SIGNER): string {
  return digest(namespace + '\0' + signer + '\0' + payload);
}
export function metadataFixture(
  bindingState: 'absent' | 'active' | 'adopted' = 'active',
) {
  const f = fixtureRepository();
  const baseOid = git(f.repositoryRoot, ['rev-parse', 'HEAD']).trim();
  const child = path.join(f.root, 'child');
  git(f.repositoryRoot, [
    'worktree',
    'add',
    '-b',
    'work/repair-A',
    child,
    baseOid,
  ]);
  fs.writeFileSync(path.join(child, 'child-wip.txt'), 'child bytes\n');
  fs.writeFileSync(path.join(f.repositoryRoot, 'tracked.txt'), 'staged\n');
  git(f.repositoryRoot, ['add', 'tracked.txt']);
  fs.writeFileSync(path.join(f.repositoryRoot, 'tracked.txt'), 'unstaged\n');
  fs.writeFileSync(
    path.join(f.repositoryRoot, 'note.bin'),
    Buffer.from([0, 1, 255]),
  );
  const checkpointPayload = {
    kind: 'harness-wip-checkpoint.v1',
    parentChangeId: 'parent-A',
    baseOid,
    worktreeFingerprint: digest('worktree'),
    trackedTreeDigest: digest('tracked'),
    untrackedBundleDigest: digest('untracked'),
    sessionStateDigest: digest('session'),
    pendingIntentDigest: digest('intent'),
    engineDigest: digest('installed'),
    policyDigest: digest('policy'),
    createdAt: NOW.toISOString(),
  };
  const checkpoint = {
    ...checkpointPayload,
    checkpointId: digest(canonicalJson(checkpointPayload)),
  };
  const checkpointFile = path.join(
    f.stateRoot,
    'checkpoints',
    checkpoint.checkpointId.slice(7) + '.json',
  );
  writeRecord(checkpointFile, checkpoint);
  const identity = {
    kind: 'intervention-child-worktree-identity.v1',
    parentChangeId: 'parent-A',
    interventionChangeId: 'repair-A',
    checkpointId: checkpoint.checkpointId,
    parentWorkspacePath: f.repositoryRoot,
    childWorkspacePath: child,
    changeRef: 'refs/heads/work/repair-A',
  };
  const childPayload = {
    ...identity,
    kind: 'intervention-child-worktree.v1',
    workspaceId: digest(canonicalJson(identity)),
    baseOid,
    state: 'planned',
    createdAt: NOW.toISOString(),
    effectsPerformed: false,
  };
  const childWorkspace = {
    ...childPayload,
    metadataDigest: digest(canonicalJson(childPayload)),
  };
  const blocker = {
    kind: 'harness-intervention',
    checkpointId: checkpoint.checkpointId,
    blockedBy: 'repair-A',
  };
  const intervention = withDigest({
    kind: 'persisted-harness-intervention.v1',
    parent: {
      changeId: 'parent-A',
      status: 'active',
      engineBinding: checkpoint.engineDigest,
      sessionSchema: 'v4',
      blocker,
    },
    relationship: {
      kind: 'harness-intervention.v1',
      parentChangeId: 'parent-A',
      interventionChangeId: 'repair-A',
      checkpointId: checkpoint.checkpointId,
      unblocks: 'parent-A',
      state: 'active',
    },
    checkpoint,
    childWorkspace,
    createdAt: NOW.toISOString(),
  });
  const interventionFile = path.join(
    f.stateRoot,
    'interventions',
    digest('intervention\0parent-A').slice(7) + '.json',
  );
  writeRecord(interventionFile, intervention);
  const grantId =
    'maintenance-' +
    digest(
      'maintenance-grant.v2\0parent-A\0' +
        checkpoint.checkpointId +
        '\0repair-A\0' +
        NOW.toISOString(),
    ).slice(7);
  const payload = {
    kind: 'harness-maintenance-grant.v1' as const,
    grantId,
    parentChangeId: 'parent-A',
    interventionChangeId: 'repair-A',
    scope: {
      paths: ['packages/workflow-engine/**'],
      operations: ['adopt-engine-into-parent' as const],
    },
    waivers: [],
    engineFromDigest: checkpoint.engineDigest,
    sessionSchema: 'v4',
    maxLocalAdoptions: 1,
    issuedAt: NOW.toISOString(),
    expiresAt: EXPIRES,
    humanSigner: SIGNER,
    reason: 'Existing repair',
  };
  const envelope = {
    payload,
    signature: signed(
      canonicalHarnessMaintenanceGrantPayload(payload),
      HARNESS_MAINTENANCE_SIGNATURE_NAMESPACE,
    ),
  };
  const summary = {
    kind: 'maintenance-approval-summary.v1',
    parentChangeId: 'parent-A',
    interventionChangeId: 'repair-A',
    checkpointId: checkpoint.checkpointId,
    engineFromDigest: checkpoint.engineDigest,
    sessionSchema: 'v4',
    reason: payload.reason,
    childWorkspace: { path: child, changeRef: identity.changeRef },
    scope: payload.scope,
    waivers: [],
    authorityAudit: f.auditScope,
    maxLocalAdoptions: 1,
    humanReadable: 'Existing maintenance approval',
  };
  const authorityAudit = {
    externalAuditRoot: f.externalAuditRoot,
    repositoryId: f.auditScope.repositoryId,
  };
  summary.authorityAudit = authorityAudit as typeof summary.authorityAudit;
  const grant = withDigest({
    kind: 'persisted-maintenance-grant.v1',
    parentChangeId: 'parent-A',
    interventionChangeId: 'repair-A',
    checkpointId: checkpoint.checkpointId,
    authorityAudit,
    envelope,
    summary,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    state: 'available',
    expiredAt: null,
    revokedAt: null,
    revocationReason: null,
  }) as PersistedMaintenanceGrantRecord;
  const grantFile = path.join(
    f.stateRoot,
    'maintenance-grants',
    digest('maintenance-record\0' + grantId).slice(7) + '.json',
  );
  writeRecord(grantFile, grant);
  const candidate = path.join(
    f.stateRoot,
    'local-engine-artifacts',
    digest('artifact').slice(7),
    'engine',
  );
  const marker = path.join(f.root, 'candidate-executed');
  fs.mkdirSync(path.dirname(candidate), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    candidate,
    'require("node:fs").writeFileSync(' +
      JSON.stringify(marker) +
      ', "executed");\n',
    { mode: 0o500 },
  );
  const bindingFile = path.join(
    f.stateRoot,
    'local-parent-sessions',
    digest('parent-session\0parent-A').slice(7) + '.json',
  );
  const binding = withDigest({
    kind: 'local-parent-session-metadata.v2',
    parentChangeId: 'parent-A',
    parentWorkspacePath: f.repositoryRoot,
    parentBranch: 'refs/heads/work/parent-A',
    interventionChangeId: 'repair-A',
    txId: 'existing-tx',
    checkpointId: checkpoint.checkpointId,
    engineDigest:
      bindingState === 'adopted'
        ? digest('candidate')
        : checkpoint.engineDigest,
    activeArtifact: {
      artifactId: digest('artifact'),
      executableDigest: digest(fs.readFileSync(candidate)),
      executablePath: candidate,
    },
    sessionSchema: 'v4',
    blocker: bindingState === 'adopted' ? null : blocker,
    interventionState: bindingState === 'adopted' ? 'adopted' : 'active',
    generation: 2,
    updatedAt: NOW.toISOString(),
  }) as LocalEngineBinding;
  if (bindingState !== 'absent') writeRecord(bindingFile, binding);
  const residues = [
    'bootstrap-wip-bundles/existing.json',
    'bootstrap-receipts/existing.json',
    'session-snapshots/existing.json',
    'adoptions/existing.json',
  ];
  for (const p of residues)
    writeRecord(path.join(f.stateRoot, p), { existing: p });
  const ordinarySession = path.join(
    f.gitCommonDirectory,
    'workflow-engine/sessions/ordinary.json',
  );
  writeRecord(ordinarySession, { task: 'ordinary', state: 'active' });
  readPersistedIntervention(f.stateRoot, 'parent-A');
  readMaintenanceGrantRecord(f.stateRoot, grantId);
  if (bindingState !== 'absent') readLocalEngineBinding(bindingFile);
  const protectedFiles = [
    checkpointFile,
    f.sessionSnapshotPath,
    candidate,
    ordinarySession,
    ...residues.map((p) => path.join(f.stateRoot, p)),
    path.join(f.repositoryRoot, 'tracked.txt'),
    path.join(f.repositoryRoot, 'note.bin'),
    path.join(child, 'child-wip.txt'),
    path.join(f.gitCommonDirectory, 'index'),
  ];
  return {
    ...f,
    child,
    checkpoint,
    intervention,
    interventionFile,
    grant,
    grantFile,
    grantId,
    binding,
    bindingFile,
    candidate,
    marker,
    protectedBytes: () => ({
      child: snapshotFiles(child),
      files: protectedFiles.map((p) => [
        p,
        fs.readFileSync(p).toString('base64'),
      ]),
      refs: git(f.repositoryRoot, [
        'for-each-ref',
        '--format=%(refname) %(objectname)',
      ]),
      head: git(f.repositoryRoot, ['rev-parse', 'HEAD']),
    }),
  };
}
export function humanDependencies(
  options: {
    now?: Date;
    signatureValid?: boolean;
    afterAuthorityAuditRecorded?: () => void;
    afterAbandonmentIntentPersisted?: () => void;
  } = {},
) {
  let signatures = 0;
  const dependencies: BootstrapInterventionCliDependencies = {
    now: () => options.now ?? NOW,
    verifyHumanSignature: (payload, signature, signer, namespace) =>
      options.signatureValid !== false &&
      signature === signed(payload, namespace, signer),
    maintenanceSigner: {
      assertHumanPresent() {},
      identity() {
        return SIGNER;
      },
      sign(payload, namespace) {
        signatures++;
        return signed(payload, namespace!);
      },
      verify(payload, signature, identity, namespace) {
        assert.equal(signature, signed(payload, namespace!, identity));
      },
    },
    testHooks: options,
  };
  return { dependencies, signatures: () => signatures };
}

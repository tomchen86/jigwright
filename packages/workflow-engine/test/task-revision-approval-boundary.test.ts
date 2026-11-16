import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  issueTaskRevisionApproval,
  readAndValidateTaskRevisionApproval,
} from '../src/application/revise/task-revision-approval.ts';
import { WorkflowError } from '../src/foundation/errors/errors.ts';
import {
  TASK_REVISION_APPROVAL_AUTHORIZED_EFFECT,
  TASK_REVISION_APPROVAL_SIGNATURE_NAMESPACE,
  assertTaskRevisionApprovalBinding,
  assertTaskRevisionApprovalPayload,
  assertTaskRevisionApprovalRecord,
  canonicalTaskRevisionApprovalPayload,
  taskRevisionApprovalRecordId,
  taskRevisionApprovalTargetDigest,
  type TaskRevisionApprovalBinding,
  type TaskRevisionApprovalPayload,
  type TaskRevisionApprovalRecord,
  type TaskRevisionApprovalRecords,
  type TaskRevisionApprovalRepository,
  type TaskRevisionApprovalIssueOptions,
  type TaskRevisionApprovalValidationOptions,
} from '../src/modules/authority/task-revision-approval-contracts.ts';
import type { MaintainerPolicy } from '../src/modules/authority/maintainer-policy.ts';
import type {
  MaintainerDataSignatureVerifier,
  MaintainerSignerProvider,
} from '../src/modules/authority/maintainer-signer-port.ts';
import type { GitState } from '../src/modules/repository-consumer/repository-git-state.ts';
import { taskRevisionApprovalRecords } from '../src/runtime/storage-journal/task-revision-approval.ts';
import { runtimePaths } from '../src/runtime/session-workspace/session-store.ts';
import { createFixtureRepository } from './fixture.ts';
import { assertPureDependencyClosure } from './support/pure-dependency-closure.ts';

const now = new Date('2026-08-11T01:04:00.000Z');
const binding: TaskRevisionApprovalBinding = {
  schemaVersion: 1,
  kind: 'task-revision-approval-binding.v1',
  changeId: 'demo-change',
  taskId: '1.1',
  sessionId: 'session-approval',
  leaseId: 'revision-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  actorAuthorityId: 'implementer',
  baselineCommit: 'a'.repeat(40),
  baselineTree: 'b'.repeat(40),
  priorContractDigest: 'c'.repeat(64),
  candidateContractDigest: 'd'.repeat(64),
  candidatePlanningGenerationId: 'e'.repeat(64),
  implementationFingerprint: 'f'.repeat(64),
  revisionReasonDigest: '1'.repeat(64),
  previousAllowedPaths: ['src/**'],
  nextAllowedPaths: ['src/**', 'test/**'],
  previousRequiredChecks: ['test'],
  nextRequiredChecks: ['test'],
};
const policy: MaintainerPolicy = {
  schemaVersion: 1,
  repository: {
    id: 'github:fixture',
    origin: 'https://github.com/fixture/project.git',
  },
  phase: 'bootstrap',
  auditTagPrefix: 'refs/tags/fixture/',
  signatureNamespace: 'workflow.maintainer-grant.v1',
  maxTtlMinutes: 30,
  maxUses: 1,
  bootstrapEligiblePaths: ['src/**'],
  sealedImmutablePaths: [],
  requiredChecks: ['test'],
  trustedSigners: [
    {
      identity: 'maintainer',
      publicKey:
        'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJL6dVljsgm9EAbjCiOhA/tKsgApOhKmcB/NRewL1uns',
      fingerprint: 'SHA256:7UB1aHADtIMUJBFt3sjo9RwoBDgCKc1B1GlEucUDL4U',
    },
  ],
};
const policyBlob = '2'.repeat(40);
const signature =
  '-----BEGIN SSH SIGNATURE-----\nAAAA\n-----END SSH SIGNATURE-----\n';
const payload: TaskRevisionApprovalPayload = {
  version: 1,
  kind: 'task-revision-approval.v1',
  repositoryId: policy.repository.id,
  repositoryOrigin: policy.repository.origin,
  policyBlob,
  binding,
  targetDigest: taskRevisionApprovalTargetDigest(binding),
  authorizedEffect: TASK_REVISION_APPROVAL_AUTHORIZED_EFFECT,
  rationale: 'Approve this exact reviewed widening.',
  issuedAt: now.toISOString(),
  expiresAt: '2026-08-11T01:09:00.000Z',
  signer: 'maintainer',
};
const record: TaskRevisionApprovalRecord = {
  schemaVersion: 1,
  kind: 'task-revision-approval-record.v1',
  createdAt: payload.issuedAt,
  envelope: {
    payload,
    signatureNamespace: TASK_REVISION_APPROVAL_SIGNATURE_NAMESPACE,
    signature,
  },
};
const approvalId = taskRevisionApprovalRecordId(
  record.createdAt,
  record.envelope,
);
const gitState: GitState = {
  repositoryRoot: '/memory',
  repositoryRealPath: '/memory',
  gitCommonDirectory: '/memory/.git',
  branch: 'work/demo-change',
  head: binding.baselineCommit,
  tree: binding.baselineTree,
  statusEntries: [],
};

function memoryEffects(failureAt = '') {
  const calls: string[] = [];
  const failure = new Error(`failed ${failureAt}`);
  function observe(name: string) {
    calls.push(name);
    if (name === failureAt) throw failure;
  }
  const repository: TaskRevisionApprovalRepository = {
    inspect(cwd) {
      observe('inspect');
      assert.equal(cwd, '/memory');
      return gitState;
    },
    policyAt(root, commit) {
      observe('policy');
      assert.equal(root, '/memory');
      assert.equal(commit, binding.baselineCommit);
      return { policy, policyBlob };
    },
    origin(root) {
      observe('origin');
      assert.equal(root, '/memory');
      return policy.repository.origin;
    },
  };
  const records: TaskRevisionApprovalRecords = {
    read(repository, id) {
      observe('read');
      assert.equal(repository.repositoryRoot, '/memory');
      assert.equal(id, approvalId);
      return record;
    },
    publish(repository, value) {
      observe('publish');
      assert.equal(repository, gitState);
      assert.deepEqual(value, record);
      return { approvalId, recordPath: `/memory/${approvalId}.json` };
    },
  };
  const signer: MaintainerSignerProvider = {
    assertHumanPresent() {
      observe('human');
    },
    identity() {
      observe('identity');
      return 'maintainer';
    },
    sign(bytes, namespace) {
      observe('sign');
      assert.equal(bytes, canonicalTaskRevisionApprovalPayload(payload));
      assert.equal(namespace, TASK_REVISION_APPROVAL_SIGNATURE_NAMESPACE);
      return signature;
    },
    verify(bytes, signed, identity, namespace) {
      observe('verify');
      assert.equal(bytes, canonicalTaskRevisionApprovalPayload(payload));
      assert.equal(signed, signature);
      assert.equal(identity, 'maintainer');
      assert.equal(namespace, TASK_REVISION_APPROVAL_SIGNATURE_NAMESPACE);
    },
  };
  const selectedKeyVerifier: MaintainerDataSignatureVerifier = (
    bytes,
    signed,
    selected,
    namespace,
    errorCode,
  ) => {
    observe('selected-key');
    assert.equal(selected, policy.trustedSigners[0]);
    assert.equal(bytes, canonicalTaskRevisionApprovalPayload(payload));
    assert.equal(signed, signature);
    assert.equal(namespace, TASK_REVISION_APPROVAL_SIGNATURE_NAMESPACE);
    assert.equal(errorCode, 'TASK_REVISION_APPROVAL_SIGNATURE_INVALID');
  };
  const createSigner = (root: string, selected: MaintainerPolicy) => {
    observe('signer');
    assert.equal(root, '/memory');
    assert.equal(selected, policy);
    return signer;
  };
  return {
    calls,
    failure,
    repository: { ...repository },
    records: { ...records },
    signer,
    createSigner,
    selectedKeyVerifier,
  };
}
function issue(
  effects: ReturnType<typeof memoryEffects>,
  options: TaskRevisionApprovalIssueOptions = { now },
  target = payload.targetDigest,
) {
  return issueTaskRevisionApproval(
    effects.repository,
    effects.records,
    effects.createSigner,
    '/memory',
    {
      binding,
      expectedTargetDigest: target,
      rationale: payload.rationale,
    },
    options,
  );
}
function read(
  effects: ReturnType<typeof memoryEffects>,
  options: TaskRevisionApprovalValidationOptions = { now },
) {
  return readAndValidateTaskRevisionApproval(
    effects.repository,
    effects.records,
    effects.selectedKeyVerifier,
    '/memory',
    approvalId,
    binding,
    options,
  );
}
function code(expected: string) {
  return (error: unknown) =>
    error instanceof WorkflowError && error.code === expected;
}

test('approval contracts have a pure type and value closure and reject outward dependencies', () => {
  const entry = fileURLToPath(
    new URL(
      '../src/modules/authority/task-revision-approval-contracts.ts',
      import.meta.url,
    ),
  );
  assertPureDependencyClosure(entry);
  for (const source of [
    "import type { ContentRecord } from '../../runtime/storage-journal/content-record-store.ts';",
    "import { readContentRecord } from '../../runtime/storage-journal/content-record-store.ts';",
  ])
    assert.throws(
      () => assertPureDependencyClosure(entry, source),
      /Outward pure dependency/,
    );
});

test('approval data rules preserve exact binding, record identity and limited expiry relaxation', () => {
  assert.deepEqual(assertTaskRevisionApprovalBinding(binding), binding);
  assert.deepEqual(
    assertTaskRevisionApprovalRecord(record, approvalId),
    record.envelope,
  );
  assert.throws(
    () =>
      assertTaskRevisionApprovalBinding({
        ...binding,
        nextAllowedPaths: ['test/**', 'src/**'],
      }),
    code('TASK_REVISION_APPROVAL_INVALID'),
  );
  for (const invalid of [
    { ...record, extra: true },
    { ...record, createdAt: '2026-08-11T01:03:00.000Z' },
  ])
    assert.throws(
      () => assertTaskRevisionApprovalRecord(invalid, approvalId),
      code('TASK_REVISION_APPROVAL_INVALID'),
    );
  assert.throws(
    () => assertTaskRevisionApprovalRecord(record, '0'.repeat(64)),
    code('TASK_REVISION_APPROVAL_INVALID'),
  );
  const late = new Date('2026-08-11T01:20:00.000Z');
  assert.throws(
    () =>
      assertTaskRevisionApprovalPayload(payload, policy, policyBlob, binding, {
        now: new Date(payload.expiresAt),
      }),
    code('TASK_REVISION_APPROVAL_STALE'),
  );
  assertTaskRevisionApprovalPayload(payload, policy, policyBlob, binding, {
    now: late,
    allowExpired: true,
  });
  for (const invalid of [
    { ...payload, signer: binding.actorAuthorityId },
    { ...payload, signer: 'untrusted' },
    { ...payload, policyBlob: '3'.repeat(40) },
    { ...payload, targetDigest: '3'.repeat(64) },
    { ...payload, expiresAt: '2026-08-11T01:09:00.001Z' },
    {
      ...payload,
      issuedAt: '2026-08-11T01:21:00.000Z',
      expiresAt: '2026-08-11T01:22:00.000Z',
    },
  ])
    assert.throws(
      () =>
        assertTaskRevisionApprovalPayload(
          invalid,
          policy,
          policyBlob,
          binding,
          { now: late, allowExpired: true },
        ),
      code('TASK_REVISION_APPROVAL_STALE'),
    );
});

test('issuance observes each phase lazily and publishes only after signature verification', () => {
  const effects = memoryEffects();
  assert.deepEqual(effects.calls, []);
  assert.equal(issue(effects).approvalId, approvalId);
  assert.deepEqual(effects.calls, [
    'inspect',
    'policy',
    'origin',
    'signer',
    'human',
    'identity',
    'sign',
    'verify',
    'publish',
  ]);
  const provided = memoryEffects();
  issue(provided, { now, signer: provided.signer });
  assert.ok(!provided.calls.includes('signer'));
  const wrongTarget = memoryEffects();
  assert.throws(
    () => issue(wrongTarget, { now }, '0'.repeat(64)),
    code('TASK_REVISION_APPROVAL_INVALID'),
  );
  assert.deepEqual(wrongTarget.calls, []);
  const changedBaseline = memoryEffects();
  changedBaseline.repository.inspect = () => {
    changedBaseline.calls.push('inspect');
    return { ...gitState, head: '9'.repeat(40) };
  };
  assert.throws(
    () => issue(changedBaseline),
    code('TASK_REVISION_APPROVAL_STALE'),
  );
  assert.deepEqual(changedBaseline.calls, ['inspect']);
  const badClock = memoryEffects();
  assert.throws(
    () => issue(badClock, { now: new Date('invalid') }),
    code('TASK_REVISION_APPROVAL_INVALID'),
  );
  assert.deepEqual(badClock.calls, [
    'inspect',
    'policy',
    'origin',
    'signer',
    'human',
    'identity',
  ]);
  for (const phase of ['human', 'identity', 'sign', 'verify']) {
    const failing = memoryEffects(phase);
    assert.throws(
      () => issue(failing),
      phase === 'sign' || phase === 'verify'
        ? (error: unknown) =>
            code('TASK_REVISION_APPROVAL_SIGNATURE_INVALID')(error) &&
            (error as Error).cause === undefined
        : (error: unknown) => error === failing.failure,
    );
    assert.equal(failing.calls.at(-1), phase);
    assert.ok(!failing.calls.includes('publish'));
  }
  const malformed = memoryEffects();
  malformed.signer.sign = () => {
    malformed.calls.push('sign');
    return 'bad signature';
  };
  assert.throws(
    () => issue(malformed),
    code('TASK_REVISION_APPROVAL_SIGNATURE_INVALID'),
  );
  assert.equal(malformed.calls.at(-1), 'sign');
});

test('recovery reads immutable baseline policy at a later HEAD and verifies the selected trusted key', () => {
  const effects = memoryEffects();
  effects.repository.inspect = () => {
    effects.calls.push('inspect');
    return { ...gitState, head: '9'.repeat(40), tree: '8'.repeat(40) };
  };
  assert.deepEqual(
    read(effects, {
      now: new Date('2026-08-11T01:20:00.000Z'),
      allowExpired: true,
    }),
    record.envelope,
  );
  assert.deepEqual(effects.calls, [
    'inspect',
    'policy',
    'origin',
    'read',
    'selected-key',
  ]);
  const override = memoryEffects();
  read(override, { now, verifier: override.signer });
  assert.deepEqual(override.calls, [
    'inspect',
    'policy',
    'origin',
    'read',
    'verify',
  ]);
  const badRecord = memoryEffects();
  badRecord.records.read = () => {
    badRecord.calls.push('read');
    return { ...record, extra: true };
  };
  assert.throws(() => read(badRecord), code('TASK_REVISION_APPROVAL_INVALID'));
  assert.equal(badRecord.calls.at(-1), 'read');
  const badSignature = memoryEffects('selected-key');
  assert.throws(
    () => read(badSignature),
    code('TASK_REVISION_APPROVAL_SIGNATURE_INVALID'),
  );
  const badOverride = memoryEffects('verify');
  assert.throws(
    () => read(badOverride, { now, verifier: badOverride.signer }),
    code('TASK_REVISION_APPROVAL_SIGNATURE_INVALID'),
  );
});

test('origin faults retain issuance versus recovery errors before any signing or record read', () => {
  for (const operation of [issue, read]) {
    const expected =
      operation === issue
        ? 'TASK_REVISION_APPROVAL_INVALID'
        : 'TASK_REVISION_APPROVAL_STALE';
    const missing = memoryEffects('origin');
    assert.throws(() => operation(missing), code(expected));
    assert.deepEqual(missing.calls, ['inspect', 'policy', 'origin']);
    const mismatch = memoryEffects();
    mismatch.repository.origin = () => {
      mismatch.calls.push('origin');
      return 'different';
    };
    assert.throws(() => operation(mismatch), code(expected));
    assert.deepEqual(mismatch.calls, ['inspect', 'policy', 'origin']);
  }
});

test('private approval store preserves layout and configuration, content and semantic error boundaries', () => {
  const repositoryRoot = fs.realpathSync(createFixtureRepository());
  const repository = {
    ...gitState,
    repositoryRoot,
    gitCommonDirectory: path.join(repositoryRoot, '.git'),
  };
  try {
    const configPath = path.join(repositoryRoot, 'workflow/config.json');
    const configSource = fs.readFileSync(configPath, 'utf8');
    const config = JSON.parse(configSource);
    const published = taskRevisionApprovalRecords.publish(repository, record);
    assert.equal(published.approvalId, approvalId);
    assert.equal(
      published.recordPath,
      path.join(
        runtimePaths(repository.gitCommonDirectory, config.runtimeDirectory)
          .root,
        'task-revision-approvals',
        `${approvalId}.json`,
      ),
    );
    assert.deepEqual(
      taskRevisionApprovalRecords.read(repository, approvalId),
      record,
    );
    fs.writeFileSync(configPath, '{');
    assert.throws(
      () => taskRevisionApprovalRecords.read(repository, approvalId),
      code('UNREADABLE_CONTRACT'),
    );
    fs.writeFileSync(configPath, configSource);
    for (const candidate of [
      { ...record, schemaVersion: 2 },
      { ...record, extra: true },
    ]) {
      const bytes = `${JSON.stringify(candidate, null, 2)}\n`;
      const id = crypto.createHash('sha256').update(bytes).digest('hex');
      fs.writeFileSync(
        path.join(path.dirname(published.recordPath), `${id}.json`),
        bytes,
        { mode: 0o600 },
      );
      if (candidate.schemaVersion === 2) {
        assert.throws(
          () => taskRevisionApprovalRecords.read(repository, id),
          code('TASK_REVISION_APPROVAL_NOT_FOUND'),
        );
      } else {
        const readRecord = taskRevisionApprovalRecords.read(repository, id);
        assert.throws(
          () => assertTaskRevisionApprovalRecord(readRecord, id),
          code('TASK_REVISION_APPROVAL_INVALID'),
        );
      }
    }
  } finally {
    fs.rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

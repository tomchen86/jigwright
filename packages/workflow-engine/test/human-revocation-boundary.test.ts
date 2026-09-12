import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { readRepositoryDependencies } from './support/repository-dependency-graph.ts';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createHumanRevocationAuthorizer } from '../src/application/control-plane/human-revocation.ts';
import { createCollaborationGrantRevoker } from '../src/application/control-plane/collaboration-grant-revocation.ts';
import { createHumanResolutionGrantRevoker } from '../src/application/control-plane/human-resolution-grant-revocation.ts';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import {
  type HumanRevocationAuthorization,
  type HumanRevocationBinding,
  type HumanRevocationServices,
  digestHumanRevocationSubject,
} from '../src/modules/authority/human-revocation-contract.ts';
import type { MaintainerPolicy } from '../src/modules/authority/maintainer-policy.ts';
import type { MaintainerSignerProvider } from '../src/modules/authority/maintainer-signer-port.ts';
import type { AuthorityAuditEventInput } from '../src/modules/authority/authority-audit-contract.ts';
import { deriveAuthorityAuditRepositoryId } from '../src/modules/authority/authority-audit-contract.ts';
import {
  type CollaborationGrantEnvelope,
  COLLABORATION_GRANT_AUTHORIZED_EFFECT,
  COLLABORATION_GRANT_V2_SIGNATURE_NAMESPACE,
} from '../src/modules/authority/collaboration-grant-codec.ts';
import type { CollaborationRevocationTarget } from '../src/modules/authority/grant-revocation-contract.ts';
import type {
  HumanResolutionGrantStoreEntry,
  HumanResolutionRevocationStore,
} from '../src/modules/investigation/domain/human-resolution-grant-contract.ts';
import type { CollaborationGrantInspection } from '../src/modules/authority/collaboration-grant-records.ts';
import { projectInvestigationRuntimePaths } from '@jigwright/core/runtime-path-kernel';
import { assertPureDependencyClosure } from './support/pure-dependency-closure.ts';

const grantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const now = new Date('2026-08-18T00:00:00.000Z');
const policy: MaintainerPolicy = {
  schemaVersion: 1,
  repository: {
    id: 'github:fixture',
    origin: 'https://github.com/example/fixture.git',
  },
  phase: 'sealed',
  auditTagPrefix: 'refs/tags/workflow/',
  signatureNamespace: 'workflow.maintainer-grant.v1',
  maxTtlMinutes: 30,
  maxUses: 1,
  bootstrapEligiblePaths: [],
  sealedImmutablePaths: [],
  requiredChecks: ['check'],
  trustedSigners: [
    {
      identity: 'human',
      publicKey: 'ssh-ed25519 fixture',
      fingerprint: 'SHA256:fixture',
    },
  ],
};
const binding: HumanRevocationBinding = {
  subjectKind: 'human-resolution-grant',
  grantId,
  grantDigest: digestHumanRevocationSubject('grant'),
  repositoryId: policy.repository.id,
  repositoryOrigin: policy.repository.origin,
  changeId: 'change',
  taskId: null,
  workflowId: 'investigation',
  audit: {
    externalAuditRoot: '/audit',
    repositoryId: deriveAuthorityAuditRepositoryId(policy.repository.id),
  },
};
function memoryAuthorization() {
  const trace: string[] = [],
    preparations = new Map<string, HumanRevocationAuthorization>(),
    audits = new Map<string, AuthorityAuditEventInput>();
  let present = true;
  const sign = (payload: string, namespace?: string) =>
    crypto
      .createHash('sha256')
      .update(`${namespace}\0${payload}`)
      .digest('hex');
  const signer: MaintainerSignerProvider = {
    assertHumanPresent() {
      trace.push('human');
      if (!present) throw new Error('absent human');
    },
    identity() {
      trace.push('identity');
      return 'human';
    },
    sign(payload, namespace) {
      trace.push('sign');
      return sign(payload, namespace);
    },
    verify(payload, signature, identity, namespace) {
      trace.push('verify');
      assert.equal(identity, 'human');
      assert.equal(signature, sign(payload, namespace));
    },
  };
  const services: HumanRevocationServices = {
    now() {
      trace.push('clock');
      return now;
    },
    discoverRepository() {
      trace.push('repository');
      return { repositoryRoot: '/repository' };
    },
    loadCurrentPolicy() {
      trace.push('policy');
      return policy;
    },
    readRepositoryOrigin() {
      trace.push('origin');
      return policy.repository.origin;
    },
    createSigner() {
      trace.push('signer');
      return signer;
    },
    readOptionalPreparation(key) {
      trace.push('read-preparation');
      return preparations.get(key) ?? null;
    },
    persistExactPreparation(key, value) {
      trace.push('persist');
      const old = preparations.get(key);
      if (old) assert.deepEqual(value, old);
      else preparations.set(key, structuredClone(value));
    },
    verifyAuthorityAuditEvents() {
      trace.push('audit-verify');
    },
    recordAuthorityAuditEvent(_scope, input) {
      trace.push('audit-append');
      const old = audits.get(input.idempotencyKey);
      if (old) assert.deepEqual(input, old);
      else audits.set(input.idempotencyKey, structuredClone(input));
    },
  };
  return {
    trace,
    preparations,
    audits,
    signer,
    services,
    authorize: createHumanRevocationAuthorizer(services),
    setPresent(value: boolean) {
      present = value;
    },
  };
}

test('human revocation memory protocol preserves preparation, exact audit replay and current presence after crash', () => {
  const memory = memoryAuthorization(),
    crash = new Error('after audit');
  assert.deepEqual(memory.trace, []);
  assert.throws(
    () =>
      memory.authorize(
        '/repository',
        binding,
        {
          reason: 'revoke',
          testAfterAudit() {
            memory.trace.push('crash');
            throw crash;
          },
        },
        '/prepare',
      ),
    (error) => error === crash,
  );
  assert.deepEqual(memory.trace, [
    'clock',
    'repository',
    'policy',
    'origin',
    'signer',
    'human',
    'identity',
    'read-preparation',
    'sign',
    'verify',
    'persist',
    'audit-verify',
    'audit-append',
    'crash',
  ]);
  assert.equal(memory.preparations.size, 1);
  assert.equal(memory.audits.size, 1);
  memory.trace.length = 0;
  const replay = memory.authorize(
    '/repository',
    binding,
    { reason: 'revoke' },
    '/prepare',
  );
  assert.deepEqual(replay, memory.preparations.get('/prepare'));
  assert.deepEqual(memory.trace, [
    'clock',
    'repository',
    'policy',
    'origin',
    'signer',
    'human',
    'identity',
    'read-preparation',
    'verify',
    'persist',
    'audit-verify',
    'audit-append',
  ]);
  assert.equal(memory.audits.size, 1);
  memory.trace.length = 0;
  memory.setPresent(false);
  assert.throws(
    () =>
      memory.authorize(
        '/repository',
        binding,
        { reason: 'revoke' },
        '/prepare',
      ),
    /absent human/,
  );
  assert.deepEqual(memory.trace, [
    'clock',
    'repository',
    'policy',
    'origin',
    'signer',
    'human',
  ]);
});

test('human revocation refuses conflicting preparation before signature and propagates persistence failure before audit', () => {
  const memory = memoryAuthorization();
  const existing = memory.authorize(
    '/repository',
    binding,
    { reason: 'revoke' },
    '/prepare',
  );
  const other = memory.authorize(
    '/repository',
    binding,
    { reason: 'other' },
    '/other',
  );
  memory.trace.length = 0;
  assert.throws(
    () =>
      memory.authorize(
        '/repository',
        binding,
        { reason: 'revoke' },
        '/prepare',
        other,
      ),
    { code: 'HUMAN_REVOCATION_CONFLICT' },
  );
  assert.deepEqual(memory.trace, [
    'clock',
    'repository',
    'policy',
    'origin',
    'signer',
    'human',
    'identity',
    'read-preparation',
  ]);
  const failure = new Error('durable preparation failed');
  const authorize = createHumanRevocationAuthorizer({
    ...memory.services,
    persistExactPreparation() {
      throw failure;
    },
  });
  memory.trace.length = 0;
  assert.throws(
    () =>
      authorize(
        '/repository',
        binding,
        { reason: 'revoke', now, signer: memory.signer },
        '/prepare',
        existing,
      ),
    (error) => error === failure,
  );
  assert.deepEqual(memory.trace, [
    'repository',
    'policy',
    'origin',
    'human',
    'identity',
    'read-preparation',
    'verify',
  ]);
});

const envelope: CollaborationGrantEnvelope = {
  payload: {
    version: 2,
    signatureNamespace: COLLABORATION_GRANT_V2_SIGNATURE_NAMESPACE,
    grantId,
    repositoryId: policy.repository.id,
    repositoryOrigin: policy.repository.origin,
    policyBlob: '1'.repeat(40),
    collaborationPolicyDigest: '2'.repeat(64),
    changeId: 'change',
    taskId: null,
    baselineCommit: '3'.repeat(40),
    baselineTree: '4'.repeat(40),
    targetDigest: '5'.repeat(64),
    lifecyclePhase: 'plan-review',
    rolePair: { authorRole: 'plan-author', conflictingRole: 'plan-reviewer' },
    availableActor: {
      kind: 'provider',
      providerId: 'codex',
      assurance: 'runtime-hint',
    },
    degradedForm: 'same-provider-fresh-session',
    authorizedEffect: COLLABORATION_GRANT_AUTHORIZED_EFFECT,
    reason: 'fixture',
    issuedAt: now.toISOString(),
    expiresAt: '2026-08-18T00:30:00.000Z',
    maxUses: 1,
    signer: 'human',
  },
  signature: 'subject-signature',
};
function inspection(
  target: CollaborationRevocationTarget,
): CollaborationGrantInspection {
  const p = target.envelope.payload;
  return {
    grantId,
    version: p.version,
    signatureNamespace: p.signatureNamespace,
    authorizedEffect: p.authorizedEffect,
    state: target.state,
    changeId: p.changeId,
    taskId: p.taskId,
    lifecyclePhase: p.lifecyclePhase,
    targetDigest: p.targetDigest,
    degradedForm: p.degradedForm,
    issuedAt: p.issuedAt,
    expiresAt: p.expiresAt,
    signer: p.signer,
    signedEnvelopeDigest: digestHumanRevocationSubject(
      canonicalJson(target.envelope),
    ),
    ...(target.reason ? { terminalReason: target.reason } : {}),
  };
}

test('collaboration memory store keeps target observation and current human authorization inside the held transaction', () => {
  const memory = memoryAuthorization(),
    trace: string[] = [];
  let owned = false,
    loseAtPublication = false;
  let target: CollaborationRevocationTarget = {
    state: 'available',
    envelope,
    transitionDigest: null,
    reason: null,
    authorization: null,
  };
  const lockLost = new Error('lock lost');
  const assertOwned = () => {
    trace.push('owned');
    if (!owned) throw lockLost;
  };
  const revoke = createCollaborationGrantRevoker({
    now: () => {
      trace.push('clock');
      return now;
    },
    discoverRepository: () => {
      trace.push('repository');
      return { repositoryRoot: '/repository', gitCommonDirectory: '/git' };
    },
    taskMandate: {
      inspectTaskMandate() {
        throw new Error('null task must not inspect mandate');
      },
    },
    authorizeHumanRevocation(...args) {
      trace.push('authorize');
      assert.equal(owned, true);
      const value = memory.authorize(...args);
      if (loseAtPublication) owned = false;
      return value;
    },
    collaborationGrants: {
      canonicalCollaborationGrantEnvelope: (value) => canonicalJson(value),
    },
    withStoreLock(_common, _repository, operation) {
      trace.push('lock');
      owned = true;
      try {
        return operation({
          assertOwned,
          readTarget() {
            trace.push('read');
            assert.equal(owned, true);
            return structuredClone(target);
          },
          assertTarget(value) {
            trace.push('historical-policy');
            assert.equal(owned, true);
            assert.deepEqual(value, envelope);
          },
          authorizationPath: () => '/prepare',
          publish(_read, authorization) {
            trace.push('publish');
            assertOwned();
            target = {
              ...target,
              state: 'revoked',
              reason: authorization.payload.reason,
              authorization,
            };
            return inspection(target);
          },
        });
      } finally {
        owned = false;
        trace.push('unlock');
      }
    },
  });
  assert.deepEqual(trace, []);
  loseAtPublication = true;
  assert.throws(
    () => revoke('/repository', grantId, { reason: 'revoke' }),
    (error) => error === lockLost,
  );
  assert.equal(target.state, 'available');
  assert.equal(memory.preparations.size, 1);
  assert.deepEqual(trace, [
    'repository',
    'lock',
    'owned',
    'read',
    'clock',
    'historical-policy',
    'authorize',
    'publish',
    'owned',
    'unlock',
  ]);
  trace.length = 0;
  memory.trace.length = 0;
  loseAtPublication = false;
  const result = revoke('/repository', grantId, { reason: 'revoke' });
  assert.equal(result.state, 'revoked');
  assert.equal(memory.trace.includes('sign'), false);
  assert.equal(owned, false);
  assert.deepEqual(trace, [
    'repository',
    'lock',
    'owned',
    'read',
    'clock',
    'historical-policy',
    'authorize',
    'publish',
    'owned',
    'unlock',
  ]);
});

test('human-resolution memory store refuses prepared work before authorization and publishes only after exact authorization', () => {
  const memory = memoryAuthorization(),
    trace: string[] = [];
  let prepared = true;
  let entry: HumanResolutionGrantStoreEntry = {
    grantId,
    state: 'reserved',
    envelopeBytes: 'exact-envelope',
    terminalReason: null,
    recordedAt: null,
  };
  const store: HumanResolutionRevocationStore = {
    inspect() {
      trace.push('inspect');
      return structuredClone(entry);
    },
    hasPreparedJournal() {
      trace.push('journal');
      return prepared;
    },
    binding() {
      trace.push('binding');
      return binding;
    },
    authorizationPath: () => '/prepare',
    publish(_grantId, authorization) {
      trace.push('terminal-transaction');
      entry = {
        ...entry,
        state: 'revoked',
        terminalReason: authorization.payload.reason,
        recordedAt: authorization.payload.revokedAt,
        revocationAuthorization: authorization,
      };
      return structuredClone(entry);
    },
  };
  const revoke = createHumanResolutionGrantRevoker(
    (...args) => {
      trace.push('authorize');
      return memory.authorize(...args);
    },
    () => store,
  );
  const paths = projectInvestigationRuntimePaths('/git', 'workflow-engine');
  assert.throws(
    () => revoke(paths, '/repository', grantId, { reason: 'revoke' }),
    { code: 'HUMAN_RESOLUTION_RECOVERY_REQUIRED' },
  );
  assert.deepEqual(trace, ['inspect', 'journal']);
  assert.deepEqual(memory.trace, []);
  trace.length = 0;
  prepared = false;
  const revoked = revoke(paths, '/repository', grantId, { reason: 'revoke' });
  assert.equal(revoked.state, 'revoked');
  assert.deepEqual(trace, [
    'inspect',
    'journal',
    'binding',
    'authorize',
    'terminal-transaction',
  ]);
});

test('revocation application and canonical contracts have complete effect-free dependency closures', () => {
  for (const file of [
    'application/control-plane/human-revocation',
    'application/control-plane/collaboration-grant-revocation',
    'application/control-plane/human-resolution-grant-revocation',
    'modules/authority/grant-revocation-contract',
    'modules/investigation/domain/human-resolution-grant-contract',
  ]) {
    const root = fileURLToPath(new URL('../../../', import.meta.url));
    const entry = fileURLToPath(new URL(`../src/${file}.ts`, import.meta.url));
    if (file.startsWith('modules/')) {
      assertPureDependencyClosure(entry);
      continue;
    }
    const result = readRepositoryDependencies(root).read(entry);
    assert.deepEqual(result.effects, []);
    assert.deepEqual(result.problems, []);
    for (const edge of result.edges)
      assertPureDependencyClosure(path.join(root, edge.to));
  }
});

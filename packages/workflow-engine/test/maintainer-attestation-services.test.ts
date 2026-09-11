import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import test from 'node:test';
import {
  createAuthorityAttestationOperations,
  type AuthorityAttestationServices,
} from '../src/application/control-plane/maintainer-attestation.ts';
import type { AuthorityApplicationReceiptOperations } from '../src/modules/authority/authority-application-receipt.ts';
import {
  canonicalAttestationEnvelope,
  type AttestedCommitFacts,
} from '../src/modules/authority/authority-attestation.ts';
import type { MaintainerGrantV2Envelope } from '../src/modules/authority/maintainer-grant-v2-codec.ts';
import type { MaintainerPolicy } from '../src/modules/authority/maintainer-policy.ts';
import type { MaintainerSignerProvider } from '../src/modules/authority/maintainer-signer-port.ts';
import { readRepositoryDependencies } from './support/repository-dependency-graph.ts';
import { assertPureDependencyClosure } from './support/pure-dependency-closure.ts';

const oid = (char: string) => char.repeat(40);
const original = oid('a'),
  main = oid('b'),
  base = oid('c');
const grantId = '402b4c86-4b97-4c69-8c5c-bba5995b4387';
const signature =
  '-----BEGIN SSH SIGNATURE-----\nU1NIU0lHAAAAAQAAADMAAAAL\n-----END SSH SIGNATURE-----\n';
const message = `Apply reviewed authority\n\nChange: demo-change\nTransition: authority-maintenance\nGrant: ${grantId}\n`;
const request = {
  originalCommit: original,
  mainCommit: main,
  grantBasePairs: [],
};

function memoryAttestation() {
  const events: string[] = [];
  const publications: Parameters<
    AuthorityAttestationServices['createAttestationTag']
  >[] = [];
  const policy: MaintainerPolicy = {
    schemaVersion: 1,
    repository: {
      id: 'github:memory',
      origin: 'https://github.com/memory/repository.git',
    },
    phase: 'sealed',
    auditTagPrefix: 'refs/tags/workflow-maintainer/',
    signatureNamespace: 'workflow.maintainer-grant.v1',
    maxTtlMinutes: 30,
    maxUses: 1,
    bootstrapEligiblePaths: [],
    sealedImmutablePaths: [],
    requiredChecks: [],
    trustedSigners: [
      {
        identity: 'maintainer',
        publicKey: 'ssh-ed25519 memory-key',
        fingerprint: 'SHA256:memory',
      },
    ],
  };
  const state = {
    statusEntries: [] as string[],
    origin: policy.repository.origin,
    candidates: [main],
    candidateMessage: message,
    signatureFailure: null as Error | null,
    readFailure: null as Error | null,
    existingTag: '',
    clock: new Date('2026-09-10T12:00:00.000Z'),
  };
  const policyContent = JSON.stringify(policy);
  const digest = crypto
    .createHash('sha256')
    .update(policyContent)
    .digest('hex');
  const envelope: MaintainerGrantV2Envelope = {
    signatureNamespace: 'workflow.maintainer-grant.v2',
    signature,
    payload: {
      version: 2,
      grantId,
      repositoryId: policy.repository.id,
      repositoryOrigin: policy.repository.origin,
      baseCommit: base,
      policyBlob: oid('9'),
      policyDigest: digest,
      changeId: 'demo-change',
      taskId: 'authority-change',
      mandateBinding: {
        schemaVersion: 1,
        mandateTaskId: 'authority-change',
        mandateId: grantId,
        mandateDigest: digest,
        changeId: 'demo-change',
        externalAuditRoot: '/audit',
      },
      profile: 'authority-maintenance',
      profileVersion: 1,
      classification: 'ordinary',
      manifest: {
        schema: 'maintainer-patch-manifest.v2',
        profile: 'authority-maintenance',
        profileVersion: 1,
        trustBaseCommit: base,
        policyDigest: digest,
        files: [],
        patchDigest: digest,
      },
      manifestDigest: digest,
      patchDigest: digest,
      allowedPaths: [],
      evidenceOverlay: [],
      requiredChecks: [],
      evidenceWaivers: [],
      checkDependencies: {},
      checksAttestation: null,
      checksAttestationDigest: null,
      candidateBundle: null,
      candidateBundleDigest: null,
      effectsManifestDigest: null,
      issuedAt: '2026-09-10T11:55:00.000Z',
      expiresAt: '2026-09-10T12:05:00.000Z',
      maxUses: 1,
      reason: 'Approve the exact memory candidate',
      signer: 'maintainer',
    },
  };
  const signer: MaintainerSignerProvider = {
    assertHumanPresent() {
      events.push('human');
    },
    identity() {
      events.push('identity');
      return 'maintainer';
    },
    sign(payload, namespace) {
      events.push('sign');
      assert.equal(namespace, 'workflow.authority-attestation.v1');
      assert.equal(JSON.parse(payload).grantId, grantId);
      return signature;
    },
    verify(payload, value, identity, namespace) {
      events.push(`verify:${namespace}`);
      assert.equal(identity, 'maintainer');
      assert.equal(value, signature);
      assert.equal(JSON.parse(payload).grantId, grantId);
      if (
        namespace === 'workflow.authority-attestation.v1' &&
        state.signatureFailure
      )
        throw state.signatureFailure;
    },
  };
  const receipts: AuthorityApplicationReceiptOperations = {
    listAuthorityApplicationReceiptTagRefs() {
      assert.fail('An authority grant does not use an application receipt.');
    },
    readAuthorityApplicationReceiptTag() {
      assert.fail('An authority grant does not read an application receipt.');
    },
    verifyAuthorityApplicationReceiptSignature() {
      assert.fail('An authority grant does not verify an application receipt.');
    },
    publishAuthorityApplicationReceipt() {
      assert.fail('Attestation does not publish an application receipt.');
    },
  };
  const services: AuthorityAttestationServices = {
    discoverRepository(cwd) {
      assert.equal(cwd, '/caller');
      events.push('repository');
      return {
        repositoryRoot: '/repository',
        repositoryRealPath: '/repository',
        gitCommonDirectory: '/repository/.git',
        branch: 'work',
        head: main,
        tree: oid('1'),
        statusEntries: state.statusEntries,
      };
    },
    loadHeadPolicy(root) {
      assert.equal(root, '/repository');
      events.push('policy');
      return policy;
    },
    readRepositoryOrigin() {
      events.push('origin');
      return state.origin;
    },
    loadWorkflowConfig() {
      events.push('config');
      return {
        schemaVersion: 1,
        repositoryName: 'memory',
        changeRoot: 'changes',
        runtimeDirectory: '.workflow',
        protectedBranches: ['main'],
        branchTemplate: 'work/{changeId}',
      };
    },
    requireProtectedBaseRef(root, branch) {
      assert.equal(root, '/repository');
      assert.equal(branch, 'main');
      events.push('protected-ref');
      return 'refs/remotes/origin/main';
    },
    readAttestationCandidateLog(root, kind, ref) {
      assert.equal(root, '/repository');
      assert.equal(kind, 'authority');
      assert.equal(ref, 'refs/remotes/origin/main');
      events.push('candidates');
      return `${original}\n${state.candidates.join('\n')}\n`;
    },
    attestedFacts(root, commit): AttestedCommitFacts {
      assert.equal(root, '/repository');
      events.push(`facts:${commit}`);
      if (state.readFailure && commit !== original) throw state.readFailure;
      return {
        oid: commit,
        tree: oid('1'),
        parentOids: [base],
        parentTree: oid('2'),
        message: commit === original ? message : state.candidateMessage,
      };
    },
    assertOriginalCommitSignature(root, observedPolicy, commit) {
      assert.equal(root, '/repository');
      assert.equal(observedPolicy, policy);
      assert.equal(commit, original);
      events.push('original-signature');
    },
    assertMainContained(root, ref, commit) {
      assert.equal(root, '/repository');
      assert.equal(ref, 'refs/remotes/origin/main');
      assert.equal(commit, main);
      events.push('contained');
    },
    readGrantEnvelope(root, observedPolicy, id) {
      assert.equal(root, '/repository');
      assert.equal(observedPolicy, policy);
      assert.equal(id, grantId);
      events.push('grant');
      return envelope;
    },
    readPolicyContent(root, commit) {
      assert.equal(root, '/repository');
      assert.equal(commit, base);
      events.push('policy-content');
      return policyContent;
    },
    readPolicyBlob(root, commit) {
      assert.equal(root, '/repository');
      assert.ok(commit === base || commit === 'HEAD');
      events.push(`policy-blob:${commit}`);
      return oid('9');
    },
    readAuditTagRefs() {
      assert.fail('No base remapping was requested.');
    },
    readAttestationRef(root, ref) {
      assert.equal(root, '/repository');
      assert.equal(ref, `refs/tags/workflow-attestation/${grantId}`);
      events.push('tag');
      return state.existingTag;
    },
    createAttestationTag(...args) {
      events.push('publish');
      publications.push(args);
    },
    readHumanResolutionAuditTag() {
      assert.fail('No base remapping was requested.');
    },
    verifyHumanResolutionGrantEnvelope() {
      assert.fail('No human resolution was observed.');
    },
    createInteractiveSshSigner(root, observedPolicy) {
      assert.equal(root, '/repository');
      assert.equal(observedPolicy, policy);
      events.push('default-signer');
      return signer;
    },
    authorityAttestCommand(binding) {
      events.push('attest-command');
      return JSON.stringify(binding);
    },
    authorityTagPublishCommand(origin, ref) {
      events.push('publish-command');
      return `${origin} ${ref}`;
    },
    currentTime() {
      events.push('clock');
      return state.clock;
    },
  };
  const operations = createAuthorityAttestationOperations(services);
  return {
    operations,
    receipts,
    services,
    state,
    events,
    publications,
    envelope,
    policy,
    signer,
  };
}

test('attestation construction is inert and dirty/origin guards precede later reads', () => {
  const memory = memoryAttestation();
  assert.deepEqual(memory.events, []);
  memory.state.statusEntries.push('modified');
  assert.throws(
    () =>
      memory.operations.issueAuthorityAttestation(
        memory.receipts,
        '/caller',
        request,
      ),
    { code: 'AUTHORITY_ATTESTATION_DIRTY_WORKTREE' },
  );
  assert.deepEqual(memory.events, ['repository']);
  memory.events.length = 0;
  memory.state.statusEntries = [];
  memory.state.origin = 'another-origin';
  assert.throws(
    () =>
      memory.operations.issueAuthorityAttestation(
        memory.receipts,
        '/caller',
        request,
      ),
    { code: 'MAINTAINER_REPOSITORY_MISMATCH' },
  );
  assert.deepEqual(memory.events, ['repository', 'policy', 'origin']);
});

test('relay observes original signature before candidates and ignores only pair validation failures', () => {
  const memory = memoryAttestation();
  const result = memory.operations.projectAuthorityAttestationRelay(
    memory.receipts,
    '/caller',
    original,
  );
  assert.deepEqual(result.grantBasePairs, []);
  assert.equal(result.mainCommit, main);
  assert.deepEqual(memory.events.slice(0, 9), [
    'repository',
    'policy',
    'origin',
    `facts:${original}`,
    'original-signature',
    'config',
    'protected-ref',
    'candidates',
    `facts:${main}`,
  ]);
  const failure = new Error('Unable to observe the candidate object');
  memory.state.readFailure = failure;
  assert.throws(
    () =>
      memory.operations.projectAuthorityAttestationRelay(
        memory.receipts,
        '/caller',
        original,
      ),
    (error) => error === failure,
  );
  memory.state.readFailure = null;
  memory.state.candidateMessage = 'Unrelated transition';
  assert.throws(
    () =>
      memory.operations.projectAuthorityAttestationRelay(
        memory.receipts,
        '/caller',
        original,
      ),
    { code: 'AUTHORITY_ATTESTATION_RELAY_NOT_READY' },
  );
});

test('relay rereads candidates and rejects ambiguity without choosing a first match', () => {
  const memory = memoryAttestation();
  memory.state.candidates.push(oid('d'));
  assert.throws(
    () =>
      memory.operations.projectAuthorityAttestationRelay(
        memory.receipts,
        '/caller',
        original,
      ),
    { code: 'AUTHORITY_ATTESTATION_RELAY_AMBIGUOUS' },
  );
  memory.state.candidates.pop();
  assert.equal(
    memory.operations.projectAuthorityAttestationRelay(
      memory.receipts,
      '/caller',
      original,
    ).mainCommit,
    main,
  );
  assert.equal(
    memory.events.filter((event) => event === 'candidates').length,
    2,
  );
});

test('issue admits and signs exact bindings before publishing canonical bytes', () => {
  const memory = memoryAttestation();
  const result = memory.operations.issueAuthorityAttestation(
    memory.receipts,
    '/caller',
    request,
  );
  assert.deepEqual(memory.events, [
    'repository',
    'policy',
    'origin',
    'config',
    'protected-ref',
    `facts:${original}`,
    `facts:${main}`,
    'contained',
    'original-signature',
    'clock',
    'default-signer',
    'human',
    'grant',
    'policy-content',
    `policy-blob:${base}`,
    'verify:workflow.maintainer-grant.v2',
    'policy-blob:HEAD',
    'identity',
    'tag',
    'sign',
    'verify:workflow.authority-attestation.v1',
    'publish',
    'publish-command',
  ]);
  assert.deepEqual(memory.publications, [
    [
      '/repository',
      original,
      result.tagRef,
      canonicalAttestationEnvelope(result.envelope),
      'maintainer',
    ],
  ]);
  assert.equal(
    result.envelope.payload.issuedAt,
    memory.state.clock.toISOString(),
  );
});

test('explicit time and signer bypass defaults while invalid time stops before human presence', () => {
  const memory = memoryAttestation();
  const now = new Date('2026-09-10T12:01:00.000Z');
  const result = memory.operations.issueAuthorityAttestation(
    memory.receipts,
    '/caller',
    request,
    { now, signer: memory.signer },
  );
  assert.equal(result.envelope.payload.issuedAt, now.toISOString());
  assert.ok(!memory.events.includes('clock'));
  assert.ok(!memory.events.includes('default-signer'));
  memory.events.length = 0;
  assert.throws(
    () =>
      memory.operations.issueAuthorityAttestation(
        memory.receipts,
        '/caller',
        request,
        { now: new Date(NaN) },
      ),
    { code: 'AUTHORITY_ATTESTATION_INVALID' },
  );
  assert.ok(!memory.events.includes('human'));
  assert.ok(!memory.events.includes('clock'));
});

test('grant mismatch, duplicate tag and signature failures cannot publish', () => {
  const invalid = memoryAttestation();
  invalid.envelope.payload.policyDigest = 'wrong';
  assert.throws(
    () =>
      invalid.operations.issueAuthorityAttestation(
        invalid.receipts,
        '/caller',
        request,
      ),
    { code: 'AUTHORITY_ATTESTATION_GRANT_INVALID' },
  );
  assert.ok(!invalid.events.includes('sign'));
  assert.deepEqual(invalid.publications, []);
  const duplicate = memoryAttestation();
  duplicate.state.existingTag = oid('f');
  assert.throws(
    () =>
      duplicate.operations.issueAuthorityAttestation(
        duplicate.receipts,
        '/caller',
        request,
      ),
    { code: 'AUTHORITY_ATTESTATION_EXISTS' },
  );
  assert.ok(!duplicate.events.includes('sign'));
  assert.deepEqual(duplicate.publications, []);
  const signing = memoryAttestation();
  const failure = new Error('The attestation signature did not verify');
  signing.state.signatureFailure = failure;
  assert.throws(
    () =>
      signing.operations.issueAuthorityAttestation(
        signing.receipts,
        '/caller',
        request,
      ),
    (error) => error === failure,
  );
  assert.deepEqual(signing.publications, []);
  assert.ok(!signing.events.includes('publish-command'));
});

test('attestation application imports only complete pure value/type closures', () => {
  const root = path.resolve(import.meta.dirname, '../../..');
  const entry = path.join(
    import.meta.dirname,
    '../src/application/control-plane/maintainer-attestation.ts',
  );
  const dependencies = readRepositoryDependencies(root).read(entry);
  assert.deepEqual(dependencies.problems, []);
  for (const edge of dependencies.edges)
    assertPureDependencyClosure(path.join(root, edge.to));
});

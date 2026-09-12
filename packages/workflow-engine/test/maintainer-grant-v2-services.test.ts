import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import { createMaintainerGrantV2Operations } from '../src/application/control-plane/maintainer-grant-v2.ts';
import {
  buildImmutableCandidateBundleV2,
  assertCandidateSupportingArtifactsBinding,
  type CandidateSupportingArtifactSet,
  type ImmutableCandidateBundleV2,
} from '../src/modules/authority/maintainer-candidate-contracts.ts';
import { createRefGenerationLedger } from '../src/modules/authority/maintainer-candidate-ref-ledger.ts';
import {
  canonicalPatchManifest,
  type CapabilityProfile,
  type PatchManifest,
} from '../src/modules/authority/maintainer-manifest-contracts.ts';
import type { MaintainerManifestOperations } from '../src/modules/authority/maintainer-manifest.ts';
import type { MaintainerPolicy } from '../src/modules/authority/maintainer-policy.ts';
import type { MaintainerSignerProvider } from '../src/modules/authority/maintainer-signer-port.ts';
import type {
  MaintainerGrantV2IssueRequest,
  MaintainerGrantV2Services,
  MaintainerTaskMandateOperations,
} from '../src/modules/authority/maintainer-grant-v2.ts';
import {
  canonicalMaintainerGrantV2Envelope,
  digest,
  maintainerChecksEnvironmentDigest,
  type MaintainerChecksAttestationV2,
  type MaintainerGrantV2Envelope,
} from '../src/modules/authority/maintainer-grant-v2-codec.ts';
import type { CheckEvidence } from '../src/modules/assurance/check-evidence.ts';
import type { GitState } from '../src/modules/repository-consumer/repository-git-state.ts';
import {
  createSignedMaintainerGrantPublisher,
  type SignedGrantPublicationRuntime,
} from '../src/runtime/repository-transaction/maintainer-grant-v2-publication.ts';
import { readRequiredRefGenerationLedger } from '../src/runtime/repository-observation/maintainer-grant-v2.ts';
import { defaultSessionRuntimeLayoutPort } from '@jigwright/core/session-runtime-layout-port';

const oid = 'a'.repeat(40);
const nextOid = 'b'.repeat(40);
const tree = 'c'.repeat(40);
const hash = 'd'.repeat(64);
const now = new Date('2026-08-03T09:01:00.000Z');
const grantId = '33333333-3333-4333-8333-333333333333';
const signature =
  '-----BEGIN SSH SIGNATURE-----\nZmFrZQ==\n-----END SSH SIGNATURE-----\n';

function memoryProtocol() {
  const events: string[] = [];
  const policy: MaintainerPolicy = {
    schemaVersion: 1,
    repository: {
      id: 'github:R_memory',
      origin: 'https://github.com/example/memory.git',
    },
    phase: 'bootstrap',
    auditTagPrefix: 'refs/tags/maintainer-grants/',
    signatureNamespace: 'workflow.maintainer-grant.v1',
    maxTtlMinutes: 30,
    maxUses: 1,
    bootstrapEligiblePaths: ['packages/**'],
    sealedImmutablePaths: [],
    requiredChecks: ['fixture'],
    trustedSigners: [
      {
        identity: 'memory-maintainer',
        publicKey: 'ssh-ed25519 ZmFrZQ==',
        fingerprint: 'SHA256:fixturefixturefixturefixture',
      },
    ],
  };
  const policyContent = canonicalJson(policy);
  const profile: CapabilityProfile = {
    id: 'memory-profile',
    version: 1,
    authorityClass: 'ordinary',
    implementationPaths: ['packages/**'],
    evidencePaths: [],
    policyPaths: [],
    verificationInfrastructurePaths: [],
    forbiddenPaths: [],
    constraints: {
      evidenceOnlyGrantForbidden: true,
      samePackageRequired: false,
      evidenceAdditionsAllowed: false,
      maximumFiles: 20,
    },
    requiredChecks: ['fixture'],
    checkDependencies: { fixture: ['harness-engine', 'runner', 'source-tree'] },
  };
  const manifest: PatchManifest = {
    schema: 'maintainer-patch-manifest.v2',
    profile: profile.id,
    profileVersion: 1,
    trustBaseCommit: oid,
    policyDigest: digest(policyContent),
    files: [
      {
        path: 'packages/example/src/value.ts',
        role: 'implementation',
        operation: 'modify',
        beforeBlobOid: oid,
        afterSha256: hash,
        beforeMode: '100644',
        afterMode: '100644',
      },
    ],
    patchDigest: '',
  };
  manifest.patchDigest = digest(canonicalPatchManifest(manifest));
  const binding = {
    schemaVersion: 1 as const,
    mandateTaskId: 'memory-task',
    mandateId: '11111111-1111-4111-8111-111111111111',
    mandateDigest: hash,
    changeId: 'memory-change',
    externalAuditRoot: '/memory/audit',
  };
  const artifacts: CandidateSupportingArtifactSet = {
    effectsManifest: {
      schemaVersion: 1,
      kind: 'candidate-external-effects.v1',
      changeId: binding.changeId,
      mandateBinding: binding,
      effects: [],
    },
    providerInvocations: {
      schemaVersion: 1,
      kind: 'candidate-provider-invocations.v1',
      changeId: binding.changeId,
      mandateBinding: binding,
      invocations: [],
    },
    recoveryPlan: {
      schemaVersion: 1,
      kind: 'candidate-recovery-plan.v1',
      changeId: binding.changeId,
      mandateBinding: binding,
      targetRef: 'refs/heads/main',
      expectedOldCommit: oid,
      expectedRefGeneration: 0,
      candidateCommit: nextOid,
      rollbackTarget: oid,
    },
  };
  const evidence: CheckEvidence = {
    checkId: 'fixture',
    outcome: 'passed',
    exitCode: 0,
    runner: 'node',
    runnerDigest: hash,
    destructiveDatabase: false,
  };
  const attestation: MaintainerChecksAttestationV2 = {
    schemaVersion: 2,
    trustBaseCommit: oid,
    policyDigest: manifest.policyDigest,
    patchDigest: manifest.patchDigest,
    candidateStateDigest: hash,
    environmentDigest: maintainerChecksEnvironmentDigest(null),
    harnessEngineDigest: hash,
    checks: [
      {
        evidence,
        commandDigest: hash,
        startedAt: '2026-08-03T08:59:00.000Z',
        completedAt: '2026-08-03T09:00:00.000Z',
      },
    ],
  };
  const dependencySnapshot = {
    schemaVersion: 1 as const,
    sourceTree: tree,
    baseCommit: oid,
    harnessEngineDigest: hash,
    policyDigest: manifest.policyDigest,
    runnerDigests: { fixture: hash },
    externalStateDigests: { fixture: null },
  };
  const candidate = buildImmutableCandidateBundleV2({
    mandateBinding: binding,
    repositoryId: policy.repository.id,
    targetRef: 'refs/heads/main',
    expectedOldCommit: oid,
    expectedRefGeneration: 0,
    candidateCommit: nextOid,
    resultTree: tree,
    commitMessage: 'Apply memory candidate\n',
    manifest,
    checksAttestation: {
      schemaVersion: 3,
      candidateTree: tree,
      patchDigest: manifest.patchDigest,
      trustBaseCommit: oid,
      dependencySnapshot,
      checks: [
        {
          checkId: 'fixture',
          definitionDigest: hash,
          commandDigest: hash,
          runnerDigest: hash,
          environmentDigest: attestation.environmentDigest,
          resultDigest: digest(canonicalJson(evidence)),
          outcome: 'passed',
          startedAt: attestation.checks[0].startedAt,
          completedAt: attestation.checks[0].completedAt,
          reuseClass: 'toolchain-dependent',
          maxAgeMs: 86_400_000,
          externalSnapshotDigest: null,
          dependsOn: profile.checkDependencies.fixture,
        },
      ],
    },
    effectsManifestDigest: digest(canonicalJson(artifacts.effectsManifest)),
    providerInvocationsDigest: digest(
      canonicalJson(artifacts.providerInvocations),
    ),
    recoveryPlanDigest: digest(canonicalJson(artifacts.recoveryPlan)),
    classification: 'ordinary',
    createdAt: now.toISOString(),
  }).bundle;
  const candidates = new Map<string, ImmutableCandidateBundleV2>([
    [candidate.candidateBundleDigest, candidate],
  ]);
  const tags = new Map<string, string>();
  const available = new Map<string, string>();
  const terminal = new Map<string, MaintainerGrantV2Envelope>();
  const repository: GitState = {
    repositoryRoot: '/memory/repo',
    repositoryRealPath: '/memory/repo',
    gitCommonDirectory: '/memory/repo/.git',
    head: oid,
    tree,
    branch: 'main',
    statusEntries: [],
  };
  const faults = {
    missingLedger: false,
    collision: false,
    tokenFailure: false,
    tagFailure: false,
    foreignTag: false,
    lockLost: false,
    verificationFailure: false,
    mandateLost: false,
  };
  const failure = new Error('injected post-approval failure');
  const assertOwned = () => {
    events.push('owned');
    if (faults.lockLost) throw failure;
  };
  const persistence: SignedGrantPublicationRuntime = {
    maintainerGrantStorePaths(gitCommonDirectory) {
      const runtime = defaultSessionRuntimeLayoutPort.resolve({
        gitCommonDirectory,
        runtimeDirectory: 'workflow-engine',
      });
      const root = path.join(runtime.root, 'maintainer-grants');
      return {
        runtime,
        root,
        available: root + '/available',
        reserved: root + '/reserved',
        terminal: root + '/terminal',
        journals: root + '/journals',
        sessions: root + '/sessions',
      };
    },
    withRepositoryLifecycleOperation(_paths, operation) {
      events.push('lock');
      try {
        return operation(assertOwned);
      } finally {
        events.push('unlock');
      }
    },
    createMaintainerAuditTag(_repository, _base, ref) {
      events.push('tag');
      tags.set(ref, faults.foreignTag ? 'foreign' : nextOid);
      if (faults.tagFailure) throw failure;
      return nextOid;
    },
    storeCanonicalAvailableMaintainerGrantUnderLifecycleLock(
      _git,
      id,
      bytes,
      owned,
    ) {
      events.push('token');
      owned();
      if (faults.tokenFailure) throw failure;
      available.set(id, bytes);
      return '/memory/available/' + id;
    },
    terminallyFailSignedMaintainerGrantV2UnderLifecycleLock(
      _git,
      envelope,
      reason,
      _now,
      owned,
    ) {
      events.push('terminal');
      owned();
      terminal.set(envelope.payload.grantId, envelope);
      available.delete(envelope.payload.grantId);
      return { ...envelope.payload, state: 'failed', terminalReason: reason };
    },
    isPostApprovalAdmissionFailure: (error) => error === failure,
    enterActivePostApprovalTerminalCleanup() {
      events.push('cleanup');
    },
    exactPublishedAuditTagObject(_repository, ref) {
      events.push('read-exact-tag');
      return tags.get(ref) === nextOid ? nextOid : null;
    },
    deleteExpectedAuditTag(_repository, ref, expected) {
      events.push('delete-exact-tag');
      if (tags.get(ref) !== expected) throw new Error('CAS mismatch');
      tags.delete(ref);
    },
  };
  const publisher = createSignedMaintainerGrantPublisher(persistence);
  const signer: MaintainerSignerProvider = {
    identity() {
      events.push('identity');
      return 'memory-maintainer';
    },
    assertHumanPresent() {
      events.push('human');
    },
    sign() {
      events.push('sign');
      return signature;
    },
    verify() {
      events.push('verify');
      if (faults.verificationFailure) throw new Error('bad signature');
    },
  };
  const services: MaintainerGrantV2Services = {
    loadV2TrustContext() {
      events.push('trust');
      return {
        repository,
        policy,
        policyBlob: oid,
        policyDigest: manifest.policyDigest,
      };
    },
    assertUnusedGrant() {
      events.push('collision');
      if (faults.collision) throw failure;
      return '/memory/available/' + grantId;
    },
    discoverRepository() {
      events.push('rediscover');
      return repository;
    },
    currentChecksEnvironmentDigest() {
      events.push('environment');
      return attestation.environmentDigest;
    },
    currentCandidateDependencySnapshot() {
      events.push('dependencies');
      return dependencySnapshot;
    },
    readStoredImmutableCandidateBundle(_git, id) {
      events.push('candidate');
      const found = candidates.get(id);
      if (!found) throw failure;
      return found;
    },
    assertStoredCandidateSupportingArtifacts(_git, changeId, value) {
      events.push('support');
      return assertCandidateSupportingArtifactsBinding(
        changeId,
        value,
        artifacts.effectsManifest,
        artifacts.providerInvocations,
        artifacts.recoveryPlan,
      );
    },
    readRequiredRefGenerationLedger() {
      events.push('ledger');
      if (faults.missingLedger) throw failure;
      return createRefGenerationLedger(candidate.targetRef, oid);
    },
    readTargetRef() {
      events.push('ref');
      return oid;
    },
    readPolicyContent() {
      events.push('policy-bytes');
      return policyContent;
    },
    protectedCapabilityPaths() {
      events.push('protected');
      return [];
    },
    createInteractiveSshSigner() {
      events.push('signer');
      return signer;
    },
    isPostApprovalAdmissionFailure: (error) => error === failure,
    publishSignedMaintainerGrant: publisher,
    authorityTagPublishCommand(_origin, ref) {
      events.push('format');
      return `publish ${ref}`;
    },
    currentTime() {
      events.push('clock');
      return now;
    },
    randomGrantId() {
      events.push('random');
      return grantId;
    },
    currentEnvironment() {
      events.push('environment-default');
      return {};
    },
  };
  const manifests: MaintainerManifestOperations = {
    loadCapabilityProfileFromTrustBase() {
      events.push('profile');
      return profile;
    },
    buildMaintainerPatchManifest() {
      events.push('manifest');
      return manifest;
    },
    verifyPatchManifestAgainstWorktree() {},
    validatePatchManifestAgainstProfile() {
      events.push('validate-profile');
    },
  };
  const mandate: MaintainerTaskMandateOperations = {
    inspectActiveTaskMandateBinding() {
      events.push('mandate');
      return binding;
    },
    assertActiveTaskMandateBindingUnderLifecycleLock(_cwd, _expected, owned) {
      events.push('mandate-locked');
      owned();
      if (faults.mandateLost) throw failure;
      return binding;
    },
  };
  const operations = createMaintainerGrantV2Operations(services);
  const request: MaintainerGrantV2IssueRequest = {
    changeId: binding.changeId,
    reason: 'Apply exact memory candidate',
    manifest,
    checksAttestation: attestation,
    candidateBundle: candidate,
  };
  return {
    events,
    policy,
    profile,
    repository,
    request,
    candidates,
    tags,
    available,
    terminal,
    faults,
    failure,
    services,
    manifests,
    mandate,
    operations,
    signer,
    issue: () =>
      operations.issueMaintainerGrantV2(
        manifests,
        mandate,
        repository.repositoryRoot,
        request,
      ),
  };
}

test('V2 required services construct without observation and execute the complete memory publication protocol', () => {
  const state = memoryProtocol();
  assert.deepEqual(state.events, []);
  const result = state.issue();
  assert.equal(
    state.available.get(grantId),
    canonicalMaintainerGrantV2Envelope(result.envelope),
  );
  assert.deepEqual(state.events, [
    'trust',
    'profile',
    'manifest',
    'protected',
    'clock',
    'random',
    'collision',
    'rediscover',
    'environment-default',
    'environment',
    'dependencies',
    'candidate',
    'support',
    'mandate',
    'ledger',
    'ref',
    'signer',
    'identity',
    'human',
    'sign',
    'verify',
    'lock',
    'owned',
    'mandate-locked',
    'owned',
    'tag',
    'token',
    'owned',
    'unlock',
    'format',
  ]);
  assert.equal(state.operations.preflightMaintainerGrantV2.length, 3);
  assert.equal(state.operations.issueMaintainerGrantV2.length, 4);
  assert.equal(
    state.operations.validateMaintainerGrantV2AuthorityBinding.length,
    6,
  );
});

test('V2 read-only preflight does not select signer, clock, grant ID or publication', () => {
  const state = memoryProtocol();
  const result = state.operations.preflightMaintainerGrantV2(
    state.manifests,
    state.repository.repositoryRoot,
    { profileId: state.profile.id },
  );
  assert.equal(result.grantable, true);
  assert.deepEqual(state.events, ['trust', 'profile', 'manifest', 'protected']);
  assert.equal(state.available.size, 0);
});

test('V2 deterministic refusals precede human attention and durable publication', () => {
  for (const fault of ['missingLedger', 'collision'] as const) {
    const state = memoryProtocol();
    state.faults[fault] = true;
    assert.throws(state.issue, (error) => error === state.failure);
    assert.equal(state.events.includes('signer'), false);
    assert.equal(state.available.size, 0);
    assert.equal(state.tags.size, 0);
  }
  const state = memoryProtocol();
  const request = { ...state.request, candidateBundle: undefined };
  assert.throws(
    () =>
      state.operations.issueMaintainerGrantV2(
        state.manifests,
        state.mandate,
        '/memory/repo',
        request,
      ),
    { code: 'APPLY_CANDIDATE_REQUIRED' },
  );
  assert.deepEqual(state.events, []);
});

test('V2 signature rejection remains earlier than expired authority admission', () => {
  const state = memoryProtocol();
  const issued = state.issue();
  state.events.length = 0;
  state.faults.verificationFailure = true;
  assert.throws(
    () =>
      state.operations.validateMaintainerGrantV2AuthorityBinding(
        state.manifests,
        state.mandate,
        state.repository.repositoryRoot,
        issued.envelope,
        state.policy,
        {
          now: new Date('2026-09-01T00:00:00.000Z'),
          expectedBase: oid,
          expectedPolicyBlob: oid,
        },
      ),
    { code: 'AUTHORITY_SIGNATURE_INVALID' },
  );
  assert.deepEqual(state.events, ['rediscover', 'support', 'signer', 'verify']);
});

test('V2 publication rejects a changed signed envelope before locking', () => {
  const state = memoryProtocol();
  assert.throws(
    () =>
      state.operations.issueMaintainerGrantV2(
        state.manifests,
        state.mandate,
        '/memory/repo',
        state.request,
        {
          beforeGrantPublication: (envelope) => {
            envelope.payload.reason = 'changed after signing';
          },
        },
      ),
    { code: 'MAINTAINER_GRANT_PUBLICATION_MUTATED' },
  );
  assert.equal(state.events.includes('lock'), false);
  assert.equal(state.available.size, 0);
});

test('V2 memory protocol terminalizes post-approval failures before exact tag cleanup', () => {
  for (const fault of ['tokenFailure', 'tagFailure', 'mandateLost'] as const) {
    const state = memoryProtocol();
    state.faults[fault] = true;
    assert.throws(state.issue, (error) => error === state.failure);
    assert.equal(state.terminal.has(grantId), true);
    assert.equal(state.available.size, 0);
    assert.equal(state.tags.size, 0);
    const terminal = state.events.indexOf('terminal'),
      cleanup = state.events.indexOf('delete-exact-tag');
    assert.ok(terminal >= 0);
    assert.ok(cleanup === -1 || terminal < cleanup);
    assert.equal(state.events.at(-1), 'unlock');
  }
  const state = memoryProtocol();
  state.faults.tagFailure = true;
  state.faults.foreignTag = true;
  assert.throws(state.issue, (error) => error === state.failure);
  assert.equal(state.terminal.has(grantId), true);
  assert.equal([...state.tags.values()][0], 'foreign');
  assert.equal(state.events.includes('delete-exact-tag'), false);
});

test('V2 memory protocol refuses lost lifecycle ownership before publishing', () => {
  const state = memoryProtocol();
  state.faults.lockLost = true;
  assert.throws(state.issue, (error) => error === state.failure);
  assert.equal(state.tags.size, 0);
  assert.equal(state.available.size, 0);
  assert.equal(state.terminal.size, 0);
  assert.deepEqual(state.events.slice(-3), ['lock', 'owned', 'unlock']);
});

test('V2 required-existing ledger observation never creates missing durable state', () => {
  const gitCommonDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'v2-required-ledger-'),
  );
  try {
    assert.throws(
      () =>
        readRequiredRefGenerationLedger(gitCommonDirectory, 'refs/heads/main'),
      { code: 'APPLY_REF_LEDGER_MISSING' },
    );
    assert.deepEqual(fs.readdirSync(gitCommonDirectory), []);
  } finally {
    fs.rmSync(gitCommonDirectory, { recursive: true, force: true });
  }
});

import { fileURLToPath } from 'node:url';
import { assertPureDependencyClosure } from './support/pure-dependency-closure.ts';

test('V2 canonical candidate rules have no transitive effect dependencies', () => {
  for (const entry of [
    '../src/modules/authority/maintainer-grant-v2.ts',
    '../src/modules/authority/maintainer-candidate-contracts.ts',
    '../src/modules/authority/maintainer-candidate-ref-ledger.ts',
    '../src/modules/authority/maintainer-candidate-dependencies.ts',
  ])
    assertPureDependencyClosure(fileURLToPath(new URL(entry, import.meta.url)));
});

import { readRepositoryDependencies } from './support/repository-dependency-graph.ts';

test('V2 application delegates effects only through required services', () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const entry = fileURLToPath(
    new URL(
      '../src/application/control-plane/maintainer-grant-v2.ts',
      import.meta.url,
    ),
  );
  const observed = readRepositoryDependencies(root).read(entry);
  assert.deepEqual(observed.problems, []);
  assert.deepEqual(observed.effects, []);
  for (const edge of observed.edges)
    assertPureDependencyClosure(path.join(root, edge.to));
});

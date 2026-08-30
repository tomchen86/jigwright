import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import {
  assertSshPortableApprovalEvidenceV1,
  evaluateApprovalProfile,
  sshPortableApprovalEvidenceDigest,
  type VerifiedApprovalProof,
} from '../src/modules/authority/grant-approval.ts';
import {
  approvalSubjectDigest,
  type ApprovalSubject,
} from '../src/modules/authority/grant-core.ts';
import {
  codeOwnedApprovalModuleRegistry,
  GRANT_PROOF_SSH_V1_CONFIGURATION_DIGEST,
  HUMAN_GATE_MACOS_V1_CONFIGURATION_DIGEST,
  parseGrantPolicyV2,
} from '../src/modules/authority/grant-policy.ts';
import { isWorkflowError } from './fixture.ts';

const SUBJECT = approvalSubject();
const SUBJECT_DIGEST = approvalSubjectDigest(SUBJECT);

test('local-presence accepts a subject-bound macOS human proof without SSH', () => {
  const result = evaluateApprovalProfile(
    localPresencePolicy(),
    'local-presence',
    SUBJECT_DIGEST,
    [humanProof()],
  );

  assert.deepEqual(result.claims, ['fresh-local-device-owner']);
  assert.deepEqual(result.proofModules, [
    {
      moduleId: 'human-gate-macos',
      version: '1',
      claim: 'fresh-local-device-owner',
      proofDigest: digest('2'),
      identity: null,
      portableEvidence: null,
    },
  ]);
});

test('SSH portable proof evidence is exact and self-consistent', () => {
  const policy = sshPolicy();
  const proof = sshProof();
  assert.doesNotThrow(() =>
    evaluateApprovalProfile(policy, 'ssh', SUBJECT_DIGEST, [proof]),
  );
  for (const portableEvidence of [
    { ...proof.portableEvidence!, signature: 'tampered-signature' },
    {
      ...proof.portableEvidence!,
      verifiedAt: '2026-08-18T03:00:01.000Z',
    },
    { ...proof.portableEvidence!, identity: 'different-maintainer' },
    { ...proof.portableEvidence!, payload: canonicalJson({ tampered: true }) },
  ]) {
    assert.throws(
      () =>
        evaluateApprovalProfile(policy, 'ssh', SUBJECT_DIGEST, [
          { ...proof, portableEvidence },
        ]),
      (error) => isWorkflowError(error, 'GRANT_APPROVAL_PROOF_INVALID'),
    );
  }
  assert.throws(
    () =>
      evaluateApprovalProfile(policy, 'ssh', SUBJECT_DIGEST, [
        { ...proof, proofDigest: digest('f') },
      ]),
    (error) => isWorkflowError(error, 'GRANT_APPROVAL_PROOF_INVALID'),
  );
});

test('SSH independently satisfies the explicit SSH profile', () => {
  const policy = parseGrantPolicyV2(
    {
      ...localPresencePolicyInput(),
      profiles: {
        'local-presence': {
          requiredClaims: ['fresh-local-device-owner'],
        },
        ssh: { requiredClaims: ['ssh-signature'] },
      },
      approvalModules: [
        ...localPresencePolicyInput().approvalModules,
        {
          moduleId: 'grant-proof-ssh',
          version: '1',
          allowedClaims: ['ssh-signature'],
          configurationDigest: GRANT_PROOF_SSH_V1_CONFIGURATION_DIGEST,
        },
      ],
      optionalSsh: {
        signatureNamespace: 'expense-app.workflow.grant.v2',
        trustedSigners: [
          {
            identity: 'maintainer',
            publicKey:
              'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJL6dVljsgm9EAbjCiOhA/tKsgApOhKmcB/NRewL1uns',
            fingerprint: 'SHA256:7UB1aHADtIMUJBFt3sjo9RwoBDgCKc1B1GlEucUDL4U',
          },
        ],
      },
    },
    { registry: codeOwnedApprovalModuleRegistry() },
  );

  const evaluated = evaluateApprovalProfile(policy, 'ssh', SUBJECT_DIGEST, [
    sshProof(),
  ]);
  assert.deepEqual(evaluated.claims, ['ssh-signature']);
  assert.equal(evaluated.proofModules[0]?.identity, 'maintainer');
  assert.throws(
    () =>
      evaluateApprovalProfile(policy, 'ssh', SUBJECT_DIGEST, [
        sshProof(),
        humanProof(),
      ]),
    (error) => isWorkflowError(error, 'GRANT_APPROVAL_PROFILE_UNSATISFIED'),
  );
});

test('proofs cannot self-assert another subject, module, or claim', () => {
  for (const proof of [
    { ...humanProof(), approvalSubjectDigest: digest('f') },
    { ...humanProof(), moduleId: 'agent-always-approves' },
    { ...humanProof(), claims: ['ssh-signature'] },
  ]) {
    assert.throws(
      () =>
        evaluateApprovalProfile(
          localPresencePolicy(),
          'local-presence',
          SUBJECT_DIGEST,
          [proof as VerifiedApprovalProof],
        ),
      (error) => isWorkflowError(error, 'GRANT_APPROVAL_PROOF_INVALID'),
    );
  }
});

function localPresencePolicy() {
  return parseGrantPolicyV2(localPresencePolicyInput(), {
    registry: codeOwnedApprovalModuleRegistry(),
  });
}

function localPresencePolicyInput() {
  return {
    schemaVersion: 2,
    defaultProfile: 'local-presence',
    profiles: {
      'local-presence': {
        requiredClaims: ['fresh-local-device-owner'],
      },
    },
    approvalModules: [
      {
        moduleId: 'human-gate-macos',
        version: '1',
        allowedClaims: ['fresh-local-device-owner'],
        configurationDigest: HUMAN_GATE_MACOS_V1_CONFIGURATION_DIGEST,
      },
    ],
    legacyVerification: {
      maintainerPolicyV1: 'read-only',
    },
  };
}

function humanProof(): VerifiedApprovalProof {
  return {
    moduleId: 'human-gate-macos',
    version: '1',
    claims: ['fresh-local-device-owner'],
    approvalSubjectDigest: SUBJECT_DIGEST,
    proofDigest: digest('2'),
    verifiedAt: '2026-08-18T03:00:00.000Z',
    identity: null,
    portableEvidence: null,
  };
}

function sshProof(): VerifiedApprovalProof {
  const identity = 'maintainer';
  const verifiedAt = '2026-08-18T03:00:00.000Z';
  const portableEvidence = assertSshPortableApprovalEvidenceV1({
    schemaVersion: 1,
    kind: 'grant-proof-ssh-portable-evidence.v1',
    payload: canonicalJson({
      schemaVersion: 1,
      kind: 'grant-proof-ssh-subject.v1',
      approvalSubject: SUBJECT,
      approvalSubjectDigest: SUBJECT_DIGEST,
      signerIdentity: identity,
    }),
    signature: 'fixture-signature',
    signatureNamespace: 'expense-app.workflow.grant.v2',
    identity,
    verifiedAt,
  });
  return {
    moduleId: 'grant-proof-ssh',
    version: '1',
    claims: ['ssh-signature'],
    approvalSubjectDigest: SUBJECT_DIGEST,
    proofDigest: sshPortableApprovalEvidenceDigest(portableEvidence),
    verifiedAt,
    identity,
    portableEvidence,
  };
}

function sshPolicy() {
  return parseGrantPolicyV2(
    {
      ...localPresencePolicyInput(),
      profiles: {
        'local-presence': {
          requiredClaims: ['fresh-local-device-owner'],
        },
        ssh: { requiredClaims: ['ssh-signature'] },
      },
      approvalModules: [
        ...localPresencePolicyInput().approvalModules,
        {
          moduleId: 'grant-proof-ssh',
          version: '1',
          allowedClaims: ['ssh-signature'],
          configurationDigest: GRANT_PROOF_SSH_V1_CONFIGURATION_DIGEST,
        },
      ],
      optionalSsh: {
        signatureNamespace: 'expense-app.workflow.grant.v2',
        trustedSigners: [
          {
            identity: 'maintainer',
            publicKey:
              'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJL6dVljsgm9EAbjCiOhA/tKsgApOhKmcB/NRewL1uns',
            fingerprint: 'SHA256:7UB1aHADtIMUJBFt3sjo9RwoBDgCKc1B1GlEucUDL4U',
          },
        ],
      },
    },
    { registry: codeOwnedApprovalModuleRegistry() },
  );
}

function approvalSubject(): ApprovalSubject {
  const reason = 'Use an exact portable SSH proof.';
  return {
    schemaVersion: 1,
    kind: 'grant-approval-subject.v1',
    challengeDigest: digest('1'),
    choiceId: digest('2'),
    approvalMethod: 'ssh',
    reasonCode: 'portable-approval',
    reason,
    reasonDigest: `sha256:${crypto
      .createHash('sha256')
      .update(canonicalJson(reason))
      .digest('hex')}`,
    stateDigest: digest('3'),
    expiresAt: '2026-08-18T03:10:00.000Z',
    sessionNonce: 'nonce-approval-111111111111111111111111',
  };
}

function digest(character: string): `sha256:${string}` {
  return `sha256:${character.repeat(64)}`;
}

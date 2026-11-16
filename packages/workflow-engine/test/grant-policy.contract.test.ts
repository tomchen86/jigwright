import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  APPROVAL_CLAIMS as PUBLIC_APPROVAL_CLAIMS,
  type ApprovalClaim as PublicApprovalClaim,
  type GrantPolicyV2 as PublicGrantPolicyV2,
} from '@jigwright/grants/central-grant-contracts';

import {
  APPROVAL_CLAIMS,
  approvalMethodsForPolicy,
  codeOwnedApprovalModuleRegistry,
  GRANT_PROOF_SSH_V1_CONFIGURATION_DIGEST,
  HUMAN_GATE_MACOS_V1_CONFIGURATION_DIGEST,
  parseGrantPolicyV2,
  type ApprovalClaim,
  type GrantPolicyV2,
} from '../src/modules/authority/grant-policy.ts';
import { loadGrantPolicyV2 } from '../src/runtime/repository-observation/grant-policy-reader.ts';
import { parseGrantPolicyV2Document as parsePublicGrantPolicyV2Document } from '../src/composition-root/public/central-grant.ts';
import { isWorkflowError } from './fixture.ts';

test('tracked GrantPolicyV2 defaults to local presence and offers SSH separately', () => {
  const repositoryRoot = path.resolve(import.meta.dirname, '../../..');
  const loaded = loadGrantPolicyV2(repositoryRoot);

  assert.equal(loaded.policy.defaultProfile, 'local-presence');
  assert.deepEqual(loaded.policy.profiles['local-presence']?.requiredClaims, [
    'fresh-local-device-owner',
  ]);
  assert.deepEqual(
    loaded.policy.approvalModules.map(({ moduleId }) => moduleId),
    ['human-gate-macos', 'grant-proof-ssh'],
  );
  assert.deepEqual(approvalMethodsForPolicy(loaded.policy), [
    'human-presence',
    'ssh',
  ]);
  assert.equal(loaded.policy.optionalSsh?.trustedSigners.length, 1);
  assert.match(loaded.digest, /^[0-9a-f]{64}$/);
});

test('the public GrantPolicyV2 and ApprovalClaim union exactly match the live contract', () => {
  const repositoryRoot = path.resolve(import.meta.dirname, '../../..');
  const livePolicy = loadGrantPolicyV2(repositoryRoot).policy;
  const publicPolicy: PublicGrantPolicyV2 = livePolicy;
  const livePolicyAgain: GrantPolicyV2 = publicPolicy;
  const publicClaims: readonly PublicApprovalClaim[] = APPROVAL_CLAIMS;
  const liveClaims: readonly ApprovalClaim[] = PUBLIC_APPROVAL_CLAIMS;

  assert.equal(publicPolicy.defaultProfile, 'local-presence');
  assert.deepEqual(publicPolicy.optionalSsh, livePolicy.optionalSsh);
  assert.equal(livePolicyAgain, publicPolicy);
  assert.deepEqual(publicClaims, liveClaims);
});

test('GrantPolicyV2 loader rejects a symlinked policy document', () => {
  const repository = fs.mkdtempSync(
    path.join(os.tmpdir(), 'grant-policy-symlink-'),
  );
  try {
    const workflowDirectory = path.join(repository, 'workflow');
    fs.mkdirSync(workflowDirectory);
    const target = path.join(repository, 'policy-target.json');
    fs.writeFileSync(target, JSON.stringify(policyInput()));
    fs.symlinkSync(target, path.join(workflowDirectory, 'grant-policy.json'));

    assert.throws(
      () => loadGrantPolicyV2(repository),
      (error) => isWorkflowError(error, 'GRANT_POLICY_INVALID'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('GrantPolicyV2 defaults to local human presence without requiring SSH configuration', () => {
  const policy = parseGrantPolicyV2(policyInput(), {
    registry: codeOwnedApprovalModuleRegistry(),
  });

  assert.equal(policy.defaultProfile, 'local-presence');
  assert.deepEqual(policy.profiles['local-presence']?.requiredClaims, [
    'fresh-local-device-owner',
  ]);
  assert.equal(policy.optionalSsh, undefined);
});

test('GrantPolicy current contract rejects retired legacy verification in the engine parser', () => {
  const registry = codeOwnedApprovalModuleRegistry();
  const policy = parseGrantPolicyV2(policyInput(), { registry });

  assert.deepEqual(Object.keys(policy).sort(), [
    'approvalModules',
    'defaultProfile',
    'profiles',
    'schemaVersion',
  ]);
  assert.throws(
    () =>
      parseGrantPolicyV2(
        {
          ...policyInput(),
          legacyVerification: { maintainerPolicyV1: 'read-only' },
        },
        { registry },
      ),
    (error) => isWorkflowError(error, 'GRANT_POLICY_INVALID'),
  );
});

test('GrantPolicy current contract rejects retired legacy verification in the public parser', () => {
  const parsed = parsePublicGrantPolicyV2Document(
    JSON.stringify(policyInput()),
  ).policy;

  assert.deepEqual(Object.keys(parsed).sort(), [
    'approvalModules',
    'defaultProfile',
    'profiles',
    'schemaVersion',
  ]);
  assert.throws(
    () =>
      parsePublicGrantPolicyV2Document(
        JSON.stringify({
          ...policyInput(),
          legacyVerification: { maintainerPolicyV1: 'read-only' },
        }),
      ),
    (error) => isWorkflowError(error, 'GRANT_POLICY_INVALID'),
  );
});

test('GrantPolicy current contract has exact tracked config and schema keys', () => {
  const repositoryRoot = path.resolve(import.meta.dirname, '../../..');
  const policyDocument = fs.readFileSync(
    path.join(repositoryRoot, 'workflow/grant-policy.json'),
    'utf8',
  );
  const schemaDocument = fs.readFileSync(
    path.join(repositoryRoot, 'workflow/schemas/grant-policy.schema.json'),
    'utf8',
  );
  const policy = JSON.parse(policyDocument) as Record<string, unknown>;
  const schema = JSON.parse(schemaDocument) as {
    required: string[];
    properties: Record<string, unknown>;
  };

  assert.deepEqual(Object.keys(policy).sort(), [
    'approvalModules',
    'defaultProfile',
    'optionalSsh',
    'profiles',
    'schemaVersion',
  ]);
  assert.deepEqual(schema.required, [
    'schemaVersion',
    'defaultProfile',
    'profiles',
    'approvalModules',
  ]);
  assert.deepEqual(Object.keys(schema.properties).sort(), [
    'approvalModules',
    'defaultProfile',
    'optionalSsh',
    'profiles',
    'schemaVersion',
  ]);
  assert.doesNotMatch(policyDocument, /legacyVerification|maintainerPolicyV1/u);
  assert.doesNotMatch(schemaDocument, /legacyVerification|maintainerPolicyV1/u);
});

test('SSH is an explicit alternative method while local presence remains the default', () => {
  const policy = parseGrantPolicyV2(sshPolicyInput(), {
    registry: codeOwnedApprovalModuleRegistry(),
  });

  assert.equal(policy.defaultProfile, 'local-presence');
  assert.deepEqual(policy.profiles.ssh?.requiredClaims, ['ssh-signature']);
  assert.deepEqual(approvalMethodsForPolicy(policy), ['human-presence', 'ssh']);

  assert.throws(
    () =>
      parseGrantPolicyV2(
        {
          ...sshPolicyInput(),
          profiles: {
            ...sshPolicyInput().profiles,
            ssh: {
              requiredClaims: ['fresh-local-device-owner', 'ssh-signature'],
            },
          },
        },
        { registry: codeOwnedApprovalModuleRegistry() },
      ),
    (error) => isWorkflowError(error, 'GRANT_POLICY_SSH_CONFIGURATION_INVALID'),
  );
});

test('policy cannot load an arbitrary module or let a module claim unregistered assurance', () => {
  const registry = codeOwnedApprovalModuleRegistry();
  assert.throws(
    () =>
      parseGrantPolicyV2(
        {
          ...policyInput(),
          approvalModules: [
            {
              moduleId: 'agent-always-approves',
              version: '1',
              allowedClaims: ['fresh-local-device-owner'],
              configurationDigest: HUMAN_GATE_MACOS_V1_CONFIGURATION_DIGEST,
            },
          ],
        },
        { registry },
      ),
    (error) => isWorkflowError(error, 'GRANT_POLICY_MODULE_UNTRUSTED'),
  );

  assert.throws(
    () =>
      parseGrantPolicyV2(
        {
          ...policyInput(),
          approvalModules: [
            {
              moduleId: 'human-gate-macos',
              version: '1',
              allowedClaims: ['fresh-local-device-owner', 'ssh-signature'],
              configurationDigest: HUMAN_GATE_MACOS_V1_CONFIGURATION_DIGEST,
            },
          ],
        },
        { registry },
      ),
    (error) => isWorkflowError(error, 'GRANT_POLICY_MODULE_CLAIM_INVALID'),
  );
});

function policyInput() {
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
  };
}

function sshPolicyInput() {
  return {
    ...policyInput(),
    profiles: {
      ...policyInput().profiles,
      ssh: { requiredClaims: ['ssh-signature'] },
    },
    approvalModules: [
      ...policyInput().approvalModules,
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
  };
}

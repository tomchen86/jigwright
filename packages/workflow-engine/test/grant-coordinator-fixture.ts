import { HUMAN_GATE_MACOS_V1_CONFIGURATION_DIGEST } from '../src/modules/authority/grant-policy.ts';
import { type VerifiedApprovalProof } from '../src/modules/authority/grant-approval.ts';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const NOW = new Date('2026-08-18T04:00:00.000Z');

export const CHALLENGE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

export const OPERATION_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

export function policyInput() {
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

export function humanProof(
  subjectDigest: `sha256:${string}`,
): VerifiedApprovalProof {
  return {
    moduleId: 'human-gate-macos',
    version: '1',
    claims: ['fresh-local-device-owner'],
    approvalSubjectDigest: subjectDigest,
    proofDigest: digest('4'),
    verifiedAt: NOW.toISOString(),
    identity: null,
    portableEvidence: null,
  };
}

export async function withRuntime(
  operation: (runtimeRoot: string) => Promise<void>,
): Promise<void> {
  const runtimeRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'grant-coordinator-'),
  );
  try {
    await operation(fs.realpathSync(runtimeRoot));
  } finally {
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  }
}

export function digest(character: string): `sha256:${string}` {
  return `sha256:${character.repeat(64)}`;
}

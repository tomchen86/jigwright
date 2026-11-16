/** Reads exact Git evidence and verifies original commit signatures for attestation. */
import fs from 'node:fs';
import {
  resolveBlobOid,
  resolveCommitOid,
  resolveTreeOid,
} from '../repository-transaction/git-object-ids.ts';
import os from 'node:os';
import path from 'node:path';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import {
  COMMIT_OID,
  invalidRequest,
  grantMissing,
  grantInvalid,
} from '../../modules/authority/authority-attestation-admission.ts';
import type { AttestedCommitFacts } from '../../modules/authority/authority-attestation.ts';
import {
  parseMaintainerPolicy,
  type MaintainerPolicy,
} from '../../modules/authority/maintainer-policy.ts';
import {
  parseMaintainerGrantV2Envelope,
  type MaintainerGrantV2Envelope,
} from '../../modules/authority/maintainer-grant-v2-codec.ts';
import { commitFacts } from '../repository-transaction/git-transitions.ts';
import {
  LOCAL_PROTECTED_BASE_REF,
  resolveProtectedBaseRef,
  runGit,
} from '../repository-transaction/git.ts';
import {
  readFileAtRevision,
  readTagObject,
} from '../repository-transaction/git-command.ts';

const MAINTAINER_POLICY_PATH = 'workflow/maintainer-policy.json';
export function loadHeadPolicy(repositoryRoot: string): MaintainerPolicy {
  try {
    return parseMaintainerPolicy(
      JSON.parse(
        runGit(repositoryRoot, ['show', `HEAD:${MAINTAINER_POLICY_PATH}`]),
      ),
    );
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error) {
      throw error;
    }
    throw workflowError(
      'MAINTAINER_POLICY_INVALID',
      'The repository head does not contain a valid maintainer policy.',
      ExitCode.guard,
    );
  }
}

export function readGrantEnvelope(
  repositoryRoot: string,
  policy: MaintainerPolicy,
  grantId: string,
): MaintainerGrantV2Envelope {
  const tagRef = `${policy.auditTagPrefix}${grantId}`;
  if (!runGit(repositoryRoot, ['rev-parse', '--verify', tagRef], true).trim()) {
    throw grantMissing(grantId);
  }
  if (runGit(repositoryRoot, ['cat-file', '-t', tagRef]).trim() !== 'tag') {
    throw grantInvalid(grantId);
  }
  const raw = readTagObject(repositoryRoot, tagRef);
  const boundary = raw.indexOf('\n\n');
  if (boundary === -1) {
    throw grantInvalid(grantId);
  }
  const rawEnvelope = raw.slice(boundary + 2);
  const envelope = parseMaintainerGrantV2Envelope(rawEnvelope);
  const target = resolveCommitOid(repositoryRoot, tagRef);
  if (
    envelope.payload.grantId !== grantId ||
    envelope.payload.baseCommit !== target
  ) {
    throw grantInvalid(grantId);
  }
  return envelope;
}

export function attestedFacts(
  repositoryRoot: string,
  commitOid: string,
): AttestedCommitFacts {
  if (!COMMIT_OID.test(commitOid)) {
    throw invalidRequest(
      'Authority attestation requests need full commit object IDs.',
    );
  }
  const facts = commitFacts(repositoryRoot, commitOid);
  const parentTree =
    facts.parents.length === 1
      ? resolveTreeOid(repositoryRoot, facts.parents[0])
      : undefined;
  return {
    oid: facts.hash,
    tree: facts.tree,
    parentOids: facts.parents,
    parentTree,
    message: facts.message,
  };
}

export function assertMainContained(
  repositoryRoot: string,
  protectedRef: string,
  commitOid: string,
): void {
  try {
    runGit(repositoryRoot, [
      'merge-base',
      '--is-ancestor',
      commitOid,
      protectedRef,
    ]);
  } catch {
    throw mainUnreachable(commitOid, protectedRef);
  }
}

export function assertOriginalCommitSignature(
  repositoryRoot: string,
  policy: MaintainerPolicy,
  commitOid: string,
): void {
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-attest-signers-'),
  );
  fs.chmodSync(temporaryDirectory, 0o700);
  const allowedSignersPath = path.join(temporaryDirectory, 'allowed-signers');
  try {
    fs.writeFileSync(
      allowedSignersPath,
      policy.trustedSigners
        .map(
          (signer) =>
            `${signer.identity} namespaces="git" ${signer.publicKey}\n`,
        )
        .join(''),
      { encoding: 'utf8', mode: 0o600 },
    );
    runGit(repositoryRoot, [
      '-c',
      `gpg.ssh.allowedSignersFile=${allowedSignersPath}`,
      'verify-commit',
      commitOid,
    ]);
  } catch {
    throw workflowError(
      'AUTHORITY_ATTESTATION_SIGNATURE_INVALID',
      'The original authority commit is not signed by a trusted maintainer key.',
      ExitCode.verification,
    );
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}
function mainUnreachable(identity: string, protectedRef: string) {
  return workflowError(
    'AUTHORITY_ATTESTATION_MAIN_UNREACHABLE',
    protectedRef === LOCAL_PROTECTED_BASE_REF
      ? `${identity} is not contained in the selected protected base.`
      : `${identity} is not contained in the fetched protected branch.`,
    ExitCode.verification,
  );
}

export function requireProtectedBaseRef(
  repositoryRoot: string,
  protectedBranch: string,
): string {
  const protectedRef = resolveProtectedBaseRef(repositoryRoot, protectedBranch);
  if (
    !runGit(
      repositoryRoot,
      ['rev-parse', '--verify', protectedRef],
      true,
    ).trim()
  ) {
    throw mainUnreachable(protectedRef, protectedRef);
  }
  return protectedRef;
}
export function readRepositoryOrigin(repositoryRoot: string): string {
  return runGit(repositoryRoot, ['remote', 'get-url', 'origin']).trim();
}
export function readAttestationCandidateLog(
  repositoryRoot: string,
  kind: 'authority' | 'authority-candidate',
  protectedRef: string,
): string {
  return runGit(repositoryRoot, [
    'log',
    '--first-parent',
    '--format=%H',
    '--fixed-strings',
    `--grep=Transition: ${kind}`,
    protectedRef,
  ]);
}
export function readPolicyContent(
  repositoryRoot: string,
  baseCommit: string,
): string {
  return readFileAtRevision(
    repositoryRoot,
    baseCommit,
    `${MAINTAINER_POLICY_PATH}`,
  );
}
export function readPolicyBlob(
  repositoryRoot: string,
  baseCommit: string,
): string {
  return resolveBlobOid(
    repositoryRoot,
    baseCommit,
    `${MAINTAINER_POLICY_PATH}`,
  );
}
export function readAuditTagRefs(
  repositoryRoot: string,
  prefix: string,
): string[] {
  return runGit(repositoryRoot, [
    'for-each-ref',
    '--format=%(refname)',
    prefix.endsWith('/') ? prefix.slice(0, -1) : prefix,
  ])
    .split('\n')
    .filter(Boolean);
}
export function readAttestationRef(
  repositoryRoot: string,
  tagRef: string,
): string {
  return runGit(repositoryRoot, ['rev-parse', '--verify', tagRef], true).trim();
}

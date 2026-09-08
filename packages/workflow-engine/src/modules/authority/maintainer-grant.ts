import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import {
  isPostApprovalAdmissionFailure,
  runGit,
  runGitWithEnvironment,
} from '../../runtime/repository-transaction/git.ts';
import {
  parseMaintainerPolicy,
  type MaintainerPolicy,
} from './maintainer-policy.ts';
import {
  createInteractiveSshSigner,
  type MaintainerSignerProvider,
} from '../../adapters/signing/ssh/maintainer-signer.ts';
import {
  assertHumanResolutionConsequences,
  assertHumanResolutionDecision,
  humanResolutionDecisionSchemaDigest,
  readInvestigationSession,
  type HumanResolutionConsequences,
  type HumanResolutionDecision,
  type HumanResolutionExpectedState,
  type HumanResolutionTarget,
  type InvestigationResolutionState,
} from '../../runtime/storage-journal/investigation-session-store.ts';
import { loadInvestigationRuntimeContext } from '../../composition-root/lifecycle-context.ts';
import {
  assertChangeId,
  assertInvestigationId,
} from '../../runtime/session-workspace/paths.ts';
import { createMaintainerGrantContracts } from './maintainer-grant-contracts.ts';

export type CreateMaintainerGrantContractsBindings = Readonly<{
  assertChangeId: typeof assertChangeId;
  assertHumanResolutionConsequences: typeof assertHumanResolutionConsequences;
  assertHumanResolutionDecision: typeof assertHumanResolutionDecision;
  assertInvestigationId: typeof assertInvestigationId;
  humanResolutionDecisionSchemaDigest: typeof humanResolutionDecisionSchemaDigest;
}>;
const maintainerGrantContracts = createMaintainerGrantContracts({
  assertChangeId,
  assertHumanResolutionConsequences,
  assertHumanResolutionDecision,
  assertInvestigationId,
  humanResolutionDecisionSchemaDigest,
});
export const {
  canonicalHumanResolutionGrantPayload,
  canonicalHumanResolutionGrantEnvelope,
  parseHumanResolutionGrantEnvelope,
  assertMaintainerGrantId,
  validateHumanResolutionGrantPayload,
  humanResolutionBlockerBinding,
  assertResolutionDecisionAvailable,
  assertResolutionConsequences,
} = maintainerGrantContracts;
const { assertHumanResolutionAuditPayload, humanResolutionGrantInvalid } =
  maintainerGrantContracts;
export type { HumanResolutionDecision };
export type { HumanResolutionConsequences };
export type { InvestigationResolutionState };
export type { HumanResolutionExpectedState };

export const HUMAN_RESOLUTION_SIGNATURE_NAMESPACE =
  'workflow.human-resolution-grant.v1' as const;

export type HumanResolutionGrantPayload = {
  version: 1;
  grantId: string;
  repositoryId: string;
  repositoryOrigin: string;
  trustBaseCommit: string;
  policyBlob: string;
  target: HumanResolutionTarget;
  expected: HumanResolutionExpectedState;
  decision: HumanResolutionDecision;
  consequences: HumanResolutionConsequences;
  rationale: string;
  issuedAt: string;
  expiresAt: string;
  maxUses: 1;
  signer: string;
};

export type HumanResolutionGrantEnvelope = {
  payload: HumanResolutionGrantPayload;
  signature: string;
};

export type HumanResolutionGrantValidationOptions = {
  now: Date;
  expectedTrustBase: string;
  expectedPolicyBlob: string;
  state: InvestigationResolutionState;
  allowExpired?: boolean;
};

export function readHumanResolutionAuditTag(
  repositoryRoot: string,
  policy: MaintainerPolicy,
  observedRef: string,
): HumanResolutionGrantEnvelope | null {
  const resolutionPrefix = `${policy.auditTagPrefix}resolution-`;
  if (!observedRef.startsWith(resolutionPrefix)) {
    return null;
  }

  try {
    const observedGrantId = observedRef.slice(resolutionPrefix.length);
    assertMaintainerGrantId(observedGrantId);
    const raw = runGit(repositoryRoot, ['cat-file', 'tag', observedRef]);
    const separator = raw.indexOf('\n\n');
    if (separator === -1) {
      throw new Error('missing tag message');
    }
    const headers = raw.slice(0, separator).split('\n');
    const objectHeaders = headers.filter((line) => line.startsWith('object '));
    const typeHeaders = headers.filter((line) => line.startsWith('type '));
    const tagHeaders = headers.filter((line) => line.startsWith('tag '));
    const message = raw.slice(separator + 2);
    const envelope = parseHumanResolutionGrantEnvelope(message);
    const payload = envelope.payload;
    if (
      payload.grantId !== observedGrantId ||
      objectHeaders.length !== 1 ||
      objectHeaders[0] !== `object ${payload.trustBaseCommit}` ||
      typeHeaders.length !== 1 ||
      typeHeaders[0] !== 'type commit' ||
      tagHeaders.length !== 1 ||
      tagHeaders[0] !== `tag ${observedRef.slice('refs/tags/'.length)}` ||
      canonicalHumanResolutionGrantEnvelope(envelope) !== message ||
      runGit(repositoryRoot, [
        'rev-parse',
        `${observedRef}^{commit}`,
      ]).trim() !== payload.trustBaseCommit
    ) {
      throw new Error('tag binding mismatch');
    }

    const trustBase = loadMaintainerPolicyForResolution(
      repositoryRoot,
      payload.trustBaseCommit,
    );
    assertHumanResolutionAuditPayload(
      payload,
      policy,
      trustBase.policy,
      trustBase.policyBlob,
    );
    return envelope;
  } catch {
    throw workflowError(
      'HUMAN_RESOLUTION_AUDIT_TAG_INVALID',
      `Human-resolution audit tag ${observedRef} is malformed or noncanonical.`,
      ExitCode.guard,
    );
  }
}

export function verifyHumanResolutionGrantEnvelope(
  repositoryRoot: string,
  envelope: HumanResolutionGrantEnvelope,
  policy: MaintainerPolicy,
  verifier?: MaintainerSignerProvider,
): void {
  assertHumanResolutionDecision(envelope.payload.decision);
  const signer = verifier ?? createInteractiveSshSigner(repositoryRoot, policy);
  signer.verify(
    canonicalHumanResolutionGrantPayload(envelope.payload),
    envelope.signature,
    envelope.payload.signer,
    HUMAN_RESOLUTION_SIGNATURE_NAMESPACE,
  );
}

export function verifyHumanResolutionGrantForRevocation(
  repositoryRoot: string,
  envelope: HumanResolutionGrantEnvelope,
  verifier?: MaintainerSignerProvider,
): void {
  const trustBase = loadMaintainerPolicyForResolution(
    repositoryRoot,
    envelope.payload.trustBaseCommit,
  );
  assertHumanResolutionAuditPayload(
    envelope.payload,
    trustBase.policy,
    trustBase.policy,
    trustBase.policyBlob,
  );
  const signer =
    verifier ?? createInteractiveSshSigner(repositoryRoot, trustBase.policy);
  signer.verify(
    canonicalHumanResolutionGrantPayload(envelope.payload),
    envelope.signature,
    envelope.payload.signer,
    HUMAN_RESOLUTION_SIGNATURE_NAMESPACE,
  );
}

export function assertHumanResolutionAuditTag(
  repositoryRoot: string,
  envelope: HumanResolutionGrantEnvelope,
  policy: MaintainerPolicy,
): void {
  const tagRef = `${policy.auditTagPrefix}resolution-${envelope.payload.grantId}`;
  try {
    const observed = readHumanResolutionAuditTag(
      repositoryRoot,
      policy,
      tagRef,
    );
    if (
      observed === null ||
      canonicalHumanResolutionGrantEnvelope(observed) !==
        canonicalHumanResolutionGrantEnvelope(envelope)
    ) {
      throw new Error('audit mismatch');
    }
  } catch {
    throw workflowError(
      'HUMAN_RESOLUTION_AUDIT_TAG_INVALID',
      'The exact human-resolution audit tag is missing or different.',
      ExitCode.guard,
    );
  }
}

export function loadMaintainerPolicyForResolution(
  repositoryRoot: string,
  trustBaseCommit: string,
): { policy: MaintainerPolicy; policyBlob: string } {
  return {
    policy: loadBasePolicy(repositoryRoot, trustBaseCommit),
    policyBlob: runGit(repositoryRoot, [
      'rev-parse',
      `${trustBaseCommit}:workflow/maintainer-policy.json`,
    ]).trim(),
  };
}

function loadBasePolicy(
  repositoryRoot: string,
  baseCommit: string,
): MaintainerPolicy {
  try {
    return parseMaintainerPolicy(
      JSON.parse(
        runGit(repositoryRoot, [
          'show',
          `${baseCommit}:workflow/maintainer-policy.json`,
        ]),
      ),
    );
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error) {
      throw error;
    }
    throw workflowError(
      'MAINTAINER_POLICY_INVALID',
      'The base commit does not contain a valid maintainer policy.',
      ExitCode.guard,
    );
  }
}

export function createMaintainerAuditTag(
  repositoryRoot: string,
  baseCommit: string,
  tagRef: string,
  message: string,
  signerIdentity: string,
): string {
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-grant-tag-'),
  );
  fs.chmodSync(temporaryDirectory, 0o700);
  const messagePath = path.join(temporaryDirectory, 'message');
  try {
    fs.writeFileSync(messagePath, message, { encoding: 'utf8', mode: 0o600 });
    const shortName = tagRef.slice('refs/tags/'.length);
    runGitWithEnvironment(
      repositoryRoot,
      [
        'tag',
        '--annotate',
        '--cleanup=verbatim',
        '--file',
        messagePath,
        shortName,
        baseCommit,
      ],
      {
        GIT_COMMITTER_NAME: signerIdentity,
        GIT_COMMITTER_EMAIL: 'workflow-maintainer@users.noreply.github.com',
      },
    );
    return runGit(repositoryRoot, ['rev-parse', `${tagRef}^{tag}`]).trim();
  } catch (error) {
    if (isPostApprovalAdmissionFailure(error)) throw error;
    if (
      runGit(repositoryRoot, ['rev-parse', '--verify', tagRef], true).trim()
    ) {
      throw grantExists(tagRef.slice(policyTagPrefixLength(tagRef)));
    }
    throw error;
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function policyTagPrefixLength(tagRef: string): number {
  return tagRef.lastIndexOf('/') + 1;
}

export function assertResolutionDecisionTarget(
  paths: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  state: InvestigationResolutionState,
  decision: HumanResolutionDecision,
): void {
  const successor =
    decision.kind === 'repair'
      ? decision.parameters.successorInvestigationId
      : decision.kind === 'supersede'
        ? decision.parameters.successorInvestigationId
        : null;
  if (successor === null) {
    return;
  }
  const session = readInvestigationSession(paths, successor);
  if (
    session.changeId !== state.envelope.changeId ||
    successor === state.envelope.investigationId
  ) {
    throw humanResolutionGrantInvalid(
      'A resolution successor must be a different readable investigation for the same change.',
    );
  }
}

function grantExists(grantId: string) {
  return workflowError(
    'MAINTAINER_GRANT_EXISTS',
    `Maintainer grant ${grantId} already has local state or an audit tag.`,
    ExitCode.conflict,
  );
}

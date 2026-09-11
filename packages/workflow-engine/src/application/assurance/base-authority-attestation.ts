import { ROLE_CONTEXT_SHARING_TERMINAL_RECEIPT_TAG_PREFIX_V1 } from '../../modules/authority/role-context-sharing-grant-lifecycle-port.ts';
import {
  AUTHORITY_ATTESTATION_TAG_PREFIX,
  canonicalAttestationPayload,
  validateAttestedTransitionPair,
  validateAuthorityTransitionIdentity,
  type AttestedCommitFacts,
  type AuthorityAttestationEnvelope,
} from '../../modules/authority/authority-attestation.ts';
import { authorityApplicationReceiptTagPrefix } from '../../modules/authority/authority-application-receipt.ts';
import { type RangeCommit } from '../../modules/assurance/commit-replay/ci-git.ts';
import { WorkflowError } from '../../foundation/errors/errors.ts';
import {
  HUMAN_RESOLUTION_SIGNATURE_NAMESPACE,
  canonicalHumanResolutionGrantPayload,
} from '../../modules/authority/maintainer-grant-contracts.ts';
import {
  canonicalMaintainerGrantV2Payload,
  maintainerGrantV2SignatureNamespace,
  parseMaintainerGrantV2Envelope,
} from '../../modules/authority/maintainer-grant-v2-codec.ts';
import { type MaintainerPolicy } from '../../modules/authority/maintainer-policy.ts';
import {
  ManagedTrailerSyntaxError,
  parseManagedTrailers,
  type AuthorityCandidateManagedTrailers,
  type AuthorityManagedTrailers,
} from '@jigwright/core/managed-transition-trailers';
import crypto from 'node:crypto';
import { authorityAttestationSignatureNamespace } from '../../modules/authority/authority-attestation.ts';
import {
  parseAttestationTag,
  parseBasePolicy,
  parseProtectedBranches,
  trustedSigner,
  wrapMapping,
  invalidAttestationTag,
  invalidGrantTag,
  attestationError,
  type AttestedAuthority,
  type DirectAuthority,
  type CiAttestationResult,
  type GrantTagRecord,
} from '../../modules/assurance/ci-attestation.ts';
import type { CiAttestationServices } from '../../modules/assurance/ci-attestation.ts';

const MAINTAINER_POLICY_PATH = 'workflow/maintainer-policy.json';
const WORKFLOW_CONFIG_PATH = 'workflow/config.json';
export function createBaseAuthorityAttestationVerifier(
  services: CiAttestationServices,
) {
  const {
    listVerifiedRoleContextSharingTerminalReceipts,
    listFirstParentHashes,
    commitFacts,
    listTagRefs,
    validateCiAuthorityCommit,
    readTagObject,
    readHistoricalPolicyBlob,
    readHistoricalPolicyContent,
    verifySshDataSignature,
    verifyTrustedCommitSignature,
    readHumanResolutionAuditTag,
    resolveTagCommit,
    resolveCommitTree,
    readFileAtCommit,
  } = services;
  function verifyBaseAuthorityAttestations(
    repositoryRoot: string,
    base: string,
    evaluatedAt: Date = new Date(),
  ): CiAttestationResult {
    const roleContextSharingTerminalReceipts =
      listVerifiedRoleContextSharingTerminalReceipts(repositoryRoot);
    const roleContextSharingTerminalReceiptRefs = new Set(
      roleContextSharingTerminalReceipts.map(({ tagRef }) => tagRef),
    );
    const firstParentHashes = listFirstParentHashes(repositoryRoot, base);
    const firstParentSet = new Set(firstParentHashes);

    const authorityCommits: Array<
      RangeCommit & {
        trailers: AuthorityManagedTrailers | AuthorityCandidateManagedTrailers;
      }
    > = [];
    for (const hash of firstParentHashes) {
      try {
        const facts = commitFacts(repositoryRoot, hash);
        const trailers = parseManagedTrailers(facts.message);
        if (
          trailers?.kind === 'authority' ||
          trailers?.kind === 'authority-candidate'
        ) {
          authorityCommits.push({
            hash: facts.hash,
            subject: facts.message.split('\n', 1)[0],
            parents: facts.parents,
            trailers,
          });
        }
      } catch (error) {
        if (error instanceof ManagedTrailerSyntaxError) continue;
        throw error;
      }
    }
    if (authorityCommits.length === 0) {
      return {
        attestedAuthorities: [],
        directAuthorities: [],
        roleContextSharingTerminalReceipts,
      };
    }

    const policy = loadBasePolicy(repositoryRoot, base);
    const protectedBranches = loadProtectedBranches(repositoryRoot, base);
    const grantTags = listGrantTags(
      repositoryRoot,
      policy,
      roleContextSharingTerminalReceiptRefs,
    );
    const attestationRefs = new Set(
      listTagRefs(repositoryRoot, AUTHORITY_ATTESTATION_TAG_PREFIX),
    );
    const usedOriginals = new Set<string>();
    const usedMains = new Set<string>();
    const baseMappings = new Map<string, string>();
    const attested: AttestedAuthority[] = [];
    const direct: DirectAuthority[] = [];

    for (const commit of authorityCommits.reverse()) {
      let attestationGrantId: string;
      let envelope: AuthorityAttestationEnvelope;
      if (commit.trailers.kind === 'authority-candidate') {
        try {
          const validated = validateCiAuthorityCommit(
            repositoryRoot,
            commit,
            evaluatedAt,
          );
          direct.push({
            grantId: validated.grantId,
            changeId: validated.changeId,
            commit: commit.hash,
          });
          continue;
        } catch (directError) {
          const candidates = [...attestationRefs]
            .map((ref) =>
              readAttestationEnvelope(
                repositoryRoot,
                ref.slice(AUTHORITY_ATTESTATION_TAG_PREFIX.length),
              ),
            )
            .filter(({ payload }) => payload.mainCommit === commit.hash);
          if (candidates.length === 0 && directError instanceof WorkflowError) {
            throw directError;
          }
          if (candidates.length !== 1) {
            throw attestationError(
              'CI_ATTESTATION_MISSING',
              'A rewritten v2 authority candidate requires one exact protected attestation.',
              {
                commit: commit.hash,
                directValidationCode:
                  directError instanceof WorkflowError
                    ? directError.code
                    : 'UNKNOWN',
              },
            );
          }
          envelope = candidates[0];
          attestationGrantId = envelope.payload.grantId;
        }
      } else {
        attestationGrantId = commit.trailers.grantId;
        const attestationRef = `${AUTHORITY_ATTESTATION_TAG_PREFIX}${attestationGrantId}`;
        if (!attestationRefs.has(attestationRef)) {
          try {
            const validated = validateCiAuthorityCommit(
              repositoryRoot,
              commit,
              evaluatedAt,
            );
            direct.push({
              grantId: validated.grantId,
              changeId: validated.changeId,
              commit: commit.hash,
            });
          } catch (error) {
            if (error instanceof WorkflowError) {
              throw attestationError(
                'CI_ATTESTATION_MISSING',
                `Protected-main authority commit has no attestation tag for ${attestationGrantId} and is not directly replayable.`,
                { directValidationCode: error.code },
              );
            }
            throw error;
          }
          continue;
        }
        envelope = readAttestationEnvelope(repositoryRoot, attestationGrantId);
      }
      const payload = envelope.payload;
      if (
        payload.grantId !== attestationGrantId ||
        payload.mainCommit !== commit.hash ||
        payload.repositoryId !== policy.repository.id ||
        payload.repositoryOrigin !== policy.repository.origin ||
        !protectedBranches.includes(payload.protectedBranch)
      ) {
        throw attestationError(
          'CI_ATTESTATION_MAPPING_INVALID',
          'The protected attestation does not bind this authority commit.',
          { commit: commit.hash, grantId: attestationGrantId },
        );
      }
      const attestationSigner = trustedSigner(policy, payload.signer);
      verifySshDataSignature(
        canonicalAttestationPayload(payload),
        envelope.signature,
        attestationSigner,
        authorityAttestationSignatureNamespace(envelope),
        'CI_ATTESTATION_SIGNATURE_INVALID',
      );

      const original = attestedFacts(repositoryRoot, payload.originalCommit);
      const main = attestedFacts(repositoryRoot, payload.mainCommit);
      const transitionTrailers = wrapMapping(commit.hash, () =>
        validateAttestedTransitionPair(original, main),
      );
      let identity: { grantId: string; changeId: string };
      if (commit.trailers.kind === 'authority-candidate') {
        if (transitionTrailers.kind !== 'authority-candidate') {
          throw attestationError(
            'CI_ATTESTATION_MAPPING_INVALID',
            'The attested transition does not preserve authority-candidate trailers.',
            { commit: commit.hash },
          );
        }
        identity = validateCiAuthorityCommit(
          repositoryRoot,
          {
            hash: original.oid,
            subject: original.message.split('\n', 1)[0],
            parents: [...original.parentOids],
            trailers: transitionTrailers,
          },
          evaluatedAt,
        );
      } else {
        identity = wrapMapping(commit.hash, () =>
          validateAuthorityTransitionIdentity(original, main),
        );
      }
      if (
        identity.grantId !== payload.grantId ||
        identity.changeId !== commit.trailers.changeId
      ) {
        throw attestationError(
          'CI_ATTESTATION_MAPPING_INVALID',
          'The attested transition identity does not match its trailers.',
          { commit: commit.hash },
        );
      }

      const primaryGrant = grantTags.get(payload.grantId);
      if (!primaryGrant) {
        throw attestationError(
          'CI_ATTESTATION_GRANT_MISSING',
          `No protected maintainer grant tag exists for ${payload.grantId}.`,
        );
      }
      if (
        primaryGrant.envelope.payload.changeId !== identity.changeId ||
        primaryGrant.envelope.payload.baseCommit !== original.parentOids[0]
      ) {
        throw attestationError(
          'CI_ATTESTATION_GRANT_INVALID',
          'The primary grant does not bind the attested original commit.',
          { grantId: payload.grantId },
        );
      }
      validateHistoricalGrant(repositoryRoot, policy, primaryGrant);
      verifyTrustedCommitSignature(
        repositoryRoot,
        original.oid,
        trustedSigner(policy, primaryGrant.envelope.payload.signer),
        'CI_ATTESTATION_ORIGINAL_SIGNATURE_INVALID',
      );

      for (const mapping of payload.grantBases) {
        const mappingOriginal = attestedFacts(
          repositoryRoot,
          mapping.originalBase,
        );
        const mappingMain = attestedFacts(repositoryRoot, mapping.mainBase);
        wrapMapping(commit.hash, () =>
          validateAttestedTransitionPair(mappingOriginal, mappingMain),
        );
        if (!firstParentSet.has(mapping.mainBase)) {
          throw attestationError(
            'CI_ATTESTATION_MAIN_UNREACHABLE',
            'A mapped grant base is not on protected first-parent history.',
            { mainBase: mapping.mainBase },
          );
        }
        const bound = [...grantTags.values()]
          .filter(
            (record) =>
              record.envelope.payload.baseCommit === mapping.originalBase,
          )
          .map((record) => record.grantId)
          .sort();
        if (JSON.stringify(bound) !== JSON.stringify(mapping.grantIds)) {
          throw attestationError(
            'CI_ATTESTATION_GRANT_BASES_INCOMPLETE',
            'The attested grant-base mapping omits or invents bound grants.',
            {
              originalBase: mapping.originalBase,
              bound,
              mapped: mapping.grantIds,
            },
          );
        }
        for (const grantId of mapping.grantIds) {
          const record = grantTags.get(grantId);
          if (!record || record.target !== mapping.originalBase) {
            throw attestationError(
              'CI_ATTESTATION_GRANT_INVALID',
              'A mapped grant tag does not target its original base.',
              { grantId },
            );
          }
          validateHistoricalGrant(repositoryRoot, policy, record);
        }
        const existing = baseMappings.get(mapping.originalBase);
        if (
          (existing !== undefined && existing !== mapping.mainBase) ||
          [...baseMappings.entries()].some(
            ([originalBase, mainBase]) =>
              mainBase === mapping.mainBase &&
              originalBase !== mapping.originalBase,
          )
        ) {
          throw attestationError(
            'CI_ATTESTATION_MAPPING_CONFLICT',
            'Conflicting grant-base mappings were attested.',
            { originalBase: mapping.originalBase },
          );
        }
        baseMappings.set(mapping.originalBase, mapping.mainBase);
      }

      if (usedOriginals.has(original.oid) || usedMains.has(main.oid)) {
        throw attestationError(
          'CI_ATTESTATION_MAPPING_CONFLICT',
          'An original or protected-main commit participates in two mappings.',
          { originalCommit: original.oid, mainCommit: main.oid },
        );
      }
      usedOriginals.add(original.oid);
      usedMains.add(main.oid);
      attested.push({
        grantId: payload.grantId,
        changeId: identity.changeId,
        originalCommit: original.oid,
        mainCommit: main.oid,
      });
    }

    return {
      attestedAuthorities: attested.sort((left, right) =>
        left.grantId.localeCompare(right.grantId),
      ),
      directAuthorities: direct.sort((left, right) =>
        left.grantId.localeCompare(right.grantId),
      ),
      roleContextSharingTerminalReceipts,
    };
  }

  function readAttestationEnvelope(
    repositoryRoot: string,
    grantId: string,
  ): AuthorityAttestationEnvelope {
    const tagRef = `${AUTHORITY_ATTESTATION_TAG_PREFIX}${grantId}`;
    let raw: string;
    try {
      raw = readTagObject(repositoryRoot, tagRef);
    } catch {
      throw invalidAttestationTag(grantId);
    }
    return parseAttestationTag(grantId, raw);
  }

  function validateHistoricalGrant(
    repositoryRoot: string,
    policy: MaintainerPolicy,
    record: GrantTagRecord,
  ): void {
    const baseCommit = record.envelope.payload.baseCommit;
    const policyBlob = readHistoricalPolicyBlob(repositoryRoot, baseCommit);
    if (!policyBlob) {
      throw attestationError(
        'CI_ATTESTATION_GRANT_INVALID',
        'A mapped grant base does not carry a maintainer policy.',
        { grantId: record.grantId },
      );
    }
    const policyContent = readHistoricalPolicyContent(
      repositoryRoot,
      baseCommit,
    );
    if (
      record.envelope.payload.policyBlob !== policyBlob ||
      record.envelope.payload.policyDigest !==
        crypto.createHash('sha256').update(policyContent).digest('hex') ||
      record.envelope.payload.repositoryId !== policy.repository.id ||
      record.envelope.payload.repositoryOrigin !== policy.repository.origin
    ) {
      throw attestationError(
        'CI_ATTESTATION_GRANT_INVALID',
        'A mapped grant envelope fails validation under base policy.',
        { grantId: record.grantId },
      );
    }
    verifySshDataSignature(
      canonicalMaintainerGrantV2Payload(record.envelope.payload),
      record.envelope.signature,
      trustedSigner(policy, record.envelope.payload.signer),
      maintainerGrantV2SignatureNamespace(record.envelope),
      'CI_ATTESTATION_GRANT_SIGNATURE_INVALID',
    );
  }

  function listGrantTags(
    repositoryRoot: string,
    policy: MaintainerPolicy,
    verifiedRoleContextSharingTerminalReceiptRefs: ReadonlySet<string>,
  ): Map<string, GrantTagRecord> {
    const prefix = policy.auditTagPrefix;
    const refs = listTagRefs(
      repositoryRoot,
      prefix.endsWith('/') ? prefix.slice(0, -1) : prefix,
    );
    const records = new Map<string, GrantTagRecord>();
    for (const ref of refs) {
      if (ref.startsWith(authorityApplicationReceiptTagPrefix(policy))) {
        continue;
      }
      if (ref.startsWith(ROLE_CONTEXT_SHARING_TERMINAL_RECEIPT_TAG_PREFIX_V1)) {
        if (!verifiedRoleContextSharingTerminalReceiptRefs.has(ref)) {
          throw invalidGrantTag(
            ref.slice(
              ROLE_CONTEXT_SHARING_TERMINAL_RECEIPT_TAG_PREFIX_V1.length,
            ),
          );
        }
        continue;
      }
      const grantId = ref.slice(prefix.length);
      try {
        const resolution = readHumanResolutionAuditTag(
          repositoryRoot,
          policy,
          ref,
        );
        if (resolution !== null) {
          verifySshDataSignature(
            canonicalHumanResolutionGrantPayload(resolution.payload),
            resolution.signature,
            trustedSigner(policy, resolution.payload.signer),
            HUMAN_RESOLUTION_SIGNATURE_NAMESPACE,
            'CI_ATTESTATION_GRANT_INVALID',
          );
          continue;
        }
      } catch {
        throw invalidGrantTag(grantId);
      }
      let raw: string;
      try {
        raw = readTagObject(repositoryRoot, ref);
      } catch {
        throw invalidGrantTag(grantId);
      }
      const separator = raw.indexOf('\n\n');
      if (separator === -1) {
        throw invalidGrantTag(grantId);
      }
      try {
        const envelope = parseMaintainerGrantV2Envelope(
          raw.slice(separator + 2),
        );
        const target = resolveTagCommit(repositoryRoot, ref);
        if (
          envelope.payload.grantId !== grantId ||
          target !== envelope.payload.baseCommit
        ) {
          throw new Error('v2 grant binding differs');
        }
        verifySshDataSignature(
          canonicalMaintainerGrantV2Payload(envelope.payload),
          envelope.signature,
          trustedSigner(policy, envelope.payload.signer),
          maintainerGrantV2SignatureNamespace(envelope),
          'CI_ATTESTATION_GRANT_INVALID',
        );
        records.set(grantId, { grantId, target, envelope });
      } catch {
        throw invalidGrantTag(grantId);
      }
    }
    return records;
  }

  function attestedFacts(
    repositoryRoot: string,
    commitOid: string,
  ): AttestedCommitFacts {
    const facts = commitFacts(repositoryRoot, commitOid);
    const parentTree =
      facts.parents.length === 1
        ? resolveCommitTree(repositoryRoot, facts.parents[0]!)
        : undefined;
    return {
      oid: facts.hash,
      tree: facts.tree,
      parentOids: facts.parents,
      parentTree,
      message: facts.message,
    };
  }

  function loadBasePolicy(
    repositoryRoot: string,
    base: string,
  ): MaintainerPolicy {
    const content = readFileAtCommit(
      repositoryRoot,
      base,
      MAINTAINER_POLICY_PATH,
    );
    return parseBasePolicy(content);
  }

  function loadProtectedBranches(
    repositoryRoot: string,
    base: string,
  ): string[] {
    const content = readFileAtCommit(
      repositoryRoot,
      base,
      WORKFLOW_CONFIG_PATH,
    );
    return parseProtectedBranches(content);
  }
  return { verifyBaseAuthorityAttestations };
}
export type BaseAuthorityAttestationVerifier = ReturnType<
  typeof createBaseAuthorityAttestationVerifier
>;

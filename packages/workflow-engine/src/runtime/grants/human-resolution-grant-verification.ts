import {
  type HumanResolutionServices,
  canonicalHumanResolutionGrantPayload,
  assertHumanResolutionAuditPayload,
  HUMAN_RESOLUTION_SIGNATURE_NAMESPACE,
} from '../../modules/investigation/domain/human-resolution-grant-contract.ts';
import type { MaintainerSignerFactory } from '../../modules/authority/maintainer-signer-port.ts';
/** Verifies exact human-resolution bytes with the selected historical signer. */

import { assertHumanResolutionDecision } from '../../modules/investigation/domain/human-resolution-contract.ts';

import { loadMaintainerPolicyForResolution } from '../repository-observation/human-resolution-grants.ts';

export function createHumanResolutionGrantVerification(
  createSigner: MaintainerSignerFactory,
) {
  const verifyHumanResolutionGrantEnvelope: HumanResolutionServices['verifyHumanResolutionGrantEnvelope'] =
    (repositoryRoot, envelope, policy, verifier) => {
      assertHumanResolutionDecision(envelope.payload.decision);
      const signer = verifier ?? createSigner(repositoryRoot, policy);
      signer.verify(
        canonicalHumanResolutionGrantPayload(envelope.payload),
        envelope.signature,
        envelope.payload.signer,
        HUMAN_RESOLUTION_SIGNATURE_NAMESPACE,
      );
    };

  const verifyHumanResolutionGrantForRevocation: HumanResolutionServices['verifyHumanResolutionGrantForRevocation'] =
    (repositoryRoot, envelope, verifier) => {
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
      const signer = verifier ?? createSigner(repositoryRoot, trustBase.policy);
      signer.verify(
        canonicalHumanResolutionGrantPayload(envelope.payload),
        envelope.signature,
        envelope.payload.signer,
        HUMAN_RESOLUTION_SIGNATURE_NAMESPACE,
      );
    };

  return {
    verifyHumanResolutionGrantEnvelope,
    verifyHumanResolutionGrantForRevocation,
  };
}

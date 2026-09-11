/** Verifies exact human-resolution bytes with the selected historical signer. */
import { canonicalHumanResolutionGrantPayload, assertHumanResolutionAuditPayload, HUMAN_RESOLUTION_SIGNATURE_NAMESPACE, } from "../../modules/authority/maintainer-grant-contracts.js";
import { assertHumanResolutionDecision } from "../../modules/investigation/domain/human-resolution-contract.js";
import { loadMaintainerPolicyForResolution } from "../repository-observation/human-resolution-grants.js";
export function createHumanResolutionGrantVerification(createSigner) {
    const verifyHumanResolutionGrantEnvelope = (repositoryRoot, envelope, policy, verifier) => {
        assertHumanResolutionDecision(envelope.payload.decision);
        const signer = verifier ?? createSigner(repositoryRoot, policy);
        signer.verify(canonicalHumanResolutionGrantPayload(envelope.payload), envelope.signature, envelope.payload.signer, HUMAN_RESOLUTION_SIGNATURE_NAMESPACE);
    };
    const verifyHumanResolutionGrantForRevocation = (repositoryRoot, envelope, verifier) => {
        const trustBase = loadMaintainerPolicyForResolution(repositoryRoot, envelope.payload.trustBaseCommit);
        assertHumanResolutionAuditPayload(envelope.payload, trustBase.policy, trustBase.policy, trustBase.policyBlob);
        const signer = verifier ?? createSigner(repositoryRoot, trustBase.policy);
        signer.verify(canonicalHumanResolutionGrantPayload(envelope.payload), envelope.signature, envelope.payload.signer, HUMAN_RESOLUTION_SIGNATURE_NAMESPACE);
    };
    return {
        verifyHumanResolutionGrantEnvelope,
        verifyHumanResolutionGrantForRevocation,
    };
}

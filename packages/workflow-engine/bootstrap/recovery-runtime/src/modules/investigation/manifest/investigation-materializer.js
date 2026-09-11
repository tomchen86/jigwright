/**
 * Materializes canonical investigation evidence from replayable terms and
 * tree facts.
 *
 * Invariants:
 * - Materialized evidence views remain process-local and cannot be
 *   serialized.
 */
import { canonicalJson } from "../../../foundation/canonical-json/canonical-json.js";
import { ExitCode, workflowError } from "../../../foundation/errors/errors.js";
import { applyInvestigationDispositionDecisions, applyInvestigationSemanticGroupDecisions, } from "../domain/investigation-domain.js";
import { deriveInvestigationCommitments, investigationTermSetDigest, } from "../domain/investigation-roots.js";
import { INVESTIGATION_LIMITS, } from "../domain/investigation-terms.js";
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const DIGEST = /^[0-9a-f]{64}$/;
/**
 * Process-local replay result. `toJSON` fails closed so this transient view
 * cannot accidentally become a tracked or durable authority artifact.
 */
export class MaterializedEvidenceView {
    #state;
    constructor(input) {
        this.#state = deepFreeze(structuredClone(input));
        Object.freeze(this);
    }
    get scanFacts() {
        return this.#state.scanFacts;
    }
    get grouping() {
        return this.#state.grouping;
    }
    get finalGroups() {
        return this.#state.finalGroups;
    }
    get dispositions() {
        return this.#state.dispositions;
    }
    get commitments() {
        return this.#state.commitments;
    }
    get termSetDigest() {
        return this.#state.termSetDigest;
    }
    get canonicalTerms() {
        return this.#state.canonicalTerms;
    }
    get limits() {
        return this.#state.limits;
    }
    toJSON() {
        throw workflowError('PROJECTION_PIPELINE_FORBIDDEN', 'MaterializedEvidenceView is process-local and must never be serialized.', ExitCode.guard);
    }
}
/**
 * Materialize the semantic v3 view from already-replayed scanner and grouping
 * facts. Ordinary propose uses this after its single pinned-tree scan; authority
 * replay uses the repository-backed wrapper below and converges here.
 */
export function materializeInvestigationEvidenceViewFromFacts(input) {
    const finalGroups = applyInvestigationSemanticGroupDecisions({
        mechanical: input.grouping,
        decisions: input.semanticGroupDecisions,
    });
    const dispositions = applyInvestigationDispositionDecisions({
        finalGroups,
        decisions: input.dispositionDecisions,
    });
    const commitments = deriveInvestigationCommitments({
        scanFacts: input.scanFacts,
        grouping: input.grouping,
        finalGroups,
        dispositions,
        effectiveTermIds: input.canonicalTerms.map(({ termId }) => termId),
    });
    return new MaterializedEvidenceView({
        scanFacts: input.scanFacts,
        grouping: input.grouping,
        finalGroups,
        dispositions,
        commitments,
        termSetDigest: investigationTermSetDigest(input.canonicalTerms),
        canonicalTerms: input.canonicalTerms,
        limits: input.limits ?? { ...INVESTIGATION_LIMITS },
    });
}
function deepFreeze(value) {
    if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
        return value;
    }
    Object.freeze(value);
    for (const child of Object.values(value)) {
        deepFreeze(child);
    }
    return value;
}
export function assertSaturationDecision(saturatedTermIds, decision) {
    const saturated = [...saturatedTermIds].sort();
    if (saturated.length === 0) {
        if (decision !== null) {
            throw workflowError('SEMANTIC_COMPLETENESS_FAILURE', 'A scan-saturation decision exists for a complete replay.', ExitCode.guard);
        }
        return;
    }
    if (decision === null ||
        decision.acknowledgeIncompleteScan !== true ||
        canonicalJson([...decision.saturatedTermIds].sort()) !==
            canonicalJson(saturated) ||
        typeof decision.rationale !== 'string' ||
        decision.rationale.trim().length === 0 ||
        typeof decision.semanticAuthor?.id !== 'string' ||
        decision.semanticAuthor.id.trim().length === 0 ||
        typeof decision.semanticAuthor.provenance !== 'string' ||
        decision.semanticAuthor.provenance.trim().length === 0 ||
        !DIGEST.test(decision.provenanceDigest)) {
        throw workflowError('SEMANTIC_COMPLETENESS_FAILURE', 'Saturated replay lacks its exact semantic acknowledgement.', ExitCode.guard);
    }
}
export function assertInvestigationReplayBaseline(baseline) {
    if (typeof baseline !== 'object' ||
        baseline === null ||
        Object.keys(baseline).length !== 2 ||
        !Object.keys(baseline).every((key) => ['commitOid', 'treeOid'].includes(key)) ||
        !GIT_OBJECT_ID.test(baseline.commitOid) ||
        !GIT_OBJECT_ID.test(baseline.treeOid) ||
        baseline.commitOid.length !== baseline.treeOid.length) {
        throw workflowError('REPLAY_INPUT_MISSING', 'Investigation baseline identity is malformed.', ExitCode.guard);
    }
}

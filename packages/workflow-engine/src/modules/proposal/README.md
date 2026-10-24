# Proposal

Owns the data and pure rules shared by proposal workflows. The governing contract is the [workflow engine specification](../../../spec.md).

- `propose-types.ts`, `propose-input.ts` and `propose-values.ts` own canonical inputs, results, envelope validation, errors and digests.
- `plan-review-contracts.ts` and `plan-review-grant-authorization.ts` define and validate review requirements, retry bindings and exact Grant authorization.
- `plan-review-role-topology.ts` resolves topology from supplied snapshots and validates durable role assignments.
- `role-context-sharing-plan-review.ts` validates role-sharing requirements, derives their exact binding and creates the existing eligibility capability.
- `propose-evidence.ts` builds evidence nodes; `propose-investigation-projections.ts` derives assurance reports, snapshot digests and build failures from supplied data.
- `propose-reviewer-checkpoint.ts` merges reusable reviewer checkpoint evidence.
- `propose-output.ts` renders deterministic proposal output.

Storage, provider execution, clocks, reservation and Grant consumption belong to [runtime/proposal](../../runtime/proposal). Runtime workflows import fixed operations directly and receive the actual capabilities they need. Pure rules depend on canonical module contracts.

Direct rule checks live in [proposal-domain.contract.test.ts](../../../test/proposal-domain.contract.test.ts). Existing proposal and role-sharing integration tests exercise the production flow.

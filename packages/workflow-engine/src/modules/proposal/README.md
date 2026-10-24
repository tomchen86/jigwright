# Proposal

Owns the data and pure validation rules shared by proposal entrypoints and their orchestration. The governing contract is the [workflow engine specification](../../../spec.md).

- `propose-types.ts` defines canonical proposal inputs, options, results and authorization data.
- `propose-input.ts` validates and builds proposal envelopes with the original investigation validators.
- `propose-values.ts` holds deterministic values, errors and digest helpers.
- `role-context-sharing-plan-review.ts` validates role-sharing requirements, derives their exact binding and creates the existing eligibility capability.

Storage, provider execution, clocks, reservation and Grant consumption remain in application/runtime owners. Pure rules import their canonical module data directly; they do not depend on the private `ProposeRuntime` assembly.

Direct rule checks live in [proposal-domain.contract.test.ts](../../../test/proposal-domain.contract.test.ts). Existing proposal and role-sharing integration tests continue to exercise the production flow.

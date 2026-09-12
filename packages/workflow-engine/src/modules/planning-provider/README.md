# Planning provider

## Why this design

<!-- jigwright:module-why confirmed=7a8fb8990a902bf6f01d8e17cedc115486ac8d40 -->

Keep planning-provider contracts neutral and adapt only their error presentation at the engine boundary. `evaluatePlanningProvider` inspects provider installation and change results; the binding codec preserves the public core representation, while the authoring port describes artifacts and readiness without publishing workflow state. This follows the [recorded requirements](../../../../../docs/REQUIREMENTS.md): packaging and modularity should preserve the existing product contract. Provider document inspection therefore remains usable independently of the engine's commit, review and archive orchestration.

<!-- /jigwright:module-why -->

<!-- jigwright:region id=documents.planning-provider-readme v=1 digest=sha256:e62dc9631489d14adebeeae377e8ba5c9dc0fee8e6bf95a9fc470445bba8fc66 -->

<!-- prettier-ignore-start -->

15 files changed in this module since confirmation.

## Commands

| Command and parameters | Does what |
| --- | --- |
| validate-change &lt;change-id&gt; [--json] | Validate the selected planning change and its readiness. |
| propose &lt;change-id&gt; --intent &lt;intent.json&gt; --mandate &lt;mandate-task-id&gt; [--actor &lt;id&gt;] [--grant &lt;grant-id&gt;] [--json] | Create or resume the durable investigation and planning workflow. |
| propose &lt;change-id&gt; --resume --input &lt;envelope.json&gt; [--grant &lt;grant-id&gt;\|--role-context-grant &lt;grant-id&gt;] [--json] | Create or resume the durable investigation and planning workflow. |
| plan-commit &lt;change-id&gt; [--json] | Verify and commit the selected planning generation. |
| amend-plan --change &lt;change-id&gt; --reason &lt;code&gt; --execution-impact &lt;none\|required&gt; [--json] | Record an explicit amendment and its execution impact. |
| openspec-assets &lt;generate\|check\|install-prompts --codex-home &lt;path&gt;&gt; [--json] | Generate, check or install the reviewed planning assets. |

## Data

| Type | Values | Source |
| --- | --- | --- |

## Contracts

- [Planning Facades Preserve Core Contracts](spec.md#requirement-planning-facades-preserve-core-contracts)

## Files

Header history compares Git blame at the explanation confirmation with this source snapshot. It is a hint, not verification of the explanation.

| File | Responsibility | Invariants | Header history |
| --- | --- | ---: | --- |
| [change-contract-errors.ts](change-contract-errors.ts) | No leading responsibility comment. | 0 | History unavailable |
| [change-contract.ts](change-contract.ts) | Parsed change artifact facts, before provider readiness and planning-assurance admission. | 0 | History unavailable |
| [change-metadata-policy.ts](change-metadata-policy.ts) | Parse canonical schema metadata text under the supplied consumer policy. | 0 | History unavailable |
| [guard-policy.ts](guard-policy.ts) | Validate guard values after repository path admission. | 0 | History unavailable |
| [planning-archive-projection-port.ts](planning-archive-projection-port.ts) | No leading responsibility comment. | 0 | History unavailable |
| [planning-artifact-parsers.ts](planning-artifact-parsers.ts) | Parse planning artifact values without observing repository state. | 0 | History unavailable |
| [planning-artifact-types.ts](planning-artifact-types.ts) | Canonical planning task, execution and PlanReview artifact data; parsers and storage share these values. | 0 | History unavailable |
| [planning-provider-authoring-port.ts](planning-provider-authoring-port.ts) | Declares the planning provider instructions and artifact status used during authoring. | 1 | History unavailable |
| [planning-provider-binding.ts](planning-provider-binding.ts) | Adapts the shared planning binding codec to workflow errors and exit categories. | 1 | History unavailable |
| [planning-provider-port.ts](planning-provider-port.ts) | Exposes shared planning provider evaluation through the workflow error boundary. | 1 | History unavailable |
| [planning-task-history.ts](planning-task-history.ts) | Adapts shared planning task-history checks to workflow errors. | 1 | History unavailable |
| [planning-workspace.ts](planning-workspace.ts) | Planning workspace identity and operations required by proposal and task activation. | 0 | History unavailable |
| [validated-change-contract.ts](validated-change-contract.ts) | Admitted change facts shared by planning, execution and report validation. | 0 | History unavailable |

<!-- prettier-ignore-end -->

<!-- /jigwright:region -->

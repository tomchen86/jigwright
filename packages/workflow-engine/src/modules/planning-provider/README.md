# Planning provider

## Why this design

<!-- jigwright:module-why confirmed=7a8fb8990a902bf6f01d8e17cedc115486ac8d40 -->

Keep planning-provider contracts neutral and adapt only their error presentation at the engine boundary. `evaluatePlanningProvider` inspects provider installation and change results; the binding codec preserves the public core representation, while the authoring port describes artifacts and readiness without publishing workflow state. This follows the [recorded requirements](../../../../../docs/REQUIREMENTS.md): packaging and modularity should preserve the existing product contract. Provider document inspection therefore remains usable independently of the engine's commit, review and archive orchestration.

<!-- /jigwright:module-why -->

<!-- jigwright:region id=documents.planning-provider-readme v=1 digest=sha256:90538dc3024dcb662b01da800492fbf9270d305e5eb5e90161f42048e5892227 -->

<!-- prettier-ignore-start -->

7 files changed in this module since confirmation.

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
| [planning-archive-projection-port.ts](planning-archive-projection-port.ts) | Adapts shared planning archive operations to workflow failure conventions. | 1 | History unavailable |
| [planning-provider-authoring-port.ts](planning-provider-authoring-port.ts) | Declares the planning provider instructions and artifact status used during authoring. | 1 | History unavailable |
| [planning-provider-binding.ts](planning-provider-binding.ts) | Adapts the shared planning binding codec to workflow errors and exit categories. | 1 | History unavailable |
| [planning-provider-port.ts](planning-provider-port.ts) | Exposes shared planning provider evaluation through the workflow error boundary. | 1 | History unavailable |
| [planning-task-history.ts](planning-task-history.ts) | Adapts shared planning task-history checks to workflow errors. | 1 | History unavailable |

<!-- prettier-ignore-end -->

<!-- /jigwright:region -->

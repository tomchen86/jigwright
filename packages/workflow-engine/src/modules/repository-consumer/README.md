# Repository consumer

## Why this design

<!-- jigwright:module-why confirmed=7a8fb8990a902bf6f01d8e17cedc115486ac8d40 -->

Keep a project's schema, document paths, Work Registry settings and database policy in explicit repository configuration so the packaged engine can serve another project without embedded application defaults. The consumer loader resolves those selections through the public consumer port and checks paths against the canonical repository root; the workflow config parser handles the project's namespace and lifecycle settings. This follows the [recorded requirements](../../../../../docs/REQUIREMENTS.md): extract reusable modules while retaining the current behavior. The Work Registry remains built in when its optional configuration is omitted, even when the project has no Work Items.

<!-- /jigwright:module-why -->

<!-- jigwright:region id=documents.repository-consumer-readme v=1 digest=sha256:4714bdb3729fe0833ec4bc9590420745ba84ebd277a17f9b2b89bd46e18bf406 -->

<!-- prettier-ignore-start -->

4 files changed in this module since confirmation.

## Commands

| Command and parameters | Does what |
| --- | --- |
| boundary inventory [--check] [--json] | Inspect or verify the machine-checked T3 consumer-coupling inventory. |
| boundary vectors [--check] [--json] | Authenticate the public language-neutral conformance corpus. |
| boundary remap --input &lt;request.json&gt; [--json] | Prove one exact mechanical move and project its authority remap manifest. |

## Data

| Type | Values | Source |
| --- | --- | --- |

## Contracts

- [Consumer Configuration Preserves Explicit Selections](spec.md#requirement-consumer-configuration-preserves-explicit-selections)
- [Consumer Paths Remain Within the Canonical Repository](spec.md#requirement-consumer-paths-remain-within-the-canonical-repository)

## Files

Header history compares Git blame at the explanation confirmation with this source snapshot. It is a hint, not verification of the explanation.

| File | Responsibility | Invariants | Header history |
| --- | --- | ---: | --- |
| [repository-consumer-config.ts](repository-consumer-config.ts) | Loads consumer configuration and resolves repository-contained policy paths. | 1 | History unavailable |
| [workflow-config.ts](workflow-config.ts) | Parses repository workflow configuration, namespace choices and task authorization policy. | 1 | History unavailable |

<!-- prettier-ignore-end -->

<!-- /jigwright:region -->

# Repository consumer

## Why this design

<!-- jigwright:module-why confirmed=7a8fb8990a902bf6f01d8e17cedc115486ac8d40 -->

Keep a project's schema, document paths, Work Registry settings and database policy in explicit repository configuration so the packaged engine can serve another project without embedded application defaults. The consumer loader resolves those selections through the public consumer port and checks paths against the canonical repository root; the workflow config parser handles the project's namespace and lifecycle settings. This follows the [recorded requirements](../../../../../docs/REQUIREMENTS.md): extract reusable modules while retaining the current behavior. The Work Registry remains built in when its optional configuration is omitted, even when the project has no Work Items.

<!-- /jigwright:module-why -->

<!-- jigwright:region id=documents.repository-consumer-readme v=1 digest=sha256:3373e53b7331f8ddf67340e333d240f3e76babec92e3a840e61e6ab0f02dc6a6 -->

<!-- prettier-ignore-start -->

8 files changed in this module since confirmation.

## Commands

| Command and parameters | Does what |
| --- | --- |
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
| [commit-facts.ts](commit-facts.ts) | Immutable Git commit facts and exact task-trailer matching. | 0 | History unavailable |
| [repository-consumer-policy.ts](repository-consumer-policy.ts) | Validates consumer policy values without observing repository files or adapters. | 0 | History unavailable |
| [repository-git-state.ts](repository-git-state.ts) | Observed Git identity and working-state facts, with no Git process dependency. | 0 | History unavailable |
| [repository-validation.ts](repository-validation.ts) | Canonical result of validating repository changes and managed documents. | 0 | History unavailable |
| [workflow-config.ts](workflow-config.ts) | Parses repository workflow configuration, namespace choices and task authorization policy. | 1 | History unavailable |

<!-- prettier-ignore-end -->

<!-- /jigwright:region -->

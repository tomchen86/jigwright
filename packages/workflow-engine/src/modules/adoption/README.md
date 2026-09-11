# Adoption

## Why this design

<!-- jigwright:module-why confirmed=7a8fb8990a902bf6f01d8e17cedc115486ac8d40 -->

Keep first-time setup incremental so a repository can adopt the harness without replacing decisions it already owns. `jigwright init` fills missing answers and validates requested configuration; host provider profiles stay outside the repository while repository settings and explicitly selected guidance targets stay with the project. This follows the [recorded requirements](../../../../../docs/REQUIREMENTS.md): setup should make the ordinary development path usable, preserve existing configuration and expose the next missing choice. Guidance installation owns a marked region, so the surrounding agent instructions remain editable by their owner.

<!-- /jigwright:module-why -->

<!-- jigwright:region id=documents.adoption-readme v=1 digest=sha256:eaab17f8075a6565205e52c4dcbf657bbfdccec73d8262c3eecb4602e8bba132 -->

<!-- prettier-ignore-start -->

3 files changed in this module since confirmation.

## Commands

| Command and parameters | Does what |
| --- | --- |
| init [--answers &lt;json-file&gt;] [--provider-config &lt;absolute-host-path&gt;] [--providers &lt;json-array&gt;] [--non-interactive] [question flags] [--json] | Fill missing setup answers and create a new host provider configuration when requested. |

## Data

| Type | Values | Source |
| --- | --- | --- |

## Contracts

- [Explicit Markdown Guidance Targets](spec.md#requirement-explicit-markdown-guidance-targets)
- [Stable Region Identity and User Ownership](spec.md#requirement-stable-region-identity-and-user-ownership)
- [Rules Share Maintained Sources](spec.md#requirement-rules-share-maintained-sources)
- [Centralized Incremental Adoption Setup](spec.md#requirement-centralized-incremental-adoption-setup)

## Files

Header history compares Git blame at the explanation confirmation with this source snapshot. It is a hint, not verification of the explanation.

| File | Responsibility | Invariants | Header history |
| --- | --- | ---: | --- |
| [agent-guidance.ts](agent-guidance.ts) | Explicit guidance target, configuration and exact Source wording policy. | 0 | History unavailable |
| [setup-questions.ts](setup-questions.ts) | Setup question, answer, defaults and provider-document policy without host or repository IO. | 0 | History unavailable |

<!-- prettier-ignore-end -->

<!-- /jigwright:region -->

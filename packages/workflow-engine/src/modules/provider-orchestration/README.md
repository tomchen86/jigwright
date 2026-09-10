# Provider orchestration

## Why this design

<!-- jigwright:module-why confirmed=7fa6a85ee1e5d43a6efa4c2ab8c3e0f31d5fcf69 -->

Keep installed provider profiles on the host so repositories select roles without owning executable commands. To register a built-in Codex or Claude profile, run `jigwright init` from the consumer repository, choose an absolute TOML path outside the repository, and enter the providers as a JSON array; for a macOS Codex installation at `/opt/homebrew/bin/codex`, use `[{"id":"codex-local","family":"codex","executable":"/opt/homebrew/bin/codex"}]`. Init validates and creates a new TOML file, including its explicit rankings; it preserves existing configuration. See [setup flags and answers](../../../../../docs/features/AGENT_GUIDANCE.md) for `--provider-config`, `--providers`, and noninteractive setup. Inspect the named profile with `jigwright agent provider probe codex-local --config /absolute/host/agent-providers.toml --json`. Then run `jigwright role-config configure --config /absolute/host/agent-providers.toml` in a terminal to choose and save declarative author, builder, and reviewer rules; inspect them with `jigwright role-config show --json`. A probe records observations without launching a model or accepting availability evidence. These steps register local profiles for existing provider families; repository policy still decides their permitted use.

<!-- /jigwright:module-why -->

<!-- jigwright:region id=documents.provider-orchestration-readme v=1 digest=sha256:7d5cf3e824c7b8b2e765fd30250609d0446184f2a6a7000d40a77c2a5cf2a915 -->

<!-- prettier-ignore-start -->

1 file changed in this module since confirmation.

## Commands

| Command and parameters | Does what |
| --- | --- |
| init [--answers &lt;json-file&gt;] [--provider-config &lt;absolute-host-path&gt;] [--providers &lt;json-array&gt;] [--non-interactive] [question flags] [--json] | Fill missing setup answers and create a new host provider configuration when requested. |
| adapter evaluate [--config &lt;absolute-host-path&gt;] [--json] | Inspect provider availability and configured policy. |
| agent provider probe &lt;profile-id&gt; --config &lt;absolute-host-path&gt; [--json] | Observe the selected host profile without launching a model. |
| agent provider test &lt;profile-id&gt; --config &lt;absolute-host-path&gt; --live [--json] | Record an explicitly requested live profile observation. |
| role-config &lt;show\|configure --config &lt;absolute-host-path&gt;\|simulate --config &lt;absolute-host-path&gt; --caller &lt;logical-provider-id&gt;&gt; [--json] | Inspect, configure or simulate declarative role and provider rules. |

## Data

| Type | Values | Source |
| --- | --- | --- |
| ActorAssurance | self-declared, runtime-hint, adapter-assigned | [actor-identity.ts](actor-identity.ts) |
| AgentRoleScopeRule | planning-generation, task, candidate | [agent-role-plan.ts](agent-role-plan.ts) |
| AgentRoleIndependenceRequirement | provider-independent, session-independent, none | [agent-role-plan.ts](agent-role-plan.ts) |
| AgentCustomWrapperPolicy | forbidden, allowed-non-protected, allowed | [agent-role-plan.ts](agent-role-plan.ts) |
| AgentRuntimeHostExecutionPhaseV1 | assignment-admitted, probe-attested, native-terminal | [agent-runtime-host-execution-binding.ts](agent-runtime-host-execution-binding.ts) |
| AttemptRetention | active, debug, pinned | [execution-record-types.ts](execution-record-types.ts) |
| ProviderNativeSessionDispositionV1 | usable, rejected, error, cancelled, timeout, indeterminate | [provider-native-session.ts](provider-native-session.ts) |
| OrdinaryRole | plan-reviewer | [role-scheduler.ts](role-scheduler.ts) |
| TaskDiffReviewRole | task-diff-reviewer | [role-scheduler.ts](role-scheduler.ts) |
| TaskImplementerRole | task-implementer | [role-scheduler.ts](role-scheduler.ts) |

## Contracts

- [Provider Execution Uses a Reviewed Built-In Registry](spec.md#requirement-provider-execution-uses-a-reviewed-built-in-registry)
- [Built-In Adapters Resolve Only Reviewed Executable Candidates](spec.md#requirement-built-in-adapters-resolve-only-reviewed-executable-candidates)
- [Actor Identity Is Resolved Once and Reported Honestly](spec.md#requirement-actor-identity-is-resolved-once-and-reported-honestly)
- [Independence Is Enforced Relative to Roles](spec.md#requirement-independence-is-enforced-relative-to-roles)
- [Every Provider Call Uses a Bound Typed Invocation](spec.md#requirement-every-provider-call-uses-a-bound-typed-invocation)
- [Read-Only Provider Results Require an Unchanged Governed Projection](spec.md#requirement-read-only-provider-results-require-an-unchanged-governed-projection)
- [Provider Baselines Preserve the Repository Object Format](spec.md#requirement-provider-baselines-preserve-the-repository-object-format)
- [Role Result Admission Distinguishes Provider and Non-Provider Work](spec.md#requirement-role-result-admission-distinguishes-provider-and-non-provider-work)

## Files

Header history compares Git blame at the explanation confirmation with this source snapshot. It is a hint, not verification of the explanation.

| File | Responsibility | Invariants | Header history |
| --- | --- | ---: | --- |
| [actor-identity.ts](actor-identity.ts) | No leading responsibility comment. | 0 | History unavailable |
| [agent-role-plan.ts](agent-role-plan.ts) | No leading responsibility comment. | 0 | History unavailable |
| [agent-runtime-assignment-binding.ts](agent-runtime-assignment-binding.ts) | No leading responsibility comment. | 0 | History unavailable |
| [agent-runtime-durable-authority.ts](agent-runtime-durable-authority.ts) | No leading responsibility comment. | 0 | History unavailable |
| [agent-runtime-host-execution-binding.ts](agent-runtime-host-execution-binding.ts) | No leading responsibility comment. | 0 | History unavailable |
| [agent-runtime-port.ts](agent-runtime-port.ts) | No leading responsibility comment. | 0 | History unavailable |
| [agent-runtime-protocol.ts](agent-runtime-protocol.ts) | Compatibility facade for the public agent-runtime protocol package. | 0 | Possibly stale |
| [blind-survey-output.ts](blind-survey-output.ts) | No leading responsibility comment. | 0 | History unavailable |
| [central-role-provider-default.ts](central-role-provider-default.ts) | No leading responsibility comment. | 0 | History unavailable |
| [change-role-assignment-grant.ts](change-role-assignment-grant.ts) | No leading responsibility comment. | 0 | History unavailable |
| [change-role-assignment-record.ts](change-role-assignment-record.ts) | No leading responsibility comment. | 0 | History unavailable |
| [change-role-assignment.ts](change-role-assignment.ts) | No leading responsibility comment. | 0 | History unavailable |
| [data-authorization-policy-port.ts](data-authorization-policy-port.ts) | No leading responsibility comment. | 0 | History unavailable |
| [execution-attempts.ts](execution-attempts.ts) | Pure Job and Attempt state transitions, including lease fencing and result acceptance. | 0 | No newer code observed |
| [execution-core.ts](execution-core.ts) | No leading responsibility comment. | 0 | History unavailable |
| [execution-record-types.ts](execution-record-types.ts) | Execution Job, Attempt, failure, and retry record contracts. | 0 | No newer code observed |
| [execution-records.ts](execution-records.ts) | Execution record codecs and canonical failure descriptors. | 0 | No newer code observed |
| [execution-retry.ts](execution-retry.ts) | Retry eligibility, grant requests, and failure-state decisions. | 0 | No newer code observed |
| [execution-values.ts](execution-values.ts) | Shared execution record value checks and canonical digest helpers. | 0 | No newer code observed |
| [provider-contracts.ts](provider-contracts.ts) | No leading responsibility comment. | 0 | History unavailable |
| [provider-native-session.ts](provider-native-session.ts) | No leading responsibility comment. | 0 | History unavailable |
| [provider-registry.ts](provider-registry.ts) | No leading responsibility comment. | 0 | History unavailable |
| [provider-retry-decision.ts](provider-retry-decision.ts) | No leading responsibility comment. | 0 | History unavailable |
| [provider-runtime-evidence.ts](provider-runtime-evidence.ts) | No leading responsibility comment. | 0 | History unavailable |
| [role-result-admission.ts](role-result-admission.ts) | Admitted role-result validation and live/consumed replay admission. | 0 | No newer code observed |
| [role-scheduler.ts](role-scheduler.ts) | No leading responsibility comment. | 0 | History unavailable |
| [role-topology-resolution.ts](role-topology-resolution.ts) | No leading responsibility comment. | 0 | History unavailable |
| [task-strategy-implementation-output.ts](task-strategy-implementation-output.ts) | No leading responsibility comment. | 0 | History unavailable |
| [task-strategy-provider-contract.ts](task-strategy-provider-contract.ts) | No leading responsibility comment. | 0 | History unavailable |

<!-- prettier-ignore-end -->

<!-- /jigwright:region -->

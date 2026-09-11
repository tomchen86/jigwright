# Provider orchestration

## Why this design

<!-- jigwright:module-why confirmed=7fa6a85ee1e5d43a6efa4c2ab8c3e0f31d5fcf69 -->

Keep installed provider profiles on the host so repositories select roles without owning executable commands. To register a built-in Codex or Claude profile, run `jigwright init` from the consumer repository, choose an absolute TOML path outside the repository, and enter the providers as a JSON array; for a macOS Codex installation at `/opt/homebrew/bin/codex`, use `[{"id":"codex-local","family":"codex","executable":"/opt/homebrew/bin/codex"}]`. Init validates and creates a new TOML file, including its explicit rankings; it preserves existing configuration. See [setup flags and answers](../../../../../docs/features/AGENT_GUIDANCE.md) for `--provider-config`, `--providers`, and noninteractive setup. Inspect the named profile with `jigwright agent provider probe codex-local --config /absolute/host/agent-providers.toml --json`. Then run `jigwright role-config configure --config /absolute/host/agent-providers.toml` in a terminal to choose and save declarative author, builder, and reviewer rules; inspect them with `jigwright role-config show --json`. A probe records observations without launching a model or accepting availability evidence. These steps register local profiles for existing provider families; repository policy still decides their permitted use.

<!-- /jigwright:module-why -->

<!-- jigwright:region id=documents.provider-orchestration-readme v=1 digest=sha256:ecb94a68a49a7c89edd2bb2aee3e88987fdf53ef9c2c4daf11f8bd97051824b9 -->

<!-- prettier-ignore-start -->

30 files changed in this module since confirmation.

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
| AgentRuntimeProcessTermination | exited, timed-out, cancelled, output-limit, spawn-error, protocol-error | [agent-runtime-port.ts](agent-runtime-port.ts) |
| ChangeRoleAssignmentDiagnosticReasonV1 | ADAPTIVE_CALLER_UNAVAILABLE, CALLER_SESSION_NOT_ADOPTABLE, CALLER_SESSION_UNAVAILABLE, CUSTOM_WRAPPER_FORBIDDEN, DATA_AUTHORIZATION_DENIED, FRESH_SESSION_UNSUPPORTED, LOGICAL_PROVIDER_UNAVAILABLE, PROFILE_DISABLED, PROVIDER_BOUNDARY_CONFLICT, PROVIDER_FAMILY_NOT_ALLOWED, RESUME_UNSUPPORTED, ROLE_CAPABILITY_UNSUPPORTED | [change-role-assignment.ts](change-role-assignment.ts) |
| RetryMode | same-input, execution-policy-change, repair, strategy-change, new-context, none | [execution-record-types.ts](execution-record-types.ts) |
| AttemptRetention | active, debug, pinned | [execution-record-types.ts](execution-record-types.ts) |
| FailureSource | provider, network, worker, lease, tool, validator, environment, state, effect, policy | [execution-record-types.ts](execution-record-types.ts) |
| ExecutionFailureKind | provider-timeout, network, rate-limit, provider-process-crash, worker-crash, lease-expiry, temporary-file-lock, provider-capacity, stdout-truncated, process-nonzero, json-parse, schema-mismatch, missing-required-field, citation-out-of-range, probe-transient, needs-user-decision, state-corruption, unknown-side-effect | [execution-record-types.ts](execution-record-types.ts) |
| ProviderNativeSessionDispositionV1 | usable, rejected, error, cancelled, timeout, indeterminate | [provider-native-session.ts](provider-native-session.ts) |
| ProviderNativeSessionErrorCode | PROVIDER_NATIVE_SESSION_INVALID, PROVIDER_NATIVE_SESSION_ASSIGNMENT_AUTHORITY_REQUIRED, PROVIDER_NATIVE_SESSION_CALLER_EXISTING_UNSUPPORTED, PROVIDER_NATIVE_SESSION_PROTOCOL_UNSUPPORTED, PROVIDER_NATIVE_SESSION_CAPABILITY_UNSUPPORTED | [provider-native-session.ts](provider-native-session.ts) |
| IndependenceDimension | provider-independent, principal-independent, session-independent, none | [role-scheduler.ts](role-scheduler.ts) |
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
| [actor-identity.ts](actor-identity.ts) | Resolves provider identity from explicit actor selection and recognized runtime hints. | 1 | History unavailable |
| [agent-role-plan.ts](agent-role-plan.ts) | Defines canonical agent role plans and their pinned snapshots. | 1 | History unavailable |
| [agent-runtime-assignment-binding.ts](agent-runtime-assignment-binding.ts) | Creates and validates the public binding of a durable role assignment to its provider profile and input manifests. | 1 | History unavailable |
| [agent-runtime-durable-authority.ts](agent-runtime-durable-authority.ts) | Validates durable assignment and native session references for AgentRuntime execution. | 1 | History unavailable |
| [agent-runtime-host-execution-binding.ts](agent-runtime-host-execution-binding.ts) | Binds host execution phases to executable, probe, and native session evidence. | 1 | History unavailable |
| [agent-runtime-port.ts](agent-runtime-port.ts) | Declares governed provider-worker inputs, asynchronous controls and terminal evidence. | 1 | History unavailable |
| [agent-runtime-protocol.ts](agent-runtime-protocol.ts) | Validates public provider protocol receipts against engine invocation and native-session bindings. | 1 | Header changed since confirmation |
| [blind-survey-output.ts](blind-survey-output.ts) | Defines and validates the provider output schema for an invocation-bound blind survey. | 1 | History unavailable |
| [central-role-provider-default.ts](central-role-provider-default.ts) | Defines central provider and session partitions, selection rules, and pinned defaults. | 1 | History unavailable |
| [change-role-assignment-grant.ts](change-role-assignment-grant.ts) | Creates Central Grant challenges and activation bindings for role assignments. | 1 | History unavailable |
| [change-role-assignment-record.ts](change-role-assignment-record.ts) | Materializes durable role assignment records, session slots, and Grant requirements. | 1 | History unavailable |
| [change-role-assignment.ts](change-role-assignment.ts) | Resolves providers and session topology from central rules, overrides, and authorization. | 1 | History unavailable |
| [data-authorization-policy-port.ts](data-authorization-policy-port.ts) | Exposes shared current data authorization policy types to provider orchestration. | 1 | History unavailable |
| [execution-attempts.ts](execution-attempts.ts) | Creates execution jobs and attempts and applies lease and result transitions. | 1 | Header changed since confirmation |
| [execution-core.ts](execution-core.ts) | Projects provider requests and invocation records into execution job and attempt state. | 1 | History unavailable |
| [execution-record-types.ts](execution-record-types.ts) | Defines engine Job, Attempt, failure and retry records around the shared execution contracts. | 1 | Header changed since confirmation |
| [execution-records.ts](execution-records.ts) | Validates execution records and constructs canonical failure descriptors. | 1 | Header changed since confirmation |
| [execution-retry.ts](execution-retry.ts) | Decides retry eligibility, budget grants, and projected execution failure state. | 1 | Header changed since confirmation |
| [execution-values.ts](execution-values.ts) | Validates execution value shapes and canonical record encodings. | 1 | Header changed since confirmation |
| [provider-contracts.ts](provider-contracts.ts) | Constructs provider requests and validates bound process outputs and failure results. | 1 | History unavailable |
| [provider-native-session.ts](provider-native-session.ts) | Defines native provider session scopes, claims, completions, and continuation handles. | 1 | History unavailable |
| [provider-registry.ts](provider-registry.ts) | Exposes reviewed built-in provider families and checks requested capability profiles. | 1 | History unavailable |
| [provider-retry-decision.ts](provider-retry-decision.ts) | Authorizes provider retries from durable attempt history and execution budget receipts. | 1 | History unavailable |
| [provider-runtime-evidence.ts](provider-runtime-evidence.ts) | Validates provider process results, runtime receipts, and execution observation bindings. | 1 | History unavailable |
| [role-result-admission.ts](role-result-admission.ts) | Admits role results and replays their ordinary or granted participant authority. | 1 | Header changed since confirmation |
| [role-scheduler.ts](role-scheduler.ts) | Schedules independent provider roles and validates granted role exceptions. | 1 | History unavailable |
| [role-topology-resolution.ts](role-topology-resolution.ts) | Resolves role independence from central policy, overrides, and actual placements. | 1 | History unavailable |
| [task-strategy-implementation-output.ts](task-strategy-implementation-output.ts) | Validates implementation patch output and optionally binds it to a sealed session and source tree. | 1 | History unavailable |
| [task-strategy-provider-contract.ts](task-strategy-provider-contract.ts) | Defines implementation and correction subjects, provider manifests, and output contracts. | 1 | History unavailable |

<!-- prettier-ignore-end -->

<!-- /jigwright:region -->

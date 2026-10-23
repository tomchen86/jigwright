# Authority

## Why this design

<!-- jigwright:module-why confirmed=fa1eab4fc25bd29bd01e7567d6785046592789a2 -->

Keep Grant Core as the single place that decides whether an exact operation may proceed, while the other modules report facts and recovery choices. This follows the [recorded requirements](../../../../../docs/REQUIREMENTS.md): an authorized continuation can reuse completed work without adding another veto or pretending a skipped check passed. Use inspection to understand current authority, approval to authorize the bound operation, and recovery to continue its recorded transaction.

<!-- /jigwright:module-why -->

<!-- jigwright:region id=documents.authority-readme v=1 digest=sha256:c95bda3f4e2b4c9e12fb29fb0b87769515c0b3831229ecbc1cdc53471d1a61f4 -->

<!-- prettier-ignore-start -->

114 files changed in this module since confirmation.

## Commands

| Command and parameters | Does what |
| --- | --- |
| grant approve &lt;grant-request.json&gt; [--uses &lt;count&gt;] [--json] | Authorize the exact requested operation through Grant Core. |
| grant inspect &lt;grant-id&gt; [--json] | Inspect an existing Grant and its state. |
| grant revoke &lt;grant-id&gt; --reason &lt;text&gt; [--json] | Revoke the named Grant with a recorded reason. |
| external-effect issue --grant &lt;uuid&gt; --task &lt;task-id&gt; --kind &lt;kind&gt; --target-file &lt;json&gt; --artifact-digest &lt;sha256:digest&gt; --prestate-digest &lt;sha256:digest&gt; --rollback-plan-file &lt;json\|none&gt; --idempotency-key &lt;key&gt; [--ttl-seconds &lt;1..300&gt;] [--json] | Authorize the exact external effect and its recorded prestate. |
| external-effect inspect &lt;grant-id&gt; [--json] | Inspect the external effect authorization. |
| external-effect revoke &lt;grant-id&gt; --reason &lt;text&gt; [--json] | Revoke the external effect authorization. |
| external-effect reconcile &lt;grant-id&gt; --evidence-file &lt;json&gt; [--json] | Record evidence about an uncertain external effect. |
| publish execute --grant &lt;external-effect-grant-id&gt; [--json] | Execute the publication bound to an external effect Grant. |
| task authorize &lt;manifest.json&gt; --audit-root &lt;absolute-external-path&gt; [--json] | Authorize the exact task manifest and its audit destination. |
| task status &lt;task-id&gt; [--json] | Inspect the Task Mandate state. |
| task revoke &lt;task-id&gt; --reason &lt;text&gt; [--json] | Revoke the Task Mandate with a recorded reason. |
| change revoke-intervention &lt;parent-change-id&gt; --reason &lt;text&gt; [--json] | Authorize disposal of retained intervention metadata; preserve WIP and child data. |
| intervention status &lt;parent-change-id&gt; [--json] | Inspect retained intervention metadata. |
| audit show &lt;task-id&gt; --audit-root &lt;absolute-external-path&gt; [--json] | Show audit evidence for the named task. |
| audit verify &lt;repository-id&gt; --audit-root &lt;absolute-external-path&gt; [--json] | Verify the repository audit evidence. |
| maintainer grant preflight --profile &lt;profile-id&gt; [--json] | Inspect the frozen candidate and required checks before signing. |
| maintainer grant approve-and-apply --change &lt;change-id&gt; --task &lt;mandate-task-id&gt; --profile &lt;profile-id&gt; --reason &lt;text&gt; --message &lt;subject&gt; --effects-file &lt;json\|none&gt; [--waivers-file &lt;json\|none&gt;] [--json] | Check, authorize and apply the frozen candidate. |
| maintainer grant reissue-and-apply --grant &lt;prior-grant-id&gt; --reason &lt;text&gt; [--ttl-minutes &lt;positive-integer&gt;] [--waivers-file &lt;json\|none&gt;] [--json] | Issue fresh authorization for a retained candidate and apply it. |
| maintainer revision-approval &lt;session-id&gt; --target &lt;digest&gt; --reason &lt;text&gt; [--json] | Approve the exact task revision target. |
| maintainer resolution-inspect [grant-id] [--json] | Inspect durable human resolution state. |
| maintainer resolution-publication-discard &lt;grant-id&gt; --expected-publication-state &lt;digest&gt; --reason &lt;text&gt; [--json] | Discard the exact pending resolution publication. |
| maintainer resolution-revoke &lt;grant-id&gt; --reason &lt;text&gt; [--json] | Revoke the named human resolution. |
| maintainer attest --original &lt;commit&gt; --main &lt;commit&gt; [--base &lt;original&gt;=&lt;main&gt; ...] [--json] | Attest the exact original and protected-main transitions. |
| maintainer attestation-relay --original &lt;commit&gt; [--json] | Relay the attestation for the original transition. |
| maintainer inspect [grant-id] [--json] | Inspect local maintainer authority state. |
| maintainer collaboration-grant --change &lt;id&gt; [--task &lt;task-id&gt;] --base &lt;commit&gt; --target &lt;digest&gt; --phase &lt;blind-survey\|plan-review\|task-diff-review\|task-implementation&gt; --author-role &lt;role&gt; --conflicting-role &lt;role&gt; (--provider &lt;codex\|claude&gt; --actor-assurance &lt;grade&gt;\|--caller &lt;id&gt; --actor-assurance &lt;grade&gt;\|--direct-human true) --degraded &lt;same-provider-fresh-session\|caller-supplied\|direct-human-review&gt; --reason &lt;text&gt; [--ttl &lt;minutes&gt;m] [--uses 1] [--json] | Authorize one precisely bounded collaboration downgrade. |
| maintainer collaboration-inspect [grant-id] [--json] | Inspect collaboration authorization state. |
| maintainer collaboration-revoke &lt;grant-id&gt; --reason &lt;text&gt; [--json] | Revoke the named collaboration authorization. |
| human-resolution-state &lt;investigation-id&gt; [--json] | Inspect the resolution state for an investigation. |
| grant human &lt;request-investigation-v3 &lt;investigation-id&gt; --reason &lt;agent-proposed-reason&gt;\|request-change-routing-continuation &lt;change-id&gt; --reason &lt;agent-proposed-reason&gt;\|request-work-item-review &lt;work-item-id&gt; --input &lt;review.json&gt; --reason &lt;reason&gt;\|request-work-item-promotion &lt;work-item-id&gt; --change &lt;change-id&gt; --expected &lt;digest&gt; --reason &lt;reason&gt;\|inspect &lt;challenge-id&gt;\|decide &lt;challenge-id&gt;\|recover &lt;challenge-id&gt;&gt; [--json] | Request, inspect, decide or recover an exact human authorization. |
| maintainer review-diff-attest &lt;session-id&gt; --input &lt;typed-envelope.json&gt; --grant &lt;grant-id&gt; [--json] | Sign and resume one exact durable direct-human TaskDiff review pause at the controlling maintainer terminal. |

## Data

| Type | Values | Source |
| --- | --- | --- |
| ActorAssurance | self-declared, runtime-hint, adapter-assigned | [actor-identity.ts](actor-identity.ts) |
| AuthorityAuditProfile | development, protected | [authority-audit-contract.ts](authority-audit-contract.ts) |
| CollaborationDegradedForm | same-provider-fresh-session, caller-supplied, direct-human-review | [collaboration-grant-codec.ts](collaboration-grant-codec.ts) |
| CollaborationLifecyclePhase | blind-survey, plan-review, task-diff-review, task-implementation | [collaboration-grant-codec.ts](collaboration-grant-codec.ts) |
| CollaborationAuthorRole | investigation-author, plan-author, task-implementer, red-author | [collaboration-grant-codec.ts](collaboration-grant-codec.ts) |
| CollaborationConflictingRole | plan-reviewer, task-diff-reviewer, task-implementer | [collaboration-grant-codec.ts](collaboration-grant-codec.ts) |
| RepairKind | schema, semantic | [execution-governance-repair.ts](execution-governance-repair.ts) |
| Retention | active, expiring, pinned | [execution-governance-retention.ts](execution-governance-retention.ts) |
| ExternalEffectReconciliationOutcome | succeeded, rolled-back, failed | [external-effect-grant.ts](external-effect-grant.ts) |
| TerminalState | consumed, revoked, expired, failed, manual-reconciliation | [external-effect-grant.ts](external-effect-grant.ts) |
| GitAuthorityCandidateApplyPhase | pending, prepared, index-published, commit-created, ref-update-prepared, ref-updated, completed, failed | [git-authority-candidate-apply-grant.ts](git-authority-candidate-apply-grant.ts) |
| GitObjectFormat | sha1, sha256 | [immutable-git-candidate.ts](immutable-git-candidate.ts) |
| ParentChangeStatus | draft, active, completed, cancelled, superseded | [intervention-record-contract.ts](intervention-record-contract.ts) |
| HarnessMaintenanceOperation | adopt-engine-into-parent, build-engine-artifact, create-isolated-workspace, modify-engine, run-engine-tests | [intervention-record-contract.ts](intervention-record-contract.ts) |
| HarnessMaintenanceWaiver | active-change-exclusivity, clean-worktree-required, engine-path-protection, parent-terminalization-required, selected-workflow-check | [intervention-record-contract.ts](intervention-record-contract.ts) |
| CheckReuseClass | content-pure, toolchain-dependent, external-state | [maintainer-candidate-contracts.ts](maintainer-candidate-contracts.ts) |
| CandidateClassification | ordinary, root-one-shot, control-plane | [maintainer-candidate-contracts.ts](maintainer-candidate-contracts.ts) |
| FileRole | implementation, evidence, policy, verification-infrastructure, forbidden | [maintainer-manifest-contracts.ts](maintainer-manifest-contracts.ts) |
| CheckDependency | source-tree, base-commit, harness-engine, policy, runner, external-state | [maintainer-manifest-contracts.ts](maintainer-manifest-contracts.ts) |
| ProfileAuthorityClass | ordinary, root-one-shot, control-plane | [maintainer-manifest-contracts.ts](maintainer-manifest-contracts.ts) |
| PatchOperation | add, modify, delete | [maintainer-manifest-contracts.ts](maintainer-manifest-contracts.ts) |
| ProtectedTaskApplyRecoveryAction | cancel, cancel-and-abort | [protected-task-apply-recovery-grant.ts](protected-task-apply-recovery-grant.ts) |
| RecoveryAuthorityImportPhase | prepare-prefix-written, prepare-fsynced, prepared, published | [recovery-authority-contract.ts](recovery-authority-contract.ts) |
| RecoveryQuarantineFaultPhase | reservation-published, reservation-durable, marker-published, marker-durable, release-claim-published, release-claim-durable, receipt-published, receipt-durable, terminal-published, terminal-durable, release-durable, audit-published, audit-appended, audit-ack-published | [recovery-quarantine-contract.ts](recovery-quarantine-contract.ts) |
| RecoveryOperationalTrustRootRestoreFaultPhase | prepare-prefix-written, prepare-fsynced, reservation-published, root-published, pointer-published, receipt-published, terminal-published, audit-published, audit-appended, audit-ack-published | [recovery-trust-root-contract.ts](recovery-trust-root-contract.ts) |

## Contracts

- [Actor Identity Is Resolved Once and Reported Honestly](spec.md#requirement-actor-identity-is-resolved-once-and-reported-honestly)
- [Protected Base Initialization Offers a Local Grant Choice](spec.md#requirement-protected-base-initialization-offers-a-local-grant-choice)
- [Canonical human-present authority attestation](spec.md#requirement-canonical-human-present-authority-attestation)
- [Exact authority transition identity](spec.md#requirement-exact-authority-transition-identity)
- [Protected retention and unique mapping](spec.md#requirement-protected-retention-and-unique-mapping)
- [Explicit grant-base identity mapping](spec.md#requirement-explicit-grant-base-identity-mapping)
- [Human-present grant issuance](spec.md#requirement-human-present-grant-issuance)
- [Git-common-directory grant state](spec.md#requirement-git-common-directory-grant-state)
- [Protected audit envelope](spec.md#requirement-protected-audit-envelope)
- [Fail-closed commit recovery](spec.md#requirement-fail-closed-commit-recovery)
- [Revocation and replay resistance](spec.md#requirement-revocation-and-replay-resistance)
- [Current Authority Uses Exact Candidate Apply](spec.md#requirement-current-authority-uses-exact-candidate-apply)
- [Exact Authority Candidates Carry Portable Evidence](spec.md#requirement-exact-authority-candidates-carry-portable-evidence)
- [Policy Transitions Preserve Observations and Exact Grant Authority](spec.md#requirement-policy-transitions-preserve-observations-and-exact-grant-authority)
- [Local Verification Does Not Claim Real Pilot Evidence](spec.md#requirement-local-verification-does-not-claim-real-pilot-evidence)
- [Historical Authority Replay Retains Required Trust](spec.md#requirement-historical-authority-replay-retains-required-trust)
- [V2 Grants Bind One Exact Profile Candidate](spec.md#requirement-v2-grants-bind-one-exact-profile-candidate)
- [Check Registry Changes Preserve Current Authority Boundaries](spec.md#requirement-check-registry-changes-preserve-current-authority-boundaries)

## Files

Header history compares Git blame at the explanation confirmation with this source snapshot. It is a hint, not verification of the explanation.

| File | Responsibility | Invariants | Header history |
| --- | --- | ---: | --- |
| [actor-identity.ts](actor-identity.ts) | Resolves provider identity from explicit actor selection and recognized runtime hints. | 1 | History unavailable |
| [archive-pr-grant.ts](archive-pr-grant.ts) | Builds and authenticates the Grant that authorizes an exact archive pull request publication. | 2 | History unavailable |
| [archive-publication-preparation.ts](archive-publication-preparation.ts) | Canonical archive preparation identity, validation and readonly data. | 0 | History unavailable |
| [authority-application-receipt.ts](authority-application-receipt.ts) | Admits portable authority receipts and coordinates their exact publication through required repository and signature capabilities. | 2 | History unavailable |
| [authority-attestation-admission.ts](authority-attestation-admission.ts) | Shared attestation request and grant admission errors. | 0 | History unavailable |
| [authority-attestation.ts](authority-attestation.ts) | Encodes authority attestations and verifies the original and protected- main commit pair. | 2 | History unavailable |
| [authority-audit-contract.ts](authority-audit-contract.ts) | Canonical authority audit evidence and refusal contracts. | 0 | History unavailable |
| [authority-refusal-audit.ts](authority-refusal-audit.ts) | Pure refusal identity/event construction and original-error preservation. | 0 | History unavailable |
| [authority-remap-contract.ts](authority-remap-contract.ts) | Canonical mechanical-move and authority-remap request/result contracts. | 0 | History unavailable |
| [authority-session-contract.ts](authority-session-contract.ts) | Durable state of an authority session and its pinned checks. | 0 | History unavailable |
| [collaboration-grant-codec.ts](collaboration-grant-codec.ts) | No leading responsibility comment. | 0 | Header changed since confirmation |
| [collaboration-grant-records.ts](collaboration-grant-records.ts) | Defines collaboration reservation, assignment, consumption, and inspection record shapes. | 2 | History unavailable |
| [collaboration-grant-use.ts](collaboration-grant-use.ts) | No leading responsibility comment. | 0 | History unavailable |
| [collaboration-grant-values.ts](collaboration-grant-values.ts) | Defines exact collaboration store values, canonical records, and stable error codes. | 2 | History unavailable |
| [execution-governance-context.ts](execution-governance-context.ts) | Defines manifest-bound prompts, result eligibility, and explicit epoch rollover decisions. | 3 | Possibly stale |
| [execution-governance-epoch-port.ts](execution-governance-epoch-port.ts) | No leading responsibility comment. | 0 | History unavailable |
| [execution-governance-grant-contracts.ts](execution-governance-grant-contracts.ts) | Defines strict execution-budget grant envelopes, usage records, and canonical signing bytes. | 2 | Possibly stale |
| [execution-governance-repair.ts](execution-governance-repair.ts) | Builds complete repair contexts and accounts for bounded schema and semantic retries. | 2 | No newer code observed |
| [execution-governance-retention.ts](execution-governance-retention.ts) | No leading responsibility comment. | 0 | Header changed since confirmation |
| [execution-governance-store-contracts.ts](execution-governance-store-contracts.ts) | No leading responsibility comment. | 0 | Header changed since confirmation |
| [execution-governance-store-transitions.ts](execution-governance-store-transitions.ts) | Pure state transitions applied between durable storage phases. | 0 | History unavailable |
| [execution-governance-values.ts](execution-governance-values.ts) | Shares canonical value validation and error preservation across execution governance. | 2 | Possibly stale |
| [execution-governance.ts](execution-governance.ts) | Pure execution-budget Grant binding checks and record transitions. | 0 | Header changed since confirmation |
| [external-effect-grant-audit.ts](external-effect-grant-audit.ts) | Constructs audit facts solely from the validated signed grant. | 0 | History unavailable |
| [external-effect-grant-envelope.ts](external-effect-grant-envelope.ts) | Exact external-effect request, payload and envelope codecs. | 0 | History unavailable |
| [external-effect-grant-records.ts](external-effect-grant-records.ts) | Canonical records and deterministic durable-state interpretation. | 0 | History unavailable |
| [external-effect-grant-services.ts](external-effect-grant-services.ts) | Required observations and durable operations for the external-effect lifecycle. | 0 | History unavailable |
| [external-effect-grant.ts](external-effect-grant.ts) | External-effect authority contracts, exact validation and state decisions. | 0 | History unavailable |
| [git-authority-candidate-apply-grant.ts](git-authority-candidate-apply-grant.ts) | Defines the Grant request, transition and validated results for applying an exact Git authority candidate. | 2 | History unavailable |
| [git-authority-candidate-apply-receipt.ts](git-authority-candidate-apply-receipt.ts) | Encodes and validates the portable receipt for a Git authority candidate application. | 2 | History unavailable |
| [grant-approval.ts](grant-approval.ts) | Evaluates registered approval proofs against the exact claims required by a Grant profile. | 2 | History unavailable |
| [grant-coordinator.ts](grant-coordinator.ts) | Requests, inspects, resolves and recovers durable Grant challenges under the supplied lifecycle lock. | 2 | History unavailable |
| [grant-core.ts](grant-core.ts) | Turns a blocked operation into one bounded, human-decidable Grant challenge and binds the chosen resolution to it. | 4 | History unavailable |
| [grant-errors.ts](grant-errors.ts) | No leading responsibility comment. | 0 | History unavailable |
| [grant-parent-binding.ts](grant-parent-binding.ts) | Builds and verifies canonical parent bindings and prepared descendant trees for Grants. | 2 | History unavailable |
| [grant-policy.ts](grant-policy.ts) | Parses Grant policy and resolves its registered approval modules, profiles and methods. | 2 | History unavailable |
| [grant-primitives.ts](grant-primitives.ts) | Provides Grant identifier, canonical value, key-set and timestamp primitives. | 2 | History unavailable |
| [grant-record-store.ts](grant-record-store.ts) | Grant record transitions over required canonical record persistence. | 0 | History unavailable |
| [grant-records.ts](grant-records.ts) | Canonical Grant records, evidence validation and exact record projections. | 0 | History unavailable |
| [grant-revocation-contract.ts](grant-revocation-contract.ts) | Canonical collaboration revocation targets and required transaction capabilities. | 0 | History unavailable |
| [grant-transition-registry.ts](grant-transition-registry.ts) | Registers Grant transitions and renders choices bound to their declared parameters and consequences. | 2 | History unavailable |
| [grant-verifier-port.ts](grant-verifier-port.ts) | Seals authoritative collaboration verifiers and resolves opaque consumed- replay verifier handles. | 2 | History unavailable |
| [harness-bootstrap-parent-contract.ts](harness-bootstrap-parent-contract.ts) | No leading responsibility comment. | 0 | History unavailable |
| [human-revocation-contract.ts](human-revocation-contract.ts) | Parses canonical human revocation envelopes and validates their exact subject bindings. | 2 | History unavailable |
| [immutable-git-candidate-codec.ts](immutable-git-candidate-codec.ts) | Decodes immutable Git candidates and validates their canonical patch, policy and check bindings. | 2 | Header changed since confirmation |
| [immutable-git-candidate.ts](immutable-git-candidate.ts) | Builds immutable Git candidates and verifies their observed repository state and pinned objects. | 2 | History unavailable |
| [intervention-bootstrap-contract.ts](intervention-bootstrap-contract.ts) | Retained intervention metadata and signed disposition inputs. | 0 | History unavailable |
| [intervention-control-adoption.ts](intervention-control-adoption.ts) | No leading responsibility comment. | 0 | History unavailable |
| [intervention-control-values.ts](intervention-control-values.ts) | Provides shared intervention value checks, signature namespaces and safe verifier calls. | 2 | History unavailable |
| [intervention-control.ts](intervention-control.ts) | Local intervention contracts and permitted workflow replacement reasons. | 0 | History unavailable |
| [intervention-record-contract.ts](intervention-record-contract.ts) | Validate retained intervention checkpoints and their signed maintenance grants. | 0 | History unavailable |
| [maintainer-candidate-contracts.ts](maintainer-candidate-contracts.ts) | Builds canonical candidate bundles, supporting artifacts and check freshness contracts. | 2 | Header changed since confirmation |
| [maintainer-candidate-dependencies.ts](maintainer-candidate-dependencies.ts) | Canonical candidate dependency projections and required observation contracts. | 0 | History unavailable |
| [maintainer-candidate-ref-ledger.ts](maintainer-candidate-ref-ledger.ts) | Canonical ref-generation state and prestate rules. | 0 | Header changed since confirmation |
| [maintainer-grant-contracts.ts](maintainer-grant-contracts.ts) | Owns the canonical maintainer Grant ID pattern and its exact admission error. | 0 | Header changed since confirmation |
| [maintainer-grant-v2-codec.ts](maintainer-grant-v2-codec.ts) | No leading responsibility comment. | 0 | Header changed since confirmation |
| [maintainer-grant-v2.ts](maintainer-grant-v2.ts) | Exact V2 candidate admission rules and canonical operation contracts. | 0 | History unavailable |
| [maintainer-manifest-contracts.ts](maintainer-manifest-contracts.ts) | Validates capability profiles and canonical patch manifests, including file roles and relationships. | 2 | Header changed since confirmation |
| [maintainer-manifest.ts](maintainer-manifest.ts) | Derives and verifies exact manifests against required, sequential repository observations. | 0 | History unavailable |
| [maintainer-policy.ts](maintainer-policy.ts) | No leading responsibility comment. | 0 | History unavailable |
| [maintainer-signer-port.ts](maintainer-signer-port.ts) | Declares the human-presence, identity, signing and verification port used by maintainer operations. | 1 | Header changed since confirmation |
| [protected-base-initialization-grant.ts](protected-base-initialization-grant.ts) | Requests and records authorization to initialize an exact protected branch on an empty remote. | 2 | History unavailable |
| [protected-base-selection-grant.ts](protected-base-selection-grant.ts) | Offers exact local or remote protected-base initialization through Grant Core. | 3 | History unavailable |
| [protected-task-apply-descendant-settlement-grant.ts](protected-task-apply-descendant-settlement-grant.ts) | Settles the prepared child-Grant tree before recovering its protected- task parent. | 2 | History unavailable |
| [protected-task-apply-grant.ts](protected-task-apply-grant.ts) | Defines the Grant that finalizes one exact protected task candidate through the supplied port. | 2 | History unavailable |
| [protected-task-apply-recovery-grant.ts](protected-task-apply-recovery-grant.ts) | Defines cancellation and cancellation-with-abort recovery for an in- progress protected-task application. | 2 | History unavailable |
| [provider-invocation-cancellation-grant.ts](provider-invocation-cancellation-grant.ts) | Defines exact cancellation Grants for prepared or leased provider invocations. | 2 | History unavailable |
| [publish-grant.ts](publish-grant.ts) | Exact publication contracts, receipt identities and terminal-state decisions. | 0 | History unavailable |
| [recovery-authority-contract.ts](recovery-authority-contract.ts) | Validates recovery authority descriptors against their canonical payload and external expectations. | 2 | Header changed since confirmation |
| [recovery-operational-trust-root.ts](recovery-operational-trust-root.ts) | Normalizes the operational trust root and its trusted maintainer signer identities. | 2 | Header changed since confirmation |
| [recovery-quarantine-contract.ts](recovery-quarantine-contract.ts) | Encodes quarantine Grants, markers, receipts and record chains for recovery state. | 2 | Header changed since confirmation |
| [recovery-trust-root-contract.ts](recovery-trust-root-contract.ts) | Encodes trust-root restoration records and checks replacement generations, grant windows and pointer state. | 2 | Header changed since confirmation |
| [recovery-trust-root-values.ts](recovery-trust-root-values.ts) | Defines recovery trust-root values, canonical encoders and structural predicates. | 2 | Header changed since confirmation |
| [role-context-sharing-consumed-replay.ts](role-context-sharing-consumed-replay.ts) | No leading responsibility comment. | 0 | History unavailable |
| [role-context-sharing-grant-lifecycle-port.ts](role-context-sharing-grant-lifecycle-port.ts) | No leading responsibility comment. | 0 | History unavailable |
| [role-context-sharing-grant-verifier-port.ts](role-context-sharing-grant-verifier-port.ts) | Seals and checks live and consumed-replay role-context-sharing verifier capabilities. | 2 | History unavailable |
| [role-context-sharing-grant.ts](role-context-sharing-grant.ts) | Validates role-context-sharing Grants and applies their reserve and consume transitions. | 2 | History unavailable |
| [role-independence-continuation-contracts.ts](role-independence-continuation-contracts.ts) | Validates and encodes role-independence continuation owners, parameters and observations. | 2 | Header changed since confirmation |
| [role-independence-continuation-grant.ts](role-independence-continuation-grant.ts) | Requests degraded role-independence continuation and authenticates its completed activation. | 2 | History unavailable |
| [task-mandate-access-contract.ts](task-mandate-access-contract.ts) | Authority capabilities required by actual mandate consumers. | 0 | History unavailable |
| [task-mandate-audit.ts](task-mandate-audit.ts) | Pure mandate audit scope, refusal binding and canonical event inputs. | 0 | History unavailable |
| [task-mandate-contract.ts](task-mandate-contract.ts) | Exact authority binding carried by execution jobs and Grants. | 0 | History unavailable |
| [task-mandate-policy.ts](task-mandate-policy.ts) | Deterministic provider scope, budget, reservation and preparation rules. | 0 | History unavailable |
| [task-mandate-records.ts](task-mandate-records.ts) | Canonical mandate requests, envelopes, records and issuance data. | 0 | History unavailable |
| [task-mandate-services.ts](task-mandate-services.ts) | Required repository, persistence, clock and audit capabilities for mandate rules. | 0 | History unavailable |
| [task-mandate-values.ts](task-mandate-values.ts) | Canonical Task Mandate data and deterministic scalar validation. | 0 | History unavailable |
| [task-mandate.ts](task-mandate.ts) | Pure mandate state, exact binding and observed repository trust decisions. | 0 | History unavailable |
| [task-revision-approval-contracts.ts](task-revision-approval-contracts.ts) | Validates and encodes exact task-revision widening approvals, including their paths and validity windows. | 2 | Header changed since confirmation |

<!-- prettier-ignore-end -->

<!-- /jigwright:region -->

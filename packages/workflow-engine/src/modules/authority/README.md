# Authority

## Why this design

<!-- jigwright:module-why confirmed=fa1eab4fc25bd29bd01e7567d6785046592789a2 -->

Keep Grant Core as the single place that decides whether an exact operation may proceed, while the other modules report facts and recovery choices. This follows the [recorded requirements](../../../../../docs/REQUIREMENTS.md): an authorized continuation can reuse completed work without adding another veto or pretending a skipped check passed. Use inspection to understand current authority, approval to authorize the bound operation, and recovery to continue its recorded transaction.

<!-- /jigwright:module-why -->

<!-- jigwright:region id=documents.authority-readme v=1 digest=sha256:435eecfbf70a68091e0fc73ffce6d347be7acad843631f8156519f71af68adaa -->

<!-- prettier-ignore-start -->

75 files changed in this module since confirmation.

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
| change intervene &lt;parent-change-id&gt; --reason &lt;text&gt; --audit-root &lt;absolute-external-path&gt; [--json] | Request human intervention in the named parent change. |
| change revoke-intervention &lt;parent-change-id&gt; --reason &lt;text&gt; [--json] | Revoke intervention in the named parent change. |
| engine build-artifact &lt;absolute-executable-path&gt; --for &lt;parent-change-id&gt; --protocol-version &lt;positive-integer&gt; --policy-schema-version &lt;positive-integer&gt; --audit-root &lt;absolute-path&gt; [--json] | Build an engine artifact for the exact intervention target. |
| engine adopt &lt;artifact-id&gt; --into &lt;parent-change-id&gt; --audit-root &lt;absolute-external-path&gt; [--json] | Adopt the selected engine artifact into the parent change. |
| intervention status &lt;parent-change-id&gt; [--tx &lt;tx-id&gt;] [--json] | Inspect the durable intervention transaction. |
| intervention recover &lt;tx-id&gt; [--json] | Recover the recorded intervention transaction. |
| control-plane produce &lt;frozen-candidate-bundle-digest&gt; [--json] | Produce a candidate from the frozen control-plane bundle. |
| control-plane approve-and-apply &lt;candidate-id&gt; --task &lt;parent-task-id&gt; [--json] | Authorize and apply the exact control-plane candidate. |
| control-plane recover &lt;grant-id&gt; [--json] | Recover the recorded control-plane operation. |
| control-plane status &lt;grant-id&gt; [--json] | Inspect the recorded control-plane operation. |
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
| CollaborationLifecyclePhase | blind-survey, plan-review, task-diff-review, task-implementation | [collaboration-grant-codec.ts](collaboration-grant-codec.ts) |
| CollaborationAuthorRole | investigation-author, plan-author, task-implementer, red-author | [collaboration-grant-codec.ts](collaboration-grant-codec.ts) |
| CollaborationConflictingRole | plan-reviewer, task-diff-reviewer, task-implementer | [collaboration-grant-codec.ts](collaboration-grant-codec.ts) |
| CollaborationDegradedForm | same-provider-fresh-session, caller-supplied, direct-human-review | [collaboration-grant-codec.ts](collaboration-grant-codec.ts) |
| ControlPlaneRecoverySourceState | RECOVERY_VERIFIED, SWITCHED, ROLLBACK_REQUIRED | [control-plane-recovery-grant.ts](control-plane-recovery-grant.ts) |
| ControlPlaneRecoveryAuditEvent | authorized, expired, failed, rolled-back, consumed | [control-plane-recovery-grant.ts](control-plane-recovery-grant.ts) |
| RepairKind | schema, semantic | [execution-governance-repair.ts](execution-governance-repair.ts) |
| Retention | active, expiring, pinned | [execution-governance-retention.ts](execution-governance-retention.ts) |
| ExternalEffectReconciliationOutcome | succeeded, rolled-back, failed | [external-effect-grant.ts](external-effect-grant.ts) |
| TerminalState | consumed, revoked, expired, failed, manual-reconciliation | [external-effect-grant.ts](external-effect-grant.ts) |
| GitAuthorityCandidateApplyPhase | pending, prepared, index-published, commit-created, ref-update-prepared, ref-updated, completed, failed | [git-authority-candidate-apply-grant.ts](git-authority-candidate-apply-grant.ts) |
| GitObjectFormat | sha1, sha256 | [immutable-git-candidate.ts](immutable-git-candidate.ts) |
| ParentChangeStatus | draft, active, completed, cancelled, superseded | [intervention-control-adoption.ts](intervention-control-adoption.ts) |
| HarnessMaintenanceOperation | adopt-engine-into-parent, build-engine-artifact, create-isolated-workspace, modify-engine, run-engine-tests | [intervention-control-adoption.ts](intervention-control-adoption.ts) |
| HarnessMaintenanceWaiver | active-change-exclusivity, clean-worktree-required, engine-path-protection, parent-terminalization-required, selected-workflow-check | [intervention-control-adoption.ts](intervention-control-adoption.ts) |
| EngineAdoptionState | PREPARED, PARENT_CHECKPOINTED, ENGINE_BINDING_UPDATED, NEW_ENGINE_STARTED, ROLLBACK_REQUIRED, HEALTHY, COMMITTED, ENGINE_BINDING_ROLLED_BACK | [intervention-control-adoption.ts](intervention-control-adoption.ts) |
| ControlPlaneFileModeV2 | 100644, 100755 | [intervention-control-promotion-material.ts](intervention-control-promotion-material.ts) |
| MinimalUpdaterState | PREPARED, OLD_CLOSURE_VERIFIED, CANDIDATE_VERIFIED, RECOVERY_VERIFIED, SWITCHED, SELF_TESTED, ROLLBACK_REQUIRED, FINALIZED, ROLLED_BACK | [intervention-control.ts](intervention-control.ts) |
| CheckReuseClass | content-pure, toolchain-dependent, external-state | [maintainer-candidate.ts](maintainer-candidate.ts) |
| CandidateClassification | ordinary, root-one-shot, control-plane | [maintainer-candidate.ts](maintainer-candidate.ts) |
| FileRole | implementation, evidence, policy, verification-infrastructure, forbidden | [maintainer-manifest.ts](maintainer-manifest.ts) |
| CheckDependency | source-tree, base-commit, harness-engine, policy, runner, external-state | [maintainer-manifest.ts](maintainer-manifest.ts) |
| ProfileAuthorityClass | ordinary, root-one-shot, control-plane | [maintainer-manifest.ts](maintainer-manifest.ts) |
| PatchOperation | add, modify, delete | [maintainer-manifest.ts](maintainer-manifest.ts) |
| ProtectedTaskApplyRecoveryAction | cancel, cancel-and-abort | [protected-task-apply-recovery-grant.ts](protected-task-apply-recovery-grant.ts) |
| RecoveryAuthorityImportPhase | prepare-prefix-written, prepare-fsynced, prepared, published | [recovery-authority-contract.ts](recovery-authority-contract.ts) |
| RecoveryQuarantineFaultPhase | reservation-published, reservation-durable, marker-published, marker-durable, release-claim-published, release-claim-durable, receipt-published, receipt-durable, terminal-published, terminal-durable, release-durable, audit-published, audit-appended, audit-ack-published | [recovery-quarantine-contract.ts](recovery-quarantine-contract.ts) |
| RecoveryOperationalTrustRootRestoreFaultPhase | prepare-prefix-written, prepare-fsynced, reservation-published, root-published, pointer-published, receipt-published, terminal-published, audit-published, audit-appended, audit-ack-published | [recovery-trust-root-contract.ts](recovery-trust-root-contract.ts) |

## Contracts

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
| [archive-pr-grant.ts](archive-pr-grant.ts) | Builds and authenticates the Grant that authorizes an exact archive pull request publication. | 2 | History unavailable |
| [authority-application-receipt.ts](authority-application-receipt.ts) | Creates, validates, signs and reads portable receipts for an applied authority candidate. | 2 | History unavailable |
| [authority-attestation.ts](authority-attestation.ts) | Encodes authority attestations and verifies the original and protected- main commit pair. | 2 | History unavailable |
| [authority-refusal-audit.ts](authority-refusal-audit.ts) | Records durable authority refusals while preserving the original operation error. | 2 | History unavailable |
| [collaboration-grant-codec.ts](collaboration-grant-codec.ts) | Encodes and verifies collaboration Grants and direct human review attestations. | 2 | Header changed since confirmation |
| [collaboration-grant.ts](collaboration-grant.ts) | Prepares and issues signed collaboration Grants and direct human review attestations. | 2 | History unavailable |
| [control-plane-recovery-grant-records.ts](control-plane-recovery-grant-records.ts) | Builds and normalizes recovery Grant payloads, completion receipts and audit records. | 2 | History unavailable |
| [control-plane-recovery-grant-storage.ts](control-plane-recovery-grant-storage.ts) | Reads and atomically replaces private recovery Grant records while reconciling interrupted writes. | 2 | History unavailable |
| [control-plane-recovery-grant.ts](control-plane-recovery-grant.ts) | Reserves, prepares, consumes, expires and fails durable one-use recovery Grants. | 2 | History unavailable |
| [execution-governance-context.ts](execution-governance-context.ts) | Defines manifest-bound prompts, result eligibility, and explicit epoch rollover decisions. | 3 | No newer code observed |
| [execution-governance-epoch-store.ts](execution-governance-epoch-store.ts) | Publishes and advances durable epoch contexts under their workflow-generation lock. | 3 | No newer code observed |
| [execution-governance-evidence-store.ts](execution-governance-evidence-store.ts) | Stores, pins, and prunes evidence through the current durable retention catalog. | 3 | No newer code observed |
| [execution-governance-grant-contracts.ts](execution-governance-grant-contracts.ts) | Defines strict execution-budget grant envelopes, usage records, and canonical signing bytes. | 2 | No newer code observed |
| [execution-governance-grant-store.ts](execution-governance-grant-store.ts) | Reads private grant records and prepares their grant-specific storage directories. | 2 | No newer code observed |
| [execution-governance-locks.ts](execution-governance-locks.ts) | Serializes grant and workflow mutations with their distinct private lock protocols. | 3 | No newer code observed |
| [execution-governance-private-files.ts](execution-governance-private-files.ts) | Preserves private file reads and the distinct atomic publication primitives used by governance. | 3 | No newer code observed |
| [execution-governance-prune-recovery.ts](execution-governance-prune-recovery.ts) | Reconciles prepared prune receipts against the published catalog before deleting objects. | 3 | No newer code observed |
| [execution-governance-repair.ts](execution-governance-repair.ts) | Builds complete repair contexts and accounts for bounded schema and semantic retries. | 2 | No newer code observed |
| [execution-governance-retention.ts](execution-governance-retention.ts) | Decides evidence retention and compacts epoch history without mutating durable storage. | 2 | No newer code observed |
| [execution-governance-store-contracts.ts](execution-governance-store-contracts.ts) | Validates durable context, retention, and prune envelopes with their exact CAS bindings. | 2 | No newer code observed |
| [execution-governance-store-objects.ts](execution-governance-store-objects.ts) | Publishes and reads private workflow context envelopes and content-addressed objects. | 2 | No newer code observed |
| [execution-governance-values.ts](execution-governance-values.ts) | Shares canonical value validation and error preservation across execution governance. | 2 | No newer code observed |
| [execution-governance.ts](execution-governance.ts) | Publishes, consumes, and revokes execution-budget grants with their durable audit trail. | 2 | No newer code observed |
| [external-effect-grant-audit.ts](external-effect-grant-audit.ts) | Builds external-effect audit events from the signed Grant and appends them with deterministic identities. | 2 | History unavailable |
| [external-effect-grant-envelope.ts](external-effect-grant-envelope.ts) | Parses external-effect requests and Grant envelopes with exact field and target-kind validation. | 2 | History unavailable |
| [external-effect-grant-reconciliation.ts](external-effect-grant-reconciliation.ts) | Reconciles uncertain external-effect outcomes and revokes eligible Grants without replaying the effect. | 2 | History unavailable |
| [external-effect-grant-records.ts](external-effect-grant-records.ts) | Builds and parses canonical external-effect reservation, transaction, observation and terminal records. | 2 | History unavailable |
| [external-effect-grant-store.ts](external-effect-grant-store.ts) | Stores private external-effect records and binds idempotency keys to exact Grants. | 2 | History unavailable |
| [external-effect-grant-transaction.ts](external-effect-grant-transaction.ts) | Advances external-effect reservations through dispatch, observation and terminal states. | 2 | History unavailable |
| [external-effect-grant.ts](external-effect-grant.ts) | Issues and inspects external-effect Grants bound to an active Task Mandate. | 2 | History unavailable |
| [git-authority-candidate-apply-grant.ts](git-authority-candidate-apply-grant.ts) | Defines the Grant request, transition and validated results for applying an exact Git authority candidate. | 2 | History unavailable |
| [git-authority-candidate-apply-receipt.ts](git-authority-candidate-apply-receipt.ts) | Encodes and validates the portable receipt for a Git authority candidate application. | 2 | History unavailable |
| [grant-approval.ts](grant-approval.ts) | Evaluates registered approval proofs against the exact claims required by a Grant profile. | 2 | History unavailable |
| [grant-coordinator.ts](grant-coordinator.ts) | Requests, inspects, resolves and recovers durable Grant challenges under the supplied lifecycle lock. | 2 | History unavailable |
| [grant-core.ts](grant-core.ts) | Turns a blocked operation into one bounded, human-decidable Grant challenge and binds the chosen resolution to it. | 4 | History unavailable |
| [grant-parent-binding.ts](grant-parent-binding.ts) | Builds and verifies canonical parent bindings and prepared descendant trees for Grants. | 2 | History unavailable |
| [grant-policy.ts](grant-policy.ts) | Loads Grant policy and resolves its registered approval modules, profiles and methods. | 2 | History unavailable |
| [grant-primitives.ts](grant-primitives.ts) | Provides Grant identifier, canonical value, key-set and timestamp primitives. | 2 | History unavailable |
| [grant-transition-registry.ts](grant-transition-registry.ts) | Registers Grant transitions and renders choices bound to their declared parameters and consequences. | 2 | History unavailable |
| [grant-verifier-port.ts](grant-verifier-port.ts) | Seals authoritative collaboration verifiers and resolves opaque consumed- replay verifier handles. | 2 | History unavailable |
| [human-revocation-contract.ts](human-revocation-contract.ts) | Parses canonical human revocation envelopes and validates their exact subject bindings. | 2 | History unavailable |
| [immutable-git-candidate-codec.ts](immutable-git-candidate-codec.ts) | Decodes immutable Git candidates and validates their canonical patch, policy and check bindings. | 2 | Header changed since confirmation |
| [immutable-git-candidate.ts](immutable-git-candidate.ts) | Builds immutable Git candidates and verifies their observed repository state and pinned objects. | 2 | History unavailable |
| [intervention-control-adoption.ts](intervention-control-adoption.ts) | Models intervention checkpoints, maintenance Grants and recoverable engine adoption transitions. | 2 | History unavailable |
| [intervention-control-promotion-grant.ts](intervention-control-promotion-grant.ts) | Builds and verifies promotion Grants bound to exact control-plane material and review evidence. | 2 | History unavailable |
| [intervention-control-promotion-material.ts](intervention-control-promotion-material.ts) | Normalizes promotion material, recovery bundles and lineage while classifying protected changes. | 2 | History unavailable |
| [intervention-control-protected-manifest.ts](intervention-control-protected-manifest.ts) | Builds protected-capability manifests and classifies the affected protected closures. | 2 | History unavailable |
| [intervention-control-review.ts](intervention-control-review.ts) | Validates signed independent reviews of exact control-plane promotion material and lineage. | 2 | History unavailable |
| [intervention-control-values.ts](intervention-control-values.ts) | Provides shared intervention value checks, signature namespaces and safe verifier calls. | 2 | History unavailable |
| [intervention-control.ts](intervention-control.ts) | Models minimal updater transitions, recovery decisions and permitted workflow replacement reasons. | 2 | History unavailable |
| [maintainer-candidate-contracts.ts](maintainer-candidate-contracts.ts) | Builds canonical candidate bundles, supporting artifacts and check freshness contracts. | 2 | Header changed since confirmation |
| [maintainer-candidate-ref-ledger.ts](maintainer-candidate-ref-ledger.ts) | Validates and publishes the durable ref-generation ledger used to detect stale candidate prestates. | 2 | Header changed since confirmation |
| [maintainer-candidate.ts](maintainer-candidate.ts) | Stores and reads immutable candidate bundles, their supporting artifacts and readable summaries. | 2 | History unavailable |
| [maintainer-grant-contracts.ts](maintainer-grant-contracts.ts) | Encodes canonical human-resolution envelopes and validates exact decision and state bindings. | 2 | Header changed since confirmation |
| [maintainer-grant-v2-codec.ts](maintainer-grant-v2-codec.ts) | Encodes exact Maintainer Grant payloads, envelopes, evidence waivers and check attestations. | 2 | Header changed since confirmation |
| [maintainer-grant-v2.ts](maintainer-grant-v2.ts) | Preflights, signs and admits Maintainer Grants for exact checked candidates against the live trust base. | 2 | History unavailable |
| [maintainer-grant.ts](maintainer-grant.ts) | Verifies human-resolution Grants and binds their audit tags to the maintainer trust base. | 2 | History unavailable |
| [maintainer-manifest-contracts.ts](maintainer-manifest-contracts.ts) | Validates capability profiles and canonical patch manifests, including file roles and relationships. | 2 | Header changed since confirmation |
| [maintainer-manifest.ts](maintainer-manifest.ts) | Builds and verifies exact patch manifests against the pinned trust base and observed worktree. | 2 | History unavailable |
| [maintainer-policy.ts](maintainer-policy.ts) | Loads maintainer policy, trusted signers and the eligible and sealed authority path sets. | 2 | History unavailable |
| [maintainer-signer-port.ts](maintainer-signer-port.ts) | Declares the human-presence, identity, signing and verification port used by maintainer operations. | 1 | Header changed since confirmation |
| [optional-grants-package.ts](optional-grants-package.ts) | Loads optional Grant implementations on demand and exposes their public contract operations. | 2 | History unavailable |
| [protected-base-initialization-grant.ts](protected-base-initialization-grant.ts) | Requests and records authorization to initialize an exact protected branch on an empty remote. | 2 | History unavailable |
| [protected-task-apply-descendant-settlement-grant.ts](protected-task-apply-descendant-settlement-grant.ts) | Settles the prepared child-Grant tree before recovering its protected- task parent. | 2 | History unavailable |
| [protected-task-apply-grant.ts](protected-task-apply-grant.ts) | Defines the Grant that finalizes one exact protected task candidate through the supplied port. | 2 | History unavailable |
| [protected-task-apply-recovery-grant.ts](protected-task-apply-recovery-grant.ts) | Defines cancellation and cancellation-with-abort recovery for an in- progress protected-task application. | 2 | History unavailable |
| [provider-invocation-cancellation-grant.ts](provider-invocation-cancellation-grant.ts) | Defines exact cancellation Grants for prepared or leased provider invocations. | 2 | History unavailable |
| [recovery-authority-contract.ts](recovery-authority-contract.ts) | Validates recovery authority descriptors against their canonical payload and external expectations. | 2 | Header changed since confirmation |
| [recovery-authority-store.ts](recovery-authority-store.ts) | Imports and reads the private recovery authority descriptor with exact replay and interrupted-write recovery. | 2 | Header changed since confirmation |
| [recovery-operational-trust-root.ts](recovery-operational-trust-root.ts) | Normalizes the operational trust root and its trusted maintainer signer identities. | 2 | Header changed since confirmation |
| [recovery-quarantine-contract.ts](recovery-quarantine-contract.ts) | Encodes quarantine Grants, markers, receipts and record chains for recovery state. | 2 | Header changed since confirmation |
| [recovery-quarantine-store.ts](recovery-quarantine-store.ts) | Publishes immutable private quarantine records and reconciles interrupted publications. | 2 | Header changed since confirmation |
| [recovery-trust-root-contract.ts](recovery-trust-root-contract.ts) | Encodes trust-root restoration records and checks replacement generations, grant windows and pointer state. | 2 | Header changed since confirmation |
| [recovery-trust-root-store.ts](recovery-trust-root-store.ts) | Publishes private trust-root restoration records and verifies their stored publication evidence. | 2 | Header changed since confirmation |
| [recovery-trust-root-values.ts](recovery-trust-root-values.ts) | Defines recovery trust-root values, canonical encoders and structural predicates. | 2 | Header changed since confirmation |
| [role-context-sharing-consumed-replay.ts](role-context-sharing-consumed-replay.ts) | Verifies consumed role-context-sharing records and replays their stored evidence for matching admission inputs. | 2 | History unavailable |
| [role-context-sharing-grant-lifecycle-port.ts](role-context-sharing-grant-lifecycle-port.ts) | Declares role-context-sharing records, use evidence and the lock-held lifecycle port. | 2 | History unavailable |
| [role-context-sharing-grant-verifier-port.ts](role-context-sharing-grant-verifier-port.ts) | Seals and checks live and consumed-replay role-context-sharing verifier capabilities. | 2 | History unavailable |
| [role-context-sharing-grant.ts](role-context-sharing-grant.ts) | Validates role-context-sharing Grants and applies their reserve and consume transitions. | 2 | History unavailable |
| [role-independence-continuation-contracts.ts](role-independence-continuation-contracts.ts) | Validates and encodes role-independence continuation owners, parameters and observations. | 2 | Header changed since confirmation |
| [role-independence-continuation-grant.ts](role-independence-continuation-grant.ts) | Requests degraded role-independence continuation and authenticates its completed activation. | 2 | History unavailable |
| [task-mandate-audit.ts](task-mandate-audit.ts) | Appends authority audit events for Task Mandate authorization, revocation and provider calls. | 2 | History unavailable |
| [task-mandate-policy.ts](task-mandate-policy.ts) | Checks Task Mandate provider scope, retries and budgets, and binds provider reservation identities. | 2 | History unavailable |
| [task-mandate-provider-lifecycle.ts](task-mandate-provider-lifecycle.ts) | Reserves and records Task Mandate provider calls while the lifecycle lock is held. | 2 | History unavailable |
| [task-mandate-records.ts](task-mandate-records.ts) | Parses and canonically serializes preparation-only Task Mandate requests, envelopes and records. | 2 | History unavailable |
| [task-mandate-store.ts](task-mandate-store.ts) | Reads and atomically publishes private Task Mandate files. | 2 | History unavailable |
| [task-mandate.ts](task-mandate.ts) | Issues, inspects and revokes preparation-only Task Mandates and authorizes their operations. | 2 | History unavailable |
| [task-revision-approval-contracts.ts](task-revision-approval-contracts.ts) | Validates and encodes exact task-revision widening approvals, including their paths and validity windows. | 2 | Header changed since confirmation |
| [task-revision-approval.ts](task-revision-approval.ts) | Issues and validates task-revision approvals from an independent trusted signer. | 2 | History unavailable |

<!-- prettier-ignore-end -->

<!-- /jigwright:region -->

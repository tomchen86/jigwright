# Authority

## Why this design

<!-- jigwright:module-why -->

Keep Grant Core as the single place that decides whether an exact operation may proceed, while the other modules report facts and recovery choices. This follows the [recorded requirements](../../../../../docs/REQUIREMENTS.md): an authorized continuation can reuse completed work without adding another veto or pretending a skipped check passed. Use inspection to understand current authority, approval to authorize the bound operation, and recovery to continue its recorded transaction.

Confirmed at commit: `fa1eab4fc25bd29bd01e7567d6785046592789a2`
<!-- /jigwright:module-why -->

<!-- jigwright:region id=documents.authority-readme v=1 digest=sha256:f13897f88ab07a9980ec296aa0b361dec6458d84fa619a87eb89f6c646b92052 -->

<!-- prettier-ignore-start -->

0 files changed in this module since confirmation.

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
| GitObjectFormat | sha1, sha256 | [immutable-git-candidate.ts](immutable-git-candidate.ts) |
| ParentChangeStatus | draft, active, completed, cancelled, superseded | [intervention-control-adoption.ts](intervention-control-adoption.ts) |
| ControlPlaneFileModeV2 | 100644, 100755 | [intervention-control-promotion-material.ts](intervention-control-promotion-material.ts) |
| CheckReuseClass | content-pure, toolchain-dependent, external-state | [maintainer-candidate.ts](maintainer-candidate.ts) |
| CandidateClassification | ordinary, root-one-shot, control-plane | [maintainer-candidate.ts](maintainer-candidate.ts) |
| ProfileAuthorityClass | ordinary, root-one-shot, control-plane | [maintainer-manifest.ts](maintainer-manifest.ts) |
| PatchOperation | add, modify, delete | [maintainer-manifest.ts](maintainer-manifest.ts) |
| ProtectedTaskApplyRecoveryAction | cancel, cancel-and-abort | [protected-task-apply-recovery-grant.ts](protected-task-apply-recovery-grant.ts) |
| RecoveryAuthorityImportPhase | prepare-prefix-written, prepare-fsynced, prepared, published | [recovery-authority-contract.ts](recovery-authority-contract.ts) |

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
| [archive-pr-grant.ts](archive-pr-grant.ts) | No leading responsibility comment. | 0 | History unavailable |
| [authority-application-receipt.ts](authority-application-receipt.ts) | No leading responsibility comment. | 0 | History unavailable |
| [authority-attestation.ts](authority-attestation.ts) | No leading responsibility comment. | 0 | History unavailable |
| [authority-refusal-audit.ts](authority-refusal-audit.ts) | No leading responsibility comment. | 0 | History unavailable |
| [collaboration-grant-codec.ts](collaboration-grant-codec.ts) | Pure collaboration grant and direct-review contracts, canonical bytes, and verification through a supplied verifier. | 0 | Possibly stale |
| [collaboration-grant.ts](collaboration-grant.ts) | No leading responsibility comment. | 0 | History unavailable |
| [control-plane-recovery-grant-records.ts](control-plane-recovery-grant-records.ts) | No leading responsibility comment. | 0 | History unavailable |
| [control-plane-recovery-grant-storage.ts](control-plane-recovery-grant-storage.ts) | No leading responsibility comment. | 0 | History unavailable |
| [control-plane-recovery-grant.ts](control-plane-recovery-grant.ts) | No leading responsibility comment. | 0 | History unavailable |
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
| [external-effect-grant-audit.ts](external-effect-grant-audit.ts) | No leading responsibility comment. | 0 | History unavailable |
| [external-effect-grant-envelope.ts](external-effect-grant-envelope.ts) | No leading responsibility comment. | 0 | History unavailable |
| [external-effect-grant-reconciliation.ts](external-effect-grant-reconciliation.ts) | No leading responsibility comment. | 0 | History unavailable |
| [external-effect-grant-records.ts](external-effect-grant-records.ts) | No leading responsibility comment. | 0 | History unavailable |
| [external-effect-grant-store.ts](external-effect-grant-store.ts) | No leading responsibility comment. | 0 | History unavailable |
| [external-effect-grant-transaction.ts](external-effect-grant-transaction.ts) | No leading responsibility comment. | 0 | History unavailable |
| [external-effect-grant.ts](external-effect-grant.ts) | No leading responsibility comment. | 0 | History unavailable |
| [git-authority-candidate-apply-grant.ts](git-authority-candidate-apply-grant.ts) | No leading responsibility comment. | 0 | History unavailable |
| [git-authority-candidate-apply-receipt.ts](git-authority-candidate-apply-receipt.ts) | No leading responsibility comment. | 0 | History unavailable |
| [grant-approval.ts](grant-approval.ts) | No leading responsibility comment. | 0 | History unavailable |
| [grant-coordinator.ts](grant-coordinator.ts) | No leading responsibility comment. | 0 | History unavailable |
| [grant-core.ts](grant-core.ts) | No leading responsibility comment. | 0 | History unavailable |
| [grant-parent-binding.ts](grant-parent-binding.ts) | No leading responsibility comment. | 0 | History unavailable |
| [grant-policy.ts](grant-policy.ts) | No leading responsibility comment. | 0 | History unavailable |
| [grant-primitives.ts](grant-primitives.ts) | No leading responsibility comment. | 0 | History unavailable |
| [grant-transition-registry.ts](grant-transition-registry.ts) | No leading responsibility comment. | 0 | History unavailable |
| [grant-verifier-port.ts](grant-verifier-port.ts) | No leading responsibility comment. | 0 | History unavailable |
| [human-revocation-contract.ts](human-revocation-contract.ts) | No leading responsibility comment. | 0 | History unavailable |
| [immutable-git-candidate-codec.ts](immutable-git-candidate-codec.ts) | Pure immutable Git candidate decoding and canonical object, patch, policy and check binding validation. | 0 | No newer code observed |
| [immutable-git-candidate.ts](immutable-git-candidate.ts) | No leading responsibility comment. | 0 | History unavailable |
| [intervention-control-adoption.ts](intervention-control-adoption.ts) | No leading responsibility comment. | 0 | History unavailable |
| [intervention-control-promotion-grant.ts](intervention-control-promotion-grant.ts) | No leading responsibility comment. | 0 | History unavailable |
| [intervention-control-promotion-material.ts](intervention-control-promotion-material.ts) | No leading responsibility comment. | 0 | History unavailable |
| [intervention-control-protected-manifest.ts](intervention-control-protected-manifest.ts) | No leading responsibility comment. | 0 | History unavailable |
| [intervention-control-review.ts](intervention-control-review.ts) | No leading responsibility comment. | 0 | History unavailable |
| [intervention-control-values.ts](intervention-control-values.ts) | No leading responsibility comment. | 0 | History unavailable |
| [intervention-control.ts](intervention-control.ts) | No leading responsibility comment. | 0 | History unavailable |
| [maintainer-candidate-contracts.ts](maintainer-candidate-contracts.ts) | Canonical candidate bundles, supporting artifacts and check freshness contracts; no repository reads or durable writes. | 0 | No newer code observed |
| [maintainer-candidate-ref-ledger.ts](maintainer-candidate-ref-ledger.ts) | One cohesive durable ref-generation ledger: validation, ABA prestate, lifecycle locking and durable transition publication. | 0 | No newer code observed |
| [maintainer-candidate.ts](maintainer-candidate.ts) | No leading responsibility comment. | 0 | History unavailable |
| [maintainer-grant-contracts.ts](maintainer-grant-contracts.ts) | Canonical human-resolution envelopes and exact decision/state validation; repository trust, audit tags and SSH verification stay in the original owner. | 0 | No newer code observed |
| [maintainer-grant-v2-codec.ts](maintainer-grant-v2-codec.ts) | Exact maintainer payload, evidence waiver and check-attestation codecs; signing, audit publication and terminal cleanup stay with issuance. | 0 | No newer code observed |
| [maintainer-grant-v2.ts](maintainer-grant-v2.ts) | No leading responsibility comment. | 0 | History unavailable |
| [maintainer-grant.ts](maintainer-grant.ts) | No leading responsibility comment. | 0 | History unavailable |
| [maintainer-manifest-contracts.ts](maintainer-manifest-contracts.ts) | Capability profile and patch-manifest canonical validation; repository observations and file reads remain in the original manifest owner. | 0 | No newer code observed |
| [maintainer-manifest.ts](maintainer-manifest.ts) | No leading responsibility comment. | 0 | History unavailable |
| [maintainer-policy.ts](maintainer-policy.ts) | No leading responsibility comment. | 0 | History unavailable |
| [maintainer-signer-port.ts](maintainer-signer-port.ts) | Authority-owned signing contract. | 0 | No newer code observed |
| [optional-grants-package.ts](optional-grants-package.ts) | No leading responsibility comment. | 0 | History unavailable |
| [protected-base-initialization-grant.ts](protected-base-initialization-grant.ts) | No leading responsibility comment. | 0 | History unavailable |
| [protected-task-apply-descendant-settlement-grant.ts](protected-task-apply-descendant-settlement-grant.ts) | No leading responsibility comment. | 0 | History unavailable |
| [protected-task-apply-grant.ts](protected-task-apply-grant.ts) | No leading responsibility comment. | 0 | History unavailable |
| [protected-task-apply-recovery-grant.ts](protected-task-apply-recovery-grant.ts) | No leading responsibility comment. | 0 | History unavailable |
| [provider-invocation-cancellation-grant.ts](provider-invocation-cancellation-grant.ts) | No leading responsibility comment. | 0 | History unavailable |
| [recovery-authority-contract.ts](recovery-authority-contract.ts) | Canonical recovery-authority records, exact value validation, and dependency contracts. | 0 | No newer code observed |
| [recovery-authority-store.ts](recovery-authority-store.ts) | Private recovery-authority storage, immutable publication, and crash residue recovery. | 0 | No newer code observed |
| [recovery-operational-trust-root.ts](recovery-operational-trust-root.ts) | Standalone operational trust-root content, signer/fingerprint validation, and content digest. | 0 | No newer code observed |
| [recovery-quarantine-contract.ts](recovery-quarantine-contract.ts) | Canonical recovery-quarantine records, exact value validation, and dependency contracts. | 0 | No newer code observed |
| [recovery-quarantine-store.ts](recovery-quarantine-store.ts) | Private recovery-quarantine storage, immutable publication, and crash residue recovery. | 0 | No newer code observed |
| [recovery-trust-root-contract.ts](recovery-trust-root-contract.ts) | Canonical recovery-trust-root-restore records, exact value validation, and dependency contracts. | 0 | No newer code observed |
| [recovery-trust-root-store.ts](recovery-trust-root-store.ts) | Private recovery-trust-root-restore storage, immutable publication, and crash residue recovery. | 0 | No newer code observed |
| [recovery-trust-root-values.ts](recovery-trust-root-values.ts) | Shared exact recovery values, canonical encoding, protocol constants, and error construction. | 0 | No newer code observed |
| [role-context-sharing-consumed-replay.ts](role-context-sharing-consumed-replay.ts) | No leading responsibility comment. | 0 | History unavailable |
| [role-context-sharing-grant-lifecycle-port.ts](role-context-sharing-grant-lifecycle-port.ts) | No leading responsibility comment. | 0 | History unavailable |
| [role-context-sharing-grant-verifier-port.ts](role-context-sharing-grant-verifier-port.ts) | No leading responsibility comment. | 0 | History unavailable |
| [role-context-sharing-grant.ts](role-context-sharing-grant.ts) | No leading responsibility comment. | 0 | History unavailable |
| [role-independence-continuation-contracts.ts](role-independence-continuation-contracts.ts) | Pure role-independence owner, parameter, degradation and observation contracts; Grant transition execution and activation authentication remain with their owner. | 0 | No newer code observed |
| [role-independence-continuation-grant.ts](role-independence-continuation-grant.ts) | No leading responsibility comment. | 0 | History unavailable |
| [task-mandate-audit.ts](task-mandate-audit.ts) | No leading responsibility comment. | 0 | History unavailable |
| [task-mandate-policy.ts](task-mandate-policy.ts) | No leading responsibility comment. | 0 | History unavailable |
| [task-mandate-provider-lifecycle.ts](task-mandate-provider-lifecycle.ts) | No leading responsibility comment. | 0 | History unavailable |
| [task-mandate-records.ts](task-mandate-records.ts) | No leading responsibility comment. | 0 | History unavailable |
| [task-mandate-store.ts](task-mandate-store.ts) | No leading responsibility comment. | 0 | History unavailable |
| [task-mandate.ts](task-mandate.ts) | No leading responsibility comment. | 0 | History unavailable |
| [task-revision-approval-contracts.ts](task-revision-approval-contracts.ts) | Task-revision approval record, payload and widening-binding contracts; issuer and repository-backed admission retain signing and storage authority. | 0 | No newer code observed |
| [task-revision-approval.ts](task-revision-approval.ts) | No leading responsibility comment. | 0 | History unavailable |

<!-- prettier-ignore-end -->

<!-- /jigwright:region -->

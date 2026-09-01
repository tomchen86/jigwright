# Workflow Engine Boundary Inventory

The extraction anchor is
`749616aa6e77ece5bcc3aa590a8b145d00c40e11`. This document now also records
the bounded T3 slices present in the current checkpoint; the anchor is not a
claim that those later slices existed in that commit. The companion fixture
freezes exact current-tree identities. When this inventory and the repository
disagree, code is authoritative.

## Scanner baseline

The production `jigwright boundary inventory --check` command parses TypeScript
and JavaScript syntax rather than counting comments. Its primary-source
baseline is 178 direct `workflow/*.json` literal occurrences in 60 files,
covering 11 unique paths.
AST provenance separately freezes four split `path.join`/`path.resolve` sites
and one workflow-root directory enumeration. Bootstrap TypeScript contributes
nine direct references in three files, and root tooling scripts contribute one.
The generated recovery projection contains 34 direct references in 13 files
and three split path joins in three files; these are pinned separately from the
primary extraction workload.

The retired signature/record namespace `expense-app.workflow.*` has zero
occurrences in primary TypeScript, bootstrap TypeScript, generated recovery
JavaScript, and workflow JSON artifacts. JSON Schema `$id` values are a
separate surface: all 15 tracked schemas use `jigwright.local`; the complete
URI identities, not only host counts, are frozen.

Top-level workflow artifacts contain a different path surface. Across
`workflow/*.json`, 1,261 string leaves in six files are equal to
`packages/workflow-engine` or begin with that package prefix. This scope
includes authority-sensitive policies and generated test shards; it does not
label every value as authority. Their file, JSON Pointer, and raw value
identities are frozen for mechanical remapping.

These numbers are scope-qualified. Generated recovery files are not counted as
additional extraction work, JSON Schema URIs are not signature namespaces, and
source references to workflow JSON files are not conflated with path-bearing
values inside workflow artifacts. The machine-readable fixture beside the
module migration map contains the exact scopes and identity digests.

## Coupling dispositions

<!-- coupling:agent-provider-identity -->

### Agent provider identity — landed

`@jigwright/agent-runtime` owns the exact immutable built-in provider family
registry, reviewed definition snapshots, and role-purpose capability policy.
The workflow-engine facade derives both identity and capability bytes from that
package-owned registry, retaining only workflow error mapping. Repository role
selection still belongs to repository policy and does not redefine provider
identity, reviewed command profiles, or provider capabilities.

<!-- coupling:availability-pilot -->

### Availability pilot — partial

The Codex/Claude verifier owns the exact-baseline, policy-bound availability
decision format. Consumer pilot evidence is not carried into Jigwright; the
real Jigwright pilot remains an explicit operational gate. A generic probe may
feed the verifier but must not create a second decision authority or convert a
pending pilot into an inferred pass.

<!-- coupling:central-grant-shadow-authority -->

### Central Grant shadow authority — landed

Direct Manifest v3 authority persists non-authorizing direct and publication
failure observations for Central Grant replay. The observation itself remains
explicitly non-authoritative (`authorityEligible: false`); the old transition
shadow store and parity authority are retired.

<!-- coupling:collaboration-grant -->

### Collaboration Grant — partial

The generic exact-envelope verifier, exact current envelope reader, and one-use
reserve/consume/expire/revoke lifecycle reducer are extracted to
`@jigwright/grants` and are used by Collaboration Grant. The exact
role-independence-only scope, TTL, durable bytes, and error mapping remain
intact. Workflow-specific payload semantics, locking, durable schema, and
storage remain in the engine; no broader blanket grant was introduced.

<!-- coupling:data-egress-authorization -->

### Data-egress authorization — landed

`workflow/ai-adapter-policy.json` schema v4 remains the repository-owned
provider authorization surface. A strict-v4 current-policy port now fronts it;
the v3 parser is replay-only and cannot become a second live authority source.

<!-- coupling:execution-substrate -->

### Execution substrate — partial

`@jigwright/core` now owns the exact Job/Attempt status vocabulary and the
AttemptResult acceptance-binding codec. Workflow, Job, Attempt, lease, retry,
and fencing in `execution-store` remain the existing sole aggregate and
transition authority. Broader Git/session/check/record ownership has not yet
moved, and no second lifecycle reducer was introduced.

<!-- coupling:openspec-direct-dependency -->

### OpenSpec direct dependency — coupled

Planning inspection now crosses `PlanningProviderPort`, but propose, archive,
and several CI paths still import the in-engine OpenSpec adapter directly. The
remaining coupling is the standalone adapter extraction and those direct
archive/propose seams, not absence of the planning port.

The planning seam retains all eight planning-provider responsibilities:
provider provenance, artifact inventory, task/source anchors, readiness
diagnostics, spec and archive targets, archive projection, error normalization,
and historical replay. Agent-runtime extraction does not absorb or weaken any
of them.

<!-- coupling:package-topology -->

### Package topology — landed

The public `jigwright` package composes `@jigwright/core`, optional
`@jigwright/grants`, `@jigwright/fixture-adapter`,
`@jigwright/agent-runtime`, and `@jigwright/openspec-adapter` through explicit
workspace dependencies. The fixture adapter consumes only public contracts.

<!-- coupling:planning-provider-binding -->

### Planning-provider binding — partial

The v1 binding contract, digest, current and pinned explicit readers,
composition wiring, archive retention, and explicit migration refusal are
landed. Every managed current or pinned planning tree requires its exact
per-change `workflow/change-providers` document; no inference or activation
marker path remains.

<!-- coupling:policy-path-literals -->

### Policy-path literals — coupled

Direct strings, split joins, and dynamic workflow-directory enumeration bind
the engine to the consumer repository layout. Path-bearing values in checks,
maintainer policy/profiles, path roles, protected capabilities, CI policy, and
test shards form a second remap surface. T3 replaces these with validated
repository configuration and keeps identity coverage for both surfaces.

<!-- coupling:provider-plane-separation -->

### Provider-plane separation — partial

Planning providers, agent runtimes, and grant verification have distinct engine
contracts. Required planning-binding paths and optional agent-role-plan paths
also have separate readers; an absent optional agent plan does not weaken or
replace the required planning contract. Core ownership of these ports and
direct adoption of a public `@jigwright/agent-runtime` execution port remain
incomplete.

<!-- coupling:provider-runner -->

### Provider runner — partial

The bounded async process primitive and strict JSONL wrapper protocol are now
owned by `@jigwright/agent-runtime` and consumed through engine compatibility
facades. Provider execution still preserves executable identity, a sanitized
environment, private runtime state, bounded execution, and governed evidence.
Reviewed provider identity and policy binding, synchronous compatibility,
non-resumable sessions, and the documented containment residuals remain in the
engine.

<!-- coupling:recovery-mirror -->

### Recovery mirror — landed

The recovery generator now compiles the reachable workspace source closure and
projects dependency packages into path-stable runtime locations while
retaining exact `--check`/`--write` tree comparison. The combined current-only
source closure and dependency packages have been regenerated together; stale
investigation replay and consumer namespace bytes are absent.

<!-- coupling:role-assurance -->

### Role assurance — landed

The role scheduler and provider-independent floor are production behavior.
Their separately planned pre-anchor/session-independent migration is not part
of this inventory slice.

<!-- coupling:runtime-distribution -->

### Runtime distribution — coupled

The current package requires Node and `--experimental-strip-types`. T3 keeps
that requirement through extraction; the v1 distribution decision belongs to
the later distribution phase.

<!-- coupling:schema-signature-namespace -->

### Schema and signature namespace — partial

`workflow/config.json` owns only the consumer namespace. New boundary records
carry the neutral `workflow.<kind>.vN` schema separately from
`consumerNamespace`; the current schema admission API has no configurable
legacy prefix or schema-selection fallback. The Collaboration Grant reader
admits only its neutral current V2 namespace; unsupported payload versions
cannot reach domain semantics or signature verification.

## Conformance and command surfaces

`packages/core/conformance/workflow-conformance-v2.json` is the authenticated,
language-neutral nine-domain corpus for canonical JSON, digest identity,
managed trailers, journal records, Manifest/PlanReview binding, Central Grant,
current Collaboration Grant envelopes, agent protocol frames and planning
bindings. The
`jigwright boundary vectors --check` production command authenticates the
corpus before a fixture or second implementation consumes it.

The production command guide is generated from the command registry. It owns
the inventory, vector and remap routes as well as their exact help usage, so a
new boundary surface cannot silently diverge between `guide` and `help`.

## Mechanical-move discipline

Each extraction batch follows the landed refactor precedent: add guardrails,
freeze an exact migration map, move one bounded ownership slice, regenerate
path-derived policy and recovery artifacts mechanically, then run targeted
contract checks. `mechanical-move` applies only where exact remap and blob
identity prove a byte-identical move. Import or content edits remain a separate
semantic commit with normal review. Each phase regenerates its authority remap
and projections once; identity or role-continuity failure keeps the ordinary
risk floor in force, and required-check migration is a definition transition,
never a suspension. A move must not silently strengthen authority, weaken
historical verification, duplicate the execution state machine, or add new
ordinary-change governance requirements.

`jigwright boundary remap --input <request.json>` is the read-only production
entry point. It proves adjacent pinned commits, exact blob/mode identity and
role continuity, then generates the remap manifest plus path-role, check,
guard, projection and bootstrap-regeneration projections. It never applies or
signs the resulting authority plan.

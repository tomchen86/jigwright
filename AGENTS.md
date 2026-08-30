# Jigwright Repository Instructions

## R-000 Product Purpose and Trust Model

### Product purpose

Jigwright is an AI-agent coding harness. It exists to improve the development
outcomes of well-intentioned AI agents by:

- preserving working memory and durable state;
- preventing drift from approved plans and task scope;
- avoiding duplicated, omitted, or incorrectly repeated work;
- supporting recovery, role collaboration, and progress visibility;
- keeping agents in an effective, fixed development flow so required steps and
  document updates are not forgotten;
- maintaining accurate development documents for later maintenance and
  implementation; and
- improving completion accuracy, development speed, and cost efficiency while
  reducing engine and workflow complexity.

Security governance is supporting infrastructure, not the product objective.
Controls must not impose disproportionate process cost, materially slow the
ordinary development path, or create avoidable deadlocks. An agent must not
independently raise a security classification, invent a non-grantable category,
make a workflow step permanently unskippable, or add approval, signing, review,
or evidence ceremony merely because stricter behavior appears safer. Such an
escalation is a product decision and requires explicit owner direction.

The default delivery order is the simplest usable production path first,
followed by the correctness and recovery boundaries needed to keep facts and
durable state truthful. Security-only edge cases, adversarial hardening, and
additional ceremony that do not protect an active production path are deferred;
they must not block ordinary capability delivery or expand the product threat
model by default.

### Trust model

- Agents are assumed to be well-intentioned but capable of mistakes,
  forgetting, misjudgment, or plan drift.
- Malicious, adversarial, or Byzantine agents are not the core product's
  primary threat model. Defences against malicious host or control bypass must
  not be prerequisites for the ordinary product path.
- Fail-closed is not the default response to a decision that can be submitted
  to Grant Core. The engine must prefer a precise Fail-Grant transition,
  especially when repeating interrupted work is expensive.
- Grant Core is the sole product authority boundary. Any entity admitted by
  Grant Core for an exact Grant may authorize any operation, risk acceptance,
  recovery choice, or workflow override. The engine must not apply a second
  safety veto after accepting that Grant.
- No operation category is inherently non-grantable. Exact Grants may authorize
  continuation despite corruption or tampering, unknown external effects,
  secret access, monetary cost, irreversible actions, commit, merge, signing or
  publication operations, or skipped tests, reviews, documents, and workflow
  steps.
- Fail-Grant pauses the operation and requests exact authorization. It records
  an explicit exception and must never silently permit an action.
- A Grant cannot falsify facts. It may authorize proceeding, accepting risk, or
  skipping a check, but cannot describe corrupted data as valid, a skipped
  check as passed, or a failed external effect as successful. Authorized
  exceptions remain explicit in durable evidence.
- Corruption acceptance binds the exact record digest and remains valid until
  the record changes, is repaired, or the Grant is revoked. Derived evidence
  must retain a `corruption-authorized` marker.
- Technical inability is not a permanent policy veto. The engine must report it
  truthfully and, where possible, offer exact grantable recovery choices such
  as continue, retry, ignore, replace, rebuild, or accept an uncertain result.
- Every control must demonstrably improve development outcomes or reduce a
  concrete correctness, recovery, cost, or data-exposure risk on an active
  production path. A control that mainly adds ceremony or risks deadlock must
  be simplified or removed.

This repository is current-only. Preserve all current-v3 product capabilities
and correctness invariants. Do not restore v1/v2 readers, migrations,
shadow/parity implementations, consumer application data, or consumer-specific
namespaces.

Normative requirements live in `openspec/specs/`. Governed changes live in
`openspec/changes/<change-id>/`. Runtime sessions, locks, reports, Git
validation, completion authority, and managed documents belong to the
executable engine rather than Markdown or an agent claim.

## Skill routing

- Use `openspec-explore` to investigate or clarify a change without editing.
- Use `openspec-propose` to create governed proposal, design, specs, tasks, and
  guard artifacts.
- Use `workflow-engine` to route implementation, recovery, review, finalization,
  and archive after planning is ready. The skill does not authorize a state
  transition; the executable command does.

The stable claim-ID/hardness registry is in `docs/WORKFLOW.md`. Preserve each
registered owner and hardness; do not invent a stronger synonym. An
investigation exemption changes investigation applicability only. A separate
task-execution exemption does not waive PlanReview, checks, or Git authority.

## Command routing

Planning and assurance:

- `pnpm workflow doctor --json`
- `pnpm workflow validate-change <id> --json`
- `pnpm workflow propose <id> --intent <intent.json> --json`
- `pnpm workflow plan-commit <id> --json`
- `pnpm workflow run-check <check-id> --json`
- `pnpm workflow ci --base <sha> --head <sha> --json`
- `pnpm workflow adapter evaluate --json`
- `pnpm workflow adapter availability-pilot --record <path> --json`
- `pnpm workflow adapter verify-availability-pilot --record <path> --json`

Planning assets:

- `pnpm workflow openspec-assets generate --json`
- `pnpm workflow openspec-assets check --json`
- `pnpm workflow openspec-assets install-prompts --codex-home <path> --json`

Managed lifecycle:

- `pnpm workflow open-task <id> --json`
- `pnpm workflow finalize <session-id> --message "Subject" --json`
- `pnpm workflow status <session-id> --json`
- `pnpm workflow check <session-id> --json`
- `pnpm workflow complete-task <session-id> --json`
- `pnpm workflow finish <session-id> --json`
- `pnpm workflow finalize-task <session-id> --json`
- `pnpm workflow rollback-completion <session-id> --json`
- `pnpm workflow commit <session-id> --message "Subject" --json`
- `pnpm workflow abort <session-id> --reason "Reason" --json`
- `pnpm workflow archive <id> --json`

Managed documents:

- `pnpm workflow documents validate --json`
- `pnpm workflow handoff validate --json`
- `pnpm workflow document-refresh propose ... --json`
- `pnpm workflow document-refresh show --proposal <id> --json`
- `pnpm workflow document-refresh review ... --json`
- `pnpm workflow document-refresh apply ... --json`

Repository hooks:

- `pnpm workflow hook pre-commit`
- `pnpm workflow hook commit-msg <path>`
- `pnpm workflow hook pre-push ...`
- `pnpm workflow hook post-merge`

Human-only maintainer inspection and ceremonies:

- `pnpm workflow maintainer grant ... --json`
- `pnpm workflow maintainer inspect --json`
- `pnpm workflow grant revoke <grant-id> --reason <text> --json`

Legacy V1 issuance, public authority-session commands, and live
human-resolution execution entrypoints are absent. Remaining historical
inspection parsers cannot authorize new work.

## Development rules

Use RED → GREEN → REFACTOR for behavior changes. Prefer targeted tests while
iterating, then run one full gate for the coherent candidate. Do not run
duplicate full gates on an unchanged tree. Database-writing tests require an
explicitly disposable database.

Use TypeScript and focused modules with explicit boundaries. Do not change, split, or refactor source solely because it exceeds 500 lines. Core must depend
on ports, not directly on optional Grants or integration implementations.

Do not manually stage or commit managed lifecycle changes. Use the workflow
commands and preserve the exact check evidence they return. Do not publish,
push, sign, or perform real external operations without explicit authority.

## Explicit owner override for repository development

This development mechanism is separate from the Jigwright product's Grant
Core. When the repository owner explicitly authorizes a named action, an agent
may perform that exact action without repository workflow authorization.

The authorization must identify the exact scope, worktree or branch, and
permitted Git operations. It does not authorize destructive operations, secret
access, signer impersonation, force-pushing protected branches, or unrelated
changes. The agent must preserve a recoverable snapshot and report the action
and verification results. These restrictions govern development agents; they
must not be implemented as a second runtime veto after Grant Core accepts an
exact product Grant.

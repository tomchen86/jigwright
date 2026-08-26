# Jigwright Repository Instructions

## Product and trust model

Jigwright improves the development outcomes of well-intentioned AI agents by
preserving durable state, preventing scope drift, supporting recovery and role
collaboration, and making completion evidence reproducible. Agents are assumed
to be fallible, not malicious. Secrets, irreversible external actions, money,
and commit, merge, signing, or publication authority retain explicit hard
boundaries.

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
- `pnpm workflow start <id> --task <task-id> --json`
- `pnpm workflow check <session-id> --json`
- `pnpm workflow complete-task <session-id> --json`
- `pnpm workflow finish <session-id> --json`
- `pnpm workflow finalize-task <session-id> --json`
- `pnpm workflow rollback-completion <session-id> --json`
- `pnpm workflow commit <session-id> --message "Subject" --json`
- `pnpm workflow abort <session-id> --reason "Reason" --json`
- `pnpm workflow archive <id> --json`

Managed documents and issues:

- `pnpm workflow issue add ... --json`
- `pnpm workflow issue update <id> ... --json`
- `pnpm workflow issue close <id> ... --json`
- `pnpm workflow issue render --json`
- `pnpm workflow issue validate --json`
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
- `pnpm workflow maintainer revoke <grant-id> --reason <text> --json`

Legacy V1 issuance and authority-session entry are disabled. Their historical
parsers cannot authorize new work.

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

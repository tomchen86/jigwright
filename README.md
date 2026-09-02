# Jigwright

Jigwright is a repository-owned current-v3 workflow harness for
well-intentioned AI agents. It is distributed as one public `jigwright` package
containing the installed CLI and public current-v3 module surfaces.

The Work Registry is always built in. Work Item use is not mandatory: a
repository may have zero Work Items, and a change may cite an immutable Source
directly.

## What it is for

Jigwright exists to improve the development outcomes of well-intentioned AI
agents: keep durable state and working memory, prevent drift from the approved
plan and task scope, make sure required steps and document updates are not
forgotten, and leave accurate development documents behind for the next agent
or human. Security governance is supporting infrastructure, not the objective;
the full product purpose and trust model is `R-000` in [`AGENTS.md`](AGENTS.md).

Two consequences shape everything below. First, authority is executable: a
transition happens only when a workflow command performs it, and prose, checked
boxes, and chat summaries never count as evidence. Second, when a decision can
be submitted to Grant Core the engine prefers an exact Fail-Grant pause over a
terminal failure, so interrupted work is resumed rather than repeated.

## How a change flows

```text
intake            planning                 execution                    closure
──────            ────────                 ─────────                    ───────
later <text> ─┐
now <text>   ─┼─▶ Source ledger ─▶ propose ─▶ [ open-task ─▶ finalize ]×N ─▶ archive
finding …    ─┘   Work Registry     │              │            │              │
                                    ▼              ▼            ▼              ▼
                          openspec/changes/<id>/   session +    checks +      deltas applied to
                          proposal, design,        guard.json   managed       openspec/specs/,
                          spec deltas, tasks       write scope  commit        handoff regenerated,
                                                                              Work Items closed
```

**Intake.** Wording from a person is captured verbatim, once, as an immutable
Governance Source under `workflow/source-ledger/`; everything downstream cites
its identity instead of copying the text. `later` parks a Source as an inbox
Work Item, `now` starts a change that cites the Source directly, and `attach`
adds wording to an existing item. Findings are an agent's private mid-task
observations; each ends as converted, linked, or dismissed. The backlog grows
only through reviewed intake, and the Work Registry is always available even
when a repository holds zero Work Items.

**Planning.** `propose` is a durable, resumable checkpoint wrapper around
investigation-first planning: sealed search terms are scanned across the pinned
Git tree, hits are grouped, every group receives an explicit disposition, and
each load-bearing file gets a WHY row bound to its exact blob. The result is one
change directory with a proposal, a design whose investigation ledger region
is engine-managed, requirement deltas, tasks, and a `guard.json` that fixes each
task's write scope and checks. PlanReview is advisory; it never replaces the
mechanical validators.

**Execution.** `open-task` opens one session against the current admission and
isolation facts. `finalize` validates the checked tree, runs the required
checks, escalates to the full gate when the change becomes all-terminal, stages
exactly that tree, and creates one managed commit carrying `Change:` and
`Task:` trailers. The transaction is replay-safe.

**Closure.** `archive` applies the requirement deltas to `openspec/specs/`,
regenerates the handoff, closes the Work Items linked through the change's
`origin.json`, and moves the change under `openspec/changes/archive/`.

**Authority.** Grant Core is the single authority boundary. A protected
transition emits one exact challenge instead of failing; `grant human …`
carries a person's decision back into the same transition. Grants are an
optional capability that is disabled by default, and maintainer ceremonies are
human-only.

**Providers.** Agent Runtime owns a fixed set of built-in provider families;
repository policy can enable, disable, and bound them but never add one. Roles
are author, builder, and reviewer, assigned by `workflow/role-provider-default.json`.

## Where things live

| Question                                                  | Look in                                                        |
| --------------------------------------------------------- | -------------------------------------------------------------- |
| What must the product do?                                 | `openspec/specs/<capability>/spec.md`                          |
| Why is a change being made, and what may each task touch? | `openspec/changes/<id>/`                                       |
| What was decided, and what is still open?                 | `docs/DECISION-REGISTER.md`                                    |
| What is active, blocked, and next?                        | `docs/CURRENT_AND_NEXT_STEPS.md` (generated)                   |
| What is parked?                                           | `docs/BACKLOG.md` (generated from `docs/work-registry/items/`) |
| How do I run a transition?                                | `docs/WORKFLOW.md` and the routing table in `AGENTS.md`        |
| Which documents may be edited, and how?                   | `workflow/document-policy.json`                                |
| How is the engine put together?                           | this file and `docs/architecture/`                             |

## Engine layout

The workspace holds one distribution package and its internal packages:

- `packages/workflow-engine` — the engine and the `jigwright` CLI.
- `packages/core` — ports and canonical JSON; it imports no feature implementation.
- `packages/agent-runtime` — provider processes, protocol frames, and built-in provider definitions.
- `packages/grants` — optional grant envelope readers and verifiers.
- `packages/openspec-adapter`, `packages/github-adapter`, `packages/fixture-adapter` — planning, remote, and test-fixture adapters.

Inside `packages/workflow-engine/src`, dependencies point downward:

| Layer               | Holds                                                                                                |
| ------------------- | ---------------------------------------------------------------------------------------------------- |
| `entrypoints/`      | `cli`, `ci`, `hooks`, and the provider `worker`                                                      |
| `application/`      | use cases: `propose`, `execute-task`, `finalize`, `archive`, `control-plane`                         |
| `runtime/`          | durable state: `storage-journal`, `session-workspace`, `managed-documents`, `repository-transaction` |
| `modules/`          | domain logic, one directory per domain (below)                                                       |
| `adapters/`         | `consumer`, `providers`, `remote`, `signing`, `compatibility`                                        |
| `foundation/`       | canonical JSON and error types                                                                       |
| `composition-root/` | wiring of ports to implementations                                                                   |

Domain modules:

| Module                   | Responsibility                                                                                     |
| ------------------------ | -------------------------------------------------------------------------------------------------- |
| `authority`              | Grant Core: every grant kind, maintainer grants, attestations, task mandates, intervention control |
| `governance-intake`      | Governance Sources, Findings, and the Work Registry                                                |
| `investigation`          | investigation-first planning: terms, scanning, groups, dispositions, the WHY manifest, sealing     |
| `why-knowledge`          | the semantic ledger, freshness, and implementation reconciliation                                  |
| `assurance`              | how much evidence each transition owes: PlanReview coverage, finalize check policy, term floors    |
| `lifecycle`              | change routing, the context manifest, and managed commit trailers                                  |
| `provider-orchestration` | actor identity, role plans, the provider registry, retry decisions, role scheduling                |
| `planning-provider`      | ports binding the planning-artifact provider and task history                                      |
| `projection`             | rendering structured evidence into managed documents such as the design ledger                     |
| `source`                 | path roles, mutation classes, declared symbols, and planning paths                                 |
| `guidance`               | usage text and the next steps every command returns                                                |
| `repository-consumer`    | parsing and validating a consumer repository's configuration                                       |

## Adopting Jigwright in a repository

There is no `init` command yet. A consumer repository installs the released
tarballs (pinned under `workflow/vendor/jigwright/<version>/`), maps
`pnpm workflow` to the `jigwright` bin, and carries its own configuration under
`workflow/`: `config.json`, `repository-consumer.json`, `document-policy.json`,
`path-roles.json`, `checks.json`, `ci-policy.json`, the grant and maintainer
policies, and `role-provider-default.json`. Planning skills and prompts are
generated with `pnpm workflow openspec-assets generate` and installed with
`install-prompts`. `doctor` reports what is missing or unsafe.

## Inspecting a repository

After installing the local package, inspect a repository with:

```bash
jigwright --repository-root /absolute/path/to/repository doctor --json
```

Installed consumers can inspect or watch one durable provider execution Job
through the read-only public module:

```ts
import {
  inspectExecutionJob,
  watchExecutionJob,
} from 'jigwright/execution-job';

const current = inspectExecutionJob('/absolute/path/to/repository', jobId);

const controller = new AbortController();
for await (const changed of watchExecutionJob(
  '/absolute/path/to/repository',
  jobId,
  { signal: controller.signal },
)) {
  console.log(changed.runtimeStatus);
}
```

The watch yields the current durable projection immediately, then only changed
projections, and stops at a terminal state or when its abort signal fires. It
does not stream provider transcripts or acquire retry, cancellation, or other
lifecycle authority.

This repository has no configured remote. Its local release workflow builds
candidate artifacts only; it does not publish an npm package or perform real
external operations.

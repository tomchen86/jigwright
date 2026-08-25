## Context

The repository agent guide combined valid OpenSpec and workflow rules with
retired tooling, incomplete command routing, and a hard 500-line refactoring
rule. The executable CLI and installed planning skills are the discoverable
authorities for the supported surface.

## Goals / Non-Goals

**Goals:**

- Make the agent guide a self-contained routing guide for supported planning
  skills and every public workflow command or subcommand.
- Treat 500 lines as a review signal, never a sufficient reason to edit source.
- Fail governance checks when prose and the executable command surface diverge.

**Non-Goals:**

- Changing product code, dependencies, databases, or APIs.
- Defining or migrating a consumer repository's document system.
- Inventing unsupported skill aliases or alternate workflow authority.

## Decisions

### 1. Document exact supported entry points

The guide names `openspec-explore` and `openspec-propose` exactly as installed.
It does not guess aliases. A decision table covers every command family printed
by the workflow CLI so an agent can select diagnostics, planning, execution,
recovery, documents, issues, assets, hooks, adapters, CI, and archive
operations.

### 2. Make source-size guidance explicitly non-authoritative

The guide prefers focused TypeScript modules and permits 500 lines as a
cohesion review signal. It prohibits source edits whose sole reason is file
length; a concrete behavior, ownership, testability, or maintainability
objective and normal verification are required.

### 3. Keep prose synchronized with executable discovery

Repository contracts compare the documented skills and command families with
the installed planning assets and public CLI surface. A command addition or
retirement therefore requires the guide and contracts to change together.

## Trust Boundaries and Failure Behavior

- Prose explains routing but never authorizes a lifecycle transition.
- Contracts fail when the guide names retired tooling, omits a public command
  or supported skill, or reinstates the hard line-count rule.
- Workflow commands remain responsible for planning, execution, Git, and
  archive authority.

## Migration Plan

1. Validate and commit the OpenSpec plan.
2. Establish RED contract evidence against the stale guide.
3. Update agent routing and source-size guidance, then demonstrate targeted
   GREEN against the executable command surface.
4. Complete and archive through the normal managed lifecycle.

## Open Questions

None.

## Context

The workflow engine performs a pinned OpenSpec archive in a temporary detached
worktree and strictly validates every rebuilt base spec. A base spec with valid
requirements but a nonconforming introductory heading blocked that transition.

OpenSpec remains planning and transformation machinery. The workflow engine,
not a direct OpenSpec command or prose status, owns archive authority.

## Goals / Non-Goals

**Goals:**

- Make the complete normative base-spec set pass pinned strict validation.
- Preserve every existing requirement, scenario, and purpose statement.
- Exercise the same pinned adapter used by the production archive path.

**Non-Goals:**

- Rewording or extending product requirements.
- Changing consumer application source or unrelated documentation.
- Weakening archive validation or accepting malformed diagnostics.

## Decisions

### Exercise the pinned adapter from the registered contract suite

The repository-baseline contract calls the same pinned adapter used by the
workflow engine. This validates actual OpenSpec structure and keeps future
base-spec drift inside the registered test boundary.

### Preserve prose and repair only invalid structure

Each invalid heading is replaced with the schema-required `Purpose` heading.
Existing prose, requirements, and scenarios remain unchanged.

### Keep archive fail-closed

The repository baseline is repaired instead of special-casing or suppressing
the archive validator. RED is the contract against the invalid baseline; GREEN
is the same contract and pinned validation after the structural repair.

## Migration Plan

1. Commit the planning baseline through the managed workflow.
2. Add the repository-baseline contract and demonstrate RED.
3. Repair only the invalid headings and demonstrate targeted GREEN.
4. Complete through the engine and retry the blocked archive transition.

## Open Questions

None.

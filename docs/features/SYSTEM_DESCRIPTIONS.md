# System descriptions

A containing `spec.md` owns the contracts for its directory. A module without
its own specification inherits the nearest containing one. Cross-module
contracts live at their common ancestor. The generated
[specification map](../SPEC_MAP.md) shows that ownership; it is an index rather
than another contract source.

Each requirement has `sources:` references to immutable original wording.
Each scenario has `covers:` pointing to its requirement or an actual file
header invariant, and `test:` naming a native case as `path#name`. Keep these
metadata fields on separate lines. Use reviewed OpenSpec deltas for changes
to normative behavior; archive resolves each delta back to its current
canonical owner.

The [requirements view](../REQUIREMENTS.md) prints original wording. The
[coverage view](../COVERAGE.md) shows exact scenario bindings and observed
results. A named test's presence does not prove it passed. A changed source
snapshot makes previous proof stale; skipped or failed tests remain visible.

```sh
pnpm workflow documents test --spec packages/workflow-engine/src/modules/governance-intake/spec.md --json
pnpm workflow documents render --json
pnpm workflow documents validate --json
```

`documents test` observes the referenced native cases. Omit `--spec` to select
all current specifications. `documents render` refreshes the map, coverage,
original wording and module README generated sections. `documents validate`
checks references, current proof and projection drift. Matching full-gate
telemetry can provide existing proof; an unobserved package case still needs
its own native observation.

Module READMEs keep a reviewed explanation of the design and generate command,
data, contract and file tables. A file header contains one responsibility
sentence and its `Invariants:` section. Imports supply dependencies; do not
maintain a parallel dependency list in prose. Header history can indicate
possible staleness without certifying the explanation or blocking work.

`open-task` includes the containing contract and module explanation from its
pinned baseline. When finalization identifies affected documents, inspect the
actual candidate and its review template:

```sh
pnpm workflow documents review <session-id> --json
pnpm workflow documents review <session-id> --input <review.json> --json
```

Record whether each contract or explanation was updated, remains valid, or
needs later work. The record binds that exact candidate; a later edit requires
a current review. An exact accepted Grant can skip the obligation with an
explicit exception. It does not turn missing documentation or test proof into
a passed check.

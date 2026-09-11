# Jigwright Architecture

Jigwright is distributed as one public package and CLI while retaining
package-grade internal module boundaries.

Package manifests declare `architecture.role: "domain-library"` for core and
Grants. This role requires every source file, including private and unused
files, to obey the domain dependency rules. Other packages default to
integration. Core does not depend on other workspace packages. Grants retains
its canonical branded types and receives verification, clocks and storage
through required capabilities; optional loading belongs to runtime composition.

The engine separates domain rules in `src/modules`, shared primitives in
`src/foundation`, use cases in `src/application`, external implementations in
`src/runtime` and `src/adapters`, production assembly in `src/composition-root`,
and input/output dispatch in `src/entrypoints`. A domain owner may consume its
own sources, foundation primitives and declared public domain-library exports.
Foundation has the narrower core-only package boundary. Use cases receive
required capabilities; composition binds the actual operations without eager
repository observations or silent production fallbacks. Interfaces belong to
the rule that needs them, and implementations use those canonical contracts.

`test/architecture-graph.contract.test.ts` checks the current source graph,
including type references, re-exports, dynamic imports, CommonJS loaders and
TypeScript aliases. The same ownership resolver serves focused domain-closure
tests. Package roles do not suppress edges or cycles. Missing dependencies,
computed targets, private cross-package imports, unsafe source/export paths
and unapproved external modules fail the guard. Domain dependencies permit
only crypto and path among Node builtins; all other external dependencies
require an explicit architectural decision. File and module-owner cycles are
checked separately from dependency direction.

Architecture acceptance also requires cohesive responsibilities, useful
abstractions, independent domain tests, preserved integration behavior and
accurate folder ownership. Passing import checks alone does not establish those
properties. The permanent guard uses no per-edge baseline or frozen module map.
Runtime source-closure and authorization digests remain product integrity
checks and are regenerated from their actual owners after source changes.

Consumer repositories own their application source, issue data, work items,
and product-specific adapters. Jigwright owns workflow lifecycle, planning,
Git CAS, recovery, managed documents, provider/session execution, optional
authorization composition, archive orchestration, and their current-v3
correctness invariants.

Durable understanding and in-flight evidence are separate stores with
different lifetimes. The semantic ledger under `workflow/semantic-ledger/`
is tracked content: it is committed, travels with the repository, and its
entries outlive any single change. Investigation evidence under the Git
common directory is local runtime state: it is never committed, every node
belongs to exactly one change, and no evidence reference crosses a change
boundary.

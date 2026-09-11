# Jigwright Architecture

Jigwright is distributed as one public package and CLI while retaining
package-grade internal module boundaries.

The current migration preserves the frozen current-v3 engine closure before
genericizing repository configuration and reorganizing modules. Core behavior
must not directly depend on optional Grants or integration implementations;
the composition root supplies those capabilities through core-defined ports.

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

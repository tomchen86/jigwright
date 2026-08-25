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

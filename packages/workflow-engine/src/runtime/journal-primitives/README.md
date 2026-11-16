# runtime/journal-primitives

The private-file and value primitives the durable journals are built from.
Split out of `storage-journal` so that `runtime/lifecycle-ledgers` — the two
ledgers the repository lifecycle lock rechecks before admitting an operation —
can sit below `session-workspace` without a cycle.

## Admission rule

A file belongs here only if **both** hold:

1. Its runtime imports are limited to `paths` and the filesystem primitives in
   `repository-transaction`. Anything reaching another runtime family is a
   store or an operation, not a primitive, and belongs with its family.
2. It is here because it _is_ a primitive, not because moving it closed a
   cycle.

Rule 2 is the important one. This folder is grouped by level rather than by
feature, which is the nearest thing in this codebase to the "move it to
shared and call it solved" pattern we reject. If a fifth file wants in because
its presence would break some future cycle, that is a design question about
where the dependency belongs — not a move to make here.

## Known exception to rule 1

`investigation-private-files.ts` imports
`../repository-transaction/filesystem-safety.ts`. That is a filesystem
primitive of the same level rather than a store, and `repository-transaction`
imports nothing from this folder, so the edge is one-way and closes no cycle.
It is why rule 1 names those primitives explicitly instead of saying "paths
only". If `filesystem-safety.ts` ever moves here, rule 2 still applies: it
would have to come because it is a primitive.

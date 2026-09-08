# Workflow engine responsibility refactor audit

The engine was scanned in full, and all identified large-file responsibility
mixes were resolved. The audit covers handwritten source, bootstrap, the native
helper, and tests under `packages/workflow-engine`. The baseline for this final
round is `9acbd6ef35bb92211bc1a8efdcc2d9a9e98f1129`; earlier extraction work is
already present at that commit.

[The complete file inventory](ENGINE_LONG_FILE_AUDIT.json) records the baseline
and current sizes, content hashes, decisions, retention reasons, and original
sources of every extracted module. It covers all 187 original candidates
(118 source/bootstrap and 69 tests), every current threshold candidate, and
supplemental extracted modules. The final scan examines 1,256 handwritten
TypeScript/JavaScript files; the 664-line native Swift helper was reviewed
separately.

A file reaching 1,000 lines or a function reaching 250 lines triggered review.
Those values are discovery thresholds. Decisions also use actual operations,
call graphs, effect boundaries, and transaction state dependencies. Generated
recovery JavaScript, shard wrappers, binaries, JSON data and the frozen TSV map
are accounted for separately.

## Work ownership

| Workstream  | Completed responsibility boundaries                                                                                                                               |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A           | Authority contracts and transactions, control-plane application services, bootstrap trust/materialization, sealed recovery helpers and their compilation boundary |
| B           | Runtime records/codecs, storage journals, publication/completion/recovery, execution governance, and blind-survey admission                                       |
| Coordinator | Application lifecycles, revision journals and implementation admission, core contracts, CLI command families, test families, cross-stream review and integration  |

## Representative results

These line counts compare this round's exact baseline with the final source.
Existing public facades remain available.

| File                                                                     | Before | After | Resulting boundary                                                                                     |
| ------------------------------------------------------------------------ | -----: | ----: | ------------------------------------------------------------------------------------------------------ |
| `bootstrap/control-plane-trust.ts`                                       |  7,915 |   120 | Bootstrap selection facade; provenance, closure, journal, filesystem and executable-source owners      |
| `src/runtime/storage-journal/investigation-session-store.ts`             |  7,011 |   375 | Session facade; records, evidence binding, journals, recovery and publication owners                   |
| `src/modules/authority/execution-governance.ts`                          |  3,536 |   884 | Governance decisions separated from epoch storage and evidence maintenance                             |
| `src/modules/governance-intake/work-registry.ts`                         |  2,935 | 1,248 | Work Item operations with distinct codecs and protocol helpers                                         |
| `src/application/execute-task/task-strategy-implementation-lifecycle.ts` |  2,756 |   496 | Entry points compose shared context, caller admission, provider reservations and result reconciliation |
| `src/application/revise/task-revision.ts`                                |  2,322 | 1,705 | Revision orchestration separated from journal codec/persistence and implementation snapshots           |
| `src/cli.ts`                                                             |  1,213 |   763 | Stable process boundary and routing with command-family parsing in entrypoints                         |
| `src/application/propose/propose-reviewer-terms.ts`                      |    574 |   385 | Reviewer evidence replay separated from blind-survey Grant admission                                   |

Long retained files have specific reasons in the inventory. For example,
`investigation-session.ts` keeps one session lifecycle, `finalize/lifecycle.ts`
keeps ordered finalization coordination, and `work-registry-promotion-transaction.ts`
keeps its journal/CAS/rollback protocol together. The 2,553-line candidate-apply
test file covers one atomic candidate-apply contract. Large `describe` containers
register independent cases; the largest actual retained case is 605 lines and
preserves one saved-session/materialization/replay proof.

## Preserved behavior and coverage

The refactor preserves public APIs, errors, signed/canonical values, locking,
CAS, journal ordering and replay boundaries. Declaration-level AST and binding
checks accompany A, B and coordinator extractions. The static test review at
refactor delivery (`c7a0c21`)
preserves all 9,217 original assertion calls across the 69 original test files
and their descendants. This is static preservation evidence; it is not a claim
that all assertions were executed in this run.

The test inventory now has 434 physical test files and 431 execution units.
All original physical test paths remain. At refactor delivery, shards used the
existing completed historical timing run and no new full gate had been run.
The owner subsequently authorized a full gate; its follow-up is recorded below.

Every one of the 273 new source files has a baseline origin. New files inherit
273 path-role rules, 540 protected-capability dependency entries and 11 verifier
composition source entries. No capability dependency was removed. The module
map remains at 262 rows and all 832 frozen dependency identities remain intact;
four actual cross-layer dependencies were retired, leaving 711 active edges.
T3 positive evidence follows the actual new owners, with every original literal
and negative assertion preserved.

Two integration corrections are recorded independently from mechanical moves:

- Pending provider replay now leaves admission to its exact owner operation;
  succeeded continuation recovery retains its locked reread and publication
  order. This makes the previously unreachable protected recovery cases run.
- Sealed harness helper types refer to leaf functions rather than maintainer
  approval orchestration, keeping unrelated workflow-directory enumeration out
  of the generated recovery mirror.

## Verification and delivery

TypeScript, dependency/T3/path-role/protected-capability contracts, test inventory,
formatting, and exact generator checks pass. Focused behavior checks cover the
changed authority/runtime families, revision and provider/caller correction
paths, bootstrap parent binding, supervisor replay/crash recovery and propose
admission. Per-command results and explicit test limits are recorded in the
inventory; overlapping workstream runs are not summed into a unique test count.

Work was performed directly in isolated local worktrees under the owner's
explicit override. No Claude, workflow-engine managed lifecycle, push, or remote
merge was used. Source commits, baseline snapshots and local
verification artifacts remain available. The reviewed result is integrated
locally into `work/pilot-findings-fixes`.

## Full-gate follow-up

The initial full gate and focused follow-ups identified stale test source
locations and an outdated installed `init` result expectation. The corrections
change seven test files and leave production source unchanged:

- A follows the extracted maintenance publication and grant storage owners,
  retaining exact replay call counts and authorization/currentness/terminal
  ordering. Added guards verify facade wiring and independent repair paths.
- B follows the extracted Git and core DTO definitions, includes the exact
  native-session owners, and checks negative surfaces across the original
  modules and their extracted implementation families. Matcher arguments,
  numeric restrictions and external consumer identities remain intact.
- The coordinator extends the exact installed `init` result expectation with
  `applied`, `pending` and `guidanceSuggestions`, keeping both complete installed
  lifecycles in the test. Governance finding checks verify actual callable
  exports and private-operation exclusion, with forbidden Source-root checks
  covering all six extracted implementation owners.

The integrated seven source-boundary cases and all three governance specification
cases pass. The installed tarball case
passes both complete lifecycles in approximately 48 minutes. A's fifteen negative
controls and the coordinator's twelve governance controls are rejected, and the
seven modified tests pass formatting checks. The
rescan still covers 1,256 handwritten files and 222 candidates, with no unreviewed
candidate. Per-file assertion preservation records are explicitly bound to the
refactor-delivery commit; the follow-up records explain the added guards and
strengthened expectation.

Concurrent documentation commits changed the main checkout's HEAD during the
initial run. Final gate validation therefore uses a fixed isolated worktree.
The exact result is recorded by its run-bound private full-gate receipt; this
tracked document does not claim a passing receipt.

The completed initial run reports 2,833 passed, seven failed, zero cancelled and
zero skipped test nodes, with all 434 expected physical files observed. Its
unmodified complete telemetry now assigns 52–57 execution units to each shard.
The generator check and all nine inventory contract cases pass; the inventory
test pins the exact new telemetry digest. No physical test or execution unit is
removed by the rebalance.

# Jigwright Workflow

Jigwright owns the executable transitions for planning, implementation,
review, recovery, commit, and archive. Prose and checked boxes describe state;
they do not authorize it.

## Repository skills

- `openspec-explore` supports read-only investigation.
- `openspec-propose` prepares governed planning artifacts.
- `workflow-engine` routes implementation and recovery after planning.

The engine records provider wait count/rate, collaboration-grant count/rate,
provider latency, and direct human review/action count so operational friction
is visible without turning empirical observations into structural proof.

### Stable assurance claim registry

| Claim                     | Meaning                                                                                                                             | Hardness                                                                        | Owner                                                                |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `C-TERM-SCAN`             | Every currently effective sealed term was scanned under the governed scan policy                                                    | Hard                                                                            | T1.5 sealed-investigation branch                                     |
| `C-TERM-SUPERSESSION`     | Engine-floor terms cannot be removed; an agent term leaves the effective set only by reviewed, reasoned, audit-visible supersession | Hard engine floor; audit-monotone but correctable agent contribution            | T1.5                                                                 |
| `C-TERM-COMPLETENESS`     | The effective term set is semantically complete                                                                                     | Soft and not provable                                                           | Residual, never delivered as hard                                    |
| `C-REVIEW-CURRENT`        | A review artifact exists, is immutable, and is current for its exact target                                                         | Hard                                                                            | T1.5                                                                 |
| `C-REVIEW-JUDGMENT`       | The reviewer judgment is correct                                                                                                    | Soft                                                                            | Human/agent judgment                                                 |
| `C-WHY-BINDING`           | Every required WHY field exists and is bound to exact source blobs                                                                  | Hard structure                                                                  | T1.5 sealed-investigation branch                                     |
| `C-WHY-TRUTH`             | The WHY explanation is true or proves understanding                                                                                 | Soft                                                                            | Human/agent judgment                                                 |
| `C-ARTIFACT-ORDER`        | Authoritative design materialization follows sealed investigation inputs                                                            | Hard artifact order; cognition order is not proved                              | T1.5 when investigation applies; exemption is separately labeled     |
| `C-SEMANTIC-INJECTION`    | `proposedTerms` is the only review-to-lifecycle semantic cost injection path and stays within aggregate budgets                     | Hard structural choke point and budgets; semantic usefulness is soft            | T1.5                                                                 |
| `C-EXACT-CLOSURE`         | Exact declared bytes are absent from the governed live closure scope                                                                | Hard                                                                            | T2.4 `mechanical-transform` engine evidence on exact candidate trees |
| `C-GRAPH-COMPLETENESS`    | All semantic consumers and dependency edges have been found                                                                         | Soft and not proved by grep or declared DAG structure                           | Residual, never delivered as hard                                    |
| `C-CANONICALIZATION`      | Canonical subjects preserve every assurance-relevant distinction                                                                    | Tested and fail-closed; residual implementation risk remains                    | T1.5 for planning subjects; later owners extend their subjects       |
| `C-COVERAGE-COMPOSITION`  | Composed review manifests cover exactly the claimed subject                                                                         | Hard algorithm over declared facts; semantic adequacy is soft                   | Future T2.3; not delivered by T1.5                                   |
| `C-CONVERGENCE`           | A reused descendant has a complete valid proof path to the current generation                                                       | Hard validator over declared graph; proof/canonicalizer defects remain residual | T1.5                                                                 |
| `C-PROVIDER-IDENTITY`     | Local provider identity from runtime hints or adapter assignment                                                                    | Soft                                                                            | T1.5 records assurance only                                          |
| `C-CONTAINMENT`           | A local provider is confined against the same OS user                                                                               | Soft without stronger isolation                                                 | Not delivered as hard                                                |
| `C-DEGRADED-INDEPENDENCE` | A collaboration grant recreates missing provider independence                                                                       | False; grant authorizes only visible degradation                                | T1.5                                                                 |
| `C-AVAILABILITY`          | The ordinary two-provider path meets wait, grant, latency, and cost budgets                                                         | Empirical pilot claim                                                           | T1.5 pilot, never structural proof                                   |

## Managed Task Lifecycle

The ordinary sequence is:

```text
propose → [ open-task → finalize ]×N → archive
```

Start planning with `pnpm workflow propose`. Enter implementation with `pnpm workflow open-task`. Finish one task with `pnpm workflow finalize <session-id>`.
The finalize durable transaction is replay-safe: it validates the checked tree
and stages only that exact checked tree before creating its managed commit.

An intermediate finalize runs targeted `requiredChecks`. When the projection
is all-terminal, `allTasksTerminalChecks` applies. The `workflow-full-gate`
covers `workflow-tests`, so do not run twice on the same tree. There is no defer
or skip flag. The operator message is: `This finalize completes the change → running full gate.`

For a long full gate, report:

- Monitor: pnpm workflow:test:status
- Machine status: pnpm workflow:test:status --json
- Full log: <exact stdout log path>
- Failures: pnpm workflow:test:failures

The compatibility lifecycle uses `pnpm workflow start`, then `pnpm workflow
check`, `pnpm workflow complete-task`, and `pnpm workflow finish`; `pnpm workflow finalize-task` and `pnpm workflow commit` complete the longer route.
That longer route cannot bypass the full gate.

Use `pnpm workflow status`, `pnpm workflow abort`, and `pnpm workflow
rollback-completion` only for their documented recovery states. Use `pnpm
workflow archive` only after every managed task commit is on the configured
base.

## Planning assurance boundaries

An investigation exemption marks `C-TERM-SCAN` and `C-WHY-BINDING`
inapplicable; it does not silently satisfy them. An investigation exemption
does not waive PlanReview, checks, or Git transitions. A task-execution exemption is separate and does not create an investigation exemption.

Semantic completeness remains soft and not proved. WHY truth remains soft and not proved. Provider identity is soft, not cryptographic identity. Same-user containment is soft and not proved without stronger isolation. Reviewer judgment remains soft and not proved by artifact existence.

Exact-byte closure is deterministic `mechanical-transform` evidence; it does not claim graph completeness or semantic equivalence. A degraded grant does not recreate provider independence. Availability is an empirical pilot claim, not structural proof.

## Checks and CI

Use `pnpm workflow doctor`, `pnpm workflow validate-change`, and `pnpm workflow
run-check` for read-only diagnostics. CI recomputes assurance with `pnpm
workflow ci`. Planning assets use `pnpm workflow openspec-assets generate`,
`pnpm workflow openspec-assets check`, and `pnpm workflow openspec-assets
install-prompts`.

## Maintainer authority

Maintainer ceremonies are human-only and require a controlling interactive terminal. Operators use `pnpm workflow maintainer grant`, `pnpm workflow
maintainer attest`, `pnpm workflow maintainer attestation-relay`, `pnpm
workflow maintainer inspect`, and the family-neutral `pnpm workflow grant
revoke`.

The local signer is configured with `git config --local gpg.format ssh` and
`git config --local user.signingkey`. Protected audit refs include
`workflow-grant/**` and `workflow-attestation/**`. Sealed enforcement requires a
migration gate, a protected environment, and a one-way transition. Emergency
recovery remains repository-admin, out-of-band authority.

Legacy V1 issuance, public authority-session commands, and live
human-resolution execution entrypoints are absent. Remaining historical
inspection surfaces exist only for terminal cleanup and cannot authorize new
work.

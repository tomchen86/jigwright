# Native agent guidance

Jigwright keeps a generated region in instruction Markdown files you select.
The same four rules appear for every provider. Content outside the hidden
markers, including a renamed heading, remains yours.

```sh
jigwright guidance install                 # suggestions only
jigwright guidance install AGENTS.md .qwen/AGENTS.md
jigwright guidance status
jigwright guidance refresh
jigwright guidance remove
```

Install and refresh print diffs before writing. Status recomputes the content;
it does not trust the recorded digest or repair drift. Removing either
marker is treated as intentional removal. Refresh does not recreate it;
explicit install does. Remove retains the heading and target configuration.

Targets live in `workflow/agent-guidance.json`:

```json
{
  "targets": [
    { "path": "AGENTS.md" },
    { "path": ".qwen/AGENTS.md", "label": "qwen" }
  ]
}
```

Only repository-relative `.md` or `.markdown` files are supported. Targets
must be plain UTF-8 files without symlink traversal. Installation into an
unclosed fenced block is rejected so it cannot report an invisible region as
installed. Multi-file changes are preflighted and checked for concurrent edits;
they are not a cross-file transaction.

`jigwright init` asks missing setup questions in order. Existing host provider
configuration stays on the host. Guidance installation follows confirmation
of exact paths. Repeated init fills missing answers and preserves existing
policy/configuration values. A script can supply the same answers explicitly:

```sh
jigwright init --non-interactive --no-provider --guidance-target AGENTS.md --json
jigwright init --answers setup-answers.json --json
jigwright init --help
```

The answers file accepts question IDs: `providerConfig`, `providers`,
`guidanceTargets`, `consumerId`, `handoffPath`, and `databasePolicy`.
`providerConfig` selects an existing or new absolute host TOML path. A new path
also needs `providers`, an array of `{id, family, executable}` entries using
absolute executable paths; flags accept the same array through `--providers`.
Init creates and validates new host configuration without launching providers
or overwriting an existing TOML. Missing provider/guidance answers stay pending
in noninteractive runs; a selected new provider path requires its provider
entries before any setup writes. An explicit skip is remembered; use guidance
install directly to add targets later.

Doctor includes the shared projection catalog, with target states such as
current, drifted, missing, removed and unexpected. WHY and registry output
retain their existing bytes and configured locations. Curated document refresh
uses the shared splice while keeping its proposal/review/apply workflow.

The R-000 sentences are generated from the repository's AGENTS.md. Maintainers
update packaged source text with
`node --experimental-strip-types scripts/generate-agent-rule-sources.ts`;
the contract test detects stale output. The other rules use the code-owned
Source-text and intake policies and the current command catalog.

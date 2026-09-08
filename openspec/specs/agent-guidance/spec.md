# agent-guidance Specification

## Purpose

Keep native agent instruction files current with generated repository rules,
while preserving the user's surrounding Markdown and configuration choices.

## Requirements

### Requirement: Explicit Markdown Guidance Targets

The engine SHALL store path-keyed target declarations and optional display labels
in `workflow/agent-guidance.json`. All providers SHALL receive the same generated
content. Guidance SHALL NOT make an instruction file a whole-file managed
document or infer a provider from its filename.

#### Scenario: Install is invoked without paths

- **WHEN** `guidance install` receives no paths
- **THEN** it suggests existing root `AGENTS.md`, `CLAUDE.md`, and `GEMINI.md`
- **AND** it does not write configuration or instruction files

#### Scenario: Explicit target installation

- **WHEN** `guidance install <path>…` receives safe Markdown targets
- **THEN** it registers those paths and installs one generated region in each
- **AND** it prints all proposed section and config diffs before writing
- **AND** unsupported formats, unsafe paths, invalid UTF-8, or ambiguous regions fail before target writes

### Requirement: Stable Region Identity and User Ownership

The engine SHALL identify its region using
`<!-- jigwright:region id=guidance.agent-section v=… digest=… -->` and
`<!-- /jigwright:region -->`. The initial visible heading SHALL be
`## Jigwright`; subsequent heading edits SHALL NOT change region identity.
Every byte outside the marker region SHALL remain unchanged by refresh/remove.
Removal SHALL retain the target declaration so status can report its absence.

#### Scenario: Content drift

- **WHEN** a user changes generated content or marker version/digest
- **THEN** status independently recomputes the expected content and reports drift
- **AND** status and doctor do not repair it
- **AND** explicit refresh previews and replaces only the owned region

#### Scenario: The user removes a region marker

- **WHEN** a configured target has no recognizable opening or closing marker
- **THEN** status reports removed and refresh leaves the file unchanged
- **AND** an explicit install is required to restore the region

#### Scenario: Markdown examples or unclosed fences

- **WHEN** markers occur inside fenced examples
- **THEN** they do not identify a managed region
- **AND** installation fails before writing if the generated region would remain inside an unclosed fence

### Requirement: Rules Share Maintained Sources

The guidance body SHALL be generated from maintained R-000 wording, the exact
Source-text contract, intake routing policy, and the executable command catalog.
It SHALL instruct agents to transcribe and echo `originalText` verbatim, record
their observations as Findings during active tasks, and consult `workflow guide`
when blocked. Outside active tasks, observation intake SHALL preserve existing
non-Source Work Item behavior. Projection SHALL NOT create Sources or Findings.

#### Scenario: A maintained rule changes

- **WHEN** R-000 or the code-owned text/routing/command source changes
- **THEN** the generator or source-currentness check exposes the changed guidance
- **AND** every provider target receives the same regenerated rules

### Requirement: Centralized Incremental Adoption Setup

Init SHALL use one question registry for order, defaults, validation, flags and
configuration destinations. Interactive setup SHALL ask missing provider,
guidance and repository questions in order, confirm exact guidance targets,
and preserve answers already present. Provider configuration SHALL remain on
the host; repository configuration SHALL NOT contain credentials or host
provider definitions. Explicit flags and JSON answers SHALL use the same schema.

#### Scenario: Create host provider configuration

- **WHEN** the user selects a new absolute host TOML path and supplies provider IDs, families and executable paths
- **THEN** init validates and creates that configuration using maintained provider definitions
- **AND** it does not launch providers or overwrite existing host TOML files
- **AND** missing required provider entries fail before setup writes

#### Scenario: Repeated initialization

- **WHEN** init is rerun against a configured repository
- **THEN** it only fills missing answers and preserves existing policy bytes
- **AND** it reports unchanged or updated rather than rejecting a valid existing profile

#### Scenario: Noninteractive initialization

- **WHEN** init has no interactive terminal
- **THEN** it consumes explicit flags or an answers file and applies repository defaults
- **AND** absent provider/guidance choices remain pending without implicit installation
- **AND** invalid or contradictory answers fail preflight before guidance writes

## ADDED Requirements

### Requirement: Agent Guide Uses Supported Planning Entry Points

The repository agent guide SHALL identify `openspec-explore` as the read-only
thinking and investigation skill and `openspec-propose` as the planning-artifact
creation skill. It MUST NOT advertise guessed aliases or retired execution
systems, and it SHALL route implementation authority to the workflow engine.

#### Scenario: Agent needs to clarify a change

- **WHEN** a request needs investigation or clarification before implementation
- **THEN** the guide directs the agent to `openspec-explore`
- **THEN** exploration does not authorize implementation

#### Scenario: Agent needs a complete managed plan

- **WHEN** requirements are clear enough for proposal, design, specs, tasks, and guard artifacts
- **THEN** the guide directs the agent to `openspec-propose`
- **THEN** implementation begins only after a workflow plan commit and task start

### Requirement: Agent Guide Explains Every Workflow Command

The repository agent guide SHALL state when to use every public command and
subcommand exposed by the workflow CLI. It SHALL distinguish diagnostics,
planning, execution, recovery, archive, document, issue, asset, handoff, hook,
adapter, and CI responsibilities without treating prose as authority.

#### Scenario: Agent selects a workflow transition

- **WHEN** an agent needs to diagnose, plan, execute, recover, archive, or verify a managed change
- **THEN** the guide provides the relevant command and its permitted use
- **THEN** detailed procedures remain linked to `docs/WORKFLOW.md`

#### Scenario: CLI surface changes

- **WHEN** public CLI usage no longer matches the documented command table
- **THEN** the governance contract fails until they are reconciled

### Requirement: Source Size Does Not Authorize Churn

The repository SHALL prefer focused TypeScript modules and MAY use 500 lines as
a maintainability review signal. Agents MUST NOT edit, split, or refactor source
solely because a file exceeds 500 lines; source changes require a concrete scoped
objective and normal verification.

#### Scenario: Large source file has no scoped defect

- **WHEN** a source file exceeds 500 lines but no behavior or maintainability objective is in scope
- **THEN** the source file remains unchanged

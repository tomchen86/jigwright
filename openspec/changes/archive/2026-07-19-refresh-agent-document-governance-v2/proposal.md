## Why

The repository agent guide advertised retired tooling, omitted the decision
point for public workflow commands, and treated a 500-line threshold as an
automatic refactoring mandate. Those instructions could route an agent away
from repository-owned planning and execution authority or create unrelated
source churn.

## What Changes

- Identify the exact supported OpenSpec exploration and proposal skills.
- Explain when to use every public Jigwright workflow command and subcommand.
- State that source must not be changed, split, or refactored solely because it
  exceeds 500 lines.
- Add repository contracts that keep the guide aligned with the executable CLI
  and reject retired tooling or guessed aliases.

## Scope

The change is limited to repository agent instructions and their executable
governance contracts. It does not change production behavior, dependencies,
consumer documentation, databases, APIs, or workflow authority.

## Non-Goals

- Defining a consumer repository's product overview or document tree.
- Moving consumer documents or changing consumer ignore rules.
- Changing the executable workflow model or CI-anchored authority policies.
- Refactoring production source because of line count.

## Capabilities

### New Capabilities

- `repository-knowledge-governance`: Defines truthful agent routing, complete
  public-command guidance, and the no-churn source-size rule.

### Modified Capabilities

None.

## Impact

Affected surfaces are the repository agent guide and its governance contract
tests. No runtime product code or external service is affected.

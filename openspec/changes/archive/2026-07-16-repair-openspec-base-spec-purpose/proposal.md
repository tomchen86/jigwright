## Why

An archive pilot exposed normative base specs that did not satisfy the pinned
OpenSpec schema because they used a nonconforming scope heading where a
`Purpose` section was required. Baseline spec drift prevented managed changes
from completing the engine-owned archive transition.

## What Changes

- Add an executable repository contract requiring every normative base spec to
  pass pinned strict validation.
- Preserve requirement semantics while repairing nonconforming structural
  headings.
- Keep archive validation fail-closed instead of bypassing malformed specs.

## Capabilities

### New Capabilities

- `openspec-base-spec-validity`: Require normative base specs to retain the
  schema structure needed for pinned validation and archive readiness.

### Modified Capabilities

None.

## Impact

Affected surfaces are the workflow-engine OpenSpec adapter contract and
invalid normative base-spec documents. This is test and documentation work;
it does not change consumer product behavior or require database access.

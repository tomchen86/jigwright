# Jigwright Roadmap

## Current

- Preserve the complete current-v3 engine closure in the standalone repository.
- Replace repository-specific assumptions with validated consumer configuration.
- Run the same engine against Jigwright and a separate consumer repository.

## Next

- Consolidate the preserved workspace into the single public `jigwright` package.
- Verify exact-tarball bootstrap, lifecycle, recovery, provider, and archive paths.
- Retire only v1/v2, migration, shadow/parity, and consumer-owned application data.

## Release Gate

The first package release requires targeted-green production paths, one
current-only full gate, and a real non-database consumer pilot.

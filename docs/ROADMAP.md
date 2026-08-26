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

The release sequence records one current-only full gate before accepting the
exact-tarball consumer candidate.

## Authority sealing

Maintainer authority remains bootstrap-only until `workflow-grant/**` and
`workflow-attestation/**` refs, the migration gate, and the protected environment are independently configured and verified.

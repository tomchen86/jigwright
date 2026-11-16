# Repository runtime

`@jigwright/repository-runtime/paths` owns filesystem inspection shared by the workflow engine and fixture adapter: repository containment, symlink checks, and canonical Git runtime paths.

The package depends on core contracts and pure path projection. Core never imports this package. Consumers keep their own error presentation while the shared implementation retains `RepositoryBoundaryError` identities and codes.

Domain rules receive validated paths or observations from their callers. They must not import this filesystem implementation.

Run the package contracts with `node --experimental-strip-types --test packages/repository-runtime/test/*.test.ts` from the repository root.

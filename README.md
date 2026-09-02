# Jigwright

Jigwright is a repository-owned current-v3 workflow harness for
well-intentioned AI agents. It is distributed as one public `jigwright` package
containing the installed CLI and public current-v3 module surfaces.

The Work Registry is always built in. Work Item use is not mandatory: a
repository may have zero Work Items, and a change may cite an immutable Source
directly.

After installing the local package, inspect a repository with:

```bash
jigwright --repository-root /absolute/path/to/repository doctor --json
```

This repository has no configured remote. Its local release workflow builds
candidate artifacts only; it does not publish an npm package or perform real
external operations.
